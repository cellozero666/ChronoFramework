/**
 * User-approved Gaspar document writes (co-architect memos, fix plans).
 *
 * Gaspar petitions the Core with exact proposed bytes; one human
 * approval through the permission-bound ceremony authorizes exactly
 * one Core-side write (backup + atomic replace). Chat text alone
 * authorizes nothing, and approval can never drift onto different
 * bytes: the ticket binds path plus content hash, the body is stored
 * Core-side at request time, and any base movement burns the ticket.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import {
  buildApprovalPayload,
  buildCeremonyKey,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  computeRevisionHash,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore, type CallerAuth } from "./chrono-core.js";

const FIXED_TIME = "2026-09-14T00:00:00.000Z";
const OBSERVATION = { permissionCallId: "call-doc-001", decidedAt: FIXED_TIME, autoModeProbed: true };
const RATIONALE = "record the decided fix plan";
const IMPLICATIONS = "docs only; no code, secrets, or runtime effects";

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

describe("User-approved document writes", () => {
  let tempDir: string;
  let core: ChronoCore;
  let signingKey = "";
  let gaspar: { actor: string; session: { id: string; token: string } };
  let restoreTty: () => void;

  const BODY = "# Fix plan\n\n- Bug A: retry with backoff.\n- Bug B: validate input.\n";

  function requestDoc(path = "docs/FIXES.md", body: string = BODY): {
    ticketId: string | null; challenge: string | null; expiresAt: string | null;
    alreadyCurrent: boolean; scopeId: string; contentHash: string; baseRevision: string | null;
  } {
    mkdirSync(join(tempDir, "docs"), { recursive: true });
    const res = core.requestDocumentWriteTicket(
      { path, body, rationale: RATIONALE, securityImplications: IMPLICATIONS },
      gaspar
    );
    expect(res.ok).toBe(true);
    return res.value!;
  }

  function hostSign(scopeId: string, contentHash: string): { timestamp: string; signature: string } {
    return {
      timestamp: FIXED_TIME,
      signature: signApprovalPayload(buildApprovalPayload({
        action: "document-write", scopeArtifactId: scopeId, scopeRevision: contentHash,
        authority: "PO", rationale: RATIONALE, timestamp: FIXED_TIME, securityImplications: IMPLICATIONS,
      }), signingKey),
    };
  }

  function ceremonyFor(ticketId: string, scopeId: string, contentHash: string, sessionId = "ses-doc-1", requestId = "req-doc-1"): { key: string; sessionId: string; requestId: string } {
    return {
      key: buildCeremonyKey({
        project: realpathSync(tempDir),
        sessionId,
        requestId,
        ticketId,
        scopeArtifactId: scopeId,
        action: "document-write",
        scopeRevision: contentHash,
      }),
      sessionId,
      requestId,
    };
  }

  function finalize(ticketId: string, scopeId: string, contentHash: string, ceremony = ceremonyFor(ticketId, scopeId, contentHash)): { ok: boolean; value?: { approvalId: string; duplicate: boolean; aliased?: boolean }; error?: { code?: string; message?: string } } {
    const { timestamp, signature } = hostSign(scopeId, contentHash);
    const res = core.finalizeApprovalTicket(
      { ticketId, timestamp, signature, observation: OBSERVATION, ceremony },
      gaspar
    );
    return res as unknown as { ok: boolean; value?: { approvalId: string; duplicate: boolean }; error?: { code?: string; message?: string } };
  }

  function docAbs(rel: string): string {
    return join(realpathSync(tempDir), rel);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-docwrite-test-"));
    core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    expect(core.init().ok).toBe(true);
    const pair = generateApprovalKeyPair();
    restoreTty = fakeTty();
    enrollTestPo(core, pair);
    signingKey = pair.privateKeyPem;
    gaspar = { actor: "gaspar", session: bootstrapSession(core, "gaspar", signingKey) };
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("request validates paths, bounds, secrets, and existing foundations", () => {
    mkdirSync(join(tempDir, "docs"), { recursive: true });
    const bad = (path: string, body: string = BODY) =>
      core.requestDocumentWriteTicket({ path, body, rationale: RATIONALE, securityImplications: IMPLICATIONS }, gaspar);
    expect(bad("docs/plan.txt").error?.code).toBe("VALIDATION_ERROR");
    expect(bad("../escape.md").error?.code).toBe("VALIDATION_ERROR");
    expect(bad("/etc/evil.md").error?.code).toBe("VALIDATION_ERROR");
    expect(bad(".chrono/context/evil.md").error?.code).toBe("VALIDATION_ERROR");
    expect(bad(".git/hooks/evil.md").error?.code).toBe("VALIDATION_ERROR");
    expect(bad("node_modules/evil.md").error?.code).toBe("VALIDATION_ERROR");
    expect(bad("no-such-dir/plan.md").error?.code).toBe("VALIDATION_ERROR");
    expect(bad("docs/empty.md", "").error?.code).toBe("VALIDATION_ERROR");
    expect(bad("docs/huge.md", `# t\n${"x".repeat(70000)}`).error?.code).toBe("VALIDATION_ERROR");
    expect(bad("docs/valid.md").ok).toBe(true);
    const leaked = core.requestDocumentWriteTicket(
      { path: "docs/leak.md", body: "# t\napi_key = 'sk-live-1234567890'\n", rationale: RATIONALE, securityImplications: IMPLICATIONS },
      gaspar
    );
    expect(leaked.error?.code).toBe("SECRET_DETECTED");
    expect(core.requestDocumentWriteTicket(
      { path: "docs/FIXES.md", body: BODY, rationale: "  ", securityImplications: IMPLICATIONS }, gaspar
    ).error?.code).toBe("VALIDATION_ERROR");
  });

  it("request binds path plus content hash; already-current content needs no ticket", () => {
    const first = requestDoc();
    expect(first.ticketId).toMatch(/^TICKET-[0-9]{4}$/);
    expect(first.scopeId).toBe("doc:docs/FIXES.md");
    expect(first.contentHash).toBe(computeRevisionHash(BODY));
    expect(first.baseRevision).toBe(null);
    expect(first.alreadyCurrent).toBe(false);
    const described = core.describeApprovalTicket(first.ticketId as string, gaspar);
    expect(described.ok).toBe(true);
    expect(described.value).toMatchObject({ action: "document-write", scopeArtifactId: "doc:docs/FIXES.md", consumed: false, live: true });
    // Identical bytes already on disk: deterministic no-op, no ticket.
    writeFileSync(docAbs("docs/FIXES.md"), BODY, "utf8");
    const again = requestDoc();
    expect(again.alreadyCurrent).toBe(true);
    expect(again.ticketId).toBe(null);
  });

  it("approval-request rejects the document-write action (dedicated petition path)", () => {
    const res = core.requestApprovalTicket({
      action: "document-write", scopeArtifactId: "doc:docs/FIXES.md", scopeRevision: computeRevisionHash(BODY),
      rationale: RATIONALE, securityImplications: IMPLICATIONS,
    }, gaspar);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("VALIDATION_ERROR");
  });

  it("Approve writes exact bytes on create (no backup) with audit", () => {
    const req = requestDoc();
    const done = finalize(req.ticketId as string, req.scopeId, req.contentHash);
    expect(done.ok).toBe(true);
    expect(readFileSync(docAbs("docs/FIXES.md"), "utf8")).toBe(BODY);
    // No backup for creates.
    expect(() => readFileSync(docAbs("docs/FIXES.md.chrono-bak"), "utf8")).toThrow();
    const written = core.listEvents().filter((e) => e.eventType === "DocumentWritten" && e.entityId === req.scopeId);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.payload)).toMatchObject({ contentHash: req.contentHash, baseRevision: null });
    expect(core.hasValidApproval(req.scopeId, req.contentHash, "document-write")).toBe(true);
  });

  it("Approve replaces with backup preserving the original", () => {
    mkdirSync(join(tempDir, "docs"), { recursive: true });
    const original = "# Old plan\n";
    writeFileSync(docAbs("docs/FIXES.md"), original, "utf8");
    const req = requestDoc();
    expect(req.baseRevision).toBe(computeRevisionHash(original));
    const done = finalize(req.ticketId as string, req.scopeId, req.contentHash);
    expect(done.ok).toBe(true);
    expect(readFileSync(docAbs("docs/FIXES.md"), "utf8")).toBe(BODY);
    expect(readFileSync(docAbs("docs/FIXES.md.chrono-bak"), "utf8")).toBe(original);
  });

  it("denial path writes nothing: no finalize, no file", () => {
    const req = requestDoc();
    expect(req.ticketId).not.toBe(null);
    // No finalize call at all: the ticket sits live, the file absent.
    expect(() => readFileSync(docAbs("docs/FIXES.md"), "utf8")).toThrow();
    const described = core.describeApprovalTicket(req.ticketId as string, gaspar);
    expect(described.value?.consumed).toBe(false);
  });

  it("replay of the same ceremony is a durable no-op with one write", () => {
    const req = requestDoc();
    const ticketId = req.ticketId as string;
    const ceremony = ceremonyFor(ticketId, req.scopeId, req.contentHash);
    const first = finalize(ticketId, req.scopeId, req.contentHash, ceremony);
    expect(first.ok).toBe(true);
    const second = finalize(ticketId, req.scopeId, req.contentHash, ceremony);
    expect(second.ok).toBe(true);
    expect(second.value?.duplicate).toBe(true);
    expect(second.value?.approvalId).toBe(first.value?.approvalId);
    expect(core.listEvents().filter((e) => e.eventType === "DocumentWritten" && e.entityId === req.scopeId)).toHaveLength(1);
    expect(readFileSync(docAbs("docs/FIXES.md"), "utf8")).toBe(BODY);
  });

  it("base movement between request and finalize burns the ticket", () => {
    mkdirSync(join(tempDir, "docs"), { recursive: true });
    writeFileSync(docAbs("docs/FIXES.md"), "# Stale base\n", "utf8");
    const req = requestDoc();
    // Someone else rewrites the document after the human was asked.
    writeFileSync(docAbs("docs/FIXES.md"), "# Intruder\n", "utf8");
    const done = finalize(req.ticketId as string, req.scopeId, req.contentHash);
    expect(done.ok).toBe(false);
    expect(done.error?.code).toBe("STALE_REVISION");
    expect(readFileSync(docAbs("docs/FIXES.md"), "utf8")).toBe("# Intruder\n");
    // Burned: the ticket is consumed and cannot be retried.
    expect(core.describeApprovalTicket(req.ticketId as string, gaspar).value?.consumed).toBe(true);
  });

  it("create-race burns the ticket and leaves the intruding file", () => {
    const req = requestDoc();
    writeFileSync(docAbs("docs/FIXES.md"), "# Squatter\n", "utf8");
    const done = finalize(req.ticketId as string, req.scopeId, req.contentHash);
    expect(done.ok).toBe(false);
    expect(done.error?.code).toBe("STALE_REVISION");
    expect(readFileSync(docAbs("docs/FIXES.md"), "utf8")).toBe("# Squatter\n");
  });

  it("expired tickets deny and consume; forged signatures and ceremonies leave the ticket live", () => {
    const req = requestDoc();
    const ticketId = req.ticketId as string;
    // Forged signature: ticket untouched.
    const forged = core.finalizeApprovalTicket(
      {
        ticketId,
        timestamp: FIXED_TIME,
        signature: Buffer.from("forged").toString("base64"),
        observation: OBSERVATION,
        ceremony: ceremonyFor(ticketId, req.scopeId, req.contentHash),
      },
      gaspar
    );
    expect(forged.ok).toBe(false);
    // Forged ceremony key: ticket untouched.
    const badCeremony = core.finalizeApprovalTicket(
      {
        ticketId,
        timestamp: FIXED_TIME,
        signature: hostSignFor(req.scopeId, req.contentHash),
        observation: OBSERVATION,
        ceremony: { key: "0".repeat(64), sessionId: "ses-doc-1", requestId: "req-doc-1" },
      },
      gaspar
    );
    expect(badCeremony.ok).toBe(false);
    expect(core.describeApprovalTicket(ticketId, gaspar).value?.consumed).toBe(false);
    expect(() => readFileSync(docAbs("docs/FIXES.md"), "utf8")).toThrow();
    // Expired ticket: denied and burned, nothing written.
    const raw = new Database(join(tempDir, ".chrono", "chrono.db"));
    try {
      raw.prepare("UPDATE approval_ticket SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(ticketId);
    } finally {
      raw.close();
    }
    const stale = finalize(ticketId, req.scopeId, req.contentHash);
    expect(stale.ok).toBe(false);
    expect(core.describeApprovalTicket(ticketId, gaspar).value?.consumed).toBe(true);
    expect(() => readFileSync(docAbs("docs/FIXES.md"), "utf8")).toThrow();
  });

  function hostSignFor(scopeId: string, contentHash: string): string {
    return signApprovalPayload(buildApprovalPayload({
      action: "document-write", scopeArtifactId: scopeId, scopeRevision: contentHash,
      authority: "PO", rationale: RATIONALE, timestamp: FIXED_TIME, securityImplications: IMPLICATIONS,
    }), signingKey);
  }

  it("workers cannot petition for document writes", () => {
    mkdirSync(join(tempDir, "docs"), { recursive: true });
    const workerSession = core.openSession(
      { role: "belthazar", adapter: "test-adapter", runtime: "test-runtime", scopeModule: "default", ttlSeconds: 3600 },
      { interactive: true }
    );
    expect(workerSession.ok).toBe(true);
    const worker: CallerAuth = { actor: "belthazar", session: { id: workerSession.value!.id, token: workerSession.value!.token } };
    const res = core.requestDocumentWriteTicket(
      { path: "docs/FIXES.md", body: BODY, rationale: RATIONALE, securityImplications: IMPLICATIONS },
      worker
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("EXECUTION_DENIED");
  });

  it("re-approving identical content after a write aliases without rewriting", () => {
    const first = requestDoc();
    const done = finalize(first.ticketId as string, first.scopeId, first.contentHash);
    expect(done.ok).toBe(true);
    expect(done.value?.aliased).toBe(false);
    // Content already on disk: the dedicated path reports already-current.
    const again = requestDoc();
    expect(again.alreadyCurrent).toBe(true);
    expect(core.listEvents().filter((e) => e.eventType === "DocumentWritten" && e.entityId === first.scopeId)).toHaveLength(1);
  });
});
