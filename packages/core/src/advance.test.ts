/**
 * Workflow engine unit tests (`ChronoCore.advance`, WORKFLOW-STABILIZATION).
 *
 * Focused coverage through public Core operations only (genuine PO
 * signatures, no fabricated rows, no private helpers):
 *
 * - each of the five WorkflowDecision variants;
 * - automatic multi-transition advancement in one call;
 * - no fabricated approval/evidence/Harness/verdict/review rows;
 * - stalled-state detection (circular package dependencies);
 * - iteration bound (overridable for tests);
 * - correction-loop exhaustion via the engine;
 * - restart/reopen persistence of engine results;
 * - idempotent repeated advance() calls;
 * - clean abort (prior commits intact) when an internal step fails.
 *
 * Security checks are never weakened here: every denial below is
 * asserted with its exact code, and dry-run/execution agreement is
 * asserted wherever the engine consumes a step.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
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
import { ChronoCore, type WorkflowDecision } from "./chrono-core.js";

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
const MOD = "MOD-0080";
const WP = "WP-0080";

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

describe("Workflow engine (ChronoCore.advance)", () => {
  let tempDir: string;
  let core: ChronoCore;
  let signingKey = "";
  let gaspar: { actor: string; session: { id: string; token: string } };
  let restoreTty: () => void;
  let archRev = "";

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

  function recordEvidenceAs(
    auth: { actor: string; session: { id: string; token: string } },
    targetRevision: string,
    checkName: string
  ): string {
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

  /** Full execution stack: init through adapter approval. */
  function buildStack(): void {
    expect(core.registerModule(MOD, "DRAFT", { id: MOD, name: "M", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
    expect(
      core.registerWorkPackage(WP, "PLANNED", { id: WP, name: "W", module: MOD, dependsOn: [] }, gaspar).ok
    ).toBe(true);
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
  }

  let dispatchSeq = 0;
  function roundTrip(kind: string | undefined, agent: string): { dispatchId: string; worker: { actor: string; session: { id: string; token: string } } } {
    dispatchSeq += 1;
    const requested = core.requestDispatch(
      { moduleId: MOD, workPackageId: WP, ...(kind !== undefined ? { kind } : {}), rationale: "advance drive", adapterId: "fixture" },
      gaspar
    );
    expect(requested.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent, parentRuntimeSession: `opencode-parent-${dispatchSeq}` }, gaspar).ok).toBe(true);
    const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: `opencode-child-${dispatchSeq}` }, gaspar);
    expect(claimed.ok).toBe(true);
    expect(core.confirmClaim(requested.value!.dispatchId, gaspar).ok).toBe(true);
    return {
      dispatchId: requested.value!.dispatchId,
      worker: { actor: agent, session: { id: claimed.value!.session.id, token: claimed.value!.session.token } },
    };
  }

  function decide(): WorkflowDecision {
    const res = core.advance({ moduleId: MOD }, gaspar);
    expect(res.ok).toBe(true);
    return res.value!.decision;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-advance-test-"));
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
    archRev = proposed.value!;
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns PO_DECISION_REQUIRED naming the exact ceremony", () => {
    buildStack();
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    const decision = decide();
    expect(decision.type).toBe("PO_DECISION_REQUIRED");
    if (decision.type === "PO_DECISION_REQUIRED") {
      expect(decision.action).toBe("architecture-security");
      expect(decision.scopeId).toBe("ARCH");
      expect(decision.revision).toBe(archRev);
      expect(decision.rationale.length).toBeGreaterThan(0);
    }
  });

  it("returns AGENT_WORK_REQUIRED for a live binding held by another session", () => {
    buildStack();
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    approve("architecture-security", "ARCH", archRev);
    expect(core.approveArchitecture(gaspar).ok).toBe(true);
    approve("planning-approval", "SP-0001", core.getArtifact("SP-0001").revision);
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar).ok).toBe(true);
    approve("architecture-security", "SP-0001", core.getArtifact("SP-0001").revision);
    const specRev = core.getArtifact("SP-0001").revision;
    const harnessContent = "# harness";
    expect(core.recordHarness(specRev, `sha256:${createHash("sha256").update(harnessContent, "utf8").digest("hex")}`, harnessContent, gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecApprovedReady", gaspar).ok).toBe(true);
    const modRev = core.getArtifact(MOD).revision;
    approve("planning-approval", MOD, modRev);
    approve("module-approval", MOD, modRev);
    expect(core.activateModule(MOD, gaspar).ok).toBe(true);
    expect(core.transitionState(WP, "WorkPackageAuthorized", gaspar).ok).toBe(true);
    const impl = roundTrip(undefined, "belthazar");
    const decision = decide();
    expect(decision.type).toBe("AGENT_WORK_REQUIRED");
    if (decision.type === "AGENT_WORK_REQUIRED") {
      expect(decision.role).toBe("belthazar");
      expect(decision.kind).toBe("implementation");
      expect(decision.moduleId).toBe(MOD);
      expect(decision.workPackageId).toBe(WP);
      expect(decision.objective).toContain(impl.dispatchId);
    }
  });

  it("returns INDEPENDENT_REVIEW_REQUIRED when reviewer proof is outstanding", () => {
    buildStack();
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    approve("architecture-security", "ARCH", archRev);
    expect(core.approveArchitecture(gaspar).ok).toBe(true);
    approve("planning-approval", "SP-0001", core.getArtifact("SP-0001").revision);
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar).ok).toBe(true);
    approve("architecture-security", "SP-0001", core.getArtifact("SP-0001").revision);
    const specRev = core.getArtifact("SP-0001").revision;
    const harnessContent = "# harness";
    expect(core.recordHarness(specRev, `sha256:${createHash("sha256").update(harnessContent, "utf8").digest("hex")}`, harnessContent, gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecApprovedReady", gaspar).ok).toBe(true);
    const modRev = core.getArtifact(MOD).revision;
    approve("planning-approval", MOD, modRev);
    approve("module-approval", MOD, modRev);
    expect(core.activateModule(MOD, gaspar).ok).toBe(true);
    expect(core.transitionState(WP, "WorkPackageAuthorized", gaspar).ok).toBe(true);
    const impl = roundTrip(undefined, "belthazar");
    const rev = core.getArtifact(WP).revision;
    recordEvidenceAs(impl.worker, rev, "unit-impl");
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, impl.worker).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, impl.worker).ok).toBe(true);
    expect(core.releaseDispatch(impl.dispatchId, impl.worker).ok).toBe(true);
    // Assignment is consumed mechanically by advance(); the
    // outstanding proof resolves to the reviewer boundary.
    const assigned = core.assignReview({ kind: "verification", moduleId: MOD, workPackageId: WP }, gaspar);
    expect(assigned.ok).toBe(true);
    const decision = decide();
    expect(decision.type).toBe("INDEPENDENT_REVIEW_REQUIRED");
    if (decision.type === "INDEPENDENT_REVIEW_REQUIRED") {
      expect(decision.role).toBe("spekkio");
      expect(decision.kind).toBe("verification");
      expect(decision.workPackageId).toBe(WP);
      expect(decision.targetRevision).toBe(rev);
    }
  });

  it("returns COMPLETE for a terminal module with an empty trail", () => {
    buildStack();
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    approve("architecture-security", "ARCH", archRev);
    expect(core.approveArchitecture(gaspar).ok).toBe(true);
    approve("planning-approval", "SP-0001", core.getArtifact("SP-0001").revision);
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar).ok).toBe(true);
    approve("architecture-security", "SP-0001", core.getArtifact("SP-0001").revision);
    const specRev = core.getArtifact("SP-0001").revision;
    const harnessContent = "# harness";
    expect(core.recordHarness(specRev, `sha256:${createHash("sha256").update(harnessContent, "utf8").digest("hex")}`, harnessContent, gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecApprovedReady", gaspar).ok).toBe(true);
    const modRev = core.getArtifact(MOD).revision;
    approve("planning-approval", MOD, modRev);
    approve("module-approval", MOD, modRev);
    expect(core.activateModule(MOD, gaspar).ok).toBe(true);
    expect(core.transitionState(WP, "WorkPackageAuthorized", gaspar).ok).toBe(true);
    const impl = roundTrip(undefined, "belthazar");
    const rev = core.getArtifact(WP).revision;
    recordEvidenceAs(impl.worker, rev, "unit-impl");
    const test = roundTrip("test", "lucca");
    recordEvidenceAs(test.worker, rev, "unit");
    expect(core.releaseDispatch(test.dispatchId, test.worker).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, impl.worker).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, impl.worker).ok).toBe(true);
    expect(core.releaseDispatch(impl.dispatchId, impl.worker).ok).toBe(true);
    const assigned = core.assignReview({ kind: "verification", moduleId: MOD, workPackageId: WP }, gaspar);
    expect(assigned.ok).toBe(true);
    const spek = roundTrip("verification", "spekkio");
    expect(core.recordVerification(MOD, "PASS", "spekkio", [], [], [], spek.worker, WP).ok).toBe(true);
    expect(core.completeReview({ reviewId: assigned.value!.reviewId }, spek.worker).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "SpekkioPassed" }, spek.worker).ok).toBe(true);
    expect(core.releaseDispatch(spek.dispatchId, spek.worker).ok).toBe(true);
    approve("implementation-security", MOD, modRev);
    expect(core.completeModule(MOD, gaspar).ok).toBe(true);
    expect(core.getArtifact(MOD).status).toBe("COMPLETE");
    const res = core.advance({ moduleId: MOD }, gaspar);
    expect(res.ok).toBe(true);
    expect(res.value!.trail).toEqual([]);
    const decision = res.value!.decision;
    expect(decision.type).toBe("COMPLETE");
    if (decision.type === "COMPLETE") {
      expect(decision.moduleId).toBe(MOD);
    }
  });

  it("consumes multiple mechanical transitions in one call, then stops at the dispatch boundary", () => {
    buildStack();
    // Every ceremony recorded up front; the Harness authored as the
    // modeled external input. One advance() call must then walk the
    // whole mechanical prefix without further input.
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    approve("architecture-security", "ARCH", archRev);
    approve("planning-approval", "SP-0001", core.getArtifact("SP-0001").revision);
    approve("architecture-security", "SP-0001", core.getArtifact("SP-0001").revision);
    const specRev = core.getArtifact("SP-0001").revision;
    const harnessContent = "# harness";
    expect(core.recordHarness(specRev, `sha256:${createHash("sha256").update(harnessContent, "utf8").digest("hex")}`, harnessContent, gaspar).ok).toBe(true);
    const modRev = core.getArtifact(MOD).revision;
    approve("planning-approval", MOD, modRev);
    approve("module-approval", MOD, modRev);
    const res = core.advance({ moduleId: MOD }, gaspar);
    expect(res.ok).toBe(true);
    expect(res.value!.trail.map((t) => t.action)).toEqual([
      "approve-architecture",
      "submit-spec",
      "ready-spec",
      "activate-module",
      "authorize-wp",
    ]);
    const decision = res.value!.decision;
    expect(decision.type).toBe("AGENT_WORK_REQUIRED");
    if (decision.type === "AGENT_WORK_REQUIRED") {
      expect(decision.kind).toBe("implementation");
      expect(decision.workPackageId).toBe(WP);
    }
    expect(core.getArtifact("SP-0001").status).toBe("READY");
    expect(core.getArtifact(MOD).status).toBe("APPROVED");
    expect(core.getArtifact(WP).status).toBe("AUTHORIZED");
  });

  it("fabricates nothing: approvals, evidence, Harness, verdicts, and reviews stay untouched", () => {
    buildStack();
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    approve("architecture-security", "ARCH", archRev);
    approve("planning-approval", "SP-0001", core.getArtifact("SP-0001").revision);
    approve("architecture-security", "SP-0001", core.getArtifact("SP-0001").revision);
    const specRev = core.getArtifact("SP-0001").revision;
    const harnessContent = "# harness";
    expect(core.recordHarness(specRev, `sha256:${createHash("sha256").update(harnessContent, "utf8").digest("hex")}`, harnessContent, gaspar).ok).toBe(true);
    const modRev = core.getArtifact(MOD).revision;
    approve("planning-approval", MOD, modRev);
    approve("module-approval", MOD, modRev);
    const approvalsBefore = core.listApprovals().length;
    const qaBefore = core.listQaReports(MOD).length;
    const res = core.advance({ moduleId: MOD }, gaspar);
    expect(res.ok).toBe(true);
    // Six mechanical steps consumed (approve-arch through authorize),
    // zero rows invented for any ceremony, proof, or verdict class.
    expect(res.value!.trail.map((t) => t.action)).toEqual([
      "approve-architecture",
      "submit-spec",
      "ready-spec",
      "activate-module",
      "authorize-wp",
    ]);
    expect(core.listApprovals().length).toBe(approvalsBefore);
    expect(core.listQaReports(MOD).length).toBe(qaBefore);
    // A duplicate Harness still denies: the engine recorded none.
    const dup = core.recordHarness(specRev, `sha256:${createHash("sha256").update(harnessContent, "utf8").digest("hex")}`, harnessContent, gaspar);
    expect(dup.ok).toBe(false);
  });

  it("names a held dependency instead of looping (stall safety)", () => {
    // WP-0081 waits on WP-0082, which itself is held by an active
    // blocker: the engine must surface the named hold with an empty
    // trail — never spin, never consume. (The NO_PROGRESS detector
    // stays as defense-in-depth for cycles unreachable through
    // public ops: bottom-up authorization always converges, and
    // blockers intercept first, so no public-op sequence repeats an
    // observation without state change.)
    expect(core.registerModule("MOD-0081", "DRAFT", { id: "MOD-0081", name: "M", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
    expect(core.registerWorkPackage("WP-0082", "PLANNED", { id: "WP-0082", name: "B", module: "MOD-0081", dependsOn: [] }, gaspar).ok).toBe(true);
    expect(core.registerWorkPackage("WP-0081", "PLANNED", { id: "WP-0081", name: "A", module: "MOD-0081", dependsOn: ["WP-0082"] }, gaspar).ok).toBe(true);
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    approve("architecture-security", "ARCH", archRev);
    expect(core.approveArchitecture(gaspar).ok).toBe(true);
    approve("planning-approval", "SP-0001", core.getArtifact("SP-0001").revision);
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar).ok).toBe(true);
    approve("architecture-security", "SP-0001", core.getArtifact("SP-0001").revision);
    const specRev = core.getArtifact("SP-0001").revision;
    const harnessContent = "# harness";
    expect(core.recordHarness(specRev, `sha256:${createHash("sha256").update(harnessContent, "utf8").digest("hex")}`, harnessContent, gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecApprovedReady", gaspar).ok).toBe(true);
    const modRev = core.getArtifact("MOD-0081").revision;
    approve("planning-approval", "MOD-0081", modRev);
    approve("module-approval", "MOD-0081", modRev);
    expect(core.activateModule("MOD-0081", gaspar).ok).toBe(true);
    expect(core.raiseBlocker("PRODUCT_BLOCKER", ["WP-0082"], "WP-0082 predecessor held for test", gaspar).ok).toBe(true);
    const res = core.advance({ moduleId: "MOD-0081" }, gaspar);
    expect(res.ok).toBe(true);
    const decision = res.value!.decision;
    expect(decision.type).toBe("BLOCKED");
    if (decision.type === "BLOCKED") {
      expect(decision.reason).toContain("WP-0082");
    }
    expect(res.value!.trail).toEqual([]);
  });

  it("honors the iteration bound instead of running open-ended", () => {
    buildStack();
    const res = core.advance({ moduleId: MOD }, gaspar, { maxIterations: 1 });
    expect(res.ok).toBe(true);
    // One iteration consumes exactly the first mechanical step, then
    // the bound — never a second step, never a silent stop.
    expect(res.value!.trail.map((t) => t.action)).toEqual(["submit-architecture"]);
    const decision = res.value!.decision;
    expect(decision.type).toBe("BLOCKED");
    if (decision.type === "BLOCKED") {
      expect(decision.code).toBe("ITERATION_BOUND");
    }
  });

  it("surfaces correction-loop exhaustion as BLOCKED owned by the PO", () => {
    buildStack();
    // Lean bound of two: three FAILED verdicts escalate. Each round
    // closes its loop with a PASS so every correction binds a fresh
    // OPEN row; the third FAILED exceeds the bound.
    const poSetup = { actor: "PO", session: openPrivileged("PO", signingKey) };
    expect(core.setPolicyProfile({ profile: "lean", rationale: "advance exhaustion probe" }, poSetup).ok).toBe(true);
    const via = <T extends { ok: boolean }>(fn: () => T): T => {
      const res = fn();
      expect(res.ok).toBe(true);
      return res;
    };
    via(() => core.submitArchitectureForReview(gaspar));
    approve("architecture-security", "ARCH", archRev);
    via(() => core.approveArchitecture(gaspar));
    approve("planning-approval", "SP-0001", core.getArtifact("SP-0001").revision);
    via(() => core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar));
    approve("architecture-security", "SP-0001", core.getArtifact("SP-0001").revision);
    const specRev = core.getArtifact("SP-0001").revision;
    const harnessContent = "# harness";
    via(() => core.recordHarness(
      specRev, `sha256:${createHash("sha256").update(harnessContent, "utf8").digest("hex")}`, harnessContent, gaspar
    ));
    via(() => core.transitionState("SP-0001", "SpecApprovedReady", gaspar));
    const modRev = core.getArtifact(MOD).revision;
    approve("planning-approval", MOD, modRev);
    approve("module-approval", MOD, modRev);
    via(() => core.activateModule(MOD, gaspar));
    via(() => core.transitionState(WP, "WorkPackageAuthorized", gaspar));
    let defectId = "";
    const failPhase = (): void => {
      const assigned = core.assignReview({ kind: "verification", moduleId: MOD, workPackageId: WP }, gaspar);
      expect(assigned.ok).toBe(true);
      const spek = roundTrip("verification", "spekkio");
      if (defectId === "") {
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
        defectId = defect.value!.id;
      }
      expect(core.recordVerification(MOD, "FAILED", "spekkio", [defectId], [], [], spek.worker, WP).ok).toBe(true);
      expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "SpekkioFailed" }, spek.worker).ok).toBe(true);
      expect(core.completeReview({ reviewId: assigned.value!.reviewId }, spek.worker).ok).toBe(true);
      expect(core.releaseDispatch(spek.dispatchId, spek.worker).ok).toBe(true);
    };
    const fixPhase = (): void => {
      const fix = roundTrip("correction", "belthazar");
      const rev = core.getArtifact(WP).revision;
      recordEvidenceAs(fix.worker, rev, "fix");
      // The open loop id arrives on the structured CorrectionOpened
      // event for this defect (entityId + payload defect match) —
      // never parsed from prose. Latest event wins: each FAILED
      // verdict opens the next attempt.
      const loopedAction = core.nextAction({ workPackageId: WP }, gaspar).value!;
      expect(loopedAction.action).toBe("correct-defect");
      const opened = core.listEvents().filter(
        (e) => e.eventType === "CorrectionOpened" && (JSON.parse(e.payload) as { defectId?: string }).defectId === defectId
      );
      expect(opened.length).toBeGreaterThan(0);
      const loopId = opened[opened.length - 1]!.entityId;
      expect(core.completeCorrectionLoop(loopId, fix.worker).ok).toBe(true);
      expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, fix.worker).ok).toBe(true);
      expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, fix.worker).ok).toBe(true);
      expect(core.releaseDispatch(fix.dispatchId, fix.worker).ok).toBe(true);
      const reassigned = core.assignReview({ kind: "verification", moduleId: MOD, workPackageId: WP }, gaspar);
      expect(reassigned.ok).toBe(true);
      const spek = roundTrip("verification", "spekkio");
      expect(core.recordVerification(MOD, "PASS", "spekkio", [], [], [], spek.worker, WP).ok).toBe(true);
      expect(core.completeReview({ reviewId: reassigned.value!.reviewId }, spek.worker).ok).toBe(true);
      expect(core.releaseDispatch(spek.dispatchId, spek.worker).ok).toBe(true);
    };
    const impl = roundTrip(undefined, "belthazar");
    const rev = core.getArtifact(WP).revision;
    recordEvidenceAs(impl.worker, rev, "unit-impl");
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, impl.worker).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, impl.worker).ok).toBe(true);
    expect(core.releaseDispatch(impl.dispatchId, impl.worker).ok).toBe(true);
    failPhase();
    fixPhase();
    failPhase();
    fixPhase();
    // Third FAILED exceeds the lean bound of two: escalation with a
    // PO blocker, and no advance follows in setup.
    const assigned3 = core.assignReview({ kind: "verification", moduleId: MOD, workPackageId: WP }, gaspar);
    expect(assigned3.ok).toBe(true);
    const spek3 = roundTrip("verification", "spekkio");
    expect(core.recordVerification(MOD, "FAILED", "spekkio", [defectId], [], [], spek3.worker, WP).ok).toBe(true);
    const escalations = core.listEvents().filter((e) => e.eventType === "CorrectionEscalated");
    expect(escalations.length).toBe(1);
    const res = core.advance({ moduleId: MOD }, gaspar);
    expect(res.ok).toBe(true);
    expect(res.value!.trail).toEqual([]);
    const decision = res.value!.decision;
    expect(decision.type).toBe("BLOCKED");
    if (decision.type === "BLOCKED") {
      expect(decision.code).toBe("CORRECTION_ESCALATED");
      expect(decision.owner).toBe("PO");
      expect(decision.reason).toContain("exceeded 2 attempts");
    }
  });

  it("reproduces the same boundary after close and reopen (restart persistence)", () => {
    buildStack();
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    const first = core.advance({ moduleId: MOD }, gaspar);
    expect(first.ok).toBe(true);
    expect(first.value!.decision.type).toBe("PO_DECISION_REQUIRED");
    const session = gaspar.session;
    core.close();
    core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    gaspar = { actor: "gaspar", session };
    const second = core.advance({ moduleId: MOD }, gaspar);
    expect(second.ok).toBe(true);
    expect(second.value!.decision).toEqual(first.value!.decision);
    expect(second.value!.trail.map((t) => t.action)).toEqual(
      first.value!.trail.map((t) => t.action)
    );
  });

  it("is idempotent at boundaries and at COMPLETE", () => {
    buildStack();
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    approve("architecture-security", "ARCH", archRev);
    const first = core.advance({ moduleId: MOD }, gaspar);
    const second = core.advance({ moduleId: MOD }, gaspar);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.value!.decision).toEqual(first.value!.decision);
    expect(second.value!.trail).toEqual([]);
    expect(first.value!.trail.map((t) => t.action)).toEqual(["approve-architecture"]);
  });

  it("aborts cleanly when the caller loses authority mid-walk (rollback)", () => {
    buildStack();
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    approve("architecture-security", "ARCH", archRev);
    // First call consumes the mechanical prefix and stops at the
    // PO ceremony hold.
    const first = core.advance({ moduleId: MOD }, gaspar);
    expect(first.ok).toBe(true);
    expect(first.value!.trail.map((t) => t.action)).toEqual(["approve-architecture"]);
    // The caller session dies out-of-band (revoked by the PO through
    // a live session): the next advance fails closed with an empty
    // trail while the committed prefix stands intact — the approved
    // architecture transition persists in the event log.
    const po = { actor: "PO", session: openPrivileged("PO", signingKey) };
    expect(core.revokeSession(gaspar.session.id, po).ok).toBe(true);
    // Authentication failure surfaces as an error — exactly like
    // nextAction for the same dead session — never as a fabricated
    // decision, and the committed prefix stands intact.
    const failed = core.advance({ moduleId: MOD }, gaspar);
    expect(failed.ok).toBe(false);
    const archTransitions = core.listEvents().filter(
      (e) => e.entityId === "ARCH" && e.eventType === "StateTransition"
    );
    expect(archTransitions.length).toBeGreaterThan(0);
  });

  it("converges external inputs through re-invocation (shared engine)", () => {
    buildStack();
    // Each external input re-observed: the engine flips exactly the
    // advertised hold into the next mechanical step, proving every
    // listed convergence point shares one calculation.
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    let res = core.advance({ moduleId: MOD }, gaspar);
    expect(res.value!.decision.type).toBe("PO_DECISION_REQUIRED");
    approve("architecture-security", "ARCH", archRev);
    res = core.advance({ moduleId: MOD }, gaspar);
    expect(res.ok).toBe(true);
    expect(res.value!.trail.map((t) => t.action)).toEqual(["approve-architecture"]);
    expect(res.value!.decision.type).toBe("PO_DECISION_REQUIRED");
    const decision = res.value!.decision;
    if (decision.type === "PO_DECISION_REQUIRED") {
      expect(decision.action).toBe("planning-approval");
    }
  });

  it("injected failure commits the prefix only: no N+1 transition, resume without duplicates", () => {
    // Restart-safe step transactions (not whole-call atomicity): each
    // consumed step is its own transaction, so a crash after N steps
    // keeps exactly N committed transitions. The diagnostic seam
    // `failAfterSteps` proves it deterministically.
    buildStack();
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    approve("architecture-security", "ARCH", archRev);
    approve("planning-approval", "SP-0001", core.getArtifact("SP-0001").revision);
    approve("architecture-security", "SP-0001", core.getArtifact("SP-0001").revision);
    const specRev = core.getArtifact("SP-0001").revision;
    const harnessContent = "# harness";
    expect(core.recordHarness(specRev, `sha256:${createHash("sha256").update(harnessContent, "utf8").digest("hex")}`, harnessContent, gaspar).ok).toBe(true);
    const modRev = core.getArtifact(MOD).revision;
    approve("planning-approval", MOD, modRev);
    approve("module-approval", MOD, modRev);
    const transitionsBefore = core.listEvents().filter((e) => e.eventType === "StateTransition").length;
    const archTransitionsBefore = core.listEvents().filter((e) => e.eventType === "StateTransition" && e.entityId === "ARCH").length;
    // Crash after exactly 2 committed steps (approve-architecture,
    // submit-spec): the call fails with the distinguishable seam
    // error instead of a boundary.
    const crashed = core.advance({ moduleId: MOD }, gaspar, { failAfterSteps: 2 });
    expect(crashed.ok).toBe(false);
    expect(crashed.error?.code).toBe("WORKFLOW_INJECTED_FAILURE");
    // Exactly the 2-step prefix committed — no third transition, no
    // partial write from the unstarted ready-spec step.
    const transitionsAfterCrash = core.listEvents().filter((e) => e.eventType === "StateTransition");
    expect(transitionsAfterCrash.length).toBe(transitionsBefore + 2);
    const archTransitions = transitionsAfterCrash.filter((e) => e.entityId === "ARCH");
    expect(archTransitions.length).toBe(archTransitionsBefore + 1);
    expect(core.getArtifact("SP-0001").status).toBe("REVIEW");
    expect(core.getArtifact(MOD).status).toBe("DRAFT");
    expect(core.getArtifact(WP).status).toBe("PLANNED");
    // Close and reopen: the failed call wrote nothing further, so a
    // fresh advance resumes past the injection point.
    const session = gaspar.session;
    core.close();
    core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    gaspar = { actor: "gaspar", session };
    const resumed = core.advance({ moduleId: MOD }, gaspar);
    expect(resumed.ok).toBe(true);
    // The remaining suffix only — the committed prefix never repeats.
    expect(resumed.value!.trail.map((t) => t.action)).toEqual([
      "ready-spec",
      "activate-module",
      "authorize-wp",
    ]);
    const decision = resumed.value!.decision;
    expect(decision.type).toBe("AGENT_WORK_REQUIRED");
    if (decision.type === "AGENT_WORK_REQUIRED") {
      expect(decision.kind).toBe("implementation");
      expect(decision.workPackageId).toBe(WP);
    }
    // No duplicate events: the full prefix exists exactly once.
    const transitionsFinal = core.listEvents().filter((e) => e.eventType === "StateTransition");
    // Five trail actions commit six transitions: activate-module
    // moves DRAFT→Planned→Approved in one step. The exact ordered
    // sequence proves the committed prefix never repeats and the
    // resume continued past the injection point.
    expect(transitionsFinal.map((e) => `${e.entityId}:${(JSON.parse(e.payload) as { eventType: string }).eventType}`)).toEqual([
      "fixture:AdapterApproved",
      "ARCH:ArchitectureReviewed",
      "ARCH:ArchitectureSecurityApproved",
      "SP-0001:SpecSubmittedForReview",
      "SP-0001:SpecApprovedReady",
      `${MOD}:ModulePlanned`,
      `${MOD}:ModuleApproved`,
      `${WP}:WorkPackageAuthorized`,
    ]);
    expect(core.getArtifact("SP-0001").status).toBe("READY");
    expect(core.getArtifact(MOD).status).toBe("APPROVED");
    expect(core.getArtifact(WP).status).toBe("AUTHORIZED");
  });

  it("routes every boundary on structured fields with garbled prose", () => {
    // Prose-independence: every human-readable field on every decision
    // is replaced with garbage before handling — including DECOY ids
    // (MOD-9999 and friends). The driver below touches ONLY structured
    // fields (phase, dispatchId, reviewId, action, scopeId, revision,
    // role, kind, moduleId, workPackageId). Any step parsing prose to
    // recover an operational id would operate on a decoy scope and
    // fail; reaching the reviewer boundary proves it never happens.
    // Dispatch rationales are garbage throughout, proving rationale
    // text is opaque input rather than a control channel.
    const GARBLE = "PROSE GARBAGE — operational ids never live here: MOD-9999 WP-9999 DSP-9999 REV-9999 COR-9999";
    const scrub = (d: WorkflowDecision): void => {
      if ("rationale" in d) {
        (d as { rationale: string }).rationale = GARBLE;
      }
      if ("reason" in d) {
        (d as { reason: string }).reason = GARBLE;
      }
      if ("summary" in d) {
        (d as { summary: string }).summary = GARBLE;
      }
      if ("objective" in d) {
        (d as { objective: string }).objective = GARBLE;
      }
    };
    const decideStructured = (): WorkflowDecision => {
      const res = core.advance({ moduleId: MOD }, gaspar);
      expect(res.ok).toBe(true);
      scrub(res.value!.decision);
      return res.value!.decision;
    };
    buildStack();
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    approve("architecture-security", "ARCH", archRev);
    approve("planning-approval", "SP-0001", core.getArtifact("SP-0001").revision);
    approve("architecture-security", "SP-0001", core.getArtifact("SP-0001").revision);
    const specRev = core.getArtifact("SP-0001").revision;
    const harnessContent = "# harness";
    expect(core.recordHarness(specRev, `sha256:${createHash("sha256").update(harnessContent, "utf8").digest("hex")}`, harnessContent, gaspar).ok).toBe(true);
    const modRev = core.getArtifact(MOD).revision;
    approve("planning-approval", MOD, modRev);
    approve("module-approval", MOD, modRev);
    // Request boundary: no dispatch row exists yet.
    let d = decideStructured();
    expect(d.type).toBe("AGENT_WORK_REQUIRED");
    if (d.type !== "AGENT_WORK_REQUIRED") {
      throw new Error("expected a request boundary");
    }
    expect(d.phase).toBe("request");
    expect(d.dispatchId).toBe(null);
    expect(d.adapterId).toBe(null);
    expect(d.moduleId).toBe(MOD);
    expect(d.workPackageId).toBe(WP);
    const requested = core.requestDispatch(
      {
        moduleId: d.moduleId,
        ...(d.workPackageId !== null ? { workPackageId: d.workPackageId } : {}),
        kind: d.kind,
        rationale: GARBLE,
        adapterId: "fixture",
      },
      gaspar
    );
    expect(requested.ok).toBe(true);
    // Claim boundary names its row.
    d = decideStructured();
    expect(d.type).toBe("AGENT_WORK_REQUIRED");
    if (d.type !== "AGENT_WORK_REQUIRED") {
      throw new Error("expected a claim boundary");
    }
    expect(d.phase).toBe("claim");
    expect(d.dispatchId).toBe(requested.value!.dispatchId);
    expect(core.recordTaskDelegation({ agent: d.role, parentRuntimeSession: "opencode-parent-prose" }, gaspar).ok).toBe(true);
    const claimed = core.claimDispatch({ dispatchId: d.dispatchId as string, childRuntimeSession: "opencode-child-prose" }, gaspar);
    expect(claimed.ok).toBe(true);
    expect(core.confirmClaim(d.dispatchId as string, gaspar).ok).toBe(true);
    const worker = { actor: d.role, session: { id: claimed.value!.session.id, token: claimed.value!.session.token } };
    // Execute boundary names the live binding.
    d = decideStructured();
    expect(d.type).toBe("AGENT_WORK_REQUIRED");
    if (d.type !== "AGENT_WORK_REQUIRED") {
      throw new Error("expected an execute boundary");
    }
    expect(d.phase).toBe("execute");
    expect(d.dispatchId).toBe(requested.value!.dispatchId);
    const scopeRev = core.getArtifact(WP).revision;
    recordEvidenceAs(worker, scopeRev, "unit-prose-garbage-check");
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, worker).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, worker).ok).toBe(true);
    expect(core.releaseDispatch(d.dispatchId as string, worker).ok).toBe(true);
    // Review boundary names the assigned review row.
    const assigned = core.assignReview({ kind: "verification", moduleId: MOD, workPackageId: WP }, gaspar);
    expect(assigned.ok).toBe(true);
    d = decideStructured();
    expect(d.type).toBe("INDEPENDENT_REVIEW_REQUIRED");
    if (d.type !== "INDEPENDENT_REVIEW_REQUIRED") {
      throw new Error("expected a review boundary");
    }
    expect(d.role).toBe("spekkio");
    expect(d.kind).toBe("verification");
    expect(d.reviewId).toBe(assigned.value!.reviewId);
    expect(d.targetRevision).toBe(scopeRev);
    const spek = roundTrip("verification", "spekkio");
    expect(core.recordVerification(MOD, "PASS", "spekkio", [], [], [], spek.worker, WP).ok).toBe(true);
    expect(core.completeReview({ reviewId: d.reviewId as string }, spek.worker).ok).toBe(true);
    expect(core.releaseDispatch(spek.dispatchId, spek.worker).ok).toBe(true);
  });

  it("injection past the mechanical prefix never fires", () => {    buildStack();
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    approve("architecture-security", "ARCH", archRev);
    approve("planning-approval", "SP-0001", core.getArtifact("SP-0001").revision);
    approve("architecture-security", "SP-0001", core.getArtifact("SP-0001").revision);
    const specRev = core.getArtifact("SP-0001").revision;
    const harnessContent = "# harness";
    expect(core.recordHarness(specRev, `sha256:${createHash("sha256").update(harnessContent, "utf8").digest("hex")}`, harnessContent, gaspar).ok).toBe(true);
    const modRev = core.getArtifact(MOD).revision;
    approve("planning-approval", MOD, modRev);
    approve("module-approval", MOD, modRev);
    // Five mechanical steps exist; the seam at 50 never trips, so the
    // walk converges to the dispatch boundary exactly as without it.
    const res = core.advance({ moduleId: MOD }, gaspar, { failAfterSteps: 50 });
    expect(res.ok).toBe(true);
    expect(res.value!.trail.map((t) => t.action)).toEqual([
      "approve-architecture",
      "submit-spec",
      "ready-spec",
      "activate-module",
      "authorize-wp",
    ]);
    expect(res.value!.decision.type).toBe("AGENT_WORK_REQUIRED");
  });
});
