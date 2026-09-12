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
          expect(second.schemaVersion()).toBe(14);
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
