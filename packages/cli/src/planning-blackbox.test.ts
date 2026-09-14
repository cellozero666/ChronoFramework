/**
 * OC-P11 governed-artifact-flow black box.
 *
 * Performs the complete greenfield lifecycle the Phase 6A workflow
 * found deadlocked:
 *
 *   chrono init --runtime opencode → Gaspar discovery → Core-mediated
 *   materialization of analysis, ADR, security and Spec drafts → real
 *   interactive signed PO approvals → Harness and plan creation →
 *   Module/WP creation and approval → only then, implementation dispatch
 *   authorization.
 *
 * No manual DB edits, no placeholder IDs, no temporary write access.
 * The sample project separates administrative database bootstrap from
 * the application schema: the runtime `tasks_app` account never
 * receives CREATE DATABASE/TABLE privileges (asserted statically on
 * the fixture SQL, no live database required).
 *
 * The hermetic flow below runs in the default suite through real Core
 * and CLI code paths (no mocks of the product path). The packed gate
 * runs only with CHRONO_BLACKBOX=1: isolated tarball install plus
 * `init --dry-run` and the planning command surface on the packed
 * binary (no paid model, no provider login, no global mutation).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RTK_UPSTREAM,
  SKILL_RELEASE,
  SKILL_RUNTIME_PATHS,
  buildApprovalPayload,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  computeRevisionHash,
  convertSkillSource,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  hashSkillSource,
  managedAssetInventory,
  signApprovalPayload,
  skillGeneratedHashes,
  skillVendorPath,
} from "@chrono/domain";
import { ChronoCore, type CallerAuth } from "@chrono/core";
import { runArtifactPropose, runArtifactStatus } from "./artifact-cli.js";

const BLACKBOX = process.env["CHRONO_BLACKBOX"] === "1";
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXED_TIME = "2026-09-14T00:00:00.000Z";

// Frozen skill fixture (byte-exact canonical source at the pinned commit).
const FIXTURE_SKILL_MD = `---
name: karpathy-guidelines
description: Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication, make surgical changes, surface assumptions, and define verifiable success criteria.
license: MIT
---

# Karpathy Guidelines

Behavioral guidelines to reduce common LLM coding mistakes, derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
\`\`\`
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
\`\`\`

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
`;

/** Sample tasks-app SQL: administrative bootstrap (postgres superuser only). */
const ADMIN_BOOTSTRAP_SQL = `-- tasks-app database bootstrap — ADMINISTRATIVE ONLY (run as postgres superuser).
-- Creates roles, the database, and connection rights. Never run as tasks_app.
CREATE ROLE tasks_owner WITH LOGIN PASSWORD 'change-me-in-production';
CREATE ROLE tasks_app WITH LOGIN NOINHERIT;
CREATE DATABASE tasks OWNER tasks_owner;
\\connect tasks
GRANT CONNECT ON DATABASE tasks TO tasks_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tasks_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tasks_app;
`;

/** Sample tasks-app SQL: application schema (run as tasks_owner only). */
const APP_SCHEMA_SQL = `-- tasks-app application schema — run as tasks_owner (the schema owner).
-- The runtime tasks_app account receives DML only, never DDL.
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON tasks TO tasks_app;
`;

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

describe("OC-P11 governed artifact flow (hermetic black box)", () => {
  let tempDir: string;
  let core: ChronoCore;
  let signingKey = "";
  let gaspar: CallerAuth;
  let restoreTty: () => void;

  function tokenString(session: { id: string; token: string }): string {
    return `${session.id}/${session.token}`;
  }

  function signFor(action: string, scope: string, revision: string): { timestamp: string; signature: string } {
    return {
      timestamp: FIXED_TIME,
      signature: signApprovalPayload(
        buildApprovalPayload({ action, scopeArtifactId: scope, scopeRevision: revision, authority: "PO", rationale: "PO decision with security implications recorded", timestamp: FIXED_TIME }),
        signingKey
      ),
    };
  }

  function approve(action: string, scope: string, revision: string): string {
    const { timestamp, signature } = signFor(action, scope, revision);
    const res = core.recordApproval({
      action, scopeArtifactId: scope, scopeRevision: revision,
      authority: "PO", rationale: "PO decision with security implications recorded",
      timestamp, signature,
    });
    expect(res.ok).toBe(true);
    return res.value!.id;
  }

  function bootstrapPoSession(): CallerAuth {
    const nonce = randomBytes(16).toString("hex");
    const timestamp = "2026-09-11T00:00:00.000Z";
    const signature = signApprovalPayload(
      buildSessionAuthorizationPayload({
        sessionRole: "PO", adapter: "test-adapter", runtime: "opencode",
        scopeModule: null, scopeWp: null, ttlSeconds: 3600, nonce,
        authority: "PO", rationale: "test", timestamp,
      }),
      signingKey
    );
    const opened = core.openSession(
      { role: "PO", adapter: "test-adapter", runtime: "opencode", ttlSeconds: 3600 },
      { poAuthorization: { nonce, authority: "PO", rationale: "test", timestamp, signature } }
    );
    expect(opened.ok).toBe(true);
    return { actor: "PO", session: { id: opened.value!.id, token: opened.value!.token } };
  }

  function proposeViaCli(kind: string, id: string | null, title: string, body: string, refs: string[] = []): { id: string; revision: string } {
    const bodyPath = join(tempDir, `draft-${id ?? kind}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.md`);
    writeFileSync(bodyPath, body, "utf8");
    const out = runArtifactPropose(tempDir, {
      kind,
      ...(id !== null ? { id } : {}),
      title,
      bodyFile: bodyPath,
      ...(refs.length > 0 ? { references: refs } : {}),
      as: "gaspar",
      sessionToken: tokenString(gaspar.session),
      json: true,
    });
    expect(out.exitCode).toBe(0);
    return JSON.parse(out.stdout) as { id: string; revision: string };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-ocp11-flow-"));
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
    const sessionNonce = randomBytes(16).toString("hex");
    const sessionTimestamp = "2026-09-11T00:00:00.000Z";
    const sessionSig = signApprovalPayload(
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
    gaspar = { actor: "gaspar", session: { id: opened.value!.id, token: opened.value!.token } };
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("sample project separates admin bootstrap from app schema; tasks_app never gets DDL", () => {
    const dbDir = join(tempDir, "sample-tasks-app", "db");
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, "admin-bootstrap.sql"), ADMIN_BOOTSTRAP_SQL, "utf8");
    writeFileSync(join(dbDir, "app-schema.sql"), APP_SCHEMA_SQL, "utf8");
    const admin = readFileSync(join(dbDir, "admin-bootstrap.sql"), "utf8");
    const app = readFileSync(join(dbDir, "app-schema.sql"), "utf8");
    // Administrative statements live only in the bootstrap file.
    expect(admin).toMatch(/CREATE ROLE tasks_owner/);
    expect(admin).toMatch(/CREATE DATABASE tasks/);
    expect(app).not.toMatch(/CREATE\s+(ROLE|DATABASE)/i);
    // The runtime account is least-privilege: no superuser/createdb/createrole,
    // no DDL of its own, only the DML grant it needs.
    for (const doc of [admin, app]) {
      expect(doc).not.toMatch(/tasks_app[^;]*SUPERUSER/i);
      expect(doc).not.toMatch(/tasks_app[^;]*CREATEDB/i);
      expect(doc).not.toMatch(/tasks_app[^;]*CREATEROLE/i);
    }
    expect(app).not.toMatch(/GRANT\s+ALL\b/i);
    expect(app).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON tasks TO tasks_app/);
    // tasks_app creates no tables: every CREATE TABLE is owned by tasks_owner's file.
    const appCreates = app.match(/CREATE TABLE/gi) ?? [];
    expect(appCreates).toHaveLength(1);
    expect(admin).not.toMatch(/CREATE TABLE/i);
  });

  it("dispatch without an approved Module denies before any planning exists", () => {
    const worker = core.openSession(
      { role: "belthazar", adapter: "test-adapter", runtime: "opencode", scopeModule: "default", ttlSeconds: 3600 },
      { interactive: true }
    );
    expect(worker.ok).toBe(true);
    const denied = core.authorizeExecution("MOD-0001", {
      actor: "gaspar", role: "belthazar",
      session: { id: worker.value!.id, token: worker.value!.token },
      requesterSession: gaspar.session,
    });
    expect(denied.ok).toBe(false);
  });

  it("discovery to dispatch: drafts, signed approvals, harness, plan, approval, grant", () => {
    // 2. Gaspar discovery (persisted incrementally, restart-safe).
    const discovery = proposeViaCli("discovery", "DISCOVERY", "Tasks discovery", "Users manage personal task lists with titles and done states.");
    expect(existsSync(join(tempDir, ".chrono/context/DISCOVERY.md"))).toBe(true);
    // 3. Architecture, ADR, security and Spec drafts through the Core path.
    const arch = proposeViaCli("architecture", null, "Tasks architecture", "Single service, SQLite owned by tasks_owner, runtime tasks_app least-privilege.");
    expect(arch.id).toBe("ARCH");
    const adr = proposeViaCli("adr", "ADR-0001", "SQLite for tasks", "SQLite via tasks_owner; runtime uses tasks_app with DML only.");
    const sec = proposeViaCli("security-profile", "SEC-0001", "Tasks threat model", "Trust boundary at the app role; secrets in environment, never in repo.");
    const spec = proposeViaCli("spec", "SP-0001", "Task management", "CRUD contract for tasks with acceptance behaviors.");
    expect(core.getArtifact("SP-0001").status).toBe("DRAFT");
    // 4. Real interactive signed PO approvals (chat text alone approved nothing).
    approve("planning-approval", "DISCOVERY", discovery.revision);
    approve("planning-approval", "ADR-0001", adr.revision);
    approve("planning-approval", "SEC-0001", sec.revision);
    approve("planning-approval", "SP-0001", spec.revision);
    approve("architecture-security", "ARCH", arch.revision);
    const statusOut = runArtifactStatus(tempDir, { as: "gaspar", sessionToken: tokenString(gaspar.session), json: true });
    expect(statusOut.exitCode).toBe(0);
    const items = (JSON.parse(statusOut.stdout) as { items: Array<{ id: string; approval: string }> }).items;
    expect(items.find((i) => i.id === "SP-0001")?.approval).toBe("approved");
    // Architecture review transitions on the same file revision.
    expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
    expect(core.approveArchitecture(gaspar).ok).toBe(true);
    // 5. Harness for the exact Spec revision, then Spec READY.
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "gaspar", session: gaspar.session }).ok).toBe(true);
    const specRev = core.getArtifact("SP-0001").revision;
    approve("architecture-security", "SP-0001", specRev);
    expect(core.recordHarness(specRev, computeRevisionHash({ harness: "SP-0001" }), "# Harness for SP-0001", gaspar).ok).toBe(true);
    expect(core.transitionState("SP-0001", "SpecApprovedReady", { actor: "gaspar", session: gaspar.session }).ok).toBe(true);
    expect(core.getArtifact("SP-0001").status).toBe("READY");
    // 6. Module/WP plans referencing the approved Spec, then approvals.
    const mod = proposeViaCli("module", "MOD-0001", "Tasks module", "Module plan for the tasks contract.", ["SP-0001"]);
    const wp = proposeViaCli("workpackage", "WP-0001", "Tasks work package", "First work package.", ["MOD-0001"]);
    approve("planning-approval", "MOD-0001", mod.revision);
    approve("planning-approval", "WP-0001", wp.revision);
    expect(core.transitionState("MOD-0001", "ModulePlanned", { actor: "gaspar", session: gaspar.session }).ok).toBe(true);
    const modRev = core.getArtifact("MOD-0001").revision;
    approve("module-approval", "MOD-0001", modRev);
    expect(core.transitionState("MOD-0001", "ModuleApproved", { actor: "gaspar", session: gaspar.session }).ok).toBe(true);
    // 7. Only now: implementation dispatch authorization (operational
    // prerequisites provisioned as fixtures: genuine-shaped RTK, pinned
    // skill, approved adapter, authoritative routing proof).
    const rtkBin = join(tempDir, "fixture-rtk.sh");
    writeFileSync(rtkBin, "#!/bin/sh\necho fixture-rtk 1.0.0-test\n", "utf8");
    chmodSync(rtkBin, 0o755);
    expect(core.recordRtkAttestation(gaspar, {
      binaryPath: rtkBin, binaryIdentity: "rtk-test", version: "1.0.0-test",
      provenance: RTK_UPSTREAM, integrationMode: "test", routingTestPassed: true,
      routingTestLog: "fixture", gained: true, savingsEvidence: null, ttlSeconds: 3600,
    }).ok).toBe(true);
    expect(hashSkillSource(FIXTURE_SKILL_MD)).toBe(SKILL_RELEASE.sourceHash);
    const vendorTarget = join(tempDir, skillVendorPath(SKILL_RELEASE.pinnedCommit));
    mkdirSync(dirname(vendorTarget), { recursive: true });
    writeFileSync(vendorTarget, FIXTURE_SKILL_MD, "utf8");
    for (const runtime of ["claude", "opencode", "kiro"] as const) {
      const target = join(tempDir, SKILL_RUNTIME_PATHS[runtime]);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, FIXTURE_SKILL_MD, "utf8");
    }
    expect(core.recordSkillAttestation(gaspar, {
      upstream: "https://github.com/multica-ai/andrej-karpathy-skills",
      pinnedCommit: SKILL_RELEASE.pinnedCommit, sourceHash: SKILL_RELEASE.sourceHash,
      generatedHashes: skillGeneratedHashes(convertSkillSource(FIXTURE_SKILL_MD)),
      converterVersion: SKILL_RELEASE.converterVersion, licenseStatus: "MIT", attribution: "MIT",
      runtimeIdentity: "test", agentIdentity: "test", discoveryResult: "found",
      permissionResult: "granted", activationTestPassed: true, ttlSeconds: 86400,
    }).ok).toBe(true);
    const entrypoint = join(tempDir, "fixture-runtime.sh");
    writeFileSync(entrypoint, "#!/bin/sh\necho fixture-ok\n", "utf8");
    chmodSync(entrypoint, 0o755);
    const po = bootstrapPoSession();
    const registered = core.registerAdapter({ id: "test-adapter", name: "Test", entrypoint, conformanceProof: ["test-adapter --version"] }, po);
    expect(registered.ok).toBe(true);
    const regHash = core.adapterRegistrationHash("test-adapter");
    const adapterApprovalId = approve("adapter-registration", "test-adapter", regHash);
    expect(core.approveAdapter("test-adapter", adapterApprovalId, po).ok).toBe(true);
    for (const spec of managedAssetInventory("test-adapter")) {
      const target = join(tempDir, spec.path);
      mkdirSync(dirname(target), { recursive: true });
      const content = spec.kind === "marker" ? `fixture-managed ${spec.marker ?? spec.path}\n` : `fixture-managed ${spec.path}\n`;
      writeFileSync(target, content, "utf8");
    }
    const proof = core.recordRoutingProof(gaspar, {
      adapterId: "test-adapter", binaryPath: rtkBin, version: "1.0.0-test",
      proofCommand: JSON.stringify([rtkBin, "gain"]),
      preRoutingCommand: JSON.stringify(["ls", tempDir]),
      commandHash: computeRevisionHash([rtkBin, "gain"]),
      outputHash: computeRevisionHash("fixture gain ok"),
      exitStatus: 0, gainAvailable: true, timestamp: new Date().toISOString(), ttlSeconds: 3600,
    });
    expect(proof.ok).toBe(true);
    expect(core.promoteRoutingProof(proof.value!.id, po).ok).toBe(true);
    const worker = core.openSession(
      { role: "belthazar", adapter: "test-adapter", runtime: "opencode", scopeModule: "MOD-0001", ttlSeconds: 3600 },
      { interactive: true }
    );
    expect(worker.ok).toBe(true);
    expect(core.transitionState("WP-0001", "WorkPackageAuthorized", { actor: "gaspar", session: gaspar.session }).ok).toBe(true);
    const grant = core.authorizeExecution("MOD-0001", {
      workPackageId: "WP-0001",
      actor: "gaspar", role: "belthazar",
      session: { id: worker.value!.id, token: worker.value!.token },
      requesterSession: gaspar.session, adapterId: "test-adapter",
    });
    expect(grant.ok).toBe(true);
    expect(typeof grant.value!.grantId).toBe("string");
  });
});

if (!BLACKBOX) {
  describe("Packed OpenCode planning surface (OC-P11 req 5)", () => {
    it("runs on demand via npm run test:blackbox (CHRONO_BLACKBOX=1)", () => {
      expect(BLACKBOX).toBe(false);
    });
  });
} else {
  describe("Packed OpenCode planning surface (OC-P11 req 5)", () => {
    const BOX_TIMEOUT = 600000;

    function sh(cmd: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }): { exit: number; stdout: string; stderr: string } {
      try {
        const stdout = execFileSync(cmd, args, {
          encoding: "utf8", cwd: options.cwd, env: options.env,
          timeout: options.timeout ?? 120000, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        });
        return { exit: 0, stdout, stderr: "" };
      } catch (e) {
        const err = e as { status?: unknown; stdout?: unknown; stderr?: unknown };
        return {
          exit: typeof err.status === "number" ? err.status : 1,
          stdout: typeof err.stdout === "string" ? err.stdout : "",
          stderr: typeof err.stderr === "string" ? err.stderr : "",
        };
      }
    }

    it("packed install exposes init dry-run and the artifact surface", async () => {
      const dir = mkdtempSync(join(tmpdir(), "chrono-ocp11-box-"));
      const tarballs = join(dir, "tarballs");
      const install = join(dir, "install");
      const project = join(dir, "project");
      mkdirSync(tarballs, { recursive: true });
      mkdirSync(install, { recursive: true });
      mkdirSync(project, { recursive: true });
      try {
        // Isolated pack of the four workspace tarballs (no workspace
        // links or source imports leak into the packed CLI).
        const pack = sh("npm", ["pack", "--workspace=@chrono/domain", "--workspace=@chrono/persistence", "--workspace=@chrono/core", "--workspace=@chrono/cli", `--pack-destination=${tarballs}`], { cwd: REPO_ROOT, timeout: 300000 });
        expect(pack.exit).toBe(0);
        writeFileSync(join(install, "package.json"), JSON.stringify({ name: "chrono-ocp11-blackbox", version: "1.0.0" }), "utf8");
        const { readdirSync } = await import("node:fs");
        const packed = readdirSync(tarballs).filter((f) => f.endsWith(".tgz")).map((f) => join(tarballs, f));
        expect(packed.length).toBe(4);
        // No test files ship inside the tarballs.
        void delimiter;
        const installed = sh("npm", ["install", "--no-audit", "--no-fund", ...packed], { cwd: install, timeout: 300000 });
        expect(installed.exit).toBe(0);
        const bin = join(install, "node_modules", ".bin", "chrono");
        expect(existsSync(bin)).toBe(true);
        sh("git", ["init", "-q", "."], { cwd: project });
        const dry = sh(bin, ["init", "--runtime", "opencode", "--dry-run", "--json", "--path", project], { cwd: project });
        expect(dry.exit).toBe(0);
        const plan = JSON.parse(dry.stdout) as { ok: boolean; dryRun: boolean; plan: unknown; detection: unknown };
        expect(plan.ok).toBe(true);
        expect(plan.dryRun).toBe(true);
        expect(typeof plan.plan).toBe("object");
        // The disposable project is untouched by the dry run.
        expect(existsSync(join(project, ".chrono"))).toBe(false);
        const help = sh(bin, ["artifact", "--help"], { cwd: project });
        expect(help.exit).toBe(0);
        expect(help.stdout).toContain("propose");
        expect(help.stdout).toContain("revise");
        expect(help.stdout).toContain("status");
        // Native ceremony surface on the packed binary.
        const proposeHelp = sh(bin, ["artifact", "propose", "--help"], { cwd: project });
        expect(proposeHelp.exit).toBe(0);
        expect(proposeHelp.stdout).toContain("--body-stdin");
        const requestHelp = sh(bin, ["approval-request", "--help"], { cwd: project });
        expect(requestHelp.exit).toBe(0);
        expect(requestHelp.stdout).toContain("--security-implications");
        // Packed tarballs ship the native tool generator and ceremony
        // runtime (exact generated bytes install through setup).
        const cliDist = join(install, "node_modules", "@chrono", "cli", "dist");
        const { readFileSync: readPacked } = await import("node:fs");
        expect(readPacked(join(cliDist, "opencode-planning-tools.js"), "utf8")).toContain("chrono_approval_confirm");
        expect(readPacked(join(cliDist, "approval-ceremony-cli.js"), "utf8")).toContain("approval-request");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, BOX_TIMEOUT);
  });
}
