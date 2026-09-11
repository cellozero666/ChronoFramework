/**
 * CLI gate/attestation tests — adapters obey Core decisions; every
 * failure path emits JSON with --json.
 * [RUNTIME §3.2, Remediation §5]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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
  computeRevisionHash,
  convertSkillSource,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  hashSkillSource,
  signApprovalPayload,
  skillGeneratedHashes,
  skillVendorPath,
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

function openGasparWithKey(core: ChronoCore, privateKeyPem: string): {
  tokenString: string;
  session: { id: string; token: string };
} {
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
  const res = core.openSession(
    { role: "gaspar", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
    { poAuthorization: { nonce, authority: "PO", rationale, timestamp, signature } }
  );
  expect(res.ok).toBe(true);
  return {
    tokenString: `${res.value!.id}/${res.value!.token}`,
    session: { id: res.value!.id, token: res.value!.token },
  };
}

function openCliSession(projectPath: string): {
  tokenString: string;
  session: { id: string; token: string };
} {
  const core = new ChronoCore({ projectPath });
  try {
    const pair = generateApprovalKeyPair();
    enrollTestPo(core, pair);
    return openGasparWithKey(core, pair.privateKeyPem);
  } finally {
    core.close();
  }
}

/** Open a PO session with an enrolled key (test-only, mirrors openGasparWithKey). */
function openPoWithKey(core: ChronoCore, privateKeyPem: string): {
  tokenString: string;
  session: { id: string; token: string };
} {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = "2026-09-11T00:00:00.000Z";
  const rationale = "test privileged-session bootstrap";
  const signature = signApprovalPayload(
    buildSessionAuthorizationPayload({
      sessionRole: "PO",
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
    { role: "PO", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
    { poAuthorization: { nonce, authority: "PO", rationale, timestamp, signature } }
  );
  expect(res.ok).toBe(true);
  return {
    tokenString: `${res.value!.id}/${res.value!.token}`,
    session: { id: res.value!.id, token: res.value!.token },
  };
}

/** Open a worker session without PO enrollment (interactive minting needs none). */
function openBelthazarToken(core: ChronoCore): string {
  const opened = core.openSession(
    { role: "belthazar", adapter: "test-adapter", runtime: "test-runtime", scopeModule: "default", ttlSeconds: 3600 },
    { interactive: true }
  );
  expect(opened.ok).toBe(true);
  return `${opened.value!.id}/${opened.value!.token}`;
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
    if (typeof restoreTty !== "undefined") {
      restoreTty();
    }
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
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
    const out = runRtkVerify(tempDir, { session: openCliSession(tempDir).session, resolveBinary: () => "/fixture/rtk" }, throwing);
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
    const out = runRtkVerify(tempDir, { session: openCliSession(tempDir).session, resolveBinary: () => "/fixture/rtk" }, fake);
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
    const out = runRtkVerify(tempDir, { session: openCliSession(tempDir).session, resolveBinary: () => "/fixture/rtk" }, fake);
    expect(out.exitCode).toBe(0);
    const status = runAttestationStatus(tempDir, "rtk", { json: true });
    const parsed = JSON.parse(status.stdout) as { state: string };
    expect(parsed.state).toBe("current");
  });
});

// Frozen fixture: byte-exact canonical SKILL.md at the pinned commit
// (hashSkillSource === SKILL_RELEASE.sourceHash, asserted on use).
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

const GATE_SPEC = {
  id: "SP-0001",
  title: "T",
  purpose: "P",
  inScope: ["a"],
  acceptanceCriteria: ["ac1"],
};
const GATE_MOD = { id: "MOD-0001", name: "M", purpose: "P", specs: ["SP-0001"] };
const GATE_FIXED_TIME = "2026-06-01T00:00:00.000Z";

interface GateFixture {
  gasparToken: string;
  privateKeyPem: string;
}

/** Drive tempDir to approved architecture, READY spec, APPROVED module, VERIFYING + PASS. */
function setupGateProject(tempDir: string): GateFixture {
  const core = new ChronoCore({ projectPath: tempDir });
  try {
    const pair = generateApprovalKeyPair();
    enrollTestPo(core, pair);
    const nonce = randomBytes(16).toString("hex");
    const sessionTimestamp = "2026-09-11T00:00:00.000Z";
    const sessionRationale = "test privileged-session bootstrap";
    const sessionSignature = signApprovalPayload(
      buildSessionAuthorizationPayload({
        sessionRole: "gaspar",
        adapter: "test-adapter",
        runtime: "test-runtime",
        scopeModule: null,
        scopeWp: null,
        ttlSeconds: 3600,
        nonce,
        authority: "PO",
        rationale: sessionRationale,
        timestamp: sessionTimestamp,
      }),
      pair.privateKeyPem
    );
    const opened = core.openSession(
      { role: "gaspar", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
      { poAuthorization: { nonce, authority: "PO", rationale: sessionRationale, timestamp: sessionTimestamp, signature: sessionSignature } }
    );
    expect(opened.ok).toBe(true);
    const gaspar = { actor: "gaspar", session: { id: opened.value!.id, token: opened.value!.token } };
    const sign = (action: string, scopeArtifactId: string, scopeRevision: string) => {
      const signature = signApprovalPayload(
        buildApprovalPayload({
          action,
          scopeArtifactId,
          scopeRevision,
          authority: "PO",
          rationale: "test approval",
          timestamp: GATE_FIXED_TIME,
        }),
        pair.privateKeyPem
      );
      const recorded = core.recordApproval({
        action,
        scopeArtifactId,
        scopeRevision,
        authority: "PO",
        rationale: "test approval",
        timestamp: GATE_FIXED_TIME,
        signature,
      });
      expect(recorded.ok).toBe(true);
    };
    const proposed = core.proposeArchitecture({ title: "A" }, gaspar);
    expect(proposed.ok).toBe(true);
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    sign("architecture-security", "ARCH", proposed.value!);
    expect(core.approveArchitecture(gaspar).ok).toBe(true);
    expect(core.registerSpec("SP-0001", "DRAFT", GATE_SPEC, gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar).ok).toBe(true);
    const specRev = core.getArtifact("SP-0001").revision;
    sign("architecture-security", "SP-0001", specRev);
    expect(core.recordHarness(specRev, `sha256:${"a".repeat(64)}`, "# h", gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecApprovedReady", gaspar).ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", GATE_MOD, gaspar).ok).toBe(true);
    expect(core.transitionState("MOD-0001", "ModulePlanned", gaspar).ok).toBe(true);
    const modRev = core.getArtifact("MOD-0001").revision;
    sign("module-approval", "MOD-0001", modRev);
    expect(core.transitionState("MOD-0001", "ModuleApproved", gaspar).ok).toBe(true);
    const rtkBin = join(tempDir, "fixture-rtk.sh");
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
    const vendorTarget = join(tempDir, skillVendorPath(SKILL_RELEASE.pinnedCommit));
    mkdirSync(dirname(vendorTarget), { recursive: true });
    writeFileSync(vendorTarget, FIXTURE_SKILL_MD, "utf8");
    for (const runtime of ["claude", "opencode", "kiro"] as const) {
      const target = join(tempDir, SKILL_RUNTIME_PATHS[runtime]);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, FIXTURE_SKILL_MD, "utf8");
    }
    const adapterEntrypoint = join(tempDir, "fixture-adapter.sh");
    writeFileSync(adapterEntrypoint, "#!/bin/sh\necho fixture-adapter\n", "utf8");
    chmodSync(adapterEntrypoint, 0o755);
    const poOpened = openPoWithKey(core, pair.privateKeyPem);
    const po = { actor: "PO", session: poOpened.session };
    expect(
      core.registerAdapter(
        { id: "test-adapter", name: "Test adapter", entrypoint: adapterEntrypoint, conformanceProof: ["test-adapter --version"] },
        po
      ).ok
    ).toBe(true);
    const adapterRev = core.adapterRegistrationHash("test-adapter");
    sign("adapter-registration", "test-adapter", adapterRev);
    const adapterApprovals = core.listEvents().filter((e) => e.eventType === "ApprovalGranted");
    const adapterApprovalId = adapterApprovals[adapterApprovals.length - 1]!.entityId;
    expect(core.approveAdapter("test-adapter", adapterApprovalId, po).ok).toBe(true);
    const proofCommand = JSON.stringify([rtkBin, "gain"]);
    expect(
      core.recordRoutingProof(gaspar, {
        adapterId: "test-adapter",
        binaryPath: rtkBin,
        version: "1.0.0-test",
        proofCommand,
        commandHash: computeRevisionHash([rtkBin, "gain"]),
        outputHash: computeRevisionHash("fixture gain ok"),
        exitStatus: 0,
        gainAvailable: true,
        timestamp: new Date().toISOString(),
        ttlSeconds: 86400,
      }).ok
    ).toBe(true);
    const openWorker = (role: string) => {
      const res = core.openSession(
        { role, adapter: "test-adapter", runtime: "test-runtime", scopeModule: "MOD-0001", ttlSeconds: 3600 },
        { interactive: true }
      );
      expect(res.ok).toBe(true);
      return { actor: role, session: { id: res.value!.id, token: res.value!.token } };
    };
    const belthazar = openWorker("belthazar");
    const spekkio = openWorker("spekkio");
    const start = core.authorizeExecution("MOD-0001", { actor: "belthazar", role: "belthazar", session: belthazar.session });
    expect(start.ok).toBe(true);
    expect(
      core.transitionState("MOD-0001", "ExecutionStarted", { actor: "belthazar", session: belthazar.session, grantId: start.value!.grantId }).ok
    ).toBe(true);
    const progress = core.authorizeExecution("MOD-0001", { actor: "belthazar", role: "belthazar", session: belthazar.session });
    expect(progress.ok).toBe(true);
    expect(
      core.transitionState("MOD-0001", "ImplementationComplete", { actor: "belthazar", session: belthazar.session, grantId: progress.value!.grantId }).ok
    ).toBe(true);
    expect(core.recordVerification("MOD-0001", "PASS", "spekkio", [], [], [], spekkio).ok).toBe(true);
    return { gasparToken: `${gaspar.session.id}/${gaspar.session.token}`, privateKeyPem: pair.privateKeyPem };
  } finally {
    core.close();
  }
}

describe("CLI gates (Slice 9: real Core decisions)", () => {
  let tempDir: string;
  let restoreTty: () => void;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-gates-test-"));
    expect(runInit(tempDir, { runtime: "test-runtime" }).exitCode).toBe(0);
    restoreTty = fakeInteractiveTerminal();
  });

  afterEach(() => {
    if (typeof restoreTty !== "undefined") {
      restoreTty();
    }
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function gate(options: Record<string, unknown>): { exitCode: number; body: { result: string; code?: string; reason?: string } } {
    const out = runGate(tempDir, { json: true, ...options } as never);
    return { exitCode: out.exitCode, body: JSON.parse(out.stdout) as { result: string; code?: string; reason?: string } };
  }

  it("denies architecture-approval on a fresh project and authorizes it once approved", () => {
    const fresh = new ChronoCore({ projectPath: tempDir });
    try {
    const denied = gate({ gate: "architecture-approval", as: "belthazar", sessionToken: openBelthazarToken(fresh) });
    expect(denied.exitCode).toBe(1);
    expect(denied.body.result).toBe("DENIED");
    expect(denied.body.code).toBe("EXECUTION_DENIED");
    expect(denied.body.reason ?? "").not.toHaveLength(0);
    } finally {
      fresh.close();
    }

    const { gasparToken } = setupGateProject(tempDir);
    const authorized = gate({ gate: "architecture-approval", as: "gaspar", sessionToken: gasparToken });
    expect(authorized.exitCode).toBe(0);
    expect(authorized.body.result).toBe("AUTHORIZED");
  });

  it("denies architecture-approval when the security approval is missing", () => {
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      const pair = generateApprovalKeyPair();
      enrollTestPo(core, pair);
      const opened = openGasparWithKey(core, pair.privateKeyPem);
      const gaspar = { actor: "gaspar", session: opened.session };
      expect(core.proposeArchitecture({ title: "A" }, gaspar).ok).toBe(true);
      expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
      const out = gate({ gate: "architecture-approval", as: "gaspar", sessionToken: opened.tokenString });
      expect(out.exitCode).toBe(1);
      expect(out.body.result).toBe("DENIED");
      expect(out.body.code).toBe("APPROVAL_REQUIRED");
    } finally {
      core.close();
    }
  });

  it("requires a session for the new gates", () => {
    for (const options of [
      { gate: "architecture-approval", as: "gaspar" },
      { gate: "spec-ready", as: "gaspar", spec: "SP-0001" },
      { gate: "verification", as: "gaspar", module: "MOD-0001" },
    ]) {
      const out = gate(options);
      expect(out.exitCode).toBe(2);
      expect(out.body.result).toBe("ERROR");
      expect(out.body.code).toBe("VALIDATION_ERROR");
    }
  });

  it("denies spec-ready for unknown specs and approves READY specs", () => {
    const fresh = new ChronoCore({ projectPath: tempDir });
    let workerToken: string;
    try {
      workerToken = openBelthazarToken(fresh);
    } finally {
      fresh.close();
    }
    const unknown = gate({ gate: "spec-ready", as: "belthazar", spec: "SP-0099", sessionToken: workerToken });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.body.result).toBe("DENIED");
    expect(unknown.body.code).toBe("ENTITY_NOT_FOUND");

    const { gasparToken } = setupGateProject(tempDir);
    const authorized = gate({ gate: "spec-ready", as: "gaspar", spec: "SP-0001", sessionToken: gasparToken });
    expect(authorized.exitCode).toBe(0);
    expect(authorized.body.result).toBe("AUTHORIZED");
  });

  it("denies spec-ready for non-spec scopes and unready specs", () => {
    const { gasparToken, privateKeyPem } = setupGateProject(tempDir);
    const wrongScope = gate({ gate: "spec-ready", as: "gaspar", spec: "MOD-0001", sessionToken: gasparToken });
    expect(wrongScope.exitCode).toBe(1);
    expect(wrongScope.body.result).toBe("DENIED");
    expect(wrongScope.body.code).toBe("VALIDATION_ERROR");

    const core = new ChronoCore({ projectPath: tempDir });
    try {
      const opened = openGasparWithKey(core, privateKeyPem);
      const gaspar = { actor: "gaspar", session: opened.session };
      expect(
        core.registerSpec("SP-0002", "DRAFT", { id: "SP-0002", title: "T", purpose: "P" }, gaspar).ok
      ).toBe(true);
      const draft = gate({ gate: "spec-ready", as: "gaspar", spec: "SP-0002", sessionToken: opened.tokenString });
      expect(draft.exitCode).toBe(1);
      expect(draft.body.result).toBe("DENIED");
      expect(draft.body.code).toBe("APPROVAL_REQUIRED");
    } finally {
      core.close();
    }
  });

  it("denies verification without a bound PASS and authorizes it with one", () => {
    const { gasparToken } = setupGateProject(tempDir);
    // Fresh project first: no verdict at all.
    const missing = gate({ gate: "verification", as: "gaspar", module: "MOD-0099", sessionToken: gasparToken });
    expect(missing.exitCode).toBe(1);
    expect(missing.body.result).toBe("DENIED");
    expect(missing.body.code).toBe("ENTITY_NOT_FOUND");

    // Existing module, no verdict bound: explicit completion denial.
    const slash = gasparToken.indexOf("/");
    const gaspar = {
      actor: "gaspar",
      session: { id: gasparToken.slice(0, slash), token: gasparToken.slice(slash + 1) },
    };
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      expect(
        core.registerModule("MOD-0002", "DRAFT", { id: "MOD-0002", name: "M2", purpose: "P", specs: [] }, gaspar).ok
      ).toBe(true);
    } finally {
      core.close();
    }
    const noVerdict = gate({ gate: "verification", as: "gaspar", module: "MOD-0002", sessionToken: gasparToken });
    expect(noVerdict.exitCode).toBe(1);
    expect(noVerdict.body.result).toBe("DENIED");
    expect(noVerdict.body.code).toBe("COMPLETION_DENIED");

    const authorized = gate({ gate: "verification", as: "gaspar", module: "MOD-0001", sessionToken: gasparToken });
    expect(authorized.exitCode).toBe(0);
    expect(authorized.body.result).toBe("AUTHORIZED");
  });

  it("denies verification for unknown work-package scopes", () => {
    const { gasparToken } = setupGateProject(tempDir);
    const out = gate({ gate: "verification", as: "gaspar", module: "MOD-0001", wp: "WP-0099", sessionToken: gasparToken });
    expect(out.exitCode).toBe(1);
    expect(out.body.result).toBe("DENIED");
    expect(out.body.code).toBe("ENTITY_NOT_FOUND");
  });

  it("denies confused actors on the new gates", () => {
    const { gasparToken } = setupGateProject(tempDir);
    void gasparToken;
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      const worker = core.openSession(
        { role: "belthazar", adapter: "test-adapter", runtime: "test-runtime", scopeModule: "MOD-0001", ttlSeconds: 3600 },
        { interactive: true }
      );
      expect(worker.ok).toBe(true);
      const workerToken = `${worker.value!.id}/${worker.value!.token}`;
      const out = gate({ gate: "verification", as: "gaspar", module: "MOD-0001", sessionToken: workerToken });
      expect(out.exitCode).toBe(1);
      expect(out.body.result).toBe("DENIED");
      expect(out.body.code).toBe("EXECUTION_DENIED");
    } finally {
      core.close();
    }
  });

  it("requires --spec for spec-ready and --module for verification", () => {
    const token = openCliSession(tempDir).tokenString;
    const noSpec = gate({ gate: "spec-ready", as: "gaspar", sessionToken: token });
    expect(noSpec.exitCode).toBe(2);
    expect(noSpec.body.code).toBe("VALIDATION_ERROR");
    const noModule = gate({ gate: "verification", as: "gaspar", sessionToken: token });
    expect(noModule.exitCode).toBe(2);
    expect(noModule.body.code).toBe("VALIDATION_ERROR");
  });
});
