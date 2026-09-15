/**
 * Lifecycle CLI tests: next-action, execution/evidence status,
 * deep-check, reviews, corrections, policy calibration, dispatch
 * confirm/release/revoke/reconcile, and module completion — all
 * through the run* functions with explicit caller credentials.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import {
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
  RTK_UPSTREAM,
  SKILL_RELEASE,
  SKILL_RUNTIME_PATHS,
  SKILL_UPSTREAM,
} from "@chrono/domain";
import { ChronoCore } from "@chrono/core";
import { FIXTURE_SKILL_MD } from "../test/test-skill-fixture.js";
import { runDispatchClaim, runDispatchRequest, runDispatchTaskCheck } from "./dispatch-cli.js";
import {
  runCompleteModule,
  runCorrectionComplete,
  runCorrectionOpen,
  runDeepCheck,
  runDispatchConfirm,
  runDispatchReconcile,
  runDispatchRelease,
  runDispatchRevoke,
  runEvidenceStatus,
  runExecutionStatus,
  runModuleActivate,
  runNextAction,
  runPolicySet,
  runPolicyStatus,
  runReviewAssign,
  runReviewComplete,
  runReviewReconcile,
  runScopeAdvance,
} from "./lifecycle-cli.js";

const SPEC = { id: "SP-0001", title: "T", purpose: "P", inScope: ["a"], acceptanceCriteria: ["ac1"] };
const MOD = { id: "MOD-0002", name: "M", purpose: "P", specs: ["SP-0001"] };

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

describe("Lifecycle CLI", () => {
  let tempDir: string;
  let root: string;
  let gasparToken = "";
  let gasparSession: { id: string; token: string } = { id: "", token: "" };
  let signingKey = "";
  let restoreTty: () => void;
  const gasparKey = "gaspar-session-1";

  function hostTokenPath(sessionKey: string): string {
    const canonical = realpathSync(root);
    const hash = createHash("sha256").update(`${canonical}|${sessionKey}`, "utf8").digest("hex").slice(0, 16);
    return join(tmpdir(), `chrono-gaspar-host-${hash}.token`);
  }

  function openPrivileged(core: ChronoCore, role: "gaspar" | "PO", key: string): { id: string; token: string } {
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

  function approve(core: ChronoCore, action: string, scopeId: string, scopeRev: string): string {
    const signature = signApprovalPayload(
      buildApprovalPayload({
        action, scopeArtifactId: scopeId, scopeRevision: scopeRev,
        authority: "PO", rationale: "test approval", timestamp: "2026-09-14T00:00:00.000Z",
      }),
      signingKey
    );
    const res = core.recordApproval({
      action, scopeArtifactId: scopeId, scopeRevision: scopeRev,
      authority: "PO", rationale: "test approval", timestamp: "2026-09-14T00:00:00.000Z", signature,
    });
    expect(res.ok).toBe(true);
    return res.value!.id;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-lifecycle-cli-test-"));
    root = tempDir;
    const core = new ChronoCore({ projectPath: tempDir, runtime: "opencode" });
    try {
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
      gasparSession = openPrivileged(core, "gaspar", signingKey);
      gasparToken = `${gasparSession.id}/${gasparSession.token}`;
      const gaspar = { actor: "gaspar", session: gasparSession };
      const po = { actor: "PO", session: openPrivileged(core, "PO", signingKey) };
      const proposed = core.proposeArchitecture({ title: "A" }, gaspar);
      expect(proposed.ok).toBe(true);
      expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
      approve(core, "architecture-security", "ARCH", proposed.value!);
      expect(core.approveArchitecture(gaspar).ok).toBe(true);
      expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
      expect(core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar).ok).toBe(true);
      const specRev = core.getArtifact("SP-0001").revision;
      approve(core, "architecture-security", "SP-0001", specRev);
      expect(core.recordHarness(specRev, `sha256:${"a".repeat(64)}`, "# h", gaspar).ok).toBe(true);
      expect(core.transitionState("SP-0001", "SpecApprovedReady", gaspar).ok).toBe(true);
      expect(core.registerModule("MOD-0002", "DRAFT", MOD, gaspar).ok).toBe(true);
      expect(
        core.registerWorkPackage("WP-0001", "PLANNED", { id: "WP-0001", name: "W", module: "MOD-0002", dependsOn: [] }, gaspar).ok
      ).toBe(true);
      expect(core.transitionState("MOD-0002", "ModulePlanned", gaspar).ok).toBe(true);
      approve(core, "module-approval", "MOD-0002", core.getArtifact("MOD-0002").revision);
      expect(core.transitionState("MOD-0002", "ModuleApproved", gaspar).ok).toBe(true);
      expect(core.transitionState("WP-0001", "WorkPackageAuthorized", gaspar).ok).toBe(true);
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
      expect(
        core.registerAdapter({ id: "fixture", name: "Fixture", entrypoint, conformanceProof: ["fixture --version"] }, po).ok
      ).toBe(true);
      const registrationHash = core.adapterRegistrationHash("fixture");
      const adapterApprovalId = approve(core, "adapter-registration", "fixture", registrationHash);
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
    } finally {
      core.close();
    }
    writeFileSync(hostTokenPath(gasparKey), gasparToken, { mode: 0o600 });
  });

  afterEach(() => {
    restoreTty();
    try {
      rmSync(hostTokenPath(gasparKey), { force: true });
    } catch {
      // best-effort
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  const auth = () => ({ as: "gaspar", sessionToken: gasparToken, json: true });

  function fullDispatch(agent = "belthazar", kind?: string): { dispatchId: string; workerToken: string } {
    const req = runDispatchRequest(root, {
      module: "MOD-0002", wp: "WP-0001", rationale: "drive the lifecycle",
      as: "gaspar", sessionToken: gasparToken, adapter: "fixture", opencodeSession: gasparKey, json: true,
      ...(kind !== undefined ? { kind } : {}),
    });
    expect(req.exitCode).toBe(0);
    const dispatchId = (JSON.parse(req.stdout) as { dispatchId: string }).dispatchId;
    const checked = runDispatchTaskCheck(root, { session: gasparKey, agent, json: true });
    expect(checked.exitCode).toBe(0);
    const workerKey = `worker-${dispatchId}`;
    const claimed = runDispatchClaim(root, { dispatch: dispatchId, agent, workerSessionKey: workerKey, json: true });
    expect(claimed.exitCode).toBe(0);
    const workerFile = join(
      tmpdir(),
      `chrono-gaspar-host-${createHash("sha256").update(`${realpathSync(root)}|${workerKey}`, "utf8").digest("hex").slice(0, 16)}.token`
    );
    const workerToken = readFileSync(workerFile, "utf8").trim();
    const confirmed = runDispatchConfirm(root, { as: "gaspar", sessionToken: gasparToken, dispatch: dispatchId, json: true });
    expect(confirmed.exitCode).toBe(0);
    return { dispatchId, workerToken };
  }

  it("next-action answers request-dispatch on a fresh package and denies without credentials", () => {
    const out = runNextAction(root, { ...auth(), wp: "WP-0001" });
    expect(out.exitCode).toBe(0);
    const body = JSON.parse(out.stdout) as { action: string; kind: string; policyRule: string };
    expect(body.action).toBe("request-dispatch");
    expect(body.kind).toBe("implementation");
    expect(body.policyRule).toContain("profile=standard");
    const denied = runNextAction(root, { as: "gaspar", wp: "WP-0001", json: true });
    expect(denied.exitCode).toBe(1);
    expect(JSON.parse(denied.stdout).error.code).toBe("VALIDATION_ERROR");
  });

  it("execution-status, evidence-status, and release close a binding with no secrets", () => {
    const { dispatchId, workerToken } = fullDispatch();
    const workerId = workerToken.slice(0, workerToken.indexOf("/"));
    const exec = runExecutionStatus(root, { as: "belthazar", sessionToken: workerToken, wp: "WP-0001", json: true });
    expect(exec.exitCode).toBe(0);
    const execBody = JSON.parse(exec.stdout) as { ownDispatch: { status: string; role: string } };
    expect(execBody.ownDispatch.status).toBe("ACTIVE");
    expect(execBody.ownDispatch.role).toBe("belthazar");
    expect(exec.stdout).not.toContain(workerToken.slice(workerToken.indexOf("/") + 1));
    // Release without evidence denies; record evidence, then release completes.
    const early = runDispatchRelease(root, { as: "belthazar", sessionToken: workerToken, dispatch: dispatchId, json: true });
    expect(early.exitCode).toBe(1);
    const core = new ChronoCore({ projectPath: root, runtime: "opencode" });
    try {
      const wpRev = core.getArtifact("WP-0001").revision;
      expect(core.recordEvidence({
        producer: "belthazar", tool: "vitest", targetRevision: wpRev, checkName: "unit",
        result: "pass", diagnostics: null,
        integrityHash: computeRevisionHash({ result: "pass", diagnostics: null, target_revision: wpRev }),
      }, { actor: "belthazar", session: { id: workerId, token: workerToken.slice(workerToken.indexOf("/") + 1) } }).ok).toBe(true);
      const ev = runEvidenceStatus(root, { as: "gaspar", sessionToken: gasparToken, revision: wpRev, json: true });
      expect(ev.exitCode).toBe(0);
      expect((JSON.parse(ev.stdout) as { current: unknown[] }).current).toHaveLength(1);
    } finally {
      core.close();
    }
    const released = runDispatchRelease(root, { as: "belthazar", sessionToken: workerToken, dispatch: dispatchId, json: true });
    expect(released.exitCode).toBe(0);
    expect((JSON.parse(released.stdout) as { status: string }).status).toBe("COMPLETED");
  });

  it("deep-check, policy-status, and reconcile answer cleanly on a healthy project", () => {
    const deep = runDeepCheck(root, auth());
    expect(deep.exitCode).toBe(0);
    expect((JSON.parse(deep.stdout) as { blockerCount: number }).blockerCount).toBe(0);
    const policy = runPolicyStatus(root, { json: true });
    expect(policy.exitCode).toBe(0);
    expect((JSON.parse(policy.stdout) as { profile: string }).profile).toBe("standard");
    const raised = runPolicySet(root, { ...auth(), profile: "critical", rationale: "test escalation" });
    expect(raised.exitCode).toBe(0);
    expect((JSON.parse(raised.stdout) as { profile: string }).profile).toBe("critical");
    const lowered = runPolicySet(root, { ...auth(), profile: "lean", rationale: "test downgrade" });
    expect(lowered.exitCode).toBe(1);
    const rec = runDispatchReconcile(root, auth());
    expect(rec.exitCode).toBe(0);
  });

  it("reviews refuse premature assignment, then assign and deny completion without bound proof", () => {
    // CF-12: an AUTHORIZED package has no positioned work, so review
    // assignment is refused before any row is committed.
    const premature = runReviewAssign(root, { ...auth(), kind: "security-review", module: "MOD-0002", wp: "WP-0001" });
    expect(premature.exitCode).toBe(1);
    expect(JSON.parse(premature.stdout).error.code).toBe("EXECUTION_DENIED");
    // Position the work through a bound implementation dispatch, then assign.
    const { workerToken } = fullDispatch();
    const advanced = runScopeAdvance(root, {
      as: "belthazar", sessionToken: workerToken, module: "MOD-0002", wp: "WP-0001",
      event: "ImplementationDone", json: true,
    });
    expect(advanced.exitCode).toBe(0);
    const assigned = runReviewAssign(root, { ...auth(), kind: "security-review", module: "MOD-0002", wp: "WP-0001" });
    expect(assigned.exitCode).toBe(0);
    const reviewId = (JSON.parse(assigned.stdout) as { reviewId: string }).reviewId;
    expect(reviewId).toMatch(/^REV-/);
    const bad = runReviewAssign(root, { ...auth(), kind: "audit", module: "MOD-0002" });
    expect(bad.exitCode).toBe(1);
    const incomplete = runReviewComplete(root, { as: "glenn", sessionToken: gasparToken, review: reviewId, json: true });
    expect(incomplete.exitCode).toBe(1);
  });

  it("corrections refuse unknown defects and completion refuses unready modules", () => {
    const opened = runCorrectionOpen(root, { ...auth(), defect: "DEF-9999" });
    expect(opened.exitCode).toBe(1);
    const looped = runCorrectionComplete(root, { ...auth(), loop: "COR-9999" });
    expect(looped.exitCode).toBe(1);
    const done = runCompleteModule(root, { ...auth(), module: "MOD-0002" });
    expect(done.exitCode).toBe(1);
    const revoked = runDispatchRevoke(root, { ...auth(), dispatch: "DSP-9999", reason: "test" });
    expect(revoked.exitCode).toBe(1);
  });

  it("module-activate advances DRAFT to APPROVED idempotently, never on planning approval alone", () => {
    const core = new ChronoCore({ projectPath: root, runtime: "opencode" });
    try {
      expect(core.registerModule("MOD-0009", "DRAFT", { id: "MOD-0009", name: "M", purpose: "P", specs: ["SP-0001"] }, { actor: "gaspar", session: gasparSession }).ok).toBe(true);
      const modRev = core.getArtifact("MOD-0009").revision;
      // Planning approval alone: activation denies, state stays DRAFT.
      approve(core, "planning-approval", "MOD-0009", modRev);
      const denied = runModuleActivate(root, { ...auth(), module: "MOD-0009" });
      expect(denied.exitCode).toBe(1);
      expect(JSON.parse(denied.stdout).error.code).toBe("APPROVAL_REQUIRED");
      expect(core.getArtifact("MOD-0009").status).toBe("DRAFT");
      // Both approvals current: activation advances exactly once.
      approve(core, "module-approval", "MOD-0009", modRev);
      const first = runModuleActivate(root, { ...auth(), module: "MOD-0009" });
      expect(first.exitCode).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({ ok: true, state: "APPROVED", activated: true });
      const replay = runModuleActivate(root, { ...auth(), module: "MOD-0009" });
      expect(replay.exitCode).toBe(0);
      expect(JSON.parse(replay.stdout)).toMatchObject({ ok: true, state: "APPROVED", activated: false });
      // Unknown modules deny without leaking internals.
      const ghost = runModuleActivate(root, { ...auth(), module: "MOD-9999" });
      expect(ghost.exitCode).toBe(1);
    } finally {
      core.close();
    }
  });

  it("review-reconcile preserves premature rows as invalid non-blocking history", async () => {
    const { ChronoDatabase } = await import("@chrono/persistence");
    const core = new ChronoCore({ projectPath: root, runtime: "opencode" });
    try {
      expect(core.registerModule("MOD-0012", "DRAFT", { id: "MOD-0012", name: "N", purpose: "P", specs: ["SP-0001"] }, { actor: "gaspar", session: gasparSession }).ok).toBe(true);
      expect(
        core.registerWorkPackage("WP-0012", "PLANNED", { id: "WP-0012", name: "W12", module: "MOD-0012", dependsOn: [] }, { actor: "gaspar", session: gasparSession }).ok
      ).toBe(true);
    } finally {
      core.close();
    }
    const legacy = new ChronoDatabase({ path: join(root, ".chrono", "chrono.db") });
    const wpRev = (() => {
      const probe = new ChronoCore({ projectPath: root, runtime: "opencode" });
      try {
        return probe.getArtifact("WP-0012").revision;
      } finally {
        probe.close();
      }
    })();
    try {
      legacy.reviewAssignments().create({
        id: "REV-0001", kind: "verification", moduleId: "MOD-0012", workPackageId: "WP-0012",
        targetRevision: wpRev, reviewerRole: "spekkio", createdAt: new Date().toISOString(),
      });
    } finally {
      legacy.close();
    }
    const reconciled = runReviewReconcile(root, { ...auth(), review: "REV-0001" });
    expect(reconciled.exitCode).toBe(0);
    expect(JSON.parse(reconciled.stdout)).toMatchObject({ ok: true, status: "INVALID" });
    const again = runReviewReconcile(root, { ...auth(), review: "REV-0001" });
    expect(again.exitCode).toBe(1);
    const ghost = runReviewReconcile(root, { ...auth(), review: "REV-9999" });
    expect(ghost.exitCode).toBe(1);
  });
});
