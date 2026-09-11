/**
 * Slice 8 CLI tests — adapter setup and the OpenCode pre-tool plugin.
 * Everything hermetic: fixture binaries stand in for the runtime/RTK,
 * and the generated plugin bytes are imported for real and exercised
 * against fixture gate scripts (AUTHORIZED passes, DENIED throws).
 * [RUNTIME §5, PL Phase 5]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
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
import { CLAUDE_HOOK_RELATIVE_PATH, buildClaudeHook } from "./claude-hook.js";
import { KIRO_HOOK_RELATIVE_PATH, buildKiroHook } from "./kiro-hook.js";
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

  async function hookFor(directory: string): Promise<{
    before: (input: unknown) => Promise<unknown>;
  }> {
    const module = (await import(pathToFileURL(pluginPath).href)) as {
      ChronoGatePlugin: (ctx: unknown) => Promise<{ "tool.execute.before": (input: unknown) => Promise<unknown> }>;
    };
    const hooks = await module.ChronoGatePlugin({ directory });
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
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
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
    expect(readFileSync(join(tempDir, CLAUDE_HOOK_RELATIVE_PATH), "utf8")).toBe(buildClaudeHook());
    expect(readFileSync(join(tempDir, KIRO_HOOK_RELATIVE_PATH), "utf8")).toBe(buildKiroHook());
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
