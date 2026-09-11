/**
 * Slice 7 CLI tests — skill verification against the PO-approved pin.
 * Network is always injected (hermetic tests); the fetch below returns
 * the frozen canonical bytes, whose hash equals the release pin.
 * [CORE §11, PL Phase 4]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  SKILL_RELEASE,
  SKILL_RUNTIME_PATHS,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  convertSkillSource,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  signApprovalPayload,
  skillGeneratedHashes,
  skillVendorPath,
} from "@chrono/domain";
import { ChronoCore } from "@chrono/core";
import { runSkillVerify } from "./index.js";

// Frozen fixture: byte-exact canonical SKILL.md at the pinned commit
// (verified: hashSkillSource === SKILL_RELEASE.sourceHash).
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

function bootstrapSession(
  core: ChronoCore,
  role: string,
  privateKeyPem: string,
  scopeModule?: string
): TestSession {
  if (role !== "gaspar" && role !== "PO") {
    const res = core.openSession(
      {
        role,
        adapter: "test-adapter",
        runtime: "test-runtime",
        ...(scopeModule !== undefined ? { scopeModule } : {}),
        ttlSeconds: 3600,
      },
      { interactive: true }
    );
    expect(res.ok).toBe(true);
    return { id: res.value!.id, token: res.value!.token };
  }
  const nonce = randomBytes(16).toString("hex");
  const timestamp = "2026-09-11T00:00:00.000Z";
  const rationale = "test privileged-session bootstrap";
  const signature = signApprovalPayload(
    buildSessionAuthorizationPayload({
      sessionRole: role,
      adapter: "test-adapter",
      runtime: "test-runtime",
      scopeModule: scopeModule ?? null,
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
    {
      role,
      adapter: "test-adapter",
      runtime: "test-runtime",
      ...(scopeModule !== undefined ? { scopeModule } : {}),
      ttlSeconds: 3600,
    },
    { poAuthorization: { nonce, authority: "PO", rationale, timestamp, signature } }
  );
  expect(res.ok).toBe(true);
  return { id: res.value!.id, token: res.value!.token };
}

const okFetch = async (): Promise<string> => CANONICAL_SKILL_MD;

describe("CLI skill verify", () => {
  let tempDir: string;
  let restoreTty: () => void;
  let gaspar: { actor: string; session: TestSession };

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
    tempDir = mkdtempSync(join(tmpdir(), "chrono-skill-cli-test-"));
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      expect(core.init().ok).toBe(true);
      const pair = generateApprovalKeyPair();
      restoreTty = fakeInteractiveTerminal();
      enrollTestPo(core, pair);
      gaspar = { actor: "gaspar", session: bootstrapSession(core, "gaspar", pair.privateKeyPem) };
    } finally {
      core.close();
    }
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function emittedPaths(): string[] {
    return [
      join(tempDir, skillVendorPath(SKILL_RELEASE.pinnedCommit)),
      join(tempDir, SKILL_RUNTIME_PATHS.claude),
      join(tempDir, SKILL_RUNTIME_PATHS.opencode),
      join(tempDir, SKILL_RUNTIME_PATHS.kiro),
    ];
  }

  it("verifies, emits byte-identical artifacts, and records the attestation", async () => {
    const out = await runSkillVerify(tempDir, { as: "gaspar", session: gaspar.session, json: true }, okFetch);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain(SKILL_RELEASE.pinnedCommit);
    for (const path of emittedPaths()) {
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(CANONICAL_SKILL_MD);
    }
    const check = new ChronoCore({ projectPath: tempDir });
    try {
      expect(check.attestationCurrency("skill")).toMatchObject({ state: "current" });
      const latest = check.describeSkillAttestation();
      expect(latest).toMatchObject({
        upstream: SKILL_RELEASE.upstream,
        pinnedCommit: SKILL_RELEASE.pinnedCommit,
        sourceHash: SKILL_RELEASE.sourceHash,
        generatedHashes: skillGeneratedHashes(convertSkillSource(CANONICAL_SKILL_MD)),
        converterVersion: SKILL_RELEASE.converterVersion,
      });
      expect(check.validate().value?.valid).toBe(true);
    } finally {
      check.close();
    }
  });

  it("refuses tampered sources and emits nothing", async () => {
    const out = await runSkillVerify(
      tempDir,
      { as: "gaspar", session: gaspar.session, json: true },
      async () => `${CANONICAL_SKILL_MD}\nrogue line`
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("SKILL_PROVENANCE_FAILURE");
    for (const path of emittedPaths()) {
      expect(existsSync(path)).toBe(false);
    }
    const check = new ChronoCore({ projectPath: tempDir });
    try {
      expect(check.attestationCurrency("skill")).toMatchObject({ state: "missing" });
    } finally {
      check.close();
    }
  });

  it("fails closed when the fetch fails", async () => {
    const out = await runSkillVerify(
      tempDir,
      { as: "gaspar", session: gaspar.session, json: true },
      async () => {
        throw new Error("network down");
      }
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("BLOCKED_PROCESS_SKILL");
  });

  it("requires an explicit matching caller session", async () => {
    expect((await runSkillVerify(tempDir, { session: gaspar.session }, okFetch)).exitCode).toBe(2);
    expect((await runSkillVerify(tempDir, { as: "gaspar" }, okFetch)).exitCode).toBe(2);
  });

  it("refuses to record over a divergent stored attestation", async () => {
    const setup = new ChronoCore({ projectPath: tempDir });
    try {
      const recorded = setup.recordSkillAttestation(gaspar, {
        upstream: SKILL_RELEASE.upstream,
        pinnedCommit: SKILL_RELEASE.pinnedCommit,
        sourceHash: SKILL_RELEASE.sourceHash,
        generatedHashes: '{"claude":"sha256:0"}',
        converterVersion: SKILL_RELEASE.converterVersion,
        licenseStatus: "MIT",
        attribution: "test",
        runtimeIdentity: null,
        agentIdentity: "test",
        discoveryResult: "found",
        permissionResult: "granted",
        activationTestPassed: true,
        ttlSeconds: 86400,
      });
      expect(recorded.ok).toBe(true);
    } finally {
      setup.close();
    }
    const out = await runSkillVerify(tempDir, { as: "gaspar", session: gaspar.session, json: true }, okFetch);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("SKILL_PROVENANCE_FAILURE");
  });

  it("denies worker sessions", async () => {
    const setup = new ChronoCore({ projectPath: tempDir });
    let worker: TestSession;
    try {
      worker = bootstrapSession(setup, "belthazar", "", "default");
    } finally {
      setup.close();
    }
    const out = await runSkillVerify(tempDir, { as: "belthazar", session: worker, json: true }, okFetch);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("EXECUTION_DENIED");
  });
});
