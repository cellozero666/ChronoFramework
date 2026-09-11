/**
 * §3A tests — Core-owned agent identity and role authority.
 * Every protected operation requires an authenticated session; capabilities
 * resolve through the session's bound role. Bare role strings, forged
 * sessions, confused actors, and cross-role operations all deny.
 * All seven canonical roles have positive and negative authority tests.
 * [DOM §2.2, RUNTIME §2, Remediation §3A]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildEnrollmentChallenge, buildEnrollmentPayload, buildSessionAuthorizationPayload, computeRevisionHash, fingerprintPublicKey, generateApprovalKeyPair, signApprovalPayload } from "@chrono/domain";
import { ChronoCore, type CallerAuth } from "./chrono-core.js";

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
    core = new ChronoCore({ projectPath: tempDir });
    expect(core.init().ok).toBe(true);
    restoreTty = fakeInteractiveTerminal();
    ({ privateKeyPem, gaspar } = bootstrapAuthority(core));
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
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

  it("each role records its own evidence; strangers cannot", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    expect(
      core.registerModule("MOD-0001", "DRAFT", { id: "MOD-0001", name: "M", purpose: "P", specs: ["SP-0001"] }, gaspar).ok
    ).toBe(true);
    const targetRevision = core.getArtifact("SP-0001").revision;
    for (const role of ["belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio", "gaspar"]) {
      const session = role === "gaspar" ? gaspar.session : openTestSession(core, role, "MOD-0001");
      expect(core.recordEvidence(evidenceFor(role, targetRevision), { actor: role, session }).ok).toBe(true);
    }
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
