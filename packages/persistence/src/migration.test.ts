/**
 * Migration tests — schema upgrades preserve data across versions.
 * [CORE §5.1, Remediation §10]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
