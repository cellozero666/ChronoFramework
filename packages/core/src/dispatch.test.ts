/**
 * Native governed dispatch — Core phase 1 (request) and phase 2 (claim).
 *
 * requestDispatch validates every dispatch gate without an executor
 * session and returns a revision snapshot; claimDispatch mints the
 * delegated worker session from the Gaspar/PO parent and runs full
 * authorizeExecution. No executor impersonation, no grant without
 * gates, no worker role outside the assignable set.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
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

describe("Native dispatch (Core request/claim)", () => {
  let tempDir: string;
  let core: ChronoCore;
  let signingKey = "";
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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-dispatch-test-"));
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
    // Architecture approved with security approval.
    const proposed = core.proposeArchitecture({ title: "A" }, gaspar);
    expect(proposed.ok).toBe(true);
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    approve("architecture-security", "ARCH", proposed.value!);
    expect(core.approveArchitecture(gaspar).ok).toBe(true);
    // Spec READY with a fresh Harness.
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar).ok).toBe(true);
    const specRev = core.getArtifact("SP-0001").revision;
    approve("architecture-security", "SP-0001", specRev);
    expect(core.recordHarness(specRev, `sha256:${"a".repeat(64)}`, "# h", gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecApprovedReady", gaspar).ok).toBe(true);
    // Module + Work Package approved.
    expect(core.registerModule("MOD-0002", "DRAFT", MOD, gaspar).ok).toBe(true);
    expect(
      core.registerWorkPackage("WP-0001", "PLANNED", { id: "WP-0001", name: "W", module: "MOD-0002", dependsOn: [] }, gaspar).ok
    ).toBe(true);
    expect(core.transitionState("MOD-0002", "ModulePlanned", gaspar).ok).toBe(true);
    modRev = core.getArtifact("MOD-0002").revision;
    approve("module-approval", "MOD-0002", modRev);
    expect(core.transitionState("MOD-0002", "ModuleApproved", gaspar).ok).toBe(true);
    expect(core.transitionState("WP-0001", "WorkPackageAuthorized", gaspar).ok).toBe(true);
    // RTK + skill currency with intact emitted files.
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
    expect(hashSkillSource(FIXTURE_SKILL_MD)).toBe(SKILL_RELEASE.sourceHash);
    const vendorTarget = join(tempDir, skillVendorPath(SKILL_RELEASE.pinnedCommit));
    mkdirSync(dirname(vendorTarget), { recursive: true });
    writeFileSync(vendorTarget, FIXTURE_SKILL_MD, "utf8");
    for (const runtime of ["claude", "opencode", "kiro"] as const) {
      const target = join(tempDir, SKILL_RUNTIME_PATHS[runtime]);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, FIXTURE_SKILL_MD, "utf8");
    }
    // Adapter + authoritative routing proof with intact managed assets.
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

  it("request validates every gate and returns a revision snapshot without mutating lifecycle", () => {
    const res = core.requestDispatch(
      { moduleId: "MOD-0002", workPackageId: "WP-0001", rationale: "start implementation now", adapterId: "fixture" },
      gaspar
    );
    expect(res.ok).toBe(true);
    expect(res.value!).toMatchObject({
      moduleId: "MOD-0002", moduleRevision: modRev, workPackageId: "WP-0001",
    });
    expect(res.value!.workPackageRevision).toMatch(/^sha256:/);
    expect(res.value!.specRevisions["SP-0001"]).toMatch(/^sha256:/);
    expect(res.value!.dispatchableRoles).toEqual(["belthazar", "melchior", "prometheus"]);
    // Read-only except audit: lifecycle untouched, no grant, no session.
    expect(core.getArtifact("MOD-0002").status).toBe("APPROVED");
    expect(core.getArtifact("WP-0001").status).toBe("AUTHORIZED");
  });

  it("claim mints a delegated worker session and issues the bound grant", () => {
    const requested = core.requestDispatch(
      { moduleId: "MOD-0002", workPackageId: "WP-0001", rationale: "start implementation now", adapterId: "fixture" },
      gaspar
    );
    expect(requested.ok).toBe(true);
    const delegated = core.recordTaskDelegation(
      { agent: "belthazar", parentRuntimeSession: "opencode-parent-1" },
      gaspar
    );
    expect(delegated.ok).toBe(true);
    expect(delegated.value!.dispatchId).toBe(requested.value!.dispatchId);
    const claimed = core.claimDispatch(
      { dispatchId: requested.value!.dispatchId, childRuntimeSession: "opencode-child-1" },
      gaspar
    );
    expect(claimed.ok).toBe(true);
    const v = claimed.value!;
    expect(v.role).toBe("belthazar");
    expect(v.grantId).toMatch(/^GRANT-[0-9]{4}$/);
    expect(v.session.id).toMatch(/^SES-[0-9]+$/);
    expect(v.session.token.length).toBeGreaterThan(10);
    expect(v.moduleRevision).toBe(modRev);
    // The grant authorizes the worker session for exactly this scope
    // (orchestrated: gaspar requests, the worker executes).
    const gate = core.authorizeExecution("MOD-0002", {
      workPackageId: "WP-0001", actor: "gaspar", role: "belthazar",
      session: { id: v.session.id, token: v.session.token },
      requesterSession: gaspar.session, adapterId: "fixture",
    });
    expect(gate.ok).toBe(true);
  });

  it("workers cannot request dispatch; forged parents cannot claim", () => {
    const workerSession = core.openSession(
      { role: "belthazar", adapter: "test-adapter", runtime: "test-runtime", scopeModule: "MOD-0002", ttlSeconds: 3600 },
      { interactive: true }
    );
    expect(workerSession.ok).toBe(true);
    const worker: CallerAuth = { actor: "belthazar", session: { id: workerSession.value!.id, token: workerSession.value!.token } };
    expect(
      core.requestDispatch({ moduleId: "MOD-0002", workPackageId: "WP-0001", rationale: "x", adapterId: "fixture" }, worker).error?.code
    ).toBe("EXECUTION_DENIED");
    const requested = core.requestDispatch(
      { moduleId: "MOD-0002", workPackageId: "WP-0001", rationale: "x", adapterId: "fixture" },
      gaspar
    );
    expect(requested.ok).toBe(true);
    expect(
      core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: "opencode-child-9" }, worker).error?.code
    ).toBe("EXECUTION_DENIED");
    // Forged parent credential denies.
    expect(
      core.claimDispatch(
        { dispatchId: requested.value!.dispatchId, childRuntimeSession: "opencode-child-9" },
        { actor: "gaspar", session: { id: gaspar.session.id, token: "forged-token" } }
      ).error?.code
    ).toBe("REFERENCE_UNRESOLVABLE");
  });

  it("non-delegable roles cannot be delegated", () => {
    const requested = core.requestDispatch(
      { moduleId: "MOD-0002", workPackageId: "WP-0001", rationale: "x", adapterId: "fixture" },
      gaspar
    );
    expect(requested.ok).toBe(true);
    for (const role of ["gaspar", "glenn", "spekkio", "PO"]) {
      const denied = core.recordTaskDelegation({ agent: role, parentRuntimeSession: "opencode-parent-1" }, gaspar);
      expect(denied.ok).toBe(false);
      expect(denied.error?.code).toBe("TASK_DENIED");
    }
  });

  it("stale approval denies the request with the exact prerequisite", () => {
    // Simulate a material change after the module approval: an
    // ArtifactRevised event newer than the approval timestamp trips
    // the post-approval-change guard (the raw insert stands in for
    // exactly the governed content change the guard watches for).
    const raw = new Database(join(tempDir, ".chrono", "chrono.db"));
    try {
      raw
        .prepare(
          "INSERT INTO event_log (event_type, entity_id, payload, actor, timestamp, prior_state, new_state, reasoning) VALUES ('ArtifactRevised', 'SP-0001', '{}', 'gaspar', ?, 'READY', 'READY', 'material change')"
        )
        .run(new Date(Date.now() + 60_000).toISOString());
    } finally {
      raw.close();
    }
    const denied = core.requestDispatch({ moduleId: "MOD-0002", workPackageId: "WP-0001", rationale: "stale module", adapterId: "fixture" }, gaspar);
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("APPROVAL_REQUIRED");
    expect(denied.error?.message).toMatch(/changed materially after approval/);
  });

  it("missing or stale Harness denies with the exact prerequisite", () => {
    expect(core.registerSpec("SP-0002", "DRAFT", { ...SPEC, id: "SP-0002" }, gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0002", "SpecSubmittedForReview", gaspar).ok).toBe(true);
    const specRev = core.getArtifact("SP-0002").revision;
    approve("architecture-security", "SP-0002", specRev);
    expect(core.recordHarness(specRev, `sha256:${"b".repeat(64)}`, "# h2", gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0002", "SpecApprovedReady", gaspar).ok).toBe(true);
    expect(
      core.registerModule("MOD-0004", "DRAFT", { id: "MOD-0004", name: "M4", purpose: "P", specs: ["SP-0001", "SP-0002"] }, gaspar).ok
    ).toBe(true);
    expect(core.transitionState("MOD-0004", "ModulePlanned", gaspar).ok).toBe(true);
    approve("module-approval", "MOD-0004", core.getArtifact("MOD-0004").revision);
    expect(core.transitionState("MOD-0004", "ModuleApproved", gaspar).ok).toBe(true);
    // Harness row lost (data loss/corruption scenario): the READY
    // transition already passed, so only the dispatch gate catches it.
    const raw = new Database(join(tempDir, ".chrono", "chrono.db"));
    try {
      raw.prepare("DELETE FROM harness WHERE spec_revision = ?").run(specRev);
    } finally {
      raw.close();
    }
    const missing = core.requestDispatch({ moduleId: "MOD-0004", rationale: "missing harness", adapterId: "fixture" }, gaspar);
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("MISSING_REQUIRED_ARTIFACT");
    // Stale harness after a material change denies just as exactly.
    expect(core.recordHarness(specRev, `sha256:${"c".repeat(64)}`, "# h2-new", gaspar).ok).toBe(true);
    const raw2 = new Database(join(tempDir, ".chrono", "chrono.db"));
    try {
      raw2.prepare("UPDATE harness SET stale = 1 WHERE spec_revision = ?").run(specRev);
    } finally {
      raw2.close();
    }
    const stale = core.requestDispatch({ moduleId: "MOD-0004", rationale: "stale harness", adapterId: "fixture" }, gaspar);
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe("STALE_REVISION");
  });

  it("wrong module and wrong WP deny as unresolvable", () => {
    expect(core.requestDispatch({ moduleId: "MOD-9999", rationale: "ghost" }, gaspar).error?.code).toBe("ENTITY_NOT_FOUND");
    expect(core.requestDispatch({ moduleId: "MOD-0002", workPackageId: "WP-9999", rationale: "ghost", adapterId: "fixture" }, gaspar).error?.code).toBe(
      "REFERENCE_UNRESOLVABLE"
    );
  });

  it("rationale bounds deny empty and oversized text", () => {
    expect(core.requestDispatch({ moduleId: "MOD-0002", workPackageId: "WP-0001", rationale: "   " }, gaspar).error?.code).toBe(
      "VALIDATION_ERROR"
    );
    expect(core.requestDispatch({ moduleId: "MOD-0002", workPackageId: "WP-0001", rationale: "x".repeat(501) }, gaspar).error?.code).toBe(
      "VALIDATION_ERROR"
    );
  });

  it("claim re-validates: a blocker raised between request and claim denies", () => {
    const requested = core.requestDispatch({ moduleId: "MOD-0002", workPackageId: "WP-0001", rationale: "race", adapterId: "fixture" }, gaspar);
    expect(requested.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent: "belthazar", parentRuntimeSession: "opencode-parent-1" }, gaspar).ok).toBe(true);
    const blocked = core.raiseBlocker("PRODUCT_BLOCKER", ["MOD-0002"], "stop work", gaspar);
    expect(blocked.ok).toBe(true);
    const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: "opencode-child-1" }, gaspar);
    expect(claimed.ok).toBe(false);
    expect(claimed.error?.code).toBe("EXECUTION_DENIED");
  });
});
