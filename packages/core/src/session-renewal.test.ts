/**
 * Sliding session renewal (field report: SES-0036 died mid-workflow).
 *
 * Authenticated calls landing inside the renew window extend a live
 * session by its original TTL, hard-capped at the absolute lifetime —
 * active work survives (entry sessions included), while expired and
 * revoked sessions never renew. Renewal is an audited SessionRenewed
 * event, never silent. Re-entry after death mints a fresh session;
 * bindings never transfer between sessions by design.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  SESSION_MAX_LIFETIME_SECONDS,
  SESSION_RENEW_WINDOW_SECONDS,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore, type CallerAuth } from "./chrono-core.js";

function enrollTestPo(core: ChronoCore, pair: { publicKeyPem: string; privateKeyPem: string }): void {
  const nonce = randomBytes(16).toString("hex");
  const fingerprint = fingerprintPublicKey(pair.publicKeyPem);
  const confirmation = buildEnrollmentChallenge("default", fingerprint, nonce);
  const timestamp = new Date().toISOString();
  const signature = signApprovalPayload(
    buildEnrollmentPayload({ projectId: "default", fingerprint, timestamp, nonce, authority: "PO", rationale: "test", confirmation }),
    pair.privateKeyPem
  );
  expect(core.enrollPo({ publicKeyPem: pair.publicKeyPem, nonce, timestamp, rationale: "test", confirmation, signature }).ok).toBe(true);
}

function fakeTty(): () => void {
  const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  return () => {
    if (stdinDesc !== undefined) Object.defineProperty(process.stdin, "isTTY", stdinDesc);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdoutDesc !== undefined) Object.defineProperty(process.stdout, "isTTY", stdoutDesc);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  };
}

describe("Sliding session renewal", () => {
  let tempDir: string;
  let core: ChronoCore;
  let signingKey = "";
  let gaspar: { actor: string; session: { id: string; token: string } };
  let clockRef = { now: "" };
  let restoreTty: () => void;

  function openPrivileged(role: "gaspar" | "PO", key: string, ttlSeconds = 3600): { id: string; token: string } {
    const nonce = randomBytes(16).toString("hex");
    const timestamp = "2026-09-11T00:00:00.000Z";
    const signature = signApprovalPayload(
      buildSessionAuthorizationPayload({
        sessionRole: role, adapter: "test-adapter", runtime: "test-runtime",
        scopeModule: null, scopeWp: null, ttlSeconds, nonce,
        authority: "PO", rationale: "test", timestamp,
      }),
      key
    );
    const res = core.openSession(
      { role, adapter: "test-adapter", runtime: "test-runtime", ttlSeconds },
      { poAuthorization: { nonce, authority: "PO", rationale: "test", timestamp, signature } }
    );
    expect(res.ok).toBe(true);
    return { id: res.value!.id, token: res.value!.token };
  }

  function renewals(): Array<{ entityId: string }> {
    return core.listEvents().filter((e) => e.eventType === "SessionRenewed");
  }

  /** Any authenticated call resolves the caller (renewal rides validation). */
  function touchSession(auth: { actor: string; session: { id: string; token: string } }): boolean {
    const res = core.nextAction({ moduleId: "MOD-0001" }, auth);
    return res.ok;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-renew-test-"));
    clockRef = { now: new Date().toISOString() };
    core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime", clock: () => clockRef.now });
    expect(core.init().ok).toBe(true);
    const pair = generateApprovalKeyPair();
    restoreTty = fakeTty();
    enrollTestPo(core, pair);
    signingKey = pair.privateKeyPem;
    gaspar = { actor: "gaspar", session: openPrivileged("gaspar", signingKey) };
    expect(core.registerModule("MOD-0001", "DRAFT", { id: "MOD-0001", name: "M", purpose: "P", specs: [] }, gaspar).ok).toBe(true);
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("renews inside the window and survives past the original expiry", () => {
    const t0 = Date.parse(clockRef.now);
    // Jump to 300s before expiry (inside the renew window).
    clockRef.now = new Date(t0 + (3600 - SESSION_RENEW_WINDOW_SECONDS + 300) * 1000).toISOString();
    expect(touchSession(gaspar)).toBe(true);
    expect(renewals()).toHaveLength(1);
    // Past the original expiry the session still authorizes.
    clockRef.now = new Date(t0 + 5400 * 1000).toISOString();
    expect(touchSession(gaspar)).toBe(true);
    expect(renewals()).toHaveLength(1);
  });

  it("does not renew fresh sessions", () => {
    expect(touchSession(gaspar)).toBe(true);
    expect(renewals()).toHaveLength(0);
  });

  it("never renews past the absolute lifetime cap", () => {
    // A maximum-lifetime session at its own expiry edge: the only
    // candidate equals the current expiry, so nothing extends and the
    // session dies on schedule instead of living forever.
    const long = openPrivileged("gaspar", signingKey, SESSION_MAX_LIFETIME_SECONDS);
    const t0 = Date.parse(clockRef.now);
    clockRef.now = new Date(t0 + (SESSION_MAX_LIFETIME_SECONDS - 300) * 1000).toISOString();
    expect(touchSession({ actor: "gaspar", session: long })).toBe(true);
    expect(renewals()).toHaveLength(0);
    clockRef.now = new Date(t0 + (SESSION_MAX_LIFETIME_SECONDS + 3600) * 1000).toISOString();
    expect(touchSession({ actor: "gaspar", session: long })).toBe(false);
    expect(renewals()).toHaveLength(0);
  });

  it("expired and revoked sessions never renew", () => {
    const t0 = Date.parse(clockRef.now);
    clockRef.now = new Date(t0 + 7200 * 1000).toISOString();
    expect(touchSession(gaspar)).toBe(false);
    expect(renewals()).toHaveLength(0);
    const po: CallerAuth = { actor: "PO", session: openPrivileged("PO", signingKey) };
    const victim = openPrivileged("gaspar", signingKey);
    expect(core.revokeSession(victim.id, po).ok).toBe(true);
    expect(touchSession({ actor: "gaspar", session: victim })).toBe(false);
    expect(renewals()).toHaveLength(0);
  });

  it("caps session TTL at thirty days", () => {
    const atCap = core.openSession(
      { role: "belthazar", adapter: "test-adapter", runtime: "test-runtime", scopeModule: "default", ttlSeconds: SESSION_MAX_LIFETIME_SECONDS },
      { interactive: true }
    );
    expect(atCap.ok).toBe(true);
    const over = core.openSession(
      { role: "belthazar", adapter: "test-adapter", runtime: "test-runtime", scopeModule: "default", ttlSeconds: SESSION_MAX_LIFETIME_SECONDS + 1 },
      { interactive: true }
    );
    expect(over.ok).toBe(false);
  });

  it("does not renew in read-only mode", () => {
    const t0 = Date.parse(clockRef.now);
    clockRef.now = new Date(t0 + (3600 - 300) * 1000).toISOString();
    const ro = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime", clock: () => clockRef.now, readOnly: true });
    try {
      const res = ro.nextAction({ moduleId: "MOD-0001" }, gaspar);
      expect(res.ok).toBe(true);
    } finally {
      ro.close();
    }
    expect(renewals()).toHaveLength(0);
  });
});
