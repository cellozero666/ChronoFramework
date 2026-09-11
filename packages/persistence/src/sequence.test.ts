/**
 * I2 tests — collision-safe Core-assigned identifier sequences.
 * [CORE §3.1, Remediation §4]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChronoDatabase } from "./database.js";

describe("SequenceRepository", () => {
  let tempDir: string;
  let db: ChronoDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-seq-test-"));
    db = new ChronoDatabase({ path: join(tempDir, "chrono.db") });
    db.migrate();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("allocates monotonic zero-padded identifiers per family", () => {
    const sequences = db.sequences();
    expect(sequences.allocate("BLK")).toBe("BLK-0001");
    expect(sequences.allocate("BLK")).toBe("BLK-0002");
    expect(sequences.allocate("QA")).toBe("QA-0001");
    expect(sequences.allocate("BLK")).toBe("BLK-0003");
  });

  it("never reuses sequences across reopen (no wall-clock derivation)", () => {
    expect(db.sequences().allocate("BLK")).toBe("BLK-0001");
    db.close();
    db = new ChronoDatabase({ path: join(tempDir, "chrono.db") });
    db.migrate();
    expect(db.sequences().allocate("BLK")).toBe("BLK-0002");
  });

  it("serves interleaved writers without collision", () => {
    const sequences = db.sequences();
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = sequences.allocate(i % 2 === 0 ? "EVD" : "DEF");
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(50);
  });

  it("keeps concurrent connections collision-free on one file", () => {
    const path = join(tempDir, "chrono.db");
    const first = new ChronoDatabase({ path });
    first.migrate();
    const second = new ChronoDatabase({ path });
    second.migrate();
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 25; i++) {
        for (const handle of [first, second]) {
          const id = handle.sequences().allocate("BLK");
          expect(seen.has(id)).toBe(false);
          seen.add(id);
        }
      }
      expect(seen.size).toBe(50);
    } finally {
      first.close();
      second.close();
    }
  });
});
