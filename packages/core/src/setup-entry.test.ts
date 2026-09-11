/**
 * Slice 10 Core tests — setup state machine, pinned Core version, broker
 * credentials, and Gaspar entry projection [SLICE-10 §§2, 3, 5].
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  BROKER_SESSION_TTL_SECONDS,
  GASPAR_ENTRY_ACTIONS,
  RTK_UPSTREAM,
  SKILL_RELEASE,
  SKILL_RUNTIME_PATHS,
  SKILL_UPSTREAM,
  buildApprovalPayload,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  computeRevisionHash,
  convertSkillSource,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  hashSkillSource,
  signApprovalPayload,
  skillGeneratedHashes,
  skillVendorPath,
} from "@chrono/domain";
import { ChronoCore, type CallerAuth } from "./chrono-core.js";

const T0 = "2026-09-11T00:00:00.000Z";

const FIXTURE_SKILL_MD = `---
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

function enrollTestPo(core: ChronoCore, pair: { publicKeyPem: string; privateKeyPem: string }): void {
  const nonce = randomBytes(16).toString("hex");
  const fingerprint = fingerprintPublicKey(pair.publicKeyPem);
  const timestamp = T0;
  const confirmation = buildEnrollmentChallenge("default", fingerprint, nonce);
  const signature = signApprovalPayload(
    buildEnrollmentPayload({
      projectId: "default",
      fingerprint,
      timestamp,
      nonce,
      authority: "PO",
      rationale: "test enrollment",
      confirmation,
    }),
    pair.privateKeyPem
  );
  const res = core.enrollPo({
    publicKeyPem: pair.publicKeyPem,
    nonce,
    timestamp,
    rationale: "test enrollment",
    confirmation,
    signature,
  });
  expect(res.ok).toBe(true);
}

function bootstrapSession(core: ChronoCore, role: "gaspar" | "PO", privateKeyPem: string): { id: string; token: string } {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = "2026-09-11T00:00:00.000Z";
  const signature = signApprovalPayload(
    buildSessionAuthorizationPayload({
      sessionRole: role,
      adapter: "opencode",
      runtime: "test-runtime",
      scopeModule: null,
      scopeWp: null,
      ttlSeconds: 3600,
      nonce,
      authority: "PO",
      rationale: "test bootstrap",
      timestamp,
    }),
    privateKeyPem
  );
  const res = core.openSession(
    { role, adapter: "opencode", runtime: "test-runtime", ttlSeconds: 3600 },
    { poAuthorization: { nonce, authority: "PO", rationale: "test bootstrap", timestamp, signature } }
  );
  expect(res.ok).toBe(true);
  return { id: res.value!.id, token: res.value!.token };
}

function approveAdapter(core: ChronoCore, id: string, entrypoint: string, po: CallerAuth, privateKeyPem: string): void {
  expect(
    core.registerAdapter({ id, name: id, entrypoint, conformanceProof: [`${entrypoint} --version`] }, po).ok
  ).toBe(true);
  const revision = core.adapterRegistrationHash(id);
  const timestamp = "2026-06-01T00:00:00.000Z";
  const signature = signApprovalPayload(
    buildApprovalPayload({
      action: "adapter-registration",
      scopeArtifactId: id,
      scopeRevision: revision,
      authority: "PO",
      rationale: "test approval",
      timestamp,
    }),
    privateKeyPem
  );
  const recorded = core.recordApproval({
    action: "adapter-registration",
    scopeArtifactId: id,
    scopeRevision: revision,
    authority: "PO",
    rationale: "test approval",
    timestamp,
    signature,
  });
  expect(recorded.ok).toBe(true);
  expect(core.approveAdapter(id, recorded.value!.id, po).ok).toBe(true);
}

function recordRtkAndSkill(core: ChronoCore, gaspar: CallerAuth, projectPath: string): void {
  const rtkBin = join(projectPath, "fixture-rtk.sh");
  writeFileSync(rtkBin, "#!/bin/sh\necho fixture-rtk 1.0.0-test\n", "utf8");
  chmodSync(rtkBin, 0o755);
  expect(
    core.recordRtkAttestation(gaspar, {
      binaryPath: rtkBin,
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
      generatedHashes: skillGeneratedHashes(convertSkillSource(FIXTURE_SKILL_MD)),
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
  expect(hashSkillSource(FIXTURE_SKILL_MD)).toBe(SKILL_RELEASE.sourceHash);
  const vendorTarget = join(projectPath, skillVendorPath(SKILL_RELEASE.pinnedCommit));
  mkdirSync(dirname(vendorTarget), { recursive: true });
  writeFileSync(vendorTarget, FIXTURE_SKILL_MD, "utf8");
  for (const runtime of ["claude", "opencode", "kiro"] as const) {
    const target = join(projectPath, SKILL_RUNTIME_PATHS[runtime]);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, FIXTURE_SKILL_MD, "utf8");
  }
}

function recordProof(core: ChronoCore, submitter: CallerAuth, projectPath: string, adapterId: string): void {
  const rtkBin = join(projectPath, "fixture-rtk.sh");
  expect(
    core.recordRoutingProof(submitter, {
      adapterId,
      binaryPath: rtkBin,
      version: "1.0.0-test",
      proofCommand: JSON.stringify([rtkBin, "gain"]),
      commandHash: computeRevisionHash([rtkBin, "gain"]),
      outputHash: computeRevisionHash("fixture gain ok"),
      exitStatus: 0,
      gainAvailable: true,
      timestamp: T0,
      ttlSeconds: 86400,
    }).ok
  ).toBe(true);
}

function advanceTo(core: ChronoCore, step: "ADAPTERS_REGISTERED_AND_APPROVED"): void {
  const chain = [
    "DETECTED",
    "CONSENTED",
    "PROJECT_INITIALIZED",
    "PO_ENROLLED",
    "RUNTIMES_SELECTED",
    "RTK_VERIFIED_AND_ROUTED",
    "SKILL_VERIFIED_AND_EMITTED",
    "ADAPTERS_REGISTERED_AND_APPROVED",
  ] as const;
  for (const s of chain) {
    const res = core.advanceSetupState(s, { note: "test" });
    expect(res.ok).toBe(true);
    if (s === step) {
      return;
    }
  }
}

describe("Setup state machine", () => {
  let tempDir: string;
  let core: ChronoCore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-setup-state-test-"));
    core = new ChronoCore({ projectPath: tempDir, clock: () => T0 });
    expect(core.init().ok).toBe(true);
  });

  afterEach(() => {
    if (typeof core !== "undefined") {
      core.close();
    }
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("starts empty and advances forward through the full chain", () => {
    expect(core.getSetupState().value).toBe(null);
    const chain = [
      "DETECTED",
      "CONSENTED",
      "PROJECT_INITIALIZED",
      "PO_ENROLLED",
      "RUNTIMES_SELECTED",
      "RTK_VERIFIED_AND_ROUTED",
      "SKILL_VERIFIED_AND_EMITTED",
      "ADAPTERS_REGISTERED_AND_APPROVED",
      "NATIVE_HOOKS_INSTALLED",
      "RUNTIME_CONFORMANCE_PASSED",
      "GASPAR_ENTRY_PREPARED",
      "READY",
    ] as const;
    for (const step of chain) {
      const res = core.advanceSetupState(step, { step });
      expect(res.ok).toBe(true);
      expect(res.value?.step).toBe(step);
    }
    expect(core.getSetupState().value?.step).toBe("READY");
  });

  it("denies skip-ahead and unknown steps, allows same-step re-entry", () => {
    expect(core.advanceSetupState("DETECTED", {}).ok).toBe(true);
    const skip = core.advanceSetupState("READY", {});
    expect(skip.ok).toBe(false);
    expect(skip.error?.code).toBe("ILLEGAL_TRANSITION");
    expect(core.advanceSetupState("DETECTED", { retry: 1 }).ok).toBe(true);
    const unknown = core.advanceSetupState("TELEPORT" as never, {});
    expect(unknown.ok).toBe(false);
    expect(unknown.error?.code).toBe("ILLEGAL_TRANSITION");
  });

  it("denies secret-bearing detail at any depth", () => {
    expect(core.advanceSetupState("DETECTED", {}).ok).toBe(true);
    for (const detail of [
      { token: "abc" },
      { nested: { apiSecret: "x" } },
      { list: [{ privateKey: "y" }] },
      { credential: "z" },
    ]) {
      const res = core.advanceSetupState("CONSENTED", detail);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("SECRET_DETECTED");
    }
    expect(core.getSetupState().value?.step).toBe("DETECTED");
  });
});

describe("Pinned Core version", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-pin-test-"));
  });

  afterEach(() => {
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("stamps on first touch and accepts the same pin", () => {
    const first = new ChronoCore({ projectPath: tempDir, pinnedVersion: "0.1.0" });
    try {
      expect(first.init().ok).toBe(true);
    } finally {
      first.close();
    }
    const second = new ChronoCore({ projectPath: tempDir, pinnedVersion: "0.1.0" });
    try {
      expect(second.status().ok).toBe(true);
    } finally {
      second.close();
    }
  });

  it("denies a different pin without substituting cores", () => {
    const first = new ChronoCore({ projectPath: tempDir, pinnedVersion: "0.1.0" });
    first.close();
    expect(() => new ChronoCore({ projectPath: tempDir, pinnedVersion: "0.2.0" })).toThrow(/pins Core 0\.1\.0/);
  });

  it("denies malformed pins and leaves no half-open handle", () => {
    expect(() => new ChronoCore({ projectPath: tempDir, pinnedVersion: "latest" })).toThrow(/malformed/);
    const reopened = new ChronoCore({ projectPath: tempDir, pinnedVersion: "0.1.0" });
    try {
      expect(reopened.init().ok).toBe(true);
      expect(reopened.status().ok).toBe(true);
    } finally {
      reopened.close();
    }
  });
});

describe("Broker credentials and Gaspar entry", () => {
  let tempDir: string;
  let core: ChronoCore;
  let restoreTty: () => void;
  let gaspar: CallerAuth;
  let po: CallerAuth;
  let entrypoint: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-broker-test-"));
    core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime", clock: () => T0 });
    expect(core.init().ok).toBe(true);
    const pair = generateApprovalKeyPair();
    restoreTty = fakeInteractiveTerminal();
    enrollTestPo(core, pair);
    gaspar = { actor: "gaspar", session: bootstrapSession(core, "gaspar", pair.privateKeyPem) };
    po = { actor: "PO", session: bootstrapSession(core, "PO", pair.privateKeyPem) };
    entrypoint = join(tempDir, "fixture-runtime.sh");
    writeFileSync(entrypoint, "#!/bin/sh\necho fixture-ok\n", "utf8");
    chmodSync(entrypoint, 0o755);
    approveAdapter(core, "opencode", entrypoint, po, pair.privateKeyPem);
    recordRtkAndSkill(core, gaspar, tempDir);
    advanceTo(core, "ADAPTERS_REGISTERED_AND_APPROVED");
    recordProof(core, gaspar, tempDir, "opencode");
  });

  afterEach(() => {
    if (typeof restoreTty !== "undefined") {
      restoreTty();
    }
    if (typeof core !== "undefined") {
      core.close();
    }
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("issues once, redeems a bounded session, and distinguishes sessions", () => {
    const issued = core.issueBrokerCredential(gaspar);
    expect(issued.ok).toBe(true);
    expect(issued.value?.id).toMatch(/^BRK-\d{4}$/);
    expect(issued.value?.secret).toMatch(/^[0-9a-f]{64}$/);
    const first = core.redeemBrokerCredential({
      brokerId: issued.value!.id,
      secret: issued.value!.secret,
      adapterId: "opencode",
      runtime: "test-runtime",
    });
    expect(first.ok).toBe(true);
    expect(first.value?.session.id).toMatch(/^SES-\d{4}$/);
    expect(first.value?.session.token).toMatch(/^[0-9a-f]{64}$/);
    const ttlMs =
      Date.parse(first.value!.session.expiresAt) - Date.parse(T0);
    expect(ttlMs).toBe(BROKER_SESSION_TTL_SECONDS * 1000);
    const second = core.redeemBrokerCredential({
      brokerId: issued.value!.id,
      secret: issued.value!.secret,
      adapterId: "opencode",
      runtime: "test-runtime",
    });
    expect(second.ok).toBe(true);
    expect(second.value?.session.id).not.toBe(first.value?.session.id);
    // The minted session is a live gaspar session: projection refresh works.
    const projection = core.gasparEntryProjection({ actor: "gaspar", session: second.value!.session });
    expect(projection.ok).toBe(true);
    expect(projection.value?.projectState).toBe("ANALYZING");
    expect(projection.value?.nextAction.key).toBe("resume-discovery");
  });

    it("denies unknown, wrong-secret, and revoked credentials without oracle detail", () => {
    const issued = core.issueBrokerCredential(gaspar);
    expect(issued.ok).toBe(true);
    const unknown = core.redeemBrokerCredential({
      brokerId: "BRK-9999",
      secret: issued.value!.secret,
      adapterId: "opencode",
      runtime: "test-runtime",
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.error?.code).toBe("EXECUTION_DENIED");
    const wrong = core.redeemBrokerCredential({
      brokerId: issued.value!.id,
      secret: "0".repeat(64),
      adapterId: "opencode",
      runtime: "test-runtime",
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.error?.code).toBe("EXECUTION_DENIED");
    expect(wrong.error?.message).toBe(unknown.error?.message);
    expect(core.revokeBrokerCredential(issued.value!.id, gaspar).ok).toBe(true);
    const revoked = core.redeemBrokerCredential({
      brokerId: issued.value!.id,
      secret: issued.value!.secret,
      adapterId: "opencode",
      runtime: "test-runtime",
    });
    expect(revoked.ok).toBe(false);
    expect(revoked.error?.code).toBe("EXECUTION_DENIED");
    expect(revoked.error?.message).toContain("revoked");
  });

  it("keeps a single active broker credential per project", () => {
    const first = core.issueBrokerCredential(gaspar);
    expect(first.ok).toBe(true);
    const second = core.issueBrokerCredential(gaspar);
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe("DUPLICATE_IDENTITY");
    expect(core.revokeBrokerCredential(first.value!.id, gaspar).ok).toBe(true);
    const third = core.issueBrokerCredential(gaspar);
    expect(third.ok).toBe(true);
    expect(third.value?.id).not.toBe(first.value?.id);
    const listed = core.listBrokerCredentials(gaspar);
    expect(listed.ok).toBe(true);
    expect(listed.value?.filter((c) => !c.revoked)).toHaveLength(1);
  });

  it("denies entry for unapproved adapters and unprepared setup", () => {
    const issued = core.issueBrokerCredential(gaspar);
    expect(issued.ok).toBe(true);
    const unapproved = core.redeemBrokerCredential({
      brokerId: issued.value!.id,
      secret: issued.value!.secret,
      adapterId: "ghost",
      runtime: "test-runtime",
    });
    expect(unapproved.ok).toBe(false);
    // Fresh project without setup progress: entry denied even with valid credential material.
    const freshDir = mkdtempSync(join(tmpdir(), "chrono-broker-fresh-"));
    try {
      const fresh = new ChronoCore({ projectPath: freshDir, runtime: "test-runtime", clock: () => T0 });
      try {
        expect(fresh.init().ok).toBe(true);
        const pair = generateApprovalKeyPair();
        const restore = fakeInteractiveTerminal();
        try {
          enrollTestPo(fresh, pair);
        } finally {
          restore();
        }
        const freshGaspar = { actor: "gaspar", session: bootstrapSession(fresh, "gaspar", pair.privateKeyPem) };
        const freshPo = { actor: "PO", session: bootstrapSession(fresh, "PO", pair.privateKeyPem) };
        approveAdapter(fresh, "opencode", entrypoint, freshPo, pair.privateKeyPem);
        recordRtkAndSkill(fresh, freshGaspar, freshDir);
        recordProof(fresh, freshGaspar, freshDir, "opencode");
        const freshBroker = fresh.issueBrokerCredential(freshGaspar);
        expect(freshBroker.ok).toBe(true);
        // No setup state advanced: readiness floor denies.
        const denied = fresh.redeemBrokerCredential({
          brokerId: freshBroker.value!.id,
          secret: freshBroker.value!.secret,
          adapterId: "opencode",
          runtime: "test-runtime",
        });
        expect(denied.ok).toBe(false);
        expect(denied.error?.code).toBe("EXECUTION_DENIED");
        expect(denied.error?.message ?? "").toContain("setup");
      } finally {
        fresh.close();
      }
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("denies projection to worker sessions and duplicate broker ids", () => {
    const worker = core.openSession(
      { role: "belthazar", adapter: "opencode", runtime: "test-runtime", scopeModule: "default", ttlSeconds: 3600 },
      { interactive: true }
    );
    expect(worker.ok).toBe(true);
    const denied = core.gasparEntryProjection({
      actor: "belthazar",
      session: { id: worker.value!.id, token: worker.value!.token },
    });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("EXECUTION_DENIED");
    // Broker issuance is role-gated like other orchestrator operations.
    const workerIssue = core.issueBrokerCredential({
      actor: "belthazar",
      session: { id: worker.value!.id, token: worker.value!.token },
    });
    expect(workerIssue.ok).toBe(false);
    expect(workerIssue.error?.code).toBe("EXECUTION_DENIED");
  });

  it("projects BLOCKED state with blocker decisions and action", () => {
    expect(core.raiseBlocker("PRODUCT_BLOCKER", ["default"], "Missing requirement", gaspar).ok).toBe(true);
    const projection = core.gasparEntryProjection(gaspar);
    expect(projection.ok).toBe(true);
    expect(projection.value?.projectState).toBe("BLOCKED");
    expect(projection.value?.nextAction.key).toBe("explain-blocker");
    expect(projection.value?.requiredDecisions.some((d) => d.startsWith("resolve-blocker:"))).toBe(true);
  });

  it("projects awaiting-approval modules as required decisions", () => {
    expect(
      core.registerModule("MOD-0001", "DRAFT", { id: "MOD-0001", name: "M", purpose: "P", specs: [] }, gaspar).ok
    ).toBe(true);
    expect(core.transitionState("MOD-0001", "ModulePlanned", { ...gaspar }).ok).toBe(true);
    const projection = core.gasparEntryProjection(gaspar);
    expect(projection.ok).toBe(true);
    expect(projection.value?.awaitingApprovalModules).toContain("MOD-0001");
    expect(projection.value?.requiredDecisions).toContain("module-approval:MOD-0001");
  });
});

describe("Gaspar entry action table", () => {
  it("covers every persisted project state exactly once", () => {
    for (const state of [
      "UNINITIALIZED",
      "ANALYZING",
      "ARCHITECTING",
      "SPECIFYING",
      "PLANNING",
      "EXECUTING",
      "VERIFYING",
      "BLOCKED",
      "COMPLETE",
    ]) {
      expect(GASPAR_ENTRY_ACTIONS[state]).toBeDefined();
      expect(typeof GASPAR_ENTRY_ACTIONS[state]!.key).toBe("string");
      expect(GASPAR_ENTRY_ACTIONS[state]!.summary.length).toBeGreaterThan(0);
    }
    expect(Object.keys(GASPAR_ENTRY_ACTIONS)).toHaveLength(9);
  });
});
