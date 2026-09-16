/**
 * Planning-advancement CLI tests: architecture submit/approve, spec
 * submit/ready/needs-revision, and harness record — the governed
 * native path for the pre-activation runway. All through the run*
 * functions with explicit caller credentials; denials carry exact
 * codes and change no state.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import {
  buildApprovalPayload,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore } from "@chrono/core";
import {
  runArchitectureApprove,
  runArchitectureSubmit,
  runHarnessRecord,
  runSpecNeedsRevision,
  runSpecReady,
  runSpecSubmit,
} from "./readiness-cli.js";
import { runModuleActivate } from "./lifecycle-cli.js";
import { createProgram } from "./index.js";

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

describe("Spec CLI (planning runway)", () => {
  let tempDir: string;
  let root: string;
  let gasparToken = "";
  let gasparSession: { id: string; token: string } = { id: "", token: "" };
  let signingKey = "";
  let restoreTty: () => void;
  let archRev = "";
  let specRev = "";

  function openPrivileged(core: ChronoCore, role: "gaspar" | "PO", key: string): { id: string; token: string } {
    const nonce = randomBytes(16).toString("hex");
    const timestamp = "2026-09-11T00:00:00.000Z";
    const signature = signApprovalPayload(
      buildSessionAuthorizationPayload({
        sessionRole: role, adapter: "fixture", runtime: "opencode",
        scopeModule: null, scopeWp: null, ttlSeconds: 3600, nonce,
        authority: "PO", rationale: "test", timestamp,
      }),
      key
    );
    const res = core.openSession(
      { role, adapter: "fixture", runtime: "opencode", ttlSeconds: 3600 },
      { poAuthorization: { nonce, authority: "PO", rationale: "test", timestamp, signature } }
    );
    expect(res.ok).toBe(true);
    return { id: res.value!.id, token: res.value!.token };
  }

  function approve(core: ChronoCore, action: string, scopeId: string, scopeRev: string): string {
    const signature = signApprovalPayload(
      buildApprovalPayload({
        action, scopeArtifactId: scopeId, scopeRevision: scopeRev,
        authority: "PO", rationale: "test approval", timestamp: "2026-09-14T00:00:00.000Z",
      }),
      signingKey
    );
    const res = core.recordApproval({
      action, scopeArtifactId: scopeId, scopeRevision: scopeRev,
      authority: "PO", rationale: "test approval", timestamp: "2026-09-14T00:00:00.000Z", signature,
    });
    expect(res.ok).toBe(true);
    return res.value!.id;
  }

  const auth = () => ({ as: "gaspar", sessionToken: gasparToken, json: true });

  function withCore<T>(fn: (core: ChronoCore) => T): T {
    const core = new ChronoCore({ projectPath: root, runtime: "opencode" });
    try {
      return fn(core);
    } finally {
      core.close();
    }
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-readiness-cli-test-"));
    root = tempDir;
    const core = new ChronoCore({ projectPath: tempDir, runtime: "opencode" });
    try {
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
      gasparSession = openPrivileged(core, "gaspar", signingKey);
      gasparToken = `${gasparSession.id}/${gasparSession.token}`;
      const gaspar = { actor: "gaspar", session: gasparSession };
      const proposed = core.proposeArchitecture({ title: "A" }, gaspar);
      expect(proposed.ok).toBe(true);
      archRev = proposed.value!;
      expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
      specRev = core.getArtifact("SP-0001").revision;
    } finally {
      core.close();
    }
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("submits architecture for review exactly once, then approves with a current approval", () => {
    const submitted = runArchitectureSubmit(root, auth());
    expect(submitted.exitCode).toBe(0);
    expect(JSON.parse(submitted.stdout) as { state?: string }).toMatchObject({ state: "under_review" });
    // Resubmission denies: illegal transition, no state change.
    expect(runArchitectureSubmit(root, auth()).exitCode).toBe(1);
    // Approval without architecture-security denies with the exact code.
    const denied = runArchitectureApprove(root, auth());
    expect(denied.exitCode).toBe(1);
    expect((JSON.parse(denied.stdout) as { error: { code: string } }).error.code).toBe("APPROVAL_REQUIRED");
    // With the signed approval bound to the current revision: approved.
    withCore((core) => approve(core, "architecture-security", "ARCH", archRev));
    const approved = runArchitectureApprove(root, auth());
    expect(approved.exitCode).toBe(0);
    expect(JSON.parse(approved.stdout) as { state?: string }).toMatchObject({ state: "approved" });
  });

  it("walks a spec DRAFT to REVIEW to READY through the governed commands", () => {
    const submitted = runSpecSubmit(root, { ...auth(), spec: "SP-0001" });
    expect(submitted.exitCode).toBe(0);
    expect(JSON.parse(submitted.stdout) as { toState?: string }).toMatchObject({ toState: "REVIEW" });
    // READY without an approved architecture denies.
    const early = runSpecReady(root, { ...auth(), spec: "SP-0001" });
    expect(early.exitCode).toBe(1);
    // Approve the architecture through the governed commands.
    expect(runArchitectureSubmit(root, auth()).exitCode).toBe(0);
    withCore((core) => approve(core, "architecture-security", "ARCH", archRev));
    expect(runArchitectureApprove(root, auth()).exitCode).toBe(0);
    // Still denies: no architecture-security for the spec, no harness.
    expect(runSpecReady(root, { ...auth(), spec: "SP-0001" }).exitCode).toBe(1);
    withCore((core) => approve(core, "architecture-security", "SP-0001", specRev));
    // Still denies: no harness recorded for the revision.
    expect(runSpecReady(root, { ...auth(), spec: "SP-0001" }).exitCode).toBe(1);
    const content = "# harness";
    const recorded = runHarnessRecord(root, {
      ...auth(), revision: specRev, contentHash: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`, contentText: content,
    });
    expect(recorded.exitCode).toBe(0);
    // Now every READY gate holds: the transition succeeds.
    const ready = runSpecReady(root, { ...auth(), spec: "SP-0001" });
    expect(ready.exitCode).toBe(0);
    expect(JSON.parse(ready.stdout) as { toState?: string }).toMatchObject({ toState: "READY" });
    withCore((core) => {
      expect(core.getArtifact("SP-0001").status).toBe("READY");
    });
  });

  it("returns a spec to DRAFT for revision and denies unknown scopes", () => {
    expect(runSpecSubmit(root, { ...auth(), spec: "SP-0001" }).exitCode).toBe(0);
    const back = runSpecNeedsRevision(root, { ...auth(), spec: "SP-0001" });
    expect(back.exitCode).toBe(0);
    expect(JSON.parse(back.stdout) as { toState?: string }).toMatchObject({ toState: "DRAFT" });
    expect(runSpecSubmit(root, { ...auth(), spec: "SP-9999" }).exitCode).toBe(1);
    expect(runSpecReady(root, { ...auth(), spec: "SP-9999" }).exitCode).toBe(1);
    expect(runSpecNeedsRevision(root, { ...auth(), spec: "SP-9999" }).exitCode).toBe(1);
  });

  it("harness-record validates shapes, sources, and callers", () => {
    const content = "# harness";
    const hash = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
    // Malformed revision and hash deny.
    expect(runHarnessRecord(root, { ...auth(), revision: "nope", contentHash: hash, contentText: content }).exitCode).toBe(1);
    expect(runHarnessRecord(root, { ...auth(), revision: specRev, contentHash: "nope", contentText: content }).exitCode).toBe(1);
    // Neither content source denies; both denies.
    expect(runHarnessRecord(root, { ...auth(), revision: specRev, contentHash: hash }).exitCode).toBe(1);
    expect(
      runHarnessRecord(root, { ...auth(), revision: specRev, contentHash: hash, contentFile: join(root, "missing.md"), contentText: content }).exitCode
    ).toBe(1);
    // Missing file denies.
    expect(runHarnessRecord(root, { ...auth(), revision: specRev, contentHash: hash, contentFile: join(root, "missing.md") }).exitCode).toBe(1);
    // Worker sessions deny (planning authority only).
    const worker = withCore((core) => core.openSession(
      { role: "belthazar", adapter: "fixture", runtime: "opencode", scopeModule: "default", ttlSeconds: 3600 },
      { interactive: true }
    ));
    expect(worker.ok).toBe(true);
    if (worker.ok) {
      const workerToken = `${worker.value!.id}/${worker.value!.token}`;
      expect(
        runHarnessRecord(root, { as: "belthazar", sessionToken: workerToken, json: true, revision: specRev, contentHash: hash, contentText: content }).exitCode
      ).toBe(1);
    }
    // Happy path records exactly one harness bound to the revision.
    const recorded = runHarnessRecord(root, { ...auth(), revision: specRev, contentHash: hash, contentText: content });
    expect(recorded.exitCode).toBe(0);
    expect((JSON.parse(recorded.stdout) as { specRevision?: string }).specRevision).toBe(specRev);
  });

  it("walks the full pre-activation runway to module activation through governed commands only", () => {
    // The pilot shape (missing-transition-surface repair): arch
    // submit/approve, spec submit/ready, harness record, then module
    // activation — every step through a CLI command, no direct Core
    // transition calls below.
    expect(runArchitectureSubmit(root, auth()).exitCode).toBe(0);
    withCore((core) => approve(core, "architecture-security", "ARCH", archRev));
    expect(runArchitectureApprove(root, auth()).exitCode).toBe(0);
    expect(runSpecSubmit(root, { ...auth(), spec: "SP-0001" }).exitCode).toBe(0);
    withCore((core) => approve(core, "architecture-security", "SP-0001", specRev));
    const content = "# harness";
    const hash = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
    expect(
      runHarnessRecord(root, { ...auth(), revision: specRev, contentHash: hash, contentText: content }).exitCode
    ).toBe(0);
    expect(runSpecReady(root, { ...auth(), spec: "SP-0001" }).exitCode).toBe(0);
    // With the spec READY, activation proceeds through its own
    // governed command after both current approvals.
    withCore((core) => {
      const gaspar = { actor: "gaspar", session: gasparSession };
      expect(core.registerModule("MOD-0002", "DRAFT", { id: "MOD-0002", name: "M", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
      const modRev = core.getArtifact("MOD-0002").revision;
      approve(core, "planning-approval", "MOD-0002", modRev);
      approve(core, "module-approval", "MOD-0002", modRev);
    });
    const activated = runModuleActivate(root, { ...auth(), module: "MOD-0002" });
    expect(activated.exitCode).toBe(0);
    expect(JSON.parse(activated.stdout) as { state?: string }).toMatchObject({ state: "APPROVED" });
  });

  it("exposes the six runway commands on the program surface", () => {
    const program = createProgram(root);
    const names = program.commands.map((c) => c.name());
    for (const name of [
      "architecture-submit",
      "architecture-approve",
      "spec-submit",
      "spec-ready",
      "spec-needs-revision",
      "harness-record",
    ]) {
      expect(names, `program surface omits '${name}'`).toContain(name);
    }
  });

  it("requires caller credentials on every command", () => {
    expect(runArchitectureSubmit(root, { as: "", sessionToken: gasparToken, json: true }).exitCode).toBe(1);
    expect(runSpecSubmit(root, { as: "gaspar", json: true, spec: "SP-0001" }).exitCode).toBe(1);
    expect(runSpecReady(root, { as: "", sessionToken: gasparToken, json: true, spec: "SP-0001" }).exitCode).toBe(1);
    expect(
      runHarnessRecord(root, { as: "gaspar", json: true, revision: specRev, contentHash: `sha256:${"b".repeat(64)}`, contentText: "# h" }).exitCode
    ).toBe(1);
  });
});
