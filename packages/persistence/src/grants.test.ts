/**
 * Grant repository tests — single-use dispatch grants.
 * [DOM §2.2, Remediation §3A]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChronoDatabase } from "./database.js";

describe("GrantRepository", () => {
  let tempDir: string;
  let db: ChronoDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-grant-test-"));
    db = new ChronoDatabase({ path: join(tempDir, "chrono.db") });
    db.migrate();
  });

  afterEach(() => {
    if (typeof db !== "undefined") {
      db.close();
    }
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function grant(id: string) {
    return {
      id,
      projectId: "default",
      moduleId: "MOD-0001",
      workPackageId: null as string | null,
      moduleRevision: `sha256:${"a".repeat(64)}`,
      workPackageRevision: null as string | null,
      specRevisions: {} as Record<string, string>,
      harnessBindings: [] as Array<{ specId: string; specRevision: string; contentHash: string }>,
      role: "belthazar",
      session: null as string | null,
      requestedBy: "gaspar",
      adapterId: null as string | null,
      rtkAttestationId: null as string | null,
      skillAttestationId: null as string | null,
      moduleApprovalId: null as string | null,
      archApprovalId: null as string | null,
      policyVersion: "1",
      issuedAt: "2026-09-11T00:00:00.000Z",
      expiresAt: "2026-09-11T01:00:00.000Z",
    };
  }

  it("consumes exactly once: replay denies", () => {
    db.grants().create(grant("GRANT-0001"));
    expect(db.grants().findById("GRANT-0001").consumed).toBe(false);
    expect(db.grants().consume("GRANT-0001").consumed).toBe(true);
    expect(() => db.grants().consume("GRANT-0001")).toThrow(/already consumed/);
  });

  it("round-trips the optional adapter binding", () => {
    db.grants().create({ ...grant("GRANT-0002"), adapterId: "fixture" });
    expect(db.grants().findById("GRANT-0002").adapterId).toBe("fixture");
    db.grants().create(grant("GRANT-0001"));
    expect(db.grants().findById("GRANT-0001").adapterId).toBeNull();
  });

  it("rejects unknown grant ids", () => {
    expect(() => db.grants().findById("GRANT-0999")).toThrow(/not found/);
  });
});
