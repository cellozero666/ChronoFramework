/**
 * I7 CLI tests — human-only commands refuse non-interactive invocation
 * without persisting anything; the interactive path signs through the
 * OS-keychain-backed store and verifies through the Core.
 * [ADR-003, P2.10, Remediation §3]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateApprovalKeyPair } from "@chrono/domain";
import { ChronoCore } from "@chrono/core";
import {
  runApprove,
  runInit,
  runKeysGenerate,
  runWaive,
  testDeps,
  type HumanCommandDeps,
} from "./index.js";
import { MemoryKeyStore } from "./keychain.js";

const SPEC = { id: "SP-0001", title: "T", purpose: "P" };
const FIXED_REVISION = `sha256:${"c".repeat(64)}`;

function interactive(store?: MemoryKeyStore): HumanCommandDeps {
  return testDeps(store ?? new MemoryKeyStore());
}

function nonInteractive(store?: MemoryKeyStore): HumanCommandDeps {
  return { interactive: false, store: store ?? new MemoryKeyStore() };
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

describe("CLI human-only authority", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-auth-cli-test-"));
    expect(runInit(tempDir).exitCode).toBe(0);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("refuses approve/waive/keys-generate without a TTY and persists nothing", () => {
    const deps = nonInteractive();
    const approve = runApprove(
      tempDir,
      { action: "module-approval", scope: "SP-0001", revision: FIXED_REVISION, authority: "PO", rationale: "x" },
      deps
    );
    expect(approve.exitCode).toBe(1);
    expect(approve.stderr).toContain("APPROVAL_REQUIRED");
    expect(approve.stderr).toContain("interactive");

    const waive = runWaive(
      tempDir,
      { scope: "SP-0001", revision: FIXED_REVISION, authority: "PO", issue: "i", rationale: "r", expiry: "e" },
      deps
    );
    expect(waive.exitCode).toBe(1);

    expect(runKeysGenerate(tempDir, {}, deps).exitCode).toBe(1);

    // Nothing was persisted by any refused command.
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      expect(core.listEvents().filter((e) => e.eventType === "ApprovalGranted")).toHaveLength(0);
      expect(core.listEvents().filter((e) => e.eventType === "WaiverGranted")).toHaveLength(0);
    } finally {
      core.close();
    }
  });

  it("emits JSON refusal with --json on the non-interactive path", () => {
    const out = runApprove(
      tempDir,
      { action: "module-approval", scope: "SP-0001", revision: FIXED_REVISION, authority: "PO", rationale: "x", json: true },
      nonInteractive()
    );
    expect(out.exitCode).toBe(1);
    const parsed = JSON.parse(out.stdout) as { ok: boolean; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("APPROVAL_REQUIRED");
  });

  it("completes keys-generate → approve end to end through the keychain store", () => {
    const restoreTty = fakeInteractiveTerminal();
    const store = new MemoryKeyStore();
    const deps = interactive(store);
    expect(runKeysGenerate(tempDir, {}, deps).exitCode).toBe(0);

    const core = new ChronoCore({ projectPath: tempDir });
    let revision: string;
    try {
      expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
      revision = core.getArtifact("SP-0001").revision;
    } finally {
      core.close();
    }

    const approved = runApprove(
      tempDir,
      { action: "module-approval", scope: "SP-0001", revision, authority: "po@example.com", rationale: "go" },
      deps
    );
    expect(approved.exitCode).toBe(0);
    expect(approved.stdout).toContain("APR-");

    const verify = new ChronoCore({ projectPath: tempDir });
    try {
      expect(verify.hasValidApproval("SP-0001", revision, "module-approval")).toBe(true);
    } finally {
      verify.close();
    }
    restoreTty();
  });

  it("rejects approval when the store holds an unregistered key", () => {
    const restoreTty = fakeInteractiveTerminal();
    // Key in store, but a DIFFERENT key registered with the project.
    const storeKey = generateApprovalKeyPair();
    const store = new MemoryKeyStore();
    store.writeKey("po", storeKey.privateKeyPem);
    const registered = generateApprovalKeyPair();
    const core = new ChronoCore({ projectPath: tempDir });
    let revision: string;
    try {
      expect(core.registerPoPublicKey(registered.publicKeyPem).ok).toBe(true);
      expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
      revision = core.getArtifact("SP-0001").revision;
    } finally {
      core.close();
    }
    const out = runApprove(
      tempDir,
      { action: "module-approval", scope: "SP-0001", revision, authority: "PO", rationale: "x" },
      interactive(store)
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("SIGNATURE_INVALID");
    restoreTty();
  });

  it("records waivers through the interactive path", () => {
    const restoreTty = fakeInteractiveTerminal();
    const store = new MemoryKeyStore();
    const deps = interactive(store);
    expect(runKeysGenerate(tempDir, {}, deps).exitCode).toBe(0);

    const core = new ChronoCore({ projectPath: tempDir });
    let revision: string;
    try {
      expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
      revision = core.getArtifact("SP-0001").revision;
    } finally {
      core.close();
    }

    const waived = runWaive(
      tempDir,
      { scope: "SP-0001", revision, authority: "PO", issue: "risk", rationale: "accept", expiry: "review 30d" },
      deps
    );
    expect(waived.exitCode).toBe(0);
    expect(waived.stdout).toContain("WAIVER-");
    restoreTty();
  });
});
