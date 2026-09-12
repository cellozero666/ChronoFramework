/**
 * Slice 10 tests — doctor, broker, entry, and uninstall operations.
 * Hermetic: full init flows with fixture binaries, memory keychain,
 * and injected confirmations. Real-runtime and paid-model acceptance
 * stays out; reported as open, never mocked as passed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { ChronoCore } from "@chrono/core";
import {
  buildApprovalPayload,
  buildSessionAuthorizationPayload,
  signApprovalPayload,
} from "@chrono/domain";
import { runSetup } from "./index.js";
import {
  buildKiroEntryRegistration,
  kiroEntryRegistrationPath,
} from "./gaspar-entry.js";
import { MemoryKeyStore } from "./keychain.js";
import {
  runInitFlow,
  runDoctor,
  runBrokerIssue,
  runBrokerRevoke,
  runBrokerList,
  runEntry,
  runUninstall,
  type FlowProbes,
} from "./init-flow.js";
import { FIXTURE_SKILL_MD } from "../test/test-skill-fixture.js";

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

function makeBins(dir: string): { rtk: string; runtime: string } {
  const rtk = join(dir, "rtk");
  writeFileSync(
    rtk,
    "#!/bin/sh\nif [ \"$1\" = \"gain\" ]; then echo 'Token Killer savings dashboard'; else echo 'rtk 0.44.0-test'; fi\n",
    "utf8"
  );
  chmodSync(rtk, 0o755);
  const runtime = join(dir, "opencode");
  writeFileSync(runtime, "#!/bin/sh\necho 'opencode 9.9.9-test'\n", "utf8");
  chmodSync(runtime, 0o755);
  return { rtk, runtime };
}

function flowProbes(bins: { rtk: string; runtime: string }): FlowProbes {
  return {
    execFile: (cmd: string[]) => {
      const [binary, ...args] = cmd as [string, ...string[]];
      const name = binary.split("/").pop() ?? binary;
      if (name === "git") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (binary === bins.rtk || name === "rtk") {
        if (args[0] === "--version") {
          return { exitCode: 0, stdout: "rtk 0.44.0-test\n", stderr: "" };
        }
        if (args[0] === "rewrite") {
          // Fixture mapping: raw pre-routing words are routed through
          // the genuine (fixture) binary (see init-flow.test.ts).
          const mapped = args
            .slice(1)
            .map((word) => `'${word.replace(/'/g, `'"'"'`)}'`)
            .join(" ");
          return { exitCode: 0, stdout: `rtk ${mapped}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: "Token Killer savings dashboard\n", stderr: "" };
      }
      if (binary === bins.runtime || name === "opencode") {
        return { exitCode: 0, stdout: "opencode 9.9.9-test\n", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `unknown fixture command: ${binary}` };
    },
    fetchSkill: async () => FIXTURE_SKILL_MD,
    readFile: (path: string): string | null => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    fileExists: (path: string): boolean => {
      try {
        return existsSync(path);
      } catch {
        return false;
      }
    },
    which: (binary: string): string | null => {
      if (binary === "rtk") {
        return bins.rtk;
      }
      if (binary === "opencode") {
        return bins.runtime;
      }
      return null;
    },
    homedir: () => join(bins.rtk, "..", "home"),
    platform: () => ({ os: "linux", arch: "arm64", node: "v22.0.0" }),
  };
}

function bootstrapSession(
  projectPath: string,
  store: MemoryKeyStore,
  role: "gaspar" | "PO",
  adapter: string,
  runtime: string
): { id: string; token: string } {
  const privateKey = store.readKey("po");
  if (privateKey === null) {
    throw new Error("PO key missing from test store");
  }
  const nonce = randomBytes(16).toString("hex");
  const timestamp = new Date().toISOString();
  const signature = signApprovalPayload(
    buildSessionAuthorizationPayload({
      sessionRole: role,
      adapter,
      runtime,
      scopeModule: null,
      scopeWp: null,
      ttlSeconds: 3600,
      nonce,
      authority: "PO",
      rationale: "test bootstrap",
      timestamp,
    }),
    privateKey
  );
  const core = new ChronoCore({ projectPath });
  try {
    const res = core.openSession(
      { role, adapter, runtime, ttlSeconds: 3600 },
      { poAuthorization: { nonce, authority: "PO", rationale: "test bootstrap", timestamp, signature } }
    );
    if (!res.ok) {
      throw new Error(`bootstrap failed: ${res.error?.message}`);
    }
    return { id: res.value!.id, token: res.value!.token };
  } finally {
    core.close();
  }
}

interface ReadyProject {
  readonly dir: string;
  readonly store: MemoryKeyStore;
  readonly gaspar: { id: string; token: string };
  readonly po: { id: string; token: string };
}

async function readyProject(dir: string, binDir: string): Promise<ReadyProject> {
  const restore = fakeInteractiveTerminal();
  try {
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const out = await runInitFlow(
      dir,
      { json: true, yes: true },
      { interactive: true, store },
      flowProbes(bins),
      (_plan, challenge) => challenge
    );
    expect(out.exitCode).toBe(0);
    const gaspar = bootstrapSession(dir, store, "gaspar", "opencode", "opencode");
    const po = bootstrapSession(dir, store, "PO", "opencode", "opencode");
    return { dir, store, gaspar, po };
  } finally {
    restore();
  }
}

describe("Doctor", () => {
  let tempDir: string;
  let binDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-doctor-"));
    binDir = mkdtempSync(join(tmpdir(), "chrono-doctor-bins-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it("reports missing projects without writing anything", () => {
    const out = runDoctor(tempDir, { json: true });
    expect(out.exitCode).toBe(1);
    const parsed = JSON.parse(out.stdout) as { doctor: { found: boolean } };
    expect(parsed.doctor.found).toBe(false);
    expect(existsSync(join(tempDir, ".chrono"))).toBe(false);
  });

  it("reports READY on a configured project with zero writes", async () => {
    const project = await readyProject(tempDir, binDir);
    const before = statSync(join(tempDir, ".chrono", "chrono.db")).mtimeMs;
    const out = runDoctor(
      tempDir,
      { json: true, as: "gaspar", session: project.gaspar }
    );
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as {
      ok: boolean;
      doctor: { entry: { ready: boolean; reasons: string[] }; projectState: string; broker: { active: number } };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.doctor.entry.ready).toBe(true);
    expect(parsed.doctor.projectState).toBe("ANALYZING");
    expect(parsed.doctor.broker.active).toBe(1);
    expect(statSync(join(tempDir, ".chrono", "chrono.db")).mtimeMs).toBe(before);
  });

  it("names drifted hooks with actionable reasons", async () => {
    const project = await readyProject(tempDir, binDir);
    writeFileSync(join(tempDir, ".opencode", "plugins", "chrono-gate.js"), "// drifted by hand\n", "utf8");
    const out = runDoctor(tempDir, { json: true, as: "gaspar", session: project.gaspar });
    expect(out.exitCode).toBe(1);
    const parsed = JSON.parse(out.stdout) as { doctor: { entry: { reasons: string[] } } };
    expect(parsed.doctor.entry.reasons.some((r) => r.includes("chrono-gate.js"))).toBe(true);
  });

  it("hides broker credentials without a privileged session", async () => {
    await readyProject(tempDir, binDir);
    const out = runDoctor(tempDir, { json: true });
    expect(out.exitCode).toBe(1);
    const parsed = JSON.parse(out.stdout) as { doctor: { entry: { reasons: string[] }; broker: { visible: boolean } } };
    expect(parsed.doctor.broker.visible).toBe(false);
    expect(parsed.doctor.entry.reasons.some((r) => r.includes("broker"))).toBe(true);
  });
});

describe("Broker and entry", () => {
  let tempDir: string;
  let binDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-broker-"));
    binDir = mkdtempSync(join(tmpdir(), "chrono-broker-bins-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it("lists metadata without secret hashes and revokes terminally", async () => {
    const project = await readyProject(tempDir, binDir);
    const listed = runBrokerList(tempDir, { json: true, as: "gaspar", session: project.gaspar });
    expect(listed.exitCode).toBe(0);
    const creds = (JSON.parse(listed.stdout) as { credentials: { id: string }[] }).credentials;
    expect(creds).toHaveLength(1);
    expect(listed.stdout).not.toContain("secret_hash");
    expect(listed.stdout).not.toContain(project.store.readKey("po") ?? "IMPOSSIBLE");
    // Second issue denies while one is active; revoke then re-issue works.
    const again = runBrokerIssue(tempDir, { json: true, as: "gaspar", session: project.gaspar });
    expect(again.exitCode).toBe(1);
    expect(
      runBrokerRevoke(tempDir, { id: creds[0]!.id, json: true, as: "gaspar", session: project.gaspar }).exitCode
    ).toBe(0);
    const reissued = runBrokerIssue(tempDir, { json: true, as: "gaspar", session: project.gaspar });
    expect(reissued.exitCode).toBe(0);
    expect((JSON.parse(reissued.stdout) as { id: string }).id).not.toBe(creds[0]!.id);
  });

  it("redeems entry with secret on stdin and confines the token to 0600", async () => {
    const project = await readyProject(tempDir, binDir);
    const listed = runBrokerList(tempDir, { json: true, as: "gaspar", session: project.gaspar });
    const brokerId = (JSON.parse(listed.stdout) as { credentials: { id: string }[] }).credentials[0]!.id;
    const account = readFileSync(join(tempDir, ".chrono", "broker-account"), "utf8").split("\n")[0] ?? "";
    const secret = project.store.readKey(account) ?? "";
    const tokenOut = join(binDir, "gaspar.token");
    const out = runEntry(
      tempDir,
      { adapter: "opencode", broker: brokerId, runtime: "opencode", tokenOut, json: true },
      secret
    );
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { sessionId: string; projection: { projectState: string } };
    expect(parsed.projection.projectState).toBe("ANALYZING");
    expect(out.stdout).not.toContain(secret);
    const tokenFile = readFileSync(tokenOut, "utf8").trim();
    expect(tokenFile).toMatch(/^[A-Z]+-\d+\/[0-9a-f]{64}$/);
    expect(tokenFile.startsWith(parsed.sessionId)).toBe(true);
    expect(statSync(tokenOut).mode & 0o777).toBe(0o600);
    // The minted session is live: projection refresh authorizes.
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      const slash = tokenFile.indexOf("/");
      const projection = core.gasparEntryProjection({
        actor: "gaspar",
        session: { id: tokenFile.slice(0, slash), token: tokenFile.slice(slash + 1) },
      });
      expect(projection.ok).toBe(true);
    } finally {
      core.close();
    }
  });

  it("denies forged secrets, missing token-out, and empty stdin", async () => {
    const project = await readyProject(tempDir, binDir);
    const listed = runBrokerList(tempDir, { json: true, as: "gaspar", session: project.gaspar });
    const brokerId = (JSON.parse(listed.stdout) as { credentials: { id: string }[] }).credentials[0]!.id;
    const forged = runEntry(
      tempDir,
      { adapter: "opencode", broker: brokerId, runtime: "opencode", tokenOut: join(binDir, "t.token"), json: true },
      "0".repeat(64)
    );
    expect(forged.exitCode).toBe(1);
    const noOut = runEntry(tempDir, { adapter: "opencode", broker: brokerId, runtime: "opencode", tokenOut: "", json: true }, "x");
    expect(noOut.exitCode).toBe(2);
    const noStdin = runEntry(
      tempDir,
      { adapter: "opencode", broker: brokerId, runtime: "opencode", tokenOut: join(binDir, "t2.token"), json: true },
      "   "
    );
    expect(noStdin.exitCode).toBe(2);
    expect(existsSync(join(binDir, "t.token"))).toBe(false);
  });

  it("identifies projection failure in human and JSON output without leaking secrets", async () => {
    // C1 evidence: an unreadable module registry denies redemption with
    // the stable PROJECTION_FAILED code on both surfaces, mints no
    // session file, and never echoes the broker secret or any token.
    const project = await readyProject(tempDir, binDir);
    const listed = runBrokerList(tempDir, { json: true, as: "gaspar", session: project.gaspar });
    const brokerId = (JSON.parse(listed.stdout) as { credentials: { id: string }[] }).credentials[0]!.id;
    const account = readFileSync(join(tempDir, ".chrono", "broker-account"), "utf8").split("\n")[0] ?? "";
    const secret = project.store.readKey(account) ?? "";
    expect(secret.length).toBeGreaterThan(0);
    const raw = new Database(join(tempDir, ".chrono", "chrono.db"));
    try {
      raw.exec("DROP TABLE artifact");
    } finally {
      raw.close();
    }
    const tokenOut = join(binDir, "denied.token");
    const jsonOut = runEntry(
      tempDir,
      { adapter: "opencode", broker: brokerId, runtime: "opencode", tokenOut, json: true },
      secret
    );
    expect(jsonOut.exitCode).toBe(1);
    const parsed = JSON.parse(jsonOut.stdout) as { ok: boolean; error: { code: string; message: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("PROJECTION_FAILED");
    expect(parsed.error.message.length).toBeGreaterThan(0);
    expect(jsonOut.stdout).not.toContain(secret);
    expect(jsonOut.stderr).not.toContain(secret);
    const humanOut = runEntry(
      tempDir,
      { adapter: "opencode", broker: brokerId, runtime: "opencode", tokenOut },
      secret
    );
    expect(humanOut.exitCode).toBe(1);
    expect(humanOut.stdout).toBe("");
    expect(humanOut.stderr).toContain("PROJECTION_FAILED");
    expect(humanOut.stderr).not.toContain(secret);
    expect(existsSync(tokenOut)).toBe(false);
  });
});

describe("Uninstall scopes", () => {
  let tempDir: string;
  let binDir: string;
  let restoreTty: () => void;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-uninstall-"));
    binDir = mkdtempSync(join(tmpdir(), "chrono-uninstall-bins-"));
    restoreTty = fakeInteractiveTerminal();
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it("removes hooks without touching user content or unselected runtimes", async () => {
    const project = await readyProject(tempDir, binDir);
    void project;
    // OpenCode-only setup never creates Claude/Kiro integration assets
    // (skill artifacts stay: one attested unit for all runtimes).
    expect(existsSync(join(tempDir, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(tempDir, ".claude", "agents"))).toBe(false);
    expect(existsSync(join(tempDir, ".kiro", "hooks"))).toBe(false);
    const out = runUninstall(tempDir, { scope: "hooks", json: true });
    expect(out.exitCode).toBe(0);
    expect(existsSync(join(tempDir, ".opencode", "plugins", "chrono-gate.js"))).toBe(false);
    expect(existsSync(join(tempDir, ".chrono", "hooks", "chrono-entry-session.sh"))).toBe(false);
    expect(existsSync(join(tempDir, ".chrono", "broker-account"))).toBe(false);
    // Doctor now reports drift instead of passing.
    const doctor = runDoctor(tempDir, { json: true });
    expect(doctor.exitCode).toBe(1);
  });

  it("revokes broker credentials and adapters with sessions", async () => {
    const project = await readyProject(tempDir, binDir);
    expect(runUninstall(tempDir, { scope: "broker", json: true, as: "gaspar", session: project.gaspar }).exitCode).toBe(0);
    const listed = runBrokerList(tempDir, { json: true, as: "gaspar", session: project.gaspar });
    expect((JSON.parse(listed.stdout) as { credentials: { revoked: boolean }[] }).credentials.every((c) => c.revoked)).toBe(true);
    expect(runUninstall(tempDir, { scope: "adapters", json: true, as: "PO", session: project.po }).exitCode).toBe(0);
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      expect(core.listAdapters().every((a) => a.status === "revoked")).toBe(true);
    } finally {
      core.close();
    }
  });

  it("destroys project data only with the exact typed challenge", async () => {
    await readyProject(tempDir, binDir);
    const fingerprint = createHash("sha256").update(tempDir, "utf8").digest("hex").slice(0, 8);
    const refusing = runUninstall(tempDir, { scope: "project-data", json: true }, { interactive: false, store: new MemoryKeyStore() }, () => null);
    expect(refusing.exitCode).toBe(2);
    expect(existsSync(join(tempDir, ".chrono"))).toBe(true);
    const mistyped = runUninstall(
      tempDir,
      { scope: "project-data", json: true },
      { interactive: true, store: new MemoryKeyStore() },
      () => "delete everything"
    );
    expect(mistyped.exitCode).toBe(2);
    expect(existsSync(join(tempDir, ".chrono"))).toBe(true);
    const destroyed = runUninstall(
      tempDir,
      { scope: "project-data", json: true },
      { interactive: true, store: new MemoryKeyStore() },
      (_text, challenge) => challenge
    );
    expect(destroyed.exitCode).toBe(0);
    expect(existsSync(join(tempDir, ".chrono"))).toBe(false);
    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it("rejects unknown scopes", () => {
    const out = runUninstall(tempDir, { scope: "everything", json: true });
    expect(out.exitCode).toBe(2);
  });
});

describe("Publish safety", () => {  it("declares no install/uninstall lifecycle hooks", async () => {
    const { fileURLToPath } = await import("node:url");
    const rootPkg = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(rootPkg, "utf8")) as {
      scripts?: Record<string, string>;
    };
    for (const key of ["preinstall", "install", "postinstall", "preuninstall", "uninstall", "prepublishOnly"]) {
      expect(pkg.scripts?.[key]).toBe(undefined);
    }
  });
});

describe("Kiro entry (hermetic contract, real runtime open)", () => {
  // C4 evidence at hermetic grade: setup emits the dual-surface entry
  // registration, the doctor reports Kiro as an environment blocker
  // (never ready), drift is named, and entry without routing proof is
  // denied. None of this claims real Kiro conformance: no Kiro binary
  // exists on this host and VERIFIED_KIRO_VERSIONS is empty.
  let tempDir: string;
  let binDir: string;
  let restoreTty: () => void;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-kiro-entry-"));
    binDir = mkdtempSync(join(tmpdir(), "chrono-kiro-entry-bins-"));
    restoreTty = fakeInteractiveTerminal();
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  function kiroEntrypoint(): string {
    const entrypoint = join(tempDir, "fixture-kiro.sh");
    writeFileSync(entrypoint, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'fixture-kiro 1.0'; else echo fixture-kiro-ok; fi\n", "utf8");
    chmodSync(entrypoint, 0o755);
    return entrypoint;
  }

  function approveKiroAdapter(store: MemoryKeyStore, entrypoint: string): void {
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      const privateKey = store.readKey("po");
      if (privateKey === null) {
        throw new Error("PO key missing from test store");
      }
      const po = bootstrapSession(tempDir, store, "PO", "opencode", "opencode");
      const poAuth = { actor: "PO", session: po };
      expect(
        core.registerAdapter(
          { id: "kiro", name: "Kiro", entrypoint, conformanceProof: [`${entrypoint} --version`] },
          poAuth
        ).ok
      ).toBe(true);
      const revision = core.adapterRegistrationHash("kiro");
      const timestamp = new Date().toISOString();
      const signature = signApprovalPayload(
        buildApprovalPayload({
          action: "adapter-registration",
          scopeArtifactId: "kiro",
          scopeRevision: revision,
          authority: "PO",
          rationale: "test",
          timestamp,
        }),
        privateKey
      );
      const recorded = core.recordApproval({
        action: "adapter-registration",
        scopeArtifactId: "kiro",
        scopeRevision: revision,
        authority: "PO",
        rationale: "test",
        timestamp,
        signature,
      });
      expect(recorded.ok).toBe(true);
      expect(core.approveAdapter("kiro", recorded.value!.id, poAuth).ok).toBe(true);
    } finally {
      core.close();
    }
  }

  function stubExec(entrypoint: string, rtkBin: string): (cmd: string[]) => { exitCode: number; stdout: string; stderr: string } {
    return (cmd: string[]) => {
      const [bin, ...args] = cmd as [string, ...string[]];
      if (bin === entrypoint && args[0] === "--version") {
        return { exitCode: 0, stdout: "fixture-kiro 1.0\n", stderr: "" };
      }
      if (bin === rtkBin) {
        if (args[0] === "--version") {
          return { exitCode: 0, stdout: "rtk 0.44.0-test\n", stderr: "" };
        }
        if (args[0] === "gain") {
          return { exitCode: 0, stdout: "Token Killer savings dashboard\n", stderr: "" };
        }
      }
      return { exitCode: 1, stdout: "", stderr: `unknown fixture command: ${bin}` };
    };
  }

  it("setup emits the dual-surface Kiro entry registration", async () => {
    const project = await readyProject(tempDir, binDir);
    const entrypoint = kiroEntrypoint();
    approveKiroAdapter(project.store, entrypoint);
    const out = runSetup(
      tempDir,
      { adapter: "kiro", runtime: "kiro", rtkBinary: join(binDir, "rtk"), json: true },
      stubExec(entrypoint, join(binDir, "rtk"))
    );
    expect(out.exitCode).toBe(0);
    const written = readFileSync(join(tempDir, kiroEntryRegistrationPath("kiro")), "utf8");
    expect(written).toBe(buildKiroEntryRegistration("kiro"));
    const triggers = (
      JSON.parse(written) as { hooks: { trigger: string }[] }
    ).hooks.map((h) => h.trigger).sort();
    expect(triggers).toEqual(["AgentSpawn", "SessionStart"]);
  });

  it("doctor reports Kiro as an environment blocker and names entry drift", async () => {
    const project = await readyProject(tempDir, binDir);
    const entrypoint = kiroEntrypoint();
    approveKiroAdapter(project.store, entrypoint);
    const setupOut = runSetup(
      tempDir,
      { adapter: "kiro", runtime: "kiro", rtkBinary: join(binDir, "rtk"), json: true },
      stubExec(entrypoint, join(binDir, "rtk"))
    );
    expect(setupOut.exitCode).toBe(0);
    const blocked = runDoctor(tempDir, { json: true, as: "gaspar", session: project.gaspar });
    expect(blocked.exitCode).toBe(1);
    const reasons = (JSON.parse(blocked.stdout) as { doctor: { entry: { reasons: string[] } } }).doctor.entry.reasons;
    expect(reasons.some((r) => r.includes("Kiro adapter present") && r.includes("C4"))).toBe(true);
    writeFileSync(join(tempDir, kiroEntryRegistrationPath("kiro")), '{"tampered":true}', "utf8");
    const drifted = runDoctor(tempDir, { json: true, as: "gaspar", session: project.gaspar });
    expect(drifted.exitCode).toBe(1);
    const driftReasons = (JSON.parse(drifted.stdout) as { doctor: { entry: { reasons: string[] } } }).doctor.entry.reasons;
    expect(driftReasons.some((r) => r.includes("chrono-entry-kiro.json"))).toBe(true);
  });

  it("denies Kiro entry without routing proof or registration", async () => {
    const project = await readyProject(tempDir, binDir);
    const listed = runBrokerList(tempDir, { json: true, as: "gaspar", session: project.gaspar });
    const brokerId = (JSON.parse(listed.stdout) as { credentials: { id: string }[] }).credentials[0]!.id;
    const account = readFileSync(join(tempDir, ".chrono", "broker-account"), "utf8").split("\n")[0] ?? "";
    const secret = project.store.readKey(account) ?? "";
    // Unregistered Kiro adapter: no entry.
    const ghost = runEntry(
      tempDir,
      { adapter: "kiro", broker: brokerId, runtime: "opencode", tokenOut: join(binDir, "k.token"), json: true },
      secret
    );
    expect(ghost.exitCode).toBe(1);
    // Approved-but-unproven Kiro adapter: entry reaches the routing gate
    // and denies there.
    const entrypoint = kiroEntrypoint();
    approveKiroAdapter(project.store, entrypoint);
    const unproven = runEntry(
      tempDir,
      { adapter: "kiro", broker: brokerId, runtime: "opencode", tokenOut: join(binDir, "k2.token"), json: true },
      secret
    );
    expect(unproven.exitCode).toBe(1);
    expect((JSON.parse(unproven.stdout) as { error: { code: string } }).error.code).toBe("RTK_ROUTING_FAILURE");
    expect(existsSync(join(binDir, "k2.token"))).toBe(false);
  });
});
