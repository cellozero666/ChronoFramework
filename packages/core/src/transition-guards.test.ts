/**
 * I6 adversarial tests — authoritative transition guards evaluated by the
 * Core before persistence. Each required guard is omitted in turn and the
 * denial is asserted. All calls carry authenticated sessions.
 * [CORE §6.1/§7, STATE §6, Remediation §2/§3A]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  buildApprovalPayload,
  buildSessionAuthorizationPayload,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore, type CallerAuth } from "./chrono-core.js";

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

type TestSession = { id: string; token: string };

function openTestSession(
  core: ChronoCore,
  role: string,
  scopeModule?: string
): TestSession {
  if (role === "gaspar" || role === "PO") {
    throw new Error("Privileged test sessions require a PO-signed bootstrap");
  }
  const res = core.openSession(
    {
      role,
      adapter: "test-adapter",
      runtime: "test-runtime",
      ...(scopeModule !== undefined ? { scopeModule } : {}),
      ttlSeconds: 3600,
    },
    { interactive: true }
  );
  expect(res.ok).toBe(true);
  return { id: res.value!.id, token: res.value!.token };
}

function approvedArchitecture(core: ChronoCore, sign: SignFn, auth: CallerAuth): string {
  const proposed = core.proposeArchitecture({ title: "A", components: ["c"] }, auth);
  expect(proposed.ok).toBe(true);
  const revision = proposed.value!;
  expect(core.submitArchitectureForReview(auth).ok).toBe(true);
  const { signature, timestamp } = sign({
    action: "architecture-security",
    scopeArtifactId: "ARCH",
    scopeRevision: revision,
    authority: "PO",
    rationale: "secure",
  });
  const approval = core.recordApproval({
    action: "architecture-security",
    scopeArtifactId: "ARCH",
    scopeRevision: revision,
    authority: "PO",
    rationale: "secure",
    timestamp,
    signature,
  });
  expect(approval.ok).toBe(true);
  expect(core.approveArchitecture(auth).ok).toBe(true);
  return revision;
}

function readySpec(core: ChronoCore, sign: SignFn, auth: CallerAuth): string {
  const created = core.registerSpec("SP-0001", "DRAFT", SPEC, auth);
  expect(created.ok).toBe(true);
  expect(core.transitionState("SP-0001", "SpecSubmittedForReview", contextFor(auth)).ok).toBe(true);
  // The REVIEW transition preserves the contract revision: the Harness and
  // the security approval bind it.
  const revision = core.getArtifact("SP-0001").revision;
  const { signature, timestamp } = sign({
    action: "architecture-security",
    scopeArtifactId: "SP-0001",
    scopeRevision: revision,
    authority: "PO",
    rationale: "secure spec",
  });
  const specApproval = core.recordApproval({
    action: "architecture-security",
    scopeArtifactId: "SP-0001",
    scopeRevision: revision,
    authority: "PO",
    rationale: "secure spec",
    timestamp,
    signature,
  });
  expect(specApproval.ok).toBe(true);
  const harness = core.recordHarness(revision, `sha256:${"a".repeat(64)}`, "# harness", auth);
  expect(harness.ok).toBe(true);
  const ready = core.transitionState("SP-0001", "SpecApprovedReady", contextFor(auth));
  expect(ready.ok).toBe(true);
  return core.getArtifact("SP-0001").revision;
}

function contextFor(auth: CallerAuth): { actor: string; session: TestSession } {
  return { actor: auth.actor, session: auth.session };
}

function bootstrapGaspar(core: ChronoCore, privateKeyPem: string): CallerAuth {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = "2026-09-11T00:00:00.000Z";
  const rationale = "test privileged-session bootstrap";
  const signature = signApprovalPayload(
    buildSessionAuthorizationPayload({
      sessionRole: "gaspar",
      adapter: "test-adapter",
      runtime: "test-runtime",
      scopeModule: null,
      scopeWp: null,
      ttlSeconds: 3600,
      nonce,
      authority: "PO",
      rationale,
      timestamp,
    }),
    privateKeyPem
  );
  const res = core.openSession(
    { role: "gaspar", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
    { poAuthorization: { nonce, authority: "PO", rationale, timestamp, signature } }
  );
  expect(res.ok).toBe(true);
  return { actor: "gaspar", session: { id: res.value!.id, token: res.value!.token } };
}

describe("Transition guards", () => {
  let tempDir: string;
  let core: ChronoCore;
  let sign: SignFn;
  let restoreTty: () => void;
  let gaspar: CallerAuth;

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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-guard-test-"));
    core = new ChronoCore({ projectPath: tempDir });
    expect(core.init().ok).toBe(true);
    const pair = generateApprovalKeyPair();
    restoreTty = fakeInteractiveTerminal();
    expect(core.registerPoPublicKey(pair.publicKeyPem).ok).toBe(true);
    sign = (fields) => ({
      signature: signApprovalPayload(
        buildApprovalPayload({ ...fields, timestamp: FIXED_TIME }),
        pair.privateKeyPem
      ),
      timestamp: FIXED_TIME,
    });
    const session = bootstrapGaspar(core, pair.privateKeyPem);
    gaspar = { actor: "gaspar", session: session.session };
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects missing sessions and confused actors", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    // No session presented at all.
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "gaspar" }).ok).toBe(false);
    // Unknown actor fails at identity parsing.
    expect(
      core.transitionState("SP-0001", "SpecSubmittedForReview", {
        actor: "mallory",
        session: gaspar.session,
      }).error?.code
    ).toBe("VALIDATION_ERROR");
    // Known-but-wrong role with another role's session: confusion.
    expect(
      core.transitionState("SP-0001", "SpecSubmittedForReview", {
        actor: "melchior",
        session: gaspar.session,
      }).error?.code
    ).toBe("EXECUTION_DENIED");
    // Forged session token.
    expect(
      core.transitionState("SP-0001", "SpecSubmittedForReview", {
        actor: "gaspar",
        session: { id: gaspar.session.id, token: "forged" },
      }).ok
    ).toBe(false);
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", contextFor(gaspar)).ok).toBe(true);
  });

  it("denies ModuleApproved without a bound approval, allows with one", () => {
    // Release the spec, then plan, then approve without approval → denied.
    approvedArchitecture(core, sign, gaspar);
    readySpec(core, sign, gaspar);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, gaspar).ok).toBe(true);
    expect(core.transitionState("MOD-0001", "ModulePlanned", contextFor(gaspar)).ok).toBe(true);
    const denied = core.transitionState("MOD-0001", "ModuleApproved", contextFor(gaspar));
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("APPROVAL_REQUIRED");

    const revision = core.getArtifact("MOD-0001").revision;
    const modSig = sign({
      action: "module-approval",
      scopeArtifactId: "MOD-0001",
      scopeRevision: revision,
      authority: "PO",
      rationale: "go",
    });
    expect(
      core.recordApproval({
        action: "module-approval",
        scopeArtifactId: "MOD-0001",
        scopeRevision: revision,
        authority: "PO",
        rationale: "go",
        timestamp: modSig.timestamp,
        signature: modSig.signature,
      }).ok,
    ).toBe(true);
    expect(core.transitionState("MOD-0001", "ModuleApproved", contextFor(gaspar)).ok).toBe(true);
  });

  it("denies SpecApprovedReady omitting each prerequisite in turn", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", contextFor(gaspar)).ok).toBe(true);

    // No approved architecture.
    expect(core.transitionState("SP-0001", "SpecApprovedReady", contextFor(gaspar)).error?.code).toBe(
      "APPROVAL_REQUIRED",
    );

    approvedArchitecture(core, sign, gaspar);

    // No architecture-security approval bound to the spec revision.
    expect(core.transitionState("SP-0001", "SpecApprovedReady", contextFor(gaspar)).error?.code).toBe(
      "APPROVAL_REQUIRED",
    );

    const revision = core.getArtifact("SP-0001").revision;
    const specSig = sign({
      action: "architecture-security",
      scopeArtifactId: "SP-0001",
      scopeRevision: revision,
      authority: "PO",
      rationale: "secure spec",
    });
    expect(
      core.recordApproval({
        action: "architecture-security",
        scopeArtifactId: "SP-0001",
        scopeRevision: revision,
        authority: "PO",
        rationale: "secure spec",
        timestamp: specSig.timestamp,
        signature: specSig.signature,
      }).ok,
    ).toBe(true);

    // No Harness.
    expect(core.transitionState("SP-0001", "SpecApprovedReady", contextFor(gaspar)).error?.code).toBe(
      "MISSING_REQUIRED_ARTIFACT",
    );

    // Harness for an unknown revision cannot be recorded.
    expect(core.recordHarness(`sha256:${"b".repeat(64)}`, `sha256:${"a".repeat(64)}`, "# h", gaspar).ok).toBe(
      false,
    );
  });

  it("scopes blockers to project, module, spec, and work packages", () => {
    approvedArchitecture(core, sign, gaspar);
    readySpec(core, sign, gaspar);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, gaspar).ok).toBe(true);
    expect(
      core.registerWorkPackage(
        "WP-0001",
        "PLANNED",
        { id: "WP-0001", name: "W", module: "MOD-0001", dependsOn: [] }
      , gaspar).ok
    ).toBe(true);

    // Project-scoped blocker blocks the projection.
    const projectBlocker = core.raiseBlocker("PRODUCT_BLOCKER", ["default"], "freeze", gaspar);
    expect(projectBlocker.ok).toBe(true);
    expect(core.status().value?.state).toBe("BLOCKED");
    expect(core.resolveBlocker(projectBlocker.value!.id, gaspar).ok).toBe(true);

    // Work-package-scoped blocker denies WP transitions but not the module.
    const wpBlocker = core.raiseBlocker("PRODUCT_BLOCKER", ["WP-0001"], "wp gap", gaspar);
    expect(wpBlocker.ok).toBe(true);
    expect(
      core.transitionState("WP-0001", "BlockerRaised", { ...contextFor(gaspar), blockerId: wpBlocker.value!.id }).ok
    ).toBe(true);
    expect(core.getArtifact("WP-0001").status).toBe("BLOCKED");
    expect(core.getArtifact("MOD-0001").status).toBe("DRAFT");
  });

  it("links BlockerRaised to a live blocker and re-enters the prior state", () => {
    approvedArchitecture(core, sign, gaspar);
    readySpec(core, sign, gaspar);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, gaspar).ok).toBe(true);
    expect(core.transitionState("MOD-0001", "ModulePlanned", contextFor(gaspar)).ok).toBe(true);

    // No blocker id → denied.
    expect(
      core.transitionState("MOD-0001", "BlockerRaised", contextFor(gaspar)).error?.code,
    ).toBe("MISSING_REQUIRED_ARTIFACT");

    const raised = core.raiseBlocker("PRODUCT_BLOCKER", ["MOD-0001"], "gap", gaspar);
    expect(raised.ok).toBe(true);
    const blockerId = raised.value!.id;

    const blocked = core.transitionState("MOD-0001", "BlockerRaised", {
      ...contextFor(gaspar),
      blockerId,
    });
    expect(blocked.ok).toBe(true);
    expect(core.getArtifact("MOD-0001").status).toBe("BLOCKED");

    // Re-entry while still active → denied.
    expect(
      core.transitionState("MOD-0001", "BlockerResolved", { ...contextFor(gaspar), blockerId }).error?.code,
    ).toBe("EXECUTION_DENIED");

    expect(core.resolveBlocker(blockerId, gaspar).ok).toBe(true);
    const reentered = core.transitionState("MOD-0001", "BlockerResolved", {
      ...contextFor(gaspar),
      blockerId,
    });
    expect(reentered.ok).toBe(true);
    expect(reentered.value?.toState).toBe("AWAITING_APPROVAL");
    expect(core.getArtifact("MOD-0001").status).toBe("AWAITING_APPROVAL");
  });

  it("denies ExecutionStarted without authorization and audits the denial", () => {
    approvedArchitecture(core, sign, gaspar);
    readySpec(core, sign, gaspar);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, gaspar).ok).toBe(true);
    expect(core.transitionState("MOD-0001", "ModulePlanned", contextFor(gaspar)).ok).toBe(true);
    const revision = core.getArtifact("MOD-0001").revision;
    const modSig = sign({
      action: "module-approval",
      scopeArtifactId: "MOD-0001",
      scopeRevision: revision,
      authority: "PO",
      rationale: "go",
    });
    expect(
      core.recordApproval({
        action: "module-approval",
        scopeArtifactId: "MOD-0001",
        scopeRevision: revision,
        authority: "PO",
        rationale: "go",
        timestamp: modSig.timestamp,
        signature: modSig.signature,
      }).ok,
    ).toBe(true);
    expect(core.transitionState("MOD-0001", "ModuleApproved", contextFor(gaspar)).ok).toBe(true);

    // ExecutionStarted without a presented grant denies (missing-grant
    // path), and the denial is audited.
    const denied = core.transitionState("MOD-0001", "ExecutionStarted", contextFor(gaspar));
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("MISSING_REQUIRED_ARTIFACT");
    const events = core.listEvents();
    const audit = events.filter((e) => e.eventType === "DENIED");
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[audit.length - 1]?.entityId).toBe("MOD-0001");
  });

  it("validates raiseBlocker inputs", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, gaspar).ok).toBe(true);
    const belthazar = openTestSession(core, "belthazar", "MOD-0001");
    const belthazarAuth = { actor: "belthazar", session: belthazar };
    expect(core.raiseBlocker("NOPE", ["SP-0001"], "r", gaspar).ok).toBe(false);
    expect(core.raiseBlocker("PRODUCT_BLOCKER", ["SP-0001"], "r", { actor: "mallory", session: gaspar.session }).ok).toBe(false);
    expect(core.raiseBlocker("PRODUCT_BLOCKER", [], "r", gaspar).ok).toBe(false);
    expect(core.raiseBlocker("PRODUCT_BLOCKER", ["SP-0001"], "  ", gaspar).ok).toBe(false);
    expect(core.raiseBlocker("PRODUCT_BLOCKER", ["SP-0099"], "r", gaspar).ok).toBe(false);
    // Scoped worker session covers its assignment (SP-0001 belongs to MOD-0001).
    expect(core.raiseBlocker("PRODUCT_BLOCKER", ["SP-0001"], "r", belthazarAuth).ok).toBe(true);
    // ...but not the project scope.
    expect(core.raiseBlocker("PRODUCT_BLOCKER", ["default"], "r", belthazarAuth).ok).toBe(false);
  });

  it("enforces recordVerification role, state, and defect rules", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, gaspar).ok).toBe(true);
    const spekkio = openTestSession(core, "spekkio", "MOD-0001");
    const spekkioAuth = { actor: "spekkio", session: spekkio };

    // Only spekkio records verdicts: belthazar's session is refused.
    const belthazar = openTestSession(core, "belthazar", "MOD-0001");
    expect(
      core.recordVerification("MOD-0001", "PASS", "belthazar", [], [], [], {
        actor: "belthazar",
        session: belthazar,
      }).error?.code
    ).toBe("EXECUTION_DENIED");
    // A DRAFT module is not under verification.
    expect(core.recordVerification("MOD-0001", "PASS", "spekkio", [], [], [], spekkioAuth).error?.code).toBe(
      "INVALID_STATE"
    );
    // Unknown modules fail closed.
    expect(core.recordVerification("MOD-0099", "PASS", "spekkio", [], [], [], spekkioAuth).error?.code).toBe(
      "REFERENCE_UNRESOLVABLE",
    );
  });
});
