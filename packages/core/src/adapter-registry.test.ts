/**
 * Slice 6 tests — runtime adapter registry [RUNTIME §13, PL Phase 5].
 * Registration is PO-only and verified deterministically: identifier
 * shape, required fields, executable entrypoint, and no provider/model/
 * secret bindings. Revocation is terminal; dispatch resolves fail-closed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  buildApprovalPayload,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore, type CallerAuth } from "./chrono-core.js";

const APPROVAL_TIME = "2026-06-01T00:00:00.000Z";

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

function bootstrapPo(core: ChronoCore, privateKeyPem: string): CallerAuth {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = "2026-09-11T00:00:00.000Z";
  const rationale = "test privileged-session bootstrap";
  const signature = signApprovalPayload(
    buildSessionAuthorizationPayload({
      sessionRole: "PO",
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
  const res = core.openSession(
    { role: "PO", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
    { poAuthorization: { nonce, authority: "PO", rationale, timestamp, signature } }
  );
  expect(res.ok).toBe(true);
  return { actor: "PO", session: { id: res.value!.id, token: res.value!.token } };
}

describe("Adapter registry", () => {
  let tempDir: string;
  let core: ChronoCore;
  let restoreTty: () => void;
  let po: CallerAuth;
  let gaspar: CallerAuth;
  let entrypoint: string;
  let privateKeyPem: string;

  /** Sign an adapter-registration approval binding the current hash. */
  function approveRegistration(adapterId: string): string {
    const revision = core.adapterRegistrationHash(adapterId);
    const signature = signApprovalPayload(
      buildApprovalPayload({
        action: "adapter-registration",
        scopeArtifactId: adapterId,
        scopeRevision: revision,
        authority: "PO",
        rationale: "trust this runtime",
        timestamp: APPROVAL_TIME,
      }),
      privateKeyPem
    );
    const recorded = core.recordApproval({
      action: "adapter-registration",
      scopeArtifactId: adapterId,
      scopeRevision: revision,
      authority: "PO",
      rationale: "trust this runtime",
      timestamp: APPROVAL_TIME,
      signature,
    });
    expect(recorded.ok).toBe(true);
    return recorded.value!.id;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-adapter-test-"));
    core = new ChronoCore({ projectPath: tempDir });
    expect(core.init().ok).toBe(true);
    restoreTty = fakeInteractiveTerminal();
    const pair = generateApprovalKeyPair();
    enrollTestPo(core, pair);
    privateKeyPem = pair.privateKeyPem;
    po = bootstrapPo(core, pair.privateKeyPem);
    const gasparNonce = randomBytes(16).toString("hex");
    const gasparTimestamp = "2026-09-11T00:00:00.000Z";
    const gasparRationale = "test privileged-session bootstrap";
    const gasparSignature = signApprovalPayload(
      buildSessionAuthorizationPayload({
        sessionRole: "gaspar",
        adapter: "test-adapter",
        runtime: "test-runtime",
        scopeModule: null,
        scopeWp: null,
        ttlSeconds: 3600,
        nonce: gasparNonce,
        authority: "PO",
        rationale: gasparRationale,
        timestamp: gasparTimestamp,
      }),
      pair.privateKeyPem
    );
    const gasparOpened = core.openSession(
      { role: "gaspar", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
      {
        poAuthorization: {
          nonce: gasparNonce,
          authority: "PO",
          rationale: gasparRationale,
          timestamp: gasparTimestamp,
          signature: gasparSignature,
        },
      }
    );
    expect(gasparOpened.ok).toBe(true);
    gaspar = {
      actor: "gaspar",
      session: { id: gasparOpened.value!.id, token: gasparOpened.value!.token },
    };
    entrypoint = join(tempDir, "fixture-runtime.sh");
    writeFileSync(entrypoint, "#!/bin/sh\necho fixture-ok\n");
    chmodSync(entrypoint, 0o755);
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers pending, then activates with a signed approval", () => {
    const res = core.registerAdapter(
      { id: "fixture", name: "Fixture runtime", entrypoint, conformanceProof: ["fixture --version"] },
      po
    );
    expect(res.ok).toBe(true);
    expect(res.value?.id).toBe("fixture");
    expect(core.listAdapters().map((a) => `${a.id}:${a.status}`)).toEqual(["fixture:pending"]);
    expect(() => core.getAdapterForDispatch("fixture")).toThrow(/pending/);
    const approvalId = approveRegistration("fixture");
    expect(core.approveAdapter("fixture", approvalId, po).ok).toBe(true);
    expect(core.listAdapters().map((a) => `${a.id}:${a.status}`)).toEqual(["fixture:active"]);
    expect(core.getAdapterForDispatch("fixture").entrypoint).toBe(entrypoint);
    // Re-activation with the same approval is an audited no-op.
    expect(core.approveAdapter("fixture", approvalId, po).ok).toBe(true);
  });

  it("denies activation to non-PO sessions and confused approvals", () => {
    expect(
      core.registerAdapter(
        { id: "fixture", name: "Fixture runtime", entrypoint, conformanceProof: ["fixture --version"] },
        po
      ).ok
    ).toBe(true);
    expect(
      core.registerAdapter(
        { id: "other", name: "Other runtime", entrypoint, conformanceProof: ["other --version"] },
        po
      ).ok
    ).toBe(true);
    const otherApproval = approveRegistration("other");
    expect(core.approveAdapter("fixture", otherApproval, po).error?.code).toBe("APPROVAL_REQUIRED");
    expect(core.approveAdapter("nope", otherApproval, po).error?.code).toBe("ENTITY_NOT_FOUND");
    expect(core.approveAdapter("fixture", "APR-9999", po).error?.code).toBe("REFERENCE_UNRESOLVABLE");
    const approvalId = approveRegistration("fixture");
    expect(core.approveAdapter("fixture", approvalId, gaspar).error?.code).toBe("EXECUTION_DENIED");
    expect(core.approveAdapter("fixture", approvalId, po).ok).toBe(true);
  });

  it("denies registration to non-PO sessions, including gaspar", () => {
    const res = core.registerAdapter(
      { id: "fixture", name: "Fixture runtime", entrypoint },
      gaspar
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("EXECUTION_DENIED");
    expect(core.listAdapters()).toHaveLength(0);
  });

  it("rejects malformed ids, missing fields, empty proofs, and non-executable entrypoints", () => {
    const proof = ["fixture --version"];
    expect(
      core.registerAdapter({ id: "Bad Id!", name: "X", entrypoint, conformanceProof: proof }, po).error?.code
    ).toBe("VALIDATION_ERROR");
    expect(
      core.registerAdapter({ id: "fixture", name: "  ", entrypoint, conformanceProof: proof }, po).error?.code
    ).toBe("VALIDATION_ERROR");
    expect(
      core.registerAdapter({ id: "fixture", name: "X", entrypoint }, po).error?.code
    ).toBe("VALIDATION_ERROR");
    expect(
      core.registerAdapter({ id: "fixture", name: "X", entrypoint: join(tempDir, "missing.sh"), conformanceProof: proof }, po).error?.code
    ).toBe("CONFIG_ERROR");
    expect(core.listAdapters()).toHaveLength(0);
  });

  it("rejects provider/model/secret bindings in adapter specs", () => {
    for (const bad of [
      "provider=openai",
      "model: gpt-x",
      "model = gpt-x",
      "provider : x",
      "api_key=sk-live",
      "api-key: sk-live",
      "token=abc",
      "password hunter2",
      "dispatchProof=rtk; MODEL=g",
    ]) {
      const res = core.registerAdapter(
        { id: "fixture", name: "X", entrypoint, dispatchProof: bad, conformanceProof: ["x"] },
        po
      );
      expect(res.error?.code).toBe("VALIDATION_ERROR");
    }
    expect(core.listAdapters()).toHaveLength(0);
  });

  it("rejects duplicate ids and revokes terminally without duplicate audits", () => {
    expect(
      core.registerAdapter({ id: "fixture", name: "X", entrypoint, conformanceProof: ["x"] }, po).ok
    ).toBe(true);
    expect(
      core.registerAdapter({ id: "fixture", name: "Y", entrypoint, conformanceProof: ["x"] }, po).error?.code
    ).toBe("DUPLICATE_IDENTITY");
    expect(core.revokeAdapter("fixture", gaspar).error?.code).toBe("EXECUTION_DENIED");
    expect(core.revokeAdapter("fixture", po).ok).toBe(true);
    expect(core.revokeAdapter("fixture", po).ok).toBe(true);
    expect(
      core.listEvents().filter((e) => e.eventType === "StateTransition" && e.entityId === "fixture")
    ).toHaveLength(1);
    expect(() => core.getAdapterForDispatch("fixture")).toThrow(/revoked/);
  });

  it("denies dispatch for unknown adapters", () => {
    expect(() => core.getAdapterForDispatch("ghost")).toThrow(/not registered/);
  });
});
