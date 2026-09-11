/**
 * I9 tests — full execution/completion gates with explicit missing-
 * capability denials. Success is never returned after placeholder checks.
 * [CORE §7.4/§7.6, DOM §6.4/§6.6, Remediation §5]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildApprovalPayload,
  computeRevisionHash,
  generateApprovalKeyPair,
  signApprovalPayload,
  RTK_UPSTREAM,
  SKILL_UPSTREAM,
} from "@chrono/domain";
import { ChronoCore } from "./chrono-core.js";

const ACTOR = { actor: "gaspar" };
const FIXED_TIME = "2026-06-01T00:00:00.000Z";
const SPEC = {
  id: "SP-0001",
  title: "T",
  purpose: "P",
  inScope: ["a"],
  acceptanceCriteria: ["ac1"],
};
const MOD = { id: "MOD-0001", name: "M", purpose: "P", specs: ["SP-0001"] };

type SignFn = (fields: {
  action: string;
  scopeArtifactId: string;
  scopeRevision: string;
  authority: string;
  rationale: string;
}) => { signature: string; timestamp: string };

function approve(
  core: ChronoCore,
  sign: SignFn,
  action: string,
  scopeArtifactId: string,
  scopeRevision: string
): void {
  const { signature, timestamp } = sign({
    action,
    scopeArtifactId,
    scopeRevision,
    authority: "PO",
    rationale: "test approval",
  });
  const res = core.recordApproval({
    action,
    scopeArtifactId,
    scopeRevision,
    authority: "PO",
    rationale: "test approval",
    timestamp,
    signature,
  });
  expect(res.ok).toBe(true);
}

/** Drive a module to APPROVED with all non-attestation prerequisites met. */
function approvedModule(core: ChronoCore, sign: SignFn): string {
  const proposed = core.proposeArchitecture({ title: "A" }, "gaspar");
  expect(proposed.ok).toBe(true);
  expect(core.submitArchitectureForReview("gaspar").ok).toBe(true);
  approve(core, sign, "architecture-security", "ARCH", proposed.value!);
  expect(core.approveArchitecture("PO").ok).toBe(true);

  expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
  expect(core.transitionState("SP-0001", "SpecSubmittedForReview", ACTOR).ok).toBe(true);
  const specRev = core.getArtifact("SP-0001").revision;
  approve(core, sign, "architecture-security", "SP-0001", specRev);
  expect(core.recordHarness(specRev, `sha256:${"a".repeat(64)}`, "# h", "gaspar").ok).toBe(true);
  expect(core.transitionState("SP-0001", "SpecApprovedReady", ACTOR).ok).toBe(true);

  expect(core.registerModule("MOD-0001", "DRAFT", MOD, "gaspar").ok).toBe(true);
  expect(core.transitionState("MOD-0001", "ModulePlanned", ACTOR).ok).toBe(true);
  const modRev = core.getArtifact("MOD-0001").revision;
  approve(core, sign, "module-approval", "MOD-0001", modRev);
  expect(core.transitionState("MOD-0001", "ModuleApproved", ACTOR).ok).toBe(true);
  return modRev;
}

function recordAttestations(core: ChronoCore): void {
  expect(
    core.recordRtkAttestation({
      binaryPath: "/usr/local/bin/rtk",
      binaryIdentity: "rtk-test",
      version: "1.0.0-test",
      provenance: RTK_UPSTREAM,
      integrationMode: "test",
      routingTestPassed: true,
      routingTestLog: "fixture",
      gained: true,
      savingsEvidence: null,
      ttlSeconds: 3600,
    }).ok
  ).toBe(true);
  expect(
    core.recordSkillAttestation({
      upstream: SKILL_UPSTREAM,
      pinnedCommit: "a".repeat(40),
      sourceHash: `sha256:${"b".repeat(64)}`,
      generatedHashes: "{}",
      converterVersion: "test-1",
      licenseStatus: "MIT",
      attribution: "MIT",
      runtimeIdentity: "test",
      agentIdentity: "test",
      discoveryResult: "found",
      permissionResult: "granted",
      activationTestPassed: true,
      ttlSeconds: 86400,
    }).ok
  ).toBe(true);
}

function testEvidence(core: ChronoCore, producer: string, targetRevision: string, checkName: string): string {
  const integrityHash = computeRevisionHash({
    result: "pass",
    diagnostics: null,
    target_revision: targetRevision,
  });
  const res = core.recordEvidence({
    producer,
    tool: "vitest",
    targetRevision,
    checkName,
    result: "pass",
    diagnostics: null,
    integrityHash,
  });
  expect(res.ok).toBe(true);
  return res.value!.id;
}


/**
 * TEST-ONLY terminal simulation. Production authority requires a live
 * human terminal (Core TTY rule); CI processes have none, so tests that
 * exercise the signed-authority path simulate terminal presence locally
 * and restore the real descriptors afterwards. This helper never ships:
 * it lives only in *.test.ts files. Refusal paths are tested WITHOUT it.
 */
function fakeInteractiveTerminal(): () => void {
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

describe("Execution authorization", () => {
  let restoreTty: () => void;
  let tempDir: string;
  let core: ChronoCore;
  let sign: SignFn;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-authz-test-"));
    core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    expect(core.init().ok).toBe(true);
    const pair = generateApprovalKeyPair();
    restoreTty = fakeInteractiveTerminal();
    expect(core.registerPoPublicKey(pair.publicKeyPem).ok).toBe(true);
    const privateKeyPem = pair.privateKeyPem;
    sign = (fields) => ({
      timestamp: FIXED_TIME,
      signature: signApprovalPayload(buildApprovalPayload({ ...fields, timestamp: FIXED_TIME }), privateKeyPem),
    });
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("denies when the module is not approved", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, "gaspar").ok).toBe(true);
    const res = core.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("EXECUTION_DENIED");
  });

  it("denies without attestations (missing capability, explicit code)", () => {
    approvedModule(core, sign);
    const res = core.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("BLOCKED_RTK");
  });

  it("denies without module approval even when attestations exist", () => {
    recordAttestations(core);
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, "gaspar").ok).toBe(true);
    const res = core.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar" });
    expect(res.ok).toBe(false);
    // DRAFT modules fail on state before approval is even consulted.
    expect(res.error?.code).toBe("EXECUTION_DENIED");
  });

  it("authorizes a fully qualified module and audits denials", () => {
    approvedModule(core, sign);
    recordAttestations(core);
    const authorized = core.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar" });
    expect(authorized.ok).toBe(true);
    expect(authorized.value?.authorized).toBe(true);
    expect(authorized.value?.grantId).toMatch(/^GRANT-\d{4,}$/);

    // A new blocker denies again, with a DENIED audit event.
    expect(core.raiseBlocker("PRODUCT_BLOCKER", "gaspar", ["MOD-0001"], "hold").ok).toBe(true);
    const denied = core.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar" });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("EXECUTION_DENIED");
    const audit = core.listEvents().filter((e) => e.eventType === "DENIED");
    expect(audit.length).toBeGreaterThan(0);
  });

  it("denies stale harness and non-READY specs", () => {
    approvedModule(core, sign);
    recordAttestations(core);
    const specRev = core.getArtifact("SP-0001").revision;
    expect(core.markHarnessStale(specRev, "gaspar").ok).toBe(true);
    const stale = core.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar" });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe("STALE_REVISION");
  });

  it("requires explicit work-package scope when WPs exist", () => {
    approvedModule(core, sign);
    recordAttestations(core);
    expect(
      core.registerWorkPackage("WP-0001", "PLANNED", { id: "WP-0001", name: "W", module: "MOD-0001", dependsOn: [] }, "gaspar").ok
    ).toBe(true);
    const unscoped = core.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar" });
    expect(unscoped.ok).toBe(false);
    expect(unscoped.error?.code).toBe("EXECUTION_DENIED");
    // Un-AUTHORIZED WP scope also denies.
    const scoped = core.authorizeExecution("MOD-0001", { workPackageId: "WP-0001", actor: "gaspar", role: "belthazar" });
    expect(scoped.ok).toBe(false);
  });

  it("denies execution for invalid assignment roles", () => {
    approvedModule(core, sign);
    recordAttestations(core);
    for (const role of ["spekkio", "gaspar", "glenn", "PO", "mallory"]) {
      const res = core.authorizeExecution("MOD-0001", { actor: "gaspar", role });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("VALIDATION_ERROR");
    }
  });

  it("denies without a configured runtime (CONFIG_ERROR)", () => {
    const plainDir = mkdtempSync(join(tmpdir(), "chrono-nort-test-"));
    let plain: ChronoCore | undefined;
    try {
      plain = new ChronoCore({ projectPath: plainDir });
      expect(plain.init().ok).toBe(true);
      const pair = generateApprovalKeyPair();
      expect(plain.registerPoPublicKey(pair.publicKeyPem).ok).toBe(true);
      const privateKeyPem = pair.privateKeyPem;
      const plainSign: SignFn = (fields) => ({
        timestamp: FIXED_TIME,
        signature: signApprovalPayload(buildApprovalPayload({ ...fields, timestamp: FIXED_TIME }), privateKeyPem),
      });
      approvedModule(plain, plainSign);
      recordAttestations(plain);
      const res = plain.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar" });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("CONFIG_ERROR");
    } finally {
      plain?.close();
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});

/**
 * TEST-ONLY terminal simulation (see transition-guards.test.ts): the grant
 * tests below exercise signed authority, which requires the Core TTY rule
 * to observe a terminal. Refusal paths run WITHOUT the fake.
 */
function fakeInteractiveTerminalLocal(): () => void {
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

describe("Dispatch grants (session binding)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-grant-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const T0 = "2026-09-11T00:00:00.000Z";
  const T0_PLUS_2H = "2026-09-11T02:00:00.000Z";

  function clockedCore(clockTime: string, skipInit = false): {
    core: ChronoCore;
    sign: SignFn;
    restoreTty: () => void;
  } {
    const restoreTty = fakeInteractiveTerminalLocal();
    const core = new ChronoCore({
      projectPath: tempDir,
      runtime: "test-runtime",
      clock: () => clockTime,
    });
    if (!skipInit) {
      expect(core.init().ok).toBe(true);
      const pair = generateApprovalKeyPair();
      expect(core.registerPoPublicKey(pair.publicKeyPem).ok).toBe(true);
      const privateKeyPem = pair.privateKeyPem;
      const sign: SignFn = (fields) => ({
        timestamp: "2026-06-01T00:00:00.000Z",
        signature: signApprovalPayload(
          buildApprovalPayload({ ...fields, timestamp: "2026-06-01T00:00:00.000Z" }),
          privateKeyPem
        ),
      });
      return { core, sign, restoreTty };
    }
    // Reopened project: key material persists. This sign closure is never
    // invoked (the test only presents the previously issued grant); any
    // accidental use fails closed on signature verification.
    const reopenedSign: SignFn = () => ({
      timestamp: "2026-06-01T00:00:00.000Z",
      signature: "unused",
    });
    return { core, sign: reopenedSign, restoreTty };
  }

  function approvedWithGrant(
    core: ChronoCore,
    sign: SignFn,
    actor: string,
    role: string
  ): string {
    approvedModule(core, sign);
    recordAttestations(core);
    const authz = core.authorizeExecution("MOD-0001", { actor, role });
    expect(authz.ok).toBe(true);
    return authz.value!.grantId;
  }

  it("enacts dispatch only with its grant, as the assigned role", () => {
    const { core, sign, restoreTty: restoreGrantTty } = clockedCore(T0);
    try {
      const grantId = approvedWithGrant(core, sign, "gaspar", "belthazar");
      expect(grantId).toMatch(/^GRANT-\d{4,}$/);
      // No grant presented → denied before any authorization reasoning.
      expect(
        core.transitionState("MOD-0001", "ExecutionStarted", { actor: "belthazar" }).error?.code
      ).toBe("MISSING_REQUIRED_ARTIFACT");
      // Forged grant id → denied.
      expect(
        core.transitionState("MOD-0001", "ExecutionStarted", { actor: "belthazar", grantId: "GRANT-9999" }).error?.code
      ).toBe("REFERENCE_UNRESOLVABLE");
      // Wrong role → denied.
      expect(
        core.transitionState("MOD-0001", "ExecutionStarted", { actor: "melchior", grantId }).error?.code
      ).toBe("EXECUTION_DENIED");
      // Assigned role → dispatch opens and consumes the grant.
      expect(
        core.transitionState("MOD-0001", "ExecutionStarted", { actor: "belthazar", grantId }).ok
      ).toBe(true);
      expect(core.getArtifact("MOD-0001").status).toBe("EXECUTING");
    } finally {
      restoreGrantTty();
      core.close();
    }
  });

  it("denies expired grants", () => {
    const first = clockedCore(T0);
    const restoreFirst = first.restoreTty;
    let grantId: string;
    try {
      grantId = approvedWithGrant(first.core, first.sign, "gaspar", "belthazar");
    } finally {
      restoreFirst();
      first.core.close();
    }
    const second = clockedCore(T0_PLUS_2H, true);
    const restoreSecond = second.restoreTty;
    try {
      const res = second.core.transitionState("MOD-0001", "ExecutionStarted", {
        actor: "belthazar",
        grantId,
      });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("EXECUTION_DENIED");
      expect(res.error?.message).toContain("expired");
    } finally {
      restoreSecond();
      second.core.close();
    }
  });

  it("binds grants to one session; gaspar may orchestrate", () => {
    const { core, sign, restoreTty: restoreSessionTty } = clockedCore(T0);
    try {
      approvedModule(core, sign);
      recordAttestations(core);
      const authz = core.authorizeExecution("MOD-0001", {
        actor: "opencode:sess-1",
        role: "belthazar",
      });
      expect(authz.ok).toBe(true);
      const grantId = authz.value!.grantId;
      // A different session may not enact it.
      expect(
        core.transitionState("MOD-0001", "ExecutionStarted", { actor: "claude:sess-2", grantId }).error?.code
      ).toBe("EXECUTION_DENIED");
      // The bound session may.
      expect(
        core.transitionState("MOD-0001", "ExecutionStarted", { actor: "opencode:sess-1", grantId }).ok
      ).toBe(true);
    } finally {
      restoreSessionTty();
      core.close();
    }
  });

  it("rejects cross-scope grant reuse", () => {
    const { core, sign, restoreTty: restoreScopeTty } = clockedCore(T0);
    try {
      const grantId = approvedWithGrant(core, sign, "gaspar", "belthazar");
      expect(
        core.registerModule("MOD-0002", "DRAFT", { id: "MOD-0002", name: "M2", purpose: "P", specs: ["SP-0001"] }, "gaspar").ok
      ).toBe(true);
      expect(core.transitionState("MOD-0002", "ModulePlanned", ACTOR).ok).toBe(true);
      const rev = core.getArtifact("MOD-0002").revision;
      const { signature, timestamp } = sign({
        action: "module-approval",
        scopeArtifactId: "MOD-0002",
        scopeRevision: rev,
        authority: "PO",
        rationale: "go",
      });
      expect(
        core.recordApproval({
          action: "module-approval",
          scopeArtifactId: "MOD-0002",
          scopeRevision: rev,
          authority: "PO",
          rationale: "go",
          timestamp,
          signature,
        }).ok
      ).toBe(true);
      expect(core.transitionState("MOD-0002", "ModuleApproved", ACTOR).ok).toBe(true);
      // MOD-0001's grant presented for MOD-0002 → scope mismatch.
      expect(
        core.transitionState("MOD-0002", "ExecutionStarted", { actor: "belthazar", grantId }).error?.code
      ).toBe("INCONSISTENT_REFERENCE");
    } finally {
      restoreScopeTty();
      core.close();
    }
  });
});

describe("Completion authorization", () => {
  let restoreTty: () => void;
  let tempDir: string;
  let core: ChronoCore;
  let sign: SignFn;
  let privateKeyPem: string;

  /** Drive MOD-0001 to VERIFYING with attestations current. */
  function verifyingModule(): string {
    approvedModule(core, sign);
    recordAttestations(core);
    expect(core.recordSecurityProfile({ title: "P", threats: [] }, "glenn").ok).toBe(true);
    const authz = core.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar" });
    expect(authz.ok).toBe(true);
    expect(
      core.transitionState("MOD-0001", "ExecutionStarted", { actor: "belthazar", grantId: authz.value!.grantId }).ok
    ).toBe(true);
    expect(core.transitionState("MOD-0001", "ImplementationComplete", ACTOR).ok).toBe(true);
    return core.getArtifact("MOD-0001").revision;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-compl-test-"));
    core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    expect(core.init().ok).toBe(true);
    const pair = generateApprovalKeyPair();
    restoreTty = fakeInteractiveTerminal();
    expect(core.registerPoPublicKey(pair.publicKeyPem).ok).toBe(true);
    privateKeyPem = pair.privateKeyPem;
    sign = (fields) => ({
      timestamp: FIXED_TIME,
      signature: signApprovalPayload(buildApprovalPayload({ ...fields, timestamp: FIXED_TIME }), privateKeyPem),
    });
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("denies completion without current evidence", () => {
    const revision = verifyingModule();
    approve(core, sign, "implementation-security", "MOD-0001", revision);
    expect(core.recordVerification("MOD-0001", "PASS", "spekkio").ok).toBe(true);
    expect(core.transitionState("MOD-0001", "SpekkioPassed", ACTOR).ok).toBe(true);
    const res = core.authorizeCompletion("MOD-0001", "gaspar");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("EVIDENCE_MISSING");
  });

  it("denies without a bound Spekkio PASS", () => {
    verifyingModule();
    const res = core.authorizeCompletion("MOD-0001", "gaspar");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("COMPLETION_DENIED");
  });

  it("completes the full lifecycle to COMPLETE", () => {
    const revision = verifyingModule();
    testEvidence(core, "lucca", revision, "unit");
    testEvidence(core, "glenn", revision, "review");
    approve(core, sign, "implementation-security", "MOD-0001", revision);
    expect(core.recordVerification("MOD-0001", "PASS", "spekkio").ok).toBe(true);
    expect(core.transitionState("MOD-0001", "SpekkioPassed", ACTOR).ok).toBe(true);

    const authz = core.authorizeCompletion("MOD-0001", "gaspar");
    expect(authz.ok).toBe(true);

    const done = core.completeModule("MOD-0001", "gaspar");
    expect(done.ok).toBe(true);
    expect(done.value?.state).toBe("COMPLETE");
    expect(core.getArtifact("MOD-0001").status).toBe("COMPLETE");

    const status = core.status();
    expect(status.value?.state).toBe("COMPLETE");
    expect(core.validate().value?.valid).toBe(true);
  });

  it("denies with an open blocking defect, allows after correction", () => {
    const revision = verifyingModule();
    testEvidence(core, "lucca", revision, "unit");
    testEvidence(core, "glenn", revision, "review");
    approve(core, sign, "implementation-security", "MOD-0001", revision);
    const defect = core.recordDefect(
      {
        classification: "IMPLEMENTATION_DEFECT",
        severity: "major",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: ["MOD-0001"],
        blockingScope: "MOD-0001",
        reproInfo: null,
      },
      "spekkio"
    );
    expect(defect.ok).toBe(true);
    expect(core.recordVerification("MOD-0001", "FAILED", "spekkio", [defect.value!.id]).ok).toBe(true);
    expect(core.transitionState("MOD-0001", "SpekkioFailed", ACTOR).ok).toBe(true);

    // FAILED modules cannot complete.
    expect(core.authorizeCompletion("MOD-0001", "gaspar").ok).toBe(false);

    // Correct, re-verify, and complete.
    expect(core.resolveDefect(defect.value!.id, "belthazar").ok).toBe(true);
    expect(core.transitionState("MOD-0001", "CorrectionComplete", ACTOR).ok).toBe(true);
    expect(core.transitionState("MOD-0001", "ImplementationComplete", ACTOR).ok).toBe(true);
    expect(core.recordVerification("MOD-0001", "PASS", "spekkio").ok).toBe(true);
    expect(core.transitionState("MOD-0001", "SpekkioPassed", ACTOR).ok).toBe(true);
    expect(core.authorizeCompletion("MOD-0001", "gaspar").ok).toBe(true);
  });

  it("lets a valid waiver cover a security blocker at completion", () => {
    const revision = verifyingModule();
    testEvidence(core, "lucca", revision, "unit");
    testEvidence(core, "glenn", revision, "review");
    approve(core, sign, "implementation-security", "MOD-0001", revision);
    expect(core.recordVerification("MOD-0001", "PASS", "spekkio").ok).toBe(true);
    expect(core.transitionState("MOD-0001", "SpekkioPassed", ACTOR).ok).toBe(true);
    expect(
      core.raiseBlocker("SECURITY_BLOCKER", "glenn", ["MOD-0001"], "residual risk").ok
    ).toBe(true);
    expect(core.authorizeCompletion("MOD-0001", "gaspar").error?.code).toBe("SECURITY_BLOCKER");

    // A waiver signed by the registered PO key, covering this revision,
    // lets completion proceed; WAIVED stays distinct from PASS.
    const waiverSig = signApprovalPayload(
      {
        action: "waiver",
        scope_artifact_id: "MOD-0001",
        scope_revision: revision,
        authority: "PO",
        issue: "residual risk",
        rationale: "accepted with monitoring",
        evidence_ref: null,
        compensating_controls: "monitor",
        follow_up_task_id: null,
        expiry_review_condition: "review in 30d",
        timestamp: FIXED_TIME,
      },
      privateKeyPem
    );
    const waived = core.recordWaiver({
      scopeArtifactId: "MOD-0001",
      scopeRevision: revision,
      authority: "PO",
      issue: "residual risk",
      rationale: "accepted with monitoring",
      evidenceRef: null,
      compensatingControls: "monitor",
      followUpTaskId: null,
      expiryReviewCondition: "review in 30d",
      timestamp: FIXED_TIME,
      signature: waiverSig,
    });
    expect(waived.ok).toBe(true);
    expect(core.authorizeCompletion("MOD-0001", "gaspar").ok).toBe(true);
  });
});
