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
  realpathSync,
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
import { runSetup, runRtkProve, runRtkPromote } from "./index.js";
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

function flowProbes(
  bins: { rtk: string; runtime: string },
  opts: { doctorStore?: MemoryKeyStore } = {}
): FlowProbes & { doctorStore: MemoryKeyStore | null } {
  const fake: FlowProbes & { doctorStore: MemoryKeyStore | null } = {
    // Wired by the caller to the run's keychain: the simulated doctor
    // child computes the REAL public verification a separate process
    // would see.
    doctorStore: opts.doctorStore ?? null,
    execFile: (cmd: string[]) => {
      if (cmd.includes("doctor")) {
        const pathIndex = cmd.indexOf("--path");
        const root = pathIndex >= 0 && typeof cmd[pathIndex + 1] === "string" ? (cmd[pathIndex + 1] as string) : null;
        if (root === null || fake.doctorStore === null) {
          return { exitCode: 1, stdout: "", stderr: "doctor child not wired in fixture" };
        }
        return runDoctor(root, { json: true, store: fake.doctorStore });
      }
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
  return fake;
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
      flowProbes(bins, { doctorStore: store }),
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
    // No session: the public verification path alone must confirm
    // readiness (OC-P6 one-command contract).
    const out = runDoctor(tempDir, { json: true, store: project.store });
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as {
      ok: boolean;
      doctor: {
        entry: { ready: boolean; reasons: string[] };
        projectState: string;
        setupStep: string;
        broker: { active: number; state: string; brokerId: string | null };
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.doctor.entry.ready).toBe(true);
    expect(parsed.doctor.projectState).toBe("ANALYZING");
    expect(parsed.doctor.setupStep).toBe("READY");
    expect(parsed.doctor.broker.active).toBe(1);
    expect(parsed.doctor.broker.state).toBe("active");
    expect(typeof parsed.doctor.broker.brokerId).toBe("string");
    expect(statSync(join(tempDir, ".chrono", "chrono.db")).mtimeMs).toBe(before);
  });

  it("names drifted hooks with actionable reasons", async () => {
    const project = await readyProject(tempDir, binDir);
    writeFileSync(join(tempDir, ".opencode", "plugins", "chrono-gate.js"), "// drifted by hand\n", "utf8");
    const out = runDoctor(tempDir, { json: true, store: project.store });
    expect(out.exitCode).toBe(1);
    const parsed = JSON.parse(out.stdout) as { doctor: { entry: { reasons: string[] } } };
    expect(parsed.doctor.entry.reasons.some((r) => r.includes("chrono-gate.js"))).toBe(true);
  });

  it("verifies broker health publicly without a privileged session", async () => {
    // OC-P6: broker readiness is established without any gaspar/PO
    // session; only non-sensitive metadata appears in the report.
    const project = await readyProject(tempDir, binDir);
    const account = readFileSync(join(tempDir, ".chrono", "broker-account"), "utf8").split("\n")[0] ?? "";
    const secret = project.store.readKey(account) ?? "";
    expect(secret.length).toBeGreaterThan(0);
    const out = runDoctor(tempDir, { json: true, store: project.store });
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as {
      ok: boolean;
      doctor: { broker: { visible: boolean; active: number; revoked: number; state: string; brokerId: string } };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.doctor.broker.visible).toBe(true);
    expect(parsed.doctor.broker.state).toBe("active");
    expect(parsed.doctor.broker.active).toBe(1);
    const haystack = out.stdout;
    expect(haystack).not.toContain(secret);
    expect(haystack).not.toContain("secret_hash");
    expect(haystack).not.toContain("secretHash");
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
    const doctor = runDoctor(tempDir, { json: true, store: project.store });
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
    // Canonical spelling: setup executes (and compares) the registered
    // canonical entrypoint.
    return realpathSync(entrypoint);
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
    const blocked = runDoctor(tempDir, { json: true, store: project.store });
    expect(blocked.exitCode).toBe(1);
    const reasons = (JSON.parse(blocked.stdout) as { doctor: { entry: { reasons: string[] } } }).doctor.entry.reasons;
    expect(reasons.some((r) => r.includes("Kiro adapter present") && r.includes("C4"))).toBe(true);
    writeFileSync(join(tempDir, kiroEntryRegistrationPath("kiro")), '{"tampered":true}', "utf8");
    const drifted = runDoctor(tempDir, { json: true, store: project.store });
    expect(drifted.exitCode).toBe(1);
    const driftReasons = (JSON.parse(drifted.stdout) as { doctor: { entry: { reasons: string[] } } }).doctor.entry.reasons;
    expect(driftReasons.some((r) => r.includes("chrono-entry-kiro.json"))).toBe(true);
  });

  it("warns (not denies) Kiro entry without routing proof; still denies unregistered adapters (ADR-009)", async () => {
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
    // Approved-but-unproven Kiro adapter: RTK posture is advisory-only
    // (ADR-009), so entry succeeds with a recorded RtkWarning instead of
    // denying at the routing gate.
    const entrypoint = kiroEntrypoint();
    approveKiroAdapter(project.store, entrypoint);
    const unproven = runEntry(
      tempDir,
      { adapter: "kiro", broker: brokerId, runtime: "opencode", tokenOut: join(binDir, "k2.token"), json: true },
      secret
    );
    expect(unproven.exitCode).toBe(0);
    expect(existsSync(join(binDir, "k2.token"))).toBe(true);
  });
});

describe("Broker health projection (OC-P6)", () => {
  let tempDir: string;
  let binDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-ocp6-"));
    binDir = mkdtempSync(join(tmpdir(), "chrono-ocp6-bins-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  /** Keychain that refuses every read: inaccessible is not missing. */
  class LockedKeyStore extends MemoryKeyStore {
    override readKey(_account: string): string | null {
      throw new Error("OS keychain locked");
    }
  }

  type BrokerFragment = {
    visible: boolean;
    active: number;
    revoked: number;
    state: string;
    brokerId: string | null;
    detail: string;
  };

  function brokerOf(out: { stdout: string }): BrokerFragment {
    return (JSON.parse(out.stdout) as { doctor: { broker: BrokerFragment } }).doctor.broker;
  }

  function brokerSecret(project: ReadyProject): { account: string; secret: string } {
    const account = readFileSync(join(project.dir, ".chrono", "broker-account"), "utf8").split("\n")[0] ?? "";
    const secret = project.store.readKey(account) ?? "";
    expect(secret.length).toBeGreaterThan(0);
    return { account, secret };
  }

  it("reports a missing broker record without ever reading ready", async () => {
    // A project initialized but never issued a broker credential:
    // setup walked to GASPAR_ENTRY_PREPARED so the broker signal is
    // isolated from setup noise.
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      expect(core.init().ok).toBe(true);
      for (const step of ["DETECTED", "CONSENTED", "PROJECT_INITIALIZED", "PO_ENROLLED"] as const) {
        expect(core.advanceSetupState(step as never, { seeded: true }).ok).toBe(true);
      }
    } finally {
      core.close();
    }
    const out = runDoctor(tempDir, { json: true, store: new MemoryKeyStore() });
    expect(out.exitCode).toBe(1);
    const broker = brokerOf(out);
    expect(broker.state).toBe("missing");
    expect(broker.brokerId).toBe(null);
    expect(broker.active).toBe(0);
  });

  it("reports a missing keychain secret as missing, never as unknown", async () => {
    const project = await readyProject(tempDir, binDir);
    const { account } = brokerSecret(project);
    project.store.deleteKey(account);
    const out = runDoctor(tempDir, { json: true, store: project.store });
    expect(out.exitCode).toBe(1);
    const parsed = JSON.parse(out.stdout) as { ok: boolean; doctor: { entry: { ready: boolean }; broker: BrokerFragment } };
    expect(parsed.ok).toBe(false);
    expect(parsed.doctor.entry.ready).toBe(false);
    expect(parsed.doctor.broker.state).toBe("missing");
    expect(parsed.doctor.broker.detail).toContain("keychain");
  });

  it("reports a revoked broker while setup still reads READY", async () => {
    const project = await readyProject(tempDir, binDir);
    const listed = runBrokerList(tempDir, { json: true, as: "gaspar", session: project.gaspar });
    const brokerId = (JSON.parse(listed.stdout) as { credentials: { id: string }[] }).credentials[0]!.id;
    expect(runBrokerRevoke(tempDir, { id: brokerId, json: true, as: "gaspar", session: project.gaspar }).exitCode).toBe(0);
    const out = runDoctor(tempDir, { json: true, store: project.store });
    expect(out.exitCode).toBe(1);
    const parsed = JSON.parse(out.stdout) as {
      ok: boolean;
      doctor: { setupStep: string; storedSetupStep: string; entry: { ready: boolean; reasons: string[] }; broker: BrokerFragment };
    };
    // OC-P8: READY is a verified projection, not a stored label. The
    // stored label stays truthful (READY happened) while the effective
    // projection demotes to the repair step and entry stays blocked.
    expect(parsed.doctor.storedSetupStep).toBe("READY");
    expect(parsed.doctor.setupStep).toBe("GASPAR_ENTRY_PREPARED");
    expect(parsed.ok).toBe(false);
    expect(parsed.doctor.entry.ready).toBe(false);
    expect(parsed.doctor.broker.state).toBe("revoked");
    expect(parsed.doctor.broker.revoked).toBe(1);
  });

  it("reports an inaccessible keychain as unknown without claiming no broker", async () => {
    await readyProject(tempDir, binDir);
    const out = runDoctor(tempDir, { json: true, store: new LockedKeyStore() });
    expect(out.exitCode).toBe(1);
    const parsed = JSON.parse(out.stdout) as { doctor: { entry: { reasons: string[] }; broker: BrokerFragment } };
    expect(parsed.doctor.broker.state).toBe("unknown");
    expect(parsed.doctor.broker.visible).toBe(false);
    expect(parsed.doctor.entry.reasons.join("; ")).toContain("inaccessible");
    // Permission failure must never read as absence (OC-P6 req 5).
    expect(parsed.doctor.broker.detail).not.toMatch(/no active broker|no broker credential/i);
  });

  it("reports forged or mismatched broker-account files as inconsistent", async () => {
    const project = await readyProject(tempDir, binDir);
    const { account } = brokerSecret(project);
    const file = join(tempDir, ".chrono", "broker-account");
    const check = (): BrokerFragment => brokerOf(runDoctor(tempDir, { json: true, store: project.store }));
    // Forged credential id.
    writeFileSync(file, `${account}\nBRK-9999\n`, "utf8");
    expect(runDoctor(tempDir, { json: true, store: project.store }).exitCode).toBe(1);
    expect(check().state).toBe("inconsistent");
    expect(check().detail).toContain("BRK-9999");
    // Mismatched account name.
    const real = new ChronoCore({ projectPath: tempDir });
    let realId = "";
    try {
      realId = real.brokerHealth().value?.brokerId ?? "";
    } finally {
      real.close();
    }
    writeFileSync(file, `gaspar-entry-forged\n${realId}\n`, "utf8");
    expect(check().state).toBe("inconsistent");
    // Malformed file.
    writeFileSync(file, "single-line-garbage\n", "utf8");
    expect(check().state).toBe("inconsistent");
  });

  it("keeps JSON, human output, and exit codes consistent on both verdicts", async () => {
    const project = await readyProject(tempDir, binDir);
    // Healthy: exit 0, ok true, entry READY, human on stdout.
    const healthyJson = runDoctor(tempDir, { json: true, store: project.store });
    expect(healthyJson.exitCode).toBe(0);
    const healthy = JSON.parse(healthyJson.stdout) as { ok: boolean; doctor: { entry: { ready: boolean } } };
    expect(healthy.ok).toBe(true);
    expect(healthy.doctor.entry.ready).toBe(true);
    const healthyHuman = runDoctor(tempDir, { store: project.store });
    expect(healthyHuman.exitCode).toBe(0);
    expect(healthyHuman.stdout).toContain("entry: READY");
    expect(healthyHuman.stdout).toContain("broker:");
    expect(healthyHuman.stderr).toBe("");
    // Unhealthy (revoked broker): exit 1, ok false, human on stderr.
    const listed = runBrokerList(tempDir, { json: true, as: "gaspar", session: project.gaspar });
    const brokerId = (JSON.parse(listed.stdout) as { credentials: { id: string }[] }).credentials[0]!.id;
    expect(runBrokerRevoke(tempDir, { id: brokerId, json: true, as: "gaspar", session: project.gaspar }).exitCode).toBe(0);
    const sickJson = runDoctor(tempDir, { json: true, store: project.store });
    expect(sickJson.exitCode).toBe(1);
    const sick = JSON.parse(sickJson.stdout) as { ok: boolean; doctor: { entry: { ready: boolean } } };
    expect(sick.ok).toBe(false);
    expect(sick.doctor.entry.ready).toBe(false);
    const sickHuman = runDoctor(tempDir, { store: project.store });
    expect(sickHuman.exitCode).toBe(1);
    expect(sickHuman.stdout).toBe("");
    expect(sickHuman.stderr).toContain("entry: BLOCKED");
    expect(sickHuman.stderr).toContain("broker:");
    expect(sickHuman.stderr).toContain("REVOKED");
  });

  it("leaks no secret material on any surface", async () => {
    const project = await readyProject(tempDir, binDir);
    const { secret } = brokerSecret(project);
    const poKey = project.store.readKey("po") ?? "";
    expect(poKey.length).toBeGreaterThan(0);
    const forbidden = [secret, poKey, project.gaspar.token, project.po.token, "secret_hash", "secretHash"];
    const healthyJson = runDoctor(tempDir, { json: true, store: project.store });
    const healthyHuman = runDoctor(tempDir, { store: project.store });
    for (const text of [healthyJson.stdout, healthyHuman.stdout]) {
      for (const needle of forbidden) {
        expect(text).not.toContain(needle);
      }
    }
    // The credential id and account name are non-secret and may appear;
    // the secret itself must not, even on the failure surface.
    const listed = runBrokerList(tempDir, { json: true, as: "gaspar", session: project.gaspar });
    const brokerId = (JSON.parse(listed.stdout) as { credentials: { id: string }[] }).credentials[0]!.id;
    expect(healthyJson.stdout).toContain(brokerId);
    expect(runBrokerRevoke(tempDir, { id: brokerId, json: true, as: "gaspar", session: project.gaspar }).exitCode).toBe(0);
    const sickJson = runDoctor(tempDir, { json: true, store: project.store });
    const sickHuman = runDoctor(tempDir, { store: project.store });
    for (const text of [sickJson.stdout, sickHuman.stderr]) {
      for (const needle of forbidden) {
        expect(text).not.toContain(needle);
      }
    }
  });
});
describe("Entry script repair (OC-P7 req 10, OC-P8 orchestration)", () => {
  let tempDir: string;
  let binDir: string;
  let restoreTty: () => void;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-ocp7-repair-"));
    binDir = mkdtempSync(join(tmpdir(), "chrono-ocp7-repair-bins-"));
    restoreTty = fakeInteractiveTerminal();
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it("repairs an obsolete entry script on init re-run and requires fresh proof before READY", async () => {
    const project = await readyProject(tempDir, binDir);
    const scriptPath = join(tempDir, ".chrono", "hooks", "chrono-entry-session.sh");
    const canonical = readFileSync(scriptPath, "utf8");
    // Plant the exact pilot defect: the obsolete generator's flag.
    const obsolete = canonical.replace(
      '--broker "$BROKER" --token-out',
      '--broker "$BROKER" --secret-stdin --token-out'
    );
    expect(obsolete).toContain("--secret-stdin");
    const bins = { rtk: join(binDir, "rtk"), runtime: join(binDir, "opencode") };
    const repairInit = (): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
      runInitFlow(
        tempDir,
        { json: true, yes: true },
        { interactive: true, store: project.store },
        flowProbes(bins, { doctorStore: project.store }),
        () => null
      );
    const rtkPath = join(binDir, "rtk");
    const spawn = (
      cmd: string,
      args: string[]
    ): { status: number; stdout: string; stderr: string; timedOut: boolean } => {
      if (cmd === rtkPath) {
        if (args[0] === "--version") {
          return { status: 0, stdout: "rtk 0.44.0-test\n", stderr: "", timedOut: false };
        }
        if (args[0] === "gain") {
          return { status: 0, stdout: "Token Killer savings dashboard\n", stderr: "", timedOut: false };
        }
        if (args[0] === "rewrite") {
          const mapped = args
            .slice(1)
            .map((word) => `'${word}'`)
            .join(" ");
          return { status: 0, stdout: `rtk ${mapped}\n`, stderr: "", timedOut: false };
        }
        if (args[0] === "ls") {
          return { status: 0, stdout: "repaired\n", stderr: "", timedOut: false };
        }
      }
      return { status: 1, stdout: "", stderr: "unknown fixture command", timedOut: false };
    };
    const freshProof = (): string => {
      const proved = runRtkProve(
        tempDir,
        {
          adapter: "opencode",
          as: "gaspar",
          session: project.gaspar,
          binary: rtkPath,
          resolveBinary: (binary: string) => (binary === "rtk" ? rtkPath : binary),
          command: ["ls", tempDir],
          // Same TTL the init flow uses: the fresh proof must outrank
          // the older authoritative row in scope queries.
          ttlSeconds: 86400,
          json: true,
        },
        spawn
      );
      expect(proved.exitCode).toBe(0);
      const proofId = (JSON.parse(proved.stdout) as { id: string }).id;
      const promoted = runRtkPromote(tempDir, { proof: proofId, as: "PO", session: project.po, json: true });
      expect(promoted.exitCode).toBe(0);
      return proofId;
    };
    // Phase A: drifted bytes. Read-only drift protection reports the
    // drift AND the stale proof bindings (re-prove direction); nothing
    // auto-heals in the diagnostic path.
    writeFileSync(scriptPath, obsolete, "utf8");
    const drifted = runDoctor(tempDir, { json: true, store: project.store });
    expect(drifted.exitCode).toBe(1);
    expect(drifted.stdout).toContain("hook drift");
    expect(drifted.stdout).toContain("re-prove");
    // Init re-run heals the bytes and orchestrates the fresh
    // proof/promotion itself (OC-P8): the healed assets and the new
    // authoritative proof agree, so the gate passes in the same run
    // with zero manual granular commands.
    const healed = await repairInit();
    expect(readFileSync(scriptPath, "utf8")).not.toContain("--secret-stdin");
    expect(healed.exitCode).toBe(0);
    expect(healed.stdout).not.toMatch(/run chrono rtk (verify|prove|promote)/);
    // Phase B (generator-upgrade simulation): snapshot the proof while
    // obsolete bytes are live, so the promoted snapshot predates the
    // canonical repair. The read-only doctor still reports the drift
    // plus the re-prove direction (diagnostic path never auto-heals),
    // while init repair heals AND re-proves/promotes in one command.
    writeFileSync(scriptPath, obsolete, "utf8");
    freshProof();
    const driftedAgain = runDoctor(tempDir, { json: true, store: project.store });
    expect(driftedAgain.exitCode).toBe(1);
    expect(driftedAgain.stdout).toContain("hook drift");
    expect(driftedAgain.stdout).toContain("re-prove");
    const repaired = await repairInit();
    expect(readFileSync(scriptPath, "utf8")).not.toContain("--secret-stdin");
    expect(repaired.exitCode).toBe(0);
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      expect(core.getSetupState().value?.step).toBe("READY");
    } finally {
      core.close();
    }
    // Public doctor and init agree on READY again after the
    // orchestrated repair; a further re-run is an idempotent resume.
    const healthy = runDoctor(tempDir, { json: true, store: project.store });
    expect(healthy.exitCode).toBe(0);
    const resumed = await repairInit();
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(resumed.stdout) as object).toMatchObject({ resumed: true });
  });
});
