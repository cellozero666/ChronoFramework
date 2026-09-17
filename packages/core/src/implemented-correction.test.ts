/**
 * IMPLEMENTED correction re-entry (CHRONOTEST2 pilot finding).
 *
 * A Work Package that reaches IMPLEMENTED and then loses its worker
 * binding (dead session, released dispatch) used to be unreachable:
 * impl/test dispatch requires AUTHORIZED/RUNNING, no verdict can
 * exist before VERIFYING, and CorrectionComplete had no IMPLEMENTED
 * source row — so defect → loop → correction had nowhere to land.
 * Orphaned ACTIVE dispatches additionally survived every reconcile
 * sweep, shadowing the scope.
 *
 * Covered here through public Core operations only:
 *
 * - the defect taxonomy names its valid values on rejection;
 * - defect → open loop → request-correction guidance → correction
 *   dispatch → claim re-enters RUNNING from IMPLEMENTED → fix
 *   evidence → loop completion → ImplementationDone →
 *   VerificationReady reaches VERIFYING;
 * - reconcile revokes ACTIVE bindings whose worker session died
 *   (revoked, expired, or past dispatch TTL) and preserves live ones.
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
const MOD = "MOD-0002";
const WP = "WP-0001";

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

describe("IMPLEMENTED correction re-entry", () => {
  let tempDir: string;
  let core: ChronoCore;
  let signingKey = "";
  // Structural (not CallerAuth-annotated): transitionState takes an
  // open guard-context record, which rejects the annotated interface.
  let gaspar: { actor: string; session: { id: string; token: string } };
  let clockRef = { now: new Date().toISOString() };
  let restoreTty: () => void;
  let seq = 0;

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

  function bindWorker(role: string, kind: string, moduleId: string, workPackageId?: string, defectId?: string): { auth: CallerAuth; dispatchId: string } {
    seq += 1;
    const requested = core.requestDispatch(
      {
        moduleId, ...(workPackageId !== undefined ? { workPackageId } : {}), kind,
        ...(defectId !== undefined ? { defectId } : {}),
        rationale: `implemented-correction binding for ${role}`, adapterId: "fixture",
      },
      gaspar
    );
    expect(requested.ok, JSON.stringify(requested.ok ? null : requested.error)).toBe(true);
    expect(core.recordTaskDelegation({ agent: role, parentRuntimeSession: `implcorr-parent-${seq}` }, gaspar).ok).toBe(true);
    const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: `implcorr-child-${seq}` }, gaspar);
    expect(claimed.ok, JSON.stringify(claimed.ok ? null : claimed.error)).toBe(true);
    expect(core.confirmClaim(requested.value!.dispatchId, gaspar).ok).toBe(true);
    return {
      auth: { actor: role, session: { id: claimed.value!.session.id, token: claimed.value!.session.token } },
      dispatchId: requested.value!.dispatchId,
    };
  }

  /** Full stack through an AUTHORIZED package: module approved, WP authorized. */
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
    const po: CallerAuth = { actor: "PO", session: openPrivileged("PO", signingKey) };
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
    const modRev = core.getArtifact(MOD).revision;
    approve("planning-approval", MOD, modRev);
    approve("module-approval", MOD, modRev);
    expect(core.activateModule(MOD, gaspar).ok).toBe(true);
    expect(core.transitionState(WP, "WorkPackageAuthorized", gaspar).ok).toBe(true);
  }

  /** Drive the package to VERIFYING, then stand the worker down. */
  function driveVerifying(): { auth: CallerAuth; dispatchId: string } {
    const impl = bindWorker("belthazar", "implementation", MOD, WP);
    const rev = core.getArtifact(WP).revision;
    recordEvidenceAs(impl.auth, rev, "unit-impl");
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, impl.auth).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, impl.auth).ok).toBe(true);
    expect(core.getArtifact(WP).status).toBe("VERIFYING");
    expect(core.releaseDispatch(impl.dispatchId, impl.auth).ok).toBe(true);
    return impl;
  }

  /** Drive the package to IMPLEMENTED, then stand the worker down. */
  function driveImplemented(): { auth: CallerAuth; dispatchId: string } {
    const impl = bindWorker("belthazar", "implementation", MOD, WP);
    const rev = core.getArtifact(WP).revision;
    recordEvidenceAs(impl.auth, rev, "unit-impl");
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, impl.auth).ok).toBe(true);
    expect(core.getArtifact(WP).status).toBe("IMPLEMENTED");
    expect(core.releaseDispatch(impl.dispatchId, impl.auth).ok).toBe(true);
    return impl;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-implcorr-test-"));
    clockRef = { now: new Date().toISOString() };
    core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime", clock: () => clockRef.now });
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
    seq = 0;
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("publishes the defect taxonomy on rejection", () => {
    buildStack();
    const spekkio: CallerAuth = {
      actor: "spekkio",
      session: (() => {
        const res = core.openSession(
          { role: "spekkio", adapter: "fixture", runtime: "test-runtime", scopeModule: MOD, ttlSeconds: 3600 },
          { interactive: true }
        );
        expect(res.ok).toBe(true);
        return { id: res.value!.id, token: res.value!.token };
      })(),
    };
    const denied = core.recordDefect(
      {
        classification: "bug",
        severity: "major",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: [WP],
        blockingScope: WP,
        reproInfo: null,
      },
      spekkio
    );
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("VALIDATION_ERROR");
    // The valid values travel in the message itself — the surface
    // Spekkio and Gaspar actually read — not only in metadata.
    for (const value of [
      "IMPLEMENTATION_DEFECT", "UX_DEFECT", "INFRASTRUCTURE_DEFECT", "TEST_DEFECT",
      "SECURITY_DEFECT", "ARCHITECTURE_DEFECT", "SPECIFICATION_DEFECT", "PRODUCT_AMBIGUITY",
    ] as const) {
      expect(denied.error?.message).toContain(value);
    }
  });

  it("re-enters RUNNING from IMPLEMENTED through a correction claim", () => {
    buildStack();
    driveImplemented();
    // Spekkio records the blocking defect with a valid classification.
    const spek = bindWorker("spekkio", "verification", MOD, WP);
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
      spek.auth
    );
    expect(defect.ok).toBe(true);
    expect(core.releaseDispatch(spek.dispatchId, gaspar).ok).toBe(true);
    // Gaspar opens the loop, and the engine routes the open loop to
    // request-correction — the documented fix path, not a guess.
    const looped = core.openCorrectionLoop(defect.value!.id, gaspar);
    expect(looped.ok).toBe(true);
    const guided = core.nextAction({ workPackageId: WP }, gaspar);
    expect(guided.ok).toBe(true);
    expect(guided.value!.action).toBe("request-correction");
    // Correction dispatch on IMPLEMENTED work: the claim itself moves
    // IMPLEMENTED → RUNNING (CorrectionComplete) and binds the loop.
    const fix = bindWorker("belthazar", "correction", MOD, WP);
    expect(core.getArtifact(WP).status).toBe("RUNNING");
    // Fix evidence, loop completion, and the normal forward walk to
    // VERIFYING — the package rejoins the verified lifecycle.
    recordEvidenceAs(fix.auth, core.getArtifact(WP).revision, "fix");
    const opened = core.listEvents().filter(
      (e) => e.eventType === "CorrectionOpened" && (JSON.parse(e.payload) as { defectId?: string }).defectId === defect.value!.id
    );
    expect(opened.length).toBeGreaterThan(0);
    expect(core.completeCorrectionLoop(opened[opened.length - 1]!.entityId, fix.auth).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, fix.auth).ok).toBe(true);
    expect(core.getArtifact(WP).status).toBe("IMPLEMENTED");
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, fix.auth).ok).toBe(true);
    expect(core.getArtifact(WP).status).toBe("VERIFYING");
    expect(core.releaseDispatch(fix.dispatchId, fix.auth).ok).toBe(true);
  });

  it("re-enters RUNNING from VERIFYING through a correction claim", () => {
    buildStack();
    driveVerifying();
    // Glenn's security finding reaches Spekkio, who records the defect;
    // Gaspar opens the loop; the engine routes request-correction.
    const spek = bindWorker("spekkio", "verification", MOD, WP);
    const defect = core.recordDefect(
      {
        classification: "SECURITY_DEFECT",
        severity: "major",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: [WP],
        blockingScope: WP,
        reproInfo: null,
      },
      spek.auth
    );
    expect(defect.ok).toBe(true);
    expect(core.releaseDispatch(spek.dispatchId, gaspar).ok).toBe(true);
    expect(core.openCorrectionLoop(defect.value!.id, gaspar).ok).toBe(true);
    const guided = core.nextAction({ workPackageId: WP }, gaspar);
    expect(guided.ok).toBe(true);
    expect(guided.value!.action).toBe("request-correction");
    // The correction claim itself moves VERIFYING → RUNNING; the fix
    // then walks the normal forward path. No verdict is faked to get
    // editable state back.
    const fix = bindWorker("glenn", "correction", MOD, WP);
    expect(core.getArtifact(WP).status).toBe("RUNNING");
    recordEvidenceAs(fix.auth, core.getArtifact(WP).revision, "security-fix");
    const opened = core.listEvents().filter(
      (e) => e.eventType === "CorrectionOpened" && (JSON.parse(e.payload) as { defectId?: string }).defectId === defect.value!.id
    );
    expect(opened.length).toBeGreaterThan(0);
    expect(core.completeCorrectionLoop(opened[opened.length - 1]!.entityId, fix.auth).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, fix.auth).ok).toBe(true);
    expect(core.getArtifact(WP).status).toBe("IMPLEMENTED");
    expect(core.releaseDispatch(fix.dispatchId, fix.auth).ok).toBe(true);
  });

  it("selects one open loop by defect when several are open", () => {
    buildStack();
    driveImplemented();
    const spek = bindWorker("spekkio", "verification", MOD, WP);
    const first = core.recordDefect(
      {
        classification: "IMPLEMENTATION_DEFECT",
        severity: "low",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: [WP],
        blockingScope: WP,
        reproInfo: null,
      },
      spek.auth
    );
    expect(first.ok).toBe(true);
    const second = core.recordDefect(
      {
        classification: "TEST_DEFECT",
        severity: "low",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: [WP],
        blockingScope: WP,
        reproInfo: null,
      },
      spek.auth
    );
    expect(second.ok).toBe(true);
    expect(core.releaseDispatch(spek.dispatchId, gaspar).ok).toBe(true);
    expect(core.openCorrectionLoop(first.value!.id, gaspar).ok).toBe(true);
    expect(core.openCorrectionLoop(second.value!.id, gaspar).ok).toBe(true);
    // Ambiguous requests name both open defects instead of guessing.
    const denied = core.requestDispatch(
      { moduleId: MOD, workPackageId: WP, kind: "correction", rationale: "fix one of two defects", adapterId: "fixture" },
      gaspar
    );
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("EXECUTION_DENIED");
    expect(denied.error?.message).toContain(first.value!.id);
    expect(denied.error?.message).toContain(second.value!.id);
    // Selecting a defect binds its loop and derives its owner.
    const chosen = bindWorker("belthazar", "correction", MOD, WP, first.value!.id);
    expect(core.getArtifact(WP).status).toBe("RUNNING");
    // Finish that correction so the scope settles back to IMPLEMENTED.
    recordEvidenceAs(chosen.auth, core.getArtifact(WP).revision, "fix-first");
    const firstLoops = core.listEvents().filter(
      (e) => e.eventType === "CorrectionOpened" && (JSON.parse(e.payload) as { defectId?: string }).defectId === first.value!.id
    );
    expect(firstLoops.length).toBeGreaterThan(0);
    expect(core.completeCorrectionLoop(firstLoops[firstLoops.length - 1]!.entityId, chosen.auth).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, chosen.auth).ok).toBe(true);
    expect(core.getArtifact(WP).status).toBe("IMPLEMENTED");
    expect(core.releaseDispatch(chosen.dispatchId, chosen.auth).ok).toBe(true);
    // A defect whose loop covers another scope denies. A module-scoped
    // reviewer session covers any package of the module.
    expect(core.registerWorkPackage("WP-0002", "PLANNED", { id: "WP-0002", name: "W2", module: MOD, dependsOn: [] }, gaspar).ok).toBe(true);
    const modSpekkioSession = core.openSession(
      { role: "spekkio", adapter: "fixture", runtime: "test-runtime", scopeModule: MOD, ttlSeconds: 3600 },
      { interactive: true }
    );
    expect(modSpekkioSession.ok).toBe(true);
    const modSpekkio: CallerAuth = { actor: "spekkio", session: { id: modSpekkioSession.value!.id, token: modSpekkioSession.value!.token } };
    const elsewhere = core.recordDefect(
      {
        classification: "IMPLEMENTATION_DEFECT",
        severity: "low",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: ["WP-0002"],
        blockingScope: "WP-0002",
        reproInfo: null,
      },
      modSpekkio
    );
    expect(elsewhere.ok).toBe(true);
    // A defect with no open loop denies (recorded now; its loop is
    // never opened).
    const lonely = core.recordDefect(
      {
        classification: "TEST_DEFECT",
        severity: "low",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: [WP],
        blockingScope: WP,
        reproInfo: null,
      },
      modSpekkio
    );
    expect(lonely.ok).toBe(true);
    expect(core.openCorrectionLoop(elsewhere.value!.id, gaspar).ok).toBe(true);
    const crossed = core.requestDispatch(
      { moduleId: MOD, workPackageId: WP, kind: "correction", defectId: elsewhere.value!.id, rationale: "cross-scope", adapterId: "fixture" },
      gaspar
    );
    expect(crossed.ok).toBe(false);
    expect(crossed.error?.code).toBe("EXECUTION_DENIED");
    const unopened = core.requestDispatch(
      { moduleId: MOD, workPackageId: WP, kind: "correction", defectId: lonely.value!.id, rationale: "no loop", adapterId: "fixture" },
      gaspar
    );
    expect(unopened.ok).toBe(false);
    expect(unopened.error?.code).toBe("EXECUTION_DENIED");
  });

  it("reconcile revokes orphaned ACTIVE bindings and preserves live ones", () => {
    buildStack();
    // IMPLEMENTED with the worker stood down, then a defect, a loop,
    // and two live bindings side by side.
    driveImplemented();
    const spek = bindWorker("spekkio", "verification", MOD, WP);
    const defect = core.recordDefect(
      {
        classification: "TEST_DEFECT",
        severity: "minor",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: [WP],
        blockingScope: WP,
        reproInfo: null,
      },
      spek.auth
    );
    expect(defect.ok).toBe(true);
    expect(core.releaseDispatch(spek.dispatchId, gaspar).ok).toBe(true);
    expect(core.openCorrectionLoop(defect.value!.id, gaspar).ok).toBe(true);
    const good = bindWorker("belthazar", "correction", MOD, WP);
    const dead = bindWorker("lucca", "test", MOD, WP);
    const po: CallerAuth = { actor: "PO", session: openPrivileged("PO", signingKey) };
    expect(core.revokeSession(dead.auth.session.id, po).ok).toBe(true);
    const swept = core.reconcileStaleClaims(gaspar);
    expect(swept.ok).toBe(true);
    expect(swept.value!.revoked).toContain(dead.dispatchId);
    expect(swept.value!.revoked).not.toContain(good.dispatchId);
    expect(swept.value!.expired).toEqual([]);
    // The dead binding denies; the live one still evidences.
    expect(core.recordEvidence({
      producer: "lucca",
      tool: "vitest",
      targetRevision: core.getArtifact(WP).revision,
      checkName: "unit",
      result: "pass",
      diagnostics: null,
      integrityHash: computeRevisionHash({ result: "pass", diagnostics: null, target_revision: core.getArtifact(WP).revision }),
    }, dead.auth).ok).toBe(false);
    recordEvidenceAs(good.auth, core.getArtifact(WP).revision, "fix");
    const audit = core.listEvents().filter((e) => e.eventType === "DispatchRevoked" && e.entityId === dead.dispatchId);
    expect(audit.length).toBe(1);
    expect(JSON.parse(audit[0]!.payload).reason).toContain("worker session revoked");
  });

  it("reconcile revokes ACTIVE bindings past TTL while sessions live", () => {
    buildStack();
    driveImplemented();
    const spek = bindWorker("spekkio", "verification", MOD, WP);
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
      spek.auth
    );
    expect(defect.ok).toBe(true);
    expect(core.releaseDispatch(spek.dispatchId, gaspar).ok).toBe(true);
    expect(core.openCorrectionLoop(defect.value!.id, gaspar).ok).toBe(true);
    const fix = bindWorker("belthazar", "correction", MOD, WP);
    // Two hours later: dispatch TTL (1h) and worker session TTL (1h)
    // both elapsed, while attestations (24h) stay current. The caller
    // session died too, so reconcile runs under a fresh Gaspar session.
    clockRef.now = new Date(Date.parse(clockRef.now) + 2 * 3600 * 1000).toISOString();
    gaspar = { actor: "gaspar", session: openPrivileged("gaspar", signingKey) };
    const swept = core.reconcileStaleClaims(gaspar);
    expect(swept.ok).toBe(true);
    expect(swept.value!.revoked).toContain(fix.dispatchId);
    const audit = core.listEvents().filter((e) => e.eventType === "DispatchRevoked" && e.entityId === fix.dispatchId);
    expect(audit.length).toBe(1);
    expect(JSON.parse(audit[0]!.payload).reason).toContain("expired");
    // The scope accepts fresh work: the swept claim had already moved
    // the package IMPLEMENTED → RUNNING, so an implementation dispatch
    // picks it up and re-implements (the open loop still owns the fix).
    const retry = bindWorker("belthazar", "implementation", MOD, WP);
    recordEvidenceAs(retry.auth, core.getArtifact(WP).revision, "rework");
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, retry.auth).ok).toBe(true);
    expect(core.getArtifact(WP).status).toBe("IMPLEMENTED");
  });

  it("rebinds CORRECTING after its dispatch is revoked (binding-defect repair)", () => {
    buildStack();
    driveImplemented();
    const spek = bindWorker("spekkio", "verification", MOD, WP);
    const defect = core.recordDefect(
      {
        classification: "SECURITY_DEFECT",
        severity: "major",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: [WP],
        blockingScope: WP,
        reproInfo: null,
      },
      spek.auth
    );
    expect(defect.ok).toBe(true);
    expect(core.releaseDispatch(spek.dispatchId, gaspar).ok).toBe(true);
    expect(core.openCorrectionLoop(defect.value!.id, gaspar).ok).toBe(true);
    // First correction binds the loop (OPEN -> CORRECTING, IMPLEMENTED
    // -> RUNNING), then the claim is revoked: the loop stays CORRECTING
    // with no live dispatch — the exact COR-0005 shape.
    const first = bindWorker("glenn", "correction", MOD, WP, defect.value!.id);
    expect(core.getArtifact(WP).status).toBe("RUNNING");
    expect(core.revokeDispatch(first.dispatchId, gaspar, "abandoned claim").ok).toBe(true);
    // Revocation leaves positioned RUNNING work: rework it to IMPLEMENTED
    // through a plain implementation binding first.
    const rework = bindWorker("belthazar", "implementation", MOD, WP);
    recordEvidenceAs(rework.auth, core.getArtifact(WP).revision, "rework");
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, rework.auth).ok).toBe(true);
    expect(core.getArtifact(WP).status).toBe("IMPLEMENTED");
    expect(core.releaseDispatch(rework.dispatchId, rework.auth).ok).toBe(true);
    // A fresh correction dispatch rebinds the same CORRECTING loop
    // (CORRECTING -> CORRECTING): previously aborted with the lifecycle
    // trigger error.
    const second = bindWorker("glenn", "correction", MOD, WP, defect.value!.id);
    recordEvidenceAs(second.auth, core.getArtifact(WP).revision, "security-fix-retry");
    const opened = core.listEvents().filter(
      (e) => e.eventType === "CorrectionOpened" && (JSON.parse(e.payload) as { defectId?: string }).defectId === defect.value!.id
    );
    expect(opened.length).toBeGreaterThan(0);
    expect(core.completeCorrectionLoop(opened[opened.length - 1]!.entityId, second.auth).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, second.auth).ok).toBe(true);
    expect(core.getArtifact(WP).status).toBe("IMPLEMENTED");
    expect(core.releaseDispatch(second.dispatchId, second.auth).ok).toBe(true);
  });

  it("lets the dispatched executor complete another owner's loop (Glenn guides, Belthazar executes)", () => {
    buildStack();
    driveImplemented();
    const spek = bindWorker("spekkio", "verification", MOD, WP);
    const defect = core.recordDefect(
      {
        classification: "SECURITY_DEFECT",
        severity: "major",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: [WP],
        blockingScope: WP,
        reproInfo: null,
      },
      spek.auth
    );
    expect(defect.ok).toBe(true);
    expect(core.releaseDispatch(spek.dispatchId, gaspar).ok).toBe(true);
    const looped = core.openCorrectionLoop(defect.value!.id, gaspar);
    expect(looped.ok).toBe(true);
    expect(looped.value!.owner).toBe("glenn");
    // Gaspar delegates the glenn-owned loop to belthazar: the claim
    // binds Belthazar as executor, Belthazar evidences, and Belthazar
    // completes — previously denied as non-owner.
    const fix = bindWorker("belthazar", "correction", MOD, WP, defect.value!.id);
    expect(core.getArtifact(WP).status).toBe("RUNNING");
    recordEvidenceAs(fix.auth, core.getArtifact(WP).revision, "guided-fix");
    const opened = core.listEvents().filter(
      (e) => e.eventType === "CorrectionOpened" && (JSON.parse(e.payload) as { defectId?: string }).defectId === defect.value!.id
    );
    const completed = core.completeCorrectionLoop(opened[opened.length - 1]!.entityId, fix.auth);
    expect(completed.ok, JSON.stringify(completed.ok ? null : completed.error)).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, fix.auth).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, fix.auth).ok).toBe(true);
    expect(core.getArtifact(WP).status).toBe("VERIFYING");
    expect(core.releaseDispatch(fix.dispatchId, fix.auth).ok).toBe(true);
  });

  it("denies executor completion without a live correction binding", () => {
    buildStack();
    driveImplemented();
    const spek = bindWorker("spekkio", "verification", MOD, WP);
    const defect = core.recordDefect(
      {
        classification: "SECURITY_DEFECT",
        severity: "major",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: [WP],
        blockingScope: WP,
        reproInfo: null,
      },
      spek.auth
    );
    expect(defect.ok).toBe(true);
    expect(core.releaseDispatch(spek.dispatchId, gaspar).ok).toBe(true);
    expect(core.openCorrectionLoop(defect.value!.id, gaspar).ok).toBe(true);
    // Belthazar holds an implementation binding on RUNNING work here is
    // impossible (IMPLEMENTED denies it); instead prove the negative with
    // a verification binding: spekkio cannot complete glenn's loop.
    const verifier = bindWorker("spekkio", "verification", MOD, WP);
    const opened = core.listEvents().filter(
      (e) => e.eventType === "CorrectionOpened" && (JSON.parse(e.payload) as { defectId?: string }).defectId === defect.value!.id
    );
    const denied = core.completeCorrectionLoop(opened[opened.length - 1]!.entityId, verifier.auth);
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("EXECUTION_DENIED");
    expect(core.releaseDispatch(verifier.dispatchId, gaspar).ok).toBe(true);
  });

  it("re-advances IMPLEMENTED with REVERIFY loops to VERIFYING for the formal verdict", () => {
    buildStack();
    driveImplemented();
    const spek = bindWorker("spekkio", "verification", MOD, WP);
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
      spek.auth
    );
    expect(defect.ok).toBe(true);
    expect(core.releaseDispatch(spek.dispatchId, gaspar).ok).toBe(true);
    expect(core.openCorrectionLoop(defect.value!.id, gaspar).ok).toBe(true);
    // Fix through the normal path, then stand the worker down while
    // IMPLEMENTED with the loop in REVERIFY — the WP-0002 shape: fully
    // evidenced, technically fixed, but no binding left to advance.
    const fix = bindWorker("belthazar", "correction", MOD, WP);
    recordEvidenceAs(fix.auth, core.getArtifact(WP).revision, "fix");
    const opened = core.listEvents().filter(
      (e) => e.eventType === "CorrectionOpened" && (JSON.parse(e.payload) as { defectId?: string }).defectId === defect.value!.id
    );
    expect(core.completeCorrectionLoop(opened[opened.length - 1]!.entityId, fix.auth).ok).toBe(true);
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "ImplementationDone" }, fix.auth).ok).toBe(true);
    expect(core.getArtifact(WP).status).toBe("IMPLEMENTED");
    expect(core.releaseDispatch(fix.dispatchId, fix.auth).ok).toBe(true);
    // A fresh implementation dispatch binds only (no state change at
    // claim on positioned work), evidences, and advances IMPLEMENTED
    // -> VERIFYING — previously denied as requiring AUTHORIZED/RUNNING.
    const reAdvance = bindWorker("belthazar", "implementation", MOD, WP);
    expect(core.getArtifact(WP).status).toBe("IMPLEMENTED");
    recordEvidenceAs(reAdvance.auth, core.getArtifact(WP).revision, "re-advance-proof");
    expect(core.advanceScope({ moduleId: MOD, workPackageId: WP, event: "VerificationReady" }, reAdvance.auth).ok).toBe(true);
    expect(core.getArtifact(WP).status).toBe("VERIFYING");
    expect(core.releaseDispatch(reAdvance.dispatchId, reAdvance.auth).ok).toBe(true);
    // The formal verdict now binds on VERIFYING: Spekkio PASS closes the
    // REVERIFY loop. (Terminal SpekkioPassed -> COMPLETE additionally
    // requires profile evidence, reviews, and security acceptance, which
    // ride their own gates outside this re-advance path.)
    const verify = bindWorker("spekkio", "verification", MOD, WP);
    const verdict = core.recordVerification(MOD, "PASS", "spekkio", [], [], [], verify.auth, WP);
    expect(verdict.ok, JSON.stringify(verdict.ok ? null : verdict.error)).toBe(true);
    const loops = core.listEvents().filter((e) => e.eventType === "CorrectionClosed");
    expect(loops.length).toBeGreaterThan(0);
    expect(core.releaseDispatch(verify.dispatchId, gaspar).ok).toBe(true);
  });
});
