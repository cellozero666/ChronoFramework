/**
 * Migration tests — schema upgrades preserve data across versions.
 * [CORE §5.1, Remediation §10]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ChronoDatabase } from "./database.js";
import { SCHEMA_VERSION } from "./schema.js";

describe("Schema migrations", () => {
  let tempDir: string;
  let db: ChronoDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-mig-test-"));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Already closed or never opened.
    }
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("upgrades v1 to current preserving data", () => {
    db = new ChronoDatabase({ path: join(tempDir, "chrono.db") });
    const first = db.migrate(1);
    expect(first.map((m) => m.version)).toEqual([1]);
    expect(db.schemaVersion()).toBe(1);

    db.projects().create("default", "en", "SEMI_AUTONOMOUS", null);

    const rest = db.migrate();
    expect(rest.map((m) => m.version)).toEqual(
      Array.from({ length: SCHEMA_VERSION - 1 }, (_, i) => i + 2)
    );
    expect(db.schemaVersion()).toBe(SCHEMA_VERSION);

    // v1 data survives the upgrade.
    expect(db.projects().findById("default").language).toBe("en");
    // v2+ tables are usable.
    expect(db.sequences().allocate("BLK")).toBe("BLK-0001");
    // Slice 6 registry table exists after the upgrade path.
    expect(db.adapters().listAll()).toEqual([]);
  });

  it("is idempotent on a current database", () => {
    db = new ChronoDatabase({ path: join(tempDir, "chrono.db") });
    expect(db.migrate()).toHaveLength(SCHEMA_VERSION);
    expect(db.migrate()).toHaveLength(0);
    expect(db.schemaVersion()).toBe(SCHEMA_VERSION);
  });

  it("creates the approval_ticket table at v15 on every upgrade path", () => {
    for (const baseline of [1, 14]) {
      const dir = mkdtempSync(join(tmpdir(), "chrono-ticket-mig-test-"));
      try {
        const first = new ChronoDatabase({ path: join(dir, "chrono.db") });
        try {
          first.migrate(baseline);
        } finally {
          first.close();
        }
        const second = new ChronoDatabase({ path: join(dir, "chrono.db") });
        try {
          second.migrate();
          expect(second.schemaVersion()).toBe(SCHEMA_VERSION);
          const created = second.approvalTickets().create({
            id: "TICKET-0001",
            action: "planning-approval",
            scopeArtifactId: "REQ-0001",
            scopeRevision: `sha256:${"a".repeat(64)}`,
            authority: "PO",
            rationale: "test",
            securityImplications: "none",
            requesterSession: "SES-0001",
            createdAt: "2026-09-14T00:00:00.000Z",
            expiresAt: "2026-09-14T00:15:00.000Z",
          });
          expect(created.consumed).toBe(false);
          expect(second.approvalTickets().consume("TICKET-0001").consumed).toBe(true);
        } finally {
          second.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("rewrites the legacy luca identity to lucca with an audit trail", () => {
    db = new ChronoDatabase({ path: join(tempDir, "chrono.db") });
    db.migrate(4);
    db.evidence().create({
      id: "EVD-0001",
      producer: "luca",
      tool: "vitest",
      timestamp: "2026-01-01T00:00:00.000Z",
      targetRevision: `sha256:${"a".repeat(64)}`,
      checkName: "unit",
      result: "pass",
      diagnostics: null,
      integrityHash: `sha256:${"b".repeat(64)}`,
    });
    db.defects().create({
      id: "DEF-0001",
      classification: "TEST_DEFECT",
      severity: "minor",
      evidenceRefs: [],
      affectedCriteria: [],
      affectedArtifacts: [],
      owner: "luca",
      blockingScope: null,
      reproInfo: null,
    });

    db.migrate();
    expect(db.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(db.evidence().findById("EVD-0001").producer).toBe("lucca");
    expect(db.defects().findById("DEF-0001").owner).toBe("lucca");
  });
});

describe("Routing-proof promotion guard (OC-P2)", () => {
  // Persistence backstop: exactly one legal mutation
  // (candidate → authoritative with non-null hashes), no deletes.
  // Core validation stays primary; these triggers deny direct-SQL
  // bypass so an illegally-authoritative proof can never exist.
  let tempDir: string;
  let db: ChronoDatabase;

  const PROOF_COLUMNS =
    "(id, adapter_id, runtime, session_id, project_id, rtk_attestation_id, binary_path, binary_hash, version, proof_command, pre_routing_command, command_hash, output_hash, exit_status, gain_available, timestamp, valid_until, authority, adapter_hash, asset_hash)";

  function seedCandidate(id: string): void {
    const raw = new Database(join(tempDir, "chrono.db"));
    try {
      raw
        .prepare(
          `INSERT INTO routing_proof ${PROOF_COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id, "test-adapter", "test-runtime", "SES-0001", "default", "RTK-0001", "/bin/rtk", "ab".repeat(32),
          "1.0.0-test", JSON.stringify(["/bin/rtk", "gain"]), "", `sha256:${"a".repeat(64)}`,
          `sha256:${"b".repeat(64)}`, 0, 1, "2026-09-11T00:00:00.000Z", "2026-09-12T00:00:00.000Z",
          "candidate", null, null
        );
    } finally {
      raw.close();
    }
  }

  function rawExec(sql: string, ...params: unknown[]): void {
    const raw = new Database(join(tempDir, "chrono.db"));
    try {
      raw.prepare(sql).run(...params);
    } finally {
      raw.close();
    }
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-proof-guard-test-"));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Already closed or never opened.
    }
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates the promotion triggers at v14 on every upgrade path", () => {
    for (const baseline of [11, 12, 13]) {
      const dir = mkdtempSync(join(tmpdir(), "chrono-guard-mig-test-"));
      try {
        const first = new ChronoDatabase({ path: join(dir, "chrono.db") });
        try {
          first.migrate(baseline);
        } finally {
          first.close();
        }
        const second = new ChronoDatabase({ path: join(dir, "chrono.db") });
        try {
          const applied = second.migrate().map((m) => m.version);
          expect(applied[applied.length - 1]).toBe(SCHEMA_VERSION);
          expect(second.schemaVersion()).toBe(SCHEMA_VERSION);
          const raw = new Database(join(dir, "chrono.db"));
          try {
            const triggers = raw
              .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'routing_proof'")
              .all() as { name: string }[];
            expect(triggers.map((t) => t.name).sort()).toEqual([
              "routing_proof_no_delete",
              "routing_proof_permit_promotion_only",
            ]);
          } finally {
            raw.close();
          }
        } finally {
          second.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("permits the single legal promotion and denies everything else", () => {
    db = new ChronoDatabase({ path: join(tempDir, "chrono.db") });
    db.migrate();
    seedCandidate("RTE-0001");
    seedCandidate("RTE-0002");

    // Legal promotion shape (what the repository issues): allowed.
    rawExec(
      "UPDATE routing_proof SET authority = 'authoritative', adapter_hash = ?, asset_hash = ? WHERE id = ?",
      "hash-a",
      "hash-b",
      "RTE-0001"
    );
    expect(db.routingProofs().findById("RTE-0001").authority).toBe("authoritative");

    // Authority demotion.
    expect(() =>
      rawExec("UPDATE routing_proof SET authority = 'candidate' WHERE id = ?", "RTE-0001")
    ).toThrow(/routing_proof/);
    // Promotion without hashes.
    expect(() =>
      rawExec("UPDATE routing_proof SET authority = 'authoritative' WHERE id = ?", "RTE-0002")
    ).toThrow(/routing_proof/);
    // Evidence tampering on a candidate.
    expect(() =>
      rawExec("UPDATE routing_proof SET proof_command = ? WHERE id = ?", "[]", "RTE-0002")
    ).toThrow(/routing_proof/);
    // Binding tampering on an authoritative proof.
    expect(() =>
      rawExec("UPDATE routing_proof SET binary_hash = ? WHERE id = ?", "00", "RTE-0001")
    ).toThrow(/routing_proof/);
    // Expiry extension on an authoritative proof.
    expect(() =>
      rawExec("UPDATE routing_proof SET valid_until = ? WHERE id = ?", "2030-01-01T00:00:00.000Z", "RTE-0001")
    ).toThrow(/routing_proof/);
    // Hash mutation on an authoritative proof.
    expect(() =>
      rawExec("UPDATE routing_proof SET adapter_hash = ? WHERE id = ?", "other", "RTE-0001")
    ).toThrow(/routing_proof/);
    // Deletion is forbidden for every row.
    expect(() => rawExec("DELETE FROM routing_proof WHERE id = ?", "RTE-0002")).toThrow(/routing_proof/);
    expect(() => rawExec("DELETE FROM routing_proof WHERE id = ?", "RTE-0001")).toThrow(/routing_proof/);

    // Denied statements left the rows untouched.
    expect(db.routingProofs().findById("RTE-0001").authority).toBe("authoritative");
    expect(db.routingProofs().findById("RTE-0001").adapterHash).toBe("hash-a");
    expect(db.routingProofs().findById("RTE-0002").authority).toBe("candidate");
  });

  it("reports promotion idempotently without a second write", () => {
    db = new ChronoDatabase({ path: join(tempDir, "chrono.db") });
    db.migrate();
    seedCandidate("RTE-0001");
    const first = db.routingProofs().promote("RTE-0001", "hash-a", "hash-b");
    expect(first.applied).toBe(true);
    expect(first.record.authority).toBe("authoritative");
    const second = db.routingProofs().promote("RTE-0001", "hash-a", "hash-b");
    expect(second.applied).toBe(false);
    expect(second.record.authority).toBe("authoritative");
  });
});

describe("Exactly-once ceremony ledger and fan-out repair (v16)", () => {
  let tempDir: string;
  let db: ChronoDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-ceremony-mig-test-"));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Already closed or never opened.
    }
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function grantPayload(ticketId: string, callId: string | null, ceremony = "question-answer-v2"): string {
    return JSON.stringify({
      action: "planning-approval",
      scopeArtifactId: "OPEN-0001",
      scopeRevision: `sha256:${"a".repeat(64)}`,
      authority: "PO",
      ticketId,
      ceremony,
      nativeObservation: callId === null ? undefined : { permissionCallId: callId, decidedAt: "2026-09-14T00:00:00.000Z", autoModeProbed: true },
      policyVersion: "8",
    });
  }

  function seedApproval(id: string): void {
    const raw = new Database(join(tempDir, "chrono.db"));
    try {
      raw
        .prepare(
          `INSERT INTO approval (id, action, scope_artifact_id, scope_revision, authority, signer, signature, rationale, timestamp, revoked)
           VALUES (?, 'planning-approval', 'OPEN-0001', ?, 'PO', 'PO', 'sig', 'r', '2026-09-14T00:00:00.000Z', 0)`
        )
        .run(id, `sha256:${"a".repeat(64)}`);
    } finally {
      raw.close();
    }
  }

  function seedGrant(approvalId: string, ticketId: string, callId: string | null, ceremony = "question-answer-v2"): void {
    const raw = new Database(join(tempDir, "chrono.db"));
    try {
      raw
        .prepare(
          `INSERT INTO event_log (event_type, entity_id, payload, actor, timestamp, prior_state, new_state, reasoning)
           VALUES ('ApprovalGranted', ?, ?, 'PO', '2026-09-14T00:00:00.000Z', 'granted', 'granted', 'test')`
        )
        .run(approvalId, grantPayload(ticketId, callId, ceremony));
    } finally {
      raw.close();
    }
  }

  it("creates the claim ledger on every upgrade path and revokes only fan-out rows", () => {
    for (const baseline of [1, 15]) {
      const dir = mkdtempSync(join(tmpdir(), "chrono-v16-test-"));
      try {
        const first = new ChronoDatabase({ path: join(dir, "chrono.db") });
        try {
          first.migrate(baseline);
        } finally {
          first.close();
        }
        // Seed the TICKET-0024 class BEFORE the v16 repair runs: one
        // approval id granted for two tickets by one observation.
        const raw = new Database(join(dir, "chrono.db"));
        try {
          raw
            .prepare(
              `INSERT INTO approval (id, action, scope_artifact_id, scope_revision, authority, signer, signature, rationale, timestamp, revoked)
               VALUES ('APR-0002', 'planning-approval', 'OPEN-0001', ?, 'PO', 'PO', 'sig', 'r', '2026-09-14T00:00:00.000Z', 0)`
            )
            .run(`sha256:${"a".repeat(64)}`);
          raw
            .prepare(
              `INSERT INTO approval (id, action, scope_artifact_id, scope_revision, authority, signer, signature, rationale, timestamp, revoked)
               VALUES ('APR-0003', 'planning-approval', 'OPEN-0001', ?, 'PO', 'PO', 'sig', 'r', '2026-09-14T00:00:00.000Z', 0)`
            )
            .run(`sha256:${"b".repeat(64)}`);
          raw
            .prepare(
              `INSERT INTO approval (id, action, scope_artifact_id, scope_revision, authority, signer, signature, rationale, timestamp, revoked)
               VALUES ('APR-0004', 'module-approval', 'MOD-0001', ?, 'PO', 'PO', 'sig', 'r', '2026-09-14T00:00:00.000Z', 0)`
            )
            .run(`sha256:${"c".repeat(64)}`);
          const grant = raw.prepare(
            `INSERT INTO event_log (event_type, entity_id, payload, actor, timestamp, prior_state, new_state, reasoning)
             VALUES ('ApprovalGranted', ?, ?, 'PO', '2026-09-14T00:00:00.000Z', 'granted', 'granted', 'test')`
          );
          // Fan-out: APR-0002 granted for two tickets, one observation.
          grant.run("APR-0002", grantPayload("TICKET-0024", "req-7"));
          grant.run("APR-0002", grantPayload("TICKET-0025", "req-7"));
          // Legit alias: APR-0003 granted for two tickets, two observations.
          grant.run("APR-0003", grantPayload("TICKET-0030", "req-a"));
          grant.run("APR-0003", grantPayload("TICKET-0031", "req-b"));
          // Classic: no ticket marker at all.
          grant.run("APR-0004", JSON.stringify({ action: "module-approval" }));
        } finally {
          raw.close();
        }
        const second = new ChronoDatabase({ path: join(dir, "chrono.db") });
        try {
          second.migrate();
          expect(second.schemaVersion()).toBe(SCHEMA_VERSION);
          // The ledger exists and is writable.
          expect(second.ceremonyClaims().insert("k".repeat(64), "TICKET-0001", "APR-0001", "2026-09-14T00:00:00.000Z")).toBe(true);
          expect(second.ceremonyClaims().insert("k".repeat(64), "TICKET-0001", "APR-0001", "2026-09-14T00:00:00.000Z")).toBe(false);
          expect(second.ceremonyClaims().findByKey("k".repeat(64))).toMatchObject({ ticketId: "TICKET-0001", approvalId: "APR-0001" });
          // Fan-out row revoked with an audit event; history preserved.
          expect(second.approvals().findById("APR-0002").revoked).toBe(true);
          const revocations = second.events().listByEntity("APR-0002").filter((e) => e.eventType === "ApprovalRevoked");
          expect(revocations).toHaveLength(1);
          // Legit alias and classic rows untouched.
          expect(second.approvals().findById("APR-0003").revoked).toBe(false);
          expect(second.approvals().findById("APR-0004").revoked).toBe(false);
          expect(second.events().listByEntity("APR-0003").filter((e) => e.eventType === "ApprovalRevoked")).toHaveLength(0);
        } finally {
          second.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("v16 migration is idempotent: re-running adds no second revocation", () => {
    db = new ChronoDatabase({ path: join(tempDir, "chrono.db") });
    db.migrate(15);
    seedApproval("APR-0002");
    seedGrant("APR-0002", "TICKET-0024", "req-7");
    seedGrant("APR-0002", "TICKET-0025", "req-7");
    db.migrate();
    expect(db.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(db.approvals().findById("APR-0002").revoked).toBe(true);
    expect(db.events().listByEntity("APR-0002").filter((e) => e.eventType === "ApprovalRevoked")).toHaveLength(1);
    // Re-running the migrator applies nothing and adds no duplicate audit.
    expect(db.migrate()).toHaveLength(0);
    expect(db.events().listByEntity("APR-0002").filter((e) => e.eventType === "ApprovalRevoked")).toHaveLength(1);
  });
});

describe("Approval supersede schema (v17)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-supersede-mig-test-"));
  });

  afterEach(() => {
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rebuilds approval without data loss, keeps guards, and scopes uniqueness to active rows", () => {
    for (const baseline of [1, 16]) {
      const dir = mkdtempSync(join(tmpdir(), "chrono-v17-test-"));
      try {
        const first = new ChronoDatabase({ path: join(dir, "chrono.db") });
        try {
          first.migrate(baseline);
          const raw = new Database(join(dir, "chrono.db"));
          try {
            raw
              .prepare(
                `INSERT INTO approval (id, action, scope_artifact_id, scope_revision, authority, signer, signature, rationale, timestamp, revoked)
                 VALUES ('APR-0002', 'planning-approval', 'OPEN-0001', ?, 'PO', 'PO', 'sig', 'r', '2026-09-14T00:00:00.000Z', 0)`
              )
              .run(`sha256:${"a".repeat(64)}`);
          } finally {
            raw.close();
          }
        } finally {
          first.close();
        }
        const second = new ChronoDatabase({ path: join(dir, "chrono.db") });
        try {
          second.migrate();
          expect(second.schemaVersion()).toBe(SCHEMA_VERSION);
          // History preserved across the rebuild.
          expect(second.approvals().findById("APR-0002").revoked).toBe(false);
          // Append-only guards survived the rebuild.
          const raw = new Database(join(dir, "chrono.db"));
          try {
            const triggers = raw
              .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'approval'")
              .all() as { name: string }[];
            expect(triggers.map((t) => t.name).sort()).toEqual(["trg_approval_no_delete", "trg_approval_update_guard"]);
            const indexes = raw
              .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approval'")
              .all() as { name: string; sql: string }[];
            const active = indexes.find((i) => i.name === "idx_approval_active_triple");
            expect(active?.sql).toContain("WHERE revoked = 0");
            expect(() => raw.prepare("DELETE FROM approval WHERE id = 'APR-0002'").run()).toThrow(/revoke instead/);
            expect(() => raw.prepare("UPDATE approval SET rationale = 'x' WHERE id = 'APR-0002'").run()).toThrow(/immutable/);
          } finally {
            raw.close();
          }
          // Revoke-then-create works: a superseding row for the same
          // triple inserts once the historical row is revoked...
          second.approvals().revoke("APR-0002");
          expect(() =>
            second.approvals().create({
              id: "APR-0009", action: "planning-approval", scopeArtifactId: "OPEN-0001",
              scopeRevision: `sha256:${"a".repeat(64)}`, authority: "PO", signer: "PO",
              signature: "sig", rationale: "r", timestamp: "2026-09-14T00:00:00.000Z",
            })
          ).not.toThrow();
          // ...while a second ACTIVE row for the same triple still collides.
          expect(() =>
            second.approvals().create({
              id: "APR-0010", action: "planning-approval", scopeArtifactId: "OPEN-0001",
              scopeRevision: `sha256:${"a".repeat(64)}`, authority: "PO", signer: "PO",
              signature: "sig", rationale: "r", timestamp: "2026-09-14T00:00:00.000Z",
            })
          ).toThrow();
          expect(second.approvals().findByScope("OPEN-0001", `sha256:${"a".repeat(64)}`, "planning-approval")?.id).toBe("APR-0009");
        } finally {
          second.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
