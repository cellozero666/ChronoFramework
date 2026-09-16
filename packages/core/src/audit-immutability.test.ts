/**
 * I4 tests — audit/revision tamper attempts fail, including through a raw
 * SQL connection that bypasses the Core entirely.
 * [DOM §5.2, P3.5, FW §13, Remediation §4]
 *
 * The raw connection below is test-only evidence tooling: it proves the
 * triggers hold. Production code has no writable-handle API to abuse.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
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
import { ChronoCore } from "./chrono-core.js";

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

function rawDb(tempDir: string): Database.Database {
  const db = new Database(join(tempDir, ".chrono", "chrono.db"));
  return db;
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

describe("Audit immutability (raw-SQL tamper attempts)", () => {
  let restoreTty: () => void;
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

  let tempDir: string;
  let core: ChronoCore;
  let poPrivateKey: string;
  let gaspar: { actor: string; session: { id: string; token: string } };

  function approveForAudit(action: string, scopeId: string, scopeRev: string): void {
    const timestamp = new Date().toISOString();
    const signature = signApprovalPayload(
      buildApprovalPayload({ action, scopeArtifactId: scopeId, scopeRevision: scopeRev, authority: "PO", rationale: "audit", timestamp }),
      poPrivateKey
    );
    const res = core.recordApproval({ action, scopeArtifactId: scopeId, scopeRevision: scopeRev, authority: "PO", rationale: "audit", timestamp, signature });
    expect(res.ok).toBe(true);
  }

  function openAuditPo(): { actor: string; session: { id: string; token: string } } {
    const nonce = randomBytes(16).toString("hex");
    const timestamp = "2026-09-11T00:00:00.000Z";
    const signature = signApprovalPayload(
      buildSessionAuthorizationPayload({
        sessionRole: "PO", adapter: "test-adapter", runtime: "test-runtime",
        scopeModule: null, scopeWp: null, ttlSeconds: 3600, nonce,
        authority: "PO", rationale: "audit", timestamp,
      }),
      poPrivateKey
    );
    const opened = core.openSession(
      { role: "PO", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
      { poAuthorization: { nonce, authority: "PO", rationale: "audit", timestamp, signature } }
    );
    expect(opened.ok).toBe(true);
    return { actor: "PO", session: { id: opened.value!.id, token: opened.value!.token } };
  }

  /** Attestations, skill files, approved adapter, and a promoted routing proof. */
  function provisionAuditRouting(): void {
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
    const po = openAuditPo();
    expect(core.registerAdapter({ id: "test-adapter", name: "Test adapter", entrypoint, conformanceProof: ["test-adapter --version"] }, po).ok).toBe(true);
    const registrationHash = core.adapterRegistrationHash("test-adapter");
    approveForAudit("adapter-registration", "test-adapter", registrationHash);
    const adapterApproval = core.listApprovals().find((a) => a.scopeArtifactId === "test-adapter");
    expect(adapterApproval).toBeTruthy();
    expect(core.approveAdapter("test-adapter", adapterApproval!.id, po).ok).toBe(true);
    const recordedProof = core.recordRoutingProof(gaspar, {
      adapterId: "test-adapter", binaryPath: rtkBin, version: "1.0.0-test",
      proofCommand: JSON.stringify([rtkBin, "gain"]),
      preRoutingCommand: JSON.stringify(["ls", tempDir]),
      commandHash: computeRevisionHash([rtkBin, "gain"]),
      outputHash: computeRevisionHash("fixture gain ok"),
      exitStatus: 0, gainAvailable: true,
      timestamp: new Date().toISOString(), ttlSeconds: 86400,
    });
    expect(recordedProof.ok).toBe(true);
    for (const spec of managedAssetInventory("test-adapter")) {
      const target = join(tempDir, spec.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, spec.kind === "marker" ? `fixture-managed ${spec.marker ?? spec.path}\n` : `fixture-managed ${spec.path}\n`, "utf8");
    }
    expect(core.promoteRoutingProof(recordedProof.value!.id, po).ok).toBe(true);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-audit-test-"));
    core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    expect(core.init().ok).toBe(true);
    restoreTty = fakeInteractiveTerminal();
    const pair = generateApprovalKeyPair();
    enrollTestPo(core, pair);
    poPrivateKey = pair.privateKeyPem;
    const nonce = randomBytes(16).toString("hex");
    const timestamp = "2026-09-11T00:00:00.000Z";
    const rationale = "test privileged-session bootstrap";
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
      pair.privateKeyPem
    );
    const opened = core.openSession(
      { role: "gaspar", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
      { poAuthorization: { nonce, authority: "PO", rationale, timestamp, signature } }
    );
    expect(opened.ok).toBe(true);
    gaspar = { actor: "gaspar", session: { id: opened.value!.id, token: opened.value!.token } };
    expect(core.registerSpec("SP-0001", "DRAFT", { id: "SP-0001", title: "T", purpose: "P" }, gaspar).ok).toBe(true);
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

  it("rejects UPDATE and DELETE on event_log", () => {
    const raw = rawDb(tempDir);
    try {
      expect(() => raw.exec("UPDATE event_log SET actor = 'mallory'")).toThrow(/append-only/);
      expect(() => raw.exec("DELETE FROM event_log")).toThrow(/append-only/);
    } finally {
      raw.close();
    }
    // The Core still appends and reads normally afterwards.
    expect(core.listEvents().length).toBeGreaterThan(0);
  });

  it("rejects UPDATE and DELETE on artifact_revision history", () => {
    core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "gaspar", session: gaspar.session });
    const historyBefore = core.artifactHistory("SP-0001");
    expect(historyBefore).toHaveLength(2);

    const raw = rawDb(tempDir);
    try {
      expect(() => raw.exec("UPDATE artifact_revision SET status = 'READY'")).toThrow(/append-only/);
      expect(() => raw.exec("DELETE FROM artifact_revision")).toThrow(/append-only/);
    } finally {
      raw.close();
    }

    expect(core.artifactHistory("SP-0001")).toHaveLength(2);
  });

  it("rejects UPDATE and DELETE on evidence", () => {
    // Canonical evidence rule: even tamper-target rows ride a live
    // binding. Build the minimal dispatchable stack (package-less
    // module, empty spec set so no spec gates apply) and bind Lucca
    // through the native chain; the row targets the bound module's
    // own revision so session scope matches.
    const proposed = core.proposeArchitecture({ title: "A" }, gaspar);
    expect(proposed.ok).toBe(true);
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    approveForAudit("architecture-security", "ARCH", proposed.value!);
    expect(core.approveArchitecture(gaspar).ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", { id: "MOD-0001", name: "M", purpose: "P", specs: [] }, gaspar).ok).toBe(true);
    expect(core.transitionState("MOD-0001", "ModulePlanned", { actor: "gaspar", session: gaspar.session }).ok).toBe(true);
    const modRev = core.getArtifact("MOD-0001").revision;
    approveForAudit("planning-approval", "MOD-0001", modRev);
    approveForAudit("module-approval", "MOD-0001", modRev);
    expect(core.transitionState("MOD-0001", "ModuleApproved", { actor: "gaspar", session: gaspar.session }).ok).toBe(true);
    provisionAuditRouting();
    // Position the module with an implementation claim first: a test
    // claim binds only to an already-positioned scope and cannot enact
    // the start event itself. Lucca then binds alongside.
    const implReq = core.requestDispatch(
      { moduleId: "MOD-0001", kind: "implementation", rationale: "audit positioning", adapterId: "test-adapter" },
      gaspar
    );
    expect(implReq.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent: "belthazar", parentRuntimeSession: "audit-parent-impl" }, gaspar).ok).toBe(true);
    const implClaimed = core.claimDispatch({ dispatchId: implReq.value!.dispatchId, childRuntimeSession: "audit-child-impl" }, gaspar);
    expect(implClaimed.ok).toBe(true);
    expect(core.confirmClaim(implReq.value!.dispatchId, gaspar).ok).toBe(true);
    const requested = core.requestDispatch(
      { moduleId: "MOD-0001", kind: "test", rationale: "audit binding for lucca", adapterId: "test-adapter" },
      gaspar
    );
    expect(requested.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent: "lucca", parentRuntimeSession: "audit-parent-1" }, gaspar).ok).toBe(true);
    const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: "audit-child-1" }, gaspar);
    expect(claimed.ok).toBe(true);
    expect(core.confirmClaim(requested.value!.dispatchId, gaspar).ok).toBe(true);
    // The tamper test targets the triggers; producer binding is covered
    // elsewhere, so the producing role records through its own session.
    const lucca = { actor: "lucca", session: { id: claimed.value!.session.id, token: claimed.value!.session.token } };
    const targetRevision = core.getArtifact("MOD-0001").revision;
    expect(
      core.recordEvidence({
        producer: "lucca",
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
      }, lucca).ok,
    ).toBe(true);

    const raw = rawDb(tempDir);
    try {
      expect(() => raw.exec("UPDATE evidence SET result = 'pass'")).toThrow(/immutable/);
      expect(() => raw.exec("DELETE FROM evidence")).toThrow(/immutable/);
    } finally {
      raw.close();
    }
  });

  it("rejects approval rewrites but allows the revocation flag 0 → 1", () => {
    const revision = core.getArtifact("SP-0001").revision;
    const timestamp = "2026-06-01T00:00:00.000Z";
    const signature = signApprovalPayload(
      buildApprovalPayload({
        action: "module-approval",
        scopeArtifactId: "SP-0001",
        scopeRevision: revision,
        authority: "PO",
        rationale: "test",
        timestamp,
      }),
      poPrivateKey
    );
    const created = core.recordApproval({
      action: "module-approval",
      scopeArtifactId: "SP-0001",
      scopeRevision: revision,
      authority: "PO",
      rationale: "test",
      timestamp,
      signature,
    });
    expect(created.ok).toBe(true);

    const raw = rawDb(tempDir);
    try {
      expect(() => raw.exec("UPDATE approval SET rationale = 'forged'")).toThrow(/immutable/);
      expect(() => raw.exec("DELETE FROM approval")).toThrow(/cannot be deleted/);
      expect(() =>
        raw.exec(`UPDATE approval SET revoked = 1 WHERE id = '${created.value!.id}'`),
      ).not.toThrow();
    } finally {
      raw.close();
    }
  });

  it("rejects waiver rewrites but allows active → expired", () => {
    const raw = rawDb(tempDir);
    try {
      raw.exec(
        `INSERT INTO waiver (id, issue, scope_artifact_id, scope_revision, rationale,
          accepting_authority, expiry_review_condition, timestamp, status, signature)
         VALUES ('WAIVER-0001', 'risk', 'SP-0001', 'sha256:abc', 'accepted',
          'PO', 'review in 30d', '2026-01-01T00:00:00.000Z', 'active', 'sig')`,
      );
      expect(() => raw.exec("UPDATE waiver SET rationale = 'forged'")).toThrow(/immutable/);
      expect(() => raw.exec("DELETE FROM waiver")).toThrow(/cannot be deleted/);
      expect(() =>
        raw.exec("UPDATE waiver SET status = 'expired' WHERE id = 'WAIVER-0001'"),
      ).not.toThrow();
      // Illegal lifecycle jump is rejected even though status changes are allowed.
      expect(() =>
        raw.exec("UPDATE waiver SET status = 'active' WHERE id = 'WAIVER-0001'"),
      ).toThrow(/immutable/);
    } finally {
      raw.close();
    }
  });
});
