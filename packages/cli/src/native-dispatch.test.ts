/**
 * Native governed dispatch end-to-end (post-planning deadlock repair).
 *
 * Drives REAL generated plugin bytes, REAL native tool executes, the
 * REAL built CLI, a REAL Core project, and the real filesystem, with
 * the EXACT OpenCode 1.18.30 shapes (task tool args, child sessions
 * with parentID/agent). Fixtures cover only the model (tool
 * arguments), the runtime (child session delivery), the OS keychain
 * (PATH-injected `security`), and the entry token file.
 *
 * Proves: approved planning → Gaspar native dispatch → bound task
 * delegation → authorized worker agent → mutable tools available
 * only inside the bound WP → Gaspar remains unable to implement →
 * no shell/token/grant instructions shown to the PO.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  buildApprovalPayload,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  computeRevisionHash,
  convertSkillSource,
  DISPATCH_KIND_ROLES,
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
import { buildOpencodePlugin } from "./opencode-plugin.js";
import { buildOpenCodeAgentDefinition } from "./opencode-agent.js";
import { buildPlanningToolsFile, CHRONO_NATIVE_TOOLS } from "./opencode-planning-tools.js";
import { runGate } from "./index.js";
import { FIXTURE_SKILL_MD } from "../test/test-skill-fixture.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SPEC = { id: "SP-0001", title: "T", purpose: "P", inScope: ["a"], acceptanceCriteria: ["ac1"] };
const MOD = { id: "MOD-0002", name: "M", purpose: "P", specs: ["SP-0001"] };

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

describe("Native governed dispatch", () => {
  let tempDir: string;
  let root: string;
  let pluginPath: string;
  let core: ChronoCore;
  let signingKey = "";
  let gasparToken = "";
  let gasparSession: { id: string; token: string } = { id: "", token: "" };
  let restoreTty: () => void;
  let savedEnv: Record<string, string | undefined>;
  const sessionKey = "gaspar-dispatch-1";
  // Worker OpenCode sessions claimed during a test (token files are
  // 0600 tmp files keyed by session; remove them on teardown).
  let workerKeys: string[];
  let tools: Record<string, unknown>;

  function tokenString(session: { id: string; token: string }): string {
    return `${session.id}/${session.token}`;
  }

  function hostTokenPath(key: string): string {
    return join(tmpdir(), `chrono-gaspar-host-${createHash("sha256").update(`${root}|${key}`, "utf8").digest("hex").slice(0, 16)}.token`);
  }

  function toolContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sessionID: sessionKey,
      messageID: "m1",
      agent: "gaspar",
      directory: root,
      worktree: root,
      abort: new AbortController().signal,
      metadata: () => undefined,
      ...overrides,
    };
  }

  async function hooksFor(directory: string) {
    const module = (await import(pathToFileURL(pluginPath).href)) as {
      ChronoGatePlugin: (ctx: unknown) => Promise<{
        event: (input: unknown) => Promise<unknown>;
        "chat.message": (input: unknown) => Promise<unknown>;
        "experimental.chat.system.transform": (input: unknown, output: unknown) => Promise<unknown>;
        "tool.execute.before": (input: unknown, output: unknown) => Promise<unknown>;
        "tool.execute.after": (input: unknown, output: unknown) => Promise<unknown>;
      }>;
    };
    const hooks = await module.ChronoGatePlugin({ directory });
    return {
      event: hooks.event,
      message: hooks["chat.message"],
      transform: hooks["experimental.chat.system.transform"],
      before: hooks["tool.execute.before"],
      after: hooks["tool.execute.after"],
    };
  }

  function childCreatedEvent(childId: string, parentId: string, agent: string | null): unknown {
    return {
      event: {
        type: "session.created",
        properties: {
          sessionID: childId,
          info: {
            id: childId,
            parentID: parentId,
            ...(agent === null ? {} : { agent }),
          },
        },
      },
    };
  }

  function taskBefore(session: string, subagentType: string, extraArgs: Record<string, unknown> = {}): Promise<unknown> {
    return hooksFor(root).then((hooks) =>
      hooks.before(
        { tool: "task", sessionID: session, callID: `call-task-${subagentType}` },
        { args: { description: "do WP work", prompt: "implement", subagent_type: subagentType, ...extraArgs } }
      )
    );
  }

  async function callTool(name: string, args: Record<string, unknown>, ctxOverrides: Record<string, unknown> = {}): Promise<string> {
    const fn = tools[name] as { execute: (a: unknown, c: unknown) => Promise<string> };
    return fn.execute(args, toolContext(ctxOverrides));
  }

  function approve(action: string, scopeId: string, scopeRev: string): string {
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

  function openPrivileged(role: "gaspar" | "PO", key: string): { id: string; token: string } {
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

  beforeEach(async () => {
    workerKeys = [];
    tempDir = mkdtempSync(join(tmpdir(), "chrono-dispatch-"));
    root = realpathSync(tempDir);
    mkdirSync(join(root, ".chrono", "hooks"), { recursive: true });
    writeFileSync(join(root, ".chrono", "chrono.db"), "", "utf8");
    pluginPath = join(root, "chrono-gate.js");
    writeFileSync(pluginPath, buildOpencodePlugin(), "utf8");
    writeFileSync(join(root, ".chrono", "hooks", "chrono-entry-session.sh"), `#!/bin/sh\necho '${validPayload()}'\n`, "utf8");
    chmodSync(join(root, ".chrono", "hooks", "chrono-entry-session.sh"), 0o755);
    mkdirSync(join(root, ".opencode", "tools"), { recursive: true });
    writeFileSync(join(root, ".opencode", "tools", "chrono.ts"), buildPlanningToolsFile(), "utf8");
    tools = (await import(pathToFileURL(join(root, ".opencode", "tools", "chrono.ts")).href)) as Record<string, unknown>;
    savedEnv = { ...process.env };
    for (const key of ["CHRONO_BIN", "CHRONO_OPENCODE_BIN", "CHRONO_ENTRY_ADAPTER", "CHRONO_ENTRY_TIMEOUT_MS", "CHRONO_GATE_MODULE", "CHRONO_GATE_WP", "CHRONO_SESSION_TOKEN", "CHRONO_GATE_AS", "CHRONO_GATE_ROLE", "CHRONO_REQUESTER_TOKEN"]) {
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
    gasparSession = openPrivileged("gaspar", signingKey);
    gasparToken = tokenString(gasparSession);
    const gaspar = { actor: "gaspar", session: gasparSession };
    const po = { actor: "PO", session: openPrivileged("PO", signingKey) };
    const proposed = core.proposeArchitecture({ title: "A" }, gaspar);
    expect(proposed.ok).toBe(true);
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    approve("architecture-security", "ARCH", proposed.value!);
    expect(core.approveArchitecture(gaspar).ok).toBe(true);
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar).ok).toBe(true);
    const specRev = core.getArtifact("SP-0001").revision;
    approve("architecture-security", "SP-0001", specRev);
    expect(core.recordHarness(specRev, `sha256:${"a".repeat(64)}`, "# h", gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecApprovedReady", gaspar).ok).toBe(true);
    expect(core.registerModule("MOD-0002", "DRAFT", MOD, gaspar).ok).toBe(true);
    expect(
      core.registerWorkPackage("WP-0001", "PLANNED", { id: "WP-0001", name: "W", module: "MOD-0002", dependsOn: [] }, gaspar).ok
    ).toBe(true);
    expect(core.transitionState("MOD-0002", "ModulePlanned", gaspar).ok).toBe(true);
    // Converged activation authority (CF2-2).
    approve("planning-approval", "MOD-0002", core.getArtifact("MOD-0002").revision);
    approve("module-approval", "MOD-0002", core.getArtifact("MOD-0002").revision);
    expect(core.transitionState("MOD-0002", "ModuleApproved", gaspar).ok).toBe(true);
    expect(core.transitionState("WP-0001", "WorkPackageAuthorized", gaspar).ok).toBe(true);
    const rtkBin = join(root, "fixture-rtk.sh");
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
    const vendorTarget = join(root, skillVendorPath(SKILL_RELEASE.pinnedCommit));
    mkdirSync(dirname(vendorTarget), { recursive: true });
    writeFileSync(vendorTarget, FIXTURE_SKILL_MD, "utf8");
    for (const runtime of ["claude", "opencode", "kiro"] as const) {
      const target = join(root, SKILL_RUNTIME_PATHS[runtime]);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, FIXTURE_SKILL_MD, "utf8");
    }
    const entrypoint = join(root, "fixture-runtime.sh");
    writeFileSync(entrypoint, "#!/bin/sh\necho fixture-ok\n");
    chmodSync(entrypoint, 0o755);
    expect(
      core.registerAdapter({ id: "fixture", name: "Fixture", entrypoint, conformanceProof: ["fixture --version"] }, po).ok
    ).toBe(true);
    const registrationHash = core.adapterRegistrationHash("fixture");
    const adapterApprovalId = approve("adapter-registration", "fixture", registrationHash);
    expect(core.approveAdapter("fixture", adapterApprovalId, po).ok).toBe(true);
    const recordedProof = core.recordRoutingProof(gaspar, {
      adapterId: "fixture", binaryPath: rtkBin, version: "1.0.0-test",
      proofCommand: JSON.stringify([rtkBin, "gain"]),
      preRoutingCommand: JSON.stringify(["ls", root]),
      commandHash: computeRevisionHash([rtkBin, "gain"]),
      outputHash: computeRevisionHash("fixture gain ok"),
      exitStatus: 0, gainAvailable: true,
      timestamp: new Date().toISOString(), ttlSeconds: 86400,
    });
    expect(recordedProof.ok).toBe(true);
    for (const spec of managedAssetInventory("fixture")) {
      // The entry script owns its path (installed above with the
      // executable fixture): marker text would both break entry and
      // drift the manifest hash checked at promotion and every gate.
      if (spec.path === ".chrono/hooks/chrono-entry-session.sh") {
        continue;
      }
      const target = join(root, spec.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, spec.kind === "marker" ? `fixture-managed ${spec.marker ?? spec.path}\n` : `fixture-managed ${spec.path}\n`, "utf8");
    }
    expect(core.promoteRoutingProof(recordedProof.value!.id, po).ok).toBe(true);
    // Host entry token for the Gaspar OpenCode session.
    writeFileSync(hostTokenPath(sessionKey), gasparToken, { mode: 0o600 });
  });

  afterEach(() => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    for (const key of ["CHRONO_BIN", "CHRONO_OPENCODE_BIN"]) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    for (const key of [sessionKey, ...(typeof workerKeys !== "undefined" ? workerKeys : [])]) {
      try {
        rmSync(hostTokenPath(key), { force: true });
      } catch {
        // best-effort
      }
    }
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exposes the governed native tools with dispatch, claim, and lifecycle", () => {
    expect([...CHRONO_NATIVE_TOOLS]).toEqual([
      "chrono_artifact_status",
      "chrono_artifact_propose",
      "chrono_artifact_revise",
      "chrono_artifact_supersede",
      "chrono_approval_request",
      "chrono_approval_status",
      "chrono_dispatch",
      "chrono_dispatch_claim",
      "chrono_next",
      "chrono_execution_status",
      "chrono_evidence_record",
      "chrono_evidence_status",
      "chrono_complete_request",
      "chrono_review_request",
      "chrono_review_complete",
      "chrono_defect_record",
      "chrono_verify_record",
      "chrono_correction_open",
      "chrono_correction_complete",
      "chrono_module_complete",
      "chrono_wp_authorize",
      "chrono_deep_check",
      "chrono_policy_set",
      "chrono_policy_status",
      "chrono_dispatch_confirm",
      "chrono_dispatch_release",
      "chrono_dispatch_revoke",
      "chrono_dispatch_reconcile",
      "chrono_scope_advance",
      "chrono_defect_resolve",
      "chrono_module_activate",
      "chrono_review_reconcile",
    ]);
    expect(Object.keys(tools).join(" ")).toContain("dispatch");
    expect(Object.keys(tools).join(" ")).toContain("dispatch_claim");
    expect(Object.keys(tools).join(" ")).toContain("next");
    expect(Object.keys(tools).join(" ")).toContain("module_activate");
  });

  it("generated plugin kind roles match the domain matrix exactly (reviewers enact only review kinds)", () => {
    const bytes = buildOpencodePlugin();
    const map: Record<string, readonly string[]> = DISPATCH_KIND_ROLES as Record<string, readonly string[]>;
    for (const [kind, roles] of Object.entries(map)) {
      for (const role of roles) {
        expect(bytes).toContain(`"${role}"`);
      }
      // Bare or quoted key: the generated map is plain JS, the domain
      // map quotes every key. Either spelling carries the same entry.
      expect(bytes.includes(`"${kind}"`) || bytes.includes(`${kind}:`)).toBe(true);
    }
    // Reviewers are admitted by the gate only through their kinds.
    expect(map["security-review"]).toEqual(["glenn"]);
    expect(map["verification"]).toEqual(["spekkio"]);
    expect(bytes).toContain("kinds are not interchangeable");
  });

  it("Gaspar dispatches without shell, token, or grant instructions", () => {
    const gaspar = buildOpenCodeAgentDefinition("gaspar");
    expect(gaspar).toContain("chrono_dispatch");
    expect(gaspar).toContain("NEVER ask the Product Owner to run shell commands");
    expect(gaspar).toContain("dispatch needs no");
    // No instructions that hand internals to the PO: only prohibitions.
    expect(gaspar).not.toContain("CHRONO_SESSION_TOKEN");
    expect(gaspar).not.toContain("ask the PO to run");
    expect(gaspar).not.toContain("ask the PO to execute");
    for (const role of ["belthazar", "melchior", "prometheus", "lucca"] as const) {
      expect(buildOpenCodeAgentDefinition(role)).toContain("chrono_dispatch_claim");
    }
  });

  async function fullFlow(): Promise<{ dispatchId: string; workerSession: string }> {
    const hooks = await hooksFor(root);
    await hooks.message({ sessionID: sessionKey });
    // 1. Gaspar validates the dispatch natively (module/WP ids + rationale only).
    const dispatched = JSON.parse(
      await callTool("dispatch", { module: "MOD-0002", wp: "WP-0001", rationale: "start WP-0001 now" })
    ) as { dispatchId: string; module: string; wp: string };
    expect(dispatched.module).toBe("MOD-0002");
    expect(dispatched.wp).toBe("WP-0001");
    // 2. Gaspar delegates to exactly one worker role.
    await hooks.before(
      { tool: "task", sessionID: sessionKey, callID: "call-task-1" },
      { args: { description: "implement WP-0001", prompt: `CHRONO dispatch ${dispatched.dispatchId}: implement WP-0001`, subagent_type: "belthazar" } }
    );
    // 3. The runtime delivers the child session (parentID + agent).
    const workerSession = "worker-ses-1";
    workerKeys.push(workerSession);
    await hooks.event(childCreatedEvent(workerSession, sessionKey, "belthazar"));
    // 4. The worker claims first, from its own session as its own agent.
    const claimed = JSON.parse(
      await callTool("dispatch_claim", { dispatch: dispatched.dispatchId }, { sessionID: workerSession, agent: "belthazar" })
    ) as { grantId: string; role: string };
    expect(claimed.role).toBe("belthazar");
    expect(claimed.grantId).toMatch(/^GRANT-[0-9]{4}$/);
    return { dispatchId: dispatched.dispatchId, workerSession };
  }

  it("approved planning → dispatch → delegation → claimed worker with bound mutable tools", async () => {
    const hooks = await hooksFor(root);
    const { workerSession } = await fullFlow();
    // 5. Worker mutate tools pass inside the bound WP.
    await expect(
      hooks.before({ tool: "edit", sessionID: workerSession, callID: "call-edit-1" }, { args: { filePath: "src/app.ts", oldText: "a", newText: "b" } })
    ).resolves.toBeUndefined();
    await expect(
      hooks.before({ tool: "bash", sessionID: workerSession, callID: "call-bash-1" }, { args: { command: "npm test" } })
    ).resolves.toBeUndefined();
    // 6. Gaspar itself still cannot implement (no dispatch context by design).
    await expect(
      hooks.before({ tool: "edit", sessionID: sessionKey, callID: "call-gaspar-edit" }, { args: { filePath: "src/app.ts", oldText: "a", newText: "b" } })
    ).rejects.toThrow(/without dispatch context/);
    // 7. The worker cannot reach other scopes through the same binding.
    const other = runGate(root, {
      gate: "execution", module: "MOD-0002", wp: "WP-0002",
      as: "belthazar", role: "belthazar",
      sessionToken: readFileSync(hostTokenPath(workerSession), "utf8").trim(),
      json: true,
    });
    expect(other.exitCode).toBe(1);
  });

  it("direct task without a dispatch denies; unknown and authority targets deny", async () => {
    // No intent: direct delegation denies.
    await expect(taskBefore(sessionKey, "belthazar")).rejects.toThrow(/No live dispatch/);
    // Unknown agent, builtin agents, and authority roles deny even with
    // no intent ambiguity to hide behind.
    for (const agent of ["general", "explore", "build", "gaspar", "PO", "spekkio", "glenn", "belthazar2"]) {
      await expect(taskBefore(sessionKey, agent)).rejects.toThrow(/TASK_DENIED/);
    }
    // Malformed task calls (no subagent_type) are not classifiable delegation.
    const hooks = await hooksFor(root);
    await expect(
      hooks.before({ tool: "task", sessionID: sessionKey, callID: "call-task-bad" }, { args: { description: "x" } })
    ).rejects.toThrow(/TASK_DENIED/);
  });

  it("worker sessions cannot delegate and unbound children cannot mutate", async () => {
    const hooks = await hooksFor(root);
    const { workerSession } = await fullFlow();
    // Bound workers never delegate.
    await expect(
      hooks.before(
        { tool: "task", sessionID: workerSession, callID: "call-task-nested" },
        { args: { description: "nested", prompt: "x", subagent_type: "lucca" } }
      )
    ).rejects.toThrow(/never delegate/);
    // An unbound child (spawned without a bound task) reads but never mutates.
    const rogue = "rogue-ses-1";
    await hooks.event(childCreatedEvent(rogue, sessionKey, "general"));
    await expect(
      hooks.before({ tool: "read", sessionID: rogue, callID: "call-rogue-read" }, { args: { filePath: "x" } })
    ).resolves.toBeUndefined();
    await expect(
      hooks.before({ tool: "edit", sessionID: rogue, callID: "call-rogue-edit" }, { args: { filePath: "x", oldText: "a", newText: "b" } })
    ).rejects.toThrow(/DISPATCH_REQUIRED/);
    await expect(
      hooks.before(
        { tool: "task", sessionID: rogue, callID: "call-rogue-task" },
        { args: { description: "x", prompt: "y", subagent_type: "lucca" } }
      )
    ).rejects.toThrow();
  });

  it("claim replay, forged dispatch, and session mismatch deny", async () => {
    const hooks = await hooksFor(root);
    await hooks.message({ sessionID: sessionKey });
    const dispatched = JSON.parse(
      await callTool("dispatch", { module: "MOD-0002", wp: "WP-0001", rationale: "start now" })
    ) as { dispatchId: string };
    await hooks.before(
      { tool: "task", sessionID: sessionKey, callID: "call-task-1" },
      { args: { description: "implement", prompt: `CHRONO dispatch ${dispatched.dispatchId}`, subagent_type: "belthazar" } }
    );
    const workerSession = "worker-ses-2";
    workerKeys.push(workerSession);
    await hooks.event(childCreatedEvent(workerSession, sessionKey, "belthazar"));
    const claimed = JSON.parse(
      await callTool("dispatch_claim", { dispatch: dispatched.dispatchId }, { sessionID: workerSession, agent: "belthazar" })
    ) as { grantId: string };
    expect(claimed.grantId).toMatch(/^GRANT-/);
    // Replay: the same dispatch claimed twice denies.
    await expect(
      callTool("dispatch_claim", { dispatch: dispatched.dispatchId }, { sessionID: "worker-ses-3", agent: "belthazar" })
    ).rejects.toThrow(/already claimed/);
    // Forged dispatch id denies.
    await expect(
      callTool("dispatch_claim", { dispatch: "0".repeat(32), agent: "belthazar" }, { sessionID: "worker-ses-4", agent: "belthazar" })
    ).rejects.toThrow();
    // Claiming into the requesting session denies (session mismatch).
    await expect(
      callTool("dispatch_claim", { dispatch: dispatched.dispatchId }, { sessionID: sessionKey, agent: "belthazar" })
    ).rejects.toThrow();
    // Claim without any prior task delegation denies.
    const dispatched2 = JSON.parse(
      await callTool("dispatch", { module: "MOD-0002", wp: "WP-0001", rationale: "again" })
    ) as { dispatchId: string };
    // Second dispatch while the first is claimed is fine; claiming it
    // without delegating denies.
    await expect(
      callTool("dispatch_claim", { dispatch: dispatched2.dispatchId }, { sessionID: "worker-ses-5", agent: "belthazar" })
    ).rejects.toThrow(/delegate first/);
  });

  it("revoked module approval denies dispatch with the exact prerequisite", async () => {
    await hooksFor(root);
    expect(core.registerModule("MOD-0003", "DRAFT", { id: "MOD-0003", name: "M3", purpose: "P", specs: ["SP-0001"] }, { actor: "gaspar", session: gasparSession }).ok).toBe(true);
    expect(core.transitionState("MOD-0003", "ModulePlanned", { actor: "gaspar", session: gasparSession }).ok).toBe(true);
    const modRev = core.getArtifact("MOD-0003").revision;
    const signature = signApprovalPayload(
      buildApprovalPayload({
        action: "module-approval", scopeArtifactId: "MOD-0003", scopeRevision: modRev,
        authority: "PO", rationale: "test approval", timestamp: "2026-09-14T00:00:00.000Z",
      }),
      signingKey
    );
    expect(
      core.recordApproval({
        action: "module-approval", scopeArtifactId: "MOD-0003", scopeRevision: modRev,
        authority: "PO", rationale: "test approval", timestamp: "2026-09-14T00:00:00.000Z", signature,
      }).ok
    ).toBe(true);
    expect(core.transitionState("MOD-0003", "ModuleApproved", { actor: "gaspar", session: gasparSession }).ok).toBe(true);
    // Approval revoked after promotion: the module stands APPROVED in
    // status but carries no current authority.
    const raw = new Database(join(root, ".chrono", "chrono.db"));
    try {
      raw.prepare("UPDATE approval SET revoked = 1 WHERE scope_artifact_id = 'MOD-0003'").run();
    } finally {
      raw.close();
    }
    await expect(callTool("dispatch", { module: "MOD-0003", rationale: "revoked module" })).rejects.toThrow(/APPROVAL_REQUIRED/);
  });

  it("worker sessions skip the Gaspar contract; Gaspar sessions keep it", async () => {
    const hooks = await hooksFor(root);
    await hooks.message({ sessionID: sessionKey });
    const gasparOut: { system: unknown[] } = { system: [] };
    await hooks.transform({ sessionID: sessionKey }, gasparOut);
    expect(gasparOut.system.length).toBe(1);
    const workerSession = "worker-ses-9";
    await hooks.event(childCreatedEvent(workerSession, sessionKey, "lucca"));
    const workerOut: { system: unknown[] } = { system: [] };
    await hooks.transform({ sessionID: workerSession }, workerOut);
    expect(workerOut.system.length).toBe(0);
  });

  it("task resume re-enters only the caller's own claimed worker", async () => {
    const hooks = await hooksFor(root);
    const { workerSession } = await fullFlow();
    await expect(
      hooks.before(
        { tool: "task", sessionID: sessionKey, callID: "call-resume" },
        { args: { description: "resume", prompt: "continue", subagent_type: "belthazar", task_id: workerSession } }
      )
    ).resolves.toBeUndefined();
    await expect(
      hooks.before(
        { tool: "task", sessionID: "other-session", callID: "call-hijack" },
        { args: { description: "hijack", prompt: "x", subagent_type: "belthazar", task_id: workerSession } }
      )
    ).rejects.toThrow(/TASK_DENIED/);
  });
});
