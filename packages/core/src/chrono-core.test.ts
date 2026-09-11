/**
 * Integration tests for persistence — state survives process restart.
 * [CORE §4, P3.9, DOM §14.1]
 * [STATE §3] — Project state is a deterministic projection
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION } from "@chrono/persistence";
import {
  buildApprovalPayload,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore } from "./chrono-core.js";

/**
 * Test PO identity: a fresh Ed25519 keypair per test, registered through
 * the production trust-on-first-use path. Signatures are real; only the
 * key custody differs from production (generated in-test instead of the
 * OS keychain behind an interactive terminal).
 */
function setupTestPo(core: ChronoCore): {
  sign: (fields: {
    action: string;
    scopeArtifactId: string;
    scopeRevision: string;
    authority: string;
    rationale: string;
  }) => { signature: string; timestamp: string };
  restoreTty: () => void;
} {
  const pair = generateApprovalKeyPair();
  const restoreTty = fakeInteractiveTerminal();
  expect(core.registerPoPublicKey(pair.publicKeyPem).ok).toBe(true);
  return {
    sign: (fields) => {
      const timestamp = "2026-06-01T00:00:00.000Z";
      const payload = buildApprovalPayload({ ...fields, timestamp });
      return { signature: signApprovalPayload(payload, pair.privateKeyPem), timestamp };
    },
    restoreTty,
  };
}


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

    const specResult = core.registerSpec("SP-0001", "DRAFT", {
      id: "SP-0001",
      title: "Test Spec",
      purpose: "Testing",
      revision: "sha256:abc",
      status: "DRAFT",
      inScope: [],
      dependencies: [],
    }, "gaspar");
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

    const moduleResult = core.registerModule("MOD-0001", "DRAFT", {
      id: "MOD-0001",
      name: "Test Module",
      purpose: "Testing",
      specs: [],
      workPackages: [],
      dependencies: [],
      risks: [],
      securityStatus: "pending",
    }, "gaspar");
    expect(moduleResult.ok).toBe(true);
    const revision = moduleResult.value;

    // Record a signed approval (real Ed25519 signature, test key).
    const po = setupTestPo(core);
    const { signature, timestamp } = po.sign({
      action: "module-approval",
      scopeArtifactId: "MOD-0001",
      scopeRevision: revision!,
      authority: "PO",
      rationale: "Approved for testing",
    });
    const approvalResult = core.recordApproval({
      action: "module-approval",
      scopeArtifactId: "MOD-0001",
      scopeRevision: revision!,
      authority: "PO",
      rationale: "Approved for testing",
      timestamp,
      signature,
    });
    expect(approvalResult.ok).toBe(true);

    // Close and reopen
    core.close();
    core = new ChronoCore({ projectPath: tempDir });

    // Approval should still be valid
    // Should fail because ModuleApproved transition hasn't happened
    // but it should find the approval
    const hasApproval = core.hasValidApproval("MOD-0001", revision!, "module-approval");
    expect(hasApproval).toBe(true);
    po.restoreTty();
  });

  it("blockers persist across restart and block execution", () => {
    core = new ChronoCore({ projectPath: tempDir });
    core.init();

    const moduleResult = core.registerModule("MOD-0001", "DRAFT", {
      id: "MOD-0001",
      name: "Test Module",
      purpose: "Testing",
      specs: [],
      workPackages: [],
      dependencies: [],
      risks: [],
      securityStatus: "pending",
    }, "gaspar");
    expect(moduleResult.ok).toBe(true);

    const po = setupTestPo(core);
    const { signature, timestamp } = po.sign({
      action: "module-approval",
      scopeArtifactId: "MOD-0001",
      scopeRevision: moduleResult.value!,
      authority: "PO",
      rationale: "test",
    });
    const result = core.recordApproval({
      action: "module-approval",
      scopeArtifactId: "MOD-0001",
      scopeRevision: moduleResult.value!,
      authority: "PO",
      rationale: "test",
      timestamp,
      signature,
    });
    expect(result.ok).toBe(true);

    core.raiseBlocker("PRODUCT_BLOCKER", "gaspar", ["MOD-0001"], "Missing requirement");

    // Close and reopen
    core.close();
    core = new ChronoCore({ projectPath: tempDir });

    // Blocker should still be active
    const status = core.status();
    expect(status.value?.activeBlockers).toBe(1);
    expect(status.value?.state).toBe("BLOCKED");
    po.restoreTty();
  });

  it("event log persists in order and survives restart", () => {
    core = new ChronoCore({ projectPath: tempDir });
    core.init();

    core.registerSpec("SP-0001", "DRAFT", { id: "SP-0001", title: "S1", purpose: "P", status: "DRAFT" }, "gaspar");
    core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "gaspar" });

    core.close();

    // Reopen and verify events through the read-only Core API.
    core = new ChronoCore({ projectPath: tempDir });
    const events = core.listEvents().map((e) => ({ eventType: e.eventType, entityId: e.entityId }));

    expect(events).toContainEqual({ eventType: "ProjectInitialized", entityId: "default" });
    expect(events).toContainEqual({ eventType: "ArtifactCreated", entityId: "SP-0001" });
    expect(events).toContainEqual({ eventType: "StateTransition", entityId: "SP-0001" });
    expect(events.length).toBeGreaterThanOrEqual(3);

    // Sequence numbers are monotonic.
    const seqs = core.listEvents().map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
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

    // The Core migrates fully on construction; no raw handle is exposed.
    expect(core.getSchemaVersion()).toBe(SCHEMA_VERSION);
  });

  it("event log is append-only and ordered", () => {
    core = new ChronoCore({ projectPath: tempDir });
    core.init();
    core.registerSpec("SP-0001", "DRAFT", { id: "SP-0001", title: "S1", purpose: "P" }, "gaspar");

    const count1 = core.listEvents().length;
    core.registerSpec("SP-0002", "DRAFT", { id: "SP-0002", title: "S2", purpose: "P" }, "gaspar");
    const count2 = core.listEvents().length;

    expect(count2).toBe(count1 + 1);
  });
});
