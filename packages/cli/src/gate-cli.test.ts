/**
 * CLI gate/attestation tests — adapters obey Core decisions; every
 * failure path emits JSON with --json.
 * [RUNTIME §3.2, Remediation §5]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  buildSessionAuthorizationPayload,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { runAttestationStatus, runGate, runInit, runRtkVerify } from "./index.js";
import { ChronoCore } from "@chrono/core";

/**
 * TEST-ONLY terminal simulation (session opening is interactive).
 * Never ships; lives only in *.test.ts files.
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

/** Open a gaspar session: CLI token form plus the object form. */
function openCliSession(projectPath: string): {
  tokenString: string;
  session: { id: string; token: string };
} {
  const core = new ChronoCore({ projectPath });
  try {
    const pair = generateApprovalKeyPair();
    expect(core.registerPoPublicKey(pair.publicKeyPem).ok).toBe(true);
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
      pair.privateKeyPem
    );
    const res = core.openSession(
      { role: "gaspar", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
      { poAuthorization: { nonce, authority: "PO", rationale, timestamp, signature } }
    );
    expect(res.ok).toBe(true);
    return {
      tokenString: `${res.value!.id}/${res.value!.token}`,
      session: { id: res.value!.id, token: res.value!.token },
    };
  } finally {
    core.close();
  }
}

describe("CLI gate", () => {
  let tempDir: string;
  let restoreTty: () => void;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-gate-cli-test-"));
    expect(runInit(tempDir).exitCode).toBe(0);
    restoreTty = fakeInteractiveTerminal();
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("requires an explicit actor identity", () => {
    const out = runGate(tempDir, { gate: "execution", module: "MOD-0001", json: true });
    expect(out.exitCode).toBe(2);
    const parsed = JSON.parse(out.stdout) as { result: string; code: string };
    expect(parsed.result).toBe("ERROR");
    expect(parsed.code).toBe("VALIDATION_ERROR");
  });

  it("denies unknown modules as DENIED with JSON", () => {
    const setup = new ChronoCore({ projectPath: tempDir });
    let sessionToken: string;
    try {
      const opened = setup.openSession(
        { role: "belthazar", adapter: "test-adapter", runtime: "test-runtime", scopeModule: "default", ttlSeconds: 3600 },
        { interactive: true }
      );
      expect(opened.ok).toBe(true);
      sessionToken = `${opened.value!.id}/${opened.value!.token}`;
    } finally {
      setup.close();
    }
    const out = runGate(tempDir, { gate: "execution", module: "MOD-0099", as: "belthazar", role: "belthazar", sessionToken, json: true });
    expect(out.exitCode).toBe(1);
    const parsed = JSON.parse(out.stdout) as { result: string; code: string; reason: string };
    expect(parsed.result).toBe("DENIED");
    expect(parsed.code).toBe("ENTITY_NOT_FOUND");
    expect(parsed.reason.length).toBeGreaterThan(0);
  });

  it("rejects unknown gates", () => {
    const out = runGate(tempDir, { gate: "teleport", as: "gaspar", json: true });
    expect(out.exitCode).toBe(2);
  });

  it("reports missing attestations", () => {
    const rtk = runAttestationStatus(tempDir, "rtk", { json: true });
    expect(rtk.exitCode).toBe(0);
    expect(JSON.parse(rtk.stdout) as object).toMatchObject({ kind: "rtk", state: "missing" });
    const skill = runAttestationStatus(tempDir, "skill", { json: true });
    expect(JSON.parse(skill.stdout) as object).toMatchObject({ kind: "skill", state: "missing" });
  });

  it("fails rtk verify closed when the binary is absent", () => {
    const throwing = (): { exitCode: number; stdout: string } => {
      throw Object.assign(new Error("spawn rtk ENOENT"), { code: "ENOENT" });
    };
    const out = runRtkVerify(tempDir, { session: openCliSession(tempDir).session }, throwing);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("BLOCKED_RTK");
  });

  it("fails rtk verify closed on identity failure (gain nonzero)", () => {
    const fake = (binary: string, args: string[]): { exitCode: number; stdout: string } => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: `${binary} 0.0.0\n` };
      }
      return { exitCode: 1, stdout: "" };
    };
    const out = runRtkVerify(tempDir, { session: openCliSession(tempDir).session }, fake);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("RTK_NAME_COLLISION");
  });

  it("records an attestation when version and gain succeed", () => {
    const fake = (binary: string, args: string[]): { exitCode: number; stdout: string } => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: `${binary} 0.44.0\n` };
      }
      return { exitCode: 0, stdout: "gain dashboard" };
    };
    const out = runRtkVerify(tempDir, { session: openCliSession(tempDir).session }, fake);
    expect(out.exitCode).toBe(0);
    const status = runAttestationStatus(tempDir, "rtk", { json: true });
    const parsed = JSON.parse(status.stdout) as { state: string };
    expect(parsed.state).toBe("current");
  });
});
