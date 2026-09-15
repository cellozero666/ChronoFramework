/**
 * Lifecycle status queries (CORE_FIX CF-6, CF-8): nextAction derives the
 * single highest-precedence action from Core records; executionStatus
 * and evidenceStatus project scoped state without secrets; the deep
 * integrity check surfaces cross-record inconsistency before
 * completion. Workers are confined to their own scope throughout.
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
const MOD = { id: "MOD-0002", name: "M", purpose: "P", specs: ["SP-0001"] };

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

describe("Lifecycle status (next-action, execution, evidence, deep check)", () => {
  let tempDir: string;
  let core: ChronoCore;
  let signingKey = "";
  let gaspar: { actor: string; session: { id: string; token: string } };
  let restoreTty: () => void;
  let wpRev = "";

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
        sessionRole: role, adapter: "test-adapter", runtime: "test-runtime",
        scopeModule: null, scopeWp: null, ttlSeconds: 3600, nonce,
        authority: "PO", rationale: "test", timestamp,
      }),
      key
    );
    const res = core.openSession(
      { role, adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
      { poAuthorization: { nonce, authority: "PO", rationale: "test", timestamp, signature } }
    );
    expect(res.ok).toBe(true);
    return { id: res.value!.id, token: res.value!.token };
  }

  function recordEvidence(auth: CallerAuth, targetRevision: string, checkName: string): string {
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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-status-test-"));
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
    expect(core.registerModule("MOD-0002", "DRAFT", MOD, gaspar).ok).toBe(true);
    expect(
      core.registerWorkPackage("WP-0001", "PLANNED", { id: "WP-0001", name: "W", module: "MOD-0002", dependsOn: [] }, gaspar).ok
    ).toBe(true);
    expect(core.transitionState("MOD-0002", "ModulePlanned", gaspar).ok).toBe(true);
    // Converged activation authority (CF2-2): status, dispatch, and
    // completion projections presuppose BOTH current approvals.
    approve("planning-approval", "MOD-0002", core.getArtifact("MOD-0002").revision);
    approve("module-approval", "MOD-0002", core.getArtifact("MOD-0002").revision);
    expect(core.transitionState("MOD-0002", "ModuleApproved", gaspar).ok).toBe(true);
    expect(core.transitionState("WP-0001", "WorkPackageAuthorized", gaspar).ok).toBe(true);
    wpRev = core.getArtifact("WP-0001").revision;
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

  function requestAndDelegate(agent = "belthazar"): string {
    const requested = core.requestDispatch(
      { moduleId: "MOD-0002", workPackageId: "WP-0001", rationale: "drive the status flow", adapterId: "fixture" },
      gaspar
    );
    expect(requested.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent, parentRuntimeSession: "opencode-parent-1" }, gaspar).ok).toBe(true);
    return requested.value!.dispatchId;
  }

  it("aggregate module completion waits for every work package", () => {
    const done = core.completeModule("MOD-0002", gaspar);
    expect(done.ok).toBe(false);
    expect(done.error?.code).toBe("COMPLETION_DENIED");
    expect(done.error?.message).toContain("WP-0001");
    const next = core.nextAction({ moduleId: "MOD-0002" }, gaspar);
    expect(next.ok).toBe(true);
    // The concrete package action outranks the abstract module step:
    // an undispatched AUTHORIZED package dispatches first (CF-12).
    expect(next.value!.action).toBe("request-dispatch");
    expect(next.value!.targetId).toBe("WP-0001");
    expect(next.value!.kind).toBe("implementation");
  });

  it("reports dispatch first on a fresh package, citing the effective profile", () => {
    const next = core.nextAction({ workPackageId: "WP-0001" }, gaspar);
    expect(next.ok).toBe(true);
    expect(next.value!.action).toBe("request-dispatch");
    expect(next.value!.targetId).toBe("WP-0001");
    expect(next.value!.kind).toBe("implementation");
    expect(next.value!.policyRule).toContain("profile=standard");
  });

  it("walks claim, confirm, and execute precedence as the dispatch advances", () => {
    const dispatchId = requestAndDelegate();
    expect(core.nextAction({ workPackageId: "WP-0001" }, gaspar).value!.action).toBe("claim-dispatch");
    const claimed = core.claimDispatch({ dispatchId, childRuntimeSession: "opencode-child-1" }, gaspar);
    expect(claimed.ok).toBe(true);
    expect(core.nextAction({ workPackageId: "WP-0001" }, gaspar).value!.action).toBe("confirm-dispatch");
    expect(core.confirmClaim(dispatchId, gaspar).ok).toBe(true);
    const next = core.nextAction({ workPackageId: "WP-0001" }, gaspar);
    expect(next.value!.action).toBe("execute-dispatch");
    expect(next.value!.policyRule).toContain("attempt 1");
  });

  it("execution status shows the live binding to its worker and nothing secret", () => {
    const dispatchId = requestAndDelegate();
    const claimed = core.claimDispatch({ dispatchId, childRuntimeSession: "opencode-child-1" }, gaspar);
    expect(claimed.ok).toBe(true);
    expect(core.confirmClaim(dispatchId, gaspar).ok).toBe(true);
    const worker: CallerAuth = {
      actor: "belthazar",
      session: { id: claimed.value!.session.id, token: claimed.value!.session.token },
    };
    const status = core.executionStatus({ workPackageId: "WP-0001" }, worker);
    expect(status.ok).toBe(true);
    expect(status.value!.ownDispatch).toMatchObject({ dispatchId, status: "ACTIVE", role: "belthazar" });
    expect(status.value!.ownDispatch!.grantId).toMatch(/^GRANT-[0-9]{4}$/);
    expect(status.value!.packages).toHaveLength(1);
    expect(JSON.stringify(status.value!)).not.toContain(claimed.value!.session.token);
    // Gaspar sees the same open dispatch without holding the binding.
    const overseer = core.executionStatus({ moduleId: "MOD-0002" }, gaspar);
    expect(overseer.ok).toBe(true);
    expect(overseer.value!.openDispatches).toHaveLength(1);
    expect(overseer.value!.ownDispatch).toBe(null);
  });

  it("evidence status lists current rows by id and hides stale history", () => {
    const workerSession = core.openSession(
      { role: "belthazar", adapter: "test-adapter", runtime: "test-runtime", scopeModule: "MOD-0002", ttlSeconds: 3600 },
      { interactive: true }
    );
    expect(workerSession.ok).toBe(true);
    const worker: CallerAuth = { actor: "belthazar", session: { id: workerSession.value!.id, token: workerSession.value!.token } };
    const evidenceId = recordEvidence(worker, wpRev, "unit");
    const status = core.evidenceStatus({ targetRevision: wpRev }, worker);
    expect(status.ok).toBe(true);
    expect(status.value!.current).toHaveLength(1);
    expect(status.value!.current[0]).toMatchObject({ evidenceId, producer: "belthazar", check: "unit", result: "pass" });
    expect(status.value!.staleSuperseded).toBe(0);
    // Workers cannot probe revisions outside their scope.
    const foreign = core.evidenceStatus({ targetRevision: "sha256:ffffffff" }, worker);
    expect(foreign.ok).toBe(false);
  });

  it("module activation advances DRAFT to APPROVED exactly once through both approvals", () => {
    expect(core.registerModule("MOD-0009", "DRAFT", { id: "MOD-0009", name: "N", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
    expect(
      core.registerWorkPackage("WP-0009", "PLANNED", { id: "WP-0009", name: "W9", module: "MOD-0009", dependsOn: [] }, gaspar).ok
    ).toBe(true);
    const modRev = core.getArtifact("MOD-0009").revision;
    // No approvals: the PO ceremony holds the workflow, named explicitly.
    const waiting = core.nextAction({ moduleId: "MOD-0009" }, gaspar);
    expect(waiting.ok).toBe(true);
    expect(waiting.value!.action).toBe("await-approval");
    expect(waiting.value!.reason).toContain("planning-approval");
    // A planning approval alone never turns into module authority.
    approve("planning-approval", "MOD-0009", modRev);
    expect(core.activateModule("MOD-0009", gaspar).ok).toBe(false);
    expect(core.getArtifact("MOD-0009").status).toBe("DRAFT");
    const both = core.nextAction({ moduleId: "MOD-0009" }, gaspar);
    expect(both.value!.action).toBe("await-approval");
    expect(both.value!.reason).toContain("module-approval");
    // Both approvals current: activation is the executable next step.
    approve("module-approval", "MOD-0009", modRev);
    const ready = core.nextAction({ moduleId: "MOD-0009" }, gaspar);
    expect(ready.value!.action).toBe("activate-module");
    const activated = core.activateModule("MOD-0009", gaspar);
    expect(activated.ok).toBe(true);
    expect(activated.value!).toMatchObject({ state: "APPROVED", activated: true });
    expect(core.getArtifact("MOD-0009").status).toBe("APPROVED");
    // Idempotent replay: current projection, zero duplicated transitions.
    const transitionsFor = (id: string): string[] =>
      core.listEvents()
        .filter((e) => e.entityId === id && e.eventType === "StateTransition")
        .map((e) => (JSON.parse(e.payload) as { eventType: string }).eventType);
    expect(transitionsFor("MOD-0009")).toEqual(["ModulePlanned", "ModuleApproved"]);
    const replay = core.activateModule("MOD-0009", gaspar);
    expect(replay.ok).toBe(true);
    expect(replay.value!).toMatchObject({ state: "APPROVED", activated: false });
    expect(transitionsFor("MOD-0009")).toEqual(["ModulePlanned", "ModuleApproved"]);
    // The repaired sequence continues: authorize the package next.
    const next = core.nextAction({ moduleId: "MOD-0009" }, gaspar);
    expect(next.value!.action).toBe("authorize-wp");
    expect(next.value!.targetId).toBe("WP-0009");
  });

  it("activation resumes from partial AWAITING_APPROVAL without duplicating transitions", () => {
    expect(core.registerModule("MOD-0010", "DRAFT", { id: "MOD-0010", name: "N", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
    const modRev = core.getArtifact("MOD-0010").revision;
    approve("planning-approval", "MOD-0010", modRev);
    approve("module-approval", "MOD-0010", modRev);
    // Simulate a crash between the two activation transitions.
    expect(core.transitionState("MOD-0010", "ModulePlanned", gaspar).ok).toBe(true);
    expect(core.getArtifact("MOD-0010").status).toBe("AWAITING_APPROVAL");
    const resumed = core.activateModule("MOD-0010", gaspar);
    expect(resumed.ok).toBe(true);
    expect(resumed.value!).toMatchObject({ state: "APPROVED", activated: true });
    const transitions = core.listEvents()
      .filter((e) => e.entityId === "MOD-0010" && e.eventType === "StateTransition")
      .map((e) => (JSON.parse(e.payload) as { eventType: string }).eventType);
    expect(transitions).toEqual(["ModulePlanned", "ModuleApproved"]);
  });

  it("reviews refuse premature assignment before committing rows", () => {
    expect(core.registerModule("MOD-0011", "DRAFT", { id: "MOD-0011", name: "N", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
    expect(
      core.registerWorkPackage("WP-0011", "PLANNED", { id: "WP-0011", name: "W11", module: "MOD-0011", dependsOn: [] }, gaspar).ok
    ).toBe(true);
    // Activation authority precedes reviewability (CF2-2): the DRAFT
    // module holds no approvals, so assignment denies on authority —
    // still without committing a row.
    const denied = core.assignReview({ kind: "verification", moduleId: "MOD-0011", workPackageId: "WP-0011" }, gaspar);
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("APPROVAL_REQUIRED");
    // No row was committed: deep check finds no premature review.
    const checked = core.deepIntegrityCheck(gaspar);
    expect(checked.ok).toBe(true);
    expect(checked.value!.findings.filter((f) => f.check === "premature-review")).toHaveLength(0);
    // The DRAFT module still needs activation first.
    expect(core.nextAction({ workPackageId: "WP-0011" }, gaspar).value!.action).toBe("await-approval");
  });

  it("reviews refuse non-reviewable scopes once authority is current", () => {
    // Positioned but not reviewable: AUTHORIZED packages carry no
    // positioned work, so reviewability — not authority — denies.
    const denied = core.assignReview({ kind: "verification", moduleId: "MOD-0002", workPackageId: "WP-0001" }, gaspar);
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("EXECUTION_DENIED");
    expect(denied.error?.message).toContain("IMPLEMENTED or VERIFYING");
  });

  it("reconcile preserves premature reviews as invalid non-blocking history", async () => {
    const { ChronoDatabase } = await import("@chrono/persistence");
    expect(core.registerModule("MOD-0012", "DRAFT", { id: "MOD-0012", name: "N", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
    expect(
      core.registerWorkPackage("WP-0012", "PLANNED", { id: "WP-0012", name: "W12", module: "MOD-0012", dependsOn: [] }, gaspar).ok
    ).toBe(true);
    // Legacy row simulation: committed by pre-gating code against a
    // scope that could never enter verification. Public repository
    // API only — no decisions faked, no private helpers.
    const legacy = new ChronoDatabase({ path: join(tempDir, ".chrono", "chrono.db") });
    try {
      legacy.reviewAssignments().create({
        id: "REV-0001", kind: "verification", moduleId: "MOD-0012", workPackageId: "WP-0012",
        targetRevision: core.getArtifact("WP-0012").revision, reviewerRole: "spekkio", createdAt: new Date().toISOString(),
      });
    } finally {
      legacy.close();
    }
    // Deep check names the contradiction class precisely.
    const flagged = core.deepIntegrityCheck(gaspar);
    expect(flagged.ok).toBe(true);
    const premature = flagged.value!.findings.filter((f) => f.check === "premature-review");
    expect(premature).toHaveLength(1);
    expect(premature[0]!.detail).toContain("REV-0001");
    // Reconcile: INVALID terminal history, never blocking, never deletable.
    const reconciled = core.reconcileReview({ reviewId: "REV-0001" }, gaspar);
    expect(reconciled.ok).toBe(true);
    expect(reconciled.value!.status).toBe("INVALID");
    expect(core.reconcileReview({ reviewId: "REV-0001" }, gaspar).ok).toBe(false);
    // The repaired workflow proceeds: with no approvals recorded the
    // PO ceremony holds the module, and the INVALID row neither
    // blocks completion checks nor resurfaces as submittable.
    const next = core.nextAction({ moduleId: "MOD-0012" }, gaspar);
    expect(next.ok).toBe(true);
    expect(next.value!.action).toBe("await-approval");
    expect(next.value!.reason).toContain("planning-approval");
  });

  it("deep check is clean on a healthy project and flags expired intents", () => {
    const clean = core.deepIntegrityCheck(gaspar);
    expect(clean.ok).toBe(true);
    expect(clean.value!.blockerCount).toBe(0);
    expect(clean.value!.warningCount).toBe(0);
    // An intent that outlives its TTL surfaces as a warning with the
    // exact repair (reconcile), not as silent backlog.
    const shortLived = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime", grantTtlSeconds: 0 });
    try {
      const requested = shortLived.requestDispatch(
        { moduleId: "MOD-0002", workPackageId: "WP-0001", rationale: "expire immediately", adapterId: "fixture" },
        { actor: "gaspar", session: gaspar.session }
      );
      expect(requested.ok).toBe(true);
    } finally {
      shortLived.close();
    }
    const flagged = core.deepIntegrityCheck(gaspar);
    expect(flagged.ok).toBe(true);
    expect(flagged.value!.warningCount).toBe(1);
    expect(flagged.value!.findings[0]!.check).toBe("pending-expired");
    // Workers cannot run the deep check.
    const workerSession = core.openSession(
      { role: "belthazar", adapter: "test-adapter", runtime: "test-runtime", scopeModule: "MOD-0002", ttlSeconds: 3600 },
      { interactive: true }
    );
    expect(workerSession.ok).toBe(true);
    const worker: CallerAuth = { actor: "belthazar", session: { id: workerSession.value!.id, token: workerSession.value!.token } };
    expect(core.deepIntegrityCheck(worker).ok).toBe(false);
  });
});
