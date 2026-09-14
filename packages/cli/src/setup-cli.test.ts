/**
 * Slice 8 CLI tests — adapter setup and the OpenCode pre-tool plugin.
 * Everything hermetic: fixture binaries stand in for the runtime/RTK,
 * and the generated plugin bytes are imported for real and exercised
 * against fixture gate scripts (AUTHORIZED passes, DENIED throws).
 * [RUNTIME §5, PL Phase 5]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import {
  RTK_UPSTREAM,
  SKILL_RELEASE,
  SKILL_RUNTIME_PATHS,
  SKILL_UPSTREAM,
  buildApprovalPayload,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  convertSkillSource,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  hashSkillSource,
  signApprovalPayload,
  skillGeneratedHashes,
  skillVendorPath,
} from "@chrono/domain";
import { ChronoCore } from "@chrono/core";
import { buildOpencodePlugin } from "./opencode-plugin.js";
import { CLAUDE_HOOK_RELATIVE_PATH, CLAUDE_SETTINGS_RELATIVE_PATH, buildClaudeHook } from "./claude-hook.js";
import { KIRO_HOOK_REGISTRATION_RELATIVE_PATH, KIRO_HOOK_RELATIVE_PATH, buildKiroHook, buildKiroHookRegistration } from "./kiro-hook.js";
import { runSetup, runSkillVerify, splitCommandLine } from "./index.js";

// Frozen fixture: byte-exact canonical SKILL.md at the pinned commit.
const CANONICAL_SKILL_MD = `---
name: karpathy-guidelines
description: Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication, make surgical changes, surface assumptions, and define verifiable success criteria.
license: MIT
---

# Karpathy Guidelines

Behavioral guidelines to reduce common LLM coding mistakes, derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
\`\`\`
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
\`\`\`

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
`;

const FIXED_TIME = "2026-06-01T00:00:00.000Z";

type TestSession = { id: string; token: string };

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

function bootstrapSession(core: ChronoCore, role: string, privateKeyPem: string): TestSession {
  if (role !== "gaspar" && role !== "PO") {
    throw new Error("test helper only bootstraps privileged sessions");
  }
  const nonce = randomBytes(16).toString("hex");
  const timestamp = "2026-09-11T00:00:00.000Z";
  const rationale = "test privileged-session bootstrap";
  const signature = signApprovalPayload(
    buildSessionAuthorizationPayload({
      sessionRole: role,
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
  const res = core.openSession(
    { role, adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
    { poAuthorization: { nonce, authority: "PO", rationale, timestamp, signature } }
  );
  expect(res.ok).toBe(true);
  return { id: res.value!.id, token: res.value!.token };
}

function shellScript(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

describe("splitCommandLine", () => {
  it("splits quotes and escapes deterministically", () => {
    expect(splitCommandLine("a b c")).toEqual(["a", "b", "c"]);
    expect(splitCommandLine("a  'b c'  \"d e\"")).toEqual(["a", "b c", "d e"]);
    expect(splitCommandLine("a\\ b c")).toEqual(["a b", "c"]);
    expect(splitCommandLine("")).toEqual([]);
    expect(splitCommandLine("   ")).toEqual([]);
    expect(splitCommandLine("a 'unterminated")).toBeNull();
    expect(splitCommandLine('a "unterminated')).toBeNull();
    expect(splitCommandLine("a\\")).toBeNull();
  });
});

describe("OpenCode plugin bytes", () => {
  it("is deterministic and carries the enforcement contract", () => {
    expect(buildOpencodePlugin()).toBe(buildOpencodePlugin());
    const bytes = buildOpencodePlugin();
    expect(bytes).toContain("tool.execute.before");
    expect(bytes).toContain("CHRONO_GATE_MODULE");
    expect(bytes).toContain("CHRONO_SESSION_TOKEN");
    expect(bytes).toContain("chrono gate");
  });

  it("encodes the full mutate policy and deny-by-default", () => {
    const bytes = buildOpencodePlugin();
    for (const tool of ["bash", "edit", "write", "apply_patch", "webfetch", "websearch"]) {
      expect(bytes).toContain(`"${tool}"`);
    }
    expect(bytes).toContain("TOOL_DENIED");
  });

  it("emits syntactically valid JavaScript (node --check)", () => {
    // Regression guard: template-escaping slips produce generated files
    // that fail to parse at import time. Checked with the running Node.
    for (const [name, bytes] of Object.entries({
      "chrono-gate.js": buildOpencodePlugin(),
      "chrono-claude-gate.js": buildClaudeHook(),
      "chrono-kiro-gate.js": buildKiroHook(),
    })) {
      const probe = join(mkdtempSync(join(tmpdir(), "chrono-syntax-")), name);
      mkdirSync(dirname(probe), { recursive: true });
      writeFileSync(probe, bytes, "utf8");
      const checked = spawnSync(process.execPath, ["--check", probe], { encoding: "utf8" });
      expect(`${name}: ${checked.stderr}`).toBe(`${name}: `);
      expect(checked.status).toBe(0);
      rmSync(dirname(probe), { recursive: true, force: true });
    }
  });
});

describe("OpenCode pre-tool enforcement", () => {
  let tempDir: string;
  let pluginPath: string;
  let gateAllow: string;
  let gateDeny: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-plugin-test-"));
    mkdirSync(join(tempDir, ".chrono"), { recursive: true });
    writeFileSync(join(tempDir, ".chrono", "chrono.db"), "", "utf8");
    pluginPath = join(tempDir, "chrono-gate.js");
    writeFileSync(pluginPath, buildOpencodePlugin(), "utf8");
    gateAllow = shellScript(join(tempDir, "gate-allow.sh"), "echo '{\"result\":\"AUTHORIZED\"}'");
    gateDeny = shellScript(
      join(tempDir, "gate-deny.sh"),
      "echo '{\"result\":\"DENIED\",\"code\":\"EXECUTION_DENIED\",\"reason\":\"nope\"}'; exit 1"
    );
    // Proven-entry fixture: gate tests exercise dispatch policy, not
    // entry, so entry is established before each gate call.
    mkdirSync(join(tempDir, ".chrono", "hooks"), { recursive: true });
    writeFileSync(
      join(tempDir, ".chrono", "hooks", "chrono-entry-session.sh"),
      "#!/bin/sh\necho '{\"ok\":true,\"sessionId\":\"SES-0001\",\"projection\":{\"projectState\":\"ANALYZING\",\"nextAction\":{\"key\":\"k\",\"summary\":\"s\"},\"requiredDecisions\":[]}}'\n",
      "utf8"
    );
    chmodSync(join(tempDir, ".chrono", "hooks", "chrono-entry-session.sh"), 0o755);
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    if (typeof savedEnv !== "undefined") {
      for (const key of ["CHRONO_BIN", "CHRONO_GATE_MODULE", "CHRONO_GATE_WP", "CHRONO_SESSION_TOKEN", "CHRONO_GATE_AS", "CHRONO_GATE_ROLE", "CHRONO_REQUESTER_TOKEN"]) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    }
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function hookFor(directory: string): Promise<{
    before: (input: unknown) => Promise<unknown>;
  }> {
    const module = (await import(pathToFileURL(pluginPath).href)) as {
      ChronoGatePlugin: (ctx: unknown) => Promise<{
        "tool.execute.before": (input: unknown) => Promise<unknown>;
        "experimental.chat.system.transform": (input: unknown, output: { system: unknown[] }) => Promise<unknown>;
      }>;
    };
    const hooks = await module.ChronoGatePlugin({ directory });
    // Prove entry first: these tests exercise dispatch policy, and the
    // plugin denies every tool while entry is unproven (OC-P1).
    await hooks["experimental.chat.system.transform"]({ sessionID: "gate-tests" }, { system: [] });
    return { before: hooks["tool.execute.before"] };
  }

  function fullEnv(extra: Record<string, string> = {}): void {
    process.env["CHRONO_BIN"] = gateAllow;
    process.env["CHRONO_GATE_MODULE"] = "MOD-0001";
    process.env["CHRONO_SESSION_TOKEN"] = "SES-0001/abc";
    process.env["CHRONO_GATE_AS"] = "belthazar";
    process.env["CHRONO_GATE_ROLE"] = "belthazar";
    for (const [key, value] of Object.entries(extra)) {
      process.env[key] = value;
    }
  }

  it("passes outside CHRONO projects and for read-only tools", async () => {
    const plain = mkdtempSync(join(tmpdir(), "chrono-plain-"));
    try {
      const { before } = await hookFor(plain);
      await expect(before({ tool: "bash", command: "echo hi" })).resolves.toBeUndefined();
      await expect(before({ tool: "mcp__future_tool", command: "x" })).resolves.toBeUndefined();
      const { before: gated } = await hookFor(tempDir);
      for (const tool of ["read", "grep", "glob", "skill", "todowrite", "question", "lsp"]) {
        await expect(gated({ tool })).resolves.toBeUndefined();
      }
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("gates every mutable tool through the live verdict", async () => {
    for (const tool of ["bash", "edit", "write", "apply_patch", "webfetch", "websearch"]) {
      fullEnv();
      const { before } = await hookFor(tempDir);
      await expect(before({ tool })).resolves.toBeUndefined();
      process.env["CHRONO_BIN"] = gateDeny;
      const { before: denying } = await hookFor(tempDir);
      await expect(denying({ tool })).rejects.toThrow(/EXECUTION_DENIED: nope/);
    }
  });

  it("denies unknown and future tools deny-by-default inside projects", async () => {
    fullEnv();
    const { before } = await hookFor(tempDir);
    for (const tool of ["mcp__github__create_issue", "future_builtin", "", "BASH"]) {
      await expect(before({ tool })).rejects.toThrow(/TOOL_DENIED/);
    }
  });

  it("denies without dispatch context inside CHRONO projects", async () => {
    const { before } = await hookFor(tempDir);
    await expect(before({ tool: "bash", command: "echo hi" })).rejects.toThrow(/without dispatch context/);
  });

  it("obeys AUTHORIZED and DENIED gate verdicts", async () => {
    fullEnv();
    const { before } = await hookFor(tempDir);
    await expect(before({ tool: "bash", command: "echo hi" })).resolves.toBeUndefined();
    process.env["CHRONO_BIN"] = gateDeny;
    const { before: denying } = await hookFor(tempDir);
    await expect(denying({ tool: "bash", command: "echo hi" })).rejects.toThrow(/EXECUTION_DENIED: nope/);
  });

  it("denies when the gate binary is missing", async () => {
    fullEnv({ CHRONO_BIN: join(tempDir, "missing-gate.sh") });
    const { before } = await hookFor(tempDir);
    await expect(before({ tool: "bash", command: "echo hi" })).rejects.toThrow(/unreachable/);
  });
});

describe("OpenCode automatic Gaspar entry (fail-closed, OC-P1)", () => {
  let tempDir: string;
  let pluginPath: string;
  let savedEnv: Record<string, string | undefined>;

  /** Canned entry payload matching `chrono entry --json` (never a token). */
  function writeEntryScript(body: string): void {
    writeFileSync(join(tempDir, ".chrono", "hooks", "chrono-entry-session.sh"), `#!/bin/sh\n${body}\n`, "utf8");
    chmodSync(join(tempDir, ".chrono", "hooks", "chrono-entry-session.sh"), 0o755);
  }

  function validPayload(): string {
    return JSON.stringify({
      ok: true,
      sessionId: "SES-0001",
      projection: {
        projectState: "ANALYZING",
        nextAction: { key: "resume-discovery", summary: "Resume discovery" },
        requiredDecisions: [],
      },
      skill: { installed: true },
    });
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-entry-test-"));
    mkdirSync(join(tempDir, ".chrono", "hooks"), { recursive: true });
    writeFileSync(join(tempDir, ".chrono", "chrono.db"), "", "utf8");
    pluginPath = join(tempDir, "chrono-gate.js");
    writeFileSync(pluginPath, buildOpencodePlugin(), "utf8");
    writeEntryScript(`echo '${validPayload()}'`);
    savedEnv = { ...process.env };
    delete process.env["CHRONO_BIN"];
    delete process.env["CHRONO_ENTRY_ADAPTER"];
    delete process.env["CHRONO_ENTRY_TIMEOUT_MS"];
    delete process.env["TMPDIR"];
  });

  afterEach(() => {
    for (const key of ["CHRONO_BIN", "CHRONO_ENTRY_ADAPTER", "CHRONO_ENTRY_TIMEOUT_MS", "TMPDIR"]) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function fullHooks(directory: string): Promise<{
    event: (event: unknown) => Promise<unknown>;
    message: (input: unknown) => Promise<unknown>;
    transform: (input: unknown, output: { system: unknown[] }) => Promise<unknown>;
    before: (input: unknown) => Promise<unknown>;
    dispose: () => Promise<unknown>;
  }> {
    const module = (await import(pathToFileURL(pluginPath).href)) as {
      ChronoGatePlugin: (ctx: unknown) => Promise<{
        event: (event: unknown) => Promise<unknown>;
        "chat.message": (input: unknown) => Promise<unknown>;
        "experimental.chat.system.transform": (input: unknown, output: { system: unknown[] }) => Promise<unknown>;
        "tool.execute.before": (input: unknown) => Promise<unknown>;
        dispose: () => Promise<unknown>;
      }>;
    };
    const hooks = await module.ChronoGatePlugin({ directory });
    return {
      event: hooks.event,
      message: hooks["chat.message"],
      transform: hooks["experimental.chat.system.transform"],
      before: hooks["tool.execute.before"],
      dispose: hooks.dispose,
    };
  }

  /** Real @opencode-ai/sdk@1.18.30 session.created shape. */
  function createdEvent(id: string): unknown {
    return { event: { type: "session.created", properties: { info: { id } } } };
  }

  function deletedEvent(id: string): unknown {
    return { event: { type: "session.deleted", properties: { info: { id } } } };
  }

  it("injects the validated entry projection exactly once per session", async () => {
    const { event, transform } = await fullHooks(tempDir);
    await event(createdEvent("s1"));
    const output = { system: [] as unknown[] };
    await transform({ sessionID: "s1" }, output);
    expect(output.system).toHaveLength(1);
    const injected = String(output.system[0]);
    expect(injected).toContain("chrono-gaspar-entry");
    expect(injected).toContain("Gaspar");
    expect(injected).toContain("Product Owner");
    expect(injected).toContain("karpathy-guidelines");
    expect(injected).toContain("SES-0001");
    expect(injected).toContain("resume-discovery");
    // Atomic payload: extract the injected JSON and check completeness.
    const start = injected.indexOf("{");
    const parsed = JSON.parse(injected.slice(start, injected.lastIndexOf("}") + 1)) as {
      sessionId: string;
      projection: { projectState: string };
    };
    expect(parsed.sessionId).toBe("SES-0001");
    expect(parsed.projection.projectState).toBe("ANALYZING");
    // Second transform does not re-inject.
    await transform({ sessionID: "s1" }, output);
    expect(output.system).toHaveLength(1);
  });

  it("establishes entry lazily without a prior session.created event", async () => {
    const { transform } = await fullHooks(tempDir);
    const output = { system: [] as unknown[] };
    await transform({ sessionID: "s-lazy" }, output);
    expect(output.system).toHaveLength(1);
  });

  it("stays silent outside CHRONO projects (tools included)", async () => {
    const plain = mkdtempSync(join(tmpdir(), "chrono-plain-"));
    try {
      const { event, transform, before } = await fullHooks(plain);
      await event(createdEvent("s1"));
      const output = { system: [] as unknown[] };
      await transform({ sessionID: "s1" }, output);
      expect(output.system).toHaveLength(0);
      await expect(before({ tool: "bash" })).resolves.toBeUndefined();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("denies entry when the script is missing (transform and every tool)", async () => {
    rmSync(join(tempDir, ".chrono", "hooks", "chrono-entry-session.sh"));
    const { event, transform, before } = await fullHooks(tempDir);
    await event(createdEvent("s2"));
    const output = { system: [] as unknown[] };
    await expect(transform({ sessionID: "s2" }, output)).rejects.toThrow(/ENTRY_BLOCKED\[ENTRY_SCRIPT_MISSING\]/);
    expect(output.system).toHaveLength(0);
    // Backstop: reads, mutations, and unknown tools all deny while unproven.
    await expect(before({ tool: "read" })).rejects.toThrow(/ENTRY_BLOCKED/);
    await expect(before({ tool: "bash" })).rejects.toThrow(/ENTRY_BLOCKED/);
    await expect(before({ tool: "mcp__x" })).rejects.toThrow(/ENTRY_BLOCKED/);
  });

  it("denies nonzero exits, timeouts, and malformed projections", async () => {
    // Nonzero exit with a stderr note.
    writeEntryScript("echo '[chrono] ENTRY BLOCKED: denied' >&2; exit 3");
    const denied = await fullHooks(tempDir);
    await expect(denied.transform({ sessionID: "s3" }, { system: [] })).rejects.toThrow(
      /ENTRY_BLOCKED\[ENTRY_DENIED\]/
    );
    // Timeout (bounded by the documented env override for tests).
    process.env["CHRONO_ENTRY_TIMEOUT_MS"] = "200";
    writeEntryScript("sleep 5; echo 'too late'");
    const timedOut = await fullHooks(tempDir);
    await expect(timedOut.transform({ sessionID: "s4" }, { system: [] })).rejects.toThrow(
      /ENTRY_BLOCKED\[ENTRY_TIMEOUT\]/
    );
    delete process.env["CHRONO_ENTRY_TIMEOUT_MS"];
    // Malformed variants.
    const malformed: Array<[string, RegExp]> = [
      ["echo 'not json{{{'", /ENTRY_MALFORMED/],
      ["echo '{\"ok\":false,\"error\":{\"code\":\"X\"}}'", /ENTRY_DENIED/],
      ["echo '{\"ok\":true}'", /ENTRY_MALFORMED/],
      ["echo '{\"ok\":true,\"sessionId\":\"nope\",\"projection\":{\"projectState\":\"ANALYZING\",\"nextAction\":{\"key\":\"k\"}}}'", /ENTRY_MALFORMED/],
      ["echo '{\"ok\":true,\"sessionId\":\"SES-1\",\"projection\":{}}'", /ENTRY_MALFORMED/],
    ];
    for (const [body, pattern] of malformed) {
      writeEntryScript(body);
      const hooks = await fullHooks(tempDir);
      await expect(hooks.transform({ sessionID: `s-m-${body.length}` }, { system: [] })).rejects.toThrow(pattern);
    }
  });

  it("rejects oversized projections atomically instead of truncating", async () => {
    const big = `{"ok":true,"sessionId":"SES-1","projection":{"projectState":"ANALYZING","nextAction":{"key":"k"},"pad":"${"x".repeat(70000)}"}}`;
    writeEntryScript(`echo '${big}'`);
    const { transform } = await fullHooks(tempDir);
    const output = { system: [] as unknown[] };
    await expect(transform({ sessionID: "s-big" }, output)).rejects.toThrow(/ENTRY_BLOCKED\[ENTRY_OVERSIZED\]/);
    expect(output.system).toHaveLength(0);
  });

  it("fails when the injection surface is unavailable", async () => {
    const { transform } = await fullHooks(tempDir);
    await expect(transform({ sessionID: "s-nosys" }, {} as { system: unknown[] })).rejects.toThrow(
      /ENTRY_BLOCKED\[ENTRY_INJECTION_UNAVAILABLE\]/
    );
    await expect(
      transform({ sessionID: "s-nosys2" }, { system: "not-an-array" } as unknown as { system: unknown[] })
    ).rejects.toThrow(/ENTRY_BLOCKED\[ENTRY_INJECTION_UNAVAILABLE\]/);
  });

  it("retries within budget, then fails terminally and deterministically", async () => {
    writeEntryScript("exit 3");
    const { transform } = await fullHooks(tempDir);
    const output = { system: [] as unknown[] };
    await expect(transform({ sessionID: "s-r" }, output)).rejects.toThrow(/ENTRY_BLOCKED\[ENTRY_DENIED\]/);
    await expect(transform({ sessionID: "s-r" }, output)).rejects.toThrow(/ENTRY_BLOCKED\[ENTRY_DENIED\]/);
    await expect(transform({ sessionID: "s-r" }, output)).rejects.toThrow(/ENTRY_BLOCKED\[ENTRY_DENIED\]/);
    await expect(transform({ sessionID: "s-r" }, output)).rejects.toThrow(/will not be retried/);
    expect(output.system).toHaveLength(0);
  });

  it("redacts token paths from failure diagnostics", async () => {
    writeEntryScript("echo 'denied for chrono-gaspar-opencode-123.token' >&2; exit 3");
    const { transform } = await fullHooks(tempDir);
    await expect(transform({ sessionID: "s-red" }, { system: [] })).rejects.toThrow(/\[token path redacted\]/);
    try {
      await transform({ sessionID: "s-red" }, { system: [] });
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("chrono-gaspar-opencode-123.token");
    }
  });

  it("sweeps stale token files and drops state on session end", async () => {
    const fakeTmp = mkdtempSync(join(tmpdir(), "chrono-tmp-"));
    process.env["TMPDIR"] = fakeTmp;
    try {
      const stale = join(fakeTmp, "chrono-gaspar-opencode-1.token");
      const fresh = join(fakeTmp, "chrono-gaspar-opencode-2.token");
      const other = join(fakeTmp, "unrelated.txt");
      writeFileSync(stale, "x", "utf8");
      writeFileSync(fresh, "x", "utf8");
      writeFileSync(other, "x", "utf8");
      const old = Date.now() - 7200 * 1000;
      const { utimesSync } = await import("node:fs");
      utimesSync(stale, old / 1000, old / 1000);
      const { event, dispose } = await fullHooks(tempDir);
      await event(createdEvent("s-sweep"));
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(other)).toBe(true);
      await event(deletedEvent("s-sweep"));
      await expect(dispose()).resolves.toBeUndefined();
    } finally {
      rmSync(fakeTmp, { recursive: true, force: true });
    }
  });

  it("ignores non-session events for prefetch but still gates the transform", async () => {
    const { event, transform } = await fullHooks(tempDir);
    await event({ event: { type: "message.updated" } });
    const output = { system: [] as unknown[] };
    await transform({ sessionID: "s9" }, output);
    expect(output.system).toHaveLength(1);
  });

  it("resolves the same project root as the CLI (git boundary)", async () => {
    const git = (dir: string): void => {
      const ran = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
      expect(ran.status).toBe(0);
    };
    const parent = mkdtempSync(join(tmpdir(), "chrono-oc-iso-"));
    try {
      // Unrelated .chrono above a fresh git repo: no adoption, tools
      // pass through silently.
      mkdirSync(join(parent, ".chrono"), { recursive: true });
      writeFileSync(join(parent, ".chrono", "chrono.db"), "", "utf8");
      const repo = join(parent, "repo");
      mkdirSync(repo, { recursive: true });
      git(repo);
      const { before } = await fullHooks(repo);
      await expect(before({ tool: "read" })).resolves.toBeUndefined();
      // Own .chrono at the git root: adopted, entry mandatory.
      mkdirSync(join(repo, ".chrono"), { recursive: true });
      writeFileSync(join(repo, ".chrono", "chrono.db"), "", "utf8");
      const adopted = await fullHooks(repo);
      await expect(adopted.before({ tool: "read" })).rejects.toThrow(/ENTRY_BLOCKED/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("CLI setup", () => {
  let tempDir: string;
  let restoreTty: () => void;
  let gaspar: { actor: string; session: TestSession };
  let po: { actor: string; session: TestSession };
  let entrypoint: string;
  let rtkBinary: string;
  let proofBinary: string;

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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-setup-test-"));
    const core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    try {
      expect(core.init().ok).toBe(true);
      const pair = generateApprovalKeyPair();
      restoreTty = fakeInteractiveTerminal();
      enrollTestPo(core, pair);
      gaspar = { actor: "gaspar", session: bootstrapSession(core, "gaspar", pair.privateKeyPem) };
      po = { actor: "PO", session: bootstrapSession(core, "PO", pair.privateKeyPem) };
      entrypoint = shellScript(join(tempDir, "fixture-runtime.sh"), "echo 'fixture-runtime 1.0.0'");
      rtkBinary = shellScript(
        join(tempDir, "fixture-rtk.sh"),
        "if [ \"$1\" = \"gain\" ]; then echo 'Token Killer savings dashboard'; else echo 'rtk 0.44.0'; fi"
      );
      proofBinary = shellScript(join(tempDir, "fixture-proof.sh"), "echo proven");
      expect(
        core.recordRtkAttestation(gaspar, {
          binaryPath: rtkBinary,
          binaryIdentity: "rtk-test",
          version: "1.0.0-test",
          provenance: RTK_UPSTREAM,
          integrationMode: "test",
          routingTestPassed: true,
          routingTestLog: "fixture",
          gained: true,
          savingsEvidence: null,
          ttlSeconds: 86400,
        }).ok
      ).toBe(true);
      expect(
        core.recordSkillAttestation(gaspar, {
          upstream: SKILL_UPSTREAM,
          pinnedCommit: SKILL_RELEASE.pinnedCommit,
          sourceHash: SKILL_RELEASE.sourceHash,
          generatedHashes: skillGeneratedHashes(convertSkillSource(CANONICAL_SKILL_MD)),
          converterVersion: SKILL_RELEASE.converterVersion,
          licenseStatus: "MIT",
          attribution: "MIT",
          runtimeIdentity: "test",
          agentIdentity: "test",
          discoveryResult: "found",
          permissionResult: "granted",
          activationTestPassed: true,
          ttlSeconds: 86400,
        }).ok
      ).toBe(true);
      expect(hashSkillSource(CANONICAL_SKILL_MD)).toBe(SKILL_RELEASE.sourceHash);
      const vendorTarget = join(tempDir, skillVendorPath(SKILL_RELEASE.pinnedCommit));
      mkdirSync(dirname(vendorTarget), { recursive: true });
      writeFileSync(vendorTarget, CANONICAL_SKILL_MD, "utf8");
      for (const runtime of ["claude", "opencode", "kiro"] as const) {
        const target = join(tempDir, SKILL_RUNTIME_PATHS[runtime]);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, CANONICAL_SKILL_MD, "utf8");
      }
      expect(
        core.registerAdapter(
          { id: "fixture", name: "Fixture", entrypoint, conformanceProof: [`${proofBinary} --check`] },
          po
        ).ok
      ).toBe(true);
      const revision = core.adapterRegistrationHash("fixture");
      const signature = signApprovalPayload(
        buildApprovalPayload({
          action: "adapter-registration",
          scopeArtifactId: "fixture",
          scopeRevision: revision,
          authority: "PO",
          rationale: "trust",
          timestamp: FIXED_TIME,
        }),
        pair.privateKeyPem
      );
      const recorded = core.recordApproval({
        action: "adapter-registration",
        scopeArtifactId: "fixture",
        scopeRevision: revision,
        authority: "PO",
        rationale: "trust",
        timestamp: FIXED_TIME,
        signature,
      });
      expect(recorded.ok).toBe(true);
      expect(core.approveAdapter("fixture", recorded.value!.id, po).ok).toBe(true);
    } finally {
      core.close();
    }
  });

  afterEach(() => {
    if (typeof restoreTty !== "undefined") {
      restoreTty();
    }
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("completes setup and installs the byte-identical plugin", async () => {
    const out = runSetup(tempDir, { adapter: "fixture", rtkBinary, json: true });
    expect(out.exitCode).toBe(0);
    const body = JSON.parse(out.stdout) as { ok: boolean; proofsRun: number; plugin: string; routingProven: boolean; hooks: string[] };
    expect(body).toMatchObject({ ok: true, proofsRun: 1, plugin: ".opencode/plugins/chrono-gate.js", routingProven: true });
    expect(readFileSync(join(tempDir, ".opencode", "plugins", "chrono-gate.js"), "utf8")).toBe(buildOpencodePlugin());
  });

  it("installs byte-identical Claude and Kiro hooks alongside OpenCode", async () => {
    const out = runSetup(tempDir, { adapter: "fixture", rtkBinary, json: true });
    expect(out.exitCode).toBe(0);
    const body = JSON.parse(out.stdout) as { hooks: string[] };
    expect(body.hooks).toContain(CLAUDE_HOOK_RELATIVE_PATH);
    expect(body.hooks).toContain(KIRO_HOOK_RELATIVE_PATH);
    expect(body.hooks).toContain(KIRO_HOOK_REGISTRATION_RELATIVE_PATH);
    expect(body.hooks).toContain(CLAUDE_SETTINGS_RELATIVE_PATH);
    expect(readFileSync(join(tempDir, CLAUDE_HOOK_RELATIVE_PATH), "utf8")).toBe(buildClaudeHook());
    expect(readFileSync(join(tempDir, KIRO_HOOK_RELATIVE_PATH), "utf8")).toBe(buildKiroHook());
    expect(readFileSync(join(tempDir, KIRO_HOOK_REGISTRATION_RELATIVE_PATH), "utf8")).toBe(buildKiroHookRegistration());
    // Kiro registration is a valid hook file that always matches PreToolUse.
    const registration = JSON.parse(readFileSync(join(tempDir, KIRO_HOOK_REGISTRATION_RELATIVE_PATH), "utf8")) as {
      version: string;
      hooks: { trigger: string; action: { command: string } }[];
    };
    expect(registration.version).toBe("v1");
    expect(registration.hooks[0]).toMatchObject({ trigger: "PreToolUse" });
    expect(registration.hooks[0]!.action.command).toBe("node .chrono/hooks/chrono-kiro-gate.js");
    // Claude settings registration survives a second run (idempotent).
    const once = readFileSync(join(tempDir, CLAUDE_SETTINGS_RELATIVE_PATH), "utf8");
    expect(runSetup(tempDir, { adapter: "fixture", rtkBinary, json: true }).exitCode).toBe(0);
    expect(readFileSync(join(tempDir, CLAUDE_SETTINGS_RELATIVE_PATH), "utf8")).toBe(once);
  });

  it("merges Claude settings without losing unrelated user configuration", async () => {
    const settingsPath = join(tempDir, CLAUDE_SETTINGS_RELATIVE_PATH);
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark", hooks: { PostToolUse: [] } }, null, 2), "utf8");
    expect(runSetup(tempDir, { adapter: "fixture", rtkBinary, json: true }).exitCode).toBe(0);
    const merged = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      theme: string;
      hooks: { PostToolUse: unknown[]; PreToolUse: { hooks: { command: string }[] }[] };
    };
    expect(merged.theme).toBe("dark");
    expect(merged.hooks.PostToolUse).toEqual([]);
    expect(merged.hooks.PreToolUse[0]!.hooks[0]!.command).toBe("node .chrono/hooks/chrono-claude-gate.js");
    expect(readFileSync(`${settingsPath}.chrono-bak`, "utf8")).toContain('"theme": "dark"');
  });

  it("refuses to overwrite malformed Claude settings", async () => {
    const settingsPath = join(tempDir, CLAUDE_SETTINGS_RELATIVE_PATH);
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, "{not json", "utf8");
    const out = runSetup(tempDir, { adapter: "fixture", rtkBinary, json: true });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("settings.json");
    expect(readFileSync(settingsPath, "utf8")).toBe("{not json");
  });

  it("does not duplicate the hook when nested inside unknown structure", async () => {
    const settingsPath = join(tempDir, CLAUDE_SETTINGS_RELATIVE_PATH);
    mkdirSync(dirname(settingsPath), { recursive: true });
    const nested = {
      hooks: { PreToolUse: [{ matcher: "*", wrapper: { hooks: [{ type: "command", command: "node .chrono/hooks/chrono-claude-gate.js" }] } }] },
    };
    writeFileSync(settingsPath, JSON.stringify(nested, null, 2), "utf8");
    expect(runSetup(tempDir, { adapter: "fixture", rtkBinary, json: true }).exitCode).toBe(0);
    const merged = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: { PreToolUse: unknown[] };
    };
    expect(merged.hooks.PreToolUse).toHaveLength(1);
  });

  it("fails closed on every missing proof", async () => {
    expect(runSetup(tempDir, { adapter: "ghost", rtkBinary, json: true }).exitCode).toBe(1);
    const badRtk = runSetup(tempDir, { adapter: "fixture", rtkBinary: join(tempDir, "missing.sh"), json: true });
    expect(badRtk.exitCode).toBe(1);
    expect(badRtk.stdout).toContain("BLOCKED_RTK");
  });

  it("skill verify feeds setup: fresh verify makes setup pass", async () => {
    // A project verified through the real pipeline satisfies setup.
    const verified = await runSkillVerify(
      tempDir,
      { as: "gaspar", session: gaspar.session, json: true },
      async () => CANONICAL_SKILL_MD
    );
    expect(verified.exitCode).toBe(0);
    expect(runSetup(tempDir, { adapter: "fixture", rtkBinary, json: true }).exitCode).toBe(0);
  });
});
