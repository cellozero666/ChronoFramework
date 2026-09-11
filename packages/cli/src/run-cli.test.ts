/**
 * Slice 6 CLI tests — authorized dispatch through a registered adapter.
 * The fixture runtime is a real executable script (not a mock of the
 * product path): authorize → enact → spawn → evidence → advance.
 * Every denial leaves lifecycle state untouched.
 * [RUNTIME §4, PL Phase 5]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
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
import { ChronoCore } from "@chrono/core";
import { runDispatch, type RunOptions, type SpawnResult } from "./index.js";

const FIXED_TIME = "2026-06-01T00:00:00.000Z";
const SPEC = {
  id: "SP-0001",
  title: "T",
  purpose: "P",
  inScope: ["a"],
  acceptanceCriteria: ["ac1"],
};
const MOD = { id: "MOD-0001", name: "M", purpose: "P", specs: ["SP-0001"] };

// Frozen fixture: byte-exact canonical SKILL.md at the pinned commit
// (hashSkillSource === SKILL_RELEASE.sourceHash, asserted below).
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

function signedSession(
  core: ChronoCore,
  role: "gaspar" | "PO" | "belthazar" | "glenn",
  privateKeyPem: string,
  scopeModule?: string
): TestSession {
  const input = {
    role,
    adapter: "test-adapter",
    runtime: "test-runtime",
    ...(scopeModule !== undefined ? { scopeModule } : {}),
    ttlSeconds: 3600,
  };
  if (role !== "gaspar" && role !== "PO") {
    const res = core.openSession(input, { interactive: true });
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
  const res = core.openSession(input, {
    poAuthorization: { nonce, authority: "PO", rationale, timestamp, signature },
  });
  expect(res.ok).toBe(true);
  return { id: res.value!.id, token: res.value!.token };
}

function approve(
  core: ChronoCore,
  privateKeyPem: string,
  action: string,
  scopeArtifactId: string,
  scopeRevision: string
): string {
  const signature = signApprovalPayload(
    buildApprovalPayload({
      action,
      scopeArtifactId,
      scopeRevision,
      authority: "PO",
      rationale: "test approval",
      timestamp: FIXED_TIME,
    }),
    privateKeyPem
  );
  const res = core.recordApproval({
    action,
    scopeArtifactId,
    scopeRevision,
    authority: "PO",
    rationale: "test approval",
    timestamp: FIXED_TIME,
    signature,
  });
  expect(res.ok).toBe(true);
  return res.value!.id;
}

describe("CLI dispatch", () => {
  let tempDir: string;
  let restoreTty: () => void;
  let privateKeyPem: string;
  let gaspar: { actor: string; session: TestSession };
  let po: { actor: string; session: TestSession };
  let worker: { actor: string; session: TestSession };
  let entrypoint: string;

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
    tempDir = mkdtempSync(join(tmpdir(), "chrono-run-cli-test-"));
    const core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    try {
      expect(core.init().ok).toBe(true);
      const pair = generateApprovalKeyPair();
      restoreTty = fakeInteractiveTerminal();
      enrollTestPo(core, pair);
      privateKeyPem = pair.privateKeyPem;
      gaspar = { actor: "gaspar", session: signedSession(core, "gaspar", privateKeyPem) };
      po = { actor: "PO", session: signedSession(core, "PO", privateKeyPem) };
      // Architecture + spec + module to APPROVED.
      const proposed = core.proposeArchitecture({ title: "A" }, gaspar);
      expect(proposed.ok).toBe(true);
      expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
      approve(core, privateKeyPem, "architecture-security", "ARCH", proposed.value!);
      expect(core.approveArchitecture(gaspar).ok).toBe(true);
      expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
      expect(core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar).ok).toBe(true);
      const specRev = core.getArtifact("SP-0001").revision;
      approve(core, privateKeyPem, "architecture-security", "SP-0001", specRev);
      expect(core.recordHarness(specRev, `sha256:${"a".repeat(64)}`, "# h", gaspar).ok).toBe(true);
      expect(core.transitionState("SP-0001", "SpecApprovedReady", gaspar).ok).toBe(true);
      expect(core.registerModule("MOD-0001", "DRAFT", MOD, gaspar).ok).toBe(true);
      expect(core.transitionState("MOD-0001", "ModulePlanned", gaspar).ok).toBe(true);
      const modRev = core.getArtifact("MOD-0001").revision;
      approve(core, privateKeyPem, "module-approval", "MOD-0001", modRev);
      expect(core.transitionState("MOD-0001", "ModuleApproved", gaspar).ok).toBe(true);
      // Attestations + security posture for execution.
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
      // Emitted skill files matching the attestation (dispatch re-hashes).
      expect(hashSkillSource(FIXTURE_SKILL_MD)).toBe(SKILL_RELEASE.sourceHash);
      const vendorTarget = join(tempDir, skillVendorPath(SKILL_RELEASE.pinnedCommit));
      mkdirSync(dirname(vendorTarget), { recursive: true });
      writeFileSync(vendorTarget, FIXTURE_SKILL_MD, "utf8");
      for (const runtime of ["claude", "opencode", "kiro"] as const) {
        const target = join(tempDir, SKILL_RUNTIME_PATHS[runtime]);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, FIXTURE_SKILL_MD, "utf8");
      }
      const glenn = { actor: "glenn", session: signedSession(core, "glenn", privateKeyPem, "MOD-0001") };
      expect(core.recordSecurityProfile({ title: "P", threats: [] }, glenn).ok).toBe(true);
      approve(core, privateKeyPem, "implementation-security", "MOD-0001", modRev);
      // Fixture runtime + approved registration.
      entrypoint = join(tempDir, "fixture-runtime.sh");
      writeFileSync(entrypoint, "#!/bin/sh\necho fixture-ok\n");
      chmodSync(entrypoint, 0o755);
      expect(
        core.registerAdapter(
          { id: "fixture", name: "Fixture", entrypoint, conformanceProof: ["fixture --version"] },
          po
        ).ok
      ).toBe(true);
      const registrationHash = core.adapterRegistrationHash("fixture");
      const adapterApprovalId = approve(core, privateKeyPem, "adapter-registration", "fixture", registrationHash);
      expect(core.approveAdapter("fixture", adapterApprovalId, po).ok).toBe(true);
      const fixtureProofCommand = JSON.stringify([rtkBin, "gain"]);
      expect(
        core.recordRoutingProof(gaspar, {
          adapterId: "fixture",
          binaryPath: rtkBin,
          version: "1.0.0-test",
          proofCommand: fixtureProofCommand,
          commandHash: computeRevisionHash([rtkBin, "gain"]),
          outputHash: computeRevisionHash("fixture gain ok"),
          exitStatus: 0,
          gainAvailable: true,
          timestamp: new Date().toISOString(),
          ttlSeconds: 86400,
        }).ok
      ).toBe(true);
      worker = { actor: "belthazar", session: signedSession(core, "belthazar", privateKeyPem, "MOD-0001") };
    } finally {
      core.close();
    }
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function baseOptions(overrides: Partial<RunOptions> = {}): RunOptions {
    return {
      module: "MOD-0001",
      adapter: "fixture",
      as: "gaspar",
      requesterToken: `${gaspar.session.id}/${gaspar.session.token}`,
      role: "belthazar",
      sessionToken: `${worker.session.id}/${worker.session.token}`,
      command: [entrypoint, "--work"],
      ...overrides,
    };
  }

  const okSpawn = (seen: { env?: Record<string, string> }) =>
    (cmd: string, args: string[], _timeoutMs: number, env: Record<string, string>): SpawnResult => {
      seen.env = env;
      expect(cmd).toBe(entrypoint);
      expect(args).toEqual(["--work"]);
      return { status: 0, stdout: "fixture-ok", stderr: "", timedOut: false };
    };

  it("dispatches an approved module to VERIFYING with recorded evidence", () => {
    const seen: { env?: Record<string, string> } = {};
    const out = runDispatch(tempDir, baseOptions(), okSpawn(seen));
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("VERIFYING");
    expect(seen.env?.["CHRONO_MODULE"]).toBe("MOD-0001");
    expect(seen.env?.["CHRONO_ADAPTER"]).toBe("fixture");
    expect(seen.env?.["CHRONO_GRANT_ID"]).toMatch(/^GRANT-\d{4,}$/);
    // The bearer session token never crosses into the child environment.
    expect(seen.env?.["CHRONO_SESSION_TOKEN"]).toBeUndefined();
    const check = new ChronoCore({ projectPath: tempDir });
    try {
      expect(check.getArtifact("MOD-0001").status).toBe("VERIFYING");
      expect(check.validate().value?.valid).toBe(true);
    } finally {
      check.close();
    }
  });

  it("leaves state EXECUTING when the command fails", () => {
    const out = runDispatch(
      tempDir,
      baseOptions(),
      () => ({ status: 3, stdout: "", stderr: "boom", timedOut: false })
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("boom");
    const check = new ChronoCore({ projectPath: tempDir });
    try {
      expect(check.getArtifact("MOD-0001").status).toBe("EXECUTING");
    } finally {
      check.close();
    }
  });

  it("denies unregistered adapters and smuggled binaries", () => {
    const ghost = runDispatch(tempDir, baseOptions({ adapter: "ghost" }), okSpawn({}));
    expect(ghost.exitCode).toBe(1);
    const smuggled = runDispatch(
      tempDir,
      baseOptions({ command: ["/bin/sh", "-c", "echo pwned"] }),
      okSpawn({})
    );
    expect(smuggled.exitCode).toBe(2);
    expect(smuggled.stderr).toContain("entrypoint");
  });

  it("requires explicit requester and executor sessions", () => {
    const noRequester = runDispatch(tempDir, baseOptions({ requesterToken: "" }), okSpawn({}));
    expect(noRequester.exitCode).toBe(2);
    const noExecutor = runDispatch(tempDir, baseOptions({ sessionToken: "" }), okSpawn({}));
    expect(noExecutor.exitCode).toBe(2);
  });

  it("dispatches an authorized work package to IMPLEMENTED", () => {
    const setup = new ChronoCore({ projectPath: tempDir });
    try {
      expect(
        setup.registerWorkPackage(
          "WP-0001",
          "PLANNED",
          { id: "WP-0001", name: "W", module: "MOD-0001", dependsOn: [] },
          { actor: "gaspar", session: gaspar.session }
        ).ok
      ).toBe(true);
      expect(
        setup.transitionState("WP-0001", "WorkPackageAuthorized", { actor: "gaspar", session: gaspar.session }).ok
      ).toBe(true);
    } finally {
      setup.close();
    }
    const seen: { env?: Record<string, string> } = {};
    const out = runDispatch(tempDir, baseOptions({ wp: "WP-0001" }), okSpawn(seen));
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("IMPLEMENTED");
    const check = new ChronoCore({ projectPath: tempDir });
    try {
      expect(check.getArtifact("WP-0001").status).toBe("IMPLEMENTED");
    } finally {
      check.close();
    }
  });
});
