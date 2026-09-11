/**
 * I9 tests — full execution/completion gates with explicit missing-
 * capability denials. Success is never returned after placeholder checks.
 * [CORE §7.4/§7.6, DOM §6.4/§6.6, Remediation §5]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  SKILL_RELEASE,
  SKILL_RUNTIME_PATHS,
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
  RTK_UPSTREAM,
  SKILL_UPSTREAM,
} from "@chrono/domain";
import { ChronoCore, type CallerAuth } from "./chrono-core.js";

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

type SignFn = (fields: {
  action: string;
  scopeArtifactId: string;
  scopeRevision: string;
  authority: string;
  rationale: string;
}) => { signature: string; timestamp: string };

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

function approve(
  core: ChronoCore,
  sign: SignFn,
  action: string,
  scopeArtifactId: string,
  scopeRevision: string
): void {
  const { signature, timestamp } = sign({
    action,
    scopeArtifactId,
    scopeRevision,
    authority: "PO",
    rationale: "test approval",
  });
  const res = core.recordApproval({
    action,
    scopeArtifactId,
    scopeRevision,
    authority: "PO",
    rationale: "test approval",
    timestamp,
    signature,
  });
  expect(res.ok).toBe(true);
}

/** Drive a module to APPROVED with all non-attestation prerequisites met. */
function approvedModule(core: ChronoCore, sign: SignFn, privateKeyPem: string): { modRev: string; gaspar: CallerAuth } {
  const gaspar = { actor: "gaspar", session: bootstrapPrivilegedSession(core, "gaspar", privateKeyPem) };
  const ctx = { actor: "gaspar", session: gaspar.session };
  const proposed = core.proposeArchitecture({ title: "A" }, gaspar);
  expect(proposed.ok).toBe(true);
  expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
  approve(core, sign, "architecture-security", "ARCH", proposed.value!);
  expect(core.approveArchitecture(gaspar).ok).toBe(true);

  expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
  expect(core.transitionState("SP-0001", "SpecSubmittedForReview", ctx).ok).toBe(true);
  const specRev = core.getArtifact("SP-0001").revision;
  approve(core, sign, "architecture-security", "SP-0001", specRev);
  expect(core.recordHarness(specRev, `sha256:${"a".repeat(64)}`, "# h", gaspar).ok).toBe(true);
  expect(core.transitionState("SP-0001", "SpecApprovedReady", ctx).ok).toBe(true);

  expect(core.registerModule("MOD-0001", "DRAFT", MOD, gaspar).ok).toBe(true);
  expect(core.transitionState("MOD-0001", "ModulePlanned", ctx).ok).toBe(true);
  const modRev = core.getArtifact("MOD-0001").revision;
  approve(core, sign, "module-approval", "MOD-0001", modRev);
  expect(core.transitionState("MOD-0001", "ModuleApproved", ctx).ok).toBe(true);
  return { modRev, gaspar };
}

function recordAttestations(
  core: ChronoCore,
  auth: CallerAuth,
  privateKeyPem: string,
  timestamp = new Date().toISOString()
): void {
  // The RTK binary is a real fixture script so routing proofs can hash it.
  const rtkBin = join(core.projectPath(), "fixture-rtk.sh");
  writeFileSync(rtkBin, "#!/bin/sh\necho fixture-rtk 1.0.0-test\n", "utf8");
  chmodSync(rtkBin, 0o755);
  expect(
    core.recordRtkAttestation(auth, {
      binaryPath: rtkBin,
      binaryIdentity: "rtk-test",
      version: "1.0.0-test",
      provenance: RTK_UPSTREAM,
      integrationMode: "test",
      routingTestPassed: true,
      routingTestLog: "fixture",
      gained: true,
      savingsEvidence: null,
      ttlSeconds: 3600,
    }).ok
  ).toBe(true);
  expect(
    core.recordSkillAttestation(auth, {
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
  // Emitted skill files matching the attestation: dispatch re-hashes them.
  expect(hashSkillSource(FIXTURE_SKILL_MD)).toBe(SKILL_RELEASE.sourceHash);
  const root = core.projectPath();
  const vendorTarget = join(root, skillVendorPath(SKILL_RELEASE.pinnedCommit));
  mkdirSync(dirname(vendorTarget), { recursive: true });
  writeFileSync(vendorTarget, FIXTURE_SKILL_MD, "utf8");
  for (const runtime of ["claude", "opencode", "kiro"] as const) {
    const target = join(root, SKILL_RUNTIME_PATHS[runtime]);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, FIXTURE_SKILL_MD, "utf8");
  }
  // Approved fixture adapter plus a current routing proof: dispatch
  // requires effective routing, not just attestation currency.
  const po = { actor: "PO", session: bootstrapPrivilegedSession(core, "PO", privateKeyPem, undefined, timestamp) };
  provisionRoutingProof(core, po, auth, privateKeyPem, timestamp);
}

/**
 * Provision an approved fixture adapter plus a current routing proof so
 * dispatch-authorized paths stay green. Idempotent per project: repeat
 * registration resolves to the existing row, approved adapters skip the
 * approval flow, and each call records a fresh proof. Production callers
 * MUST use `chrono adapter register` + `chrono rtk prove`.
 */
function provisionRoutingProof(
  core: ChronoCore,
  po: CallerAuth,
  submitter: CallerAuth,
  privateKeyPem: string,
  timestamp = new Date().toISOString()
): string {
  const root = core.projectPath();
  const entrypoint = join(root, "fixture-runtime.sh");
  writeFileSync(entrypoint, "#!/bin/sh\necho fixture-ok\n", "utf8");
  chmodSync(entrypoint, 0o755);
  const registered = core.registerAdapter(
    { id: "test-adapter", name: "Test adapter", entrypoint, conformanceProof: ["test-adapter --version"] },
    po
  );
  expect(registered.ok || registered.error?.code === "DUPLICATE_IDENTITY").toBe(true);
  const status = core.listAdapters().find((a) => a.id === "test-adapter")?.status;
  if (status !== "active") {
    const revision = core.adapterRegistrationHash("test-adapter");
    const signature = signApprovalPayload(
      buildApprovalPayload({
        action: "adapter-registration",
        scopeArtifactId: "test-adapter",
        scopeRevision: revision,
        authority: "PO",
        rationale: "test routing",
        timestamp: FIXED_TIME,
      }),
      privateKeyPem
    );
    const recorded = core.recordApproval({
      action: "adapter-registration",
      scopeArtifactId: "test-adapter",
      scopeRevision: revision,
      authority: "PO",
      rationale: "test routing",
      timestamp: FIXED_TIME,
      signature,
    });
    expect(recorded.ok).toBe(true);
    expect(core.approveAdapter("test-adapter", recorded.value!.id, po).ok).toBe(true);
  }
  const rtkBin = join(root, "fixture-rtk.sh");
  const proofCommand = JSON.stringify([rtkBin, "gain"]);
  const proof = core.recordRoutingProof(submitter, {
    adapterId: "test-adapter",
    binaryPath: rtkBin,
    version: "1.0.0-test",
    proofCommand,
    commandHash: computeRevisionHash([rtkBin, "gain"]),
    outputHash: computeRevisionHash("fixture gain ok"),
    exitStatus: 0,
    gainAvailable: true,
    timestamp,
    ttlSeconds: 3600,
  });
  expect(proof.ok).toBe(true);
  return proof.value!.id;
}

function bootstrapPrivilegedSession(
  core: ChronoCore,
  role: "gaspar" | "PO",
  privateKeyPem: string,
  scopeModule?: string,
  timestamp = "2026-09-11T00:00:00.000Z"
): { id: string; token: string } {
  const nonce = randomBytes(16).toString("hex");
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
      rationale: "test privileged-session bootstrap",
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
    { poAuthorization: { nonce, authority: "PO", rationale: "test privileged-session bootstrap", timestamp, signature } }
  );
  expect(res.ok).toBe(true);
  return { id: res.value!.id, token: res.value!.token };
}

function openTestSession(
  core: ChronoCore,
  role: string,
  scopeModule?: string
): { id: string; token: string } {
  if (role === "gaspar" || role === "PO") {
    throw new Error("Privileged test sessions require bootstrapPrivilegedSession with a PO-signed authorization");
  }
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

function testEvidence(core: ChronoCore, auth: CallerAuth, targetRevision: string, checkName: string, producer?: string): string {
  const integrityHash = computeRevisionHash({
    result: "pass",
    diagnostics: null,
    target_revision: targetRevision,
  });
  const res = core.recordEvidence({
    producer: producer ?? auth.actor,
    tool: "vitest",
    targetRevision,
    checkName,
    result: "pass",
    diagnostics: null,
    integrityHash,
  }, auth);
  expect(res.ok).toBe(true);
  return res.value!.id;
}


/**
 * TEST-ONLY terminal simulation. Production authority requires a live
 * human terminal (Core TTY rule); CI processes have none, so tests that
 * exercise the signed-authority path simulate terminal presence locally
 * and restore the real descriptors afterwards. This helper never ships:
 * it lives only in *.test.ts files. Refusal paths are tested WITHOUT it.
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

describe("Execution authorization", () => {
  let restoreTty: () => void;
  let tempDir: string;
  let core: ChronoCore;
  let sign: SignFn;
  let privateKeyPem: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-authz-test-"));
    core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    expect(core.init().ok).toBe(true);
    const pair = generateApprovalKeyPair();
    restoreTty = fakeInteractiveTerminal();
    enrollTestPo(core, pair);
    privateKeyPem = pair.privateKeyPem;
    sign = (fields) => ({
      timestamp: FIXED_TIME,
      signature: signApprovalPayload(buildApprovalPayload({ ...fields, timestamp: FIXED_TIME }), privateKeyPem),
    });
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

  it("denies when the module is not approved", () => {
    const gaspar = { actor: "gaspar", session: bootstrapPrivilegedSession(core, "gaspar", privateKeyPem) };
    // Registration itself needs the session; the module cannot exist yet
    // for scoping, so register first, then mint the worker session.
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", { ...MOD, specs: [] }, gaspar).ok).toBe(true);
    const worker = { actor: "belthazar", session: openTestSession(core, "belthazar", "MOD-0001") };
    const res = core.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar", session: worker.session, requesterSession: gaspar.session });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("EXECUTION_DENIED");
  });

  it("denies without attestations (missing capability, explicit code)", () => {
    const { gaspar } = approvedModule(core, sign, privateKeyPem);
    const worker = openTestSession(core, "belthazar", "MOD-0001");
    const res = core.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar", session: worker, requesterSession: gaspar.session });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("BLOCKED_RTK");
  });

  it("denies without module approval even when attestations exist", () => {
    const gaspar = { actor: "gaspar", session: bootstrapPrivilegedSession(core, "gaspar", privateKeyPem) };
    recordAttestations(core, gaspar, privateKeyPem);
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, gaspar).ok).toBe(true);
    const worker = openTestSession(core, "belthazar", "MOD-0001");
    const res = core.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar", session: worker, requesterSession: gaspar.session });
    expect(res.ok).toBe(false);
    // DRAFT modules fail on state before approval is even consulted.
    expect(res.error?.code).toBe("EXECUTION_DENIED");
  });

  it("authorizes a fully qualified module and audits denials", () => {
    const { gaspar } = approvedModule(core, sign, privateKeyPem);
    recordAttestations(core, gaspar, privateKeyPem);
    const worker = openTestSession(core, "belthazar", "MOD-0001");
    const authorized = core.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar", session: worker, requesterSession: gaspar.session });
    expect(authorized.ok).toBe(true);
    expect(authorized.value?.authorized).toBe(true);
    expect(authorized.value?.grantId).toMatch(/^GRANT-\d{4,}$/);

    // A new blocker denies again, with a DENIED audit event.
    expect(core.raiseBlocker("PRODUCT_BLOCKER", ["MOD-0001"], "hold", gaspar).ok).toBe(true);
    const denied = core.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar", session: worker, requesterSession: gaspar.session });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("EXECUTION_DENIED");
    const audit = core.listEvents().filter((e) => e.eventType === "DENIED");
    expect(audit.length).toBeGreaterThan(0);
  });

  it("denies stale harness and non-READY specs", () => {
    const { gaspar } = approvedModule(core, sign, privateKeyPem);
    recordAttestations(core, gaspar, privateKeyPem);
    const worker = openTestSession(core, "belthazar", "MOD-0001");
    const specRev = core.getArtifact("SP-0001").revision;
    expect(core.markHarnessStale(specRev, gaspar).ok).toBe(true);
    const stale = core.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar", session: worker, requesterSession: gaspar.session });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe("STALE_REVISION");
  });

  it("requires explicit work-package scope when WPs exist", () => {
    const { gaspar } = approvedModule(core, sign, privateKeyPem);
    recordAttestations(core, gaspar, privateKeyPem);
    expect(
      core.registerWorkPackage("WP-0001", "PLANNED", { id: "WP-0001", name: "W", module: "MOD-0001", dependsOn: [] }, gaspar).ok
    ).toBe(true);
    const worker = openTestSession(core, "belthazar", "MOD-0001");
    const unscoped = core.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar", session: worker, requesterSession: gaspar.session });
    expect(unscoped.ok).toBe(false);
    expect(unscoped.error?.code).toBe("EXECUTION_DENIED");
    // Un-AUTHORIZED WP scope also denies.
    const scoped = core.authorizeExecution("MOD-0001", { workPackageId: "WP-0001", actor: "gaspar", role: "belthazar", session: worker, requesterSession: gaspar.session });
    expect(scoped.ok).toBe(false);
  });

  it("denies when emitted skill files are tampered with or missing", () => {
    const { gaspar } = approvedModule(core, sign, privateKeyPem);
    recordAttestations(core, gaspar, privateKeyPem);
    const worker = openTestSession(core, "belthazar", "MOD-0001");
    const request = {
      actor: "gaspar",
      role: "belthazar",
      session: worker,
      requesterSession: gaspar.session,
    };
    // Rewritten runtime file → provenance failure.
    const runtimeTarget = join(core.projectPath(), SKILL_RUNTIME_PATHS.claude);
    writeFileSync(runtimeTarget, `${FIXTURE_SKILL_MD}\nrogue weakening`, "utf8");
    const tampered = core.authorizeExecution("MOD-0001", request);
    expect(tampered.ok).toBe(false);
    expect(tampered.error?.code).toBe("SKILL_PROVENANCE_FAILURE");
    // Missing vendor source → not installed in this checkout.
    rmSync(join(core.projectPath(), skillVendorPath(SKILL_RELEASE.pinnedCommit)));
    writeFileSync(runtimeTarget, FIXTURE_SKILL_MD, "utf8");
    const missing = core.authorizeExecution("MOD-0001", request);
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("BLOCKED_PROCESS_SKILL");
  });

  it("denies execution for invalid assignment roles", () => {
    const { gaspar } = approvedModule(core, sign, privateKeyPem);
    recordAttestations(core, gaspar, privateKeyPem);
    const worker = openTestSession(core, "belthazar", "MOD-0001");
    for (const role of ["gaspar", "glenn", "PO", "mallory"]) {
      const res = core.authorizeExecution("MOD-0001", { actor: "gaspar", role, session: worker });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("VALIDATION_ERROR");
    }
  });

  it("denies without a configured runtime (CONFIG_ERROR)", () => {
    const plainDir = mkdtempSync(join(tmpdir(), "chrono-nort-test-"));
    let plain: ChronoCore | undefined;
    try {
      plain = new ChronoCore({ projectPath: plainDir });
      expect(plain.init().ok).toBe(true);
      const pair = generateApprovalKeyPair();
      enrollTestPo(plain, pair);
      const privateKeyPem = pair.privateKeyPem;
      const plainSign: SignFn = (fields) => ({
        timestamp: FIXED_TIME,
        signature: signApprovalPayload(buildApprovalPayload({ ...fields, timestamp: FIXED_TIME }), privateKeyPem),
      });
      const { gaspar: plainGaspar } = approvedModule(plain, plainSign, privateKeyPem);
      recordAttestations(plain, plainGaspar, privateKeyPem);
      const plainWorker = openTestSession(plain, "belthazar", "MOD-0001");
      const res = plain.authorizeExecution("MOD-0001", { actor: "gaspar", role: "belthazar", session: plainWorker, requesterSession: plainGaspar.session });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("CONFIG_ERROR");
    } finally {
      plain?.close();
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});

/**
 * TEST-ONLY terminal simulation (see transition-guards.test.ts): the grant
 * tests below exercise signed authority, which requires the Core TTY rule
 * to observe a terminal. Refusal paths run WITHOUT the fake.
 */
function fakeInteractiveTerminalLocal(): () => void {
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

describe("Dispatch grants (session binding)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-grant-test-"));
  });

  afterEach(() => {
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const T0 = "2026-09-11T00:00:00.000Z";
  const T0_PLUS_2H = "2026-09-11T02:00:00.000Z";

  function clockedCore(clockTime: string, skipInit = false): {
    core: ChronoCore;
    sign: SignFn;
    poPrivateKey: string;
    restoreTty: () => void;
  } {
    const restoreTty = fakeInteractiveTerminalLocal();
    const core = new ChronoCore({
      projectPath: tempDir,
      runtime: "test-runtime",
      clock: () => clockTime,
    });
    if (!skipInit) {
      expect(core.init().ok).toBe(true);
      const pair = generateApprovalKeyPair();
      enrollTestPo(core, pair, clockTime);
      const privateKeyPem = pair.privateKeyPem;
      const sign: SignFn = (fields) => ({
        timestamp: "2026-06-01T00:00:00.000Z",
        signature: signApprovalPayload(
          buildApprovalPayload({ ...fields, timestamp: "2026-06-01T00:00:00.000Z" }),
          privateKeyPem
        ),
      });
      return { core, sign, poPrivateKey: privateKeyPem, restoreTty };
    }
    // Reopened project: key material persists. This sign closure is never
    // invoked (the test only presents the previously issued grant); any
    // accidental use fails closed on signature verification.
    const reopenedSign: SignFn = () => ({
      timestamp: "2026-06-01T00:00:00.000Z",
      signature: "unused",
    });
    return { core, sign: reopenedSign, poPrivateKey: "unused", restoreTty };
  }

  function approvedWithGrant(
    core: ChronoCore,
    sign: SignFn,
    poPrivateKey: string,
    actor: string,
    role: string,
    now: string
  ): { grantId: string; worker: { id: string; token: string }; gaspar: CallerAuth } {
    const { gaspar } = approvedModule(core, sign, poPrivateKey);
    recordAttestations(core, gaspar, poPrivateKey, now);
    const worker = openTestSession(core, role, "MOD-0001");
    const authz = core.authorizeExecution("MOD-0001", {
      actor,
      role,
      session: worker,
      ...(actor === role ? {} : { requesterSession: gaspar.session }),
    });
    expect(authz.ok).toBe(true);
    return { grantId: authz.value!.grantId, worker, gaspar };
  }

  it("enacts dispatch only with its grant, as the assigned role", () => {
    const { core, sign, poPrivateKey, restoreTty: restoreGrantTty } = clockedCore(T0);
    try {
      const { grantId, worker } = approvedWithGrant(core, sign, poPrivateKey, "gaspar", "belthazar", T0);
      expect(grantId).toMatch(/^GRANT-\d{4,}$/);
      // No grant presented → denied before any authorization reasoning.
      expect(
        core.transitionState("MOD-0001", "ExecutionStarted", { actor: "belthazar", session: worker }).error?.code
      ).toBe("MISSING_REQUIRED_ARTIFACT");
      // Forged grant id → denied.
      expect(
        core.transitionState("MOD-0001", "ExecutionStarted", { actor: "belthazar", session: worker, grantId: "GRANT-9999" }).error?.code
      ).toBe("REFERENCE_UNRESOLVABLE");
      // Wrong role → denied.
      const melchior = openTestSession(core, "melchior", "MOD-0001");
      expect(
        core.transitionState("MOD-0001", "ExecutionStarted", { actor: "melchior", session: melchior, grantId }).error?.code
      ).toBe("EXECUTION_DENIED");
      // Assigned role → dispatch opens and consumes the grant.
      expect(
        core.transitionState("MOD-0001", "ExecutionStarted", { actor: "belthazar", session: worker, grantId }).ok
      ).toBe(true);
      expect(core.getArtifact("MOD-0001").status).toBe("EXECUTING");
    } finally {
      restoreGrantTty();
      core.close();
    }
  });

  it("denies expired grants", () => {
    const first = clockedCore(T0);
    const restoreFirst = first.restoreTty;
    const firstPrivateKey = first.poPrivateKey;
    let grantId: string;
    let worker: { id: string; token: string };
    try {
      const issued = approvedWithGrant(first.core, first.sign, firstPrivateKey, "gaspar", "belthazar", T0);
      grantId = issued.grantId;
      worker = issued.worker;
    } finally {
      restoreFirst();
      first.core.close();
    }
    const second = clockedCore(T0_PLUS_2H, true);
    const restoreSecond = second.restoreTty;
    try {
      const res = second.core.transitionState("MOD-0001", "ExecutionStarted", {
        actor: "belthazar",
        session: worker,
        grantId,
      });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("EXECUTION_DENIED");
      expect(res.error?.message).toContain("expired");
    } finally {
      restoreSecond();
      second.core.close();
    }
  });

  it("binds grants to the exact session; orchestrators cannot enact worker grants", () => {
    const { core, sign, poPrivateKey, restoreTty: restoreSessionTty } = clockedCore(T0);
    try {
      const { gaspar } = approvedModule(core, sign, poPrivateKey);
      recordAttestations(core, gaspar, poPrivateKey, T0);
      // Authorize naming the executor session explicitly.
      const worker = openTestSession(core, "belthazar", "MOD-0001");
      const authz = core.authorizeExecution("MOD-0001", {
        actor: "gaspar",
        role: "belthazar",
        session: worker,
        requesterSession: gaspar.session,
      });
      expect(authz.ok).toBe(true);
      const grantId = authz.value!.grantId;
      // A different session may not enact it, even with the right role.
      const other = openTestSession(core, "belthazar", "MOD-0001");
      expect(
        core.transitionState("MOD-0001", "ExecutionStarted", { actor: "belthazar", session: other, grantId }).error?.code
      ).toBe("EXECUTION_DENIED");
      // Neither gaspar nor PO may consume a worker's grant from their own
      // sessions: orchestration names the executor, it never spends the
      // executor's grant.
      expect(
        core.transitionState("MOD-0001", "ExecutionStarted", { actor: "gaspar", session: gaspar.session, grantId }).error?.code
      ).toBe("EXECUTION_DENIED");
      // The bound session may.
      expect(
        core.transitionState("MOD-0001", "ExecutionStarted", { actor: "belthazar", session: worker, grantId }).ok
      ).toBe(true);
      // Gaspar requesting through a fresh grant still cannot enact it from
      // a different session: orchestration names the executor, it does not
      // consume the executor's grant.
      const authz2 = core.authorizeExecution("MOD-0001", {
        actor: "gaspar",
        role: "belthazar",
        session: worker,
        requesterSession: gaspar.session,
      });
      expect(authz2.ok).toBe(true);
      expect(
        core.transitionState("MOD-0001", "ImplementationComplete", {
          actor: "gaspar",
          session: gaspar.session,
          grantId: authz2.value!.grantId,
        }).error?.code
      ).toBe("EXECUTION_DENIED");
    } finally {
      restoreSessionTty();
      core.close();
    }
  });

  it("burns grants bound to an adapter revoked after issuance", () => {
    const { core, sign, poPrivateKey, restoreTty: restoreRevokeTty } = clockedCore(T0);
    try {
      const { gaspar } = approvedModule(core, sign, poPrivateKey);
      const poAuth = { actor: "PO", session: bootstrapPrivilegedSession(core, "PO", poPrivateKey) };
      const entrypoint = join(tempDir, "fixture-runtime.sh");
      writeFileSync(entrypoint, "#!/bin/sh\necho ok\n");
      chmodSync(entrypoint, 0o755);
      expect(
        core.registerAdapter(
          { id: "fixture", name: "Fixture", entrypoint, conformanceProof: ["fixture --version"] },
          poAuth
        ).ok
      ).toBe(true);
      const revision = core.adapterRegistrationHash("fixture");
      const { signature, timestamp } = sign({
        action: "adapter-registration",
        scopeArtifactId: "fixture",
        scopeRevision: revision,
        authority: "PO",
        rationale: "trust",
      });
      const recorded = core.recordApproval({
        action: "adapter-registration",
        scopeArtifactId: "fixture",
        scopeRevision: revision,
        authority: "PO",
        rationale: "trust",
        timestamp,
        signature,
      });
      expect(recorded.ok).toBe(true);
      const approvalId = recorded.value!.id;
      expect(core.approveAdapter("fixture", approvalId, poAuth).ok).toBe(true);
      // Operator sessions in this file are bound to "test-adapter":
      // routing-proof submission requires an approved submitter adapter,
      // so it is approved here as the second approved adapter.
      expect(
        core.registerAdapter(
          { id: "test-adapter", name: "Test adapter", entrypoint, conformanceProof: ["fixture --version"] },
          poAuth
        ).ok
      ).toBe(true);
      const operatorRevision = core.adapterRegistrationHash("test-adapter");
      const operatorSig = sign({
        action: "adapter-registration",
        scopeArtifactId: "test-adapter",
        scopeRevision: operatorRevision,
        authority: "PO",
        rationale: "trust",
      });
      const operatorRecorded = core.recordApproval({
        action: "adapter-registration",
        scopeArtifactId: "test-adapter",
        scopeRevision: operatorRevision,
        authority: "PO",
        rationale: "trust",
        timestamp: operatorSig.timestamp,
        signature: operatorSig.signature,
      });
      expect(operatorRecorded.ok).toBe(true);
      expect(core.approveAdapter("test-adapter", operatorRecorded.value!.id, poAuth).ok).toBe(true);
      recordAttestations(core, gaspar, poPrivateKey, T0);
      const rtkBin = join(tempDir, "fixture-rtk.sh");
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
          timestamp: T0,
          ttlSeconds: 3600,
        }).ok
      ).toBe(true);
      const worker = openTestSession(core, "belthazar", "MOD-0001");
      const authz = core.authorizeExecution("MOD-0001", {
        actor: "gaspar",
        role: "belthazar",
        session: worker,
        requesterSession: gaspar.session,
        adapterId: "fixture",
      });
      expect(authz.ok).toBe(true);
      expect(core.revokeAdapter("fixture", poAuth).ok).toBe(true);
      const denied = core.transitionState("MOD-0001", "ExecutionStarted", {
        actor: "belthazar",
        session: worker,
        grantId: authz.value!.grantId,
      });
      expect(denied.ok).toBe(false);
      expect(denied.error?.code).toBe("EXECUTION_DENIED");
      expect(denied.error?.message).toContain("no longer approved");
    } finally {
      restoreRevokeTty();
      core.close();
    }
  });

  it("denies routing proofs submitted by sessions of unapproved adapters", () => {
    const { core, sign, poPrivateKey, restoreTty: restoreProofTty } = clockedCore(T0);
    try {
      const { gaspar } = approvedModule(core, sign, poPrivateKey);
      const poAuth = { actor: "PO", session: bootstrapPrivilegedSession(core, "PO", poPrivateKey) };
      const entrypoint = join(tempDir, "fixture-runtime.sh");
      writeFileSync(entrypoint, "#!/bin/sh\necho ok\n");
      chmodSync(entrypoint, 0o755);
      // Only "test-adapter" is approved; "ghost" is never registered and
      // "pending-adapter" stays pending.
      expect(
        core.registerAdapter(
          { id: "test-adapter", name: "Test adapter", entrypoint, conformanceProof: ["fixture --version"] },
          poAuth
        ).ok
      ).toBe(true);
      const revision = core.adapterRegistrationHash("test-adapter");
      const sig = sign({
        action: "adapter-registration",
        scopeArtifactId: "test-adapter",
        scopeRevision: revision,
        authority: "PO",
        rationale: "trust",
      });
      const recorded = core.recordApproval({
        action: "adapter-registration",
        scopeArtifactId: "test-adapter",
        scopeRevision: revision,
        authority: "PO",
        rationale: "trust",
        timestamp: sig.timestamp,
        signature: sig.signature,
      });
      expect(recorded.ok).toBe(true);
      expect(core.approveAdapter("test-adapter", recorded.value!.id, poAuth).ok).toBe(true);
      expect(
        core.registerAdapter(
          { id: "pending-adapter", name: "Pending", entrypoint, conformanceProof: ["fixture --version"] },
          poAuth
        ).ok
      ).toBe(true);
      recordAttestations(core, gaspar, poPrivateKey, T0);
      const rtkBin = join(tempDir, "fixture-rtk.sh");
      const proofInput = {
        adapterId: "test-adapter",
        binaryPath: rtkBin,
        version: "1.0.0-test",
        proofCommand: JSON.stringify([rtkBin, "gain"]),
        commandHash: computeRevisionHash([rtkBin, "gain"]),
        outputHash: computeRevisionHash("fixture gain ok"),
        exitStatus: 0,
        gainAvailable: true,
        timestamp: T0,
        ttlSeconds: 3600,
      } as const;
      const openOn = (adapter: string): { id: string; token: string } => {
        const res = core.openSession(
          { role: "belthazar", adapter, runtime: "test-runtime", scopeModule: "MOD-0001", ttlSeconds: 3600 },
          { interactive: true }
        );
        expect(res.ok).toBe(true);
        return { id: res.value!.id, token: res.value!.token };
      };
      // Never-registered submitter adapter.
      const ghostDenied = core.recordRoutingProof({ actor: "belthazar", session: openOn("ghost") }, { ...proofInput });
      expect(ghostDenied.ok).toBe(false);
      expect(ghostDenied.error?.code).toBe("ENTITY_NOT_FOUND");
      // Pending (unapproved) submitter adapter.
      const pendingDenied = core.recordRoutingProof({ actor: "belthazar", session: openOn("pending-adapter") }, { ...proofInput });
      expect(pendingDenied.ok).toBe(false);
      expect(pendingDenied.error?.code).toBe("EXECUTION_DENIED");
      // Approved submitter adapter for the same proof: allowed.
      expect(core.recordRoutingProof({ actor: "belthazar", session: openOn("test-adapter") }, { ...proofInput }).ok).toBe(true);
    } finally {
      restoreProofTty();
      core.close();
    }
  });

  it("revoking an adapter revokes its live sessions (cascade)", () => {
    const { core, sign, poPrivateKey, restoreTty: restoreCascadeTty } = clockedCore(T0);
    try {
      const { gaspar } = approvedModule(core, sign, poPrivateKey);
      const poAuth = { actor: "PO", session: bootstrapPrivilegedSession(core, "PO", poPrivateKey) };
      const entrypoint = join(tempDir, "fixture-runtime.sh");
      writeFileSync(entrypoint, "#!/bin/sh\necho ok\n");
      chmodSync(entrypoint, 0o755);
      const approveAdapter = (id: string, name: string): void => {
        expect(
          core.registerAdapter({ id, name, entrypoint, conformanceProof: ["fixture --version"] }, poAuth).ok
        ).toBe(true);
        const rev = core.adapterRegistrationHash(id);
        const sig = sign({
          action: "adapter-registration",
          scopeArtifactId: id,
          scopeRevision: rev,
          authority: "PO",
          rationale: "trust",
        });
        const rec = core.recordApproval({
          action: "adapter-registration",
          scopeArtifactId: id,
          scopeRevision: rev,
          authority: "PO",
          rationale: "trust",
          timestamp: sig.timestamp,
          signature: sig.signature,
        });
        expect(rec.ok).toBe(true);
        expect(core.approveAdapter(id, rec.value!.id, poAuth).ok).toBe(true);
      };
      approveAdapter("test-adapter", "Test adapter");
      approveAdapter("fixture", "Fixture");
      recordAttestations(core, gaspar, poPrivateKey, T0);
      const victim = openTestSession(core, "belthazar", "MOD-0001");
      const survivorRes = core.openSession(
        { role: "belthazar", adapter: "fixture", runtime: "test-runtime", scopeModule: "MOD-0001", ttlSeconds: 3600 },
        { interactive: true }
      );
      expect(survivorRes.ok).toBe(true);
      const survivor = { id: survivorRes.value!.id, token: survivorRes.value!.token };
      const rtkBin = join(tempDir, "fixture-rtk.sh");
      const proofInput = {
        adapterId: "fixture",
        binaryPath: rtkBin,
        version: "1.0.0-test",
        proofCommand: JSON.stringify([rtkBin, "gain"]),
        commandHash: computeRevisionHash([rtkBin, "gain"]),
        outputHash: computeRevisionHash("fixture gain ok"),
        exitStatus: 0,
        gainAvailable: true,
        timestamp: T0,
        ttlSeconds: 3600,
      } as const;
      // Pre-revocation the victim session submits for the other approved adapter.
      expect(core.recordRoutingProof({ actor: "belthazar", session: victim }, { ...proofInput }).ok).toBe(true);
      const revoked = core.revokeAdapter("test-adapter", poAuth);
      expect(revoked.ok).toBe(true);
      // The cascade count covers the victim plus the gaspar/PO sessions
      // bound to the revoked adapter.
      expect(revoked.value?.revokedSessions).toBeGreaterThanOrEqual(2);
      // The victim session is dead: protected operations deny as revoked.
      const dead = core.recordRoutingProof({ actor: "belthazar", session: victim }, { ...proofInput });
      expect(dead.ok).toBe(false);
      expect(dead.error?.code).toBe("EXECUTION_DENIED");
      expect(dead.error?.message ?? "").toContain("was revoked");
      // Delegation from the dead session fails: no privilege persistence.
      const child = core.openSession(
        { role: "lucca", adapter: "fixture", runtime: "test-runtime", scopeModule: "MOD-0001", ttlSeconds: 3600 },
        { parentSession: victim }
      );
      expect(child.ok).toBe(false);
      expect(child.error?.code).toBe("EXECUTION_DENIED");
      // Sessions of the surviving adapter are unaffected.
      expect(core.recordRoutingProof({ actor: "belthazar", session: survivor }, { ...proofInput }).ok).toBe(true);
    } finally {
      restoreCascadeTty();
      core.close();
    }
  });

  it("rejects cross-scope grant reuse", () => {
    const { core, sign, poPrivateKey, restoreTty: restoreScopeTty } = clockedCore(T0);
    try {
      const { grantId, gaspar } = approvedWithGrant(core, sign, poPrivateKey, "gaspar", "belthazar", T0);
      const ctx = { actor: "gaspar", session: gaspar.session };
      expect(
        core.registerModule("MOD-0002", "DRAFT", { id: "MOD-0002", name: "M2", purpose: "P", specs: ["SP-0001"] }, gaspar).ok
      ).toBe(true);
      expect(core.transitionState("MOD-0002", "ModulePlanned", ctx).ok).toBe(true);
      const rev = core.getArtifact("MOD-0002").revision;
      const { signature, timestamp } = sign({
        action: "module-approval",
        scopeArtifactId: "MOD-0002",
        scopeRevision: rev,
        authority: "PO",
        rationale: "go",
      });
      expect(
        core.recordApproval({
          action: "module-approval",
          scopeArtifactId: "MOD-0002",
          scopeRevision: rev,
          authority: "PO",
          rationale: "go",
          timestamp,
          signature,
        }).ok
      ).toBe(true);
      expect(core.transitionState("MOD-0002", "ModuleApproved", ctx).ok).toBe(true);
      // MOD-0001's grant presented for MOD-0002 by a MOD-0002-scoped
      // session → grant scope mismatch (not session scope).
      const worker2 = openTestSession(core, "belthazar", "MOD-0002");
      expect(
        core.transitionState("MOD-0002", "ExecutionStarted", { actor: "belthazar", session: worker2, grantId }).error?.code
      ).toBe("INCONSISTENT_REFERENCE");
    } finally {
      restoreScopeTty();
      core.close();
    }
  });
});

describe("Completion authorization", () => {
  let restoreTty: () => void;
  let tempDir: string;
  let core: ChronoCore;
  let sign: SignFn;
  let privateKeyPem: string;

  interface CompletionFixture {
    revision: string;
    gaspar: CallerAuth;
    belthazar: CallerAuth;
    lucca: CallerAuth;
    glenn: CallerAuth;
    spekkio: CallerAuth;
  }

  /** Drive MOD-0001 to VERIFYING with attestations current. */
  function verifyingModule(): CompletionFixture {
    const { gaspar } = approvedModule(core, sign, privateKeyPem);
    recordAttestations(core, gaspar, privateKeyPem);
    const glenn = { actor: "glenn", session: openTestSession(core, "glenn", "MOD-0001") };
    expect(core.recordSecurityProfile({ title: "P", threats: [] }, glenn).ok).toBe(true);
    const belthazar = { actor: "belthazar", session: openTestSession(core, "belthazar", "MOD-0001") };
    const lucca = { actor: "lucca", session: openTestSession(core, "lucca", "MOD-0001") };
    const spekkio = { actor: "spekkio", session: openTestSession(core, "spekkio", "MOD-0001") };
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
    return { revision: core.getArtifact("MOD-0001").revision, gaspar, belthazar, lucca, glenn, spekkio };
  }

  function authorizeWorkerStep(fx: CompletionFixture): string {
    const authz = core.authorizeExecution("MOD-0001", {
      actor: "belthazar",
      role: "belthazar",
      session: fx.belthazar.session,
    });
    expect(authz.ok).toBe(true);
    return authz.value!.grantId;
  }

  function authorizeVerdict(fx: CompletionFixture): string {
    const authz = core.authorizeExecution("MOD-0001", {
      actor: "spekkio",
      role: "spekkio",
      session: fx.spekkio.session,
    });
    expect(authz.ok).toBe(true);
    return authz.value!.grantId;
  }

  function passVerification(fx: CompletionFixture): void {
    testEvidence(core, fx.lucca, fx.revision, "unit");
    testEvidence(core, fx.glenn, fx.revision, "review");
    approve(core, sign, "implementation-security", "MOD-0001", fx.revision);
    expect(core.recordVerification("MOD-0001", "PASS", "spekkio", [], [], [], fx.spekkio).ok).toBe(true);
    const grantId = authorizeVerdict(fx);
    expect(
      core.transitionState("MOD-0001", "SpekkioPassed", { actor: "spekkio", session: fx.spekkio.session, grantId }).ok
    ).toBe(true);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-compl-test-"));
    core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    expect(core.init().ok).toBe(true);
    const pair = generateApprovalKeyPair();
    restoreTty = fakeInteractiveTerminal();
    enrollTestPo(core, pair);
    privateKeyPem = pair.privateKeyPem;
    sign = (fields) => ({
      timestamp: FIXED_TIME,
      signature: signApprovalPayload(buildApprovalPayload({ ...fields, timestamp: FIXED_TIME }), privateKeyPem),
    });
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

  it("denies completion without current evidence", () => {
    const fx = verifyingModule();
    approve(core, sign, "implementation-security", "MOD-0001", fx.revision);
    expect(core.recordVerification("MOD-0001", "PASS", "spekkio", [], [], [], fx.spekkio).ok).toBe(true);
    const grantId = authorizeVerdict(fx);
    expect(
      core.transitionState("MOD-0001", "SpekkioPassed", { actor: "spekkio", session: fx.spekkio.session, grantId }).ok
    ).toBe(true);
    const res = core.authorizeCompletion("MOD-0001", fx.gaspar);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("EVIDENCE_MISSING");
  });

  it("denies without a bound Spekkio PASS", () => {
    const fx = verifyingModule();
    const res = core.authorizeCompletion("MOD-0001", fx.gaspar);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("COMPLETION_DENIED");
  });

  it("completes the full lifecycle to COMPLETE", () => {
    const fx = verifyingModule();
    passVerification(fx);

    const authz = core.authorizeCompletion("MOD-0001", fx.gaspar);
    expect(authz.ok).toBe(true);

    const done = core.completeModule("MOD-0001", fx.gaspar);
    expect(done.ok).toBe(true);
    expect(done.value?.state).toBe("COMPLETE");
    expect(core.getArtifact("MOD-0001").status).toBe("COMPLETE");

    const status = core.status();
    expect(status.value?.state).toBe("COMPLETE");
    expect(core.validate().value?.valid).toBe(true);
  });

  it("denies with an open blocking defect, allows after correction", () => {
    const fx = verifyingModule();
    testEvidence(core, fx.lucca, fx.revision, "unit");
    testEvidence(core, fx.glenn, fx.revision, "review");
    approve(core, sign, "implementation-security", "MOD-0001", fx.revision);
    const defect = core.recordDefect(
      {
        classification: "IMPLEMENTATION_DEFECT",
        severity: "major",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: ["MOD-0001"],
        blockingScope: "MOD-0001",
        reproInfo: null,
      },
      fx.spekkio
    );
    expect(defect.ok).toBe(true);
    expect(core.recordVerification("MOD-0001", "FAILED", "spekkio", [defect.value!.id], [], [], fx.spekkio).ok).toBe(true);
    const failGrant = authorizeVerdict(fx);
    expect(
      core.transitionState("MOD-0001", "SpekkioFailed", { actor: "spekkio", session: fx.spekkio.session, grantId: failGrant }).ok
    ).toBe(true);

    // FAILED modules cannot complete.
    expect(core.authorizeCompletion("MOD-0001", fx.gaspar).ok).toBe(false);

    // Correct, re-verify, and complete (each forward step re-authorizes).
    expect(core.resolveDefect(defect.value!.id, fx.belthazar).ok).toBe(true);
    const correctGrant = authorizeWorkerStep(fx);
    expect(
      core.transitionState("MOD-0001", "CorrectionComplete", { actor: "belthazar", session: fx.belthazar.session, grantId: correctGrant }).ok
    ).toBe(true);
    const progressGrant = authorizeWorkerStep(fx);
    expect(
      core.transitionState("MOD-0001", "ImplementationComplete", { actor: "belthazar", session: fx.belthazar.session, grantId: progressGrant }).ok
    ).toBe(true);
    expect(core.recordVerification("MOD-0001", "PASS", "spekkio", [], [], [], fx.spekkio).ok).toBe(true);
    const passGrant = authorizeVerdict(fx);
    expect(
      core.transitionState("MOD-0001", "SpekkioPassed", { actor: "spekkio", session: fx.spekkio.session, grantId: passGrant }).ok
    ).toBe(true);
    expect(core.authorizeCompletion("MOD-0001", fx.gaspar).ok).toBe(true);
  });

  it("lets a valid waiver cover a security blocker at completion", () => {
    const fx = verifyingModule();
    const revision = fx.revision;
    passVerification(fx);
    expect(
      core.raiseBlocker("SECURITY_BLOCKER", ["MOD-0001"], "residual risk", fx.glenn).ok
    ).toBe(true);
    expect(core.authorizeCompletion("MOD-0001", fx.gaspar).error?.code).toBe("SECURITY_BLOCKER");

    // A waiver signed by the registered PO key, covering this revision,
    // lets completion proceed; WAIVED stays distinct from PASS.
    const waiverSig = signApprovalPayload(
      {
        action: "waiver",
        scope_artifact_id: "MOD-0001",
        scope_revision: revision,
        authority: "PO",
        issue: "residual risk",
        rationale: "accepted with monitoring",
        evidence_ref: null,
        compensating_controls: "monitor",
        follow_up_task_id: null,
        expiry_review_condition: "review in 30d",
        timestamp: FIXED_TIME,
      },
      privateKeyPem
    );
    const waived = core.recordWaiver({
      scopeArtifactId: "MOD-0001",
      scopeRevision: revision,
      authority: "PO",
      issue: "residual risk",
      rationale: "accepted with monitoring",
      evidenceRef: null,
      compensatingControls: "monitor",
      followUpTaskId: null,
      expiryReviewCondition: "review in 30d",
      timestamp: FIXED_TIME,
      signature: waiverSig,
    });
    expect(waived.ok).toBe(true);
    expect(core.authorizeCompletion("MOD-0001", fx.gaspar).ok).toBe(true);
  });
});
