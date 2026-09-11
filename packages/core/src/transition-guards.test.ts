/**
 * I6 adversarial tests — authoritative transition guards evaluated by the
 * Core before persistence. Each required guard is omitted in turn and the
 * denial is asserted.
 * [CORE §6.1/§7, STATE §6, Remediation §2]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildApprovalPayload,
  generateApprovalKeyPair,
  signApprovalPayload,
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

function approvedArchitecture(core: ChronoCore, sign: SignFn): string {
  const proposed = core.proposeArchitecture({ title: "A", components: ["c"] }, "gaspar");
  expect(proposed.ok).toBe(true);
  const revision = proposed.value!;
  expect(core.submitArchitectureForReview("gaspar").ok).toBe(true);
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
  expect(core.approveArchitecture("PO").ok).toBe(true);
  return revision;
}

function readySpec(core: ChronoCore, sign: SignFn): string {
  const created = core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar");
  expect(created.ok).toBe(true);
  expect(core.transitionState("SP-0001", "SpecSubmittedForReview", ACTOR).ok).toBe(true);
  // The REVIEW transition advances the revision: the Harness and the
  // security approval bind the current (REVIEW) revision.
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
  const harness = core.recordHarness(revision, `sha256:${"a".repeat(64)}`, "# harness", "gaspar");
  expect(harness.ok).toBe(true);
  const ready = core.transitionState("SP-0001", "SpecApprovedReady", ACTOR);
  expect(ready.ok).toBe(true);
  return core.getArtifact("SP-0001").revision;
}

describe("Transition guards", () => {
  let tempDir: string;
  let core: ChronoCore;
  let sign: SignFn;
  let restoreTty: () => void;

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
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects anonymous and unknown actors", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview").ok).toBe(false);
    const unknown = core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "mallory" });
    expect(unknown.ok).toBe(false);
    expect(unknown.error?.code).toBe("VALIDATION_ERROR");
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", ACTOR).ok).toBe(true);
  });

  it("denies ModuleApproved without a bound approval, allows with one", () => {
    // Release the spec, then plan, then approve without approval → denied.
    approvedArchitecture(core, sign);
    readySpec(core, sign);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, "gaspar").ok).toBe(true);
    expect(core.transitionState("MOD-0001", "ModulePlanned", ACTOR).ok).toBe(true);
    const denied = core.transitionState("MOD-0001", "ModuleApproved", ACTOR);
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
    expect(core.transitionState("MOD-0001", "ModuleApproved", ACTOR).ok).toBe(true);
  });

  it("denies SpecApprovedReady omitting each prerequisite in turn", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", ACTOR).ok).toBe(true);

    // No approved architecture.
    expect(core.transitionState("SP-0001", "SpecApprovedReady", ACTOR).error?.code).toBe(
      "APPROVAL_REQUIRED",
    );

    approvedArchitecture(core, sign);

    // No architecture-security approval bound to the spec revision.
    expect(core.transitionState("SP-0001", "SpecApprovedReady", ACTOR).error?.code).toBe(
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
    expect(core.transitionState("SP-0001", "SpecApprovedReady", ACTOR).error?.code).toBe(
      "MISSING_REQUIRED_ARTIFACT",
    );

    // Stale Harness (recorded for a different revision).
    expect(core.recordHarness(`sha256:${"b".repeat(64)}`, `sha256:${"a".repeat(64)}`, "# h", "gaspar").ok).toBe(
      false,
    );
  });

  it("scopes blockers to project, module, spec, and work packages", () => {
    approvedArchitecture(core, sign);
    readySpec(core, sign);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, "gaspar").ok).toBe(true);
    expect(
      core.registerWorkPackage(
        "WP-0001",
        "PLANNED",
        { id: "WP-0001", name: "W", module: "MOD-0001", dependsOn: [] }
      , "gaspar").ok
    ).toBe(true);

    // Project-scoped blocker blocks the projection.
    const projectBlocker = core.raiseBlocker("PRODUCT_BLOCKER", "gaspar", ["default"], "freeze");
    expect(projectBlocker.ok).toBe(true);
    expect(core.status().value?.state).toBe("BLOCKED");
    expect(core.resolveBlocker(projectBlocker.value!.id, "gaspar").ok).toBe(true);

    // Work-package-scoped blocker denies WP transitions but not the module.
    const wpBlocker = core.raiseBlocker("PRODUCT_BLOCKER", "gaspar", ["WP-0001"], "wp gap");
    expect(wpBlocker.ok).toBe(true);
    expect(
      core.transitionState("WP-0001", "BlockerRaised", { ...ACTOR, blockerId: wpBlocker.value!.id }).ok
    ).toBe(true);
    expect(core.getArtifact("WP-0001").status).toBe("BLOCKED");
    expect(core.getArtifact("MOD-0001").status).toBe("DRAFT");
  });

  it("links BlockerRaised to a live blocker and re-enters the prior state", () => {
    approvedArchitecture(core, sign);
    readySpec(core, sign);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, "gaspar").ok).toBe(true);
    expect(core.transitionState("MOD-0001", "ModulePlanned", ACTOR).ok).toBe(true);

    // No blocker id → denied.
    expect(
      core.transitionState("MOD-0001", "BlockerRaised", ACTOR).error?.code,
    ).toBe("MISSING_REQUIRED_ARTIFACT");

    const raised = core.raiseBlocker("PRODUCT_BLOCKER", "gaspar", ["MOD-0001"], "gap");
    expect(raised.ok).toBe(true);
    const blockerId = raised.value!.id;

    const blocked = core.transitionState("MOD-0001", "BlockerRaised", {
      ...ACTOR,
      blockerId,
    });
    expect(blocked.ok).toBe(true);
    expect(core.getArtifact("MOD-0001").status).toBe("BLOCKED");

    // Re-entry while still active → denied.
    expect(
      core.transitionState("MOD-0001", "BlockerResolved", { ...ACTOR, blockerId }).error?.code,
    ).toBe("EXECUTION_DENIED");

    expect(core.resolveBlocker(blockerId, "gaspar").ok).toBe(true);
    const reentered = core.transitionState("MOD-0001", "BlockerResolved", {
      ...ACTOR,
      blockerId,
    });
    expect(reentered.ok).toBe(true);
    expect(reentered.value?.toState).toBe("AWAITING_APPROVAL");
    expect(core.getArtifact("MOD-0001").status).toBe("AWAITING_APPROVAL");
  });

  it("denies ExecutionStarted without authorization and audits the denial", () => {
    approvedArchitecture(core, sign);
    readySpec(core, sign);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, "gaspar").ok).toBe(true);
    expect(core.transitionState("MOD-0001", "ModulePlanned", ACTOR).ok).toBe(true);
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
    expect(core.transitionState("MOD-0001", "ModuleApproved", ACTOR).ok).toBe(true);

    // ExecutionStarted without a presented grant denies (missing-grant
    // path), and the denial is audited.
    const denied = core.transitionState("MOD-0001", "ExecutionStarted", ACTOR);
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("MISSING_REQUIRED_ARTIFACT");
    const events = core.listEvents();
    const audit = events.filter((e) => e.eventType === "DENIED");
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[audit.length - 1]?.entityId).toBe("MOD-0001");
  });

  it("validates raiseBlocker inputs", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
    expect(core.raiseBlocker("NOPE", "gaspar", ["SP-0001"], "r").ok).toBe(false);
    expect(core.raiseBlocker("PRODUCT_BLOCKER", "mallory", ["SP-0001"], "r").ok).toBe(false);
    expect(core.raiseBlocker("PRODUCT_BLOCKER", "gaspar", [], "r").ok).toBe(false);
    expect(core.raiseBlocker("PRODUCT_BLOCKER", "gaspar", ["SP-0001"], "  ").ok).toBe(false);
    expect(core.raiseBlocker("PRODUCT_BLOCKER", "gaspar", ["SP-0099"], "r").ok).toBe(false);
    expect(core.raiseBlocker("PRODUCT_BLOCKER", "gaspar", ["SP-0001"], "r").ok).toBe(true);
  });

  it("enforces recordVerification role, state, and defect rules", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, "gaspar").ok).toBe(true);

    // Only spekkio records verdicts.
    expect(core.recordVerification("MOD-0001", "PASS", "belthazar").error?.code).toBe(
      "VALIDATION_ERROR",
    );
    // A DRAFT module is not under verification.
    expect(core.recordVerification("MOD-0001", "PASS", "spekkio").error?.code).toBe("INVALID_STATE");
    // Unknown modules fail closed.
    expect(core.recordVerification("MOD-0099", "PASS", "spekkio").error?.code).toBe(
      "REFERENCE_UNRESOLVABLE",
    );
  });
});
