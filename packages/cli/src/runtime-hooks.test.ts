/**
 * Slice 9 §9.5 — Claude Code and Kiro native-hook enforcement.
 * Exercises the generated hook bytes for real: each hook is written to a
 * temp CHRONO project, invoked with `node <hook>` and a PreToolUse JSON
 * payload on stdin, and must obey fixture gate scripts (AUTHORIZED allows
 * with exit 0, DENIED blocks with exit 2). Unknown tools deny, read-only
 * tools pass without dispatch context, mutable tools require it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildClaudeHook } from "./claude-hook.js";
import { buildKiroHook } from "./kiro-hook.js";

function shellScript(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function runHook(hookPath: string, cwd: string, toolName: string, env: Record<string, string>): { status: number | null; stderr: string; stdout: string } {
  const fullEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      fullEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(env)) {
    fullEnv[key] = value;
  }
  const result = spawnSync("node", [hookPath], {
    cwd,
    env: fullEnv,
    input: JSON.stringify({ tool_name: toolName, tool_input: {} }),
    encoding: "utf8",
  });
  return { status: result.status, stderr: String(result.stderr ?? ""), stdout: String(result.stdout ?? "") };
}

describe.each([
  { runtime: "claude", build: buildClaudeHook, filename: "chrono-claude-gate.js" },
  { runtime: "kiro", build: buildKiroHook, filename: "chrono-kiro-gate.js" },
])("$runtime pre-tool hook ($filename)", ({ build, filename }) => {
  let tempDir: string;
  let hookPath: string;
  let gateAllow: string;
  let gateDeny: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-hook-test-"));
    mkdirSync(join(tempDir, ".chrono"), { recursive: true });
    writeFileSync(join(tempDir, ".chrono", "chrono.db"), "", "utf8");
    expect(build()).toBe(build());
    hookPath = join(tempDir, filename);
    writeFileSync(hookPath, build(), "utf8");
    gateAllow = shellScript(join(tempDir, "gate-allow.sh"), "echo '{\"result\":\"AUTHORIZED\"}'");
    gateDeny = shellScript(
      join(tempDir, "gate-deny.sh"),
      "echo '{\"result\":\"DENIED\",\"code\":\"EXECUTION_DENIED\",\"reason\":\"nope\"}'; exit 1"
    );
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    for (const key of ["CHRONO_BIN", "CHRONO_GATE_MODULE", "CHRONO_GATE_WP", "CHRONO_SESSION_TOKEN", "CHRONO_GATE_AS", "CHRONO_GATE_ROLE", "CHRONO_REQUESTER_TOKEN"]) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function fullEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      CHRONO_BIN: gateAllow,
      CHRONO_GATE_MODULE: "MOD-0001",
      CHRONO_SESSION_TOKEN: "SES-0001/abc",
      CHRONO_GATE_AS: "belthazar",
      CHRONO_GATE_ROLE: "belthazar",
      ...extra,
    };
  }

  it("passes outside CHRONO projects", () => {
    const plain = mkdtempSync(join(tmpdir(), "chrono-plain-"));
    try {
      const out = runHook(hookPath, plain, "Bash", {});
      expect(out.status).toBe(0);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("denies malformed payloads fail-closed", () => {
    const result = spawnSync("node", [hookPath], { cwd: tempDir, input: "not-json{{{", encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(String(result.stderr)).toContain("TOOL_DENIED");
  });

  it("denies unknown tools deny-by-default", () => {
    const out = runHook(hookPath, tempDir, "mcp__future_tool", fullEnv());
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("TOOL_DENIED");
  });

  it("denies mutable tools without dispatch context", () => {
    const mutable = filename.includes("claude") ? "Bash" : "shell";
    const out = runHook(hookPath, tempDir, mutable, {});
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("without dispatch context");
  });

  it("obeys AUTHORIZED and DENIED gate verdicts on mutable tools", () => {
    const mutable = filename.includes("claude") ? "Edit" : "Write";
    const allowed = runHook(hookPath, tempDir, mutable, fullEnv());
    expect(allowed.status).toBe(0);
    const denied = runHook(hookPath, tempDir, mutable, fullEnv({ CHRONO_BIN: gateDeny }));
    expect(denied.status).toBe(2);
    expect(denied.stderr).toContain("EXECUTION_DENIED: nope");
  });

  it("denies when the gate binary is missing", () => {
    const mutable = filename.includes("claude") ? "Write" : "fs_write";
    const out = runHook(hookPath, tempDir, mutable, fullEnv({ CHRONO_BIN: join(tempDir, "missing-gate.sh") }));
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("unreachable");
  });
});
