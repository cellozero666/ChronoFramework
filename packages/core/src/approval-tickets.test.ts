/**
 * OC-P11 integrated approval ceremony — Core ticket tests (ADR-007).
 *
 * The native permission-bound path replaces the TTY ceremony inside
 * OpenCode sessions: single-use tickets, exact-revision binding,
 * Ed25519 PO signatures (model forgery dies at verification), replay /
 * stale / expired / unknown-ticket denial, and worker exclusion. Chat
 * text alone authorizes nothing at this layer either.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import {
  AUTHORITY_POLICY_VERSION,
  approvalChallenge,
  approvalGrantsAuthoritative,
  buildApprovalPayload,
  buildCeremonyKey,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  permissionBoundApprovalAuthoritative,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore, type CallerAuth } from "./chrono-core.js";

const FIXED_TIME = "2026-09-14T00:00:00.000Z";

function enrollTestPo(core: ChronoCore, pair: { publicKeyPem: string; privateKeyPem: string }): void {
  const nonce = randomBytes(16).toString("hex");
  const fingerprint = fingerprintPublicKey(pair.publicKeyPem);
  const confirmation = buildEnrollmentChallenge("default", fingerprint, nonce);
  const timestamp = new Date().toISOString();
  const signature = signApprovalPayload(
    buildEnrollmentPayload({ projectId: "default", fingerprint, timestamp, nonce, authority: "PO", rationale: "test", confirmation }),
    pair.privateKeyPem
  );
  expect(core.enrollPo({ publicKeyPem: pair.publicKeyPem, nonce, timestamp, rationale: "test", confirmation, signature }).ok).toBe(true);
}

function bootstrapSession(core: ChronoCore, role: "gaspar" | "PO", signingKey: string): { id: string; token: string } {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = "2026-09-11T00:00:00.000Z";
  const signature = signApprovalPayload(
    buildSessionAuthorizationPayload({
      sessionRole: role, adapter: "test-adapter", runtime: "test-runtime",
      scopeModule: null, scopeWp: null, ttlSeconds: 3600, nonce,
      authority: "PO", rationale: "test", timestamp,
    }),
    signingKey
  );
  const res = core.openSession(
    { role, adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
    { poAuthorization: { nonce, authority: "PO", rationale: "test", timestamp, signature } }
  );
  expect(res.ok).toBe(true);
  return { id: res.value!.id, token: res.value!.token };
}

function fakeTty(): () => void {
  const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  return () => {
    if (stdinDesc !== undefined) Object.defineProperty(process.stdin, "isTTY", stdinDesc);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdoutDesc !== undefined) Object.defineProperty(process.stdout, "isTTY", stdoutDesc);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  };
}

const OBSERVATION = { permissionCallId: "call-001", decidedAt: FIXED_TIME, autoModeProbed: true };

/**
 * Exactly-once ceremony binding for tests: the Core recomputes the
 * key from its own canonical root, so tests must canonicalize the
 * temp dir exactly the way the Core does (macOS /var skew).
 */
function ceremonyFor(
  projectPath: string,
  ticket: { id: string; scopeArtifactId: string; action: string; scopeRevision: string },
  sessionId = "ses-test-1",
  requestId = "req-test-1"
): { key: string; sessionId: string; requestId: string } {
  return {
    key: buildCeremonyKey({
      project: realpathSync(projectPath),
      sessionId,
      requestId,
      ticketId: ticket.id,
      scopeArtifactId: ticket.scopeArtifactId,
      action: ticket.action,
      scopeRevision: ticket.scopeRevision,
    }),
    sessionId,
    requestId,
  };
}

function ticketBinding(ticketId: string, scopeRevision: string): {
  id: string;
  scopeArtifactId: string;
  action: string;
  scopeRevision: string;
} {
  return { id: ticketId, scopeArtifactId: "REQ-0001", action: "planning-approval", scopeRevision };
}

describe("OC-P11 approval tickets (ADR-007)", () => {
  let tempDir: string;
  let core: ChronoCore;
  let signingKey = "";
  let gaspar: CallerAuth;
  let restoreTty: () => void;
  let draftRev = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-tickets-test-"));
    core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    expect(core.init().ok).toBe(true);
    const pair = generateApprovalKeyPair();
    restoreTty = fakeTty();
    enrollTestPo(core, pair);
    signingKey = pair.privateKeyPem;
    gaspar = { actor: "gaspar", session: bootstrapSession(core, "gaspar", signingKey) };
    const draft = core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0001", title: "R", body: "Body." }, gaspar);
    expect(draft.ok).toBe(true);
    draftRev = draft.value!.revision;
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function requestTicket(): { ticketId: string; challenge: string; expiresAt: string } {
    const res = core.requestApprovalTicket({
      action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: draftRev,
      rationale: "accept draft", securityImplications: "no new trust boundary",
    }, gaspar);
    expect(res.ok).toBe(true);
    expect(res.value!.challenge).toBe(approvalChallenge(res.value!.ticketId));
    return res.value!;
  }

  function hostSign(ticketScopeRev: string, rationale: string, implications: string): { timestamp: string; signature: string } {
    return {
      timestamp: FIXED_TIME,
      signature: signApprovalPayload(buildApprovalPayload({
        action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: ticketScopeRev,
        authority: "PO", rationale, timestamp: FIXED_TIME, securityImplications: implications,
      }), signingKey),
    };
  }

  it("request binds scope and revision; describe reports a live ticket without secrets", () => {
    const { ticketId, challenge, expiresAt } = requestTicket();
    expect(ticketId).toMatch(/^TICKET-[0-9]{4}$/);
    expect(challenge).toBe(`approve-${ticketId}`);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.parse(FIXED_TIME));
    const described = core.describeApprovalTicket(ticketId, gaspar);
    expect(described.ok).toBe(true);
    expect(described.value).toMatchObject({ id: ticketId, action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: draftRev, consumed: false, live: true });
    expect(JSON.stringify(described.value)).not.toContain("PRIVATE");
  });

  it("request denies stale scope, unknown scope, unknown action, and empty rationale", () => {
    expect(core.requestApprovalTicket({
      action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: `sha256:${"b".repeat(64)}`,
      rationale: "r", securityImplications: "s",
    }, gaspar).error?.code).toBe("STALE_REVISION");
    expect(core.requestApprovalTicket({
      action: "planning-approval", scopeArtifactId: "REQ-9999", scopeRevision: draftRev,
      rationale: "r", securityImplications: "s",
    }, gaspar).error?.code).toBe("REFERENCE_UNRESOLVABLE");
    expect(core.requestApprovalTicket({
      action: "mind-meld", scopeArtifactId: "REQ-0001", scopeRevision: draftRev,
      rationale: "r", securityImplications: "s",
    }, gaspar).error?.code).toBe("VALIDATION_ERROR");
    expect(core.requestApprovalTicket({
      action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: draftRev,
      rationale: "  ", securityImplications: "s",
    }, gaspar).error?.code).toBe("VALIDATION_ERROR");
  });

  it("workers cannot request, describe, or finalize tickets", () => {
    const workerSession = core.openSession(
      { role: "belthazar", adapter: "test-adapter", runtime: "test-runtime", scopeModule: "default", ttlSeconds: 3600 },
      { interactive: true }
    );
    expect(workerSession.ok).toBe(true);
    const worker: CallerAuth = { actor: "belthazar", session: { id: workerSession.value!.id, token: workerSession.value!.token } };
    const input = {
      action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: draftRev,
      rationale: "r", securityImplications: "s",
    };
    expect(core.requestApprovalTicket(input, worker).error?.code).toBe("EXECUTION_DENIED");
    const { ticketId } = requestTicket();
    expect(core.describeApprovalTicket(ticketId, worker).error?.code).toBe("EXECUTION_DENIED");
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    expect(
      core.finalizeApprovalTicket(
        { ticketId, timestamp, signature, observation: OBSERVATION, ceremony: ceremonyFor(tempDir, ticketBinding(ticketId, draftRev)) },
        worker
      ).error?.code
    ).toBe("EXECUTION_DENIED");
  });

  it("finalize records a signed approval binding the security implications", () => {
    const { ticketId } = requestTicket();
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    const done = core.finalizeApprovalTicket(
      { ticketId, timestamp, signature, observation: OBSERVATION, ceremony: ceremonyFor(tempDir, ticketBinding(ticketId, draftRev)) },
      gaspar
    );
    expect(done.ok).toBe(true);
    expect(done.value!.approvalId).toMatch(/^APR-[0-9]{4}$/);
    expect(done.value!.duplicate).toBe(false);
    expect(done.value!.aliased).toBe(false);
    expect(core.hasValidApproval("REQ-0001", draftRev, "planning-approval")).toBe(true);
    const status = core.planningStatus(gaspar);
    expect(status.value!.items.find((i) => i.id === "REQ-0001")?.approval).toBe("approved");
  });

  it("model-forged confirmation fails signature verification", () => {
    const { ticketId } = requestTicket();
    const forged = signApprovalPayload(buildApprovalPayload({
      action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: draftRev,
      authority: "PO", rationale: "accept draft", timestamp: FIXED_TIME, securityImplications: "no new trust boundary",
    }), generateApprovalKeyPair().privateKeyPem);
    const done = core.finalizeApprovalTicket(
      { ticketId, timestamp: FIXED_TIME, signature: forged, observation: OBSERVATION, ceremony: ceremonyFor(tempDir, ticketBinding(ticketId, draftRev)) },
      gaspar
    );
    expect(done.ok).toBe(false);
    expect(done.error?.code).toBe("SIGNATURE_INVALID");
    expect(core.hasValidApproval("REQ-0001", draftRev, "planning-approval")).toBe(false);
  });

  it("same-ceremony redelivery is a durable no-op; a new ceremony on a consumed ticket denies", () => {
    const { ticketId } = requestTicket();
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    const ceremony = ceremonyFor(tempDir, ticketBinding(ticketId, draftRev));
    const first = core.finalizeApprovalTicket({ ticketId, timestamp, signature, observation: OBSERVATION, ceremony }, gaspar);
    expect(first.ok).toBe(true);
    expect(core.listApprovals()).toHaveLength(1);
    // Identical redelivery (restart replay, concurrent duplicate):
    // ok, same approval, zero state change.
    const redelivered = core.finalizeApprovalTicket({ ticketId, timestamp, signature, observation: OBSERVATION, ceremony }, gaspar);
    expect(redelivered.ok).toBe(true);
    expect(redelivered.value).toMatchObject({ approvalId: first.value!.approvalId, duplicate: true });
    expect(core.listApprovals()).toHaveLength(1);
    // Same ticket through a NEW ceremony is replay: denied.
    const fresh = ceremonyFor(tempDir, ticketBinding(ticketId, draftRev), "ses-test-1", "req-test-2");
    const replay = core.finalizeApprovalTicket({ ticketId, timestamp, signature, observation: OBSERVATION, ceremony: fresh }, gaspar);
    expect(replay.ok).toBe(false);
    expect(replay.error?.code).toBe("EXECUTION_DENIED");
    expect(core.listApprovals()).toHaveLength(1);
  });

  it("unknown ticket denies as replay", () => {
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    const done = core.finalizeApprovalTicket(
      {
        ticketId: "TICKET-9999", timestamp, signature, observation: OBSERVATION,
        ceremony: ceremonyFor(tempDir, ticketBinding("TICKET-9999", draftRev)),
      },
      gaspar
    );
    expect(done.ok).toBe(false);
    expect(done.error?.code).toBe("ENTITY_NOT_FOUND");
  });

  it("missing ceremony binding denies without consuming", () => {
    const { ticketId } = requestTicket();
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    const bare = core.finalizeApprovalTicket(
      {
        ticketId, timestamp, signature, observation: OBSERVATION,
        ceremony: { key: "0".repeat(64), sessionId: "", requestId: "" },
      },
      gaspar
    );
    expect(bare.ok).toBe(false);
    expect(bare.error?.code).toBe("VALIDATION_ERROR");
    expect(core.describeApprovalTicket(ticketId, gaspar).value!.consumed).toBe(false);
  });

  it("forged ceremony key denies without consuming (binding is verified, never trusted)", () => {
    const { ticketId } = requestTicket();
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    const forged = {
      key: "f".repeat(64),
      sessionId: "ses-test-1",
      requestId: "req-test-1",
    };
    const denied = core.finalizeApprovalTicket({ ticketId, timestamp, signature, observation: OBSERVATION, ceremony: forged }, gaspar);
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("VALIDATION_ERROR");
    expect(core.describeApprovalTicket(ticketId, gaspar).value!.consumed).toBe(false);
  });

  it("revision drift between request and finalize burns the ticket", () => {
    const { ticketId } = requestTicket();
    const revised = core.revisePlanningArtifact("REQ-0001", { title: "R2", body: "Changed." }, gaspar);
    expect(revised.ok).toBe(true);
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    const done = core.finalizeApprovalTicket(
      { ticketId, timestamp, signature, observation: OBSERVATION, ceremony: ceremonyFor(tempDir, ticketBinding(ticketId, draftRev)) },
      gaspar
    );
    expect(done.ok).toBe(false);
    expect(done.error?.code).toBe("STALE_REVISION");
    // Burned: even the new revision cannot reuse it.
    const { signature: sig2, timestamp: ts2 } = hostSign(revised.value!.revision, "accept draft", "no new trust boundary");
    expect(
      core.finalizeApprovalTicket(
        { ticketId, timestamp: ts2, signature: sig2, observation: OBSERVATION, ceremony: ceremonyFor(tempDir, ticketBinding(ticketId, draftRev), "ses-test-1", "req-test-9") },
        gaspar
      ).error?.code
    ).toBe("EXECUTION_DENIED");
  });

  it("missing native observation denies without consuming", () => {
    const { ticketId } = requestTicket();
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    const bare = core.finalizeApprovalTicket(
      {
        ticketId, timestamp, signature,
        observation: { permissionCallId: "  ", decidedAt: FIXED_TIME, autoModeProbed: true },
        ceremony: ceremonyFor(tempDir, ticketBinding(ticketId, draftRev)),
      },
      gaspar
    );
    expect(bare.ok).toBe(false);
    expect(bare.error?.code).toBe("VALIDATION_ERROR");
    // Ticket survives: the human can still confirm.
    expect(core.describeApprovalTicket(ticketId, gaspar).value!.consumed).toBe(false);
  });

  it("failed finalize preserves the ticket: same-ticket retry succeeds (D4)", () => {
    const { ticketId } = requestTicket();
    // Host-side failure BEFORE any signed request: forged signature
    // denies and the ticket survives for a genuine retry.
    const forged = signApprovalPayload(buildApprovalPayload({
      action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: draftRev,
      authority: "PO", rationale: "accept draft", timestamp: FIXED_TIME, securityImplications: "no new trust boundary",
    }), generateApprovalKeyPair().privateKeyPem);
    const failed = core.finalizeApprovalTicket(
      { ticketId, timestamp: FIXED_TIME, signature: forged, observation: OBSERVATION, ceremony: ceremonyFor(tempDir, ticketBinding(ticketId, draftRev)) },
      gaspar
    );
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe("SIGNATURE_INVALID");
    expect(core.describeApprovalTicket(ticketId, gaspar).value!.consumed).toBe(false);
    // Same ticket, genuine signature: records, no replay ambiguity.
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    const done = core.finalizeApprovalTicket(
      { ticketId, timestamp, signature, observation: OBSERVATION, ceremony: ceremonyFor(tempDir, ticketBinding(ticketId, draftRev), "ses-test-1", "req-test-retry") },
      gaspar
    );
    expect(done.ok).toBe(true);
    expect(core.hasValidApproval("REQ-0001", draftRev, "planning-approval")).toBe(true);
  });

  it("expired tickets burn on finalize and need a fresh request", () => {
    const { ticketId } = requestTicket();
    const expired = new ChronoCore({
      projectPath: tempDir,
      runtime: "test-runtime",
      clock: () => new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    });
    try {
      const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
      const done = expired.finalizeApprovalTicket(
        { ticketId, timestamp, signature, observation: OBSERVATION, ceremony: ceremonyFor(tempDir, ticketBinding(ticketId, draftRev)) },
        gaspar
      );
      expect(done.ok).toBe(false);
      expect(core.describeApprovalTicket(ticketId, gaspar).value!.consumed).toBe(true);
      expect(core.hasValidApproval("REQ-0001", draftRev, "planning-approval")).toBe(false);
    } finally {
      expired.close();
    }
  });

  it("vulnerable permission-bound approvals are non-authoritative by provenance (fail-open fix)", () => {
    // Classic interactive approvals carry no ticket marker: unaffected.
    expect(permissionBoundApprovalAuthoritative({ action: "module-approval" }, AUTHORITY_POLICY_VERSION)).toBe(true);
    // Current explicit-answer ceremony: authoritative.
    expect(permissionBoundApprovalAuthoritative(
      { ticketId: "TICKET-0001", ceremony: "question-answer-v1", policyVersion: AUTHORITY_POLICY_VERSION },
      AUTHORITY_POLICY_VERSION
    )).toBe(true);
    // The vulnerable ask()-gated ceremony (ticket marker, no explicit-
    // answer marker, older policy): rejected in every gate, including
    // the real pilot's provenance shape.
    expect(permissionBoundApprovalAuthoritative(
      { ticketId: "TICKET-0002", policyVersion: "7", nativeObservation: {} },
      AUTHORITY_POLICY_VERSION
    )).toBe(false);
    // Explicit-answer marker at a stale policy: rejected after upgrade.
    expect(permissionBoundApprovalAuthoritative(
      { ticketId: "TICKET-0003", ceremony: "question-answer-v1", policyVersion: "7" },
      AUTHORITY_POLICY_VERSION
    )).toBe(false);
    // Unknown future ceremony: fail closed.
    expect(permissionBoundApprovalAuthoritative(
      { ticketId: "TICKET-0004", ceremony: "something-else", policyVersion: AUTHORITY_POLICY_VERSION },
      AUTHORITY_POLICY_VERSION
    )).toBe(false);
    // Multi-grant authority (exactly-once repair): several grant
    // events for one approval id authorize only when every ceremony
    // named the SAME ticket. One observation fanning out over
    // several tickets (the TICKET-0024 class) is never authoritative;
    // genuinely separate ceremonies aliasing one row stay
    // authoritative.
    const fanOut = [
      { ticketId: "TICKET-0024", ceremony: "question-answer-v2", policyVersion: AUTHORITY_POLICY_VERSION, nativeObservation: { permissionCallId: "req-7" } },
      { ticketId: "TICKET-0025", ceremony: "question-answer-v2", policyVersion: AUTHORITY_POLICY_VERSION, nativeObservation: { permissionCallId: "req-7" } },
    ];
    expect(approvalGrantsAuthoritative(fanOut, AUTHORITY_POLICY_VERSION)).toBe(false);
    const legitAlias = [
      { ticketId: "TICKET-0030", ceremony: "question-answer-v2", policyVersion: AUTHORITY_POLICY_VERSION, nativeObservation: { permissionCallId: "req-a" } },
      { ticketId: "TICKET-0031", ceremony: "question-answer-v2", policyVersion: AUTHORITY_POLICY_VERSION, nativeObservation: { permissionCallId: "req-b" } },
    ];
    expect(approvalGrantsAuthoritative(legitAlias, AUTHORITY_POLICY_VERSION)).toBe(true);
    expect(approvalGrantsAuthoritative([], AUTHORITY_POLICY_VERSION)).toBe(false);
    // A live explicit-answer approval still authorizes through the Core.
    const { ticketId } = requestTicket();
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    expect(
      core.finalizeApprovalTicket(
        { ticketId, timestamp, signature, observation: OBSERVATION, ceremony: ceremonyFor(tempDir, ticketBinding(ticketId, draftRev)) },
        gaspar
      ).ok
    ).toBe(true);
    expect(core.hasValidApproval("REQ-0001", draftRev, "planning-approval")).toBe(true);
    expect(core.approvalCeremonyAuthoritative(core.listApprovals()[0]?.id ?? "")).toBe(true);
  });

  it("separate ceremonies aliasing one row keep one approval; approval ids stay unique and monotonic", () => {
    // Both tickets requested BEFORE either finalizes (request denies
    // once a current approval exists).
    const first = requestTicket();
    const second = requestTicket();
    expect(second.ticketId).not.toBe(first.ticketId);
    const sig1 = hostSign(draftRev, "accept draft", "no new trust boundary");
    const done1 = core.finalizeApprovalTicket(
      { ticketId: first.ticketId, timestamp: sig1.timestamp, signature: sig1.signature, observation: OBSERVATION, ceremony: ceremonyFor(tempDir, ticketBinding(first.ticketId, draftRev), "ses-a", "req-a") },
      gaspar
    );
    expect(done1.ok).toBe(true);
    expect(done1.value!.aliased).toBe(false);
    // A second ticket for the same scope/revision, approved through
    // its OWN ceremony and observation, aliases the row explicitly —
    // no second row, no reused-pointer ambiguity in the audit.
    const sig2 = hostSign(draftRev, "accept draft", "no new trust boundary");
    const otherObservation = { permissionCallId: "call-002", decidedAt: FIXED_TIME, autoModeProbed: true };
    const done2 = core.finalizeApprovalTicket(
      { ticketId: second.ticketId, timestamp: sig2.timestamp, signature: sig2.signature, observation: otherObservation, ceremony: ceremonyFor(tempDir, ticketBinding(second.ticketId, draftRev), "ses-a", "req-b") },
      gaspar
    );
    expect(done2.ok).toBe(true);
    expect(done2.value).toMatchObject({ approvalId: done1.value!.approvalId, duplicate: false, aliased: true });
    expect(core.listApprovals()).toHaveLength(1);
    expect(core.approvalCeremonyAuthoritative(done1.value!.approvalId)).toBe(true);
    expect(core.hasValidApproval("REQ-0001", draftRev, "planning-approval")).toBe(true);
    // A different scope mints a fresh monotonic id: ids are never
    // reused across approvals.
    const draft2 = core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0002", title: "R2", body: "Body 2." }, gaspar);
    expect(draft2.ok).toBe(true);
    const rev2 = draft2.value!.revision;
    const third = core.requestApprovalTicket({
      action: "planning-approval", scopeArtifactId: "REQ-0002", scopeRevision: rev2,
      rationale: "accept", securityImplications: "none",
    }, gaspar);
    expect(third.ok).toBe(true);
    const sig3 = signApprovalPayload(buildApprovalPayload({
      action: "planning-approval", scopeArtifactId: "REQ-0002", scopeRevision: rev2,
      authority: "PO", rationale: "accept", timestamp: FIXED_TIME, securityImplications: "none",
    }), signingKey);
    const done3 = core.finalizeApprovalTicket(
      {
        ticketId: third.value!.ticketId, timestamp: FIXED_TIME, signature: sig3, observation: OBSERVATION,
        ceremony: ceremonyFor(tempDir, { id: third.value!.ticketId, scopeArtifactId: "REQ-0002", action: "planning-approval", scopeRevision: rev2 }, "ses-a", "req-c"),
      },
      gaspar
    );
    expect(done3.ok).toBe(true);
    expect(done3.value!.approvalId).not.toBe(done1.value!.approvalId);
    expect(Number(done3.value!.approvalId.slice(4))).toBeGreaterThan(Number(done1.value!.approvalId.slice(4)));
  });

  it("one observation fanning out over two tickets denies the second (TICKET-0024 repair)", () => {
    const first = requestTicket();
    const second = requestTicket();
    const sig1 = hostSign(draftRev, "accept draft", "no new trust boundary");
    const done1 = core.finalizeApprovalTicket(
      { ticketId: first.ticketId, timestamp: sig1.timestamp, signature: sig1.signature, observation: OBSERVATION, ceremony: ceremonyFor(tempDir, ticketBinding(first.ticketId, draftRev), "ses-fan", "req-fan") },
      gaspar
    );
    expect(done1.ok).toBe(true);
    // Same native observation, second ticket, same scope/revision:
    // the old multi-ticket loop shape. Denied, ticket untouched.
    const sig2 = hostSign(draftRev, "accept draft", "no new trust boundary");
    const fanned = core.finalizeApprovalTicket(
      { ticketId: second.ticketId, timestamp: sig2.timestamp, signature: sig2.signature, observation: OBSERVATION, ceremony: ceremonyFor(tempDir, ticketBinding(second.ticketId, draftRev), "ses-fan", "req-fan") },
      gaspar
    );
    expect(fanned.ok).toBe(false);
    expect(fanned.error?.code).toBe("EXECUTION_DENIED");
    expect(core.describeApprovalTicket(second.ticketId, gaspar).value!.consumed).toBe(false);
    expect(core.listApprovals()).toHaveLength(1);
    expect(core.hasValidApproval("REQ-0001", draftRev, "planning-approval")).toBe(true);
  });

  it("losing a concurrent ceremony claim denies atomically with the ticket untouched", () => {
    // Simulates the true-concurrency loser: another process claimed
    // the ceremony key first (durable ledger row), so this
    // transaction's claim insert collides. The whole transaction —
    // consume, record, audit — rolls back: the ticket stays live and
    // no approval row appears.
    const { ticketId } = requestTicket();
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    const ceremony = ceremonyFor(tempDir, ticketBinding(ticketId, draftRev), "ses-race", "req-race");
    const raw = new Database(join(tempDir, ".chrono", "chrono.db"));
    try {
      raw
        .prepare("INSERT INTO ceremony_claim (ceremony_key, ticket_id, approval_id, claimed_at) VALUES (?, ?, NULL, ?)")
        .run(ceremony.key, ticketId, new Date().toISOString());
    } finally {
      raw.close();
    }
    const lost = core.finalizeApprovalTicket({ ticketId, timestamp, signature, observation: OBSERVATION, ceremony }, gaspar);
    expect(lost.ok).toBe(false);
    expect(lost.error?.code).toBe("EXECUTION_DENIED");
    expect(core.describeApprovalTicket(ticketId, gaspar).value!.consumed).toBe(false);
    expect(core.listApprovals()).toHaveLength(0);
    expect(core.hasValidApproval("REQ-0001", draftRev, "planning-approval")).toBe(false);
  });

  it("no new ticket needed once approved; chat alone still approves nothing", () => {
    const { ticketId } = requestTicket();
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    expect(
      core.finalizeApprovalTicket(
        { ticketId, timestamp, signature, observation: OBSERVATION, ceremony: ceremonyFor(tempDir, ticketBinding(ticketId, draftRev)) },
        gaspar
      ).ok
    ).toBe(true);
    expect(core.requestApprovalTicket({
      action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: draftRev,
      rationale: "again", securityImplications: "s",
    }, gaspar).error?.code).toBe("DUPLICATE_IDENTITY");
  });
});
