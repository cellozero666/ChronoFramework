/**
 * WORKFLOW STABILIZATION acceptance (RED).
 *
 * Runs only under WORKFLOW_STABILIZATION=1
 * (`npm run test:workflow`): it proves the minimum functional
 * lifecycle cannot run without manual transition selection, because
 * `ChronoCore.advance()` does not exist yet. Without the flag this
 * file asserts the gate is off and proves nothing (established
 * gate pattern, same as the black-box/network/host gates).
 *
 * The lifecycle itself is walked end to end through public Core
 * operations with genuine PO signatures (the walk passing proves
 * the machinery works); the RED assertions prove the missing
 * coordination layer:
 *
 * - the driver manually selects 20+ transitions (must be zero);
 * - no nextAction resolves to a WorkflowDecision boundary (tool
 *   steps only);
 * - bounded-loop exhaustion surfaces tool actions, never BLOCKED;
 * - `ChronoCore.advance` is absent.
 *
 * Do NOT "fix" this file by weakening an assertion, by performing
 * hidden mutations, or by selecting transitions for the driver: it
 * turns green only when `advance()` is implemented under separate
 * authorization. No production behavior was changed for this file.
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
import { ChronoCore, type NextAction, type WorkflowDecision } from "@chrono/core";
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

  /**
   * Attempt to resolve a Core next-action to a workflow boundary
   * WITHOUT manual transition selection. Only the terminal state
   * resolves today: every other action names a specific tool or
   * operation the orchestrator must choose and execute itself —
   * exactly the gap `advance()` must close.
   */
  function resolveBoundary(action: NextAction): WorkflowDecision | null {
    if (action.action === "done") {
      return "COMPLETE";
    }
    return null;
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

    let dispatchSeq = 0;
    function dispatchRoundTrip(kind: string | undefined, agent: string): { dispatchId: string; worker: { actor: string; session: { id: string; token: string } } } {
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

    it("walks the minimum functional lifecycle end to end (machinery proves itself)", () => {
      // Every manual transition the stabilized driver would have to
      // choose itself is RECORDED here. The RED test below asserts
      // this list must be empty — `advance()` alone may walk it.
      const manualSelections: string[] = [];
      const noted: Array<{ step: string; action: string }> = [];
      const via = <T extends { ok: boolean }>(label: string, fn: () => T): T => {
        manualSelections.push(label);
        const res = fn();
        expect(res.ok).toBe(true);
        return res;
      };
      const note = (step: string, allowed: string[]): NextAction => {
        const next = core.nextAction({ moduleId: MOD }, gaspar);
        expect(next.ok).toBe(true);
        expect(allowed).toContain(next.value!.action);
        noted.push({ step, action: next.value!.action });
        return next.value!;
      };
      buildStack();
      // Planning runway, all Core-observed.
      note("runway-arch-submit", ["submit-architecture"]);
      via("arch-submit", () => core.submitArchitectureForReview(gaspar));
      const archHold = note("runway-arch-hold", ["request-approval"]);
      expect(archHold.kind).toBe("architecture-security");
      approve("architecture-security", "ARCH", archRev);
      note("runway-arch-approve", ["approve-architecture"]);
      via("arch-approve", () => core.approveArchitecture(gaspar));
      const specHold = note("runway-spec-planning-hold", ["request-approval"]);
      expect(specHold.kind).toBe("planning-approval");
      approve("planning-approval", "SP-0001", core.getArtifact("SP-0001").revision);
      note("runway-spec-submit", ["submit-spec"]);
      via("spec-submit", () => core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar));
      const reviewHold = note("runway-spec-review-hold", ["request-approval"]);
      expect(reviewHold.kind).toBe("architecture-security");
      approve("architecture-security", "SP-0001", core.getArtifact("SP-0001").revision);
      note("runway-harness", ["record-harness"]);
      const specRev = core.getArtifact("SP-0001").revision;
      const harnessContent = "# harness for SP-0001";
      via("harness-record", () => core.recordHarness(
        specRev, `sha256:${createHash("sha256").update(harnessContent, "utf8").digest("hex")}`, harnessContent, gaspar
      ));
      note("runway-ready", ["ready-spec"]);
      via("spec-ready", () => core.transitionState("SP-0001", "SpecApprovedReady", gaspar));
      expect(core.getArtifact("SP-0001").status).toBe("READY");
      // Module activation: both current approvals, then the call.
      const modRev = core.getArtifact(MOD).revision;
      approve("planning-approval", MOD, modRev);
      approve("module-approval", MOD, modRev);
      note("activate", ["activate-module"]);
      via("activate-module", () => core.activateModule(MOD, gaspar));
      expect(core.getArtifact(MOD).status).toBe("APPROVED");
      // WP authorization through the native transition.
      note("authorize", ["authorize-wp"]);
      via("wp-authorize", () => core.transitionState(WP, "WorkPackageAuthorized", gaspar));
      expect(core.getArtifact(WP).status).toBe("AUTHORIZED");
      // Executable chain to verification.
      note("dispatch", ["request-dispatch"]);
      const impl = dispatchRoundTrip(undefined, "belthazar");
      manualSelections.push("dispatch-delegate", "dispatch-claim", "dispatch-confirm");
      const rev = core.getArtifact(WP).revision;
      recordEvidenceAs(impl.worker, rev, "unit-impl");
      manualSelections.push("evidence-record");
      const test = dispatchRoundTrip("test", "lucca");
      manualSelections.push("dispatch-delegate", "dispatch-claim", "dispatch-confirm");
      recordEvidenceAs(test.worker, rev, "unit");
      manualSelections.push("evidence-record");
      expect(core.releaseDispatch(test.dispatchId, test.worker).ok).toBe(true);
      manualSelections.push("dispatch-release");
      expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, impl.worker).ok).toBe(true);
      expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, impl.worker).ok).toBe(true);
      manualSelections.push("scope-advance", "scope-advance");
      expect(core.releaseDispatch(impl.dispatchId, impl.worker).ok).toBe(true);
      manualSelections.push("dispatch-release");
      note("assign-review", ["assign-review"]);
      const assigned = core.assignReview({ kind: "verification", moduleId: MOD, workPackageId: WP }, gaspar);
      expect(assigned.ok).toBe(true);
      manualSelections.push("review-assign");
      const spek = dispatchRoundTrip("verification", "spekkio");
      manualSelections.push("dispatch-delegate", "dispatch-claim", "dispatch-confirm");
      expect(core.recordVerification(MOD, "PASS", "spekkio", [], [], [], spek.worker, WP).ok).toBe(true);
      manualSelections.push("verify-record");
      expect(core.completeReview({ reviewId: assigned.value!.reviewId }, spek.worker).ok).toBe(true);
      manualSelections.push("review-complete");
      expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "SpekkioPassed" }, spek.worker).ok).toBe(true);
      manualSelections.push("scope-advance");
      expect(core.getArtifact(WP).status).toBe("COMPLETE");
      expect(core.releaseDispatch(spek.dispatchId, spek.worker).ok).toBe(true);
      manualSelections.push("dispatch-release");
      // Aggregate completion needs the module acceptance (modeled PO
      // ceremony between the hold observation and re-observation).
      note("completion-hold", ["approve-security"]);
      approve("implementation-security", MOD, modRev);
      note("completion", ["complete-module"]);
      via("complete-module", () => core.completeModule(MOD, gaspar));
      expect(core.getArtifact(MOD).status).toBe("COMPLETE");
      // Terminal consistency: done, valid, deeply clean.
      const done = note("terminal", ["done"]);
      expect(resolveBoundary(done)).toBe("COMPLETE");
      expect(core.validate().value!.valid).toBe(true);
      const deep = core.deepIntegrityCheck(gaspar);
      expect(deep.ok).toBe(true);
      expect(deep.value!.blockerCount).toBe(0);
      expect(deep.value!.warningCount).toBe(0);
      // Approval registration, lifecycle state, and Core answers
      // agreed at every step (any disagreement above already threw).
      expect(core.hasValidApproval(MOD, modRev, "planning-approval")).toBe(true);
      expect(core.hasValidApproval(MOD, modRev, "module-approval")).toBe(true);
      expect(core.hasValidApproval(MOD, modRev, "implementation-security")).toBe(true);
      // RED: the stabilized driver may only call advance(). Every
      // manual selection above, every unmapped tool step, and the
      // missing operation prove the architectural gap — collected
      // into one verdict so the full shape is visible at once.
      const failures: string[] = [];
      if (manualSelections.length > 0) {
        failures.push(
          `driver manually selected ${manualSelections.length} transitions ` +
          `(${manualSelections.join(", ")}): only advance() may walk`
        );
      }
      const unmapped = noted.filter((n) => resolveBoundary({ action: n.action } as NextAction) === null);
      if (unmapped.length > 0) {
        failures.push(
          `${unmapped.length} Core actions never resolved to a WorkflowDecision boundary ` +
          `(${unmapped.map((n) => `${n.step}=${n.action}`).join(", ")}): tool steps, not boundaries`
        );
      }
      if (typeof (core as unknown as { advance?: unknown }).advance !== "function") {
        failures.push("ChronoCore.advance is not implemented");
      }
      expect(failures).toEqual([]);
    });

    it("reports BLOCKED on bounded-loop exhaustion (RED)", () => {
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
      const failPhase = (): { actor: string; session: { id: string; token: string } } => {
        const assigned = core.assignReview({ kind: "verification", moduleId: MOD, workPackageId: WP }, gaspar);
        expect(assigned.ok).toBe(true);
        const spek = dispatchRoundTrip("verification", "spekkio");
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
        return spek.worker;
      };
      const fixPhase = (): void => {
        // Governed correction on the freshly OPENED loop, then a
        // PASS verdict that closes it — the next FAILED opens the
        // next attempt. WP stays VERIFYING throughout (no terminal
        // advance), so re-verification can continue.
        const fix = dispatchRoundTrip("correction", "belthazar");
        const rev = core.getArtifact(WP).revision;
        recordEvidenceAs(fix.worker, rev, "fix");
        const looped = core.nextAction({ workPackageId: WP }, gaspar).value!;
        const loopMatch = /'(COR-[0-9]+)'/.exec(looped.summary);
        expect(loopMatch).not.toBe(null);
        expect(core.completeCorrectionLoop(loopMatch![1]!, fix.worker).ok).toBe(true);
        expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, fix.worker).ok).toBe(true);
        expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, fix.worker).ok).toBe(true);
        expect(core.releaseDispatch(fix.dispatchId, fix.worker).ok).toBe(true);
        const reassigned = core.assignReview({ kind: "verification", moduleId: MOD, workPackageId: WP }, gaspar);
        expect(reassigned.ok).toBe(true);
        const spek = dispatchRoundTrip("verification", "spekkio");
        expect(core.recordVerification(MOD, "PASS", "spekkio", [], [], [], spek.worker, WP).ok).toBe(true);
        expect(core.completeReview({ reviewId: reassigned.value!.reviewId }, spek.worker).ok).toBe(true);
        expect(core.releaseDispatch(spek.dispatchId, spek.worker).ok).toBe(true);
      };
      // First failure needs positioned work: implement and verify-ready.
      const impl = dispatchRoundTrip(undefined, "belthazar");
      const rev = core.getArtifact(WP).revision;
      recordEvidenceAs(impl.worker, rev, "unit-impl");
      const test = dispatchRoundTrip("test", "lucca");
      recordEvidenceAs(test.worker, rev, "unit");
      expect(core.releaseDispatch(test.dispatchId, test.worker).ok).toBe(true);
      expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, impl.worker).ok).toBe(true);
      expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, impl.worker).ok).toBe(true);
      expect(core.releaseDispatch(impl.dispatchId, impl.worker).ok).toBe(true);
      failPhase();
      fixPhase();
      failPhase();
      fixPhase();
      failPhase();
      fixPhase();
      // Fourth FAILED exceeds the bound of three: the verdict itself
      // escalates (fresh OPEN row, attempt 4 > max) and raises the PO
      // blocker — so no advance follows; the state is terminally held.
      const assigned4 = core.assignReview({ kind: "verification", moduleId: MOD, workPackageId: WP }, gaspar);
      expect(assigned4.ok).toBe(true);
      const spek4 = dispatchRoundTrip("verification", "spekkio");
      expect(defectId === "").toBe(false);
      expect(core.recordVerification(MOD, "FAILED", "spekkio", [defectId], [], [], spek4.worker, WP).ok).toBe(true);
      // Setup proof: the fourth attempt escalated with a PO blocker.
      const escalations = core.listEvents().filter((e) => e.eventType === "CorrectionEscalated");
      expect(escalations.length).toBe(1);
      // The boundary the stabilized Core must report — today it
      // reports a tool step instead.
      const boundary = core.nextAction({ moduleId: MOD }, gaspar);
      expect(boundary.ok).toBe(true);
      expect(
        resolveBoundary(boundary.value!),
        `escalated loop must surface a BLOCKED boundary; Core reported tool step '${boundary.value!.action}' instead`
      ).toBe("BLOCKED");
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
