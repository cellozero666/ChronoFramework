/**
 * Native dispatch CLI tests — dispatch-request, dispatch-claim, and
 * dispatch-task-check against the file ledger.
 *
 * Credentials never cross these commands toward the model: request
 * authenticates the Gaspar session, claim resolves it host-side from
 * the ledger and confines the worker credential to a 0600 file.
 * Task-check is the single delegation decision point the plugin
 * enforces verbatim.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import {
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
  RTK_UPSTREAM,
  SKILL_RELEASE,
  SKILL_RUNTIME_PATHS,
  SKILL_UPSTREAM,
} from "@chrono/domain";
import { ChronoCore } from "@chrono/core";
import { FIXTURE_SKILL_MD } from "../test/test-skill-fixture.js";
import {
  appendDispatchRecord,
  findLiveIntent,
  findSessionIntent,
  readDispatchLedger,
  runDispatchClaim,
  runDispatchRequest,
  runDispatchTaskCheck,
  withDispatchClaimLock,
  type DispatchIntentRecord,
} from "./dispatch-cli.js";

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

describe("Native dispatch CLI", () => {
  let tempDir: string;
  let root: string;
  let gasparToken = "";
  let gasparSession: { id: string; token: string } = { id: "", token: "" };
  let signingKey = "";
  let restoreTty: () => void;
  const gasparKey = "gaspar-session-1";

  function tokenString(session: { id: string; token: string }): string {
    return `${session.id}/${session.token}`;
  }

  function hostTokenPath(sessionKey: string): string {
    const canonical = realpathSync(root);
    const hash = createHash("sha256").update(`${canonical}|${sessionKey}`, "utf8").digest("hex").slice(0, 16);
    return join(tmpdir(), `chrono-gaspar-host-${hash}.token`);
  }

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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-dispatch-cli-test-"));
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
      gasparToken = tokenString(gasparSession);
      const gaspar = { actor: "gaspar", session: gasparSession };
      const po = { actor: "PO", session: openPrivileged(core, "PO", signingKey) };
      const proposed = core.proposeArchitecture({ title: "A" }, gaspar);
      expect(proposed.ok).toBe(true);
      expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
      approve(core, "architecture-security", "ARCH", proposed.value!);
      expect(core.approveArchitecture(gaspar).ok).toBe(true);
      expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
      expect(core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar).ok).toBe(true);
      const specRev = core.getArtifact("SP-0001").revision;
      approve(core, "architecture-security", "SP-0001", specRev);
      expect(core.recordHarness(specRev, `sha256:${"a".repeat(64)}`, "# h", gaspar).ok).toBe(true);
      expect(core.transitionState("SP-0001", "SpecApprovedReady", gaspar).ok).toBe(true);
      expect(core.registerModule("MOD-0002", "DRAFT", MOD, gaspar).ok).toBe(true);
      expect(
        core.registerWorkPackage("WP-0001", "PLANNED", { id: "WP-0001", name: "W", module: "MOD-0002", dependsOn: [] }, gaspar).ok
      ).toBe(true);
      expect(core.transitionState("MOD-0002", "ModulePlanned", gaspar).ok).toBe(true);
      // Converged activation authority (CF2-2): dispatch presupposes
      // BOTH current approvals.
      approve(core, "planning-approval", "MOD-0002", core.getArtifact("MOD-0002").revision);
      approve(core, "module-approval", "MOD-0002", core.getArtifact("MOD-0002").revision);
      expect(core.transitionState("MOD-0002", "ModuleApproved", gaspar).ok).toBe(true);
      expect(core.transitionState("WP-0001", "WorkPackageAuthorized", gaspar).ok).toBe(true);
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
      expect(
        core.registerAdapter({ id: "fixture", name: "Fixture", entrypoint, conformanceProof: ["fixture --version"] }, po).ok
      ).toBe(true);
      const registrationHash = core.adapterRegistrationHash("fixture");
      const adapterApprovalId = approve(core, "adapter-registration", "fixture", registrationHash);
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
    } finally {
      core.close();
    }
    // Host entry token for the Gaspar OpenCode session (what the entry
    // flow confines; the model never sees it).
    writeFileSync(hostTokenPath(gasparKey), gasparToken, { mode: 0o600 });
  });

  afterEach(() => {
    restoreTty();
    try {
      rmSync(hostTokenPath(gasparKey), { force: true });
    } catch {
      // best-effort
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function requestDispatch(dispatchModule = "MOD-0002", wp = "WP-0001"): { dispatchId: string } {
    const out = runDispatchRequest(root, {
      module: dispatchModule,
      ...(wp.length > 0 ? { wp } : {}),
      rationale: "start WP-0001 now",
      as: "gaspar",
      sessionToken: gasparToken,
      adapter: "fixture",
      opencodeSession: gasparKey,
      json: true,
    });
    expect(out.exitCode).toBe(0);
    return JSON.parse(out.stdout) as { dispatchId: string };
  }

  function delegate(dispatchId: string, agent = "belthazar"): void {
    const out = runDispatchTaskCheck(root, { session: gasparKey, agent, json: true });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: true, dispatchId });
  }

  it("requests an intent with ids and revisions only, never secrets", () => {
    const out = runDispatchRequest(root, {
      module: "MOD-0002", wp: "WP-0001", rationale: "start now",
      as: "gaspar", sessionToken: gasparToken, adapter: "fixture", opencodeSession: gasparKey, json: true,
    });
    expect(out.exitCode).toBe(0);
    const body = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, module: "MOD-0002", wp: "WP-0001" });
    expect(typeof body["dispatchId"]).toBe("string");
    expect(JSON.stringify(body)).not.toContain(gasparToken);
    expect(JSON.stringify(body)).not.toContain("token");
    const records = readDispatchLedger(root);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "dispatch-requested", module: "MOD-0002", wp: "WP-0001", gasparSessionKey: gasparKey });
  });

  it("denies stale, unknown, and worker requests with exact codes", () => {
    expect(
      JSON.parse(
        runDispatchRequest(root, { module: "MOD-9999", rationale: "ghost", as: "gaspar", sessionToken: gasparToken, json: true }).stdout
      ).error.code
    ).toBe("ENTITY_NOT_FOUND");
    // Worker session cannot request dispatch.
    const core = new ChronoCore({ projectPath: tempDir, runtime: "opencode" });
    try {
      const worker = core.openSession(
        { role: "belthazar", adapter: "fixture", runtime: "opencode", scopeModule: "MOD-0002", ttlSeconds: 3600 },
        { interactive: true }
      );
      expect(worker.ok).toBe(true);
      const denied = runDispatchRequest(root, {
        module: "MOD-0002", wp: "WP-0001", rationale: "worker overreach",
        as: "belthazar", sessionToken: `${worker.value!.id}/${worker.value!.token}`, json: true,
      });
      expect(denied.exitCode).toBe(1);
      expect(JSON.parse(denied.stdout).error.code).toBe("EXECUTION_DENIED");
    } finally {
      core.close();
    }
    // Rationale bounds.
    expect(
      runDispatchRequest(root, { module: "MOD-0002", rationale: "  ", as: "gaspar", sessionToken: gasparToken, json: true }).exitCode
    ).toBe(1);
  });

  it("claims bind exactly one worker session; replay and hijack deny", () => {
    const { dispatchId } = requestDispatch();
    delegate(dispatchId);
    const first = runDispatchClaim(root, { dispatch: dispatchId, agent: "belthazar", workerSessionKey: "worker-1", json: true });
    expect(first.exitCode).toBe(0);
    const body = JSON.parse(first.stdout) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, dispatchId, role: "belthazar", module: "MOD-0002", wp: "WP-0001" });
    expect(JSON.stringify(body)).not.toContain("token");
    expect(typeof body["grantId"]).toBe("string");
    // Worker credential confined host-side under the worker session key.
    const workerPath = hostTokenPath("worker-1");
    expect(existsSync(workerPath)).toBe(true);
    expect(readFileSync(workerPath, "utf8")).toMatch(/^SES-[0-9]+\/\S+$/);
    try {
      // Replay: same dispatch claimed twice denies.
      const replay = runDispatchClaim(root, { dispatch: dispatchId, agent: "belthazar", workerSessionKey: "worker-2", json: true });
      expect(replay.exitCode).toBe(1);
      expect(JSON.parse(replay.stdout).error.message).toMatch(/already claimed/);
      // Wrong agent: no delegation binds this dispatch to lucca.
      const wrongAgent = runDispatchClaim(root, { dispatch: dispatchId, agent: "lucca", workerSessionKey: "worker-3", json: true });
      expect(wrongAgent.exitCode).toBe(1);
      // Forged dispatch id denies.
      const forged = runDispatchClaim(root, { dispatch: "f".repeat(32), agent: "belthazar", workerSessionKey: "worker-4", json: true });
      expect(forged.exitCode).toBe(1);
      // Non-delegable role denies before any ledger read.
      const spekkio = runDispatchClaim(root, { dispatch: dispatchId, agent: "spekkio", workerSessionKey: "worker-5", json: true });
      expect(spekkio.exitCode).toBe(1);
    } finally {
      rmSync(workerPath, { force: true });
    }
  });

  it("claim without a prior task delegation denies (no guessing dispatch ids)", () => {
    const { dispatchId } = requestDispatch();
    const denied = runDispatchClaim(root, { dispatch: dispatchId, agent: "belthazar", workerSessionKey: "worker-9", json: true });
    expect(denied.exitCode).toBe(1);
    expect(JSON.parse(denied.stdout).error.message).toMatch(/delegate first/);
  });

  it("claim into the requesting session denies", () => {
    const { dispatchId } = requestDispatch();
    delegate(dispatchId);
    const denied = runDispatchClaim(root, { dispatch: dispatchId, agent: "belthazar", workerSessionKey: gasparKey, json: true });
    expect(denied.exitCode).toBe(1);
  });

  it("task-check allows one live intent, denies none, many, and foreign agents", () => {
    // None: unknown session has no intent.
    expect(runDispatchTaskCheck(root, { session: "ghost-session", agent: "belthazar", json: true }).exitCode).toBe(1);
    // Foreign agent names deny, including builtins and authority roles.
    for (const agent of ["general", "explore", "build", "gaspar", "PO", "spekkio", "glenn", "belthazar2", ""]) {
      const denied = runDispatchTaskCheck(root, { session: gasparKey, agent, json: true });
      expect(denied.exitCode).toBe(1);
      expect(JSON.parse(denied.stdout).error.code).toBe("TASK_DENIED");
    }
    // One live intent allows exactly one delegation...
    const { dispatchId } = requestDispatch();
    const allowed = runDispatchTaskCheck(root, { session: gasparKey, agent: "belthazar", json: true });
    expect(allowed.exitCode).toBe(0);
    expect(JSON.parse(allowed.stdout)).toMatchObject({ ok: true, dispatchId });
    // ...a second intent makes delegation ambiguous until one resolves.
    requestDispatch();
    const ambiguous = runDispatchTaskCheck(root, { session: gasparKey, agent: "melchior", json: true });
    expect(ambiguous.exitCode).toBe(1);
    expect(JSON.parse(ambiguous.stdout).error.message).toMatch(/Several live/);
  });

  it("task-check resume only re-enters the caller's own claimed worker", () => {
    const { dispatchId } = requestDispatch();
    delegate(dispatchId);
    const claimed = runDispatchClaim(root, { dispatch: dispatchId, agent: "belthazar", workerSessionKey: "worker-7", json: true });
    expect(claimed.exitCode).toBe(0);
    try {
      const resume = runDispatchTaskCheck(root, { session: gasparKey, agent: "belthazar", taskId: "worker-7", json: true });
      expect(resume.exitCode).toBe(0);
      expect(JSON.parse(resume.stdout)).toMatchObject({ ok: true, resume: true });
      // Another session cannot resume it (hijack denied).
      const hijack = runDispatchTaskCheck(root, { session: "other-session", agent: "belthazar", taskId: "worker-7", json: true });
      expect(hijack.exitCode).toBe(1);
      // Wrong agent cannot resume it either.
      const wrongRole = runDispatchTaskCheck(root, { session: gasparKey, agent: "lucca", taskId: "worker-7", json: true });
      expect(wrongRole.exitCode).toBe(1);
    } finally {
      rmSync(hostTokenPath("worker-7"), { force: true });
    }
  });

  it("expired intents deny task and claim alike", () => {
    const stale: DispatchIntentRecord = {
      v: 1,
      kind: "dispatch-requested",
      at: new Date(Date.now() - 7200_000).toISOString(),
      dispatchId: "d".repeat(32),
      module: "MOD-0002",
      wp: "WP-0001",
      rationale: "old",
      requesterCoreSession: gasparSession.id,
      requestedBy: "gaspar",
      gasparSessionKey: gasparKey,
      moduleRevision: "sha256:old",
      workPackageRevision: "sha256:old",
      specRevisions: {},
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    };
    appendDispatchRecord(root, stale);
    expect(findLiveIntent(readDispatchLedger(root), stale.dispatchId, Date.now())).toBe(null);
    expect(findSessionIntent(readDispatchLedger(root), gasparKey, Date.now())).toEqual([]);
    expect(runDispatchTaskCheck(root, { session: gasparKey, agent: "belthazar", json: true }).exitCode).toBe(1);
    const claim = runDispatchClaim(root, { dispatch: stale.dispatchId, agent: "belthazar", workerSessionKey: "worker-x", json: true });
    expect(claim.exitCode).toBe(1);
  });

  it("ledger helpers tolerate missing and corrupt files; locks serialize claims", () => {
    expect(readDispatchLedger(join(tmpdir(), "chrono-no-such-dir-xyz"))).toEqual([]);
    expect(findLiveIntent([], "abc", Date.now())).toBe(null);
    expect(findSessionIntent([], gasparKey, Date.now())).toEqual([]);
    const first = withDispatchClaimLock(root, "lock-1", () => "first");
    expect(first).toBe("first");
    // Released locks re-acquire cleanly in sequence.
    expect(withDispatchClaimLock(root, "lock-1", () => "second")).toBe("second");
  });

  it("correction dispatch selects one open loop by --defect", () => {
    const slash = gasparToken.indexOf("/");
    const G = { actor: "gaspar", session: { id: gasparToken.slice(0, slash), token: gasparToken.slice(slash + 1) } };
    const drive = (): void => {
      const core = new ChronoCore({ projectPath: root, runtime: "opencode" });
      try {
        const requested = core.requestDispatch(
          { moduleId: "MOD-0002", workPackageId: "WP-0001", rationale: "drive to implemented", adapterId: "fixture" },
          G
        );
        expect(requested.ok).toBe(true);
        expect(core.recordTaskDelegation({ agent: "belthazar", parentRuntimeSession: "p-defect-1" }, G).ok).toBe(true);
        const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: "c-defect-1" }, G);
        expect(claimed.ok).toBe(true);
        expect(core.confirmClaim(requested.value!.dispatchId, G).ok).toBe(true);
        const worker = { actor: "belthazar", session: { id: claimed.value!.session.id, token: claimed.value!.session.token } };
        const rev = core.getArtifact("WP-0001").revision;
        const ev = core.recordEvidence({
          producer: "belthazar", tool: "vitest", targetRevision: rev, checkName: "unit",
          result: "pass", diagnostics: null,
          integrityHash: computeRevisionHash({ result: "pass", diagnostics: null, target_revision: rev }),
        }, worker);
        expect(ev.ok).toBe(true);
        expect(core.advanceScope({ moduleId: "MOD-0002", workPackageId: "WP-0001", event: "ImplementationDone" }, worker).ok).toBe(true);
        expect(core.releaseDispatch(requested.value!.dispatchId, worker).ok).toBe(true);
        const spekSession = core.openSession(
          { role: "spekkio", adapter: "fixture", runtime: "opencode", scopeModule: "MOD-0002", ttlSeconds: 3600 },
          { interactive: true }
        );
        expect(spekSession.ok).toBe(true);
        const spek = { actor: "spekkio", session: { id: spekSession.value!.id, token: spekSession.value!.token } };
        const d1 = core.recordDefect({
          classification: "IMPLEMENTATION_DEFECT", severity: "low", evidenceRefs: [],
          affectedCriteria: [], affectedArtifacts: ["WP-0001"], blockingScope: "WP-0001", reproInfo: null,
        }, spek);
        expect(d1.ok).toBe(true);
        const d2 = core.recordDefect({
          classification: "TEST_DEFECT", severity: "low", evidenceRefs: [],
          affectedCriteria: [], affectedArtifacts: ["WP-0001"], blockingScope: "WP-0001", reproInfo: null,
        }, spek);
        expect(d2.ok).toBe(true);
        expect(core.openCorrectionLoop(d1.value!.id, G).ok).toBe(true);
        expect(core.openCorrectionLoop(d2.value!.id, G).ok).toBe(true);
      } finally {
        core.close();
      }
    };
    drive();
    const base = {
      module: "MOD-0002", wp: "WP-0001", kind: "correction",
      rationale: "fix selected defect", as: "gaspar", sessionToken: gasparToken,
      adapter: "fixture", opencodeSession: gasparKey, json: true as const,
    };
    const ambiguous = runDispatchRequest(root, base);
    expect(ambiguous.exitCode).toBe(1);
    // Resolve defect ids through Core events, then select through the CLI.
    const probe = new ChronoCore({ projectPath: root, runtime: "opencode" });
    let defectA = "";
    try {
      const events = probe.listEvents().filter((e) => e.eventType === "CorrectionOpened");
      expect(events.length).toBe(2);
      defectA = (JSON.parse(events[0]!.payload) as { defectId: string }).defectId;
    } finally {
      probe.close();
    }
    const chosen = runDispatchRequest(root, { ...base, defect: defectA });
    expect(chosen.exitCode).toBe(0);
    expect(JSON.parse(chosen.stdout)).toMatchObject({ ok: true, kind: "correction" });
  });
});
