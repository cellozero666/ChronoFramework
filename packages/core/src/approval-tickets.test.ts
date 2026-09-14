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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  approvalChallenge,
  buildApprovalPayload,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  fingerprintPublicKey,
  generateApprovalKeyPair,
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
    expect(core.finalizeApprovalTicket({ ticketId, timestamp, signature, observation: OBSERVATION }, worker).error?.code).toBe("EXECUTION_DENIED");
  });

  it("finalize records a signed approval binding the security implications", () => {
    const { ticketId } = requestTicket();
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    const done = core.finalizeApprovalTicket({ ticketId, timestamp, signature, observation: OBSERVATION }, gaspar);
    expect(done.ok).toBe(true);
    expect(done.value!.approvalId).toMatch(/^APR-[0-9]{4}$/);
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
    const done = core.finalizeApprovalTicket({ ticketId, timestamp: FIXED_TIME, signature: forged, observation: OBSERVATION }, gaspar);
    expect(done.ok).toBe(false);
    expect(done.error?.code).toBe("SIGNATURE_INVALID");
    expect(core.hasValidApproval("REQ-0001", draftRev, "planning-approval")).toBe(false);
  });

  it("replay of a consumed ticket denies", () => {
    const { ticketId } = requestTicket();
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    expect(core.finalizeApprovalTicket({ ticketId, timestamp, signature, observation: OBSERVATION }, gaspar).ok).toBe(true);
    const replay = core.finalizeApprovalTicket({ ticketId, timestamp, signature, observation: OBSERVATION }, gaspar);
    expect(replay.ok).toBe(false);
    expect(replay.error?.code).toBe("EXECUTION_DENIED");
  });

  it("unknown ticket denies as replay", () => {
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    const done = core.finalizeApprovalTicket({ ticketId: "TICKET-9999", timestamp, signature, observation: OBSERVATION }, gaspar);
    expect(done.ok).toBe(false);
    expect(done.error?.code).toBe("ENTITY_NOT_FOUND");
  });

  it("revision drift between request and finalize burns the ticket", () => {
    const { ticketId } = requestTicket();
    const revised = core.revisePlanningArtifact("REQ-0001", { title: "R2", body: "Changed." }, gaspar);
    expect(revised.ok).toBe(true);
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    const done = core.finalizeApprovalTicket({ ticketId, timestamp, signature, observation: OBSERVATION }, gaspar);
    expect(done.ok).toBe(false);
    expect(done.error?.code).toBe("STALE_REVISION");
    // Burned: even the new revision cannot reuse it.
    const { signature: sig2, timestamp: ts2 } = hostSign(revised.value!.revision, "accept draft", "no new trust boundary");
    expect(core.finalizeApprovalTicket({ ticketId, timestamp: ts2, signature: sig2, observation: OBSERVATION }, gaspar).error?.code).toBe("EXECUTION_DENIED");
  });

  it("missing native observation denies without consuming", () => {
    const { ticketId } = requestTicket();
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    const bare = core.finalizeApprovalTicket({ ticketId, timestamp, signature, observation: { permissionCallId: "  ", decidedAt: FIXED_TIME, autoModeProbed: true } }, gaspar);
    expect(bare.ok).toBe(false);
    expect(bare.error?.code).toBe("VALIDATION_ERROR");
    // Ticket survives: the human can still confirm.
    expect(core.describeApprovalTicket(ticketId, gaspar).value!.consumed).toBe(false);
  });

  it("no new ticket needed once approved; chat alone still approves nothing", () => {
    const { ticketId } = requestTicket();
    const { signature, timestamp } = hostSign(draftRev, "accept draft", "no new trust boundary");
    expect(core.finalizeApprovalTicket({ ticketId, timestamp, signature, observation: OBSERVATION }, gaspar).ok).toBe(true);
    expect(core.requestApprovalTicket({
      action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: draftRev,
      rationale: "again", securityImplications: "s",
    }, gaspar).error?.code).toBe("DUPLICATE_IDENTITY");
  });
});
