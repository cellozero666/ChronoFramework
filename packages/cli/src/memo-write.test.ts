/**
 * memo-write CLI + native tool tests (co-architect document writes).
 *
 * The CLI requests a document-write ticket binding path plus exact
 * content hash; finalize travels the existing approval-record path
 * (covered in approval-commands tests). The exact generated
 * `memo_write` tool executes for real through the host-held Gaspar
 * session: key material never reaches the model, and the ticket —
 * never chat text — is what the human confirms.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  computeRevisionHash,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore } from "@chrono/core";
import { runMemoWriteRequest } from "./approval-ceremony-cli.js";
import {
  CHRONO_NATIVE_TOOLS,
  OPENCODE_TOOLS_FILE_RELATIVE,
  OPENCODE_TOOLS_PACKAGE_RELATIVE,
  buildPlanningToolsFile,
  buildPlanningToolsPackage,
} from "./opencode-planning-tools.js";
import { buildOpenCodeAgentDefinition } from "./opencode-agent.js";

const REPO_ROOT = realpathSync(join(__dirname, "..", "..", ".."));
const BODY = "# Fix plan\n\n- Bug A: retry with backoff.\n";
const RATIONALE = "record the decided fix plan";
const IMPLICATIONS = "docs only; no code, secrets, or runtime effects";

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

describe("memo-write command", () => {
  let tempDir: string;
  let gasparToken = "";
  let gasparSecret = "";
  let restoreTty: () => void;

  function auth(): { as: string; sessionToken: string; json: true } {
    return { as: "gaspar", sessionToken: gasparToken, json: true };
  }

  function request(path: string, body: string = BODY): { exitCode: number; stdout: string; stderr: string } {
    mkdirSync(join(tempDir, "docs"), { recursive: true });
    return runMemoWriteRequest(tempDir, {
      path, body, rationale: RATIONALE, securityImplications: IMPLICATIONS, ...auth(),
    });
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-memo-cli-"));
    const core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
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
    const sessionNonce = randomBytes(16).toString("hex");
    const sessionTimestamp = "2026-09-11T00:00:00.000Z";
    const sessionSig = signApprovalPayload(
      buildSessionAuthorizationPayload({
        sessionRole: "gaspar", adapter: "test-adapter", runtime: "test-runtime",
        scopeModule: null, scopeWp: null, ttlSeconds: 3600, nonce: sessionNonce,
        authority: "PO", rationale: "test", timestamp: sessionTimestamp,
      }),
      pair.privateKeyPem
    );
    const opened = core.openSession(
      { role: "gaspar", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
      { poAuthorization: { nonce: sessionNonce, authority: "PO", rationale: "test", timestamp: sessionTimestamp, signature: sessionSig } }
    );
    expect(opened.ok).toBe(true);
    gasparSecret = opened.value!.token;
    gasparToken = `${opened.value!.id}/${gasparSecret}`;
    core.close();
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("issues a ticket binding path plus content hash, without secrets", () => {
    const out = request("docs/FIXES.md");
    expect(out.exitCode).toBe(0);
    const body = JSON.parse(out.stdout) as {
      ok: boolean; ticketId: string; challenge: string; scopeId: string;
      contentHash: string; baseRevision: null; alreadyCurrent: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.ticketId).toMatch(/^TICKET-[0-9]{4}$/);
    expect(body.challenge).toBe(`approve-${body.ticketId}`);
    expect(body.scopeId).toBe("doc:docs/FIXES.md");
    expect(body.contentHash).toBe(computeRevisionHash(BODY));
    expect(body.baseRevision).toBe(null);
    expect(body.alreadyCurrent).toBe(false);
    expect(out.stdout).not.toContain(gasparSecret);
    expect(out.stdout).not.toContain("CHRONO_SESSION_TOKEN");
    expect(out.stdout).not.toContain("PRIVATE KEY");
  });

  it("reports already-current content without a ticket", () => {
    mkdirSync(join(tempDir, "docs"), { recursive: true });
    writeFileSync(join(tempDir, "docs", "FIXES.md"), BODY, "utf8");
    const out = request("docs/FIXES.md");
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: true, alreadyCurrent: true, ticketId: null });
  });

  it("rejects non-documents, escapes, governed roots, and secret bodies", () => {
    expect(request("docs/plan.txt").exitCode).toBe(1);
    expect(JSON.parse(request("docs/plan.txt").stdout).error.code).toBe("VALIDATION_ERROR");
    expect(request("../escape.md").exitCode).toBe(1);
    expect(request(".chrono/context/evil.md").exitCode).toBe(1);
    expect(request("missing-dir/plan.md").exitCode).toBe(1);
    const leaked = runMemoWriteRequest(tempDir, {
      path: "docs/leak.md", body: "# t\npassword = 'hunter2-hunter2'\n",
      rationale: RATIONALE, securityImplications: IMPLICATIONS, ...auth(),
    });
    expect(leaked.exitCode).toBe(1);
    expect(JSON.parse(leaked.stdout).error.code).toBe("SECRET_DETECTED");
  });

  it("refuses requireQuestion tickets unless the question tool is exposed", () => {
    mkdirSync(join(tempDir, "docs"), { recursive: true });
    const yes = join(tempDir, "opencode-q-yes.sh");
    writeFileSync(yes, `#!/bin/sh\necho '{"tools":{"question":true}}'\n`, "utf8");
    chmodSync(yes, 0o755);
    const allowed = runMemoWriteRequest(tempDir, {
      path: "docs/FIXES.md", body: BODY, rationale: RATIONALE,
      securityImplications: IMPLICATIONS, ...auth(), requireQuestion: true, opencodeBinary: yes,
    });
    expect(allowed.exitCode).toBe(0);
    const no = join(tempDir, "opencode-q-no.sh");
    writeFileSync(no, `#!/bin/sh\necho '{"tools":{"question":false}}'\n`, "utf8");
    chmodSync(no, 0o755);
    const refused = runMemoWriteRequest(tempDir, {
      path: "docs/FIXES.md", body: BODY, rationale: RATIONALE,
      securityImplications: IMPLICATIONS, ...auth(), requireQuestion: true, opencodeBinary: no,
    });
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout).error.message).toContain("document-write ticket refused");
  });

  it("denies unauthenticated callers without a session", () => {
    mkdirSync(join(tempDir, "docs"), { recursive: true });
    const out = runMemoWriteRequest(tempDir, {
      path: "docs/FIXES.md", body: BODY, rationale: RATIONALE,
      securityImplications: IMPLICATIONS, as: "gaspar", json: true,
    });
    expect(out.exitCode).toBe(1);
  });
});

describe("chrono_memo_write native tool", () => {
  let tempDir: string;
  let root: string;
  let core: ChronoCore;
  let gasparSecret = "";
  let restoreTty: () => void;
  let savedEnv: Record<string, string | undefined>;
  const openSessionId = "memo-native-1";
  let tools: Record<string, { description: string; args: unknown; execute: (args: unknown, ctx: unknown) => Promise<string> }>;

  function tokenPath(): string {
    return join(
      tmpdir(),
      `chrono-gaspar-host-${createHash("sha256").update(`${root}|${openSessionId}`, "utf8").digest("hex").slice(0, 16)}.token`
    );
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
    tempDir = mkdtempSync(join(tmpdir(), "chrono-memo-native-"));
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
    // Fixture `opencode` oracle: memo_write always passes
    // --require-question, so fixtures answer the debug-agent question
    // the way a question-enabled OpenCode answers in production.
    const fixtureOpencode = join(root, "opencode-fixture.sh");
    writeFileSync(fixtureOpencode, `#!/bin/sh\necho '{"tools":{"question":true}}'\n`, "utf8");
    chmodSync(fixtureOpencode, 0o755);
    process.env["CHRONO_OPENCODE_BIN"] = fixtureOpencode;
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
    gasparSecret = opened.value!.token;
    writeFileSync(tokenPath(), `${opened.value!.id}/${gasparSecret}`, { mode: 0o600 });
    mkdirSync(join(root, "docs"), { recursive: true });
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

  it("is emitted, classified, and executes a real ticket request without leaking credentials", async () => {
    expect(CHRONO_NATIVE_TOOLS).toContain("chrono_memo_write");
    const def = tools["memo_write"]!;
    expect(def).toBeTruthy();
    expect(def.description.length).toBeGreaterThan(20);
    const out = await def.execute(
      { path: "docs/FIXES.md", body: BODY, rationale: RATIONALE, securityImplications: IMPLICATIONS },
      toolContext()
    );
    const parsed = JSON.parse(out) as { ok: boolean; ticketId: string; scopeId: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.ticketId).toMatch(/^TICKET-[0-9]{4}$/);
    expect(parsed.scopeId).toBe("doc:docs/FIXES.md");
    // The ticket authorizes nothing by itself: no file appears.
    expect(() => readFileSync(join(root, "docs", "FIXES.md"), "utf8")).toThrow();
    expect(out).not.toContain(gasparSecret);
  });

  it("denies an unproven session without reaching the Core", async () => {
    const def = tools["memo_write"]!;
    await expect(
      def.execute(
        { path: "docs/FIXES.md", body: BODY, rationale: RATIONALE, securityImplications: IMPLICATIONS },
        toolContext({ sessionID: "no-such-session" })
      )
    ).rejects.toThrow(/no Gaspar entry session/);
  });
});

describe("Gaspar memo-write contract", () => {
  it("routes user-requested documents through the petition, never shell", () => {
    const gaspar = buildOpenCodeAgentDefinition("gaspar");
    expect(gaspar).toContain("chrono_memo_write: allow");
    expect(gaspar).toContain("chrono_memo_write");
    expect(gaspar).toContain("single-use ticket");
    expect(gaspar).toContain("exact content hash");
    // Chat-only approval never authorizes; the Core writes, never Gaspar.
    expect(gaspar).toMatch(/chat.*alone authorizes nothing/i);
    expect(gaspar).toContain("the Core wrote the file");
    expect(gaspar).not.toContain("CHRONO_SESSION_TOKEN");
  });
});
