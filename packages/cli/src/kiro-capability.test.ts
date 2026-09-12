/**
 * Kiro capability tests [FIXES-SL-10.1 C4].
 *
 * Vendor-grounded contract (kiro.dev/docs, fetched 2026-09-11):
 * `.kiro/hooks/*.json` v1 auto-activates; `SessionStart` is IDE-only,
 * `AgentSpawn` is CLI-only, `PreToolUse` blocks on both; shell-command
 * exit 0 injects stdout into agent context while nonzero sends the
 * stderr warning (and blocks PreToolUse); JSON hooks require CLI 3.0+;
 * workspace skills (`.kiro/skills/<name>/SKILL.md`, Agent Skills
 * standard) load on IDE/CLI/Web.
 *
 * Hermetic grade only: these tests validate OUR artifacts and decisions
 * against that contract. They do NOT claim real Kiro conformance — no
 * Kiro binary exists on this host, `VERIFIED_KIRO_VERSIONS` is empty,
 * and Kiro readiness stays an environment blocker until genuine Kiro
 * execution evidences it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  convertSkillSource,
  parseSkillFrontmatter,
} from "@chrono/domain";
import {
  KIRO_CLI_MIN_MAJOR,
  VERIFIED_KIRO_VERSIONS,
  evaluateKiroSupport,
  isKiroVersionVerified,
  parseKiroVersion,
} from "./kiro-capability.js";
import { buildKiroHook } from "./kiro-hook.js";
import {
  buildEntrySessionScript,
  buildKiroEntryRegistration,
  entrySessionCommand,
  kiroEntryRegistrationPath,
} from "./gaspar-entry.js";
import { runInitFlow, type FlowProbes } from "./init-flow.js";
import { MemoryKeyStore } from "./keychain.js";

const FIXTURE_SKILL_MD = `---
name: karpathy-guidelines
description: Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code.
license: MIT
---

# Karpathy Guidelines

Behavioral guidelines to reduce common LLM coding mistakes.
`;

describe("Kiro version parsing and support decision", () => {
  it("parses documented CLI version shapes", () => {
    expect(parseKiroVersion("kiro 3.2.1\n")).toMatchObject({ version: "3.2.1", major: 3 });
    expect(parseKiroVersion("3.0.0")).toMatchObject({ version: "3.0.0", major: 3 });
    expect(parseKiroVersion("kiro-cli 4.0.0-beta\n")).toMatchObject({ version: "4.0.0", major: 4 });
    expect(parseKiroVersion("kiro 2.9.0")).toMatchObject({ version: "2.9.0", major: 2 });
  });

  it("fails closed on unparseable output", () => {
    expect(parseKiroVersion("")).toMatchObject({ version: null, major: null });
    expect(parseKiroVersion("hello world")).toMatchObject({ version: null, major: null });
    expect(parseKiroVersion("   \n")).toMatchObject({ version: null, major: null });
  });

  it("pins the documented JSON-hooks floor", () => {
    expect(KIRO_CLI_MIN_MAJOR).toBe(3);
  });

  it("ships an empty verified-version record until real acceptance", () => {
    expect(VERIFIED_KIRO_VERSIONS).toEqual([]);
    expect(isKiroVersionVerified("3.2.1")).toBe(false);
  });

  it("denies absent, unreadable, old, and unverified Kiro with actionable reasons", () => {
    const absent = evaluateKiroSupport({ binary: null, versionOutput: null });
    expect(absent.supported).toBe(false);
    expect(absent.reasons.join(" ")).toContain("absent");

    const unreadable = evaluateKiroSupport({ binary: "kiro", versionOutput: null });
    expect(unreadable.supported).toBe(false);

    const garbage = evaluateKiroSupport({ binary: "kiro", versionOutput: "hello" });
    expect(garbage.supported).toBe(false);
    expect(garbage.reasons.join(" ")).toContain("unparseable");

    const old = evaluateKiroSupport({ binary: "kiro", versionOutput: "kiro 2.9.0" });
    expect(old.supported).toBe(false);
    expect(old.version).toBe("2.9.0");
    expect(old.reasons.join(" ")).toContain("3.0+");

    const unverified = evaluateKiroSupport({ binary: "kiro", versionOutput: "kiro 3.2.1" });
    expect(unverified.supported).toBe(false);
    expect(unverified.version).toBe("3.2.1");
    expect(unverified.reasons.join(" ")).toContain("C4");

    const verified = evaluateKiroSupport({ binary: "kiro", versionOutput: "kiro 3.2.1" }, ["3.2.1"]);
    expect(verified.supported).toBe(true);
    expect(verified.reasons).toEqual([]);
  });
});

describe("Kiro hook registrations (structure)", () => {
  it("registers SessionStart (IDE) and AgentSpawn (CLI) command hooks", () => {
    const parsed = JSON.parse(buildKiroEntryRegistration("kiro")) as {
      version: string;
      hooks: { name: string; trigger: string; action: { type: string; command: string } }[];
    };
    expect(parsed.version).toBe("v1");
    const triggers = parsed.hooks.map((h) => h.trigger).sort();
    expect(triggers).toEqual(["AgentSpawn", "SessionStart"]);
    for (const hook of parsed.hooks) {
      expect(hook.action.type).toBe("command");
      expect(hook.action.command).toBe(entrySessionCommand("kiro"));
    }
    expect(kiroEntryRegistrationPath("kiro")).toBe(".kiro/hooks/chrono-entry-kiro.json");
  });
});

describe("Kiro gate script behavior (generated bytes for real)", () => {
  let tempDir: string;
  let hookPath: string;

  function runGate(toolName: string, env: Record<string, string>): { status: number | null; stderr: string } {
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
      cwd: tempDir,
      env: fullEnv,
      input: JSON.stringify({ tool_name: toolName, tool_input: {} }),
      encoding: "utf8",
    });
    return { status: result.status, stderr: String(result.stderr ?? "") };
  }

  function gateScript(body: string): string {
    const path = join(tempDir, `gate-${randomBytes(4).toString("hex")}.sh`);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
    chmodSync(path, 0o755);
    return path;
  }

  function fullEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      CHRONO_BIN: gateScript("echo '{\"result\":\"AUTHORIZED\"}'"),
      CHRONO_GATE_MODULE: "MOD-0001",
      CHRONO_SESSION_TOKEN: "SES-0001/abc",
      CHRONO_GATE_AS: "belthazar",
      CHRONO_GATE_ROLE: "belthazar",
      ...extra,
    };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-kiro-gate-test-"));
    mkdirSync(join(tempDir, ".chrono"), { recursive: true });
    writeFileSync(join(tempDir, ".chrono", "chrono.db"), "", "utf8");
    hookPath = join(tempDir, "chrono-kiro-gate.js");
    writeFileSync(hookPath, buildKiroHook(), "utf8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("allows documented read-only tools without dispatch context", () => {
    for (const tool of ["read", "glob", "grep", "fs_read", "code", "introspect", "tool_search"]) {
      expect(runGate(tool, {}).status).toBe(0);
    }
  });

  it("gates documented effectful tools and denies them without context", () => {
    for (const tool of ["write", "shell", "execute_bash", "aws", "web_search", "web_fetch", "delegate", "subagent", "goal", "knowledge", "session", "fs_write"]) {
      const out = runGate(tool, {});
      expect(out.status).toBe(2);
      expect(out.stderr).toContain("without dispatch context");
    }
  });

  it("denies undocumented and wrongly-named tools by default", () => {
    // ls/todowrite are not documented Kiro CLI tools (must not be
    // allow-listed as read-only); webfetch/websearch are not real tool
    // names (documented: web_fetch/web_search); mcp_* awaits
    // classification; thinking is internal-only. None may pass even
    // with full dispatch context.
    for (const tool of ["ls", "todowrite", "webfetch", "websearch", "mcp__future_tool", "thinking"]) {
      const out = runGate(tool, fullEnv());
      expect(out.status).toBe(2);
      expect(out.stderr).toContain("TOOL_DENIED");
    }
  });

  it("gates plausible-but-undocumented effectful names instead of allowing them", () => {
    // task/edit/deploy/package/multiedit are not documented Kiro CLI
    // tools, but a future surface could send them: they gate through
    // the Core (never allow-listed) and deny without dispatch context.
    for (const tool of ["task", "edit", "deploy", "package", "multiedit"]) {
      const ungated = runGate(tool, {});
      expect(ungated.status).toBe(2);
      expect(ungated.stderr).toContain("without dispatch context");
      const gated = runGate(tool, fullEnv());
      expect(gated.status).toBe(0);
    }
  });

  it("obeys live gate verdicts for classified mutable tools", () => {
    const allowed = runGate("shell", fullEnv());
    expect(allowed.status).toBe(0);
    const denyBin = gateScript("echo '{\"result\":\"DENIED\",\"code\":\"EXECUTION_DENIED\",\"reason\":\"nope\"}'; exit 1");
    const denied = runGate("shell", fullEnv({ CHRONO_BIN: denyBin }));
    expect(denied.status).toBe(2);
    expect(denied.stderr).toContain("EXECUTION_DENIED: nope");
  });
});

describe("Entry script fail-loud shape", () => {
  const script = buildEntrySessionScript();

  it("exits nonzero on every in-project failure, zero only with nothing to govern", () => {
    const zeroExits = script.match(/^ {2}exit 0$/gm) ?? [];
    expect(zeroExits).toHaveLength(1);
    expect(script).toContain("no CHRONO project above current directory: entry skipped");
    expect(script).toContain("ENTRY BLOCKED");
    expect((script.match(/exit 3/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(script).not.toContain("proceeds ungoverned");
    expect(script).not.toContain("entry degraded");
    expect(script).not.toContain("degraded sessions");
  });

  it("keeps secrets out of process output and confines the token", () => {
    expect(script).toContain("--secret-stdin");
    expect(script).toContain("chmod 600");
    expect(script).not.toContain("echo $SECRET");
    expect(script).not.toContain('echo "$SECRET"');
    expect(script).toContain("2>/dev/null || true");
  });
});

describe("Kiro workspace skill format (Agent Skills standard)", () => {
  it("emits a Kiro-loadable SKILL.md for the pinned release", () => {
    const kiro = convertSkillSource(FIXTURE_SKILL_MD).kiro;
    const frontmatter = parseSkillFrontmatter(kiro);
    // Folder name must equal frontmatter name (kiro.dev/docs/skills).
    expect(frontmatter.name).toBe("karpathy-guidelines");
    expect(frontmatter.description.length).toBeGreaterThan(0);
    expect(frontmatter.license).toBe("MIT");
  });
});

describe("Kiro init gating and doctor", () => {
  let tempDir: string;
  let binDir: string;

  function kiroBins(versionOutput: string): { kiro: string; versionOutput: string } {
    const kiro = join(binDir, "kiro");
    writeFileSync(kiro, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${versionOutput}'; else exit 1; fi\n`, "utf8");
    chmodSync(kiro, 0o755);
    return { kiro, versionOutput };
  }

  function probesFor(bins: { kiro: string; versionOutput: string }): FlowProbes {
    return {
      execFile: (cmd: string[]) => {
        const [binary, ...args] = cmd as [string, ...string[]];
        const name = binary.split("/").pop() ?? binary;
        if (name === "git") {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (binary === bins.kiro || name === "kiro") {
          if (args[0] === "--version") {
            return { exitCode: 0, stdout: `${bins.versionOutput}\n`, stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `unknown fixture command: ${binary}` };
      },
      fetchSkill: async () => FIXTURE_SKILL_MD,
      readFile: (path: string): string | null => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return null;
        }
      },
      fileExists: (): boolean => false,
      which: (binary: string): string | null => (binary === "kiro" ? bins.kiro : null),
      homedir: () => join(binDir, "home"),
      platform: () => ({ os: "linux", arch: "arm64", node: "v22.0.0" }),
    };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-kiro-init-"));
    binDir = mkdtempSync(join(tmpdir(), "chrono-kiro-bins-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it("blocks init for an unverified Kiro 3.x as an environment blocker", async () => {
    const bins = kiroBins("3.2.1");
    const store = new MemoryKeyStore();
    const out = await runInitFlow(
      tempDir,
      { json: true, yes: true, runtimeIds: ["kiro"] },
      { interactive: true, store },
      probesFor(bins),
      () => null
    );
    expect(out.exitCode).toBe(2);
    const parsed = JSON.parse(out.stdout) as { error: { message: string } };
    expect(parsed.error.message).toContain("Setup blocked");
    expect(parsed.error.message).toContain("C4");
  });

  it("blocks init for a pre-3.0 Kiro with the documented floor", async () => {
    const bins = kiroBins("2.9.0");
    const store = new MemoryKeyStore();
    const out = await runInitFlow(
      tempDir,
      { json: true, yes: true, runtimeIds: ["kiro"] },
      { interactive: true, store },
      probesFor(bins),
      () => null
    );
    expect(out.exitCode).toBe(2);
    const parsed = JSON.parse(out.stdout) as { error: { message: string } };
    expect(parsed.error.message).toContain("3.0+");
  });
});
