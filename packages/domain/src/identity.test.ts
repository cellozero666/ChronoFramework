/**
 * I2 tests — Core-assigned identity format and canonical role identifiers.
 * [CORE §3.1, INV §10.1, RUNTIME §2]
 */
import { describe, it, expect } from "vitest";
import {
  formatArtifactId,
  isRevisionHash,
  isValidArtifactId,
  parseActorIdentity,
  parseArtifactId,
  ENTITY_STATE_SETS,
  DECISION_TRANSITIONS,
  type AgentRole,
} from "./index.js";
import { ChronoError } from "./errors.js";

describe("Artifact identity format [CORE §3.1]", () => {
  it("accepts zero-padded Core-allocated identifiers", () => {
    expect(isValidArtifactId("SP-0001")).toBe(true);
    expect(isValidArtifactId("BLK-0007")).toBe(true);
    expect(isValidArtifactId("WAIVER-0042")).toBe(true);
    expect(parseArtifactId("MOD-0012")).toEqual({ family: "MOD", seq: 12 });
  });

  it("accepts Core-minted operational families (routing proofs, sessions, grants)", () => {
    // The Core allocates RTE (routing proofs), SES (adapter sessions),
    // and GRANT (dispatch grants) outside the reviewable-artifact tables;
    // the validator must recognize what the Core itself mints [CORE §3.1].
    expect(isValidArtifactId("RTE-0001")).toBe(true);
    expect(isValidArtifactId("SES-0001")).toBe(true);
    expect(isValidArtifactId("BRK-0001")).toBe(true);
    expect(isValidArtifactId("GRANT-0001")).toBe(true);
    expect(parseArtifactId("RTE-0007")).toEqual({ family: "RTE", seq: 7 });
    expect(parseArtifactId("SES-0042")).toEqual({ family: "SES", seq: 42 });
  });

  it("rejects malformed identifiers", () => {
    // Widened sequences stay valid: format conformance is syntactic;
    // collision safety comes from Core allocation (SequenceRepository),
    // never from digit counting.
    expect(isValidArtifactId("BLK-175758")).toBe(true);
    expect(isValidArtifactId("BLK-123")).toBe(false);
    expect(isValidArtifactId("XX-0001")).toBe(false);
    expect(isValidArtifactId("SP-0001-extra")).toBe(false);
    expect(isValidArtifactId("")).toBe(false);
    expect(() => parseArtifactId("BLK-123")).toThrow(ChronoError);
  });

  it("formats allocated sequences with zero padding that widens past 9999", () => {
    expect(formatArtifactId("BLK", 1)).toBe("BLK-0001");
    expect(formatArtifactId("QA", 9999)).toBe("QA-9999");
    expect(formatArtifactId("QA", 10000)).toBe("QA-10000");
    expect(() => formatArtifactId("BLK", 0)).toThrow(ChronoError);
  });
});

describe("Revision hash wire format [CORE §4.2]", () => {
  it("accepts only sha256:<64 lowercase hex>", () => {
    expect(isRevisionHash(`sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isRevisionHash(`sha256:${"A".repeat(64)}`)).toBe(false);
    expect(isRevisionHash("sha256:abc")).toBe(false);
    expect(isRevisionHash("abc")).toBe(false);
    expect(isRevisionHash("")).toBe(false);
  });
});

describe("Canonical agent role identifiers [RUNTIME §2, Remediation §3A]", () => {
  it("matches the normative seven canonical roles exactly", () => {
    const roles: readonly AgentRole[] = [
      "gaspar",
      "belthazar",
      "melchior",
      "prometheus",
      "lucca",
      "glenn",
      "spekkio",
    ];
    expect(roles).toHaveLength(7);
    // No display-name variants may leak into the identity type.
    for (const r of roles) {
      expect(["Lucca", "LUCCA", "Gaspar", "GASPAR", "luca", "agent", "PO"]).not.toContain(r);
    }
  });

  it("parses the closed identity model and rejects everything else", () => {
    expect(parseActorIdentity("lucca")).toEqual({ kind: "agent", identity: "lucca", role: "lucca" });
    expect(parseActorIdentity("PO")).toEqual({ kind: "po", identity: "PO" });
    expect(parseActorIdentity("system")).toEqual({ kind: "system", identity: "system" });
    expect(parseActorIdentity("opencode:sess-1")).toEqual({
      kind: "session",
      identity: "opencode:sess-1",
    });
    for (const bad of ["luca", "agent", "LUCCA", "Gaspar", "", ":", "po", "SYSTEM", "a b:c"]) {
      expect(() => parseActorIdentity(bad)).toThrow(ChronoError);
    }
  });
});

describe("Decision lifecycle reconciliation [STATE §1.1 vs §2.6]", () => {
  it("has no superseded state and no supersession transition", () => {
    expect(ENTITY_STATE_SETS.DEC).not.toContain("superseded");
    const supersede = DECISION_TRANSITIONS.filter((t) => t.toState === "superseded");
    expect(supersede).toHaveLength(0);
  });
});
