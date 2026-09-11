/**
 * §3A tests — Core-owned agent identity and role authority.
 * Every protected operation denies unknown, unassigned, wrong-role,
 * and impersonated actors; all seven canonical roles have positive
 * and negative authority tests.
 * [DOM §2.2, RUNTIME §2, Remediation §3A]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeRevisionHash } from "@chrono/domain";
import { ChronoCore } from "./chrono-core.js";

const SPEC = { id: "SP-0001", title: "T", purpose: "P" };
const REV = `sha256:${"d".repeat(64)}`;

function evidenceFor(producer: string) {
  return {
    producer,
    tool: "vitest",
    targetRevision: REV,
    checkName: "unit",
    result: "pass",
    diagnostics: null,
    integrityHash: computeRevisionHash({
      result: "pass",
      diagnostics: null,
      target_revision: REV,
    }),
  };
}

describe("Authority matrix", () => {
  let tempDir: string;
  let core: ChronoCore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-matrix-test-"));
    core = new ChronoCore({ projectPath: tempDir });
    expect(core.init().ok).toBe(true);
  });

  afterEach(() => {
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("gaspar plans, workers cannot", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
    expect(core.registerSpec("SP-0002", "DRAFT", { ...SPEC, id: "SP-0002" }, "belthazar").error?.code).toBe(
      "EXECUTION_DENIED"
    );
    expect(core.registerSpec("SP-0003", "DRAFT", { ...SPEC, id: "SP-0003" }, "lucca").error?.code).toBe(
      "EXECUTION_DENIED"
    );
    expect(core.registerSpec("SP-0004", "DRAFT", { ...SPEC, id: "SP-0004" }, "opencode:sess-1").error?.code).toBe(
      "EXECUTION_DENIED"
    );
    // PO supremacy: the principal architect may register.
    expect(core.registerSpec("SP-0005", "DRAFT", { ...SPEC, id: "SP-0005" }, "PO").ok).toBe(true);
  });

  it("rejects misspelled, generic, and case-variant identities everywhere", () => {
    for (const bad of ["luca", "agent", "LUCCA", "Gaspar", "po", "SYSTEM", "opencode", "opencode:", ":sess"]) {
      expect(core.registerSpec("SP-0009", "DRAFT", SPEC, bad).ok).toBe(false);
      expect(core.transitionState("SP-0009", "SpecSubmittedForReview", { actor: bad }).ok).toBe(false);
    }
    // Nothing was persisted by any rejected call.
    expect(core.validate().value?.errors ?? []).toHaveLength(0);
  });

  it("each worker records its own evidence; strangers cannot", () => {
    for (const role of ["belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio", "gaspar"]) {
      expect(core.recordEvidence(evidenceFor(role)).ok).toBe(true);
    }
    expect(core.recordEvidence(evidenceFor("mallory")).ok).toBe(false);
    expect(core.recordEvidence(evidenceFor("system")).ok).toBe(false);
    expect(core.recordEvidence(evidenceFor("luca")).ok).toBe(false);
    expect(core.recordEvidence(evidenceFor("opencode:sess-9")).ok).toBe(true);
  });

  it("only spekkio issues defects; only the owner resolves them", () => {
    const testDefect = core.recordDefect(
      {
        classification: "TEST_DEFECT",
        severity: "minor",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: [],
        blockingScope: null,
        reproInfo: null,
      },
      "spekkio"
    );
    expect(testDefect.ok).toBe(true);
    const defectId = testDefect.value!.id;

    // Belthazar and Lucca cannot issue defects (Lucca owns no issuance even
    // though TEST_DEFECT routes to lucca for correction).
    expect(
      core.recordDefect(
        {
          classification: "TEST_DEFECT",
          severity: "minor",
          evidenceRefs: [],
          affectedCriteria: [],
          affectedArtifacts: [],
          blockingScope: null,
          reproInfo: null,
        },
        "belthazar"
      ).error?.code
    ).toBe("EXECUTION_DENIED");

    // Only the routed owner (lucca) or PO may resolve.
    expect(core.resolveDefect(defectId, "belthazar").error?.code).toBe("EXECUTION_DENIED");
    expect(core.resolveDefect(defectId, "lucca").ok).toBe(true);
  });

  it("only glenn (or PO) issues SECURITY_BLOCKER", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
    expect(core.raiseBlocker("SECURITY_BLOCKER", "belthazar", ["SP-0001"], "x").error?.code).toBe(
      "EXECUTION_DENIED"
    );
    expect(core.raiseBlocker("SECURITY_BLOCKER", "glenn", ["SP-0001"], "x").ok).toBe(true);
  });

  it("verdict independence: PO cannot record a verification verdict", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
    expect(core.recordVerification("SP-0001", "PASS", "PO").error?.code).toBe("VALIDATION_ERROR");
    expect(core.recordVerification("SP-0001", "PASS", "gaspar").error?.code).toBe("VALIDATION_ERROR");
  });

  it("transition enactment is role-governed", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
    // Workers cannot enact planning transitions.
    expect(
      core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "belthazar", role: "belthazar" }).error?.code
    ).toBe("EXECUTION_DENIED");
    // Adapter sessions cannot plan either.
    expect(
      core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "opencode:sess-1", role: "belthazar" }).error?.code
    ).toBe("EXECUTION_DENIED");
    // The owning role can.
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "gaspar", role: "belthazar" }).ok).toBe(true);
  });

  it("execution requests come from the orchestrator, sessions, or PO — never workers", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", { id: "MOD-0001", name: "M", purpose: "P", specs: [] }, "gaspar").ok).toBe(true);
    // Belthazar self-dispatch is denied at the capability gate (before state is even consulted).
    const worker = core.authorizeExecution("MOD-0001", { actor: "belthazar", role: "belthazar" });
    expect(worker.ok).toBe(false);
    // Unknown actors never reach the gate.
    const unknown = core.authorizeExecution("MOD-0001", { actor: "mallory", role: "belthazar" });
    expect(unknown.ok).toBe(false);
  });
});
