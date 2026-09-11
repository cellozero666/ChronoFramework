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
import { randomBytes } from "node:crypto";
import {
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore } from "@chrono/core";
import {
  runApprove,
  runEnroll,
  runInit,
  runKeysGenerate,
  runWaive,
  testDeps,
  type HumanCommandDeps,
} from "./index.js";
import { MemoryKeyStore, PO_KEY_STAGING_ACCOUNT } from "./keychain.js";

const SPEC = { id: "SP-0001", title: "T", purpose: "P" };
const FIXED_REVISION = `sha256:${"c".repeat(64)}`;

function interactive(store?: MemoryKeyStore): HumanCommandDeps {
  return testDeps(store ?? new MemoryKeyStore());
}

function nonInteractive(store?: MemoryKeyStore): HumanCommandDeps {
  return { interactive: false, store: store ?? new MemoryKeyStore() };
}

function openGasparWithKey(core: ChronoCore, privateKeyPem: string): { actor: string; session: { id: string; token: string } } {
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
    privateKeyPem
  );
  const opened = core.openSession(
    { role: "gaspar", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
    { poAuthorization: { nonce, authority: "PO", rationale, timestamp, signature } }
  );
  expect(opened.ok).toBe(true);
  return { actor: "gaspar", session: { id: opened.value!.id, token: opened.value!.token } };
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

/** TEST-ONLY confirmation: echoes the challenge after asserting its shape. */
function confirmEcho(challenge: string): string {
  expect(challenge).toMatch(/^enroll-default-[0-9a-f]{8}-[0-9a-f]{8}$/);
  return challenge;
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
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
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

  it("completes enroll → approve end to end through the keychain store", () => {
    const restoreTty = fakeInteractiveTerminal();
    const store = new MemoryKeyStore();
    const deps = interactive(store);
    expect(runEnroll(tempDir, { rationale: "test enrollment" }, deps, confirmEcho).exitCode).toBe(0);

    const core = new ChronoCore({ projectPath: tempDir });
    let revision: string;
    try {
      const privateKey = store.readKey("po");
      expect(privateKey).not.toBeNull();
      const gaspar = openGasparWithKey(core, privateKey!);
      expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
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
      enrollTestPo(core, registered);
      const gaspar = openGasparWithKey(core, registered.privateKeyPem);
      expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
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
    expect(runEnroll(tempDir, { rationale: "test enrollment" }, deps, confirmEcho).exitCode).toBe(0);

    const core = new ChronoCore({ projectPath: tempDir });
    let revision: string;
    try {
      const privateKey = store.readKey("po");
      expect(privateKey).not.toBeNull();
      const gaspar = openGasparWithKey(core, privateKey!);
      expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
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

  it("refuses key replacement without --rotate and preserves the active key", () => {
    const restoreTty = fakeInteractiveTerminal();
    const store = new MemoryKeyStore();
    const deps = interactive(store);
    expect(runEnroll(tempDir, { rationale: "test enrollment" }, deps, confirmEcho).exitCode).toBe(0);
    const active = store.readKey("po");
    expect(active).not.toBeNull();

    const refused = runKeysGenerate(tempDir, {}, deps);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("Refusing to replace");
    expect(store.readKey("po")).toBe(active);
    expect(store.readKey(PO_KEY_STAGING_ACCOUNT)).toBeNull();
    restoreTty();
  });

  it("rotates with a signed rotation, replaces the primary, and cleans staging", () => {
    const restoreTty = fakeInteractiveTerminal();
    const store = new MemoryKeyStore();
    const deps = interactive(store);
    expect(runEnroll(tempDir, { rationale: "test enrollment" }, deps, confirmEcho).exitCode).toBe(0);
    const active = store.readKey("po");
    expect(active).not.toBeNull();

    const rotated = runKeysGenerate(tempDir, { rotate: true, rationale: "scheduled rotation" }, deps);
    expect(rotated.exitCode).toBe(0);
    const replacement = store.readKey("po");
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(active);
    expect(store.readKey(PO_KEY_STAGING_ACCOUNT)).toBeNull();
    restoreTty();
  });

  it("failed rotation preserves the active key and cleans staging", () => {
    const restoreTty = fakeInteractiveTerminal();
    const unrelated = generateApprovalKeyPair();
    const store = new MemoryKeyStore();
    store.writeKey("po", unrelated.privateKeyPem);
    const registered = generateApprovalKeyPair();
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      enrollTestPo(core, registered);
    } finally {
      core.close();
    }

    const failed = runKeysGenerate(
      tempDir,
      { rotate: true, rationale: "attacker rotation" },
      interactive(store)
    );
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("SIGNATURE_INVALID");
    expect(store.readKey("po")).toBe(unrelated.privateKeyPem);
    expect(store.readKey(PO_KEY_STAGING_ACCOUNT)).toBeNull();
    restoreTty();
  });
});

describe("CLI PO enrollment ceremony [SLICE-9 §9.1]", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-enroll-cli-test-"));
    expect(runInit(tempDir).exitCode).toBe(0);
  });

  afterEach(() => {
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("enrolls with typed confirmation and never exposes the private key", () => {
    const restoreTty = fakeInteractiveTerminal();
    const store = new MemoryKeyStore();
    try {
      const out = runEnroll(tempDir, { rationale: "first custodian" }, interactive(store), confirmEcho);
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toContain("fingerprint");
      const stored = store.readKey("po");
      expect(stored).not.toBeNull();
      expect(out.stdout).not.toContain(stored!);
      expect(out.stderr).not.toContain(stored!);
      expect(out.stdout).not.toContain("PRIVATE");
      const check = new ChronoCore({ projectPath: tempDir });
      try {
        expect(check.poKeyRevision()).toMatch(/^sha256:[0-9a-f]{64}$/);
      } finally {
        check.close();
      }
    } finally {
      restoreTty();
    }
  });

  it("refuses without rationale, without TTY, and without a controlling terminal", () => {
    const restoreTty = fakeInteractiveTerminal();
    const store = new MemoryKeyStore();
    try {
      expect(runEnroll(tempDir, {}, interactive(store), confirmEcho).exitCode).toBe(1);
      expect(runEnroll(tempDir, { rationale: "x" }, nonInteractive(store), confirmEcho).exitCode).toBe(1);
      const noTty = runEnroll(tempDir, { rationale: "x" }, interactive(store), () => null);
      expect(noTty.exitCode).toBe(1);
      expect(noTty.stderr).toContain("APPROVAL_REQUIRED");
      const check = new ChronoCore({ projectPath: tempDir });
      try {
        expect(check.poKeyRevision()).toBeNull();
      } finally {
        check.close();
      }
      expect(store.readKey("po")).toBeNull();
    } finally {
      restoreTty();
    }
  });

  it("refuses mistyped confirmation and persists nothing", () => {
    const restoreTty = fakeInteractiveTerminal();
    const store = new MemoryKeyStore();
    try {
      const out = runEnroll(tempDir, { rationale: "x" }, interactive(store), () => "enroll-wrong");
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain("VALIDATION_ERROR");
      const check = new ChronoCore({ projectPath: tempDir });
      try {
        expect(check.poKeyRevision()).toBeNull();
      } finally {
        check.close();
      }
      expect(store.readKey("po")).toBeNull();
    } finally {
      restoreTty();
    }
  });

  it("refuses a second enrollment and preserves existing custody on Core failure", () => {
    const restoreTty = fakeInteractiveTerminal();
    const store = new MemoryKeyStore();
    try {
      expect(runEnroll(tempDir, { rationale: "first" }, interactive(store), confirmEcho).exitCode).toBe(0);
      const first = store.readKey("po");
      const second = runEnroll(tempDir, { rationale: "second" }, interactive(store), confirmEcho);
      expect(second.exitCode).toBe(1);
      expect(store.readKey("po")).toBe(first);
    } finally {
      restoreTty();
    }
  });
});
