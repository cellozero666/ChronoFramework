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
import Database from "better-sqlite3";
import {
  buildApprovalPayload,
  computeRevisionHash,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore } from "./chrono-core.js";

function rawDb(tempDir: string): Database.Database {
  const db = new Database(join(tempDir, ".chrono", "chrono.db"));
  return db;
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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-audit-test-"));
    core = new ChronoCore({ projectPath: tempDir });
    expect(core.init().ok).toBe(true);
    restoreTty = fakeInteractiveTerminal();
    expect(core.registerSpec("SP-0001", "DRAFT", { id: "SP-0001", title: "T", purpose: "P" }, "gaspar").ok).toBe(true);
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
    core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "gaspar" });
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
      }).ok,
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
    const pair = generateApprovalKeyPair();
    expect(core.registerPoPublicKey(pair.publicKeyPem).ok).toBe(true);
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
      pair.privateKeyPem
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
