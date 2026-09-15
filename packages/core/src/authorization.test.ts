/**
 * I9 tests — full execution/completion gates with explicit missing-
 * capability denials. Success is never returned after placeholder checks.
 * [CORE §7.4/§7.6, DOM §6.4/§6.6, Remediation §5]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import Database from "better-sqlite3";
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
  managedAssetInventory,
  signApprovalPayload,
  skillGeneratedHashes,
  skillVendorPath,
  RTK_UPSTREAM,
  SKILL_UPSTREAM,
} from "@chrono/domain";
import { ChronoCore, type CallerAuth } from "./chrono-core.js";
import { ChronoDatabase, SCHEMA_VERSION } from "@chrono/persistence";

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
 * Install the managed-asset inventory for a fixture adapter so a
 * candidate proof can be promoted (promotion snapshots the manifest
 * hash; dispatch re-validates it). `exact` entries carry fixture bytes,
 * `marker` entries carry their marker string.
 */
function installManagedProofAssets(projectPath: string, adapterId: string): void {
  for (const spec of managedAssetInventory(adapterId)) {
    const target = join(projectPath, spec.path);
    mkdirSync(dirname(target), { recursive: true });
    const content =
      spec.kind === "marker" ? `fixture-managed ${spec.marker ?? spec.path}\n` : `fixture-managed ${spec.path}\n`;
    writeFileSync(target, content, "utf8");
  }
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
    preRoutingCommand: JSON.stringify(["ls", root]),
    commandHash: computeRevisionHash([rtkBin, "gain"]),
    outputHash: computeRevisionHash("fixture gain ok"),
    exitStatus: 0,
    gainAvailable: true,
    timestamp,
    ttlSeconds: 3600,
  });
  expect(proof.ok).toBe(true);
  // Recorded proofs are non-authoritative candidates: promotion after
  // the signed approval above is what authorizes dispatch [ADR-006].
  installManagedProofAssets(root, "test-adapter");
  const promoted = core.promoteRoutingProof(proof.value!.id, po);
  expect(promoted.ok).toBe(true);
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
    for (const role of ["gaspar", "PO", "mallory"]) {
      const res = core.authorizeExecution("MOD-0001", { actor: "gaspar", role, session: worker });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("VALIDATION_ERROR");
    }
    // Glenn is assignable (security-review only) but not through
    // another role's session: the executor binding check denies.
    const glenn = core.authorizeExecution("MOD-0001", { actor: "gaspar", role: "glenn", session: worker });
    expect(glenn.ok).toBe(false);
    expect(["INCONSISTENT_REFERENCE", "EXECUTION_DENIED"]).toContain(glenn.error?.code);
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
      recordAttestations(core, gaspar, poPrivateKey, T0);
      const rtkBin = join(tempDir, "fixture-rtk.sh");
      const fixtureProofCommand = JSON.stringify([rtkBin, "gain"]);
      const recordedProof = core.recordRoutingProof(gaspar, {
        adapterId: "fixture",
        binaryPath: rtkBin,
        version: "1.0.0-test",
        proofCommand: fixtureProofCommand,
        preRoutingCommand: JSON.stringify(["ls", tempDir]),
        commandHash: computeRevisionHash([rtkBin, "gain"]),
        outputHash: computeRevisionHash("fixture gain ok"),
        exitStatus: 0,
        gainAvailable: true,
        timestamp: T0,
        ttlSeconds: 3600,
      });
      expect(recordedProof.ok).toBe(true);
      installManagedProofAssets(tempDir, "fixture");
      expect(core.promoteRoutingProof(recordedProof.value!.id, poAuth).ok).toBe(true);
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
        preRoutingCommand: JSON.stringify(["ls", tempDir]),
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

  it("records proofs pre-registration but never authorizes dispatch with them", () => {
    // Evidence precedes approval by design (setup proves routing before
    // the PO approves adapters). Recording succeeds for a merely
    // registered (pending) adapter; dispatch still denies until active.
    const { core, sign, poPrivateKey, restoreTty: restorePendingTty } = clockedCore(T0);
    try {
      const { gaspar } = approvedModule(core, sign, poPrivateKey);
      const poAuth = { actor: "PO", session: bootstrapPrivilegedSession(core, "PO", poPrivateKey) };
      const entrypoint = join(tempDir, "fixture-runtime.sh");
      writeFileSync(entrypoint, "#!/bin/sh\necho ok\n");
      chmodSync(entrypoint, 0o755);
      expect(
        core.registerAdapter(
          { id: "pending-ad", name: "Pending", entrypoint, conformanceProof: ["fixture --version"] },
          poAuth
        ).ok
      ).toBe(true);
      recordAttestations(core, gaspar, poPrivateKey, T0);
      const rtkBin = join(tempDir, "fixture-rtk.sh");
      const recorded = core.recordRoutingProof(gaspar, {
        adapterId: "pending-ad",
        binaryPath: rtkBin,
        version: "1.0.0-test",
        proofCommand: JSON.stringify([rtkBin, "gain"]),
        preRoutingCommand: JSON.stringify(["ls", tempDir]),
        commandHash: computeRevisionHash([rtkBin, "gain"]),
        outputHash: computeRevisionHash("fixture gain ok"),
        exitStatus: 0,
        gainAvailable: true,
        timestamp: T0,
        ttlSeconds: 3600,
      });
      expect(recorded.ok).toBe(true);
      const worker = openTestSession(core, "belthazar", "MOD-0001");
      const denied = core.authorizeExecution("MOD-0001", {
        actor: "gaspar",
        role: "belthazar",
        session: worker,
        requesterSession: gaspar.session,
        adapterId: "pending-ad",
      });
      expect(denied.ok).toBe(false);
      expect(denied.error?.code).toBe("RTK_ROUTING_FAILURE");
      expect(denied.error?.message ?? "").toContain("pending-ad");
    } finally {
      restorePendingTty();
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

    // Completion is idempotent: repeating it re-reports COMPLETE
    // without minting grants or re-running transitions.
    const again = core.completeModule("MOD-0001", fx.gaspar);
    expect(again.ok).toBe(true);
    expect(again.value?.state).toBe("COMPLETE");

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

    // Resolving around the open correction loop denies: the loop owns
    // the defect until its fix is evidenced and re-verified.
    expect(core.resolveDefect(defect.value!.id, fx.belthazar).ok).toBe(false);

    // Governed correction: dispatch the correction through the loop
    // (claim enacts CorrectionComplete and binds the loop), evidence
    // the fix, complete the loop, then re-verify and resolve.
    const correction = core.requestDispatch(
      { moduleId: "MOD-0001", kind: "correction", rationale: "fix the implementation defect", adapterId: undefined },
      fx.gaspar
    );
    expect(correction.ok).toBe(true);
    expect(
      core.recordTaskDelegation({ agent: "belthazar", parentRuntimeSession: "opencode-parent-1" }, fx.gaspar).ok
    ).toBe(true);
    const claimed = core.claimDispatch(
      { dispatchId: correction.value!.dispatchId, childRuntimeSession: "opencode-child-1" },
      fx.gaspar
    );
    expect(claimed.ok).toBe(true);
    const looped = core.openCorrectionLoop(defect.value!.id, fx.gaspar);
    expect(looped.ok).toBe(false);
    expect(looped.error?.code).toBe("DUPLICATE_IDENTITY");
    const loops = core.nextAction({ moduleId: "MOD-0001" }, fx.gaspar);
    expect(loops.ok).toBe(true);
    expect(loops.value!.action).toBe("correct-defect");
    const fixEvidence = testEvidence(core, fx.belthazar, fx.revision, "fix");
    expect(fixEvidence.length).toBeGreaterThan(0);
    const openLoop = core.nextAction({ moduleId: "MOD-0001" }, fx.gaspar).value!.summary;
    const loopMatch = /'(COR-[0-9]+)'/.exec(openLoop);
    expect(loopMatch).not.toBe(null);
    expect(core.completeCorrectionLoop(loopMatch![1]!, fx.belthazar).ok).toBe(true);
    // Pre-correction proof went stale with the loop: re-record the
    // completion evidence the profile requires, then re-verify.
    testEvidence(core, fx.lucca, fx.revision, "unit");
    testEvidence(core, fx.glenn, fx.revision, "review");
    const progressGrant = authorizeWorkerStep(fx);
    expect(
      core.transitionState("MOD-0001", "ImplementationComplete", { actor: "belthazar", session: fx.belthazar.session, grantId: progressGrant }).ok
    ).toBe(true);
    expect(core.recordVerification("MOD-0001", "PASS", "spekkio", [], [], [], fx.spekkio).ok).toBe(true);
    const passGrant = authorizeVerdict(fx);
    expect(
      core.transitionState("MOD-0001", "SpekkioPassed", { actor: "spekkio", session: fx.spekkio.session, grantId: passGrant }).ok
    ).toBe(true);
    expect(core.resolveDefect(defect.value!.id, fx.belthazar).ok).toBe(true);
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

describe("Routing proof authority (candidate promotes to authoritative)", () => {
  // Adversarial coverage for FIXES-SL-10.1 C2/C3 [ADR-006]: recorded
  // proofs are non-authoritative candidates; only promotion after signed
  // adapter approval authorizes dispatch, and every binding (attestation,
  // binary, registration, assets, TTL, scope) re-validates per use.
  let tempDir: string;
  const T0 = "2026-09-11T00:00:00.000Z";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-proof-auth-test-"));
  });

  afterEach(() => {
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function harness(projectRuntime: string | null = "test-runtime"): {
    core: ChronoCore;
    clockRef: { now: string };
    sign: SignFn;
    privateKeyPem: string;
    restoreTty: () => void;
  } {
    const clockRef = { now: T0 };
    const restoreTty = fakeInteractiveTerminal();
    const core = new ChronoCore({ projectPath: tempDir, runtime: projectRuntime, clock: () => clockRef.now });
    expect(core.init().ok).toBe(true);
    const pair = generateApprovalKeyPair();
    enrollTestPo(core, pair, T0);
    const sign: SignFn = (fields) => ({
      timestamp: FIXED_TIME,
      signature: signApprovalPayload(
        buildApprovalPayload({ ...fields, timestamp: FIXED_TIME }),
        pair.privateKeyPem
      ),
    });
    return { core, clockRef, sign, privateKeyPem: pair.privateKeyPem, restoreTty };
  }

  function approveSecondAdapter(
    core: ChronoCore,
    po: CallerAuth,
    sign: SignFn,
    id: string
  ): void {
    const entrypoint = join(tempDir, `${id}.sh`);
    writeFileSync(entrypoint, "#!/bin/sh\necho ok\n");
    chmodSync(entrypoint, 0o755);
    expect(
      core.registerAdapter(
        { id, name: id, entrypoint, conformanceProof: [`${id} --version`] },
        po
      ).ok
    ).toBe(true);
    approve(core, sign, "adapter-registration", id, core.adapterRegistrationHash(id));
    const approvals = core.listEvents().filter((e) => e.eventType === "ApprovalGranted");
    expect(
      core.approveAdapter(id, approvals[approvals.length - 1]!.entityId, po).ok
    ).toBe(true);
  }

  function recordCandidate(core: ChronoCore, submitter: CallerAuth, adapterId: string, ttlSeconds = 3600, timestamp = T0): string {
    const rtkBin = join(tempDir, "fixture-rtk.sh");
    const pre = ["ls", tempDir];
    const routed = [rtkBin, "ls", tempDir];
    const res = core.recordRoutingProof(submitter, {
      adapterId,
      binaryPath: rtkBin,
      version: "1.0.0-test",
      proofCommand: JSON.stringify(routed),
      preRoutingCommand: JSON.stringify(pre),
      commandHash: computeRevisionHash({ pre, routed }),
      outputHash: computeRevisionHash("fixture routed ok"),
      exitStatus: 0,
      gainAvailable: true,
      timestamp,
      ttlSeconds,
    });
    expect(res.ok).toBe(true);
    return res.value!.id;
  }

  function openWorker(core: ChronoCore, adapterId: string, runtime: string): { id: string; token: string } {
    const res = core.openSession(
      { role: "belthazar", adapter: adapterId, runtime, scopeModule: "MOD-0001", ttlSeconds: 3600 },
      { interactive: true }
    );
    expect(res.ok).toBe(true);
    return { id: res.value!.id, token: res.value!.token };
  }

  function dispatch(
    core: ChronoCore,
    gaspar: CallerAuth,
    adapterId: string,
    runtime = "test-runtime"
  ): { ok: boolean; code?: string | undefined; message?: string | undefined } {
    const worker = openWorker(core, adapterId, runtime);
    const res = core.authorizeExecution("MOD-0001", {
      actor: "gaspar",
      role: "belthazar",
      session: worker,
      requesterSession: gaspar.session,
      adapterId,
    });
    if (res.ok) {
      return { ok: true };
    }
    return { ok: false, code: res.error?.code, message: res.error?.message ?? "" };
  }

  it("candidate proofs deny dispatch until promoted, then authorize", () => {
    const h = harness();
    try {
      const { gaspar } = approvedModule(h.core, h.sign, h.privateKeyPem);
      const po = { actor: "PO", session: bootstrapPrivilegedSession(h.core, "PO", h.privateKeyPem) };
      recordAttestations(h.core, gaspar, h.privateKeyPem, T0);
      approveSecondAdapter(h.core, po, h.sign, "route-ad");
      const id = recordCandidate(h.core, gaspar, "route-ad");
      const denied = dispatch(h.core, gaspar, "route-ad");
      expect(denied.ok).toBe(false);
      expect(denied.code).toBe("RTK_ROUTING_FAILURE");
      expect(denied.message ?? "").toContain("non-authoritative candidate");
      expect(denied.message ?? "").toContain("route-ad");
      installManagedProofAssets(tempDir, "route-ad");
      expect(h.core.promoteRoutingProof(id, po).ok).toBe(true);
      expect(dispatch(h.core, gaspar, "route-ad").ok).toBe(true);
    } finally {
      h.restoreTty();
      h.core.close();
    }
  });

  it("promotion requires signed adapter approval", () => {
    const h = harness();
    try {
      const { gaspar } = approvedModule(h.core, h.sign, h.privateKeyPem);
      const po = { actor: "PO", session: bootstrapPrivilegedSession(h.core, "PO", h.privateKeyPem) };
      recordAttestations(h.core, gaspar, h.privateKeyPem, T0);
      const entrypoint = join(tempDir, "pending-ad.sh");
      writeFileSync(entrypoint, "#!/bin/sh\necho ok\n");
      chmodSync(entrypoint, 0o755);
      expect(
        h.core.registerAdapter(
          { id: "pending-ad", name: "Pending", entrypoint, conformanceProof: ["pending-ad --version"] },
          po
        ).ok
      ).toBe(true);
      const id = recordCandidate(h.core, gaspar, "pending-ad");
      const promoted = h.core.promoteRoutingProof(id, po);
      expect(promoted.ok).toBe(false);
      expect(promoted.error?.code).toBe("EXECUTION_DENIED");
      expect(promoted.error?.message ?? "").toContain("pending");
    } finally {
      h.restoreTty();
      h.core.close();
    }
  });

  it("promotion is PO-only and idempotent", () => {
    const h = harness();
    try {
      const { gaspar } = approvedModule(h.core, h.sign, h.privateKeyPem);
      const po = { actor: "PO", session: bootstrapPrivilegedSession(h.core, "PO", h.privateKeyPem) };
      recordAttestations(h.core, gaspar, h.privateKeyPem, T0);
      approveSecondAdapter(h.core, po, h.sign, "route-ad");
      const id = recordCandidate(h.core, gaspar, "route-ad");
      const gasparPromote = h.core.promoteRoutingProof(id, gaspar);
      expect(gasparPromote.ok).toBe(false);
      expect(gasparPromote.error?.code).toBe("EXECUTION_DENIED");
      installManagedProofAssets(tempDir, "route-ad");
      const first = h.core.promoteRoutingProof(id, po);
      expect(first.ok).toBe(true);
      const second = h.core.promoteRoutingProof(id, po);
      expect(second.ok).toBe(true);
      expect(second.value?.id).toBe(first.value?.id);
    } finally {
      h.restoreTty();
      h.core.close();
    }
  });

  it("promotion denies a superseded attestation", () => {
    const h = harness();
    try {
      const { gaspar } = approvedModule(h.core, h.sign, h.privateKeyPem);
      const po = { actor: "PO", session: bootstrapPrivilegedSession(h.core, "PO", h.privateKeyPem) };
      recordAttestations(h.core, gaspar, h.privateKeyPem, T0);
      approveSecondAdapter(h.core, po, h.sign, "route-ad");
      const id = recordCandidate(h.core, gaspar, "route-ad");
      const rtkBin = join(tempDir, "fixture-rtk.sh");
      expect(
        h.core.recordRtkAttestation(gaspar, {
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
      installManagedProofAssets(tempDir, "route-ad");
      const promoted = h.core.promoteRoutingProof(id, po);
      expect(promoted.ok).toBe(false);
      expect(promoted.error?.code).toBe("RTK_ROUTING_FAILURE");
      expect(promoted.error?.message ?? "").toContain("attestation");
    } finally {
      h.restoreTty();
      h.core.close();
    }
  });

  it("promotion denies a binary replaced since the proof", () => {
    const h = harness();
    try {
      const { gaspar } = approvedModule(h.core, h.sign, h.privateKeyPem);
      const po = { actor: "PO", session: bootstrapPrivilegedSession(h.core, "PO", h.privateKeyPem) };
      recordAttestations(h.core, gaspar, h.privateKeyPem, T0);
      approveSecondAdapter(h.core, po, h.sign, "route-ad");
      const id = recordCandidate(h.core, gaspar, "route-ad");
      const rtkBin = join(tempDir, "fixture-rtk.sh");
      writeFileSync(rtkBin, "#!/bin/sh\necho fixture-rtk REPLACED\n", "utf8");
      installManagedProofAssets(tempDir, "route-ad");
      const promoted = h.core.promoteRoutingProof(id, po);
      expect(promoted.ok).toBe(false);
      expect(promoted.error?.code).toBe("RTK_ROUTING_FAILURE");
      expect(promoted.error?.message ?? "").toContain("changed since the proof");
    } finally {
      h.restoreTty();
      h.core.close();
    }
  });

  it("dispatch denies an expired proof", () => {
    const h = harness();
    try {
      const { gaspar } = approvedModule(h.core, h.sign, h.privateKeyPem);
      const po = { actor: "PO", session: bootstrapPrivilegedSession(h.core, "PO", h.privateKeyPem) };
      recordAttestations(h.core, gaspar, h.privateKeyPem, T0);
      approveSecondAdapter(h.core, po, h.sign, "route-ad");
      const id = recordCandidate(h.core, gaspar, "route-ad", 1);
      installManagedProofAssets(tempDir, "route-ad");
      expect(h.core.promoteRoutingProof(id, po).ok).toBe(true);
      h.clockRef.now = new Date(Date.parse(T0) + 2000).toISOString();
      const denied = dispatch(h.core, gaspar, "route-ad");
      expect(denied.ok).toBe(false);
      expect(denied.code).toBe("RTK_ROUTING_FAILURE");
      expect(denied.message ?? "").toContain("expired");
    } finally {
      h.restoreTty();
      h.core.close();
    }
  });

  it("dispatch denies a binary replaced after promotion", () => {
    const h = harness();
    try {
      const { gaspar } = approvedModule(h.core, h.sign, h.privateKeyPem);
      const po = { actor: "PO", session: bootstrapPrivilegedSession(h.core, "PO", h.privateKeyPem) };
      recordAttestations(h.core, gaspar, h.privateKeyPem, T0);
      approveSecondAdapter(h.core, po, h.sign, "route-ad");
      const id = recordCandidate(h.core, gaspar, "route-ad");
      installManagedProofAssets(tempDir, "route-ad");
      expect(h.core.promoteRoutingProof(id, po).ok).toBe(true);
      expect(dispatch(h.core, gaspar, "route-ad").ok).toBe(true);
      writeFileSync(join(tempDir, "fixture-rtk.sh"), "#!/bin/sh\necho fixture-rtk REPLACED\n", "utf8");
      const denied = dispatch(h.core, gaspar, "route-ad");
      expect(denied.ok).toBe(false);
      expect(denied.code).toBe("RTK_ROUTING_FAILURE");
      expect(denied.message ?? "").toContain("changed since the proof");
    } finally {
      h.restoreTty();
      h.core.close();
    }
  });

  it("dispatch denies managed-asset drift after promotion", () => {
    const h = harness();
    try {
      const { gaspar } = approvedModule(h.core, h.sign, h.privateKeyPem);
      const po = { actor: "PO", session: bootstrapPrivilegedSession(h.core, "PO", h.privateKeyPem) };
      recordAttestations(h.core, gaspar, h.privateKeyPem, T0);
      approveSecondAdapter(h.core, po, h.sign, "route-ad");
      const id = recordCandidate(h.core, gaspar, "route-ad");
      installManagedProofAssets(tempDir, "route-ad");
      expect(h.core.promoteRoutingProof(id, po).ok).toBe(true);
      expect(dispatch(h.core, gaspar, "route-ad").ok).toBe(true);
      writeFileSync(join(tempDir, ".opencode", "plugins", "chrono-gate.js"), "tampered-by-test\n", "utf8");
      const denied = dispatch(h.core, gaspar, "route-ad");
      expect(denied.ok).toBe(false);
      expect(denied.code).toBe("RTK_ROUTING_FAILURE");
      expect(denied.message ?? "").toContain("managed-asset drift");
    } finally {
      h.restoreTty();
      h.core.close();
    }
  });

  it("dispatch denies adapter re-registration after promotion", () => {
    const h = harness();
    try {
      const { gaspar } = approvedModule(h.core, h.sign, h.privateKeyPem);
      const po = { actor: "PO", session: bootstrapPrivilegedSession(h.core, "PO", h.privateKeyPem) };
      recordAttestations(h.core, gaspar, h.privateKeyPem, T0);
      approveSecondAdapter(h.core, po, h.sign, "route-ad");
      const id = recordCandidate(h.core, gaspar, "route-ad");
      installManagedProofAssets(tempDir, "route-ad");
      expect(h.core.promoteRoutingProof(id, po).ok).toBe(true);
      expect(dispatch(h.core, gaspar, "route-ad").ok).toBe(true);
      // Simulate re-registration drift: the entrypoint moves to another
      // live executable, so dispatch stays executable but the
      // registration hash no longer matches the promotion snapshot.
      const moved = join(tempDir, "route-ad-moved.sh");
      writeFileSync(moved, "#!/bin/sh\necho moved\n", "utf8");
      chmodSync(moved, 0o755);
      const raw = new Database(join(tempDir, ".chrono", "chrono.db"));
      try {
        raw.prepare("UPDATE adapter SET entrypoint = ? WHERE id = ?").run(moved, "route-ad");
      } finally {
        raw.close();
      }
      const denied = dispatch(h.core, gaspar, "route-ad");
      expect(denied.ok).toBe(false);
      expect(denied.code).toBe("RTK_ROUTING_FAILURE");
      expect(denied.message ?? "").toContain("current adapter registration");
    } finally {
      h.restoreTty();
      h.core.close();
    }
  });

  it("dispatch denies cross-runtime and cross-adapter proof reuse", () => {
    const h = harness();
    try {
      const { gaspar } = approvedModule(h.core, h.sign, h.privateKeyPem);
      const po = { actor: "PO", session: bootstrapPrivilegedSession(h.core, "PO", h.privateKeyPem) };
      // recordAttestations provisions + promotes a proof for
      // test-adapter under test-runtime only.
      recordAttestations(h.core, gaspar, h.privateKeyPem, T0);
      expect(dispatch(h.core, gaspar, "test-adapter", "test-runtime").ok).toBe(true);
      // Cross-runtime: the project pin bars foreign-runtime sessions at
      // open, so no foreign session can even present the proof scope.
      const foreign = h.core.openSession(
        { role: "belthazar", adapter: "test-adapter", runtime: "other-runtime", scopeModule: "MOD-0001", ttlSeconds: 3600 },
        { interactive: true }
      );
      expect(foreign.ok).toBe(false);
      expect(foreign.error?.code).toBe("INCONSISTENT_REFERENCE");
      // Cross-adapter: a live session on the approved second adapter has
      // no proof in its own scope, so lookup denies.
      approveSecondAdapter(h.core, po, h.sign, "route-ad");
      const otherAdapter = dispatch(h.core, gaspar, "route-ad", "test-runtime");
      expect(otherAdapter.ok).toBe(false);
      expect(otherAdapter.code).toBe("RTK_ROUTING_FAILURE");
      expect(otherAdapter.message ?? "").toContain("no current RTK routing proof");
    } finally {
      h.restoreTty();
      h.core.close();
    }
  });

  it("identity-only and already-routed inputs never reach the Core as proofs", () => {
    // The CLI rejects these before recording (covered in rtk-cli
    // tests); the Core additionally binds the pre-routing input so a
    // smuggled identity-only routed command is auditable as evidence,
    // not authority: a candidate alone never dispatches.
    const h = harness();
    try {
      const { gaspar } = approvedModule(h.core, h.sign, h.privateKeyPem);
      const po = { actor: "PO", session: bootstrapPrivilegedSession(h.core, "PO", h.privateKeyPem) };
      recordAttestations(h.core, gaspar, h.privateKeyPem, T0);
      approveSecondAdapter(h.core, po, h.sign, "route-ad");
      const rtkBin = join(tempDir, "fixture-rtk.sh");
      const res = h.core.recordRoutingProof(gaspar, {
        adapterId: "route-ad",
        binaryPath: rtkBin,
        version: "1.0.0-test",
        proofCommand: JSON.stringify([rtkBin, "gain"]),
        preRoutingCommand: JSON.stringify(["gain"]),
        commandHash: computeRevisionHash({ pre: ["gain"], routed: [rtkBin, "gain"] }),
        outputHash: computeRevisionHash("fixture gain ok"),
        exitStatus: 0,
        gainAvailable: true,
        timestamp: T0,
        ttlSeconds: 3600,
      });
      // Recording is evidence, not authority: it succeeds, but the
      // candidate authorizes nothing and promotion still requires the
      // full approval + manifest bindings.
      expect(res.ok).toBe(true);
      expect(dispatch(h.core, gaspar, "route-ad").ok).toBe(false);
    } finally {
      h.restoreTty();
      h.core.close();
    }
  });

  it("rolls back promotion when the audit event cannot persist (OC-P2)", () => {
    // Promotion and its ProofPromoted audit event must commit
    // atomically: an authoritative proof without its audit event is a
    // silent authority mint. Sabotage the event store and require the
    // row to stay a candidate.
    const h = harness();
    try {
      const { gaspar } = approvedModule(h.core, h.sign, h.privateKeyPem);
      const po = { actor: "PO", session: bootstrapPrivilegedSession(h.core, "PO", h.privateKeyPem) };
      recordAttestations(h.core, gaspar, h.privateKeyPem, T0);
      approveSecondAdapter(h.core, po, h.sign, "route-ad");
      const id = recordCandidate(h.core, gaspar, "route-ad");
      installManagedProofAssets(tempDir, "route-ad");
      const raw = new Database(join(tempDir, ".chrono", "chrono.db"));
      try {
        raw.exec("DROP TABLE event_log");
      } finally {
        raw.close();
      }
      const promoted = h.core.promoteRoutingProof(id, po);
      expect(promoted.ok).toBe(false);
      const scopes = h.core.routingProofScopes("route-ad");
      expect(scopes.find((proof) => proof.id === id)?.authority).toBe("candidate");
    } finally {
      h.restoreTty();
      h.core.close();
    }
  });

  it("emits exactly one audit event across repeated promotions (OC-P2)", () => {
    const h = harness();
    try {
      const { gaspar } = approvedModule(h.core, h.sign, h.privateKeyPem);
      const po = { actor: "PO", session: bootstrapPrivilegedSession(h.core, "PO", h.privateKeyPem) };
      recordAttestations(h.core, gaspar, h.privateKeyPem, T0);
      approveSecondAdapter(h.core, po, h.sign, "route-ad");
      const id = recordCandidate(h.core, gaspar, "route-ad");
      installManagedProofAssets(tempDir, "route-ad");
      expect(h.core.promoteRoutingProof(id, po).ok).toBe(true);
      expect(h.core.promoteRoutingProof(id, po).ok).toBe(true);
      const promotions = h.core.listEvents().filter((e) => e.eventType === "ProofPromoted" && e.entityId === id);
      expect(promotions).toHaveLength(1);
    } finally {
      h.restoreTty();
      h.core.close();
    }
  });

  it("resolves concurrent promotion on two connections to one event (OC-P2)", () => {
    // better-sqlite3 serializes writers; whichever handle lands first
    // applies the transition, the loser observes the authoritative row
    // and emits nothing. Either order yields exactly one audit event.
    const h = harness();
    let second: ChronoCore | null = null;
    try {
      const { gaspar } = approvedModule(h.core, h.sign, h.privateKeyPem);
      const po = { actor: "PO", session: bootstrapPrivilegedSession(h.core, "PO", h.privateKeyPem) };
      recordAttestations(h.core, gaspar, h.privateKeyPem, T0);
      approveSecondAdapter(h.core, po, h.sign, "route-ad");
      const id = recordCandidate(h.core, gaspar, "route-ad");
      installManagedProofAssets(tempDir, "route-ad");
      second = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime", clock: () => T0 });
      expect(h.core.promoteRoutingProof(id, po).ok).toBe(true);
      expect(second.promoteRoutingProof(id, po).ok).toBe(true);
      const firstEvents = h.core.listEvents().filter((e) => e.eventType === "ProofPromoted" && e.entityId === id);
      const secondEvents = second.listEvents().filter((e) => e.eventType === "ProofPromoted" && e.entityId === id);
      expect(firstEvents).toHaveLength(1);
      expect(secondEvents).toHaveLength(1);
      expect(second.routingProofScopes("route-ad").find((proof) => proof.id === id)?.authority).toBe(
        "authoritative"
      );
    } finally {
      h.restoreTty();
      h.core.close();
      second?.close();
    }
  });
});

describe.each([11, 12])("Routing proof migration (v%i → current)", (baseline) => {
  // FIXES-SL-10.1 C3 review evidence: routing_proof rows written under
  // schema v11/v12 (no authority columns) migrate with evidence intact,
  // default to non-authoritative CANDIDATE (never accidentally
  // AUTHORITATIVE), and remain promotable after signed approval with
  // current bindings — so dispatch denies before promotion and
  // authorizes after.
  let tempDir: string;
  const T0 = "2026-09-11T00:00:00.000Z";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-proof-mig-test-"));
  });

  afterEach(() => {
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function dbPath(): string {
    return join(tempDir, ".chrono", "chrono.db");
  }

  function seedVintageDb(): { applied: number[] } {
    mkdirSync(join(tempDir, ".chrono"), { recursive: true });
    const rtkBin = join(tempDir, "fixture-rtk.sh");
    writeFileSync(rtkBin, "#!/bin/sh\necho fixture-rtk 1.0.0-test\n", "utf8");
    chmodSync(rtkBin, 0o755);
    const binaryHash = createHash("sha256").update(readFileSync(rtkBin)).digest("hex");
    const migrator = new ChronoDatabase({ path: dbPath() });
    try {
      migrator.migrate(baseline);
    } finally {
      migrator.close();
    }
    const raw = new Database(dbPath());
    try {
      raw
        .prepare(
          "INSERT INTO rtk_attestation (id, binary_path, binary_identity, version, provenance, integration_mode, routing_test_passed, routing_test_log, gained, savings_evidence, bypass_events, valid_until, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          "RTK-0001", rtkBin, "rtk-test", "1.0.0-test", RTK_UPSTREAM, "test", 1, "fixture", 1, null, "[]",
          "2026-09-12T00:00:00.000Z", "current"
        );
      raw
        .prepare(
          "INSERT INTO routing_proof (id, adapter_id, runtime, session_id, project_id, rtk_attestation_id, binary_path, binary_hash, version, proof_command, command_hash, output_hash, exit_status, gain_available, timestamp, valid_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          "RTE-0001", "test-adapter", "test-runtime", "SES-0001", "default", "RTK-0001", rtkBin, binaryHash,
          "1.0.0-test", JSON.stringify([rtkBin, "gain"]), `sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`,
          0, 1, T0, "2026-09-12T00:00:00.000Z"
        );
      const skillContent = "fixture-skill for migration evidence";
      const vendorTarget = join(tempDir, skillVendorPath("test-pin"));
      mkdirSync(dirname(vendorTarget), { recursive: true });
      writeFileSync(vendorTarget, skillContent, "utf8");
      for (const runtime of ["claude", "opencode", "kiro"] as const) {
        const target = join(tempDir, SKILL_RUNTIME_PATHS[runtime]);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, skillContent, "utf8");
      }
      raw
        .prepare(
          "INSERT INTO skill_attestation (id, upstream, pinned_commit, source_hash, generated_hashes, converter_version, license_status, attribution, runtime_identity, agent_identity, discovery_result, permission_result, activation_test_passed, bypass_events, valid_until, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          "SKL-0001", SKILL_UPSTREAM, "test-pin", hashSkillSource(skillContent),
          skillGeneratedHashes(convertSkillSource(skillContent)), SKILL_RELEASE.converterVersion,
          "MIT", "test", "test", "test", "found", "granted", 1, "[]", "2026-09-12T00:00:00.000Z", "current"
        );
    } finally {
      raw.close();
    }
    const finisher = new ChronoDatabase({ path: dbPath() });
    try {
      return { applied: finisher.migrate().map((m) => m.version) };
    } finally {
      finisher.close();
    }
  }

  function migratedHarness(): {
    core: ChronoCore;
    privateKeyPem: string;
    gaspar: CallerAuth;
    po: CallerAuth;
    restoreTty: () => void;
  } {
    const restoreTty = fakeInteractiveTerminal();
    const core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime", clock: () => T0 });
    expect(core.init().ok).toBe(true);
    const pair = generateApprovalKeyPair();
    enrollTestPo(core, pair, T0);
    const sign: SignFn = (fields) => ({
      timestamp: FIXED_TIME,
      signature: signApprovalPayload(
        buildApprovalPayload({ ...fields, timestamp: FIXED_TIME }),
        pair.privateKeyPem
      ),
    });
    const { gaspar } = approvedModule(core, sign, pair.privateKeyPem);
    const po = { actor: "PO", session: bootstrapPrivilegedSession(core, "PO", pair.privateKeyPem) };
    const entrypoint = join(tempDir, "fixture-runtime.sh");
    writeFileSync(entrypoint, "#!/bin/sh\necho fixture-ok\n", "utf8");
    chmodSync(entrypoint, 0o755);
    expect(
      core.registerAdapter(
        { id: "test-adapter", name: "Test adapter", entrypoint, conformanceProof: ["test-adapter --version"] },
        po
      ).ok
    ).toBe(true);
    const revision = core.adapterRegistrationHash("test-adapter");
    const approval = core.recordApproval({
      action: "adapter-registration",
      scopeArtifactId: "test-adapter",
      scopeRevision: revision,
      authority: "PO",
      rationale: "migration test",
      timestamp: FIXED_TIME,
      signature: sign({
        action: "adapter-registration",
        scopeArtifactId: "test-adapter",
        scopeRevision: revision,
        authority: "PO",
        rationale: "migration test",
      }).signature,
    });
    expect(approval.ok).toBe(true);
    expect(core.approveAdapter("test-adapter", approval.value!.id, po).ok).toBe(true);
    installManagedProofAssets(tempDir, "test-adapter");
    return { core, privateKeyPem: pair.privateKeyPem, gaspar, po, restoreTty };
  }

  it("preserves vintage rows as non-authoritative candidates", () => {
    const { applied } = seedVintageDb();
    expect(applied[applied.length - 1]).toBe(SCHEMA_VERSION);
    const db = new ChronoDatabase({ path: dbPath() });
    try {
      const row = db.routingProofs().findById("RTE-0001");
      // Evidence intact.
      expect(row.adapterId).toBe("test-adapter");
      expect(row.binaryPath).toBe(join(tempDir, "fixture-rtk.sh"));
      expect(row.rtkAttestationId).toBe("RTK-0001");
      expect(row.commandHash).toBe(`sha256:${"a".repeat(64)}`);
      expect(row.outputHash).toBe(`sha256:${"b".repeat(64)}`);
      // Fail-closed defaults: candidate, no snapshots, empty pre-routing.
      expect(row.authority).toBe("candidate");
      expect(row.adapterHash).toBe(null);
      expect(row.assetHash).toBe(null);
      expect(row.preRoutingCommand).toBe("");
      // No authoritative proof exists for the scope.
      expect(db.routingProofs().latestAuthoritative("test-adapter", "test-runtime", "default")).toBe(null);
      expect(db.routingProofs().latestFor("test-adapter", "test-runtime", "default")?.id).toBe("RTE-0001");
    } finally {
      db.close();
    }
  });

  it("denies dispatch for the vintage candidate before promotion", () => {
    seedVintageDb();
    const h = migratedHarness();
    try {
      const worker = openTestSession(h.core, "belthazar", "MOD-0001");
      const denied = h.core.authorizeExecution("MOD-0001", {
        actor: "gaspar",
        role: "belthazar",
        session: worker,
        requesterSession: h.gaspar.session,
        adapterId: "test-adapter",
      });
      expect(denied.ok).toBe(false);
      expect(denied.error?.code).toBe("RTK_ROUTING_FAILURE");
      expect(denied.error?.message ?? "").toContain("RTE-0001");
      expect(denied.error?.message ?? "").toContain("non-authoritative candidate");
    } finally {
      h.restoreTty();
      h.core.close();
    }
  });

  it("promotes the vintage proof and authorizes dispatch after", () => {
    seedVintageDb();
    const h = migratedHarness();
    try {
      const promoted = h.core.promoteRoutingProof("RTE-0001", h.po);
      expect(promoted.ok).toBe(true);
      expect(promoted.value?.id).toBe("RTE-0001");
      const worker = openTestSession(h.core, "belthazar", "MOD-0001");
      const authz = h.core.authorizeExecution("MOD-0001", {
        actor: "gaspar",
        role: "belthazar",
        session: worker,
        requesterSession: h.gaspar.session,
        adapterId: "test-adapter",
      });
      expect(authz.ok).toBe(true);
    } finally {
      h.restoreTty();
      h.core.close();
    }
  });
});
