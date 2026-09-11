/**
 * I3 tests — immutable revision history and exact-revision resolution.
 * [DOM §2.3, P3.5, CORE §12, Remediation §4]
 *
 * A new revision must never overwrite the row required to resolve an
 * older `<ID>@<revision>` reference.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore } from "./chrono-core.js";

describe("Revision history", () => {
  let tempDir: string;
  let core: ChronoCore;
  let restoreTty: () => void;
  let gaspar: { actor: string; session: { id: string; token: string } };

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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-rev-test-"));
    core = new ChronoCore({ projectPath: tempDir });
    expect(core.init().ok).toBe(true);
    restoreTty = fakeInteractiveTerminal();
    const pair = generateApprovalKeyPair();
    enrollTestPo(core, pair);
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

  it("preserves every revision across transitions without rotating the contract", () => {
    const content = { id: "SP-0001", title: "History", purpose: "I3", revision: "x", status: "DRAFT", inScope: [], dependencies: [] };
    const created = core.registerSpec("SP-0001", "DRAFT", content, gaspar);
    expect(created.ok).toBe(true);
    const contractRevision = created.value!;

    const moved = core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "gaspar", session: gaspar.session });
    expect(moved.ok).toBe(true);

    // Status transitions are audit events, not material changes: the
    // contract revision is stable so revision-bound approvals, Harnesses,
    // and evidence survive the lifecycle [DOM §2.3].
    const current = core.resolveReference("SP-0001");
    expect(current.ok).toBe(true);
    expect(current.value?.status).toBe("REVIEW");
    expect(current.value?.revision).toBe(contractRevision);

    // The registration revision still resolves with its original status,
    // and the transition link is appended to history.
    const old = core.resolveReference("SP-0001", contractRevision);
    expect(old.ok).toBe(true);
    expect(old.value?.status).toBe("DRAFT");
    expect(core.artifactHistory("SP-0001")).toHaveLength(2);
  });

  it("distinguishes unknown artifacts from stale revisions", () => {
    const missing = core.resolveReference("SP-9999", "sha256:dead");
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("ENTITY_NOT_FOUND");

    core.registerSpec("SP-0002", "DRAFT", { id: "SP-0002", title: "T", purpose: "P" }, gaspar);
    const stale = core.resolveReference(
      "SP-0002",
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe("STALE_REVISION");
  });

  it("rejects non-canonical content instead of hashing it ambiguously", () => {
    expect(core.registerSpec("SP-0003", "DRAFT", undefined, gaspar).ok).toBe(false);
    expect(core.registerSpec("SP-0004", "DRAFT", { fn: () => 1 }, gaspar).ok).toBe(false);
    expect(core.registerSpec("SP-0005", "DRAFT", { n: Number.NaN }, gaspar).ok).toBe(false);
    expect(core.registerSpec("SP-0006", "DRAFT", { when: new Date() }, gaspar).ok).toBe(false);
  });
});
