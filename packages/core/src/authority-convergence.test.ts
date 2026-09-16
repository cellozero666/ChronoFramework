/**
 * Authority/state/next-action/operation convergence (CORE_FIX_2 §6).
 *
 * For every lifecycle scope these four MUST agree at the same
 * persisted revision with no hidden mutation between observations:
 * current signed authority, persisted lifecycle state, the single
 * action `nextAction` returns, and acceptance of that exact action
 * by the corresponding Core operation. Every test below fails
 * against the pre-CF2-2 implementation (verified by stash control):
 * activation replay reported success on revoked authority, aggregate
 * completion bypassed Module security acceptance, and `nextAction`
 * advertised operations the Core would then deny — or denied ones
 * it would accept.
 *
 * State is built exclusively through public Core operations, except
 * where a test explicitly simulates an out-of-band authority change
 * (revocation arriving in stored state) through the public
 * persistence repository — the same pattern as the premature-review
 * legacy simulation. No decision is faked: signatures are genuine,
 * revisions exact, ceremonies authoritative.
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
  managedAssetInventory,
  signApprovalPayload,
  skillGeneratedHashes,
  skillVendorPath,
} from "@chrono/domain";
import { ChronoCore, type CallerAuth } from "./chrono-core.js";

// Byte-exact canonical SKILL.md at the pinned commit (mirrors the CLI
// fixture; hash asserted in setup so copies cannot drift silently).
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

const FIXED_TIME = "2026-09-14T00:00:00.000Z";
const SPEC = { id: "SP-0001", title: "T", purpose: "P", inScope: ["a"], acceptanceCriteria: ["ac1"] };
const MOD = "MOD-0040";
const WP = "WP-0040";

function fakeTty(): () => void {
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

describe("Authority convergence (CORE_FIX_2)", () => {
  let tempDir: string;
  let core: ChronoCore;
  let signingKey = "";
  // Anonymous structural type (matching the other lifecycle suites):
  // assignable both to CallerAuth parameters and to transitionState
  // guard contexts, unlike the named interface.
  let gaspar: { actor: string; session: { id: string; token: string } };
  let restoreTty: () => void;
  let modRev = "";

  function approve(action: string, scopeId: string, scopeRev: string): string {
    const signature = signApprovalPayload(
      buildApprovalPayload({
        action, scopeArtifactId: scopeId, scopeRevision: scopeRev,
        authority: "PO", rationale: "test approval", timestamp: FIXED_TIME,
      }),
      signingKey
    );
    const res = core.recordApproval({
      action, scopeArtifactId: scopeId, scopeRevision: scopeRev,
      authority: "PO", rationale: "test approval", timestamp: FIXED_TIME, signature,
    });
    expect(res.ok).toBe(true);
    return res.value!.id;
  }

  function openPrivileged(role: "gaspar" | "PO", key: string): { id: string; token: string } {
    const nonce = randomBytes(16).toString("hex");
    const timestamp = "2026-09-11T00:00:00.000Z";
    const signature = signApprovalPayload(
      buildSessionAuthorizationPayload({
        sessionRole: role, adapter: "fixture", runtime: "test-runtime",
        scopeModule: null, scopeWp: null, ttlSeconds: 3600, nonce,
        authority: "PO", rationale: "test", timestamp,
      }),
      key
    );
    const res = core.openSession(
      { role, adapter: "fixture", runtime: "test-runtime", ttlSeconds: 3600 },
      { poAuthorization: { nonce, authority: "PO", rationale: "test", timestamp, signature } }
    );
    expect(res.ok).toBe(true);
    return { id: res.value!.id, token: res.value!.token };
  }

  function recordEvidenceAs(auth: CallerAuth, targetRevision: string, checkName: string): string {
    const res = core.recordEvidence({
      producer: auth.actor,
      tool: "vitest",
      targetRevision,
      checkName,
      result: "pass",
      diagnostics: null,
      integrityHash: computeRevisionHash({ result: "pass", diagnostics: null, target_revision: targetRevision }),
    }, auth);
    expect(res.ok).toBe(true);
    return res.value!.id;
  }

  /** Full converged stack: approved architecture/spec, activated module, authorized package. */
  function convergedModule(): void {
    expect(core.registerModule(MOD, "DRAFT", { id: MOD, name: "M", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
    expect(
      core.registerWorkPackage(WP, "PLANNED", { id: WP, name: "W", module: MOD, dependsOn: [] }, gaspar).ok
    ).toBe(true);
    modRev = core.getArtifact(MOD).revision;
    approve("planning-approval", MOD, modRev);
    approve("module-approval", MOD, modRev);
    expect(core.activateModule(MOD, gaspar).ok).toBe(true);
    expect(core.getArtifact(MOD).status).toBe("APPROVED");
    expect(core.transitionState(WP, "WorkPackageAuthorized", gaspar).ok).toBe(true);
  }

  function dispatchRoundTrip(kind: string | undefined, agent: string, rationale: string): { dispatchId: string; worker: CallerAuth } {
    const requested = core.requestDispatch(
      { moduleId: MOD, workPackageId: WP, ...(kind !== undefined ? { kind } : {}), rationale, adapterId: "fixture" },
      gaspar
    );
    expect(requested.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent, parentRuntimeSession: "opencode-parent-1" }, gaspar).ok).toBe(true);
    const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: "opencode-child-1" }, gaspar);
    expect(claimed.ok).toBe(true);
    expect(core.confirmClaim(requested.value!.dispatchId, gaspar).ok).toBe(true);
    const worker: CallerAuth = {
      actor: agent,
      session: { id: claimed.value!.session.id, token: claimed.value!.session.token },
    };
    return { dispatchId: requested.value!.dispatchId, worker };
  }

  /** Walk WP-0040 to COMPLETE through the standard fast path (clean spec: no Glenn ceremony). */
  function completePackage(): void {
    const impl = dispatchRoundTrip(undefined, "belthazar", "implement");
    const rev = core.getArtifact(WP).revision;
    recordEvidenceAs(impl.worker, rev, "unit-impl");
    const test = dispatchRoundTrip("test", "lucca", "test");
    recordEvidenceAs(test.worker, rev, "unit");
    expect(core.releaseDispatch(test.dispatchId, test.worker).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, impl.worker).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, impl.worker).ok).toBe(true);
    expect(core.releaseDispatch(impl.dispatchId, impl.worker).ok).toBe(true);
    const assigned = core.assignReview({ kind: "verification", moduleId: MOD, workPackageId: WP }, gaspar);
    expect(assigned.ok).toBe(true);
    const spek = dispatchRoundTrip("verification", "spekkio", "verify");
    expect(core.recordVerification(MOD, "PASS", "spekkio", [], [], [], spek.worker, WP).ok).toBe(true);
    expect(core.completeReview({ reviewId: assigned.value!.reviewId }, spek.worker).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "SpekkioPassed" }, spek.worker).ok).toBe(true);
    expect(core.getArtifact(WP).status).toBe("COMPLETE");
    expect(core.releaseDispatch(spek.dispatchId, spek.worker).ok).toBe(true);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-conv-test-"));
    core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    expect(core.init().ok).toBe(true);
    const pair = generateApprovalKeyPair();
    restoreTty = fakeTty();
    const nonce = randomBytes(16).toString("hex");
    const fingerprint = fingerprintPublicKey(pair.publicKeyPem);
    const confirmation = buildEnrollmentChallenge("default", fingerprint, nonce);
    const timestamp = new Date().toISOString();
    const signature = signApprovalPayload(
      buildEnrollmentPayload({ projectId: "default", fingerprint, timestamp, nonce, authority: "PO", rationale: "test", confirmation }),
      pair.privateKeyPem
    );
    expect(core.enrollPo({ publicKeyPem: pair.publicKeyPem, nonce, timestamp, rationale: "test", confirmation, signature }).ok).toBe(true);
    signingKey = pair.privateKeyPem;
    gaspar = { actor: "gaspar", session: openPrivileged("gaspar", signingKey) };
    const proposed = core.proposeArchitecture({ title: "A" }, gaspar);
    expect(proposed.ok).toBe(true);
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    approve("architecture-security", "ARCH", proposed.value!);
    expect(core.approveArchitecture(gaspar).ok).toBe(true);
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar).ok).toBe(true);
    const specRev = core.getArtifact("SP-0001").revision;
    approve("architecture-security", "SP-0001", specRev);
    expect(core.recordHarness(specRev, `sha256:${"a".repeat(64)}`, "# h", gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecApprovedReady", gaspar).ok).toBe(true);
    expect(core.recordSecurityProfile({ title: "P", threats: [] }, gaspar).ok).toBe(true);
    const rtkBin = join(tempDir, "fixture-rtk.sh");
    writeFileSync(rtkBin, "#!/bin/sh\necho fixture-rtk 1.0.0-test\n", "utf8");
    chmodSync(rtkBin, 0o755);
    expect(
      core.recordRtkAttestation(gaspar, {
        binaryPath: rtkBin, binaryIdentity: "rtk-test", version: "1.0.0-test",
        provenance: RTK_UPSTREAM, integrationMode: "test", routingTestPassed: true,
        routingTestLog: "fixture", gained: true, savingsEvidence: null, ttlSeconds: 86400,
      }).ok
    ).toBe(true);
    expect(
      core.recordSkillAttestation(gaspar, {
        upstream: SKILL_UPSTREAM, pinnedCommit: SKILL_RELEASE.pinnedCommit,
        sourceHash: SKILL_RELEASE.sourceHash,
        generatedHashes: skillGeneratedHashes(convertSkillSource(FIXTURE_SKILL_MD)),
        converterVersion: SKILL_RELEASE.converterVersion, licenseStatus: "MIT", attribution: "MIT",
        runtimeIdentity: "test", agentIdentity: "test", discoveryResult: "found",
        permissionResult: "granted", activationTestPassed: true, ttlSeconds: 86400,
      }).ok
    ).toBe(true);
    const vendorTarget = join(tempDir, skillVendorPath(SKILL_RELEASE.pinnedCommit));
    mkdirSync(dirname(vendorTarget), { recursive: true });
    writeFileSync(vendorTarget, FIXTURE_SKILL_MD, "utf8");
    for (const runtime of ["claude", "opencode", "kiro"] as const) {
      const target = join(tempDir, SKILL_RUNTIME_PATHS[runtime]);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, FIXTURE_SKILL_MD, "utf8");
    }
    const entrypoint = join(tempDir, "fixture-runtime.sh");
    writeFileSync(entrypoint, "#!/bin/sh\necho fixture-ok\n");
    chmodSync(entrypoint, 0o755);
    const po = { actor: "PO", session: openPrivileged("PO", signingKey) };
    expect(core.registerAdapter({ id: "fixture", name: "Fixture", entrypoint, conformanceProof: ["fixture --version"] }, po).ok).toBe(true);
    const registrationHash = core.adapterRegistrationHash("fixture");
    const adapterApprovalId = approve("adapter-registration", "fixture", registrationHash);
    expect(core.approveAdapter("fixture", adapterApprovalId, po).ok).toBe(true);
    const recordedProof = core.recordRoutingProof(gaspar, {
      adapterId: "fixture", binaryPath: rtkBin, version: "1.0.0-test",
      proofCommand: JSON.stringify([rtkBin, "gain"]),
      preRoutingCommand: JSON.stringify(["ls", tempDir]),
      commandHash: computeRevisionHash([rtkBin, "gain"]),
      outputHash: computeRevisionHash("fixture gain ok"),
      exitStatus: 0, gainAvailable: true,
      timestamp: new Date().toISOString(), ttlSeconds: 86400,
    });
    expect(recordedProof.ok).toBe(true);
    for (const spec of managedAssetInventory("fixture")) {
      const target = join(tempDir, spec.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, spec.kind === "marker" ? `fixture-managed ${spec.marker ?? spec.path}\n` : `fixture-managed ${spec.path}\n`, "utf8");
    }
    expect(core.promoteRoutingProof(recordedProof.value!.id, po).ok).toBe(true);
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("revoked module approval invalidates activation replay, next-action, deep-check, and dispatch (CF2-2 §6.1)", async () => {
    convergedModule();
    const before = core.getArtifact(MOD).status;
    expect(before).toBe("APPROVED");
    expect(core.hasValidApproval(MOD, modRev, "planning-approval")).toBe(true);
    expect(core.hasValidApproval(MOD, modRev, "module-approval")).toBe(true);
    // Out-of-band revocation arrives in stored state (PO key rotation
    // / supersession): public repository API, no decision faked.
    const { ChronoDatabase } = await import("@chrono/persistence");
    const stored = new ChronoDatabase({ path: join(tempDir, ".chrono", "chrono.db") });
    try {
      const row = core.listApprovals().find((a) => a.scopeArtifactId === MOD && a.action === "module-approval" && !a.revoked);
      expect(row).toBeTruthy();
      stored.approvals().revoke(row!.id);
    } finally {
      stored.close();
    }
    expect(core.hasValidApproval(MOD, modRev, "module-approval")).toBe(false);
    // Activation replay denies with the exact missing authority —
    // idempotency prevents duplicate transitions, never authority checks.
    const transitionsBefore = core.listEvents().filter((e) => e.entityId === MOD && e.eventType === "StateTransition").length;
    const replay = core.activateModule(MOD, gaspar);
    expect(replay.ok).toBe(false);
    expect(replay.error?.code).toBe("APPROVAL_REQUIRED");
    expect(replay.error?.message).toContain("module-approval");
    expect(core.getArtifact(MOD).status).toBe("APPROVED");
    expect(core.listEvents().filter((e) => e.entityId === MOD && e.eventType === "StateTransition")).toHaveLength(transitionsBefore);
    // nextAction steers to the PO ceremony hold — never dispatch, WP
    // authorization, evidence, review, or completion.
    const next = core.nextAction({ moduleId: MOD }, gaspar);
    expect(next.ok).toBe(true);
    expect(next.value!.action).toBe("await-approval");
    expect(next.value!.reason).toContain("module-approval");
    const wpNext = core.nextAction({ workPackageId: WP }, gaspar);
    expect(wpNext.ok).toBe(true);
    expect(wpNext.value!.action).toBe("await-approval");
    // Deep check identifies the contradiction class precisely.
    const deep = core.deepIntegrityCheck(gaspar);
    expect(deep.ok).toBe(true);
    const flagged = deep.value!.findings.filter((f) => f.check === "activation-authority-invalid");
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.some((f) => f.detail.includes(MOD))).toBe(true);
    // Dispatch is unreachable: the operation denies identically to
    // the dry-run, at the same observation boundary.
    const dry = core.checkActionPreconditions("request-dispatch", { moduleId: MOD, workPackageId: WP }, gaspar, { kind: "implementation" });
    expect(dry.acceptable).toBe(false);
    const requested = core.requestDispatch({ moduleId: MOD, workPackageId: WP, rationale: "revoked probe", adapterId: "fixture" }, gaspar);
    expect(requested.ok).toBe(false);
    expect(requested.error?.code).toBe("APPROVAL_REQUIRED");
    // Recovery is explicit: a fresh PO approval restores authority
    // and replay succeeds idempotently with no duplicate transition.
    approve("module-approval", MOD, modRev);
    expect(core.hasValidApproval(MOD, modRev, "module-approval")).toBe(true);
    const rereplay = core.activateModule(MOD, gaspar);
    expect(rereplay.ok).toBe(true);
    expect(rereplay.value!).toMatchObject({ state: "APPROVED", activated: false });
    expect(core.listEvents().filter((e) => e.entityId === MOD && e.eventType === "StateTransition")).toHaveLength(transitionsBefore);
    expect(core.nextAction({ workPackageId: WP }, gaspar).value!.action).toBe("request-dispatch");
  });

  it("stale approvals cannot enter the store and superseded revisions never validate (CF2-2 §6.2)", () => {
    convergedModule();
    // Record-time staleness enforcement: a well-formed but
    // non-current revision is refused at birth, never stored.
    const staleRev = `sha256:${"0".repeat(64)}`;
    expect(staleRev).not.toBe(modRev);
    const signature = signApprovalPayload(
      buildApprovalPayload({
        action: "module-approval", scopeArtifactId: MOD, scopeRevision: staleRev,
        authority: "PO", rationale: "test approval", timestamp: FIXED_TIME,
      }),
      signingKey
    );
    const stale = core.recordApproval({
      action: "module-approval", scopeArtifactId: MOD, scopeRevision: staleRev,
      authority: "PO", rationale: "test approval", timestamp: FIXED_TIME, signature,
    });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe("STALE_REVISION");
    // Registered module revisions are immutable by construction
    // (transitions move status only), so the store can only ever
    // hold current-or-revoked rows for module authority: the stale
    // branch is unreachable except through out-of-band writes, and
    // `hasValidApproval` still rejects those.
    expect(core.hasValidApproval(MOD, staleRev, "module-approval")).toBe(false);
    expect(core.hasValidApproval(MOD, modRev, "module-approval")).toBe(true);
    // Where revision mobility DOES exist through public ops
    // (architecture re-proposal), staleness fires end to end: the
    // prior architecture-security approval no longer validates and
    // dispatch denies on the moved revision.
    const reProposed = core.proposeArchitecture({ title: "B" }, gaspar);
    expect(reProposed.ok).toBe(true);
    // The moved revision no longer validates against the old approval.
    expect(core.hasValidApproval("ARCH", reProposed.value!, "architecture-security")).toBe(false);
    const requested = core.requestDispatch({ moduleId: MOD, workPackageId: WP, rationale: "stale arch probe", adapterId: "fixture" }, gaspar);
    expect(requested.ok).toBe(false);
    expect(requested.error?.code).toBe("APPROVAL_REQUIRED");
  });

  it("aggregate completion without module security acceptance advertises ceremony and denies without state change (CF2-1 §6.3)", () => {
    convergedModule();
    completePackage();
    expect(core.getArtifact(WP).status).toBe("COMPLETE");
    // The approval is missing: completion MUST NOT be advertised.
    const next = core.nextAction({ moduleId: MOD }, gaspar);
    expect(next.ok).toBe(true);
    expect(next.value!.action).toBe("approve-security");
    expect(next.value!.targetId).toBe(MOD);
    expect(next.value!.reason).toContain("Implementation Security Acceptance");
    // The operation denies identically — and changes nothing.
    const transitionsBefore = core.listEvents().filter((e) => e.entityId === MOD && e.eventType === "StateTransition").length;
    const done = core.completeModule(MOD, gaspar);
    expect(done.ok).toBe(false);
    expect(done.error?.code).toBe("APPROVAL_REQUIRED");
    expect(done.error?.message).toContain("Implementation Security Acceptance");
    expect(core.getArtifact(MOD).status).toBe("APPROVED");
    expect(core.listEvents().filter((e) => e.entityId === MOD && e.eventType === "StateTransition")).toHaveLength(transitionsBefore);
    // The reported hold verifies through the shared source: deep
    // check raises no unreachable-next-action for it.
    const deep = core.deepIntegrityCheck(gaspar);
    expect(deep.ok).toBe(true);
    expect(deep.value!.findings.filter((f) => f.check === "unreachable-next-action")).toEqual([]);
  });

  it("recorded acceptance converges advertisement, operation, and validation with no hidden mutation (CF2-1 §6.4)", () => {
    convergedModule();
    completePackage();
    expect(core.nextAction({ moduleId: MOD }, gaspar).value!.action).toBe("approve-security");
    // The PO ceremony binds the exact current module revision.
    approve("implementation-security", MOD, modRev);
    // Re-observation advertises completion — and NOTHING runs
    // between this observation and its execution below.
    const advertised = core.nextAction({ moduleId: MOD }, gaspar);
    expect(advertised.ok).toBe(true);
    expect(advertised.value!.action).toBe("complete-module");
    const done = core.completeModule(MOD, gaspar);
    expect(done.ok).toBe(true);
    expect(done.value!.state).toBe("COMPLETE");
    expect(core.getArtifact(MOD).status).toBe("COMPLETE");
    // Terminal convergence: done, valid, and deeply clean.
    expect(core.nextAction({ moduleId: MOD }, gaspar).value!.action).toBe("done");
    expect(core.validate().value!.valid).toBe(true);
    const deep = core.deepIntegrityCheck(gaspar);
    expect(deep.ok).toBe(true);
    expect(deep.value!.blockerCount).toBe(0);
    expect(deep.value!.warningCount).toBe(0);
  });

  it("revoking the acceptance pre-completion denies dry-run and operation identically (CF2-1 §6.5)", async () => {
    convergedModule();
    completePackage();
    approve("implementation-security", MOD, modRev);
    expect(core.nextAction({ moduleId: MOD }, gaspar).value!.action).toBe("complete-module");
    const { ChronoDatabase } = await import("@chrono/persistence");
    const stored = new ChronoDatabase({ path: join(tempDir, ".chrono", "chrono.db") });
    try {
      const row = core.listApprovals().find((a) => a.scopeArtifactId === MOD && a.action === "implementation-security" && !a.revoked);
      expect(row).toBeTruthy();
      stored.approvals().revoke(row!.id);
    } finally {
      stored.close();
    }
    // Dry-run and operation deny with the same missing authority.
    const dry = core.checkActionPreconditions("complete-module", { moduleId: MOD, workPackageId: null }, gaspar);
    expect(dry.acceptable).toBe(false);
    expect(dry.unmet.some((u) => u.code === "APPROVAL_REQUIRED" && u.message.includes("Implementation Security Acceptance"))).toBe(true);
    const done = core.completeModule(MOD, gaspar);
    expect(done.ok).toBe(false);
    expect(done.error?.code).toBe("APPROVAL_REQUIRED");
    expect(done.error?.message).toContain("Implementation Security Acceptance");
    expect(core.getArtifact(MOD).status).toBe("APPROVED");
    // The hold returns to the explicit ceremony.
    expect(core.nextAction({ moduleId: MOD }, gaspar).value!.action).toBe("approve-security");
  });

  it("wrong-scope, wrong-action, and wrong-revision approvals never satisfy completion (CF2-1)", () => {
    convergedModule();
    completePackage();
    // Acceptance for the package revision is not module acceptance.
    approve("implementation-security", WP, core.getArtifact(WP).revision);
    // A different approval action on the module is not acceptance.
    approve("architecture-security", MOD, modRev);
    // None of them unblock the ceremony hold.
    expect(core.nextAction({ moduleId: MOD }, gaspar).value!.action).toBe("approve-security");
    expect(core.completeModule(MOD, gaspar).ok).toBe(false);
    // The exact current acceptance does.
    approve("implementation-security", MOD, modRev);
    expect(core.nextAction({ moduleId: MOD }, gaspar).value!.action).toBe("complete-module");
  });

  it("restart at every lifecycle boundary reproduces the same next action from SQLite (CF2-2 §6.8)", () => {
    expect(core.registerModule(MOD, "DRAFT", { id: MOD, name: "M", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
    expect(
      core.registerWorkPackage(WP, "PLANNED", { id: WP, name: "W", module: MOD, dependsOn: [] }, gaspar).ok
    ).toBe(true);
    modRev = core.getArtifact(MOD).revision;
    approve("planning-approval", MOD, modRev);
    approve("module-approval", MOD, modRev);
    expect(core.activateModule(MOD, gaspar).ok).toBe(true);
    const observed: string[] = [];
    const reopenAndObserve = (scope: { moduleId?: string; workPackageId?: string }): string => {
      // Restart with the surviving host-held credential (the entry
      // token file outlives processes; sessions persist in SQLite):
      // the SAME next action must reproduce from stored rows.
      const prior = gaspar.session;
      core.close();
      core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
      gaspar = { actor: "gaspar", session: prior };
      const next = core.nextAction(scope, gaspar);
      expect(next.ok).toBe(true);
      const action = `${next.value!.action}:${next.value!.targetId}`;
      observed.push(action);
      return action;
    };
    // Post-activation boundary: the PLANNED package authorizes next.
    expect(reopenAndObserve({ moduleId: MOD })).toBe(`authorize-wp:${WP}`);
    // Post-authorization boundary.
    expect(core.transitionState(WP, "WorkPackageAuthorized", gaspar).ok).toBe(true);
    expect(reopenAndObserve({ moduleId: MOD })).toBe(`request-dispatch:${WP}`);
    // Dispatch claim boundary: request, delegate, then restart with
    // the intent PENDING.
    const requested = core.requestDispatch({ moduleId: MOD, workPackageId: WP, rationale: "restart probe", adapterId: "fixture" }, gaspar);
    expect(requested.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent: "belthazar", parentRuntimeSession: "opencode-parent-1" }, gaspar).ok).toBe(true);
    expect(reopenAndObserve({ workPackageId: WP })).toBe(`claim-dispatch:${WP}`);
    const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: "opencode-child-1" }, gaspar);
    expect(claimed.ok).toBe(true);
    expect(core.confirmClaim(requested.value!.dispatchId, gaspar).ok).toBe(true);
    const worker: CallerAuth = {
      actor: "belthazar",
      session: { id: claimed.value!.session.id, token: claimed.value!.session.token },
    };
    const rev = core.getArtifact(WP).revision;
    recordEvidenceAs(worker, rev, "unit-impl");
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, worker).ok).toBe(true);
    // Review boundary: assign, then restart with it ASSIGNED.
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, worker).ok).toBe(true);
    expect(core.releaseDispatch(requested.value!.dispatchId, worker).ok).toBe(true);
    const firstReview = core.assignReview({ kind: "verification", moduleId: MOD, workPackageId: WP }, gaspar);
    expect(firstReview.ok).toBe(true);
    expect(reopenAndObserve({ workPackageId: WP })).toBe(`await-action:${WP}`);
    // Correction boundary: FAIL opens the loop, then restart.
    const spek = dispatchRoundTrip("verification", "spekkio", "verify");
    const defect = core.recordDefect(
      {
        classification: "IMPLEMENTATION_DEFECT",
        severity: "major",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: [WP],
        blockingScope: WP,
        reproInfo: null,
      },
      spek.worker
    );
    expect(defect.ok).toBe(true);
    expect(core.recordVerification(MOD, "FAILED", "spekkio", [defect.value!.id], [], [], spek.worker, WP).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "SpekkioFailed" }, spek.worker).ok).toBe(true);
    expect(core.completeReview({ reviewId: firstReview.value!.reviewId }, spek.worker).ok).toBe(true);
    expect(core.releaseDispatch(spek.dispatchId, spek.worker).ok).toBe(true);
    expect(reopenAndObserve({ workPackageId: WP })).toBe(`request-correction:${WP}`);
    // Security-approval boundary: drive to COMPLETE-readiness, then
    // restart with the ceremony still outstanding.
    const fix = dispatchRoundTrip("correction", "belthazar", "fix");
    recordEvidenceAs(fix.worker, rev, "fix");
    const loops = core.nextAction({ workPackageId: WP }, gaspar).value!;
    const loopMatch = /'(COR-[0-9]+)'/.exec(loops.summary);
    expect(loopMatch).not.toBe(null);
    expect(core.completeCorrectionLoop(loopMatch![1]!, fix.worker).ok).toBe(true);
    // Pre-correction proof went stale with the loop: Lucca retests
    // the RUNNING fix beside correction, then the fix advances.
    const retest = dispatchRoundTrip("test", "lucca", "retest the fix");
    recordEvidenceAs(retest.worker, rev, "unit");
    expect(core.releaseDispatch(retest.dispatchId, retest.worker).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, fix.worker).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, fix.worker).ok).toBe(true);
    // Owner resolution while the owner session is live: release
    // retires the worker session with its binding (CF-3).
    expect(core.resolveDefect(defect.value!.id, fix.worker).ok).toBe(true);
    expect(core.releaseDispatch(fix.dispatchId, fix.worker).ok).toBe(true);
    const reassigned = core.assignReview({ kind: "verification", moduleId: MOD, workPackageId: WP }, gaspar);
    expect(reassigned.ok).toBe(true);
    const spek2 = dispatchRoundTrip("verification", "spekkio", "re-verify");
    expect(core.recordVerification(MOD, "PASS", "spekkio", [], [], [], spek2.worker, WP).ok).toBe(true);
    expect(core.completeReview({ reviewId: reassigned.value!.reviewId }, spek2.worker).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "SpekkioPassed" }, spek2.worker).ok).toBe(true);
    expect(core.releaseDispatch(spek2.dispatchId, spek2.worker).ok).toBe(true);
    expect(reopenAndObserve({ moduleId: MOD })).toBe(`approve-security:${MOD}`);
    // Completion boundary: record the acceptance, restart, complete.
    approve("implementation-security", MOD, modRev);
    expect(reopenAndObserve({ moduleId: MOD })).toBe(`complete-module:${MOD}`);
    expect(core.completeModule(MOD, gaspar).ok).toBe(true);
    expect(reopenAndObserve({ moduleId: MOD })).toBe(`done:${MOD}`);
    expect(observed).toEqual([
      `authorize-wp:${WP}`,
      `request-dispatch:${WP}`,
      `claim-dispatch:${WP}`,
      `await-action:${WP}`,
      `request-correction:${WP}`,
      `approve-security:${MOD}`,
      `complete-module:${MOD}`,
      `done:${MOD}`,
    ]);
  });
});
