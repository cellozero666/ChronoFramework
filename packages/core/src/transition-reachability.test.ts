/**
 * Transition-reachability meta-test (CF-12 req 9): every nonterminal
 * Module and Work Package state must resolve, through the SAME
 * executable precondition source (`nextAction` + `checkActionPreconditions`
 * + `verifyReportedAction`), to at least one legal forward, correction,
 * escalation, or explicitly PO-blocked action. States are built
 * exclusively through public Core operations; terminal COMPLETE states
 * are excluded by definition (their action is `done`).
 *
 * This prevents future unreachable states from being discovered one at
 * a time through paid testing: any state the lifecycle can persist but
 * no native/public operation can advance fails here first.
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
import { ChronoCore, type CallerAuth, type NextAction } from "./chrono-core.js";

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

/** Deep-check finding names owned by the CF-12 reachability audit. */
const REACHABILITY_CHECKS = [
  "approval-without-activation",
  "premature-review",
  "unreachable-next-action",
  "missing-transition-surface",
];

describe("Transition reachability (every nonterminal MOD/WP state)", () => {
  let tempDir: string;
  let core: ChronoCore;
  let signingKey = "";
  let gaspar: { actor: string; session: { id: string; token: string } };
  let restoreTty: () => void;

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

  function openWorker(role: string, scopeModule?: string): CallerAuth {
    const res = core.openSession(
      {
        role, adapter: "test-adapter", runtime: "test-runtime",
        ...(scopeModule !== undefined ? { scopeModule } : {}),
        ttlSeconds: 3600,
      },
      { interactive: true }
    );
    expect(res.ok).toBe(true);
    return { actor: role, session: { id: res.value!.id, token: res.value!.token } };
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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-reach-test-"));
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

  /** Module owning each registered Work Package (test-side scope map). */
  const wpModule = new Map<string, string>();

  function registerModuleWithPackages(modId: string, wpIds: string[]): void {
    expect(core.registerModule(modId, "DRAFT", { id: modId, name: "M", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
    for (const wpId of wpIds) {
      expect(
        core.registerWorkPackage(wpId, "PLANNED", { id: wpId, name: "W", module: modId, dependsOn: [] }, gaspar).ok
      ).toBe(true);
      wpModule.set(wpId, modId);
    }
  }

  /**
   * The executable contract: the reported action must be in the
   * state allowlist AND independently verify through the shared
   * dry-run source (`verifyReportedAction`, the same function
   * `deep_check` uses — never a divergent copy).
   */
  function expectAction(
    scope: { moduleId?: string; workPackageId?: string },
    auth: { actor: string; session: { id: string; token: string } },
    allowed: string[]
  ): NextAction {
    const next = core.nextAction(scope, auth);
    expect(next.ok).toBe(true);
    expect(allowed).toContain(next.value!.action);
    const moduleId = scope.workPackageId !== undefined
      ? (wpModule.get(scope.workPackageId) as string)
      : (scope.moduleId as string);
    expect(moduleId).toBeTruthy();
    const verified = core.verifyReportedAction(
      { moduleId, workPackageId: scope.workPackageId ?? null },
      next.value!,
      gaspar
    );
    expect(verified).toEqual([]);
    return next.value!;
  }

  /** Deep check carries none of the reachability-audit findings. */
  function expectDeepClean(): void {
    const checked = core.deepIntegrityCheck(gaspar);
    expect(checked.ok).toBe(true);
    const hits = checked.value!.findings.filter((f) => REACHABILITY_CHECKS.includes(f.check));
    expect(hits).toEqual([]);
  }

  /** Register a module; approve planning, module, or both at the current revision. */
  function rigModule(modId: string, approvals: Array<"planning-approval" | "module-approval"> = []): string {
    expect(core.registerModule(modId, "DRAFT", { id: modId, name: "M", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
    const rev = core.getArtifact(modId).revision;
    for (const action of approvals) {
      approve(action, modId, rev);
    }
    return rev;
  }

  function moduleTransitions(modId: string): string[] {
    return core.listEvents()
      .filter((e) => e.entityId === modId && e.eventType === "StateTransition")
      .map((e) => (JSON.parse(e.payload) as { eventType: string }).eventType);
  }

  it("MOD DRAFT without approvals waits on the PO ceremony", () => {
    registerModuleWithPackages("MOD-0010", []);
    const action = expectAction({ moduleId: "MOD-0010" }, gaspar, ["await-approval"]);
    expect(action.reason).toContain("planning-approval");
    expectDeepClean();
  });

  it("MOD DRAFT with planning approval only waits on the module decision", () => {
    const rev = rigModule("MOD-0011", ["planning-approval"]);
    void rev;
    const action = expectAction({ moduleId: "MOD-0011" }, gaspar, ["await-approval"]);
    expect(action.reason).toContain("module-approval");
    // A planning approval alone never activates, even when executed.
    expect(core.activateModule("MOD-0011", gaspar).ok).toBe(false);
    expect(core.getArtifact("MOD-0011").status).toBe("DRAFT");
    expectDeepClean();
  });

  it("MOD DRAFT with both approvals activates exactly once", () => {
    rigModule("MOD-0012", ["planning-approval", "module-approval"]);
    expectAction({ moduleId: "MOD-0012" }, gaspar, ["activate-module"]);
    const first = core.activateModule("MOD-0012", gaspar);
    expect(first.ok).toBe(true);
    expect(first.value!).toMatchObject({ state: "APPROVED", activated: true });
    expect(moduleTransitions("MOD-0012")).toEqual(["ModulePlanned", "ModuleApproved"]);
    const replay = core.activateModule("MOD-0012", gaspar);
    expect(replay.ok).toBe(true);
    expect(replay.value!).toMatchObject({ state: "APPROVED", activated: false });
    expect(moduleTransitions("MOD-0012")).toEqual(["ModulePlanned", "ModuleApproved"]);
    expectDeepClean();
  });

  it("MOD AWAITING_APPROVAL resumes activation without duplicating transitions", () => {
    const rev = rigModule("MOD-0013", ["planning-approval", "module-approval"]);
    void rev;
    expect(core.transitionState("MOD-0013", "ModulePlanned", gaspar).ok).toBe(true);
    expectAction({ moduleId: "MOD-0013" }, gaspar, ["activate-module"]);
    const resumed = core.activateModule("MOD-0013", gaspar);
    expect(resumed.ok).toBe(true);
    expect(resumed.value!).toMatchObject({ state: "APPROVED", activated: true });
    expect(moduleTransitions("MOD-0013")).toEqual(["ModulePlanned", "ModuleApproved"]);
    expectDeepClean();
  });

  it("MOD APPROVED without packages dispatches implementation", () => {
    const rev = rigModule("MOD-0014", ["planning-approval", "module-approval"]);
    void rev;
    expect(core.activateModule("MOD-0014", gaspar).ok).toBe(true);
    const action = expectAction({ moduleId: "MOD-0014" }, gaspar, ["request-dispatch"]);
    expect(action.kind).toBe("implementation");
    expectDeepClean();
  });

  it("package-less MOD FAILED with an open loop requests correction", () => {
    const rev = rigModule("MOD-0031", ["planning-approval", "module-approval"]);
    void rev;
    expect(core.activateModule("MOD-0031", gaspar).ok).toBe(true);
    const requested = core.requestDispatch(
      { moduleId: "MOD-0031", rationale: "drive the package-less failure flow", adapterId: "fixture" },
      gaspar
    );
    expect(requested.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent: "belthazar", parentRuntimeSession: "opencode-parent-1" }, gaspar).ok).toBe(true);
    const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: "opencode-child-1" }, gaspar);
    expect(claimed.ok).toBe(true);
    expect(core.confirmClaim(requested.value!.dispatchId, gaspar).ok).toBe(true);
    const worker: CallerAuth = {
      actor: "belthazar",
      session: { id: claimed.value!.session.id, token: claimed.value!.session.token },
    };
    const modRev = core.getArtifact("MOD-0031").revision;
    recordEvidenceAs(worker, modRev, "unit");
    expect(core.advanceScope({ moduleId: "MOD-0031", event: "ImplementationComplete" }, worker).ok).toBe(true);
    const verifying = core.requestDispatch(
      { moduleId: "MOD-0031", kind: "verification", rationale: "verify the failure flow", adapterId: "fixture" },
      gaspar
    );
    expect(verifying.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent: "spekkio", parentRuntimeSession: "opencode-parent-2" }, gaspar).ok).toBe(true);
    const vclaimed = core.claimDispatch({ dispatchId: verifying.value!.dispatchId, childRuntimeSession: "opencode-child-2" }, gaspar);
    expect(vclaimed.ok).toBe(true);
    expect(core.confirmClaim(verifying.value!.dispatchId, gaspar).ok).toBe(true);
    const spekkio: CallerAuth = {
      actor: "spekkio",
      session: { id: vclaimed.value!.session.id, token: vclaimed.value!.session.token },
    };
    const defect = core.recordDefect(
      {
        classification: "IMPLEMENTATION_DEFECT",
        severity: "major",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: ["MOD-0031"],
        blockingScope: "MOD-0031",
        reproInfo: null,
      },
      spekkio
    );
    expect(defect.ok).toBe(true);
    expect(core.recordVerification("MOD-0031", "FAILED", "spekkio", [defect.value!.id], [], [], spekkio).ok).toBe(true);
    expect(core.advanceScope({ moduleId: "MOD-0031", event: "SpekkioFailed" }, spekkio).ok).toBe(true);
    expect(core.getArtifact("MOD-0031").status).toBe("FAILED");
    // The FAILED verdict auto-opened the loop: correction dispatches.
    expectAction({ moduleId: "MOD-0031" }, gaspar, ["request-correction"]);
    const fix = core.requestDispatch(
      { moduleId: "MOD-0031", kind: "correction", rationale: "fix the package-less defect", adapterId: "fixture" },
      gaspar
    );
    expect(fix.ok).toBe(true);
    expectDeepClean();
  });

  it("MOD BLOCKED names its blocker as escalation", () => {
    const rev = rigModule("MOD-0015", ["planning-approval", "module-approval"]);
    void rev;
    expect(core.activateModule("MOD-0015", gaspar).ok).toBe(true);
    expect(core.raiseBlocker("PRODUCT_BLOCKER", ["MOD-0015"], "waiting on vendor", gaspar).ok).toBe(true);
    expectAction({ moduleId: "MOD-0015" }, gaspar, ["blocked"]);
    expectDeepClean();
  });

  it("WP PLANNED authorizes exactly once", () => {
    registerModuleWithPackages("MOD-0020", ["WP-0020"]);
    const rev = core.getArtifact("MOD-0020").revision;
    approve("planning-approval", "MOD-0020", rev);
    approve("module-approval", "MOD-0020", rev);
    expect(core.activateModule("MOD-0020", gaspar).ok).toBe(true);
    expectAction({ workPackageId: "WP-0020" }, gaspar, ["authorize-wp"]);
    expect(core.transitionState("WP-0020", "WorkPackageAuthorized", gaspar).ok).toBe(true);
    expect(core.getArtifact("WP-0020").status).toBe("AUTHORIZED");
    expect(core.transitionState("WP-0020", "WorkPackageAuthorized", gaspar).ok).toBe(false);
    expectDeepClean();
  });

  it("WP AUTHORIZED dispatches, claims, and confirms through one binding", () => {
    registerModuleWithPackages("MOD-0021", ["WP-0021"]);
    const rev = core.getArtifact("MOD-0021").revision;
    approve("planning-approval", "MOD-0021", rev);
    approve("module-approval", "MOD-0021", rev);
    expect(core.activateModule("MOD-0021", gaspar).ok).toBe(true);
    expect(core.transitionState("WP-0021", "WorkPackageAuthorized", gaspar).ok).toBe(true);
    const action = expectAction({ workPackageId: "WP-0021" }, gaspar, ["request-dispatch"]);
    expect(action.kind).toBe("implementation");
    const requested = core.requestDispatch(
      { moduleId: "MOD-0021", workPackageId: "WP-0021", rationale: "drive the reachability flow", adapterId: "fixture" },
      gaspar
    );
    expect(requested.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent: "belthazar", parentRuntimeSession: "opencode-parent-1" }, gaspar).ok).toBe(true);
    expectAction({ workPackageId: "WP-0021" }, gaspar, ["claim-dispatch"]);
    const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: "opencode-child-1" }, gaspar);
    expect(claimed.ok).toBe(true);
    expect(core.getArtifact("WP-0021").status).toBe("RUNNING");
    expectAction({ workPackageId: "WP-0021" }, gaspar, ["confirm-dispatch"]);
    expect(core.confirmClaim(requested.value!.dispatchId, gaspar).ok).toBe(true);
    const worker: CallerAuth = {
      actor: "belthazar",
      session: { id: claimed.value!.session.id, token: claimed.value!.session.token },
    };
    // The binding holder evidences; Gaspar observes execution.
    expectAction({ workPackageId: "WP-0021" }, worker, ["record-evidence"]);
    expectAction({ workPackageId: "WP-0021" }, gaspar, ["execute-dispatch"]);
    expectDeepClean();
  });

  it("WP RUNNING with evidence advances to IMPLEMENTED", () => {
    registerModuleWithPackages("MOD-0022", ["WP-0022"]);
    const rev = core.getArtifact("MOD-0022").revision;
    approve("planning-approval", "MOD-0022", rev);
    approve("module-approval", "MOD-0022", rev);
    expect(core.activateModule("MOD-0022", gaspar).ok).toBe(true);
    expect(core.transitionState("WP-0022", "WorkPackageAuthorized", gaspar).ok).toBe(true);
    const requested = core.requestDispatch(
      { moduleId: "MOD-0022", workPackageId: "WP-0022", rationale: "drive the reachability flow", adapterId: "fixture" },
      gaspar
    );
    expect(requested.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent: "belthazar", parentRuntimeSession: "opencode-parent-1" }, gaspar).ok).toBe(true);
    const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: "opencode-child-1" }, gaspar);
    expect(claimed.ok).toBe(true);
    expect(core.confirmClaim(requested.value!.dispatchId, gaspar).ok).toBe(true);
    const worker: CallerAuth = {
      actor: "belthazar",
      session: { id: claimed.value!.session.id, token: claimed.value!.session.token },
    };
    const wpRev = core.getArtifact("WP-0022").revision;
    recordEvidenceAs(worker, wpRev, "unit");
    expectAction({ workPackageId: "WP-0022" }, worker, ["record-evidence"]);
    expect(core.advanceScope({ moduleId: "MOD-0022", workPackageId: "WP-0022", event: "ImplementationDone" }, worker).ok).toBe(true);
    expect(core.getArtifact("WP-0022").status).toBe("IMPLEMENTED");
    // The live binding reports execution until released; reviews
    // assign once it settles on the stable revision.
    expectAction({ workPackageId: "WP-0022" }, gaspar, ["execute-dispatch"]);
    expect(core.releaseDispatch(requested.value!.dispatchId, worker).ok).toBe(true);
    const assigned = expectAction({ workPackageId: "WP-0022" }, gaspar, ["assign-review"]);
    expect(assigned.kind).toBe("verification");
    expect(core.assignReview({ kind: "verification", moduleId: "MOD-0022", workPackageId: "WP-0022" }, gaspar).ok).toBe(true);
    expectAction({ workPackageId: "WP-0022" }, gaspar, ["await-action"]);
    expectDeepClean();
  });

  it("WP IMPLEMENTED assigns verification, then awaits reviewer proof", () => {
    registerModuleWithPackages("MOD-0023", ["WP-0023"]);
    const rev = core.getArtifact("MOD-0023").revision;
    approve("planning-approval", "MOD-0023", rev);
    approve("module-approval", "MOD-0023", rev);
    expect(core.activateModule("MOD-0023", gaspar).ok).toBe(true);
    expect(core.transitionState("WP-0023", "WorkPackageAuthorized", gaspar).ok).toBe(true);
    const requested = core.requestDispatch(
      { moduleId: "MOD-0023", workPackageId: "WP-0023", rationale: "drive the reachability flow", adapterId: "fixture" },
      gaspar
    );
    expect(requested.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent: "belthazar", parentRuntimeSession: "opencode-parent-1" }, gaspar).ok).toBe(true);
    const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: "opencode-child-1" }, gaspar);
    expect(claimed.ok).toBe(true);
    expect(core.confirmClaim(requested.value!.dispatchId, gaspar).ok).toBe(true);
    const worker: CallerAuth = {
      actor: "belthazar",
      session: { id: claimed.value!.session.id, token: claimed.value!.session.token },
    };
    expect(core.advanceScope({ moduleId: "MOD-0023", workPackageId: "WP-0023", event: "ImplementationDone" }, worker).ok).toBe(true);
    // The live binding reports execution until released; reviews
    // assign once it settles on the stable revision.
    expectAction({ workPackageId: "WP-0023" }, gaspar, ["execute-dispatch"]);
    recordEvidenceAs(worker, core.getArtifact("WP-0023").revision, "unit");
    expect(core.releaseDispatch(requested.value!.dispatchId, worker).ok).toBe(true);
    const assigned = expectAction({ workPackageId: "WP-0023" }, gaspar, ["assign-review"]);
    expect(assigned.kind).toBe("verification");
    expect(core.assignReview({ kind: "verification", moduleId: "MOD-0023", workPackageId: "WP-0023" }, gaspar).ok).toBe(true);
    // Released with proof still missing: the reviewer is named.
    const waiting = expectAction({ workPackageId: "WP-0023" }, gaspar, ["await-action"]);
    expect(String(waiting.summary)).toContain("spekkio");
    expectDeepClean();
  });

  it("WP VERIFYING with proof submits, completes review, and requests completion", () => {
    registerModuleWithPackages("MOD-0024", ["WP-0024"]);
    const rev = core.getArtifact("MOD-0024").revision;
    approve("planning-approval", "MOD-0024", rev);
    approve("module-approval", "MOD-0024", rev);
    expect(core.activateModule("MOD-0024", gaspar).ok).toBe(true);
    expect(core.transitionState("WP-0024", "WorkPackageAuthorized", gaspar).ok).toBe(true);
    const requested = core.requestDispatch(
      { moduleId: "MOD-0024", workPackageId: "WP-0024", rationale: "drive the reachability flow", adapterId: "fixture" },
      gaspar
    );
    expect(requested.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent: "belthazar", parentRuntimeSession: "opencode-parent-1" }, gaspar).ok).toBe(true);
    const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: "opencode-child-1" }, gaspar);
    expect(claimed.ok).toBe(true);
    expect(core.confirmClaim(requested.value!.dispatchId, gaspar).ok).toBe(true);
    const worker: CallerAuth = {
      actor: "belthazar",
      session: { id: claimed.value!.session.id, token: claimed.value!.session.token },
    };
    const wpRev = core.getArtifact("WP-0024").revision;
    recordEvidenceAs(worker, wpRev, "unit");
    const lucca = openWorker("lucca", "MOD-0024");
    recordEvidenceAs(lucca, wpRev, "unit");
    expect(core.advanceScope({ moduleId: "MOD-0024", workPackageId: "WP-0024", event: "ImplementationDone" }, worker).ok).toBe(true);
    expect(core.advanceScope({ moduleId: "MOD-0024", workPackageId: "WP-0024", event: "VerificationReady" }, worker).ok).toBe(true);
    expect(core.assignReview({ kind: "verification", moduleId: "MOD-0024", workPackageId: "WP-0024" }, gaspar).ok).toBe(true);
    const spekkio = openWorker("spekkio", "MOD-0024");
    expect(core.recordVerification("MOD-0024", "PASS", "spekkio", [], [], [], spekkio, "WP-0024").ok).toBe(true);
    const submit = expectAction({ workPackageId: "WP-0024" }, spekkio, ["submit-review"]);
    const reviewId = submit.summary.match(/'(REV-[0-9]+)'/)?.[1];
    expect(reviewId).toBeTruthy();
    expect(core.completeReview({ reviewId: reviewId as string }, spekkio).ok).toBe(true);
    // Gaspar sees the live binding progressing, not a denial: the
    // ACTIVE dispatch outranks readiness until it is released.
    expectAction({ workPackageId: "WP-0024" }, gaspar, ["execute-dispatch"]);
    expect(core.releaseDispatch(requested.value!.dispatchId, worker).ok).toBe(true);
    expectAction({ workPackageId: "WP-0024" }, gaspar, ["request-completion"]);
    expectDeepClean();
  });

  it("WP BLOCKED names its blocker and WP FAILED routes correction", () => {
    registerModuleWithPackages("MOD-0025", ["WP-0025"]);
    const rev = core.getArtifact("MOD-0025").revision;
    approve("planning-approval", "MOD-0025", rev);
    approve("module-approval", "MOD-0025", rev);
    expect(core.activateModule("MOD-0025", gaspar).ok).toBe(true);
    expect(core.transitionState("WP-0025", "WorkPackageAuthorized", gaspar).ok).toBe(true);
    expect(core.raiseBlocker("PRODUCT_BLOCKER", ["WP-0025"], "waiting on vendor", gaspar).ok).toBe(true);
    expectAction({ workPackageId: "WP-0025" }, gaspar, ["blocked"]);
    expectDeepClean();
  });

  it("WP FAILED with an open loop requests correction, then corrects with a live binding", () => {
    registerModuleWithPackages("MOD-0026", ["WP-0026"]);
    const rev = core.getArtifact("MOD-0026").revision;
    approve("planning-approval", "MOD-0026", rev);
    approve("module-approval", "MOD-0026", rev);
    expect(core.activateModule("MOD-0026", gaspar).ok).toBe(true);
    expect(core.transitionState("WP-0026", "WorkPackageAuthorized", gaspar).ok).toBe(true);
    const requested = core.requestDispatch(
      { moduleId: "MOD-0026", workPackageId: "WP-0026", rationale: "drive the reachability flow", adapterId: "fixture" },
      gaspar
    );
    expect(requested.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent: "belthazar", parentRuntimeSession: "opencode-parent-1" }, gaspar).ok).toBe(true);
    const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: "opencode-child-1" }, gaspar);
    expect(claimed.ok).toBe(true);
    expect(core.confirmClaim(requested.value!.dispatchId, gaspar).ok).toBe(true);
    const worker: CallerAuth = {
      actor: "belthazar",
      session: { id: claimed.value!.session.id, token: claimed.value!.session.token },
    };
    const wpRev = core.getArtifact("WP-0026").revision;
    recordEvidenceAs(worker, wpRev, "unit");
    expect(core.advanceScope({ moduleId: "MOD-0026", workPackageId: "WP-0026", event: "ImplementationDone" }, worker).ok).toBe(true);
    expect(core.advanceScope({ moduleId: "MOD-0026", workPackageId: "WP-0026", event: "VerificationReady" }, worker).ok).toBe(true);
    // Verification binding for the verdict that follows.
    const verifying = core.requestDispatch(
      { moduleId: "MOD-0026", workPackageId: "WP-0026", kind: "verification", rationale: "verify the reachability flow", adapterId: "fixture" },
      gaspar
    );
    expect(verifying.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent: "spekkio", parentRuntimeSession: "opencode-parent-2" }, gaspar).ok).toBe(true);
    const vclaimed = core.claimDispatch({ dispatchId: verifying.value!.dispatchId, childRuntimeSession: "opencode-child-2" }, gaspar);
    expect(vclaimed.ok).toBe(true);
    expect(core.confirmClaim(verifying.value!.dispatchId, gaspar).ok).toBe(true);
    const spekkio: CallerAuth = {
      actor: "spekkio",
      session: { id: vclaimed.value!.session.id, token: vclaimed.value!.session.token },
    };
    const defect = core.recordDefect(
      {
        classification: "IMPLEMENTATION_DEFECT",
        severity: "major",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: ["WP-0026"],
        blockingScope: "WP-0026",
        reproInfo: null,
      },
      spekkio
    );
    expect(defect.ok).toBe(true);
    expect(core.recordVerification("MOD-0026", "FAILED", "spekkio", [defect.value!.id], [], [], spekkio, "WP-0026").ok).toBe(true);
    expect(core.advanceScope({ moduleId: "MOD-0026", workPackageId: "WP-0026", event: "SpekkioFailed" }, spekkio).ok).toBe(true);
    expect(core.getArtifact("WP-0026").status).toBe("FAILED");
    // The FAILED verdict auto-opened the loop: correction dispatches.
    expectAction({ workPackageId: "WP-0026" }, gaspar, ["request-correction"]);
    const fix = core.requestDispatch(
      { moduleId: "MOD-0026", workPackageId: "WP-0026", kind: "correction", rationale: "fix the reachability defect", adapterId: "fixture" },
      gaspar
    );
    expect(fix.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent: "belthazar", parentRuntimeSession: "opencode-parent-3" }, gaspar).ok).toBe(true);
    const fixClaimed = core.claimDispatch({ dispatchId: fix.value!.dispatchId, childRuntimeSession: "opencode-child-3" }, gaspar);
    expect(fixClaimed.ok).toBe(true);
    expect(core.getArtifact("WP-0026").status).toBe("RUNNING");
    expectAction({ workPackageId: "WP-0026" }, gaspar, ["correct-defect"]);
    const fixer: CallerAuth = {
      actor: "belthazar",
      session: { id: fixClaimed.value!.session.id, token: fixClaimed.value!.session.token },
    };
    recordEvidenceAs(fixer, wpRev, "fix");
    expectDeepClean();
  });

  it("package-less modules walk EXECUTING to COMPLETE with done terminal", () => {
    const rev = rigModule("MOD-0030", ["planning-approval", "module-approval"]);
    void rev;
    expect(core.activateModule("MOD-0030", gaspar).ok).toBe(true);
    expectAction({ moduleId: "MOD-0030" }, gaspar, ["request-dispatch"]);
    const requested = core.requestDispatch(
      { moduleId: "MOD-0030", rationale: "drive the package-less flow", adapterId: "fixture" },
      gaspar
    );
    expect(requested.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent: "belthazar", parentRuntimeSession: "opencode-parent-1" }, gaspar).ok).toBe(true);
    const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: "opencode-child-1" }, gaspar);
    expect(claimed.ok).toBe(true);
    expect(core.getArtifact("MOD-0030").status).toBe("EXECUTING");
    expect(core.confirmClaim(requested.value!.dispatchId, gaspar).ok).toBe(true);
    const worker: CallerAuth = {
      actor: "belthazar",
      session: { id: claimed.value!.session.id, token: claimed.value!.session.token },
    };
    expectAction({ moduleId: "MOD-0030" }, gaspar, ["execute-dispatch"]);
    expectAction({ moduleId: "MOD-0030" }, worker, ["record-evidence"]);
    const modRev = core.getArtifact("MOD-0030").revision;
    recordEvidenceAs(worker, modRev, "unit");
    const lucca = openWorker("lucca", "MOD-0030");
    recordEvidenceAs(lucca, modRev, "unit");
    expect(core.advanceScope({ moduleId: "MOD-0030", event: "ImplementationComplete" }, worker).ok).toBe(true);
    expect(core.getArtifact("MOD-0030").status).toBe("VERIFYING");
    expectAction({ moduleId: "MOD-0030" }, gaspar, ["execute-dispatch"]);
    expect(core.releaseDispatch(requested.value!.dispatchId, worker).ok).toBe(true);
    expectAction({ moduleId: "MOD-0030" }, gaspar, ["assign-review"]);
    expect(core.assignReview({ kind: "verification", moduleId: "MOD-0030" }, gaspar).ok).toBe(true);
    const verifying = core.requestDispatch(
      { moduleId: "MOD-0030", kind: "verification", rationale: "verify the package-less flow", adapterId: "fixture" },
      gaspar
    );
    expect(verifying.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent: "spekkio", parentRuntimeSession: "opencode-parent-2" }, gaspar).ok).toBe(true);
    const vclaimed = core.claimDispatch({ dispatchId: verifying.value!.dispatchId, childRuntimeSession: "opencode-child-2" }, gaspar);
    expect(vclaimed.ok).toBe(true);
    expect(core.confirmClaim(verifying.value!.dispatchId, gaspar).ok).toBe(true);
    const spekkio: CallerAuth = {
      actor: "spekkio",
      session: { id: vclaimed.value!.session.id, token: vclaimed.value!.session.token },
    };
    expect(core.recordVerification("MOD-0030", "PASS", "spekkio", [], [], [], spekkio).ok).toBe(true);
    expectAction({ moduleId: "MOD-0030" }, spekkio, ["submit-review"]);
    const submitted = core.nextAction({ moduleId: "MOD-0030" }, spekkio).value!;
    const submitId = submitted.summary.match(/'(REV-[0-9]+)'/)?.[1];
    expect(submitId).toBeTruthy();
    expect(core.completeReview({ reviewId: submitId as string }, spekkio).ok).toBe(true);
    // The implementation binding completed at line 753 and retired
    // its worker session with it: re-release is idempotent through a
    // live overseer session, never through the retired worker.
    expect(core.releaseDispatch(requested.value!.dispatchId, gaspar).ok).toBe(true);
    // CF2-1 transition-layer gate: the terminal advance rides the
    // ACTIVE verification binding, but without the PO security
    // acceptance it denies — no success-then-validate-failure shape.
    expectAction({ moduleId: "MOD-0030" }, gaspar, ["execute-dispatch"]);
    const earlyAdvance = core.advanceScope({ moduleId: "MOD-0030", event: "SpekkioPassed" }, spekkio);
    expect(earlyAdvance.ok).toBe(false);
    // The terminal gate names the missing acceptance inside the
    // advance envelope: same shared precondition, no divergence.
    expect(earlyAdvance.error?.code).toBe("COMPLETION_DENIED");
    expect(earlyAdvance.error?.message).toContain("Implementation Security Acceptance");
    // The PO ceremony is recorded; the same advance now succeeds.
    approve("implementation-security", "MOD-0030", core.getArtifact("MOD-0030").revision);
    expect(core.advanceScope({ moduleId: "MOD-0030", event: "SpekkioPassed" }, spekkio).ok).toBe(true);
    expect(core.getArtifact("MOD-0030").status).toBe("PASSED");
    // The verification binding settles before completion — the same
    // release-then-complete precedence the package path enforces.
    expect(core.releaseDispatch(verifying.value!.dispatchId, spekkio).ok).toBe(true);
    expectAction({ moduleId: "MOD-0030" }, gaspar, ["complete-module"]);
    expect(core.completeModule("MOD-0030", gaspar).ok).toBe(true);
    expect(core.getArtifact("MOD-0030").status).toBe("COMPLETE");
    expectAction({ moduleId: "MOD-0030" }, gaspar, ["done"]);
    expectDeepClean();
  });
});
