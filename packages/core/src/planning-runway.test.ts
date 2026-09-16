/**
 * Planning-runway vertical (gate item 5 + required regression §8):
 * starting from approved planning artifacts but DRAFT
 * architecture/spec lifecycle states, the workflow follows ONLY
 * Core-returned next actions — architecture submission and approval,
 * spec planning ceremony, spec submission, Harness recording, spec
 * READY, module activation, WP authorization — until native dispatch
 * becomes available.
 *
 * Every observation is checked two ways: the action belongs to the
 * shared NEXT_ACTIONS universe (which the Gaspar map and the policy
 * parity test bind to classified native tools), and
 * `verifyReportedAction` independently re-derives it through the
 * shared dry-run source (the same function `deep_check` uses). No
 * Product Owner shell command, token handling, internal ID plumbing,
 * or manual lifecycle recovery appears anywhere: all operations run
 * through public Core methods with a Gaspar session, and PO
 * approvals are genuine signatures recorded between an advertised
 * ceremony hold and its re-observation — never between an
 * observation and its execution.
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
import { ChronoCore, NEXT_ACTIONS, type NextAction } from "./chrono-core.js";

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
const MOD = "MOD-0050";
const WP = "WP-0050";

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

describe("Planning runway to dispatch (Core-owned coordination)", () => {
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

  /**
   * The executable contract, extended to the runway: the reported
   * action must be in the shared universe AND independently verify
   * through `verifyReportedAction` (the deep-check function). This
   * single-module fixture always scopes verification to MOD-0050.
   */
  function expectRunwayAction(
    scope: { moduleId?: string; workPackageId?: string },
    allowed: string[]
  ): NextAction {
    const next = core.nextAction(scope, gaspar);
    expect(next.ok).toBe(true);
    expect((NEXT_ACTIONS as readonly string[])).toContain(next.value!.action);
    expect(allowed).toContain(next.value!.action);
    const verified = core.verifyReportedAction(
      { moduleId: MOD, workPackageId: scope.workPackageId ?? null },
      next.value!,
      gaspar
    );
    expect(verified).toEqual([]);
    return next.value!;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-runway-test-"));
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
    // Planning layer done, lifecycle states DRAFT: architecture
    // proposed (never submitted), spec registered DRAFT (planning
    // approval recorded below in each test's order), module DRAFT
    // with both approvals, package PLANNED, full execution stack.
    const proposed = core.proposeArchitecture({ title: "A" }, gaspar);
    expect(proposed.ok).toBe(true);
    archRev = proposed.value!;
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    expect(core.registerModule(MOD, "DRAFT", { id: MOD, name: "M", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
    expect(
      core.registerWorkPackage(WP, "PLANNED", { id: WP, name: "W", module: MOD, dependsOn: [] }, gaspar).ok
    ).toBe(true);
    const modRev = core.getArtifact(MOD).revision;
    approve("planning-approval", MOD, modRev);
    approve("module-approval", MOD, modRev);
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

  it("walks architecture, spec planning, submission, harness, READY, activation, authorization to dispatch on Core actions only", () => {
    // Architecture proposed: submission is the executable step.
    const submitted = expectRunwayAction({ moduleId: MOD }, ["submit-architecture"]);
    expect(submitted.targetKind).toBe("architecture");
    expect(submitted.targetId).toBe("ARCH");
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    // Under review without approval: the ceremony hold names its
    // approval, scope, and revision — never a vague wait.
    const hold = expectRunwayAction({ moduleId: MOD }, ["request-approval"]);
    expect(hold.kind).toBe("architecture-security");
    expect(hold.targetKind).toBe("architecture");
    expect(hold.targetId).toBe("ARCH");
    // The PO ceremony binds the exact current architecture revision;
    // re-observation advertises the transition — nothing runs between.
    approve("architecture-security", "ARCH", archRev);
    expectRunwayAction({ moduleId: MOD }, ["approve-architecture"]);
    expect(core.approveArchitecture(gaspar).ok).toBe(true);
    // DRAFT spec without planning approval: the ceremony hold — NOT
    // a generic await-approval.
    const specHold = expectRunwayAction({ moduleId: MOD }, ["request-approval"]);
    expect(specHold.kind).toBe("planning-approval");
    expect(specHold.targetKind).toBe("spec");
    expect(specHold.targetId).toBe("SP-0001");
    approve("planning-approval", "SP-0001", core.getArtifact("SP-0001").revision);
    // Spec DRAFT with planning current: submission, not a hold.
    expectRunwayAction({ moduleId: MOD }, ["submit-spec"]);
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar).ok).toBe(true);
    // REVIEW without spec approval: ceremony hold again.
    const reviewHold = expectRunwayAction({ moduleId: MOD }, ["request-approval"]);
    expect(reviewHold.kind).toBe("architecture-security");
    expect(reviewHold.targetKind).toBe("spec");
    expect(reviewHold.targetId).toBe("SP-0001");
    approve("architecture-security", "SP-0001", core.getArtifact("SP-0001").revision);
    // REVIEW without Harness: record it, then release to READY.
    expectRunwayAction({ moduleId: MOD }, ["record-harness"]);
    const specRev = core.getArtifact("SP-0001").revision;
    const harnessContent = "# harness for SP-0001";
    expect(
      core.recordHarness(specRev, `sha256:${createHash("sha256").update(harnessContent, "utf8").digest("hex")}`, harnessContent, gaspar).ok
    ).toBe(true);
    expectRunwayAction({ moduleId: MOD }, ["ready-spec"]);
    expect(core.transitionState("SP-0001", "SpecApprovedReady", gaspar).ok).toBe(true);
    // Runway clear: activation, authorization, then dispatch.
    expectRunwayAction({ moduleId: MOD }, ["activate-module"]);
    expect(core.activateModule(MOD, gaspar).ok).toBe(true);
    expectRunwayAction({ moduleId: MOD }, ["authorize-wp"]);
    expect(core.transitionState(WP, "WorkPackageAuthorized", gaspar).ok).toBe(true);
    const dispatched = expectRunwayAction({ workPackageId: WP }, ["request-dispatch"]);
    expect(dispatched.kind).toBe("implementation");
  });
});
