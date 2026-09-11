/**
 * I8 tests — deterministic validation implements the P7 §3 checklist.
 * Gate-relevant findings are errors; divergence is an error; a fresh
 * project stays VALID.
 * [P7 §3, Remediation §5]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  buildApprovalPayload,
  computeRevisionHash,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore } from "./chrono-core.js";

type SignFn = (fields: {
  action: string;
  scopeArtifactId: string;
  scopeRevision: string;
  authority: string;
  rationale: string;
}) => { signature: string; timestamp: string };

const ACTOR = { actor: "gaspar" };
const SPEC = {
  id: "SP-0001",
  title: "T",
  purpose: "P",
  inScope: ["a"],
  acceptanceCriteria: ["ac1"],
};
const MOD = { id: "MOD-0001", name: "M", purpose: "P", specs: ["SP-0001"] };

describe("Deterministic validation (P7 §3)", () => {
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

  let tempDir: string;
  let core: ChronoCore;
  let sign: SignFn;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-validate-test-"));
    core = new ChronoCore({ projectPath: tempDir });
    expect(core.init().ok).toBe(true);
    restoreTty = fakeInteractiveTerminal();
    const pair = generateApprovalKeyPair();
    expect(core.registerPoPublicKey(pair.publicKeyPem).ok).toBe(true);
    const privateKeyPem = pair.privateKeyPem;
    sign = (fields) => {
      const timestamp = "2026-06-01T00:00:00.000Z";
      return {
        timestamp,
        signature: signApprovalPayload(buildApprovalPayload({ ...fields, timestamp }), privateKeyPem),
      };
    };
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function approveArchitecture(): void {
    const proposed = core.proposeArchitecture({ title: "A" }, "gaspar");
    expect(proposed.ok).toBe(true);
    expect(core.submitArchitectureForReview("gaspar").ok).toBe(true);
    const { signature, timestamp } = sign({
      action: "architecture-security",
      scopeArtifactId: "ARCH",
      scopeRevision: proposed.value!,
      authority: "PO",
      rationale: "secure",
    });
    expect(
      core.recordApproval({
        action: "architecture-security",
        scopeArtifactId: "ARCH",
        scopeRevision: proposed.value!,
        authority: "PO",
        rationale: "secure",
        timestamp,
        signature,
      }).ok
    ).toBe(true);
    expect(core.approveArchitecture("PO").ok).toBe(true);
  }

  function readySpec(): string {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", ACTOR).ok).toBe(true);
    const revision = core.getArtifact("SP-0001").revision;
    const { signature, timestamp } = sign({
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
        timestamp,
        signature,
      }).ok
    ).toBe(true);
    expect(core.recordHarness(revision, `sha256:${"a".repeat(64)}`, "# h", "gaspar").ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecApprovedReady", ACTOR).ok).toBe(true);
    return core.getArtifact("SP-0001").revision;
  }

  it("reports a fresh project VALID with a runtime warning", () => {
    const result = core.validate();
    expect(result.ok).toBe(true);
    expect(result.value?.valid).toBe(true);
    expect(result.value?.errors).toHaveLength(0);
    expect(result.value?.warnings.some((w) => w.includes("Runtime"))).toBe(true);
  });

  it("treats active blockers as errors, not warnings", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
    expect(core.raiseBlocker("PRODUCT_BLOCKER", "gaspar", ["SP-0001"], "gap").ok).toBe(true);
    const result = core.validate();
    expect(result.value?.valid).toBe(false);
    expect(result.value?.errors.some((e) => e.includes("Active blocker"))).toBe(true);
    expect(result.value?.warnings.some((w) => w.includes("blocker"))).toBe(false);
  });

  it("reports persisted/projected divergence as an error", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
    expect(core.validate().value?.valid).toBe(true);
    // External tamper outside the Core: flip the stored projection.
    const raw = new Database(join(tempDir, ".chrono", "chrono.db"));
    try {
      raw.exec("UPDATE project SET state = 'COMPLETE' WHERE id = 'default'");
    } finally {
      raw.close();
    }
    const result = core.validate();
    expect(result.value?.valid).toBe(false);
    expect(result.value?.errors.some((e) => e.includes("divergence"))).toBe(true);
  });

  it("requires a SecurityProfile once specs are READY", () => {
    approveArchitecture();
    readySpec();
    const missing = core.validate();
    expect(missing.value?.valid).toBe(false);
    expect(missing.value?.errors.some((e) => e.includes("SecurityProfile"))).toBe(true);

    expect(core.recordSecurityProfile({ title: "P", threats: [] }, "gaspar").ok).toBe(true);
    const present = core.validate();
    expect(present.value?.errors.filter((e) => e.includes("SecurityProfile"))).toHaveLength(0);
  });

  it("requires attestations and runtime once execution-relevant", () => {
    approveArchitecture();
    readySpec();
    expect(core.recordSecurityProfile({ title: "P" }, "gaspar").ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, "gaspar").ok).toBe(true);
    expect(core.transitionState("MOD-0001", "ModulePlanned", ACTOR).ok).toBe(true);
    const revision = core.getArtifact("MOD-0001").revision;
    const { signature, timestamp } = sign({
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
        timestamp,
        signature,
      }).ok
    ).toBe(true);
    expect(core.transitionState("MOD-0001", "ModuleApproved", ACTOR).ok).toBe(true);

    const result = core.validate();
    expect(result.value?.valid).toBe(false);
    expect(result.value?.errors.some((e) => e.includes("RTK attestation"))).toBe(true);
    expect(result.value?.errors.some((e) => e.includes("Skill attestation"))).toBe(true);
    expect(result.value?.errors.some((e) => e.includes("Runtime not configured"))).toBe(true);
  });

  it("flags open defects and clears them on resolution", () => {
    const recorded = core.recordDefect(
      {
        classification: "IMPLEMENTATION_DEFECT",
        severity: "major",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: [],
        blockingScope: "MOD-0001",
        reproInfo: null,
      },
      "spekkio"
    );
    expect(recorded.ok).toBe(true);
    expect(core.validate().value?.errors.some((e) => e.includes(recorded.value!.id))).toBe(true);
    expect(core.resolveDefect(recorded.value!.id, "belthazar").ok).toBe(true);
    expect(
      core.validate().value?.errors.some((e) => e.includes(recorded.value!.id))
    ).toBe(false);
  });

  it("flags orphan modules and expired waivers", () => {
    expect(core.registerModule("MOD-0009", "DRAFT", { id: "MOD-0009", name: "O", purpose: "P", specs: [] }, "gaspar").ok).toBe(
      true
    );
    expect(core.validate().value?.errors.some((e) => e.includes("Orphan module"))).toBe(true);
  });

  it("rejects secrets and integrity mismatches in evidence", () => {
    const before = core.listEvents().length;
    const revision = `sha256:${"d".repeat(64)}`;
    const integrity = (result: string, diagnostics: string | null): string =>
      computeRevisionHash({ result, diagnostics, target_revision: revision });
    const leaked = core.recordEvidence({
      producer: "lucca",
      tool: "vitest",
      targetRevision: revision,
      checkName: "unit",
      result: "pass",
      diagnostics: "api_key = 'sk-live-1234567890'",
      integrityHash: integrity("pass", "api_key = 'sk-live-1234567890'"),
    });
    expect(leaked.ok).toBe(false);
    expect(leaked.error?.code).toBe("SECRET_DETECTED");

    const forged = core.recordEvidence({
      producer: "lucca",
      tool: "vitest",
      targetRevision: revision,
      checkName: "unit",
      result: "pass",
      diagnostics: null,
      integrityHash: `sha256:${"e".repeat(64)}`,
    });
    expect(forged.ok).toBe(false);
    expect(forged.error?.code).toBe("VALIDATION_ERROR");

    // Nothing was persisted by either refusal.
    expect(core.listEvents().length).toBe(before);
  });
});
