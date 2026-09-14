/**
 * OC-P11 integrated approval ceremony black box, corrected architecture
 * (fail-open fix).
 *
 * There is deliberately NO approval-confirm tool: signing follows only
 * an explicit human Approve observed by the plugin host in a
 * runtime-delivered `question` result — never model tool invocation,
 * execution permission, cached/always allow, auto mode, or chat text.
 *
 * Drives REAL generated plugin bytes (entry gate, planning gate,
 * question observation, host signing) with the EXACT two-argument SDK
 * shapes, REAL native tool executes, the REAL built CLI, a REAL Core
 * project, and the real filesystem. Fixtures cover only the model
 * (tool arguments, question text), the human (answer text), the OS
 * keychain (PATH-injected `security`), and the entry token file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  approvalChallenge,
  buildCeremonyKey,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  canonicalizeJson,
  canonicalize,
  fingerprintPublicKey,
  generateApprovalKeyPair,
} from "@chrono/domain";
import { signApprovalPayload as domainSign } from "@chrono/domain";
import { ChronoCore } from "@chrono/core";
import { buildOpencodePlugin } from "./opencode-plugin.js";
import { buildOpenCodeAgentDefinition } from "./opencode-agent.js";
import { buildPlanningToolsFile } from "./opencode-planning-tools.js";
import { runDoctor } from "./init-flow.js";
import { MemoryKeyStore } from "./keychain.js";
import { CHRONO_VERSION } from "./version.js";
import { PO_KEY_ACCOUNT, PO_KEY_SERVICE } from "./keychain.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXED_TIME = "2026-09-14T00:00:00.000Z";

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
    if (stdinDesc !== undefined) Object.defineProperty(process.stdin, "isTTY", stdinDesc);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdoutDesc !== undefined) Object.defineProperty(process.stdout, "isTTY", stdoutDesc);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  };
}

describe("OC-P11 integrated approval ceremony", () => {
  let tempDir: string;
  let root: string;
  let pluginPath: string;
  let core: ChronoCore;
  let signingKey = "";
  let gasparToken = "";
  let gasparSession: { id: string; token: string } = { id: "", token: "" };
  let restoreTty: () => void;
  let savedEnv: Record<string, string | undefined>;
  const sessionKey = "ceremony-1";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tools: Record<string, any>;

  function tokenString(session: { id: string; token: string }): string {
    return `${session.id}/${session.token}`;
  }

  function hostTokenPath(): string {
    return join(tmpdir(), `chrono-gaspar-host-${createHash("sha256").update(`${root}|${sessionKey}`, "utf8").digest("hex").slice(0, 16)}.token`);
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
        "tool.execute.before": (input: unknown, output: unknown) => Promise<unknown>;
        "tool.execute.after": (input: unknown, output: unknown) => Promise<unknown>;
      }>;
    };
    const hooks = await module.ChronoGatePlugin({ directory });
    return { event: hooks.event, message: hooks["chat.message"], before: hooks["tool.execute.before"], after: hooks["tool.execute.after"] };
  }

  function askedEvent(sessionID: string, requestID: string, line: string): unknown {
    return {
      event: {
        type: "question.asked",
        properties: {
          id: requestID,
          sessionID,
          questions: [{ question: "CHRONO product decision", header: "Approval", options: [{ label: line, description: "Record signed PO approval" }, { label: "Deny", description: "Do nothing" }] }],
          tool: { messageID: "m1", callID: "call-q" },
        },
      },
    };
  }

  function repliedEvent(sessionID: string, requestID: string, answer: string): unknown {
    return {
      event: {
        type: "question.replied",
        properties: { sessionID, requestID, answers: [[answer]] },
      },
    };
  }

  function rejectedEvent(sessionID: string, requestID: string): unknown {
    return {
      event: {
        type: "question.rejected",
        properties: { sessionID, requestID },
      },
    };
  }

  function evidenceText(): string {
    try {
      return readFileSync(join(root, ".chrono", "runtime-activation.jsonl"), "utf8");
    } catch {
      return "";
    }
  }

  function questionArgs(line: string): unknown {
    return { question: "CHRONO product decision", header: "Approval", options: [{ label: line, description: "Record signed PO approval" }, { label: "Deny", description: "Do nothing" }] };
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const fn = tools[name] as { execute: (a: unknown, c: unknown) => Promise<string> };
    return fn.execute(args, toolContext());
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-ceremony-"));
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
    const signature = domainSign(
      buildEnrollmentPayload({ projectId: "default", fingerprint, timestamp, nonce, authority: "PO", rationale: "test", confirmation }),
      pair.privateKeyPem
    );
    expect(core.enrollPo({ publicKeyPem: pair.publicKeyPem, nonce, timestamp, rationale: "test", confirmation, signature }).ok).toBe(true);
    signingKey = pair.privateKeyPem;
    // Fixture `security` on PATH printing the enrolled key (no test
    // seam in production bytes; PATH injection mirrors the macOS
    // helper contract).
    const keyFile = join(root, "po-key.pem");
    writeFileSync(keyFile, signingKey, { mode: 0o600 });
    const fixtureBin = join(root, "fixture-bin");
    mkdirSync(fixtureBin, { recursive: true });
    writeFileSync(join(fixtureBin, "security"), `#!/bin/sh\ncat "${keyFile}"\n`, "utf8");
    chmodSync(join(fixtureBin, "security"), 0o755);
    process.env["PATH"] = `${fixtureBin}${delimiter}${process.env["PATH"] ?? ""}`;
    // Fixture `opencode` oracle for the question-surface gate: the
    // native approval_request tool always passes --require-question,
    // so hermetic fixtures must answer the same `debug agent gaspar`
    // question OpenCode answers in production. No test seam in
    // production bytes — CHRONO_OPENCODE_BIN is the supported probe
    // override.
    const fixtureOpencode = join(root, "opencode-fixture.sh");
    writeFileSync(fixtureOpencode, `#!/bin/sh\necho '{"tools":{"question":true}}'\n`, "utf8");
    chmodSync(fixtureOpencode, 0o755);
    process.env["CHRONO_OPENCODE_BIN"] = fixtureOpencode;
    const sessionNonce = randomBytes(16).toString("hex");
    const sessionTimestamp = "2026-09-11T00:00:00.000Z";
    const sessionSig = domainSign(
      buildSessionAuthorizationPayload({
        sessionRole: "gaspar", adapter: "test-adapter", runtime: "opencode",
        scopeModule: null, scopeWp: null, ttlSeconds: 3600, nonce: sessionNonce,
        authority: "PO", rationale: "test", timestamp: sessionTimestamp,
      }),
      signingKey
    );
    const opened = core.openSession(
      { role: "gaspar", adapter: "test-adapter", runtime: "opencode", ttlSeconds: 3600 },
      { poAuthorization: { nonce: sessionNonce, authority: "PO", rationale: "test", timestamp: sessionTimestamp, signature: sessionSig } }
    );
    expect(opened.ok).toBe(true);
    gasparSession = { id: opened.value!.id, token: opened.value!.token };
    gasparToken = tokenString(gasparSession);
    writeFileSync(hostTokenPath(), gasparToken, { mode: 0o600 });
  });

  afterEach(() => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    for (const key of ["CHRONO_BIN", "CHRONO_OPENCODE_BIN"]) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    try {
      rmSync(hostTokenPath(), { force: true });
    } catch {
      // best-effort
    }
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("generated signing bytes match what the Core verifies", async () => {
    const module = (await import(pathToFileURL(pluginPath).href)) as Record<string, unknown>;
    const payload = {
      action: "planning-approval",
      scope_artifact_id: "REQ-0001",
      scope_revision: `sha256:${"a".repeat(64)}`,
      authority: "PO",
      rationale: "accept",
      timestamp: FIXED_TIME,
      security_implications: "none",
    };
    const generatedCanonicalize = module["chronoCanonicalizeJson"] as (v: unknown) => string;
    const decide = module["chronoApprovalDecision"] as (q: string, a: string, c: string) => string;
    expect(typeof generatedCanonicalize).toBe("function");
    expect(typeof decide).toBe("function");
    expect(generatedCanonicalize(payload)).toBe(canonicalizeJson(payload));
    expect(generatedCanonicalize(payload)).toBe(canonicalize(payload));
    expect(decide("Q approve-TICKET-0007", "Approve approve-TICKET-0007", "approve-TICKET-0007")).toBe("approve");
    expect(decide("Q approve-TICKET-0007", "Deny approve-TICKET-0007", "approve-TICKET-0007")).toBe("decline");
    expect(decide("Q approve-TICKET-0007", "Approve it", "approve-TICKET-0007")).toBe("ignore");
    expect(decide("Q?", "Approve approve-TICKET-0007", "approve-TICKET-0007")).toBe("ignore");
    expect(approvalChallenge("TICKET-0007")).toBe("approve-TICKET-0007");
  });

  it("keychain identifiers match the CLI keystore (no drift)", () => {
    expect(PO_KEY_SERVICE).toBe("chrono-po-signing-key");
    expect(PO_KEY_ACCOUNT).toBe("po");
  });

  it("native question event chain finalizes on explicit Approve (asked/replied)", async () => {
    const hooks = await hooksFor(root);
    await hooks.message({ sessionID: sessionKey });
    const spec = JSON.parse(await callTool("artifact_propose", { kind: "spec", id: "SP-0001", title: "Tasks", body: "Task contract." })) as {
      revision: string;
    };
    const requested = JSON.parse(await callTool("approval_request", {
      action: "planning-approval", scope: "SP-0001", revision: spec.revision, rationale: "accept", securityImplications: "none",
    })) as { ticketId: string; challenge: string };
    const line = `CHRONO approval ${requested.challenge} :: planning-approval SP-0001 @${spec.revision} :: accept`;
    await hooks.event(askedEvent(sessionKey, "req-1", line));
    await hooks.event(repliedEvent(sessionKey, "req-1", `Approve ${requested.challenge} — yes`));
    expect(core.hasValidApproval("SP-0001", spec.revision, "planning-approval")).toBe(true);
    expect(core.approvalCeremonyAuthoritative(core.listApprovals()[0]?.id ?? "")).toBe(true);
    expect(evidenceText()).toContain("approval-finalized");
    // Bare reply redelivery (pending already consumed) is audited
    // with no state change.
    await hooks.event(repliedEvent(sessionKey, "req-1", `Approve ${requested.challenge} — yes`));
    expect(core.listApprovals()).toHaveLength(1);
    // Full asked+replied redelivery (restart replay shape) is
    // refused at the liveness gate — the ticket is consumed, so the
    // Core finalize path is never re-entered: no-op, no second row.
    await hooks.event(askedEvent(sessionKey, "req-1", line));
    await hooks.event(repliedEvent(sessionKey, "req-1", `Approve ${requested.challenge} — yes`));
    expect(core.listApprovals()).toHaveLength(1);
    expect(evidenceText()).toContain("approval-ticket-not-live");
    // The tool-result channel is observation-only: the same answer
    // passing through tool.execute.after records an observation and
    // never finalizes, denies, or consumes — even when its output
    // payload carries the unselected Deny option label (the exact
    // TICKET-0024 false-decline shape).
    await hooks.after(
      { tool: "question", sessionID: sessionKey, callID: "call-dup", args: questionArgs(line) },
      { title: "answer", output: { answer: `Approve ${requested.challenge} — yes`, options: [{ label: `Approve ${requested.challenge}`, description: "Record" }, { label: "Deny", description: "Do nothing" }] }, metadata: {} }
    );
    expect(core.listApprovals()).toHaveLength(1);
    expect(evidenceText()).toContain("approval-result-observed");
    expect(evidenceText()).not.toContain("approval-answer-declined");
  });

  it("event chain denies rejected, unmatched, and cross-session answers", async () => {
    const hooks = await hooksFor(root);
    await hooks.message({ sessionID: sessionKey });
    const spec = JSON.parse(await callTool("artifact_propose", { kind: "spec", id: "SP-0001", title: "Tasks", body: "Task contract." })) as {
      revision: string;
    };
    const requested = JSON.parse(await callTool("approval_request", {
      action: "planning-approval", scope: "SP-0001", revision: spec.revision, rationale: "accept", securityImplications: "none",
    })) as { ticketId: string; challenge: string };
    const line = `CHRONO approval ${requested.challenge} :: planning-approval SP-0001 @${spec.revision} :: accept`;
    // Explicit rejection cancels with no state change.
    await hooks.event(askedEvent(sessionKey, "req-deny", line));
    await hooks.event(rejectedEvent(sessionKey, "req-deny"));
    expect(core.hasValidApproval("SP-0001", spec.revision, "planning-approval")).toBe(false);
    expect(evidenceText()).toContain("approval-answer-declined");
    // Reply without a prior asked (unknown requestID): no action.
    await hooks.event(repliedEvent(sessionKey, "req-ghost", `Approve ${requested.challenge}`));
    expect(core.hasValidApproval("SP-0001", spec.revision, "planning-approval")).toBe(false);
    // Reply in another session for this session's ticket: denied at
    // the session gate (no Core entry session there to bind to).
    await hooks.event(askedEvent("other-session", "req-x", line));
    await hooks.event(repliedEvent("other-session", "req-x", `Approve ${requested.challenge}`));
    expect(core.hasValidApproval("SP-0001", spec.revision, "planning-approval")).toBe(false);
    expect(evidenceText()).toContain("approval-no-session");
  });

  it("native approval_request denies when the question surface is unavailable", async () => {
    const hooks = await hooksFor(root);
    await hooks.message({ sessionID: sessionKey });
    const spec = JSON.parse(await callTool("artifact_propose", { kind: "spec", id: "SP-0001", title: "Tasks", body: "Task contract." })) as {
      revision: string;
    };
    const closed = join(root, "opencode-closed.sh");
    writeFileSync(closed, `#!/bin/sh\necho '{"tools":{"question":false}}'\n`, "utf8");
    chmodSync(closed, 0o755);
    process.env["CHRONO_OPENCODE_BIN"] = closed;
    await expect(callTool("approval_request", {
      action: "planning-approval", scope: "SP-0001", revision: spec.revision, rationale: "accept", securityImplications: "none",
    })).rejects.toThrow("approval ticket refused");
  });

  it("agent definition uses native tools and the question flow, never shell approval", async () => {
    const gaspar = buildOpenCodeAgentDefinition("gaspar");
    for (const snippet of ["chrono_artifact_propose", "chrono_approval_request", "question", "chrono_artifact_status"]) {
      expect(gaspar).toContain(snippet);
    }
    expect(gaspar).toContain("There is no approval-confirm tool");
    expect(gaspar).not.toContain("--body-file");
    expect(gaspar).toContain("never use `chrono run`");
    // Contract proof: the definition never instructs a signing tool.
    expect(Object.keys(tools).join(" ")).not.toMatch(/confirm/);
  });

  it("full conversational flow: native tools, explicit Approve, signed approval, plan, no restart", async () => {
    const hooks = await hooksFor(root);
    await hooks.message({ sessionID: sessionKey });
    const spec = JSON.parse(await callTool("artifact_propose", { kind: "spec", id: "SP-0001", title: "Tasks", body: "Task contract." })) as {
      id: string;
      revision: string;
    };
    await callTool("artifact_propose", { kind: "adr", id: "ADR-0001", title: "SQLite", body: "SQLite decision." });
    await callTool("artifact_propose", { kind: "security-profile", id: "SEC-0001", title: "Threats", body: "Boundaries and controls." });
    expect(existsSync(join(root, ".chrono", "specs", "SP-0001.md"))).toBe(true);
    const requested = JSON.parse(await callTool("approval_request", {
      action: "planning-approval", scope: "SP-0001", revision: spec.revision,
      rationale: "accept", securityImplications: "none",
    })) as { ticketId: string; challenge: string };
    expect(requested.challenge).toBe(approvalChallenge(requested.ticketId));
    // Native question with the exact canonical line; explicit Approve
    // through the single authoritative path (asked/replied events).
    const flowLine = `CHRONO approval ${requested.challenge} :: planning-approval SP-0001 @${spec.revision} :: accept`;
    await hooks.event(askedEvent(sessionKey, "req-flow", flowLine));
    await hooks.event(repliedEvent(sessionKey, "req-flow", `Approve ${requested.challenge} — yes, ship it`));
    expect(core.hasValidApproval("SP-0001", spec.revision, "planning-approval")).toBe(true);
    const recorded = core.listApprovals().find((a) => a.scopeArtifactId === "SP-0001");
    expect(recorded?.signature.length).toBeGreaterThan(10);
    expect(evidenceText()).toContain("approval-finalized");
    expect(evidenceText()).not.toContain(signingKey.slice(0, 20));
    expect(evidenceText()).not.toContain(gasparToken);
    await expect(hooks.message({ sessionID: sessionKey })).resolves.toBeUndefined();
    const mod = JSON.parse(await callTool("artifact_propose", {
      kind: "module", id: "MOD-0001", title: "M", body: "Plan.", references: ["SP-0001"],
    })) as { ok: boolean };
    expect(mod.ok).toBe(true);
    const wp = JSON.parse(await callTool("artifact_propose", {
      kind: "workpackage", id: "WP-0001", title: "W", body: "Plan.", references: ["MOD-0001"],
    })) as { ok: boolean };
    expect(wp.ok).toBe(true);
  });

  it("deny, cancel, malformed, missing challenge, and chat-only never approve", async () => {
    const hooks = await hooksFor(root);
    await hooks.message({ sessionID: sessionKey });
    const spec = JSON.parse(await callTool("artifact_propose", { kind: "spec", id: "SP-0001", title: "Tasks", body: "Task contract." })) as {
      revision: string;
    };
    const first = JSON.parse(await callTool("approval_request", {
      action: "planning-approval", scope: "SP-0001", revision: spec.revision, rationale: "accept", securityImplications: "none",
    })) as { ticketId: string; challenge: string };
    const line = `CHRONO approval ${first.challenge} :: planning-approval SP-0001 @${spec.revision} :: accept`;
    // Chat-only "approval": no native event fires, so nothing records.
    await expect(hooks.message({ sessionID: sessionKey })).resolves.toBeUndefined();
    expect(core.hasValidApproval("SP-0001", spec.revision, "planning-approval")).toBe(false);
    // Explicit Deny through the authoritative path.
    await hooks.event(askedEvent(sessionKey, "req-deny", line));
    await hooks.event(rejectedEvent(sessionKey, "req-deny"));
    expect(core.hasValidApproval("SP-0001", spec.revision, "planning-approval")).toBe(false);
    expect(evidenceText()).toContain("approval-answer-declined");
    // Cancel wording with challenge present.
    await hooks.event(askedEvent(sessionKey, "req-cancel", line));
    await hooks.event(repliedEvent(sessionKey, "req-cancel", `Cancel ${first.challenge}`));
    expect(core.hasValidApproval("SP-0001", spec.revision, "planning-approval")).toBe(false);
    // Answer without the challenge.
    await hooks.event(askedEvent(sessionKey, "req-vague", line));
    await hooks.event(repliedEvent(sessionKey, "req-vague", "Approve it, looks good"));
    expect(core.hasValidApproval("SP-0001", spec.revision, "planning-approval")).toBe(false);
    // Tool-result observations never trigger the ceremony, even for
    // Deny wording: observation-only by construction.
    await hooks.after(
      { tool: "question", sessionID: sessionKey, callID: "call-deny", args: questionArgs(line) },
      { title: "answer", output: `Deny ${first.challenge} — not yet`, metadata: {} }
    );
    expect(core.hasValidApproval("SP-0001", spec.revision, "planning-approval")).toBe(false);
    expect(evidenceText()).toContain("approval-result-observed");
    // Non-question tool results never trigger the ceremony.
    await hooks.after(
      { tool: "read", sessionID: sessionKey, callID: "call-read", args: { filePath: "x" } },
      { title: "read", output: `Approve ${first.challenge}`, metadata: {} }
    );
    expect(core.hasValidApproval("SP-0001", spec.revision, "planning-approval")).toBe(false);
    // The ticket survives every denial: the human can still confirm.
    expect(core.listApprovals()).toHaveLength(0);
  });

  it("replay, stale, forged, cross-session, cross-project, and auto all deny", async () => {
    const hooks = await hooksFor(root);
    await hooks.message({ sessionID: sessionKey });
    const spec = JSON.parse(await callTool("artifact_propose", { kind: "spec", id: "SP-0001", title: "Tasks", body: "Task contract." })) as {
      revision: string;
    };
    const first = JSON.parse(await callTool("approval_request", {
      action: "planning-approval", scope: "SP-0001", revision: spec.revision, rationale: "accept", securityImplications: "none",
    })) as { ticketId: string; challenge: string };
    const line = `CHRONO approval ${first.challenge} :: planning-approval SP-0001 @${spec.revision} :: accept`;
    const askApprove = async (requestId: string, session: string, questionLine: string, answer: string) => {
      await hooks.event({
        event: {
          type: "question.asked",
          properties: {
            id: requestId,
            sessionID: session,
            questions: [{ question: "CHRONO product decision", header: "Approval", options: [{ label: questionLine, description: "Record signed PO approval" }] }],
          },
        },
      });
      await hooks.event({ event: { type: "question.replied", properties: { sessionID: session, requestID: requestId, answers: [[answer]] } } });
    };
    // Forged confirmation for an unknown ticket.
    await askApprove("req-forge", sessionKey, "CHRONO approval approve-TICKET-9999 :: planning-approval SP-0001 @x :: y", "Approve approve-TICKET-9999 — yes");
    expect(core.hasValidApproval("SP-0001", spec.revision, "planning-approval")).toBe(false);
    expect(evidenceText()).toContain("approval-ticket-not-live");
    // Genuine approval, then redelivery of the same ceremony: no-op.
    await askApprove("req-2", sessionKey, line, `Approve ${first.challenge} — yes`);
    expect(core.hasValidApproval("SP-0001", spec.revision, "planning-approval")).toBe(true);
    const countAfterFirst = core.listApprovals().length;
    // Redelivery of the same ceremony refuses at the liveness gate —
    // the ticket is consumed, so the Core finalize path is never
    // re-entered (and no record is even attempted).
    await askApprove("req-2", sessionKey, line, `Approve ${first.challenge} — yes again`);
    expect(core.listApprovals()).toHaveLength(countAfterFirst);
    expect(evidenceText()).toContain("approval-ticket-not-live");
    expect(evidenceText()).not.toContain("approval-record-denied");
    // A new ceremony on the consumed ticket: ticket-not-live, no change.
    await askApprove("req-3", sessionKey, line, `Approve ${first.challenge} — yes`);
    expect(core.listApprovals()).toHaveLength(countAfterFirst);
    // Cross-session answer: no host token for that session, no signing.
    await askApprove("req-4", "other-session", line, `Approve ${first.challenge} — yes`);
    expect(core.listApprovals()).toHaveLength(countAfterFirst);
    // Stale: revise after requesting, then answer the old challenge.
    const req2 = JSON.parse(await callTool("artifact_propose", { kind: "requirement", id: "REQ-0001", title: "R", body: "One." })) as {
      revision: string;
    };
    const ticket = JSON.parse(await callTool("approval_request", {
      action: "planning-approval", scope: "REQ-0001", revision: req2.revision, rationale: "accept", securityImplications: "none",
    })) as { ticketId: string; challenge: string };
    const revised = JSON.parse(await callTool("artifact_revise", { id: "REQ-0001", title: "R2", body: "Changed." })) as { revision: string };
    await askApprove("req-5", sessionKey, `CHRONO approval ${ticket.challenge} :: planning-approval REQ-0001 @${req2.revision} :: accept`, `Approve ${ticket.challenge} — yes`);
    expect(core.hasValidApproval("REQ-0001", revised.revision, "planning-approval")).toBe(false);
    // Auto mode refuses deterministically with audit evidence.
    process.argv.push("--auto");
    try {
      const req3 = JSON.parse(await callTool("artifact_propose", { kind: "requirement", id: "REQ-0002", title: "R", body: "Two." })) as {
        revision: string;
      };
      const auto = JSON.parse(await callTool("approval_request", {
        action: "planning-approval", scope: "REQ-0002", revision: req3.revision, rationale: "accept", securityImplications: "none",
      })) as { ticketId: string; challenge: string };
      await askApprove("req-auto", sessionKey, `CHRONO approval ${auto.challenge} :: x`, `Approve ${auto.challenge} — yes`);
      expect(core.hasValidApproval("REQ-0002", req3.revision, "planning-approval")).toBe(false);
      expect(evidenceText()).toContain("approval-skipped-auto");
    } finally {
      process.argv.pop();
    }
  });

  it("cross-project answers cannot spend another project's ticket", async () => {
    const hooks = await hooksFor(root);
    await hooks.message({ sessionID: sessionKey });
    // A second project with its own live ticket: answering for it in
    // THIS project's session resolves to an unknown ticket here.
    const otherDir = mkdtempSync(join(tmpdir(), "chrono-ceremony-other-"));
    const otherRoot = realpathSync(otherDir);
    const other = new ChronoCore({ projectPath: otherRoot, runtime: "opencode" });
    try {
      expect(other.init().ok).toBe(true);
      const draft = other.proposePlanningArtifact({ kind: "spec", id: "SP-0001", title: "S", body: "Body." }, { actor: "gaspar", session: gasparSession });
      // Sessions are project-scoped: the foreign session cannot act here.
      expect(draft.ok).toBe(false);
    } finally {
      other.close();
      rmSync(otherDir, { recursive: true, force: true });
    }
    await hooks.after(
      { tool: "question", sessionID: sessionKey, callID: "call-x", args: questionArgs("CHRONO approval approve-TICKET-0001 :: x") },
      { title: "answer", output: "Approve approve-TICKET-0001", metadata: {} }
    );
    expect(core.listApprovals()).toHaveLength(0);
  });

  it("one question naming two tickets finalizes neither (TICKET-0024 fan-out repair)", async () => {
    const hooks = await hooksFor(root);
    await hooks.message({ sessionID: sessionKey });
    const spec = JSON.parse(await callTool("artifact_propose", { kind: "spec", id: "SP-0001", title: "Tasks", body: "Task contract." })) as {
      revision: string;
    };
    const first = JSON.parse(await callTool("approval_request", {
      action: "planning-approval", scope: "SP-0001", revision: spec.revision, rationale: "accept", securityImplications: "none",
    })) as { ticketId: string; challenge: string };
    const second = JSON.parse(await callTool("approval_request", {
      action: "planning-approval", scope: "SP-0001", revision: spec.revision, rationale: "accept again", securityImplications: "none",
    })) as { ticketId: string; challenge: string };
    expect(second.ticketId).not.toBe(first.ticketId);
    // Accumulated question context naming both tickets: one human
    // Approve must never authorize many tickets.
    const both = `CHRONO approval ${first.challenge} :: planning-approval SP-0001 @${spec.revision} :: accept AND ${second.challenge}`;
    await hooks.event(askedEvent(sessionKey, "req-fan", both));
    await hooks.event(repliedEvent(sessionKey, "req-fan", `Approve ${first.challenge} and ${second.challenge} — yes to both`));
    expect(core.listApprovals()).toHaveLength(0);
    expect(evidenceText()).toContain("approval-multi-ticket");
    expect(evidenceText()).not.toContain("approval-finalized");
  });

  it("historical event replay after restart produces no side effects", async () => {
    const hooks = await hooksFor(root);
    await hooks.message({ sessionID: sessionKey });
    const spec = JSON.parse(await callTool("artifact_propose", { kind: "spec", id: "SP-0001", title: "Tasks", body: "Task contract." })) as {
      revision: string;
    };
    const requested = JSON.parse(await callTool("approval_request", {
      action: "planning-approval", scope: "SP-0001", revision: spec.revision, rationale: "accept", securityImplications: "none",
    })) as { ticketId: string; challenge: string };
    // Second ticket requested BEFORE the first finalizes (request
    // denies once a current approval exists).
    const other = JSON.parse(await callTool("approval_request", {
      action: "planning-approval", scope: "SP-0001", revision: spec.revision, rationale: "second", securityImplications: "none",
    })) as { ticketId: string; challenge: string };
    const line = `CHRONO approval ${requested.challenge} :: planning-approval SP-0001 @${spec.revision} :: accept`;
    await hooks.event(askedEvent(sessionKey, "req-live", line));
    await hooks.event(repliedEvent(sessionKey, "req-live", `Approve ${requested.challenge} — yes`));
    expect(core.listApprovals()).toHaveLength(1);
    // Simulate a restart: a FRESH plugin instance has an empty
    // in-memory pending map, so the redelivered reply has no prior
    // asked to bind to — audited, never finalized.
    const restarted = await hooksFor(root);
    await restarted.event(repliedEvent(sessionKey, "req-live", `Approve ${requested.challenge} — yes`));
    expect(core.listApprovals()).toHaveLength(1);
    expect(evidenceText()).toContain("approval-answer-no-match");
    // A redelivered reply for a still-LIVE ticket is equally inert
    // without its asked half: the ticket survives for a genuine
    // re-confirmation.
    await restarted.event(repliedEvent(sessionKey, "req-orphan", `Approve ${other.challenge} — yes`));
    expect(core.listApprovals()).toHaveLength(1);
    expect(core.hasValidApproval("SP-0001", spec.revision, "planning-approval")).toBe(true);
  });

  it("approving one artifact never changes any other artifact", async () => {
    const hooks = await hooksFor(root);
    await hooks.message({ sessionID: sessionKey });
    const first = JSON.parse(await callTool("artifact_propose", { kind: "spec", id: "SP-0001", title: "One", body: "First." })) as {
      revision: string;
    };
    const second = JSON.parse(await callTool("artifact_propose", { kind: "spec", id: "SP-0002", title: "Two", body: "Second." })) as {
      revision: string;
    };
    const requested = JSON.parse(await callTool("approval_request", {
      action: "planning-approval", scope: "SP-0001", revision: first.revision, rationale: "accept", securityImplications: "none",
    })) as { ticketId: string; challenge: string };
    const line = `CHRONO approval ${requested.challenge} :: planning-approval SP-0001 @${first.revision} :: accept`;
    await hooks.event(askedEvent(sessionKey, "req-scope", line));
    await hooks.event(repliedEvent(sessionKey, "req-scope", `Approve ${requested.challenge} — yes`));
    expect(core.hasValidApproval("SP-0001", first.revision, "planning-approval")).toBe(true);
    expect(core.hasValidApproval("SP-0002", second.revision, "planning-approval")).toBe(false);
    expect(core.listApprovals()).toHaveLength(1);
    expect(core.listApprovals()[0]?.scopeArtifactId).toBe("SP-0001");
  });

  it("malformed and historical event shapes never crash the plugin or approve", async () => {
    const hooks = await hooksFor(root);
    await hooks.message({ sessionID: sessionKey });
    const malformed: unknown[] = [
      { event: null },
      { event: "question.replied" },
      { event: { type: "question.replied" } },
      { event: { type: "question.replied", properties: null } },
      { event: { type: "question.replied", properties: { sessionID: "", requestID: "", answers: "Approve" } } },
      { event: { type: "question.replied", properties: { sessionID: sessionKey } } },
      { event: { type: "question.asked", properties: { sessionID: sessionKey, questions: [{ challenge: "Approve approve-TICKET-0001" }] } } },
      { event: { payload: { type: "question.v2.replied", properties: { sessionID: sessionKey, requestID: "req-hist", answers: [["Approve approve-TICKET-0001"]] } } } },
      { event: { type: "session.created", properties: {} } },
    ];
    for (const shape of malformed) {
      await expect(hooks.event(shape)).resolves.toBeUndefined();
    }
    // Hostile after-path payloads are observations, never crashes.
    await expect(hooks.after(null, null)).resolves.toBeUndefined();
    await expect(hooks.after({ tool: "question", sessionID: sessionKey, callID: "c" }, undefined)).resolves.toBeUndefined();
    expect(core.listApprovals()).toHaveLength(0);
    expect(evidenceText()).not.toContain("approval-finalized");
  });

  it("generated ceremony key matches the domain binding byte-for-byte", async () => {
    const module = (await import(pathToFileURL(pluginPath).href)) as Record<string, unknown>;
    const generated = module["chronoCeremonyKey"] as (b: unknown) => string | null;
    expect(typeof generated).toBe("function");
    const binding = {
      action: "planning-approval",
      project: root,
      requestId: "req-1",
      scopeArtifactId: "SP-0001",
      scopeRevision: `sha256:${"c".repeat(64)}`,
      sessionId: sessionKey,
      ticketId: "TICKET-0024",
    };
    expect(generated(binding)).toBe(buildCeremonyKey(binding));
    expect(generated({ ...binding, ticketId: "TICKET-24" })).toBeNull();
    expect(generated({ ...binding, sessionId: "" })).toBeNull();
    expect(generated(null)).toBeNull();
    const sanitize = module["sanitizeSigningPayload"] as (t: unknown, ts: string) => unknown;
    expect(sanitize({ action: "a" }, FIXED_TIME)).toBeNull();
    expect(sanitize(null, FIXED_TIME)).toBeNull();
    const safe = module["safeCanonicalizeJson"] as (v: unknown) => string | null;
    expect(safe(undefined)).toBeNull();
    expect(safe({ b: 1, a: [1, 2] })).toBe('{"a":[1,2],"b":1}');
  });

  it("doctor reports decision, result, authority, reason, and duplicates without secrets", async () => {
    const hooks = await hooksFor(root);
    await hooks.message({ sessionID: sessionKey });
    const spec = JSON.parse(await callTool("artifact_propose", { kind: "spec", id: "SP-0001", title: "Tasks", body: "Task contract." })) as {
      revision: string;
    };
    const requested = JSON.parse(await callTool("approval_request", {
      action: "planning-approval", scope: "SP-0001", revision: spec.revision, rationale: "accept", securityImplications: "none",
    })) as { ticketId: string; challenge: string };
    const line = `CHRONO approval ${requested.challenge} :: planning-approval SP-0001 @${spec.revision} :: accept`;
    await hooks.event(askedEvent(sessionKey, "req-doc", line));
    await hooks.event(rejectedEvent(sessionKey, "req-doc"));
    await hooks.event(askedEvent(sessionKey, "req-doc-ok", line));
    await hooks.event(repliedEvent(sessionKey, "req-doc-ok", `Approve ${requested.challenge} — yes`));
    // Pin the Core version so doctor opens the project read-only and
    // resolves finalized rows to Core-reported authority (an unpinned
    // project reports the failure path instead).
    const pin = new ChronoCore({ projectPath: root, runtime: "opencode", pinnedVersion: CHRONO_VERSION });
    pin.close();
    const out = runDoctor(root, { json: true, store: new MemoryKeyStore() });
    const report = JSON.parse(out.stdout) as {
      doctor: {
        ceremony: {
          events: Array<{ kind: string; ticket: string | null; decision: string | null; result: string | null; authoritative: boolean | null; reason: string | null; duplicate: boolean }>;
        };
      };
    };
    const finalized = report.doctor.ceremony.events.find((e) => e.kind === "approval-finalized");
    expect(finalized).toMatchObject({ ticket: requested.ticketId, decision: "approve", result: "recorded", authoritative: true, duplicate: false });
    const declined = report.doctor.ceremony.events.find((e) => e.kind === "approval-answer-declined");
    expect(declined).toMatchObject({ decision: "deny", result: "no-change" });
    expect(typeof declined?.reason).toBe("string");
    expect(JSON.stringify(report.doctor.ceremony)).not.toContain(gasparToken);
    expect(JSON.stringify(report.doctor.ceremony)).not.toContain(signingKey.slice(0, 20));
  });

  it("no product code is writable before implementation dispatch", async () => {
    const hooks = await hooksFor(root);
    await hooks.message({ sessionID: sessionKey });
    const gate = async (tool: string, args: unknown): Promise<void> => {
      await hooks.before({ tool, sessionID: sessionKey, callID: `call-${tool}` }, { args });
    };
    expect(Object.keys(tools).join(" ")).not.toMatch(/write|edit|bash|shell/);
    await expect(gate("write", { filePath: "src/app.ts", content: "x" })).rejects.toThrow();
    await expect(gate("edit", { filePath: "src/app.ts", oldText: "a", newText: "b" })).rejects.toThrow();
    await expect(gate("bash", { command: "npm run build" })).rejects.toThrow();
    expect(existsSync(join(root, "src/app.ts"))).toBe(false);
  });
});
