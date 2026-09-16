/**
 * §3A tests — Core-owned agent identity and role authority.
 * Every protected operation requires an authenticated session; capabilities
 * resolve through the session's bound role. Bare role strings, forged
 * sessions, confused actors, and cross-role operations all deny.
 * All seven canonical roles have positive and negative authority tests.
 * [DOM §2.2, RUNTIME §2, Remediation §3A]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { RTK_UPSTREAM, SKILL_RELEASE, SKILL_RUNTIME_PATHS, SKILL_UPSTREAM, buildApprovalPayload, buildEnrollmentChallenge, buildEnrollmentPayload, buildSessionAuthorizationPayload, computeRevisionHash, convertSkillSource, fingerprintPublicKey, generateApprovalKeyPair, managedAssetInventory, signApprovalPayload, skillGeneratedHashes, skillVendorPath } from "@chrono/domain";
import { ChronoCore, type CallerAuth } from "./chrono-core.js";

// Byte-exact canonical SKILL.md at the pinned commit (same bytes as
// every other suite's fixture; hash asserted by attestation setup).
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

const SPEC = { id: "SP-0001", title: "T", purpose: "P" };

type TestSession = { id: string; token: string };

function openTestSession(
  core: ChronoCore,
  role: string,
  scopeModule?: string
): TestSession {
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

function bootstrapPrivilegedSession(
  core: ChronoCore,
  role: "gaspar" | "PO",
  privateKeyPem: string,
  scopeModule?: string
): TestSession {
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
  const res = core.openSession(
    {
      role,
      adapter: "test-adapter",
      runtime: "test-runtime",
      ...(scopeModule !== undefined ? { scopeModule } : {}),
      ttlSeconds: 3600,
    },
    { poAuthorization: { nonce, authority: "PO", rationale, timestamp, signature } }
  );
  expect(res.ok).toBe(true);
  return { id: res.value!.id, token: res.value!.token };
}

function bootstrapAuthority(core: ChronoCore): { privateKeyPem: string; gaspar: CallerAuth } {
  const pair = generateApprovalKeyPair();
  enrollTestPo(core, pair);
  const session = bootstrapPrivilegedSession(core, "gaspar", pair.privateKeyPem);
  return { privateKeyPem: pair.privateKeyPem, gaspar: { actor: "gaspar", session } };
}

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

function evidenceFor(producer: string, targetRevision: string) {
  return {
    producer,
    tool: "vitest",
    targetRevision,
    checkName: "unit",
    result: "pass",
    diagnostics: null,
    integrityHash: computeRevisionHash({
      result: "pass",
      diagnostics: null,
      target_revision: targetRevision,
    }),
  };
}

describe("Authority matrix", () => {
  let tempDir: string;
  let core: ChronoCore;
  let restoreTty: () => void;
  let privateKeyPem: string;
  let gaspar: CallerAuth;

/**
 * TEST-ONLY terminal simulation (session opening is interactive).
 * Never ships; lives only in *.test.ts files.
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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-matrix-test-"));
    // Project runtime selected at init (dispatch paths require a
    // PO-selected runtime; capability tests never assert its absence).
    core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    expect(core.init().ok).toBe(true);
    restoreTty = fakeInteractiveTerminal();
    ({ privateKeyPem, gaspar } = bootstrapAuthority(core));
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

  it("gaspar plans, workers cannot, PO may by supremacy", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", { id: "MOD-0001", name: "M", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
    const belthazar = { actor: "belthazar", session: openTestSession(core, "belthazar", "MOD-0001") };
    expect(core.registerSpec("SP-0002", "DRAFT", { ...SPEC, id: "SP-0002" }, belthazar).error?.code).toBe(
      "EXECUTION_DENIED"
    );
    const lucca = { actor: "lucca", session: openTestSession(core, "lucca", "MOD-0001") };
    expect(core.registerSpec("SP-0003", "DRAFT", { ...SPEC, id: "SP-0003" }, lucca).error?.code).toBe(
      "EXECUTION_DENIED"
    );
    const po = { actor: "PO", session: bootstrapPrivilegedSession(core, "PO", privateKeyPem) };
    expect(core.registerSpec("SP-0005", "DRAFT", { ...SPEC, id: "SP-0005" }, po).ok).toBe(true);
  });

  it("rejects misspelled, generic, and case-variant identities everywhere", () => {
    for (const bad of ["luca", "agent", "LUCCA", "Gaspar", "po", "SYSTEM"]) {
      expect(core.registerSpec("SP-0009", "DRAFT", SPEC, { actor: bad, session: gaspar.session }).ok).toBe(false);
      expect(
        core.transitionState("SP-0009", "SpecSubmittedForReview", { actor: bad, session: gaspar.session }).ok
      ).toBe(false);
    }
    // A bare role string with no session never authorizes.
    expect(
      core.transitionState("SP-0009", "SpecSubmittedForReview", { actor: "gaspar" } as never).ok
    ).toBe(false);
    // Nothing was persisted by any rejected call.
    expect(core.validate().value?.errors ?? []).toHaveLength(0);
  });

  it("each role records its own evidence through a live binding; strangers cannot", () => {
    // Evidence rides ACTIVE dispatch bindings: every producer below
    // holds a real claimed-and-confirmed binding for the scope it
    // proves. Proof outside any binding denies, including gaspar's
    // own session (orchestrators hold no bindings by construction).
    expect(core.registerSpec("SP-0001", "DRAFT", { ...SPEC, inScope: ["a"], acceptanceCriteria: ["ac1"] }, gaspar).ok).toBe(true);
    expect(
      core.registerModule("MOD-0001", "DRAFT", { id: "MOD-0001", name: "M", purpose: "P", specs: ["SP-0001"] }, gaspar).ok
    ).toBe(true);
    const targetRevision = core.getArtifact("SP-0001").revision;
    const approveNow = (action: string, scopeId: string, scopeRev: string): void => {
      const signature = signApprovalPayload(
        buildApprovalPayload({
          action, scopeArtifactId: scopeId, scopeRevision: scopeRev,
          authority: "PO", rationale: "matrix approval", timestamp: "2026-09-14T00:00:00.000Z",
        }),
        privateKeyPem
      );
      const res = core.recordApproval({
        action, scopeArtifactId: scopeId, scopeRevision: scopeRev,
        authority: "PO", rationale: "matrix approval", timestamp: "2026-09-14T00:00:00.000Z", signature,
      });
      expect(res.ok).toBe(true);
    };
    const proposed = core.proposeArchitecture({ title: "A" }, gaspar);
    expect(proposed.ok).toBe(true);
    const archRev = proposed.value!;
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    approveNow("architecture-security", "ARCH", archRev);
    expect(core.approveArchitecture(gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: gaspar.actor, session: gaspar.session }).ok).toBe(true);
    approveNow("architecture-security", "SP-0001", targetRevision);
    expect(core.recordHarness(targetRevision, `sha256:${"a".repeat(64)}`, "# h", gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecApprovedReady", { actor: gaspar.actor, session: gaspar.session }).ok).toBe(true);
    approveNow("planning-approval", "MOD-0001", core.getArtifact("MOD-0001").revision);
    approveNow("module-approval", "MOD-0001", core.getArtifact("MOD-0001").revision);
    expect(core.activateModule("MOD-0001", gaspar).ok).toBe(true);
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
    const po = { actor: "PO", session: bootstrapPrivilegedSession(core, "PO", privateKeyPem) };
    expect(core.registerAdapter({ id: "fixture", name: "Fixture", entrypoint, conformanceProof: ["fixture --version"] }, po).ok).toBe(true);
    const registrationHash = core.adapterRegistrationHash("fixture");
    approveNow("adapter-registration", "fixture", registrationHash);
    const adapterApproval = core.listApprovals().find((a) => a.scopeArtifactId === "fixture");
    expect(adapterApproval).toBeTruthy();
    expect(core.approveAdapter("fixture", adapterApproval!.id, po).ok).toBe(true);
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
    // One bound producer at a time: request, delegate, claim, and
    // confirm a kind-fitting dispatch, record through the binding,
    // then release via oversight before the next role binds.
    let seq = 0;
    const bindRole = (role: string, kind: string): { auth: { actor: string; session: TestSession }; dispatchId: string } => {
      seq += 1;
      const requested = core.requestDispatch(
        { moduleId: "MOD-0001", kind, rationale: "matrix binding", adapterId: "fixture" },
        gaspar
      );
      expect(requested.ok).toBe(true);
      expect(core.recordTaskDelegation({ agent: role, parentRuntimeSession: `opencode-parent-${seq}` }, gaspar).ok).toBe(true);
      const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: `opencode-child-${seq}` }, gaspar);
      expect(claimed.ok).toBe(true);
      expect(core.confirmClaim(requested.value!.dispatchId, gaspar).ok).toBe(true);
      return {
        auth: { actor: role, session: { id: claimed.value!.session.id, token: claimed.value!.session.token } },
        dispatchId: requested.value!.dispatchId,
      };
    };
    const kinds: Record<string, string> = {
      belthazar: "implementation",
      melchior: "implementation",
      prometheus: "implementation",
      lucca: "test",
      glenn: "security-review",
      spekkio: "verification",
    };
    for (const role of ["belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio"]) {
      const bound = bindRole(role, kinds[role] as string);
      expect(core.recordEvidence(evidenceFor(role, targetRevision), bound.auth).ok).toBe(true);
      expect(core.releaseDispatch(bound.dispatchId, gaspar).ok).toBe(true);
    }
    // Gaspar holds no binding by construction: even the orchestrator
    // cannot record proof outside a binding.
    expect(core.recordEvidence(evidenceFor("gaspar", targetRevision), gaspar).ok).toBe(false);
    expect(core.recordEvidence(evidenceFor("mallory", targetRevision), { actor: "mallory", session: gaspar.session }).ok).toBe(false);
    expect(core.recordEvidence(evidenceFor("system", targetRevision), { actor: "system", session: gaspar.session }).ok).toBe(false);
    expect(core.recordEvidence(evidenceFor("luca", targetRevision), { actor: "luca", session: gaspar.session }).ok).toBe(false);
  });

  it("only spekkio issues defects; only the owner resolves them", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", { id: "MOD-0001", name: "M", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
    const spekkio = { actor: "spekkio", session: openTestSession(core, "spekkio", "MOD-0001") };
    const testDefect = core.recordDefect(
      {
        classification: "TEST_DEFECT",
        severity: "minor",
        evidenceRefs: [],
        affectedCriteria: [],
        affectedArtifacts: [],
        blockingScope: null,
        reproInfo: null,
      },
      spekkio
    );
    expect(testDefect.ok).toBe(true);
    const defectId = testDefect.value!.id;

    // Belthazar cannot issue defects even though he corrects them.
    const belthazar = { actor: "belthazar", session: openTestSession(core, "belthazar", "MOD-0001") };
    expect(
      core.recordDefect(
        {
          classification: "TEST_DEFECT",
          severity: "minor",
          evidenceRefs: [],
          affectedCriteria: [],
          affectedArtifacts: [],
          blockingScope: null,
          reproInfo: null,
        },
        belthazar
      ).error?.code
    ).toBe("EXECUTION_DENIED");

    // Only the routed owner (lucca) or PO may resolve.
    expect(core.resolveDefect(defectId, belthazar).error?.code).toBe("EXECUTION_DENIED");
    const lucca = { actor: "lucca", session: openTestSession(core, "lucca", "MOD-0001") };
    expect(core.resolveDefect(defectId, lucca).ok).toBe(true);
  });

  it("only glenn (or PO) issues SECURITY_BLOCKER", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", { id: "MOD-0001", name: "M", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
    const belthazar = { actor: "belthazar", session: openTestSession(core, "belthazar", "MOD-0001") };
    expect(core.raiseBlocker("SECURITY_BLOCKER", ["SP-0001"], "x", belthazar).error?.code).toBe(
      "EXECUTION_DENIED"
    );
    const glenn = { actor: "glenn", session: openTestSession(core, "glenn", "MOD-0001") };
    expect(core.raiseBlocker("SECURITY_BLOCKER", ["SP-0001"], "x", glenn).ok).toBe(true);
  });

  it("verdict independence: nobody but spekkio records verdicts", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    const po = { actor: "PO", session: bootstrapPrivilegedSession(core, "PO", privateKeyPem) };
    expect(core.recordVerification("SP-0001", "PASS", "PO", [], [], [], po).error?.code).toBe(
      "EXECUTION_DENIED"
    );
    expect(core.recordVerification("SP-0001", "PASS", "gaspar", [], [], [], gaspar).error?.code).toBe(
      "EXECUTION_DENIED"
    );
  });

  it("transition enactment is role-governed through sessions", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", { id: "MOD-0001", name: "M", purpose: "P", specs: [] }, gaspar).ok).toBe(true);
    const belthazar = { actor: "belthazar", session: openTestSession(core, "belthazar", "MOD-0001") };
    // Workers cannot enact planning transitions.
    expect(
      core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "belthazar", session: belthazar.session }).error?.code
    ).toBe("EXECUTION_DENIED");
    // The owning role can.
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "gaspar", session: gaspar.session }).ok).toBe(true);
  });

  it("syntactic sessions without registry entries deny", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    const targetRevision = core.getArtifact("SP-0001").revision;
    // Well-formed but never issued: no registry row, no capabilities.
    const forged = { id: "SES-9999", token: "a".repeat(64) };
    expect(
      core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "gaspar", session: forged }).ok
    ).toBe(false);
    expect(core.recordEvidence(evidenceFor("gaspar", targetRevision), { actor: "gaspar", session: forged }).ok).toBe(false);
  });

  it("denies TTY-only privileged sessions and replays signed bootstraps", () => {
    const workerInput = { adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 };
    const gasparTty = core.openSession({ ...workerInput, role: "gaspar" }, { interactive: true });
    expect(gasparTty.ok).toBe(false);
    expect(gasparTty.error?.code).toBe("APPROVAL_REQUIRED");
    const poTty = core.openSession({ ...workerInput, role: "PO" }, { interactive: true });
    expect(poTty.ok).toBe(false);
    expect(poTty.error?.code).toBe("APPROVAL_REQUIRED");

    const nonce = randomBytes(16).toString("hex");
    const timestamp = "2026-09-11T00:00:00.000Z";
    const rationale = "test privileged-session replay";
    const signature = signApprovalPayload(
      buildSessionAuthorizationPayload({
        sessionRole: "gaspar",
        adapter: "test-adapter",
        runtime: "test-runtime",
        scopeModule: null,
        scopeWp: null,
        ttlSeconds: 3600,
        nonce,
        authority: "PO",
        rationale,
        timestamp,
      }),
      privateKeyPem
    );
    const authorization = { nonce, authority: "PO", rationale, timestamp, signature };
    const first = core.openSession(
      { role: "gaspar", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
      { poAuthorization: authorization }
    );
    expect(first.ok).toBe(true);
    const replay = core.openSession(
      { role: "gaspar", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
      { poAuthorization: authorization }
    );
    expect(replay.ok).toBe(false);
    expect(replay.error?.code).toBe("DUPLICATE_IDENTITY");
  });

  it("denies orchestrator declarations through worker sessions", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    expect(
      core.registerModule("MOD-0001", "DRAFT", { id: "MOD-0001", name: "M", purpose: "P", specs: ["SP-0001"] }, gaspar).ok
    ).toBe(true);
    const worker = openTestSession(core, "belthazar", "MOD-0001");
    expect(
      core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "gaspar", session: worker }).error?.code
    ).toBe("EXECUTION_DENIED");
    expect(
      core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "PO", session: worker }).error?.code
    ).toBe("EXECUTION_DENIED");
  });
});
