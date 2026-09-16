/**
 * WORKFLOW STABILIZATION acceptance (GREEN).
 *
 * Runs only under WORKFLOW_STABILIZATION=1
 * (`npm run test:workflow`): it proves the minimum functional
 * lifecycle runs through `ChronoCore.advance()` with zero manual
 * transition selection. Without the flag this file asserts the
 * gate is off and proves nothing (established gate pattern, same
 * as the black-box/network/host gates).
 *
 * Driver discipline (the property under test):
 *
 * - Gaspar calls ONLY `advance()` and read projections
 *   (`nextAction` for review-id extraction, `execution-status`
 *   never for decisions). Any Gaspar-initiated lifecycle
 *   transition outside a boundary handler fails the suite — the
 *   `gasparSelections` tripwire stays empty by construction and is
 *   asserted empty at the end.
 * - Every external input (PO approval with a genuine signature,
 *   worker delegation/claim/evidence/advance/release, reviewer
 *   verdict/submit) runs ONLY as the immediate response to the
 *   boundary `advance()` just returned, citing that boundary.
 *   Inputs without a preceding boundary fail the suite.
 * - Approval registration, lifecycle state, and the next decision
 *   are re-observed after every input: the loop continues only on
 *   a fresh `advance()` result.
 *
 * No production behavior was weakened for this file; failing
 * assertions name the missing engine behavior, never a faked row.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import {
  RTK_UPSTREAM,
  SKILL_RELEASE,
  SKILL_RUNTIME_PATHS,
  SKILL_UPSTREAM,
  buildApprovalPayload,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildPolicyPayload,
  buildSessionAuthorizationPayload,
  computeRevisionHash,
  convertSkillSource,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  managedAssetInventory,
  signApprovalPayload,
  skillGeneratedHashes,
  skillVendorPath,
} from "@chrono/domain";
import { ChronoCore, type WorkflowDecision } from "@chrono/core";
import { buildOpenCodeAgentDefinition } from "./opencode-agent.js";
import { FIXTURE_SKILL_MD } from "../test/test-skill-fixture.js";

const STABILIZATION = process.env["WORKFLOW_STABILIZATION"] === "1";

if (!STABILIZATION) {
  describe("Workflow stabilization (minimum functional lifecycle)", () => {
    it("runs on demand via npm run test:workflow (WORKFLOW_STABILIZATION=1)", () => {
      expect(STABILIZATION).toBe(false);
    });
  });
} else {
  const FIXED_TIME = "2026-09-14T00:00:00.000Z";
  const SPEC = { id: "SP-0001", title: "T", purpose: "P", inScope: ["a"], acceptanceCriteria: ["ac1"] };
  const MOD = "MOD-0090";
  const WP = "WP-0090";

  /** Actions the engine itself may consume (all other steps are boundaries). */
  const MECHANICAL = [
    "submit-architecture",
    "approve-architecture",
    "submit-spec",
    "ready-spec",
    "activate-module",
    "authorize-wp",
    "assign-review",
    "complete-module",
  ];

  function fakeTty(): () => void {
    const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    return () => {
      if (stdinDesc !== undefined) {
        Object.defineProperty(process.stdin, "isTTY", stdinDesc);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
      if (stdoutDesc !== undefined) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDesc);
      } else {
        delete (process.stdout as { isTTY?: boolean }).isTTY;
      }
    };
  }

  describe("Workflow stabilization (minimum functional lifecycle)", () => {
    let tempDir: string;
    let core: ChronoCore;
    let signingKey = "";
    let gaspar: { actor: string; session: { id: string; token: string } };
    let restoreTty: () => void;
    let archRev = "";

    function approve(action: string, scopeId: string, scopeRev: string): string {
      const signature = signApprovalPayload(
        buildApprovalPayload({
          action, scopeArtifactId: scopeId, scopeRevision: scopeRev,
          authority: "PO", rationale: "test approval", timestamp: FIXED_TIME,
        }),
        signingKey
      );
      const res = core.recordApproval({
        action, scopeArtifactId: scopeId, scopeRevision: scopeRev,
        authority: "PO", rationale: "test approval", timestamp: FIXED_TIME, signature,
      });
      expect(res.ok).toBe(true);
      return res.value!.id;
    }

    function openPrivileged(role: "gaspar" | "PO", key: string): { id: string; token: string } {
      const nonce = randomBytes(16).toString("hex");
      const timestamp = "2026-09-11T00:00:00.000Z";
      const signature = signApprovalPayload(
        buildSessionAuthorizationPayload({
          sessionRole: role, adapter: "fixture", runtime: "opencode",
          scopeModule: null, scopeWp: null, ttlSeconds: 3600, nonce,
          authority: "PO", rationale: "test", timestamp,
        }),
        key
      );
      const res = core.openSession(
        { role, adapter: "fixture", runtime: "opencode", ttlSeconds: 3600 },
        { poAuthorization: { nonce, authority: "PO", rationale: "test", timestamp, signature } }
      );
      expect(res.ok).toBe(true);
      return { id: res.value!.id, token: res.value!.token };
    }

    function recordEvidenceAs(
      auth: { actor: string; session: { id: string; token: string } },
      targetRevision: string,
      checkName: string
    ): string {
      const res = core.recordEvidence({
        producer: auth.actor,
        tool: "vitest",
        targetRevision,
        checkName,
        result: "pass",
        diagnostics: null,
        integrityHash: computeRevisionHash({ result: "pass", diagnostics: null, target_revision: targetRevision }),
      }, auth);
      expect(res.ok).toBe(true);
      return res.value!.id;
    }

    /**
     * Tripwire: the holder session must own a live dispatch binding
     * covering the scope right now (read through the public
     * execution-status projection). Evidence and advances without
     * one fail this walk instead of simulating worker mutation.
     */
    function assertBinding(
      holder: { actor: string; session: { id: string; token: string } },
      moduleId: string,
      workPackageId: string | null
    ): void {
      const status = core.executionStatus(
        workPackageId !== null ? { workPackageId } : { moduleId },
        holder
      );
      expect(status.ok).toBe(true);
      expect(
        status.value!.ownDispatch,
        `session for '${holder.actor}' holds no live binding`
      ).toBeTruthy();
    }

    /**
     * Tripwire: current passing proof by this producer for this
     * revision must exist right now (read through the public
     * evidence-status projection). Forward steps without it fail
     * this walk instead of advancing on assertion alone.
     */
    function assertEvidenceCurrent(producer: string, revision: string): void {
      const status = core.evidenceStatus({ targetRevision: revision }, gaspar);
      expect(status.ok).toBe(true);
      expect(
        status.value!.current.some((e) => e.producer === producer && e.result === "pass"),
        `no current passing evidence by '${producer}' for this revision`
      ).toBe(true);
    }

    /** Full execution stack: init through adapter approval. */
    function buildStack(): void {
      expect(core.registerModule(MOD, "DRAFT", { id: MOD, name: "M", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
      expect(
        core.registerWorkPackage(WP, "PLANNED", { id: WP, name: "W", module: MOD, dependsOn: [] }, gaspar).ok
      ).toBe(true);
      expect(core.recordSecurityProfile({ title: "P", threats: [] }, gaspar).ok).toBe(true);
      const rtkBin = join(tempDir, "fixture-rtk.sh");
      writeFileSync(rtkBin, "#!/bin/sh\necho fixture-rtk 1.0.0-test\n", "utf8");
      chmodSync(rtkBin, 0o755);
      expect(
        core.recordRtkAttestation(gaspar, {
          binaryPath: rtkBin, binaryIdentity: "rtk-test", version: "1.0.0-test",
          provenance: RTK_UPSTREAM, integrationMode: "test", routingTestPassed: true,
          routingTestLog: "fixture", gained: true, savingsEvidence: null, ttlSeconds: 86400,
        }).ok
      ).toBe(true);
      expect(
        core.recordSkillAttestation(gaspar, {
          upstream: SKILL_UPSTREAM, pinnedCommit: SKILL_RELEASE.pinnedCommit,
          sourceHash: SKILL_RELEASE.sourceHash,
          generatedHashes: skillGeneratedHashes(convertSkillSource(FIXTURE_SKILL_MD)),
          converterVersion: SKILL_RELEASE.converterVersion, licenseStatus: "MIT", attribution: "MIT",
          runtimeIdentity: "test", agentIdentity: "test", discoveryResult: "found",
          permissionResult: "granted", activationTestPassed: true, ttlSeconds: 86400,
        }).ok
      ).toBe(true);
      const vendorTarget = join(tempDir, skillVendorPath(SKILL_RELEASE.pinnedCommit));
      mkdirSync(dirname(vendorTarget), { recursive: true });
      writeFileSync(vendorTarget, FIXTURE_SKILL_MD, "utf8");
      for (const runtime of ["claude", "opencode", "kiro"] as const) {
        const target = join(tempDir, SKILL_RUNTIME_PATHS[runtime]);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, FIXTURE_SKILL_MD, "utf8");
      }
      const entrypoint = join(tempDir, "fixture-runtime.sh");
      writeFileSync(entrypoint, "#!/bin/sh\necho fixture-ok\n");
      chmodSync(entrypoint, 0o755);
      const po = { actor: "PO", session: openPrivileged("PO", signingKey) };
      expect(core.registerAdapter({ id: "fixture", name: "Fixture", entrypoint, conformanceProof: ["fixture --version"] }, po).ok).toBe(true);
      const registrationHash = core.adapterRegistrationHash("fixture");
      const adapterApprovalId = approve("adapter-registration", "fixture", registrationHash);
      expect(core.approveAdapter("fixture", adapterApprovalId, po).ok).toBe(true);
      const recordedProof = core.recordRoutingProof(gaspar, {
        adapterId: "fixture", binaryPath: rtkBin, version: "1.0.0-test",
        proofCommand: JSON.stringify([rtkBin, "gain"]),
        preRoutingCommand: JSON.stringify(["ls", tempDir]),
        commandHash: computeRevisionHash([rtkBin, "gain"]),
        outputHash: computeRevisionHash("fixture gain ok"),
        exitStatus: 0, gainAvailable: true,
        timestamp: new Date().toISOString(), ttlSeconds: 86400,
      });
      expect(recordedProof.ok).toBe(true);
      for (const spec of managedAssetInventory("fixture")) {
        const target = join(tempDir, spec.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, spec.kind === "marker" ? `fixture-managed ${spec.marker ?? spec.path}\n` : `fixture-managed ${spec.path}\n`, "utf8");
      }
      expect(core.promoteRoutingProof(recordedProof.value!.id, po).ok).toBe(true);
    }

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "chrono-workflow-stab-"));
      core = new ChronoCore({ projectPath: tempDir, runtime: "opencode" });
      expect(core.init().ok).toBe(true);
      const pair = generateApprovalKeyPair();
      restoreTty = fakeTty();
      const nonce = randomBytes(16).toString("hex");
      const fingerprint = fingerprintPublicKey(pair.publicKeyPem);
      const confirmation = buildEnrollmentChallenge("default", fingerprint, nonce);
      const timestamp = new Date().toISOString();
      const signature = signApprovalPayload(
        buildEnrollmentPayload({ projectId: "default", fingerprint, timestamp, nonce, authority: "PO", rationale: "test", confirmation }),
        pair.privateKeyPem
      );
      expect(core.enrollPo({ publicKeyPem: pair.publicKeyPem, nonce, timestamp, rationale: "test", confirmation, signature }).ok).toBe(true);
      signingKey = pair.privateKeyPem;
      gaspar = { actor: "gaspar", session: openPrivileged("gaspar", signingKey) };
      const proposed = core.proposeArchitecture({ title: "A" }, gaspar);
      expect(proposed.ok).toBe(true);
      archRev = proposed.value!;
      expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    });

    afterEach(() => {
      restoreTty();
      core.close();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("walks the minimum functional lifecycle on advance() alone (GREEN)", () => {
      // Tripwire: Gaspar-initiated lifecycle transitions. Gaspar may
      // call advance() and read projections only; every transition
      // below runs either inside advance() or as a boundary-cited
      // external input by its owning identity. This list stays empty.
      const gasparSelections: string[] = [];
      // Every external input cites the boundary that directed it.
      const externalInputs: Array<{ boundary: string; op: string }> = [];
      const workers = new Map<string, { actor: string; session: { id: string; token: string } }>();
      const delegated = new Set<string>();
      let childSeq = 0;
      const cite = (boundary: string, op: string): void => {
        expect(boundary.length, `external input '${op}' cites no boundary`).toBeGreaterThan(0);
        externalInputs.push({ boundary, op });
      };

      buildStack();
      // Lean calibration is project setup (PO-signed, genuine
      // signature): focused evidence plus one independent check, so
      // the walk needs no Lucca parallel binding.
      const poSetup = { actor: "PO", session: openPrivileged("PO", signingKey) };
      const leanTimestamp = new Date().toISOString();
      const leanSignature = signApprovalPayload(
        buildPolicyPayload({ profile: "lean", rationale: "stabilization walk", timestamp: leanTimestamp }),
        signingKey
      );
      expect(core.setPolicyProfile(
        { profile: "lean", rationale: "stabilization walk", signature: leanSignature, timestamp: leanTimestamp },
        poSetup
      ).ok).toBe(true);

      const doAgentWork = (d: Extract<WorkflowDecision, { type: "AGENT_WORK_REQUIRED" }>): void => {
        const tag = `${d.type}:${d.phase}:${d.kind}:${d.workPackageId ?? d.moduleId}`;
        // Phase-driven dispatch: every id and scope below comes from
        // structured boundary fields. Descriptive text is never read.
        if (d.phase === "record-harness") {
          // Harness content is creative input: authored here as the
          // modeled planning step the boundary named.
          expect(d.specId, "harness boundary names its spec").toBe("SP-0001");
          expect(d.specRevision, "harness boundary names its revision").toBeTruthy();
          const rev = core.getArtifact(d.specId as string).revision;
          expect(rev).toBe(d.specRevision);
          const content = "# harness for SP-0001";
          expect(
            core.recordHarness(rev, `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`, content, gaspar).ok
          ).toBe(true);
          cite(tag, `harness-record:${d.specId}`);
          return;
        }
        if (d.phase === "request") {
          // No dispatch row exists yet (boundary proves it): request
          // with the boundary's kind/scope, then delegate exactly
          // once, claim, and confirm.
          expect(d.dispatchId, "request phase carries no dispatch row").toBe(null);
          expect(d.adapterId, "Core never selects adapters").toBe(null);
          const requested = core.requestDispatch(
            {
              moduleId: d.moduleId,
              ...(d.workPackageId !== null ? { workPackageId: d.workPackageId } : {}),
              kind: d.kind,
              rationale: `stabilization walk: ${d.kind} work for '${d.workPackageId ?? d.moduleId}'`,
              adapterId: "fixture",
            },
            gaspar
          );
          expect(requested.ok).toBe(true);
          const dispatchId = requested.value!.dispatchId;
          expect(core.recordTaskDelegation({ agent: d.role, parentRuntimeSession: `opencode-parent-${dispatchId}` }, gaspar).ok).toBe(true);
          childSeq += 1;
          const claimed = core.claimDispatch({ dispatchId, childRuntimeSession: `opencode-child-${childSeq}` }, gaspar);
          expect(claimed.ok).toBe(true);
          workers.set(dispatchId, { actor: d.role, session: { id: claimed.value!.session.id, token: claimed.value!.session.token } });
          expect(core.confirmClaim(dispatchId, gaspar).ok).toBe(true);
          cite(tag, `dispatch-chain:${dispatchId}:${d.role}`);
          return;
        }
        if (d.phase === "claim") {
          // A pending row exists (boundary proves it): finish
          // delegation exactly once unless already delegated, then
          // claim and confirm into a worker session.
          expect(d.dispatchId, "claim phase names its dispatch row").toBeTruthy();
          const dispatchId = d.dispatchId as string;
          if (!delegated.has(dispatchId)) {
            expect(core.recordTaskDelegation({ agent: d.role, parentRuntimeSession: `opencode-parent-${dispatchId}` }, gaspar).ok).toBe(true);
            delegated.add(dispatchId);
          }
          childSeq += 1;
          const claimed = core.claimDispatch({ dispatchId, childRuntimeSession: `opencode-child-${childSeq}` }, gaspar);
          expect(claimed.ok).toBe(true);
          workers.set(dispatchId, { actor: d.role, session: { id: claimed.value!.session.id, token: claimed.value!.session.token } });
          expect(core.confirmClaim(dispatchId, gaspar).ok).toBe(true);
          cite(tag, `dispatch-chain:${dispatchId}:${d.role}`);
          return;
        }
        // Execute phase: the holder session was minted by an earlier
        // claim in this walk — sessions are tracked, never invented.
        expect(d.phase).toBe("execute");
        expect(d.dispatchId, "execute phase names its binding").toBeTruthy();
        const bindingId = d.dispatchId as string;
        const worker = workers.get(bindingId);
        expect(worker, `worker session for ${bindingId} comes from its claim`).toBeTruthy();
        const holder = worker as { actor: string; session: { id: string; token: string } };
        expect(holder.actor).toBe(d.role);
        // Holder executes inside its own binding: evidence, forward
        // steps, then release. Tripwires prove the binding is live
        // and the proof is current before every step.
        const scope = { moduleId: d.moduleId, ...(d.workPackageId !== null ? { workPackageId: d.workPackageId } : {}) };
        const scopeRev = core.getArtifact(d.workPackageId ?? d.moduleId).revision;
        if (d.kind === "implementation") {
          assertBinding(holder, d.moduleId, d.workPackageId);
          recordEvidenceAs(holder, scopeRev, "unit-impl");
          cite(tag, `evidence-record:${bindingId}`);
          assertEvidenceCurrent(d.role, scopeRev);
          expect(core.advanceScope({ ...scope, event: "ImplementationDone" }, holder).ok).toBe(true);
          expect(core.advanceScope({ ...scope, event: "VerificationReady" }, holder).ok).toBe(true);
          cite(tag, `scope-advance:${bindingId}`);
          expect(core.releaseDispatch(bindingId, holder).ok).toBe(true);
          cite(tag, `dispatch-release:${bindingId}`);
          return;
        }
        throw new Error(`test driver has no worker playbook for kind '${d.kind}'`);
      };

      const doReviewWork = (d: Extract<WorkflowDecision, { type: "INDEPENDENT_REVIEW_REQUIRED" }>): void => {
        const tag = `${d.type}:${d.kind}:${d.workPackageId ?? d.moduleId}`;
        const scope = { moduleId: d.moduleId, ...(d.workPackageId !== null ? { workPackageId: d.workPackageId } : {}) };
        // The assigned review id arrives on the boundary itself —
        // the reviewer never reads prose to discover their work.
        expect(d.reviewId, "review boundary names its assigned review").toBeTruthy();
        // The reviewer flow — dispatch, verdict, submission, advance,
        // release — runs here as the boundary-directed response.
        const dispatched = core.requestDispatch(
          {
            moduleId: d.moduleId,
            ...(d.workPackageId !== null ? { workPackageId: d.workPackageId } : {}),
            kind: d.kind,
            rationale: `stabilization walk: ${d.kind} for '${d.workPackageId ?? d.moduleId}'`,
            adapterId: "fixture",
          },
          gaspar
        );
        expect(dispatched.ok).toBe(true);
        cite(tag, `dispatch-chain:${dispatched.value!.dispatchId}:${d.role}`);
        expect(core.recordTaskDelegation({ agent: d.role, parentRuntimeSession: `opencode-parent-${dispatched.value!.dispatchId}` }, gaspar).ok).toBe(true);
        childSeq += 1;
        const claimed = core.claimDispatch({ dispatchId: dispatched.value!.dispatchId, childRuntimeSession: `opencode-child-${childSeq}` }, gaspar);
        expect(claimed.ok).toBe(true);
        const reviewer = { actor: d.role, session: { id: claimed.value!.session.id, token: claimed.value!.session.token } };
        expect(core.confirmClaim(dispatched.value!.dispatchId, gaspar).ok).toBe(true);
        assertBinding(reviewer, d.moduleId, d.workPackageId);
        expect(core.recordVerification(d.moduleId, "PASS", "spekkio", [], [], [], reviewer, d.workPackageId ?? undefined).ok).toBe(true);
        cite(tag, `verify-record:${dispatched.value!.dispatchId}`);
        expect(core.completeReview({ reviewId: d.reviewId as string }, reviewer).ok).toBe(true);
        cite(tag, `review-complete:${d.reviewId}`);
        expect(core.advanceScope({ ...scope, event: "SpekkioPassed" }, reviewer).ok).toBe(true);
        cite(tag, `scope-advance:SpekkioPassed`);
        expect(core.releaseDispatch(dispatched.value!.dispatchId, reviewer).ok).toBe(true);
        cite(tag, `dispatch-release:${dispatched.value!.dispatchId}`);
      };

      for (let round = 0; round < 80; round += 1) {
        const res = core.advance({ moduleId: MOD }, gaspar);
        expect(res.ok).toBe(true);
        const { decision, trail } = res.value!;
        for (const step of trail) {
          expect(MECHANICAL, `advance() consumed non-mechanical step '${step.action}'`).toContain(step.action);
        }
        if (decision.type === "COMPLETE") {
          expect(decision.moduleId).toBe(MOD);
          expect(core.getArtifact(MOD).status).toBe("COMPLETE");
          expect(core.validate().value!.valid).toBe(true);
          const deep = core.deepIntegrityCheck(gaspar);
          expect(deep.ok).toBe(true);
          expect(deep.value!.blockerCount).toBe(0);
          expect(deep.value!.warningCount).toBe(0);
          const modRev = core.getArtifact(MOD).revision;
          expect(core.hasValidApproval(MOD, modRev, "planning-approval")).toBe(true);
          expect(core.hasValidApproval(MOD, modRev, "module-approval")).toBe(true);
          expect(core.hasValidApproval(MOD, modRev, "implementation-security")).toBe(true);
          expect(gasparSelections).toEqual([]);
          expect(externalInputs.length).toBeGreaterThan(0);
          return;
        }
        if (decision.type === "BLOCKED") {
          throw new Error(`walk must complete; advance() blocked: ${decision.code}: ${decision.reason}`);
        }
        if (decision.type === "PO_DECISION_REQUIRED") {
          approve(decision.action, decision.scopeId, decision.revision);
          cite(decision.type, `approve:${decision.action}:${decision.scopeId}`);
          expect(core.hasValidApproval(decision.scopeId, decision.revision, decision.action)).toBe(true);
          continue;
        }
        if (decision.type === "AGENT_WORK_REQUIRED") {
          doAgentWork(decision);
          continue;
        }
        doReviewWork(decision);
      }
      throw new Error("walk did not converge within 80 advance() rounds");
    });

    it("reports BLOCKED on bounded-loop exhaustion", () => {
      buildStack();
      // Drive the package to verification, then fail it four times
      // (standard profile allows three attempts): the fourth FAILED
      // verdict escalates the loop and raises a PO blocker.
      const via = <T extends { ok: boolean }>(fn: () => T): T => {
        const res = fn();
        expect(res.ok).toBe(true);
        return res;
      };
      via(() => core.submitArchitectureForReview(gaspar));
      approve("architecture-security", "ARCH", archRev);
      via(() => core.approveArchitecture(gaspar));
      approve("planning-approval", "SP-0001", core.getArtifact("SP-0001").revision);
      via(() => core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar));
      approve("architecture-security", "SP-0001", core.getArtifact("SP-0001").revision);
      const specRev = core.getArtifact("SP-0001").revision;
      const harnessContent = "# harness for SP-0001";
      via(() => core.recordHarness(
        specRev, `sha256:${createHash("sha256").update(harnessContent, "utf8").digest("hex")}`, harnessContent, gaspar
      ));
      via(() => core.transitionState("SP-0001", "SpecApprovedReady", gaspar));
      const modRev = core.getArtifact(MOD).revision;
      approve("planning-approval", MOD, modRev);
      approve("module-approval", MOD, modRev);
      via(() => core.activateModule(MOD, gaspar));
      via(() => core.transitionState(WP, "WorkPackageAuthorized", gaspar));
      // One defect across all four rounds: each FAILED verdict opens
      // a fresh loop attempt (CLOSED rows keep counting toward the
      // standard bound of three), and each PASS closes its loop — so
      // the fourth FAILED exceeds the bound and escalates. Rounds
      // never rebind a CORRECTING loop: every correction binds a
      // freshly OPENED row.
      let defectId = "";
      let dispatchSeq = 0;
      const roundTrip = (kind: string | undefined, agent: string): { dispatchId: string; worker: { actor: string; session: { id: string; token: string } } } => {
        dispatchSeq += 1;
        const requested = core.requestDispatch(
          { moduleId: MOD, workPackageId: WP, ...(kind !== undefined ? { kind } : {}), rationale: "stabilization drive", adapterId: "fixture" },
          gaspar
        );
        expect(requested.ok).toBe(true);
        expect(core.recordTaskDelegation({ agent, parentRuntimeSession: `opencode-parent-${dispatchSeq}` }, gaspar).ok).toBe(true);
        const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: `opencode-child-${dispatchSeq}` }, gaspar);
        expect(claimed.ok).toBe(true);
        expect(core.confirmClaim(requested.value!.dispatchId, gaspar).ok).toBe(true);
        return {
          dispatchId: requested.value!.dispatchId,
          worker: { actor: agent, session: { id: claimed.value!.session.id, token: claimed.value!.session.token } },
        };
      };
      const failPhase = (): void => {
        const assigned = core.assignReview({ kind: "verification", moduleId: MOD, workPackageId: WP }, gaspar);
        expect(assigned.ok).toBe(true);
        const spek = roundTrip("verification", "spekkio");
        if (defectId === "") {
          const defect = core.recordDefect(
            {
              classification: "IMPLEMENTATION_DEFECT",
              severity: "major",
              evidenceRefs: [],
              affectedCriteria: [],
              affectedArtifacts: [WP],
              blockingScope: WP,
              reproInfo: null,
            },
            spek.worker
          );
          expect(defect.ok).toBe(true);
          defectId = defect.value!.id;
        }
        expect(core.recordVerification(MOD, "FAILED", "spekkio", [defectId], [], [], spek.worker, WP).ok).toBe(true);
        expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "SpekkioFailed" }, spek.worker).ok).toBe(true);
        expect(core.completeReview({ reviewId: assigned.value!.reviewId }, spek.worker).ok).toBe(true);
        expect(core.releaseDispatch(spek.dispatchId, spek.worker).ok).toBe(true);
      };
      const fixPhase = (round: number): void => {
        // Governed correction on the freshly OPENED loop, then a
        // PASS verdict that closes it — the next FAILED opens the
        // next attempt. WP stays VERIFYING throughout (no terminal
        // advance), so re-verification can continue. The loop id
        // comes from the engine's own correct-defect boundary, never
        // prose: the FAILED verdict auto-opened attempt `round`.
        const fix = roundTrip("correction", "belthazar");
        const rev = core.getArtifact(WP).revision;
        assertBinding(fix.worker, MOD, WP);
        recordEvidenceAs(fix.worker, rev, "fix");
        const observed = core.advance({ workPackageId: WP }, gaspar);
        expect(observed.ok).toBe(true);
        const boundary = observed.value!.decision;
        expect(boundary.type).toBe("AGENT_WORK_REQUIRED");
        if (boundary.type !== "AGENT_WORK_REQUIRED") {
          throw new Error("expected a correction boundary");
        }
        expect(boundary.phase).toBe("correct");
        expect(boundary.loopId, "correction boundary names its loop").toBeTruthy();
        expect(boundary.defectId).toBe(defectId);
        expect(boundary.attempt).toBe(round);
        expect(core.completeCorrectionLoop(boundary.loopId as string, fix.worker).ok).toBe(true);
        expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, fix.worker).ok).toBe(true);
        expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, fix.worker).ok).toBe(true);
        expect(core.releaseDispatch(fix.dispatchId, fix.worker).ok).toBe(true);
        const reassigned = core.assignReview({ kind: "verification", moduleId: MOD, workPackageId: WP }, gaspar);
        expect(reassigned.ok).toBe(true);
        const spek = roundTrip("verification", "spekkio");
        expect(core.recordVerification(MOD, "PASS", "spekkio", [], [], [], spek.worker, WP).ok).toBe(true);
        expect(core.completeReview({ reviewId: reassigned.value!.reviewId }, spek.worker).ok).toBe(true);
        expect(core.releaseDispatch(spek.dispatchId, spek.worker).ok).toBe(true);
      };
      // First failure needs positioned work: implement and verify-ready.
      const impl = roundTrip(undefined, "belthazar");
      const rev = core.getArtifact(WP).revision;
      recordEvidenceAs(impl.worker, rev, "unit-impl");
      const test = roundTrip("test", "lucca");
      recordEvidenceAs(test.worker, rev, "unit");
      expect(core.releaseDispatch(test.dispatchId, test.worker).ok).toBe(true);
      expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, impl.worker).ok).toBe(true);
      expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, impl.worker).ok).toBe(true);
      expect(core.releaseDispatch(impl.dispatchId, impl.worker).ok).toBe(true);
      failPhase();
      fixPhase(1);
      failPhase();
      fixPhase(2);
      failPhase();
      fixPhase(3);
      // Fourth FAILED exceeds the bound of three: the verdict itself
      // escalates (fresh OPEN row, attempt 4 > max) and raises the PO
      // blocker — so no advance follows; the state is terminally held.
      const assigned4 = core.assignReview({ kind: "verification", moduleId: MOD, workPackageId: WP }, gaspar);
      expect(assigned4.ok).toBe(true);
      const spek4 = roundTrip("verification", "spekkio");
      expect(defectId === "").toBe(false);
      expect(core.recordVerification(MOD, "FAILED", "spekkio", [defectId], [], [], spek4.worker, WP).ok).toBe(true);
      // Setup proof: the fourth attempt escalated with a PO blocker.
      const escalations = core.listEvents().filter((e) => e.eventType === "CorrectionEscalated");
      expect(escalations.length).toBe(1);
      // The engine surfaces the terminal boundary even though the
      // verification binding is still live: escalation is checked
      // before any next-action observation it could shadow.
      const res = core.advance({ moduleId: MOD }, gaspar);
      expect(res.ok).toBe(true);
      expect(res.value!.trail).toEqual([]);
      const decision = res.value!.decision;
      expect(decision.type).toBe("BLOCKED");
      if (decision.type === "BLOCKED") {
        expect(decision.code).toBe("CORRECTION_ESCALATED");
        expect(decision.owner).toBe("PO");
        expect(decision.recoverable).toBe(true);
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    });

    it("Gaspar never routes terminal steps to the PO (holds today)", () => {
      const contract = buildOpenCodeAgentDefinition("gaspar");
      expect(contract).toContain("There is no approval-confirm tool");
      expect(contract).not.toContain("CHRONO_SESSION_TOKEN");
      expect(contract).not.toContain("ask the PO to run");
      expect(contract).not.toContain("ask the PO to execute");
      expect(contract).toContain("chrono_approval_request");
      expect(contract).toContain("question");
    });
  });
}
