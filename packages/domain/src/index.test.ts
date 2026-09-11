/**
 * Unit tests derived directly from docs/domain/CORE-INVARIANTS.md
 * [FW §287] — "no stubs, TODO-only paths, skipped mandatory checks"
 *
 * These tests prove deterministic invariant enforcement at the domain level.
 */

import { describe, it, expect } from "vitest";
import {
  validateTransition,
  isValidState,
  projectProjectState,
  computeRevisionHash,
  verifyRevisionHash,
  isStaleReference,
  ENTITY_STATE_SETS,
  TRANSITION_TABLES,
  PROJECT_DIRECTIONAL_CONSTRAINTS,
  ErrorCode,
  Severity,
  ChronoError,
} from "../src/index.js";

describe("I-02.1: Legal state sets", () => {
  it("Project has exactly 9 states", () => {
    expect(new Set(ENTITY_STATE_SETS.PROJECT)).toEqual(
      new Set([
        "UNINITIALIZED", "ANALYZING", "ARCHITECTING", "SPECIFYING",
        "PLANNING", "EXECUTING", "VERIFYING", "COMPLETE", "BLOCKED",
      ])
    );
  });

  it("Specification has exactly 4 states", () => {
    expect(new Set(ENTITY_STATE_SETS.SP)).toEqual(
      new Set(["DRAFT", "REVIEW", "READY", "SUPERSEDED"])
    );
  });

  it("Module has exactly 9 states", () => {
    expect(new Set(ENTITY_STATE_SETS.MOD)).toEqual(
      new Set([
        "DRAFT", "AWAITING_APPROVAL", "APPROVED", "EXECUTING",
        "VERIFYING", "PASSED", "FAILED", "COMPLETE", "BLOCKED",
      ])
    );
  });

  it("WorkPackage has exactly 8 states", () => {
    expect(new Set(ENTITY_STATE_SETS.WP)).toEqual(
      new Set([
        "PLANNED", "AUTHORIZED", "RUNNING", "BLOCKED",
        "IMPLEMENTED", "VERIFYING", "FAILED", "COMPLETE",
      ])
    );
  });

  it("Verification has exactly 5 states with WAIVED distinct from PASSED", () => {
    expect(new Set(ENTITY_STATE_SETS.VERIFICATION)).toEqual(
      new Set(["PENDING", "RUNNING", "FAILED", "PASSED", "WAIVED"])
    );
  });

  it("isValidState returns false for invalid states", () => {
    expect(isValidState("PROJECT", "INVALID")).toBe(false);
    expect(isValidState("SP", "READY")).toBe(true);
  });
});

describe("I-02.2: Legal transitions only", () => {
  it("allows legal Specification DRAFT → REVIEW", () => {
    const t = validateTransition("SP", "DRAFT", "REVIEW", "SpecSubmittedForReview");
    expect(t.fromState).toBe("DRAFT");
    expect(t.toState).toBe("REVIEW");
  });

  it("rejects illegal Specification DRAFT → READY", () => {
    expect(() =>
      validateTransition("SP", "DRAFT", "READY", "SpecApprovedReady")
    ).toThrowError(ChronoError);
    try {
      validateTransition("SP", "DRAFT", "READY", "SpecApprovedReady");
    } catch (e) {
      expect((e as ChronoError).code).toBe(ErrorCode.ILLEGAL_TRANSITION);
    }
  });

  it("rejects DRAFT → COMPLETE for Module", () => {
    expect(() =>
      validateTransition("MOD", "DRAFT", "COMPLETE", "ModuleCompleted")
    ).toThrowError(ChronoError);
  });

  it("allows ANY → BLOCKED for Module (BlockerRaised)", () => {
    const states = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "EXECUTING", "VERIFYING"];
    for (const state of states) {
      const t = validateTransition("MOD", state, "BLOCKED", "BlockerRaised");
      expect(t.toState).toBe("BLOCKED");
    }
  });

  it("rejects illegal transition with INVALID_STATE code for unknown state", () => {
    try {
      validateTransition("SP", "DRAFT", "MAYBE", "SomeEvent");
    } catch (e) {
      expect((e as ChronoError).code).toBe(ErrorCode.INVALID_STATE);
    }
  });

  it("allows legal Module AWAITING_APPROVAL → APPROVED", () => {
    const t = validateTransition("MOD", "AWAITING_APPROVAL", "APPROVED", "ModuleApproved");
    expect(t.toState).toBe("APPROVED");
  });

  it("allows legal Module APPROVED → EXECUTING", () => {
    const t = validateTransition("MOD", "APPROVED", "EXECUTING", "ExecutionStarted");
    expect(t.toState).toBe("EXECUTING");
  });

  it("allows legal Module VERIFYING → PASSED", () => {
    const t = validateTransition("MOD", "VERIFYING", "PASSED", "SpekkioPassed");
    expect(t.toState).toBe("PASSED");
  });

  it("allows legal Module FAILED → EXECUTING (correction)", () => {
    const t = validateTransition("MOD", "FAILED", "EXECUTING", "CorrectionComplete");
    expect(t.toState).toBe("EXECUTING");
  });

  it("allows legal WorkPackage PLANNED → AUTHORIZED", () => {
    const t = validateTransition("WP", "PLANNED", "AUTHORIZED", "WorkPackageAuthorized");
    expect(t.toState).toBe("AUTHORIZED");
  });

  it("allows legal WorkPackage AUTHORIZED → RUNNING", () => {
    const t = validateTransition("WP", "AUTHORIZED", "RUNNING", "ExecutionAssigned");
    expect(t.toState).toBe("RUNNING");
  });

  it("allows legal Verification RUNNING → PASSED", () => {
    const t = validateTransition("VERIFICATION", "RUNNING", "PASSED", "VerificationPassed");
    expect(t.toState).toBe("PASSED");
  });

  it("allows legal Verification RUNNING → WAIVED", () => {
    const t = validateTransition("VERIFICATION", "RUNNING", "WAIVED", "VerificationWaived");
    expect(t.toState).toBe("WAIVED");
  });
});

describe("I-02.4: WAIVED is never PASSED", () => {
  it("WAIVED and PASSED are distinct values", () => {
    expect(ENTITY_STATE_SETS.VERIFICATION).toContain("WAIVED");
    expect(ENTITY_STATE_SETS.VERIFICATION).toContain("PASSED");
    expect("WAIVED").not.toBe("PASSED");
  });

  it("Verification WAIVED → PENDING on new revision", () => {
    const t = validateTransition(
      "VERIFICATION", "WAIVED", "PENDING",
      "NewRevisionRequiresReverification"
    );
    expect(t.toState).toBe("PENDING");
  });

  it("Verification WAIVED → PASSED is illegal", () => {
    expect(() =>
      validateTransition("VERIFICATION", "WAIVED", "PASSED", "SomeEvent")
    ).toThrowError(ChronoError);
  });

  it("Verification PASSED → WAIVED is illegal", () => {
    expect(() =>
      validateTransition("VERIFICATION", "PASSED", "WAIVED", "SomeEvent")
    ).toThrowError(ChronoError);
  });
});

describe("I-02.3: Project projection correctness", () => {
  it("no hidden blockers — active blocker forces BLOCKED", () => {
    const state = projectProjectState({
      initialized: true,
      blockers: [{ active: true, targetType: "PROJECT" }],
      modules: [{ state: "COMPLETE" }],
      workPackages: [],
      specifications: [],
      hasSpecs: false,
      systemAnalysisComplete: true,
      architectureState: "approved",
      planningInProgress: false,
    });
    expect(state).toBe("BLOCKED");
  });

  it("no hidden running work — RUNNING WP forces EXECUTING", () => {
    const state = projectProjectState({
      initialized: true,
      blockers: [],
      modules: [{ state: "APPROVED" }],
      workPackages: [{ state: "RUNNING" }],
      specifications: [],
      hasSpecs: true,
      systemAnalysisComplete: true,
      architectureState: "approved",
      planningInProgress: false,
    });
    expect(state).toBe("EXECUTING");
  });

  it("no hidden await approval — AWAITING_APPROVAL forces at least PLANNING", () => {
    const state = projectProjectState({
      initialized: true,
      blockers: [],
      modules: [{ state: "AWAITING_APPROVAL" }],
      workPackages: [],
      specifications: [{ state: "READY" }],
      hasSpecs: true,
      systemAnalysisComplete: true,
      architectureState: "approved",
      planningInProgress: true,
    });
    expect(state).toBe("PLANNING");
  });

  it("no premature completion — FAILED module prevents COMPLETE", () => {
    const state = projectProjectState({
      initialized: true,
      blockers: [],
      modules: [{ state: "FAILED" }],
      workPackages: [{ state: "FAILED" }],
      specifications: [],
      hasSpecs: true,
      systemAnalysisComplete: true,
      architectureState: "approved",
      planningInProgress: false,
    });
    expect(state).toBe("VERIFYING");
  });

  it("COMPLETE requires all modules COMPLETE and zero active blockers", () => {
    const state = projectProjectState({
      initialized: true,
      blockers: [],
      modules: [{ state: "COMPLETE" }],
      workPackages: [],
      specifications: [{ state: "READY" }],
      hasSpecs: true,
      systemAnalysisComplete: true,
      architectureState: "approved",
      planningInProgress: false,
    });
    expect(state).toBe("COMPLETE");
  });

  it("uninitialized project with no analysis is UNINITIALIZED", () => {
    const state = projectProjectState({
      initialized: false,
      blockers: [],
      modules: [],
      workPackages: [],
      specifications: [],
      hasSpecs: false,
      systemAnalysisComplete: false,
      architectureState: undefined,
      planningInProgress: false,
    });
    expect(state).toBe("UNINITIALIZED");
  });

  it("initialized project with no analysis is ANALYZING", () => {
    const state = projectProjectState({
      initialized: true,
      blockers: [],
      modules: [],
      workPackages: [],
      specifications: [],
      hasSpecs: false,
      systemAnalysisComplete: false,
      architectureState: undefined,
      planningInProgress: false,
    });
    expect(state).toBe("ANALYZING");
  });

  it("all modules complete but with active blocker forces BLOCKED", () => {
    const state = projectProjectState({
      initialized: true,
      blockers: [{ active: true, targetType: "MODULE" }],
      modules: [{ state: "COMPLETE" }],
      workPackages: [],
      specifications: [{ state: "READY" }],
      hasSpecs: true,
      systemAnalysisComplete: true,
      architectureState: "approved",
      planningInProgress: false,
    });
    expect(state).toBe("BLOCKED");
  });

  it("system analysis complete, no specs, architecture in progress is ARCHITECTING", () => {
    const state = projectProjectState({
      initialized: true,
      blockers: [],
      modules: [],
      workPackages: [],
      specifications: [],
      hasSpecs: false,
      systemAnalysisComplete: true,
      architectureState: "under_review",
      planningInProgress: false,
    });
    expect(state).toBe("ARCHITECTING");
  });
});

describe("I-03.1: Material change invalidates approval (revision hashing)", () => {
  it("different content produces different revision hash", () => {
    const content1 = { name: "test", value: 1 };
    const content2 = { name: "test", value: 2 };
    const hash1 = computeRevisionHash(content1);
    const hash2 = computeRevisionHash(content2);
    expect(hash1).not.toBe(hash2);
  });

  it("identical content produces identical revision hash", () => {
    const content1 = { name: "test", value: 1 };
    const content2 = { name: "test", value: 1 };
    const hash1 = computeRevisionHash(content1);
    const hash2 = computeRevisionHash(content2);
    expect(hash1).toBe(hash2);
  });

  it("hash format is sha256: prefix + 64 hex chars", () => {
    const hash = computeRevisionHash({ test: true });
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("verifyRevisionHash returns true for matching content", () => {
    const content = { name: "test", value: 1 };
    const hash = computeRevisionHash(content);
    expect(verifyRevisionHash(content, hash)).toBe(true);
  });

  it("verifyRevisionHash returns false for divergent content", () => {
    const content = { name: "test", value: 1 };
    const hash = computeRevisionHash(content);
    expect(verifyRevisionHash({ name: "test", value: 2 }, hash)).toBe(false);
  });

  it("isStaleReference detects stale revision binding", () => {
    const currentHash = computeRevisionHash({ version: 2 });
    const staleHash = computeRevisionHash({ version: 1 });
    expect(isStaleReference(staleHash, currentHash)).toBe(true);
    expect(isStaleReference(currentHash, currentHash)).toBe(false);
  });

  it("canonical JSON sorts keys deterministically", () => {
    const content1 = { b: 2, a: 1, c: 3 };
    const content2 = { c: 3, a: 1, b: 2 };
    expect(computeRevisionHash(content1)).toBe(computeRevisionHash(content2));
  });

  it("nested objects sorted deterministically", () => {
    const content1 = { outer: { z: 1, a: 2 } };
    const content2 = { outer: { a: 2, z: 1 } };
    expect(computeRevisionHash(content1)).toBe(computeRevisionHash(content2));
  });
});

describe("I-14: Error taxonomy", () => {
  it("ChronoError carries structured fields", () => {
    const err = new ChronoError({
      code: ErrorCode.EXECUTION_DENIED,
      severity: Severity.BLOCKER,
      message: "Spec is not READY",
      invariantRef: "INV §5.1",
      affectedTarget: "SP-001",
      suggestedAction: "Promote Spec to READY",
    });
    expect(err.code).toBe("EXECUTION_DENIED");
    expect(err.severity).toBe("BLOCKER");
    expect(err.invariantRef).toBe("INV §5.1");
    expect(err.affectedTarget).toBe("SP-001");
  });

  it("toJSON produces machine-readable output", () => {
    const err = new ChronoError({
      code: ErrorCode.ILLEGAL_TRANSITION,
      severity: Severity.ERROR,
      message: "Test error",
    });
    const json = err.toJSON();
    expect(json["code"]).toBe("ILLEGAL_TRANSITION");
    expect(json["severity"]).toBe("ERROR");
    expect(json["message"]).toBe("Test error");
  });
});

describe("Project directional constraints", () => {
  it("PROJECT_DIRECTIONAL_CONSTRAINTS has correct progression order", () => {
    expect(PROJECT_DIRECTIONAL_CONSTRAINTS.progression).toEqual([
      "UNINITIALIZED", "ANALYZING", "ARCHITECTING",
      "SPECIFYING", "PLANNING", "EXECUTING",
      "VERIFYING", "COMPLETE",
    ]);
  });

  it("COMPLETE is terminal", () => {
    expect(PROJECT_DIRECTIONAL_CONSTRAINTS.terminal).toBe("COMPLETE");
  });
});

describe("Transition table completeness", () => {
  it("every entity type has a transition table", () => {
    const entityTypes: Array<[string, string]> = [
      ["SP", "Specification"],
      ["MOD", "Module"],
      ["WP", "WorkPackage"],
      ["VERIFICATION", "Verification"],
      ["ADR", "ADR"],
      ["BLK", "Blocker"],
      ["DEF", "Defect"],
      ["WAIVER", "Waiver"],
      ["RTK", "RTKAttestation"],
      ["SKILL", "SkillAttestation"],
    ];
    for (const [key, _name] of entityTypes) {
      const table = TRANSITION_TABLES[key];
      expect(table).toBeDefined();
      expect(table).not.toBeNull();
      if (table === undefined) return;
      expect(table.length).toBeGreaterThan(0);
      const states = ENTITY_STATE_SETS[key as keyof typeof ENTITY_STATE_SETS];
      expect(states).toBeDefined();
      if (states === undefined) return;
      for (const t of table) {
        if (t.fromState !== "ANY") {
          expect(states).toContain(t.fromState);
        }
        expect(states).toContain(t.toState);
      }
    }
  });
});
