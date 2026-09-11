/**
 * CLI gate/attestation tests — adapters obey Core decisions; every
 * failure path emits JSON with --json.
 * [RUNTIME §3.2, Remediation §5]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAttestationStatus, runGate, runInit, runRtkVerify } from "./index.js";

describe("CLI gate", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-gate-cli-test-"));
    expect(runInit(tempDir).exitCode).toBe(0);
  });

  afterEach(() => {
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
    const out = runGate(tempDir, { gate: "execution", module: "MOD-0001", as: "gaspar", role: "belthazar", json: true });
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
    const out = runRtkVerify(tempDir, {}, throwing);
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
    const out = runRtkVerify(tempDir, {}, fake);
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
    const out = runRtkVerify(tempDir, {}, fake);
    expect(out.exitCode).toBe(0);
    const status = runAttestationStatus(tempDir, "rtk", { json: true });
    const parsed = JSON.parse(status.stdout) as { state: string };
    expect(parsed.state).toBe("current");
  });
});
