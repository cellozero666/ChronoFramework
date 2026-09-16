/**
 * Minimal OpenCode advance integration (WORKFLOW-STABILIZATION):
 * `chrono advance` CLI plus the `chrono_advance` native tool.
 *
 * Focused coverage only — no lifecycle simulator, no new workflow
 * architecture:
 *
 * - the CLI returns each structured WorkflowDecision type as JSON
 *   without exposing credentials;
 * - the exact generated `advance` tool calls `chrono advance`
 *   through the host-held Gaspar session (executed for real);
 * - Gaspar's contract routes the normal workflow exclusively through
 *   `chrono_advance` (structured `decision.type` switching, never
 *   parsed prose, never PO-operated internals);
 * - `chrono_advance` is classified by the canonical policy (v9) and
 *   passes the real pre-tool gate; unknown tools stay denied;
 * - garbled prose never deflects a structured result.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  OPENCODE_TOOL_POLICY,
  TOOL_POLICY_VERSION,
  buildApprovalPayload,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildPolicyPayload,
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
  buildRuntimeFingerprint,
  classifyOpencodeTool,
} from "@chrono/domain";
import { ChronoCore } from "@chrono/core";
import { FIXTURE_SKILL_MD } from "../test/test-skill-fixture.js";
import { runAdvance } from "./lifecycle-cli.js";
import {
  CHRONO_NATIVE_TOOLS,
  OPENCODE_TOOLS_FILE_RELATIVE,
  OPENCODE_TOOLS_PACKAGE_RELATIVE,
  buildPlanningToolsFile,
  buildPlanningToolsPackage,
} from "./opencode-planning-tools.js";
import { buildOpenCodeAgentDefinition } from "./opencode-agent.js";
import { buildOpencodePlugin } from "./opencode-plugin.js";
import type { CliOutput } from "./dispatch-cli.js";

const REPO_ROOT = realpathSync(join(__dirname, "..", "..", ".."));
const SPEC = { id: "SP-0001", title: "T", purpose: "P", inScope: ["a"], acceptanceCriteria: ["ac1"] };
const MOD_BODY = { id: "MOD-0001", name: "M", purpose: "P", specs: ["SP-0001"] };
const FIXTURE_TIME = "2026-09-14T00:00:00.000Z";

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

type Session = { id: string; token: string };
type Caller = { actor: string; session: Session };

function hostedToken(root: string, sessionKey: string): string {
  const canonical = realpathSync(root);
  const hash = createHash("sha256").update(`${canonical}|${sessionKey}`, "utf8").digest("hex").slice(0, 16);
  return join(tmpdir(), `chrono-gaspar-host-${hash}.token`);
}

describe("chrono advance CLI (structured WorkflowDecision as JSON)", () => {
  let tempDir: string;
  let core: ChronoCore;
  let signingKey = "";
  let gasparSession: Session = { id: "", token: "" };
  let gasparToken = "";
  let restoreTty: () => void;

  function auth(): { as: string; sessionToken: string; json: true } {
    return { as: "gaspar", sessionToken: gasparToken, json: true };
  }

  function gaspar(): Caller {
    return { actor: "gaspar", session: gasparSession };
  }

  function openPrivileged(role: "gaspar" | "PO", key: string): Session {
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

  function approve(action: string, scopeId: string, scopeRev: string): string {
    const signature = signApprovalPayload(
      buildApprovalPayload({
        action, scopeArtifactId: scopeId, scopeRevision: scopeRev,
        authority: "PO", rationale: "test approval", timestamp: FIXTURE_TIME,
      }),
      signingKey
    );
    const res = core.recordApproval({
      action, scopeArtifactId: scopeId, scopeRevision: scopeRev,
      authority: "PO", rationale: "test approval", timestamp: FIXTURE_TIME, signature,
    });
    expect(res.ok).toBe(true);
    return res.value!.id;
  }

  function recordEvidenceAs(caller: Caller, targetRevision: string, checkName: string): string {
    const res = core.recordEvidence({
      producer: caller.actor,
      tool: "vitest",
      targetRevision,
      checkName,
      result: "pass",
      diagnostics: null,
      integrityHash: computeRevisionHash({ result: "pass", diagnostics: null, target_revision: targetRevision }),
    }, caller);
    expect(res.ok).toBe(true);
    return res.value!.id;
  }

  let bindSeq = 0;
  function bindWorker(role: string, kind: string, moduleId: string, workPackageId?: string): { auth: Caller; dispatchId: string } {
    bindSeq += 1;
    const requested = core.requestDispatch(
      { moduleId, ...(workPackageId !== undefined ? { workPackageId } : {}), kind, rationale: `advance binding for ${role}`, adapterId: "fixture" },
      gaspar()
    );
    expect(requested.ok).toBe(true);
    expect(core.recordTaskDelegation({ agent: role, parentRuntimeSession: `adv-parent-${bindSeq}` }, gaspar()).ok).toBe(true);
    const claimed = core.claimDispatch({ dispatchId: requested.value!.dispatchId, childRuntimeSession: `adv-child-${bindSeq}` }, gaspar());
    expect(claimed.ok).toBe(true);
    expect(core.confirmClaim(requested.value!.dispatchId, gaspar()).ok).toBe(true);
    return {
      auth: { actor: role, session: { id: claimed.value!.session.id, token: claimed.value!.session.token } },
      dispatchId: requested.value!.dispatchId,
    };
  }

  /** Parsed JSON body plus a credential-leak sweep over every surface. */
  function cleanDecision(out: CliOutput): { type: string; [key: string]: unknown } {
    expect(out.exitCode).toBe(0);
    const body = JSON.parse(out.stdout) as { ok: boolean; decision: { type: string; [key: string]: unknown } };
    expect(body.ok).toBe(true);
    // No credential material anywhere the model could read: the bearer
    // secret, key files, and credential envelopes stay host-side.
    expect(out.stdout).not.toContain(gasparSession.token);
    expect(out.stderr).not.toContain(gasparSession.token);
    expect(out.stdout).not.toContain("CHRONO_SESSION_TOKEN");
    expect(out.stdout).not.toContain("PRIVATE KEY");
    expect(out.stdout).not.toContain("bearer");
    const keys = JSON.stringify(body);
    expect(keys).not.toContain(gasparSession.token);
    expect(body.decision.type.length).toBeGreaterThan(0);
    return body.decision;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-advance-cli-"));
    core = new ChronoCore({ projectPath: tempDir, runtime: "opencode" });
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
    gasparSession = openPrivileged("gaspar", signingKey);
    gasparToken = `${gasparSession.id}/${gasparSession.token}`;
    const proposed = core.proposeArchitecture({ title: "A" }, gaspar());
    expect(proposed.ok).toBe(true);
    expect(core.submitArchitectureForReview(gaspar()).ok).toBe(true);
    approve("architecture-security", "ARCH", proposed.value!);
    expect(core.approveArchitecture(gaspar()).ok).toBe(true);
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar()).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar()).ok).toBe(true);
    const specRev = core.getArtifact("SP-0001").revision;
    approve("architecture-security", "SP-0001", specRev);
    expect(core.recordHarness(specRev, `sha256:${"a".repeat(64)}`, "# h", gaspar()).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecApprovedReady", gaspar()).ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD_BODY, gaspar()).ok).toBe(true);
    expect(core.transitionState("MOD-0001", "ModulePlanned", gaspar()).ok).toBe(true);
    expect(
      core.registerWorkPackage("WP-0001", "PLANNED", { id: "WP-0001", name: "W", module: "MOD-0001", dependsOn: [] }, gaspar()).ok
    ).toBe(true);
    expect(core.recordSecurityProfile({ title: "P", threats: [] }, gaspar()).ok).toBe(true);
    const rtkBin = join(tempDir, "fixture-rtk.sh");
    writeFileSync(rtkBin, "#!/bin/sh\necho fixture-rtk 1.0.0-test\n", "utf8");
    chmodSync(rtkBin, 0o755);
    expect(
      core.recordRtkAttestation(gaspar(), {
        binaryPath: rtkBin, binaryIdentity: "rtk-test", version: "1.0.0-test",
        provenance: RTK_UPSTREAM, integrationMode: "test", routingTestPassed: true,
        routingTestLog: "fixture", gained: true, savingsEvidence: null, ttlSeconds: 86400,
      }).ok
    ).toBe(true);
    expect(
      core.recordSkillAttestation(gaspar(), {
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
    const po: Caller = { actor: "PO", session: openPrivileged("PO", signingKey) };
    expect(core.registerAdapter({ id: "fixture", name: "Fixture", entrypoint, conformanceProof: ["fixture --version"] }, po).ok).toBe(true);
    const registrationHash = core.adapterRegistrationHash("fixture");
    const adapterApprovalId = approve("adapter-registration", "fixture", registrationHash);
    expect(core.approveAdapter("fixture", adapterApprovalId, po).ok).toBe(true);
    const recordedProof = core.recordRoutingProof(gaspar(), {
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

  it("returns PO_DECISION_REQUIRED with the exact ceremony fields", () => {
    // Fresh DRAFT module: no approvals exist, so the engine stops at
    // the planning-approval ceremony without consuming anything.
    const decision = cleanDecision(runAdvance(tempDir, { ...auth(), module: "MOD-0001" }));
    expect(decision.type).toBe("PO_DECISION_REQUIRED");
    expect(decision["action"]).toBe("planning-approval");
    expect(decision["scopeId"]).toBe("MOD-0001");
    expect(decision["revision"]).toBe(core.getArtifact("MOD-0001").revision);
  });

  it("returns AGENT_WORK_REQUIRED after approvals (mechanical prefix consumed)", () => {
    const modRev = core.getArtifact("MOD-0001").revision;
    approve("planning-approval", "MOD-0001", modRev);
    approve("module-approval", "MOD-0001", modRev);
    const out = runAdvance(tempDir, { ...auth(), module: "MOD-0001" });
    const decision = cleanDecision(out);
    expect(decision.type).toBe("AGENT_WORK_REQUIRED");
    expect(decision["phase"]).toBe("request");
    expect(decision["kind"]).toBe("implementation");
    expect(decision["workPackageId"]).toBe("WP-0001");
    expect(decision["role"]).toBeTruthy();
    expect(decision["dispatchId"]).toBe(null);
  });

  it("returns INDEPENDENT_REVIEW_REQUIRED naming the assigned review", () => {
    const modRev = core.getArtifact("MOD-0001").revision;
    approve("planning-approval", "MOD-0001", modRev);
    approve("module-approval", "MOD-0001", modRev);
    expect(core.transitionState("MOD-0001", "ModuleApproved", gaspar()).ok).toBe(true);
    expect(core.transitionState("WP-0001", "WorkPackageAuthorized", gaspar()).ok).toBe(true);
    const impl = bindWorker("belthazar", "implementation", "MOD-0001", "WP-0001");
    const wpRev = core.getArtifact("WP-0001").revision;
    recordEvidenceAs(impl.auth, wpRev, "unit-impl");
    expect(core.advanceScope({ moduleId: "MOD-0001", workPackageId: "WP-0001", event: "ImplementationDone" }, impl.auth).ok).toBe(true);
    expect(core.advanceScope({ moduleId: "MOD-0001", workPackageId: "WP-0001", event: "VerificationReady" }, impl.auth).ok).toBe(true);
    expect(core.releaseDispatch(impl.dispatchId, impl.auth).ok).toBe(true);
    const assigned = core.assignReview({ kind: "verification", moduleId: "MOD-0001", workPackageId: "WP-0001" }, gaspar());
    expect(assigned.ok).toBe(true);
    const decision = cleanDecision(runAdvance(tempDir, { ...auth(), wp: "WP-0001" }));
    expect(decision.type).toBe("INDEPENDENT_REVIEW_REQUIRED");
    expect(decision["role"]).toBe("spekkio");
    expect(decision["kind"]).toBe("verification");
    expect(decision["reviewId"]).toBe(assigned.value!.reviewId);
    expect(decision["targetRevision"]).toBe(wpRev);
  });

  it("returns BLOCKED while a product blocker holds the scope", () => {
    // Approvals first so the blocker — not a missing ceremony — is
    // the hold: the authorized package then reports its blocker.
    const modRev = core.getArtifact("MOD-0001").revision;
    approve("planning-approval", "MOD-0001", modRev);
    approve("module-approval", "MOD-0001", modRev);
    expect(core.transitionState("MOD-0001", "ModuleApproved", gaspar()).ok).toBe(true);
    expect(core.transitionState("WP-0001", "WorkPackageAuthorized", gaspar()).ok).toBe(true);
    expect(core.raiseBlocker("PRODUCT_BLOCKER", ["WP-0001"], "waiting on vendor", gaspar()).ok).toBe(true);
    const decision = cleanDecision(runAdvance(tempDir, { ...auth(), wp: "WP-0001" }));
    expect(decision.type).toBe("BLOCKED");
    expect(String(decision["reason"] ?? "").length).toBeGreaterThan(0);
  });

  it("returns COMPLETE after the verified walk (lean profile)", () => {
    const po: Caller = { actor: "PO", session: openPrivileged("PO", signingKey) };
    const leanTimestamp = new Date().toISOString();
    const leanSignature = signApprovalPayload(
      buildPolicyPayload({ profile: "lean", rationale: "advance integration", timestamp: leanTimestamp }),
      signingKey
    );
    expect(core.setPolicyProfile(
      { profile: "lean", rationale: "advance integration", signature: leanSignature, timestamp: leanTimestamp },
      po
    ).ok).toBe(true);
    const modRev = core.getArtifact("MOD-0001").revision;
    approve("planning-approval", "MOD-0001", modRev);
    approve("module-approval", "MOD-0001", modRev);
    expect(core.transitionState("MOD-0001", "ModuleApproved", gaspar()).ok).toBe(true);
    expect(core.transitionState("WP-0001", "WorkPackageAuthorized", gaspar()).ok).toBe(true);
    const impl = bindWorker("belthazar", "implementation", "MOD-0001", "WP-0001");
    const wpRev = core.getArtifact("WP-0001").revision;
    recordEvidenceAs(impl.auth, wpRev, "unit-impl");
    expect(core.advanceScope({ moduleId: "MOD-0001", workPackageId: "WP-0001", event: "ImplementationDone" }, impl.auth).ok).toBe(true);
    expect(core.advanceScope({ moduleId: "MOD-0001", workPackageId: "WP-0001", event: "VerificationReady" }, impl.auth).ok).toBe(true);
    expect(core.releaseDispatch(impl.dispatchId, impl.auth).ok).toBe(true);
    const assigned = core.assignReview({ kind: "verification", moduleId: "MOD-0001", workPackageId: "WP-0001" }, gaspar());
    expect(assigned.ok).toBe(true);
    const spek = bindWorker("spekkio", "verification", "MOD-0001", "WP-0001");
    expect(core.recordVerification("MOD-0001", "PASS", "spekkio", [], [], [], spek.auth, "WP-0001").ok).toBe(true);
    expect(core.completeReview({ reviewId: assigned.value!.reviewId }, spek.auth).ok).toBe(true);
    expect(core.advanceScope({ moduleId: "MOD-0001", workPackageId: "WP-0001", event: "SpekkioPassed" }, spek.auth).ok).toBe(true);
    expect(core.releaseDispatch(spek.dispatchId, spek.auth).ok).toBe(true);
    approve("implementation-security", "MOD-0001", core.getArtifact("MOD-0001").revision);
    expect(core.completeModule("MOD-0001", gaspar()).ok).toBe(true);
    const decision = cleanDecision(runAdvance(tempDir, { ...auth(), module: "MOD-0001" }));
    expect(decision.type).toBe("COMPLETE");
    expect(decision["moduleId"]).toBe("MOD-0001");
  });

  it("garbled prose never deflects the structured result", () => {
    // The parsed copy's rationale is overwritten with garbage holding
    // decoy ids; the flow continues on action/scope/revision only.
    const out = runAdvance(tempDir, { ...auth(), module: "MOD-0001" });
    const first = cleanDecision(out);
    expect(first.type).toBe("PO_DECISION_REQUIRED");
    const garbled = JSON.parse(JSON.stringify(first)) as Record<string, unknown>;
    garbled["rationale"] = "GARBAGE MOD-9999 WP-9999 DSP-9999 REV-9999 COR-9999";
    garbled["reason"] = "GARBAGE";
    approve(String(first["action"]), String(first["scopeId"]), String(first["revision"]));
    const second = cleanDecision(runAdvance(tempDir, { ...auth(), module: "MOD-0001" }));
    // Structured progress despite the garbled copy: the next ceremony
    // names module-approval (planning-approval now stands).
    expect(second.type).toBe("PO_DECISION_REQUIRED");
    expect(second["action"]).toBe("module-approval");
    expect(String(garbled["rationale"])).toContain("MOD-9999");
  });

  it("denies without credentials and answers human output without secrets", () => {
    const denied = runAdvance(tempDir, { as: "gaspar", module: "MOD-0001", json: true });
    expect(denied.exitCode).toBe(1);
    const human = runAdvance(tempDir, { as: "gaspar", sessionToken: gasparToken, module: "MOD-0001" });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("decision: PO_DECISION_REQUIRED");
    expect(human.stdout).not.toContain(gasparSession.token);
    expect(human.stderr).not.toContain(gasparSession.token);
  });
});

describe("chrono_advance native tool (generated bytes, executed for real)", () => {
  let tempDir: string;
  let root: string;
  let core: ChronoCore;
  let signingKey = "";
  let gasparSession: Session = { id: "", token: "" };
  let restoreTty: () => void;
  let savedEnv: Record<string, string | undefined>;
  const openSessionId = "adv-native-1";
  let tools: Record<string, { description: string; args: unknown; execute: (args: unknown, ctx: unknown) => Promise<string> }>;

  function tokenPath(): string {
    return hostedToken(root, openSessionId);
  }

  function toolContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sessionID: openSessionId,
      messageID: "m1",
      agent: "gaspar",
      directory: root,
      worktree: root,
      abort: new AbortController().signal,
      ...overrides,
    };
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-advance-native-"));
    root = realpathSync(tempDir);
    const fixtureModules = join(root, "node_modules");
    mkdirSync(join(fixtureModules, "@opencode-ai"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "node_modules", "@opencode-ai", "plugin"), join(fixtureModules, "@opencode-ai", "plugin"), "dir");
    symlinkSync(join(REPO_ROOT, "node_modules", "zod"), join(fixtureModules, "zod"), "dir");
    mkdirSync(join(root, ".opencode", "tools"), { recursive: true });
    writeFileSync(join(root, OPENCODE_TOOLS_FILE_RELATIVE), buildPlanningToolsFile(), "utf8");
    writeFileSync(join(root, OPENCODE_TOOLS_PACKAGE_RELATIVE), buildPlanningToolsPackage(), "utf8");
    tools = (await import(pathToFileURL(join(root, OPENCODE_TOOLS_FILE_RELATIVE)).href)) as Record<string, { description: string; args: unknown; execute: (args: unknown, ctx: unknown) => Promise<string> }>;
    savedEnv = { ...process.env };
    for (const key of ["CHRONO_BIN", "CHRONO_OPENCODE_BIN", "CHRONO_SESSION_TOKEN"]) {
      delete process.env[key];
    }
    const shim = join(root, "chrono-shim.sh");
    writeFileSync(shim, `#!/bin/sh\nexec node ${join(REPO_ROOT, "packages", "cli", "dist", "bin.js")} "$@"\n`, "utf8");
    chmodSync(shim, 0o755);
    process.env["CHRONO_BIN"] = shim;
    core = new ChronoCore({ projectPath: root, runtime: "opencode" });
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
    void signingKey;
    const sessionNonce = randomBytes(16).toString("hex");
    const sessionTimestamp = "2026-09-11T00:00:00.000Z";
    const sessionSig = signApprovalPayload(
      buildSessionAuthorizationPayload({
        sessionRole: "gaspar", adapter: "test-adapter", runtime: "opencode",
        scopeModule: null, scopeWp: null, ttlSeconds: 3600, nonce: sessionNonce,
        authority: "PO", rationale: "test", timestamp: sessionTimestamp,
      }),
      pair.privateKeyPem
    );
    const opened = core.openSession(
      { role: "gaspar", adapter: "test-adapter", runtime: "opencode", ttlSeconds: 3600 },
      { poAuthorization: { nonce: sessionNonce, authority: "PO", rationale: "test", timestamp: sessionTimestamp, signature: sessionSig } }
    );
    expect(opened.ok).toBe(true);
    gasparSession = { id: opened.value!.id, token: opened.value!.token };
    writeFileSync(tokenPath(), `${gasparSession.id}/${gasparSession.token}`, { mode: 0o600 });
    const gaspar: Caller = { actor: "gaspar", session: gasparSession };
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", { id: "MOD-0001", name: "M", purpose: "P", specs: ["SP-0001"] }, gaspar).ok).toBe(true);
  });

  afterEach(() => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    for (const key of ["CHRONO_BIN", "CHRONO_OPENCODE_BIN", "CHRONO_SESSION_TOKEN"]) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    try {
      rmSync(tokenPath(), { force: true });
    } catch {
      // best-effort
    }
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("is generated with the advance export wired to the CLI", () => {
    expect(CHRONO_NATIVE_TOOLS).toContain("chrono_advance");
    const bytes = buildPlanningToolsFile();
    expect(bytes).toContain("export const advance = tool({");
    // Host-held session only: the tool resolves the project, reads the
    // entry credential host-side, and invokes the advance command —
    // the bearer value never appears in arguments or results.
    expect(bytes).toContain('"advance"');
    expect(bytes).toContain("hostToken(root, context.sessionID)");
  });

  it("executes for real: structured decision, no credential leakage", async () => {
    const def = tools["advance"]!;
    expect(def).toBeTruthy();
    expect(def.description.length).toBeGreaterThan(20);
    const out = await def.execute({ module: "MOD-0001" }, toolContext());
    const parsed = JSON.parse(out) as { ok: boolean; decision: { type: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.decision.type).toBe("PO_DECISION_REQUIRED");
    expect(out).not.toContain(gasparSession.token);
    expect(JSON.stringify(parsed)).not.toContain(gasparSession.token);
  });

  it("denies an unproven session without reaching the Core", async () => {
    const def = tools["advance"]!;
    await expect(def.execute({ module: "MOD-0001" }, toolContext({ sessionID: "no-such-session" }))).rejects.toThrow(/no Gaspar entry session/);
  });
});

describe("Gaspar advance contract (normal workflow routing)", () => {
  it("routes the normal workflow exclusively through chrono_advance", () => {
    const gaspar = buildOpenCodeAgentDefinition("gaspar");
    // The driver section exists and names the tool plus the five-way switch.
    expect(gaspar).toContain("chrono_advance");
    expect(gaspar).toContain("decision.type");
    for (const boundary of ["PO_DECISION_REQUIRED", "AGENT_WORK_REQUIRED", "INDEPENDENT_REVIEW_REQUIRED", "BLOCKED", "COMPLETE"] as const) {
      expect(gaspar, `driver never names '${boundary}'`).toContain(boundary);
    }
    // Permission surface: the driver is allowed for Gaspar.
    expect(gaspar).toContain("chrono_advance: allow");
    // Prose is never parsed: every human-readable field is named only
    // inside the never-parse prohibition.
    expect(gaspar).toContain("NEVER parse");
    for (const field of ["summary", "reason", "objective", "rationale"] as const) {
      expect(gaspar, `driver never constrains '${field}'`).toContain(field);
    }
    // The Product Owner never operates CHRONO internals (instruction
    // lines wrap, so match across whitespace).
    expect(gaspar).toMatch(/NEVER ask the Product Owner to execute CHRONO\s+commands/);
    expect(gaspar).not.toContain("CHRONO_SESSION_TOKEN");
    expect(gaspar).not.toContain("ask the PO to run");
  });

  it("keeps every legacy lifecycle tool for compatibility", () => {
    // Compatibility surface intact: the emitted list still carries the
    // full legacy set even though the normal path no longer calls it.
    for (const tool of ["chrono_next", "chrono_module_activate", "chrono_wp_authorize", "chrono_dispatch", "chrono_module_complete"] as const) {
      expect(CHRONO_NATIVE_TOOLS).toContain(tool);
    }
  });
});

describe("advance policy surface (canonical v9)", () => {
  function validPayload(sessionId = "SES-0001"): string {
    return JSON.stringify({
      ok: true,
      sessionId,
      projection: {
        projectState: "ANALYZING",
        nextAction: { key: "resume-discovery", summary: "Resume discovery" },
        requiredDecisions: [],
      },
      skill: { installed: true },
    });
  }

  it("classifies chrono_advance as a planning tool under policy v9", () => {
    expect(TOOL_POLICY_VERSION).toBe("9");
    expect(classifyOpencodeTool("chrono_advance")).toBe("planning");
    expect(OPENCODE_TOOL_POLICY["chrono_advance"]).toBe("planning");
    // The generation identity moves with the tool addition.
    const without = { ...OPENCODE_TOOL_POLICY };
    delete without["chrono_advance"];
    expect(buildRuntimeFingerprint(without)).not.toBe(buildRuntimeFingerprint());
  });

  it("passes chrono_advance and denies unknown tools through the real gate", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "chrono-advance-gate-"));
    try {
      mkdirSync(join(tempDir, ".chrono", "hooks"), { recursive: true });
      writeFileSync(join(tempDir, ".chrono", "chrono.db"), "", "utf8");
      const pluginPath = join(tempDir, "chrono-gate.js");
      writeFileSync(pluginPath, buildOpencodePlugin(), "utf8");
      writeFileSync(join(tempDir, ".chrono", "hooks", "chrono-entry-session.sh"), `#!/bin/sh\necho '${validPayload()}'\n`, "utf8");
      chmodSync(join(tempDir, ".chrono", "hooks", "chrono-entry-session.sh"), 0o755);
      const module = (await import(pathToFileURL(pluginPath).href)) as {
        ChronoGatePlugin: (ctx: unknown) => Promise<{
          "tool.execute.before": (input: unknown, output?: unknown) => Promise<unknown>;
          "chat.message": (input: unknown) => Promise<unknown>;
        }>;
      };
      const hooks = await module.ChronoGatePlugin({ directory: tempDir });
      await hooks["chat.message"]({ sessionID: "adv-gate-1" });
      await expect(
        hooks["tool.execute.before"]({ tool: "chrono_advance", sessionID: "adv-gate-1", callID: "call-adv" }, { args: {} })
      ).resolves.toBeUndefined();
      await expect(
        hooks["tool.execute.before"]({ tool: "chrono_advance_next", sessionID: "adv-gate-1", callID: "call-adv" }, { args: {} })
      ).rejects.toThrow(/TOOL_DENIED/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
