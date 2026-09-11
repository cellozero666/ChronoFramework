/**
 * I4 tests — audit/revision tamper attempts fail, including through a raw
 * SQL connection that bypasses the Core entirely.
 * [DOM §5.2, P3.5, FW §13, Remediation §4]
 *
 * The raw connection below is test-only evidence tooling: it proves the
 * triggers hold. Production code has no writable-handle API to abuse.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import {
  buildApprovalPayload,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  computeRevisionHash,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore } from "./chrono-core.js";

function rawDb(tempDir: string): Database.Database {
  const db = new Database(join(tempDir, ".chrono", "chrono.db"));
  return db;
}

/**
 * TEST-ONLY enrollment helper: builds a valid ceremony proof with a
 * caller-supplied timestamp (wall clock by default; pass the fixed clock
 * time for clock-injected cores). Production callers MUST use
 * `chrono enroll`, which adds /dev/tty confirmation and keychain custody.
 */
function enrollTestPo(
  core: ChronoCore,
  pair: { publicKeyPem: string; privateKeyPem: string },
  timestamp = new Date().toISOString(),
  rationale = "test enrollment"
): void {
  const nonce = randomBytes(16).toString("hex");
  const fingerprint = fingerprintPublicKey(pair.publicKeyPem);
  const confirmation = buildEnrollmentChallenge("default", fingerprint, nonce);
  const signature = signApprovalPayload(
    buildEnrollmentPayload({
      projectId: "default",
      fingerprint,
      timestamp,
      nonce,
      authority: "PO",
      rationale,
      confirmation,
    }),
    pair.privateKeyPem
  );
  const res = core.enrollPo({
    publicKeyPem: pair.publicKeyPem,
    nonce,
    timestamp,
    rationale,
    confirmation,
    signature,
  });
  expect(res.ok).toBe(true);
  expect(res.value?.fingerprint).toBe(fingerprint);
}

describe("Audit immutability (raw-SQL tamper attempts)", () => {
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
  let poPrivateKey: string;
  let gaspar: { actor: string; session: { id: string; token: string } };

  function openTestSession(role: string, scopeModule?: string): { id: string; token: string } {
    if (role === "gaspar" || role === "PO") {
      throw new Error("Privileged test sessions require a PO-signed bootstrap");
    }
    const res = core.openSession(
      {
        role,
        adapter: "test-adapter",
        runtime: "test-runtime",
        ...(scopeModule !== undefined ? { scopeModule } : {}),
        ttlSeconds: 3600,
      },
      { interactive: true }
    );
    expect(res.ok).toBe(true);
    return { id: res.value!.id, token: res.value!.token };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-audit-test-"));
    core = new ChronoCore({ projectPath: tempDir });
    expect(core.init().ok).toBe(true);
    restoreTty = fakeInteractiveTerminal();
    const pair = generateApprovalKeyPair();
    enrollTestPo(core, pair);
    poPrivateKey = pair.privateKeyPem;
    const nonce = randomBytes(16).toString("hex");
    const timestamp = "2026-09-11T00:00:00.000Z";
    const rationale = "test privileged-session bootstrap";
    const signature = signApprovalPayload(
      buildSessionAuthorizationPayload({
        sessionRole: "gaspar",
        adapter: "test-adapter",
        runtime: "test-runtime",
        scopeModule: null,
        scopeWp: null,
        ttlSeconds: 3600,
        nonce,
        authority: "PO",
        rationale,
        timestamp,
      }),
      pair.privateKeyPem
    );
    const opened = core.openSession(
      { role: "gaspar", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
      { poAuthorization: { nonce, authority: "PO", rationale, timestamp, signature } }
    );
    expect(opened.ok).toBe(true);
    gaspar = { actor: "gaspar", session: { id: opened.value!.id, token: opened.value!.token } };
    expect(core.registerSpec("SP-0001", "DRAFT", { id: "SP-0001", title: "T", purpose: "P" }, gaspar).ok).toBe(true);
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects UPDATE and DELETE on event_log", () => {
    const raw = rawDb(tempDir);
    try {
      expect(() => raw.exec("UPDATE event_log SET actor = 'mallory'")).toThrow(/append-only/);
      expect(() => raw.exec("DELETE FROM event_log")).toThrow(/append-only/);
    } finally {
      raw.close();
    }
    // The Core still appends and reads normally afterwards.
    expect(core.listEvents().length).toBeGreaterThan(0);
  });

  it("rejects UPDATE and DELETE on artifact_revision history", () => {
    core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "gaspar", session: gaspar.session });
    const historyBefore = core.artifactHistory("SP-0001");
    expect(historyBefore).toHaveLength(2);

    const raw = rawDb(tempDir);
    try {
      expect(() => raw.exec("UPDATE artifact_revision SET status = 'READY'")).toThrow(/append-only/);
      expect(() => raw.exec("DELETE FROM artifact_revision")).toThrow(/append-only/);
    } finally {
      raw.close();
    }

    expect(core.artifactHistory("SP-0001")).toHaveLength(2);
  });

  it("rejects UPDATE and DELETE on evidence", () => {
    const targetRevision = `sha256:${"b".repeat(64)}`;
    // The tamper test targets the triggers; producer binding is covered
    // elsewhere, so the producing role records through its own session.
    const lucca = { actor: "lucca", session: openTestSession("lucca", "default") };
    expect(
      core.recordEvidence({
        producer: "lucca",
        tool: "vitest",
        targetRevision,
        checkName: "unit",
        result: "pass",
        diagnostics: null,
        integrityHash: computeRevisionHash({
          result: "pass",
          diagnostics: null,
          target_revision: targetRevision,
        }),
      }, lucca).ok,
    ).toBe(true);

    const raw = rawDb(tempDir);
    try {
      expect(() => raw.exec("UPDATE evidence SET result = 'pass'")).toThrow(/immutable/);
      expect(() => raw.exec("DELETE FROM evidence")).toThrow(/immutable/);
    } finally {
      raw.close();
    }
  });

  it("rejects approval rewrites but allows the revocation flag 0 → 1", () => {
    const revision = core.getArtifact("SP-0001").revision;
    const timestamp = "2026-06-01T00:00:00.000Z";
    const signature = signApprovalPayload(
      buildApprovalPayload({
        action: "module-approval",
        scopeArtifactId: "SP-0001",
        scopeRevision: revision,
        authority: "PO",
        rationale: "test",
        timestamp,
      }),
      poPrivateKey
    );
    const created = core.recordApproval({
      action: "module-approval",
      scopeArtifactId: "SP-0001",
      scopeRevision: revision,
      authority: "PO",
      rationale: "test",
      timestamp,
      signature,
    });
    expect(created.ok).toBe(true);

    const raw = rawDb(tempDir);
    try {
      expect(() => raw.exec("UPDATE approval SET rationale = 'forged'")).toThrow(/immutable/);
      expect(() => raw.exec("DELETE FROM approval")).toThrow(/cannot be deleted/);
      expect(() =>
        raw.exec(`UPDATE approval SET revoked = 1 WHERE id = '${created.value!.id}'`),
      ).not.toThrow();
    } finally {
      raw.close();
    }
  });

  it("rejects waiver rewrites but allows active → expired", () => {
    const raw = rawDb(tempDir);
    try {
      raw.exec(
        `INSERT INTO waiver (id, issue, scope_artifact_id, scope_revision, rationale,
          accepting_authority, expiry_review_condition, timestamp, status, signature)
         VALUES ('WAIVER-0001', 'risk', 'SP-0001', 'sha256:abc', 'accepted',
          'PO', 'review in 30d', '2026-01-01T00:00:00.000Z', 'active', 'sig')`,
      );
      expect(() => raw.exec("UPDATE waiver SET rationale = 'forged'")).toThrow(/immutable/);
      expect(() => raw.exec("DELETE FROM waiver")).toThrow(/cannot be deleted/);
      expect(() =>
        raw.exec("UPDATE waiver SET status = 'expired' WHERE id = 'WAIVER-0001'"),
      ).not.toThrow();
      // Illegal lifecycle jump is rejected even though status changes are allowed.
      expect(() =>
        raw.exec("UPDATE waiver SET status = 'active' WHERE id = 'WAIVER-0001'"),
      ).toThrow(/immutable/);
    } finally {
      raw.close();
    }
  });
});
