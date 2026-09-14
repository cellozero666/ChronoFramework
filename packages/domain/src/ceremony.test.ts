/**
 * Exactly-once approval ceremony primitives (TICKET-0024 repair).
 *
 * One human Approve authorizes exactly one ceremony for exactly one
 * ticket: the ceremony key binds canonical project, runtime session,
 * question/request id, ticket, scope, action, and revision; grant
 * authority requires a valid explicit-answer marker at the current
 * policy AND single-ticket binding (one observation fanning out
 * over several tickets is never authoritative).
 */
import { describe, it, expect } from "vitest";
import {
  AUTHORITY_POLICY_VERSION,
  approvalGrantsAuthoritative,
  buildCeremonyKey,
  CEREMONY_MARKER_CURRENT,
  permissionBoundApprovalAuthoritative,
  type CeremonyBinding,
} from "./index.js";

const BINDING: CeremonyBinding = {
  project: "/Volumes/Studio/HOSTS/CHRONOTESTAPP",
  sessionId: "ses-abc123",
  requestId: "req-7",
  ticketId: "TICKET-0024",
  scopeArtifactId: "OPEN-0001",
  action: "planning-approval",
  scopeRevision: `sha256:${"d".repeat(64)}`,
};

describe("buildCeremonyKey", () => {
  it("is deterministic and binds every component", () => {
    const first = buildCeremonyKey(BINDING);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(buildCeremonyKey({ ...BINDING })).toBe(first);
    const variants: Array<Partial<CeremonyBinding>> = [
      { project: "/other" },
      { sessionId: "ses-other" },
      { requestId: "req-other" },
      { ticketId: "TICKET-0025" },
      { scopeArtifactId: "OPEN-0002" },
      { action: "module-approval" },
      { scopeRevision: `sha256:${"e".repeat(64)}` },
    ];
    for (const variant of variants) {
      expect(buildCeremonyKey({ ...BINDING, ...variant })).not.toBe(first);
    }
  });

  it("rejects malformed components fail-closed", () => {
    expect(() => buildCeremonyKey({ ...BINDING, ticketId: "TICKET-24" })).toThrow();
    expect(() => buildCeremonyKey({ ...BINDING, sessionId: "" })).toThrow();
    expect(() => buildCeremonyKey({ ...BINDING, requestId: "" })).toThrow();
    expect(() => buildCeremonyKey({ ...BINDING, project: "" })).toThrow();
    expect(() => buildCeremonyKey({ ...BINDING, scopeRevision: "x".repeat(1025) })).toThrow();
  });
});

describe("approvalGrantsAuthoritative", () => {
  const grant = (ticketId: string, callId: string | null, ceremony = CEREMONY_MARKER_CURRENT): Record<string, unknown> => ({
    ticketId,
    ceremony,
    policyVersion: AUTHORITY_POLICY_VERSION,
    ...(callId === null
      ? {}
      : { nativeObservation: { permissionCallId: callId, decidedAt: "2026-09-14T00:00:00.000Z", autoModeProbed: true } }),
  });

  it("needs at least one grant event", () => {
    expect(approvalGrantsAuthoritative([], AUTHORITY_POLICY_VERSION)).toBe(false);
  });

  it("leaves classic interactive approvals unaffected", () => {
    expect(approvalGrantsAuthoritative([{ action: "module-approval" }], AUTHORITY_POLICY_VERSION)).toBe(true);
  });

  it("accepts v1 and v2 markers at the current policy", () => {
    expect(approvalGrantsAuthoritative([grant("TICKET-0001", "req-1", "question-answer-v1")], AUTHORITY_POLICY_VERSION)).toBe(true);
    expect(approvalGrantsAuthoritative([grant("TICKET-0001", "req-1")], AUTHORITY_POLICY_VERSION)).toBe(true);
  });

  it("rejects vulnerable, stale-policy, and unknown ceremonies", () => {
    expect(approvalGrantsAuthoritative([{ ticketId: "TICKET-0002", policyVersion: "7" }], AUTHORITY_POLICY_VERSION)).toBe(false);
    expect(
      approvalGrantsAuthoritative([{ ...grant("TICKET-0003", "req-1", "question-answer-v1"), policyVersion: "7" }], AUTHORITY_POLICY_VERSION)
    ).toBe(false);
    expect(approvalGrantsAuthoritative([{ ticketId: "TICKET-0004", ceremony: "something-else", policyVersion: AUTHORITY_POLICY_VERSION }], AUTHORITY_POLICY_VERSION)).toBe(false);
  });

  it("rejects one observation fanned out over several tickets", () => {
    expect(
      approvalGrantsAuthoritative([grant("TICKET-0024", "req-7"), grant("TICKET-0025", "req-7")], AUTHORITY_POLICY_VERSION)
    ).toBe(false);
  });

  it("keeps genuinely separate ceremonies aliasing one row authoritative", () => {
    expect(
      approvalGrantsAuthoritative([grant("TICKET-0030", "req-a"), grant("TICKET-0031", "req-b")], AUTHORITY_POLICY_VERSION)
    ).toBe(true);
  });

  it("single-ticket grants stay authoritative across repeated observations", () => {
    expect(
      approvalGrantsAuthoritative([grant("TICKET-0040", "req-x"), grant("TICKET-0040", "req-x")], AUTHORITY_POLICY_VERSION)
    ).toBe(true);
  });

  it("permissionBoundApprovalAuthoritative delegates to the multi-grant judgment", () => {
    expect(permissionBoundApprovalAuthoritative({ action: "module-approval" }, AUTHORITY_POLICY_VERSION)).toBe(true);
    expect(
      permissionBoundApprovalAuthoritative(
        { ticketId: "TICKET-0001", ceremony: CEREMONY_MARKER_CURRENT, policyVersion: AUTHORITY_POLICY_VERSION },
        AUTHORITY_POLICY_VERSION
      )
    ).toBe(true);
    expect(
      permissionBoundApprovalAuthoritative({ ticketId: "TICKET-0002", policyVersion: "7" }, AUTHORITY_POLICY_VERSION)
    ).toBe(false);
  });
});
