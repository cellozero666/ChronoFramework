/**
 * Integration tests for persistence — state survives process restart.
 * [CORE §4, P3.9, DOM §14.1]
 * [STATE §3] — Project state is a deterministic projection
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChronoCore } from "./chrono-core.js";

describe("Persistence: state survives process restart", () => {
  let tempDir: string;
  let core: ChronoCore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-test-"));
  });

  afterEach(() => {
    if (core !== undefined) {
      core.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("project state persists across Core instance restart", () => {
    // First instance: init and register a spec
    core = new ChronoCore({ projectPath: tempDir });
    const initResult = core.init();
    expect(initResult.ok).toBe(true);

    const specResult = core.registerSpec("SP-001", "DRAFT", {
      id: "SP-001",
      title: "Test Spec",
      purpose: "Testing",
      revision: "sha256:abc",
      status: "DRAFT",
      inScope: [],
      dependencies: [],
    });
    expect(specResult.ok).toBe(true);

    // Close the first instance
    core.close();

    // Second instance: reopen and verify state survived
    core = new ChronoCore({ projectPath: tempDir });
    const status = core.status();
    expect(status.ok).toBe(true);
    expect(status.value?.state).toBe("SPECIFYING");
    expect(status.value?.specCount).toBe(1);
  });

  it("module approvals persist across restart", () => {
    core = new ChronoCore({ projectPath: tempDir });
    core.init();

    const moduleResult = core.registerModule("MOD-001", "AWAITING_APPROVAL", {
      id: "MOD-001",
      name: "Test Module",
      purpose: "Testing",
      specs: [],
      workPackages: [],
      dependencies: [],
      risks: [],
      securityStatus: "pending",
    });
    expect(moduleResult.ok).toBe(true);
    const revision = moduleResult.value;

    // Record an approval
    const approvalResult = core.recordApproval({
      id: "APR-001",
      action: "module-approval",
      scopeArtifactId: "MOD-001",
      scopeRevision: revision!,
      authority: "PO",
      signer: "product-owner@example.com",
      signature: "test-signature",
      rationale: "Approved for testing",
    });
    expect(approvalResult.ok).toBe(true);

    // Close and reopen
    core.close();
    core = new ChronoCore({ projectPath: tempDir });

    // Approval should still be valid
    // Should fail because ModuleApproved transition hasn't happened
    // but it should find the approval
    const hasApproval = core.hasValidApproval("MOD-001", revision!, "module-approval");
    expect(hasApproval).toBe(true);
  });

  it("blockers persist across restart and block execution", () => {
    core = new ChronoCore({ projectPath: tempDir });
    core.init();

    core.registerModule("MOD-001", "DRAFT", {
      id: "MOD-001",
      name: "Test Module",
      purpose: "Testing",
      specs: [],
      workPackages: [],
      dependencies: [],
      risks: [],
      securityStatus: "pending",
    });

    const result = core.recordApproval({
      id: "APR-001",
      action: "module-approval",
      scopeArtifactId: "MOD-001",
      scopeRevision: "sha256:draft",
      authority: "PO",
      signer: "po@example.com",
      signature: "sig",
      rationale: "test",
    });
    expect(result.ok).toBe(true);

    core.raiseBlocker("PRODUCT_BLOCKER", "gaspar", ["MOD-001"], "Missing requirement");

    // Close and reopen
    core.close();
    core = new ChronoCore({ projectPath: tempDir });

    // Blocker should still be active
    const status = core.status();
    expect(status.value?.activeBlockers).toBe(1);
    expect(status.value?.state).toBe("BLOCKED");
  });

  it("event log persists in order and survives restart", () => {
    core = new ChronoCore({ projectPath: tempDir });
    core.init();

    core.registerSpec("SP-001", "DRAFT", { id: "SP-001", title: "S1", status: "DRAFT" });
    core.transitionState("SP-001", "SpecSubmittedForReview");

    core.close();

    // Reopen and verify events
    core = new ChronoCore({ projectPath: tempDir });
    const events = core.getDatabase().prepare(
      "SELECT event_type, entity_id FROM event_log ORDER BY seq"
    ).all() as { event_type: string; entity_id: string }[];

    expect(events).toContainEqual({ event_type: "ProjectInitialized", entity_id: "default" });
    expect(events).toContainEqual({ event_type: "ArtifactCreated", entity_id: "SP-001" });
    expect(events).toContainEqual({ event_type: "StateTransition", entity_id: "SP-001" });
    expect(events.length).toBeGreaterThanOrEqual(3);
  });
});

describe("Persistence: SQLite schema", () => {
  let tempDir: string;
  let core: ChronoCore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-schemas-"));
  });

   afterEach(() => {
    if (core !== undefined) {
      core.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("schema version is recorded after migration", () => {
    core = new ChronoCore({ projectPath: tempDir });

    const row = core.getDatabase().prepare(
      "SELECT version, applied_at, migration_sql FROM schema_version ORDER BY version DESC LIMIT 1"
    ).get() as { version: number; applied_at: string; migration_sql: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.version).toBeGreaterThanOrEqual(1);
    expect(row!.migration_sql.length).toBeGreaterThan(0);
  });

  it("event log is append-only and ordered", () => {
    core = new ChronoCore({ projectPath: tempDir });
    core.init();
    core.registerSpec("SP-001", "DRAFT", { id: "SP-001" });

    const count1 = core.getDatabase().prepare("SELECT COUNT(*) as c FROM event_log").get() as { c: number };
    core.registerSpec("SP-002", "DRAFT", { id: "SP-002" });
    const count2 = core.getDatabase().prepare("SELECT COUNT(*) as c FROM event_log").get() as { c: number };

    expect(count2.c).toBe(count1.c + 1);
  });
});
