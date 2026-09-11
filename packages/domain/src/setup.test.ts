/**
 * Setup state-machine unit tests [SLICE-10 §3.3]. Pure domain logic:
 * step ordering, advance legality, and the entry-action table.
 */
import { describe, it, expect } from "vitest";
import {
  BROKER_SESSION_TTL_SECONDS,
  SETUP_STEPS,
  isLegalSetupAdvance,
  setupStepIndex,
} from "./setup.js";

describe("Setup step chain", () => {
  it("defines the twelve-step chain in slice order", () => {
    expect(SETUP_STEPS).toEqual([
      "DETECTED",
      "CONSENTED",
      "PROJECT_INITIALIZED",
      "PO_ENROLLED",
      "RUNTIMES_SELECTED",
      "RTK_VERIFIED_AND_ROUTED",
      "SKILL_VERIFIED_AND_EMITTED",
      "ADAPTERS_REGISTERED_AND_APPROVED",
      "NATIVE_HOOKS_INSTALLED",
      "RUNTIME_CONFORMANCE_PASSED",
      "GASPAR_ENTRY_PREPARED",
      "READY",
    ]);
  });

  it("allows same-step re-entry and exactly-next-step only", () => {
    expect(isLegalSetupAdvance(null, "DETECTED")).toBe(true);
    expect(isLegalSetupAdvance(null, "READY")).toBe(false);
    expect(isLegalSetupAdvance("DETECTED", "DETECTED")).toBe(true);
    expect(isLegalSetupAdvance("DETECTED", "CONSENTED")).toBe(true);
    expect(isLegalSetupAdvance("DETECTED", "READY")).toBe(false);
    expect(isLegalSetupAdvance("READY", "READY")).toBe(true);
    expect(isLegalSetupAdvance("CONSENTED", "DETECTED")).toBe(false);
    expect(isLegalSetupAdvance("BOGUS", "DETECTED")).toBe(false);
    expect(setupStepIndex("NOPE")).toBe(-1);
  });

  it("bounds broker sessions to a short TTL", () => {
    expect(BROKER_SESSION_TTL_SECONDS).toBe(1800);
  });
});
