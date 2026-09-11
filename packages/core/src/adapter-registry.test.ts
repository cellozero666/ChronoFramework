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
  buildSessionAuthorizationPayload,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore, type CallerAuth } from "./chrono-core.js";

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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-adapter-test-"));
    core = new ChronoCore({ projectPath: tempDir });
    expect(core.init().ok).toBe(true);
    restoreTty = fakeInteractiveTerminal();
    const pair = generateApprovalKeyPair();
    expect(core.registerPoPublicKey(pair.publicKeyPem).ok).toBe(true);
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

  it("registers an adapter through a PO session and lists it", () => {
    const res = core.registerAdapter(
      { id: "fixture", name: "Fixture runtime", entrypoint, conformanceProof: ["fixture --version"] },
      po
    );
    expect(res.ok).toBe(true);
    expect(res.value?.id).toBe("fixture");
    expect(core.listAdapters().map((a) => a.id)).toEqual(["fixture"]);
    expect(core.getAdapterForDispatch("fixture").entrypoint).toBe(entrypoint);
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

  it("rejects malformed ids, missing fields, and non-executable entrypoints", () => {
    expect(
      core.registerAdapter({ id: "Bad Id!", name: "X", entrypoint }, po).error?.code
    ).toBe("VALIDATION_ERROR");
    expect(
      core.registerAdapter({ id: "fixture", name: "  ", entrypoint }, po).error?.code
    ).toBe("VALIDATION_ERROR");
    expect(
      core.registerAdapter({ id: "fixture", name: "X", entrypoint: join(tempDir, "missing.sh") }, po).error?.code
    ).toBe("CONFIG_ERROR");
    expect(core.listAdapters()).toHaveLength(0);
  });

  it("rejects provider/model/secret bindings in adapter specs", () => {
    for (const bad of ["provider=openai", "model: gpt-x", "api_key=sk-live", "dispatchProof=rtk; MODEL=g"]) {
      const res = core.registerAdapter(
        { id: "fixture", name: "X", entrypoint, dispatchProof: bad },
        po
      );
      expect(res.error?.code).toBe("VALIDATION_ERROR");
    }
    expect(core.listAdapters()).toHaveLength(0);
  });

  it("rejects duplicate ids and revokes terminally", () => {
    expect(
      core.registerAdapter({ id: "fixture", name: "X", entrypoint }, po).ok
    ).toBe(true);
    expect(
      core.registerAdapter({ id: "fixture", name: "Y", entrypoint }, po).error?.code
    ).toBe("DUPLICATE_IDENTITY");
    expect(core.revokeAdapter("fixture", gaspar).error?.code).toBe("EXECUTION_DENIED");
    expect(core.revokeAdapter("fixture", po).ok).toBe(true);
    expect(() => core.getAdapterForDispatch("fixture")).toThrow(/revoked/);
  });

  it("denies dispatch for unknown adapters", () => {
    expect(() => core.getAdapterForDispatch("ghost")).toThrow(/not registered/);
  });
});
