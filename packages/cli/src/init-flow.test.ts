/**
 * Slice 10 hermetic tests — init detection (zero writes), consent scopes,
 * idempotent apply, resume after injected failure, plan files, locks,
 * re-run health, secret safety, and model neutrality.
 *
 * Everything hermetic: fake TTY, memory keychain, fixture binaries, and
 * an injectable confirm callback. Production paths never run here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChronoCore } from "@chrono/core";
import Database from "better-sqlite3";
import { MemoryKeyStore } from "./keychain.js";
import { hashSkillSource, SKILL_RELEASE } from "@chrono/domain";
import {
  buildInitPlan,
  detectInit,
  detectionHash,
  readInitPlanFile,
  runDoctor,
  runInitFlow,
  sanitizeDoctorEnv,
  validatePlanReplay,
  writeInitPlanFile,
  type FlowProbes,
  type InitDetection,
} from "./init-flow.js";
import { runAdapterList } from "./index.js";
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

interface FixtureBins {
  readonly dir: string;
  readonly rtk: string;
  readonly runtime: string;
}

/** Fixture executables standing in for opencode + rtk (version/gain only). */
function makeBins(dir: string): FixtureBins {
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
  return { dir, rtk, runtime };
}

function flowProbes(
  bins: FixtureBins,
  opts: { failGainOnce?: boolean; doctorStore?: MemoryKeyStore } = {}
): FlowProbes & {
  gainCalls: () => number;
  doctorStore: MemoryKeyStore | null;
  doctorSeen: () => { argv: string[] | null; env: Record<string, string> | null };
} {
  let gainCalls = 0;
  let failedOnce = false;
  const seen: { argv: string[] | null; env: Record<string, string> | null } = { argv: null, env: null };
  const fake = {
    gainCalls: () => gainCalls,
    // Wired by the test to the run's keychain: the simulated doctor
    // child computes the REAL public verification against the same
    // project dir + keychain content a separate process would see.
    doctorStore: (opts.doctorStore ?? null) as MemoryKeyStore | null,
    doctorSeen: () => seen,
    execFile: (cmd: string[], _timeoutMs?: number, options?: { env?: Record<string, string> }) => {
      if (cmd.includes("doctor")) {
        seen.argv = cmd;
        seen.env = options?.env ?? null;
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
        if (args[0] === "gain") {
          gainCalls += 1;
          // Fail the second gain call: detection (first call) stays
          // healthy so the failure lands in the apply phase, proving
          // resume from a recorded step.
          if (opts.failGainOnce === true && !failedOnce && gainCalls === 2) {
            failedOnce = true;
            return { exitCode: 1, stdout: "", stderr: "injected gain failure" };
          }
          return { exitCode: 0, stdout: "Token Killer savings dashboard\n", stderr: "" };
        }
        if (args[0] === "rewrite") {
          // Fixture mapping: the raw pre-routing words are routed
          // through the genuine (fixture) binary. Single-quote each
          // word so the CLI's splitCommandLine recovers the argv.
          const mapped = args
            .slice(1)
            .map((word) => `'${word.replace(/'/g, `'"'"'`)}'`)
            .join(" ");
          return { exitCode: 0, stdout: `rtk ${mapped}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: "rtk ok\n", stderr: "" };
      }
      if (binary === bins.runtime || name === "opencode") {
        if (args[0] === "--version") {
          return { exitCode: 0, stdout: "opencode 9.9.9-test\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "fixture-runtime ok\n", stderr: "" };
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
    homedir: () => join(bins.dir, "home"),
    platform: () => ({ os: "linux", arch: "arm64", node: "v22.0.0" }),
  };
  return fake;
}

function depsOf(store: MemoryKeyStore): { interactive: boolean; store: MemoryKeyStore } {
  return { interactive: true, store };
}

function autoConfirm(seen: string[]): (planText: string, challenge: string) => string | null {
  return (planText: string, challenge: string) => {
    seen.push(planText);
    return challenge;
  };
}

describe("Init detection (read-only)", () => {
  it("pins the shared skill fixture to the release hash", () => {
    expect(hashSkillSource(FIXTURE_SKILL_MD)).toBe(SKILL_RELEASE.sourceHash);
  });
  let tempDir: string;
  let binDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-init-detect-"));
    binDir = mkdtempSync(join(tmpdir(), "chrono-init-bins-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it("performs zero writes and produces a deterministic plan", () => {
    const bins = makeBins(binDir);
    const probes = flowProbes(bins);
    const before = JSON.stringify([...walkFiles(tempDir)].sort());
    const first = detectInit(tempDir, {}, probes);
    const second = detectInit(tempDir, {}, probes);
    expect(JSON.stringify([...walkFiles(tempDir)].sort())).toBe(before);
    expect(first.inProject).toBe(false);
    expect(first.newRepository).toBe(true);
    expect(first.runtimes.find((r) => r.id === "opencode")?.selected).toBe(true);
    expect(first.runtimes.find((r) => r.id === "claude-code")?.selected).toBe(false);
    expect(first.rtk.binary).toBe("rtk");
    expect(detectionHash(first)).toBe(detectionHash(second));
    const planA = buildInitPlan(first, "2026-01-01T00:00:00.000Z");
    const planB = buildInitPlan(second, "2026-01-01T00:00:00.000Z");
    expect(planA).toEqual(planB);
    expect(planA.runtimeIds).toEqual(["opencode"]);
  });

  it("rejects unknown runtime ids as conflicts, never silent defaults", () => {
    const bins = makeBins(binDir);
    const detection = detectInit(tempDir, { runtimeIds: ["watson"] }, flowProbes(bins));
    expect(detection.conflicts.some((c) => c.includes("Unknown runtime"))).toBe(true);
    expect(detection.runtimes.every((r) => !r.selected)).toBe(true);
  });
});

function* walkFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkFiles(full);
    } else {
      yield full;
    }
  }
}

describe("Init consent scopes", () => {
  let tempDir: string;
  let binDir: string;
  let restoreTty: () => void;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-init-consent-"));
    binDir = mkdtempSync(join(tmpdir(), "chrono-init-bins-"));
    restoreTty = () => {};
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it("non-interactive without flags names every missing scope", async () => {
    const bins = makeBins(binDir);
    const out = await runInitFlow(
      tempDir,
      { json: true },
      { interactive: false, store: new MemoryKeyStore() },
      flowProbes(bins),
      () => null
    );
    expect(out.exitCode).toBe(2);
    const parsed = JSON.parse(out.stdout) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("CONSENT_REQUIRED");
    expect(parsed.error.message).toContain("files");
    expect(parsed.error.message).toContain("keychain");
    expect(existsSync(join(tempDir, ".chrono"))).toBe(false);
  });

  it("partial flags cannot broaden consent", async () => {
    const bins = makeBins(binDir);
    const out = await runInitFlow(
      tempDir,
      { json: true, yesFiles: true },
      { interactive: false, store: new MemoryKeyStore() },
      flowProbes(bins),
      () => null
    );
    expect(out.exitCode).toBe(2);
    const parsed = JSON.parse(out.stdout) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("CONSENT_REQUIRED");
    expect(parsed.error.message).toContain("keychain");
    expect(parsed.error.message).not.toContain("files");
  });
});

describe("Init happy path and resume", () => {
  let tempDir: string;
  let binDir: string;
  let restoreTty: () => void;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-init-flow-"));
    binDir = mkdtempSync(join(tmpdir(), "chrono-init-bins-"));
    restoreTty = fakeInteractiveTerminal();
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it("completes to READY through every step with one command", async () => {
    const seen: string[] = [];
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const out = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm(seen));
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { ok: boolean; ready: boolean; runtimes: string[] };
    expect(parsed).toMatchObject({ ok: true, ready: true, runtimes: ["opencode"] });
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      expect(core.getSetupState().value?.step).toBe("READY");
      expect(core.status().value?.state).toBe("ANALYZING");
      const adapters = core.listAdapters();
      expect(adapters.filter((a) => a.status === "active").map((a) => a.id)).toEqual(["opencode"]);
    } finally {
      core.close();
    }
    // Managed assets installed for the selected runtime only;
    // unselected runtimes' integration assets are untouched (skill
    // artifacts stay: one attested unit for all runtimes); broker
    // secret in keychain only.
    expect(existsSync(join(tempDir, ".opencode", "plugins", "chrono-gate.js"))).toBe(true);
    expect(existsSync(join(tempDir, ".chrono", "hooks", "chrono-entry-session.sh"))).toBe(true);
    expect(existsSync(join(tempDir, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(tempDir, ".claude", "agents"))).toBe(false);
    expect(existsSync(join(tempDir, ".kiro", "hooks"))).toBe(false);
    expect(existsSync(join(tempDir, ".chrono", "broker-account"))).toBe(true);
    const [account, recordedBroker] = readFileSync(join(tempDir, ".chrono", "broker-account"), "utf8").trim().split("\n");
    expect(account).toMatch(/^gaspar-entry-[0-9a-f]{16}$/);
    expect(recordedBroker).toMatch(/^BRK-\d{4}$/);
    if (account === undefined) {
      throw new Error("broker account file malformed");
    }
    const secret = store.readKey(account);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    for (const file of walkFiles(tempDir)) {
      const content = readFileSync(file, "utf8");
      expect(content).not.toContain(secret);
    }
    // No secret material in project files; broker id audited in events.
    const core2 = new ChronoCore({ projectPath: tempDir });
    try {
      const detail = core2.getSetupState().value?.detail ?? "{}";
      expect(detail).not.toContain("BEGIN");
      expect(detail).not.toContain("secret");
      const entryEvents = core2
        .listEvents()
        .filter((e) => e.eventType === "StateTransition" && e.entityId === "setup");
      expect(entryEvents.length).toBeGreaterThan(0);
    } finally {
      core2.close();
    }
  });

  it("READY gate re-invokes the public doctor as a separate process with a sanitized environment", async () => {
    // OC-P6 reqs 1+9: READY persists only if the exact normal-user
    // `chrono doctor` confirms readiness; the child carries no session
    // and a sanitized environment even when the parent is polluted.
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const probes = flowProbes(bins, { doctorStore: store });
    const saved = {
      session: process.env["CHRONO_SESSION_TOKEN"],
      nodeOptions: process.env["NODE_OPTIONS"],
      ldPreload: process.env["LD_PRELOAD"],
      custom: process.env["MY_SECRET_TOKEN"],
    };
    process.env["CHRONO_SESSION_TOKEN"] = "GASPAR-1/deadbeef";
    process.env["NODE_OPTIONS"] = "--require /tmp/evil.js";
    process.env["LD_PRELOAD"] = "/tmp/evil.so";
    process.env["MY_SECRET_TOKEN"] = "s3cret";
    try {
      const out = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), probes, autoConfirm([]));
      expect(out.exitCode).toBe(0);
    } finally {
      if (saved.session === undefined) {
        delete process.env["CHRONO_SESSION_TOKEN"];
      } else {
        process.env["CHRONO_SESSION_TOKEN"] = saved.session;
      }
      if (saved.nodeOptions === undefined) {
        delete process.env["NODE_OPTIONS"];
      } else {
        process.env["NODE_OPTIONS"] = saved.nodeOptions;
      }
      if (saved.ldPreload === undefined) {
        delete process.env["LD_PRELOAD"];
      } else {
        process.env["LD_PRELOAD"] = saved.ldPreload;
      }
      if (saved.custom === undefined) {
        delete process.env["MY_SECRET_TOKEN"];
      } else {
        process.env["MY_SECRET_TOKEN"] = saved.custom;
      }
    }
    const seen = probes.doctorSeen();
    expect(seen.argv).not.toBe(null);
    expect(seen.argv?.[0]).toBe(process.execPath);
    expect(seen.argv).toContain("doctor");
    const pathIndex = seen.argv?.indexOf("--path") ?? -1;
    expect(pathIndex).toBeGreaterThanOrEqual(0);
    expect(seen.argv?.[pathIndex + 1]).toBe(realpathSync(tempDir));
    expect(seen.argv).toContain("--json");
    // No privilege or secret carrier crosses into the verification
    // process; the allowlist still passes PATH through.
    expect(seen.env).not.toBe(null);
    expect(seen.env?.["CHRONO_SESSION_TOKEN"]).toBeUndefined();
    expect(seen.env?.["NODE_OPTIONS"]).toBeUndefined();
    expect(seen.env?.["LD_PRELOAD"]).toBeUndefined();
    expect(seen.env?.["MY_SECRET_TOKEN"]).toBeUndefined();
    expect(seen.env?.["PATH"]).toBe(process.env["PATH"]);
  });

  it("sanitizeDoctorEnv passes an allowlist and drops session carriers", async () => {
    const clean = sanitizeDoctorEnv({
      PATH: "/usr/bin",
      HOME: "/home/po",
      CHRONO_SESSION_TOKEN: "GASPAR-1/deadbeef",
      NODE_OPTIONS: "--require /tmp/evil.js",
      LD_PRELOAD: "/tmp/evil.so",
      DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      MY_SECRET_TOKEN: "s3cret",
      AWS_SECRET_ACCESS_KEY: "s3cret",
    });
    expect(clean).toMatchObject({ PATH: "/usr/bin", HOME: "/home/po" });
    expect(Object.keys(clean).sort()).toEqual(["HOME", "PATH"]);
  });
  it("opencode-only selection ignores absent Claude/Kiro runtimes", async () => {
    // No claude/kiro binaries exist in this fixture. Explicit opencode
    // selection must initialize cleanly, install no Claude/Kiro
    // integration assets, and keep doctor free of Claude/Kiro reasons.
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const out = await runInitFlow(
      tempDir,
      { json: true, yes: true, runtimeIds: ["opencode"] },
      depsOf(store),
      flowProbes(bins, { doctorStore: store }),
      autoConfirm([])
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout) as object).toMatchObject({ ok: true, ready: true, runtimes: ["opencode"] });
    expect(existsSync(join(tempDir, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(tempDir, ".kiro", "hooks"))).toBe(false);
    const doctor = runDoctor(tempDir, { json: true, store });
    const reasons = (JSON.parse(doctor.stdout) as { doctor: { entry: { reasons: string[] } } }).doctor.entry.reasons;
    expect(reasons.some((r) => /claude|kiro/i.test(r))).toBe(false);
  });

  it("re-running on READY is a health path, not a duplicate identity", async () => {
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const seen: string[] = [];
    expect((await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm(seen))).exitCode).toBe(0);
    const again = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm(seen));
    expect(again.exitCode).toBe(0);
    const parsed = JSON.parse(again.stdout) as { resumed: boolean };
    expect(parsed.resumed).toBe(true);
    const listed = runAdapterList(tempDir, { json: true });
    const adapters = (JSON.parse(listed.stdout) as { adapters: { id: string }[] }).adapters;
    expect(adapters).toHaveLength(1);
  });

  it("resumes after an injected failure without duplicates", async () => {
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const failing = flowProbes(bins, { failGainOnce: true, doctorStore: store });
    const seen: string[] = [];
    const first = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), failing, autoConfirm(seen));
    expect(first.exitCode).toBe(1);
    expect(first.stdout).toContain("RTK_VERIFIED_AND_ROUTED");
    const second = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm(seen));
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout) as object).toMatchObject({ ok: true, ready: true });
    const listed = runAdapterList(tempDir, { json: true });
    expect((JSON.parse(listed.stdout) as { adapters: unknown[] }).adapters).toHaveLength(1);
  });

  it("refuses a mistyped confirmation without writing state", async () => {
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const out = await runInitFlow(
      tempDir,
      { json: true },
      depsOf(store),
      flowProbes(bins, { doctorStore: store }),
      () => "yes init wronghash"
    );
    expect(out.exitCode).toBe(2);
    expect(existsSync(join(tempDir, ".chrono"))).toBe(false);
  });

  it("honors the init lock for concurrent runs", async () => {
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    mkdirSync(join(tempDir, ".chrono"), { recursive: true });
    writeFileSync(join(tempDir, ".chrono", "init.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const out = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm([]));
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("already running");
  });

  it("keeps output model-neutral", async () => {
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const seen: string[] = [];
    const out = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm(seen));
    expect(out.exitCode).toBe(0);
    const haystack = `${out.stdout} ${seen.join("\n")}`.toLowerCase();
    for (const banned of ["openai", "anthropic", "gpt-", "claude-sonnet", "gemini", "sonnet-4", "opus-4"]) {
      expect(haystack).not.toContain(banned);
    }
  });

  it("configures two runtimes with per-adapter sessions, proofs, and entry", async () => {
    const bins = makeBins(binDir);
    writeFileSync(join(binDir, "claude"), "#!/bin/sh\necho 'claude 9.9.9-test'\n", "utf8");
    // Canonical spelling: setup executes (and compares) the registered
    // canonical entrypoint.
    const claudeBin = realpathSync(join(binDir, "claude"));
    chmodSync(claudeBin, 0o755);
    const probes = flowProbes(bins);
    const multi: FlowProbes = {
      ...probes,
      execFile: (cmd: string[], timeoutMs?: number, options?: { env?: Record<string, string> }) => {
        const [binary, ...args] = cmd as [string, ...string[]];
        if (binary === claudeBin || binary === "claude") {
          return { exitCode: 0, stdout: "claude 9.9.9-test\n", stderr: "" };
        }
        void args;
        return probes.execFile(cmd, timeoutMs ?? 120000, options);
      },
      which: (binary: string): string | null => {
        if (binary === "claude") {
          return claudeBin;
        }
        return probes.which(binary);
      },
    };
    const store = new MemoryKeyStore();
    probes.doctorStore = store;
    const out = await runInitFlow(
      tempDir,
      { json: true, yes: true, runtimeIds: ["opencode", "claude-code"] },
      depsOf(store),
      multi,
      autoConfirm([])
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout) as object).toMatchObject({ ok: true, ready: true });
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      // Multi-runtime projects keep project runtime unset (any runtime opens).
      expect(core.status().value?.details.runtime).toBe(null);
      const active = core.listAdapters().filter((a) => a.status === "active").map((a) => a.id).sort();
      expect(active).toEqual(["claude-code", "opencode"]);
      // Each adapter proved under its own runtime string.
      for (const [adapter, runtime] of [["opencode", "opencode"], ["claude-code", "claude-code"]] as const) {
        const proof = core.routingProofStatus(adapter, runtime);
        expect(proof.present).toBe(true);
        expect(proof.expired).toBe(false);
      }
      // Entry redeems for the second adapter with its own scope.
      const [account, brokerId] = readFileSync(join(tempDir, ".chrono", "broker-account"), "utf8").trim().split("\n");
      const secret = store.readKey(account ?? "");
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      const redeemed = core.redeemBrokerCredential({
        brokerId: brokerId ?? "",
        secret: secret ?? "",
        adapterId: "claude-code",
        runtime: "claude-code",
      });
      expect(redeemed.ok).toBe(true);
      expect(redeemed.value?.projection.projectState).toBe("ANALYZING");
    } finally {
      core.close();
    }
  });
});

describe("Init plan files", () => {
  let tempDir: string;
  let binDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-init-plan-"));
    binDir = mkdtempSync(join(tmpdir(), "chrono-init-bins-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it("writes, replays, and rejects replayed-against-different-input plans", async () => {
    const bins = makeBins(binDir);
    const probes = flowProbes(bins);
    const detection = detectInit(tempDir, {}, probes);
    const plan = buildInitPlan(detection, "2026-01-01T00:00:00.000Z");
    const planPath = join(binDir, "plan.json");
    writeInitPlanFile(planPath, plan, detection);
    expect(validatePlanReplay(readInitPlanFile(planPath), detectInit(tempDir, {}, probes))).toBe(null);
    const other: InitDetection = { ...detection, projectRoot: join(tempDir, "elsewhere") };
    expect(validatePlanReplay(readInitPlanFile(planPath), other)).toContain("current project");
    const tampered = { ...detection, conflicts: [...detection.conflicts, "injected"] };
    expect(validatePlanReplay(readInitPlanFile(planPath), tampered)).toContain("Detection changed");
  });

  it("write-plan performs no project writes", async () => {
    const bins = makeBins(binDir);
    const planPath = join(binDir, "plan.json");
    const out = await runInitFlow(
      tempDir,
      { json: true, writePlan: planPath },
      { interactive: false, store: new MemoryKeyStore() },
      flowProbes(bins),
      () => null
    );
    expect(out.exitCode).toBe(0);
    expect(existsSync(planPath)).toBe(true);
    expect(existsSync(join(tempDir, ".chrono"))).toBe(false);
  });
});

describe("Init resume and fail-closed driver (OC-P5)", () => {
  // Regression suite for the real-pilot finding: a resumed `chrono
  // init` silently returned after PO_ENROLLED. One invocation must
  // flow through every non-interactive step; failures must be loud
  // with step, code, and resume action; exit 0 means READY.

  /** Store reproducing macOS `security -w` read semantics. */
  class MacOsKeychainStore extends MemoryKeyStore {
    override readKey(account: string): string | null {
      const raw = super.readKey(account);
      if (raw === null) {
        return null;
      }
      if (raw.includes("\n")) {
        return `${Buffer.from(raw, "utf8").toString("hex")}\n`;
      }
      const trimmed = raw.trim();
      return trimmed.length === 0 ? null : trimmed;
    }
  }

  let tempDir: string;
  let binDir: string;
  let restoreTty: () => void;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-init-ocp5-"));
    binDir = mkdtempSync(join(tmpdir(), "chrono-init-ocp5-bins-"));
    restoreTty = fakeInteractiveTerminal();
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  function setupStep(): string | null {
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      const state = core.getSetupState();
      return state.ok && state.value !== undefined && state.value !== null ? state.value.step : null;
    } finally {
      core.close();
    }
  }

  function activeAdapters(): string[] {
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      return core.listAdapters().filter((a) => a.status === "active").map((a) => a.id).sort();
    } finally {
      core.close();
    }
  }

  function approvalCount(): number {
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      // The init flow records exactly one approval (adapter
      // registration); enrollment is a ceremony, not an approval.
      return core.listEvents().filter((e) => e.eventType === "ApprovalGranted").length;
    } finally {
      core.close();
    }
  }

  function brokerAccountBytes(): string | null {
    try {
      return readFileSync(join(tempDir, ".chrono", "broker-account"), "utf8");
    } catch {
      return null;
    }
  }

  it("completes a full init through macOS keychain semantics in one invocation", async () => {
    // Exact hermetic reproduction of the pilot failure: multiline
    // keychain reads come back hex-encoded, which previously threw
    // out of session bootstrap into a silent exit.
    const bins = makeBins(binDir);
    const store = new MacOsKeychainStore();
    const out = await runInitFlow(
      tempDir,
      { json: true, yes: true },
      depsOf(store),
      flowProbes(bins, { doctorStore: store }),
      autoConfirm([])
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout) as object).toMatchObject({ ok: true, ready: true, step: "READY" });
    expect(setupStep()).toBe("READY");
    expect(activeAdapters()).toEqual(["opencode"]);
    expect(brokerAccountBytes()).not.toBeNull();
  });

  it("resumes mid-flow past PO_ENROLLED and never duplicates authority records", async () => {
    const bins = makeBins(binDir);
    const store = new MacOsKeychainStore();
    const seen: string[] = [];
    const first = await runInitFlow(
      tempDir,
      { json: true, yes: true },
      depsOf(store),
      flowProbes(bins, { failGainOnce: true, doctorStore: store }),
      autoConfirm(seen)
    );
    expect(first.exitCode).toBe(1);
    // Stopped at the RTK step with enrollment done and marked: the
    // exact pilot resume point (PO_ENROLLED behind, work ahead).
    expect(setupStep()).toBe("RUNTIMES_SELECTED");
    const second = await runInitFlow(
      tempDir,
      { json: true, yes: true },
      depsOf(store),
      flowProbes(bins, { doctorStore: store }),
      autoConfirm(seen)
    );
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout) as object).toMatchObject({ ok: true, ready: true });
    expect(setupStep()).toBe("READY");
    expect(activeAdapters()).toEqual(["opencode"]);
    expect(approvalCount()).toBe(1);
    const brokerBefore = brokerAccountBytes();
    // A further resume is a health path that changes nothing.
    const third = await runInitFlow(
      tempDir,
      { json: true, yes: true },
      depsOf(store),
      flowProbes(bins, { doctorStore: store }),
      autoConfirm(seen)
    );
    expect(third.exitCode).toBe(0);
    expect(brokerAccountBytes()).toBe(brokerBefore);
    expect(activeAdapters()).toEqual(["opencode"]);
    expect(approvalCount()).toBe(1);
  });

  it("reports failures loudly with step, code, and resume action", async () => {
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const failing = await runInitFlow(
      tempDir,
      { json: true, yes: true },
      depsOf(store),
      flowProbes(bins, { failGainOnce: true, doctorStore: store }),
      autoConfirm([])
    );
    expect(failing.exitCode).toBe(1);
    const parsed = JSON.parse(failing.stdout) as {
      ok: boolean;
      step: string;
      error: { ok: boolean; error: { code: string } };
      nextAction: string;
      resume: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.step).toBe("RTK_VERIFIED_AND_ROUTED");
    expect(parsed.error.error.code).toBe("BLOCKED_RTK");
    expect(parsed.nextAction).toContain("chrono init");
    expect(parsed.resume).toContain("chrono init");
    // Human envelope carries the same contract (failing fixtures so
    // the run stops loud at the RTK step instead of completing).
    const humanDir = mkdtempSync(join(tmpdir(), "chrono-init-ocp5-human-"));
    const humanBins = mkdtempSync(join(tmpdir(), "chrono-init-ocp5-humanbins-"));
    try {
      const human = await runInitFlow(
        humanDir,
        { yes: true },
        depsOf(new MemoryKeyStore()),
        flowProbes(makeBins(humanBins), { failGainOnce: true }),
        autoConfirm([])
      );
      expect(human.exitCode).toBe(1);
      expect(human.stdout).toBe("");
      expect(human.stderr).toContain("FAILED");
      expect(human.stderr).toContain("RTK_VERIFIED_AND_ROUTED");
      expect(human.stderr).toContain("Resume:");
    } finally {
      rmSync(humanDir, { recursive: true, force: true });
      rmSync(humanBins, { recursive: true, force: true });
    }
  });

  it("uses distinct exit codes for READY, consent, blockers, and failures", async () => {
    const bins = makeBins(binDir);
    // READY → 0.
    const readyStore = new MemoryKeyStore();
    const ready = await runInitFlow(
      tempDir,
      { json: true, yes: true },
      depsOf(readyStore),
      flowProbes(bins, { doctorStore: readyStore }),
      autoConfirm([])
    );
    expect(ready.exitCode).toBe(0);
    // Missing consent → 2 with a CONSENT step.
    const noConsentDir = mkdtempSync(join(tmpdir(), "chrono-init-ocp5-nc-"));
    try {
      const noConsent = await runInitFlow(
        noConsentDir,
        { json: true },
        { interactive: false, store: new MemoryKeyStore() },
        flowProbes(bins),
        () => null
      );
      expect(noConsent.exitCode).toBe(2);
      expect((JSON.parse(noConsent.stdout) as { step: string; error: { code: string } }).step).toBe("CONSENT");
    } finally {
      rmSync(noConsentDir, { recursive: true, force: true });
    }
    // External blocker (no RTK binary) → nonzero setup block.
    const noRtk: FlowProbes = {
      ...flowProbes(bins),
      execFile: () => ({ exitCode: 1, stdout: "", stderr: "no rtk" }),
      which: () => null,
    };
    const blockedDir = mkdtempSync(join(tmpdir(), "chrono-init-ocp5-bl-"));
    try {
      const blocked = await runInitFlow(
        blockedDir,
        { json: true, yes: true, runtimeIds: ["opencode"] },
        depsOf(new MemoryKeyStore()),
        noRtk,
        autoConfirm([])
      );
      expect(blocked.exitCode).toBe(2);
      expect(blocked.stdout).toContain("Setup blocked");
    } finally {
      rmSync(blockedDir, { recursive: true, force: true });
    }
  });

  it("keeps the plan hash stable across identical detections", () => {
    const bins = makeBins(binDir);
    const first = detectInit(tempDir, {}, flowProbes(bins));
    const second = detectInit(tempDir, {}, flowProbes(bins));
    expect(detectionHash(first)).toBe(detectionHash(second));
    expect(buildInitPlan(first, "2026-01-01T00:00:00.000Z").detectionHash).toBe(
      buildInitPlan(second, "2026-06-01T00:00:00.000Z").detectionHash
    );
    // Pin volatile host state (real keychain contents) for a
    // deterministic material-change check: only a documented input
    // change may move the hash.
    const pinned = { ...first, keychain: { available: true, enrolled: false, reason: "test" } };
    const changed = { ...pinned, keychain: { available: true, enrolled: true, reason: "test" } };
    expect(detectionHash(pinned)).toBe(detectionHash({ ...pinned }));
    expect(detectionHash(changed)).not.toBe(detectionHash(pinned));
  });

  it("resuming from every persisted step never exits silently incomplete", async () => {
    const steps = [
      "DETECTED", "CONSENTED", "PROJECT_INITIALIZED", "PO_ENROLLED", "RUNTIMES_SELECTED",
      "RTK_VERIFIED_AND_ROUTED", "SKILL_VERIFIED_AND_EMITTED", "ADAPTERS_REGISTERED_AND_APPROVED",
      "NATIVE_HOOKS_INSTALLED", "RUNTIME_CONFORMANCE_PASSED", "GASPAR_ENTRY_PREPARED", "READY",
    ] as const;
    for (const seed of steps) {
      const dir = mkdtempSync(join(tmpdir(), "chrono-init-ocp5-seed-"));
      const seedBins = mkdtempSync(join(tmpdir(), "chrono-init-ocp5-seedbins-"));
      try {
        const core = new ChronoCore({ projectPath: dir });
        try {
          expect(core.init().ok).toBe(true);
          let current: string | null = null;
          for (const step of steps) {
            const advanced = core.advanceSetupState(step as never, { seeded: true });
            expect(advanced.ok).toBe(true);
            current = step;
            if (current === seed) {
              break;
            }
          }
        } finally {
          core.close();
        }
        const seedStore = new MemoryKeyStore();
        const out = await runInitFlow(
          dir,
          { json: true, yes: true },
          depsOf(seedStore),
          flowProbes(makeBins(seedBins), { doctorStore: seedStore }),
          autoConfirm([])
        );
        if (out.exitCode === 0) {
          const parsed = JSON.parse(out.stdout) as { ready?: boolean; resumed?: boolean };
          expect(parsed.ready === true || parsed.resumed === true).toBe(true);
        } else {
          expect(out.exitCode).not.toBe(0);
          const combined = `${out.stdout}\n${out.stderr}`;
          expect(/step|FAILED|DENIED|CONSENT|Error|BLOCKED/i.test(combined)).toBe(true);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(seedBins, { recursive: true, force: true });
      }
    }
  }, 300000);
});

describe("Init upgrade/repair orchestration (OC-P8)", () => {
  // Regression suite for the live-pilot finding: a READY project under
  // a previous entry script failed repair at NATIVE_HOOKS_INSTALLED
  // with BLOCKED_RTK ("run chrono rtk verify first"), left
  // setupStep=READY while doctor reported not-ready, and demanded a
  // manual granular command. `chrono init` now owns the full repair:
  // demote the verified projection, re-verify, re-prove, promote,
  // regenerate hooks, revalidate, and return to READY only on a
  // separate-process doctor agreement — with zero manual commands.
  let tempDir: string;
  let binDir: string;
  let restoreTty: () => void;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-init-ocp8-"));
    binDir = mkdtempSync(join(tmpdir(), "chrono-init-ocp8-bins-"));
    restoreTty = fakeInteractiveTerminal();
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  function storedStep(): string | null {
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      const state = core.getSetupState();
      return state.ok && state.value !== undefined && state.value !== null ? state.value.step : null;
    } finally {
      core.close();
    }
  }

  function staleRtkAttestation(): void {
    // Trigger-legal staleness: current → stale preserves the row as
    // historical evidence while denying authority (OC-P8 req 8).
    const db = new Database(join(tempDir, ".chrono", "chrono.db"));
    try {
      db.prepare("UPDATE rtk_attestation SET status = 'stale' WHERE status = 'current'").run();
    } finally {
      db.close();
    }
  }

  function driftEntryScript(): void {
    const script = join(tempDir, ".chrono", "hooks", "chrono-entry-session.sh");
    const before = readFileSync(script, "utf8");
    writeFileSync(script, `${before}\n# OC-P8 drift probe\n`, "utf8");
  }

  function snapshotIdentity(): { adapters: string[]; approvals: number; broker: string | null; projectId: string } {
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      const adapters = core.listAdapters().filter((a) => a.status === "active").map((a) => a.id).sort();
      const approvals = core.listEvents().filter((e) => e.eventType === "ApprovalGranted").length;
      let broker: string | null = null;
      try {
        broker = readFileSync(join(tempDir, ".chrono", "broker-account"), "utf8");
      } catch {
        broker = null;
      }
      return { adapters, approvals, broker, projectId: "default" };
    } finally {
      core.close();
    }
  }

  it("demotes READY on drift/stale and repairs to READY with one init, no manual commands", async () => {
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const seen: string[] = [];
    const first = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm(seen));
    expect(first.exitCode).toBe(0);
    expect(storedStep()).toBe("READY");
    const before = snapshotIdentity();
    // Exact live upgrade: previous entry script + stale attestation.
    driftEntryScript();
    staleRtkAttestation();
    // Public doctor must not report proven routing or READY while the
    // bound attestation/assets are stale (OC-P8 reqs 1, 2, 7).
    const drifted = runDoctor(tempDir, { json: true, store });
    expect(drifted.exitCode).toBe(1);
    const report = JSON.parse(drifted.stdout) as {
      ok: boolean;
      doctor: { setupStep: string; storedSetupStep: string; rtk: { attested: string; routing: Record<string, string> }; entry: { ready: boolean; reasons: string[] } };
    };
    expect(report.doctor.entry.ready).toBe(false);
    expect(report.doctor.setupStep).not.toBe("READY");
    expect(report.doctor.storedSetupStep).toBe("READY");
    expect(report.doctor.rtk.attested).toBe("stale");
    expect(report.doctor.rtk.routing["opencode"]).toBe("stale");
    // One-command repair: no granular rtk/setup/prove/promote runs.
    const probes = flowProbes(bins, { doctorStore: store });
    const repaired = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), probes, autoConfirm(seen));
    expect(repaired.exitCode).toBe(0);
    expect(JSON.parse(repaired.stdout) as object).toMatchObject({ ok: true, ready: true, step: "READY" });
    expect(repaired.stdout).not.toMatch(/run chrono rtk (verify|prove|promote)/);
    expect(repaired.stdout).not.toMatch(/run chrono setup/);
    expect(storedStep()).toBe("READY");
    // Separate-process doctor agreement was exercised in-process.
    expect(probes.doctorSeen().argv).toContain("doctor");
    expect(probes.doctorSeen().env?.["CHRONO_SESSION_TOKEN"]).toBeUndefined();
    // Repair preserves identity without duplication (OC-P8 reqs 8, 9).
    const after = snapshotIdentity();
    expect(after.adapters).toEqual(before.adapters);
    expect(after.approvals).toBe(before.approvals);
    expect(after.broker).not.toBeNull();
    // Idempotent second repair is a health path.
    const again = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm(seen));
    expect(again.exitCode).toBe(0);
    expect(snapshotIdentity()).toEqual(after);
    expect(storedStep()).toBe("READY");
  });

  it("installs the corrected OpenCode plugin on repair and refreshes the proof automatically (OC-P9)", async () => {
    // The pilot project runs a previous plugin generator (no
    // chat.message gate, fictional session shapes). Re-running init
    // must install the corrected bytes and refresh the invalidated RTK
    // proof in the same command — no manual granular steps.
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const first = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm([]));
    expect(first.exitCode).toBe(0);
    const pluginFile = join(tempDir, ".opencode", "plugins", "chrono-gate.js");
    expect(readFileSync(pluginFile, "utf8")).toContain("chat.message");
    // Simulate the previous generator: strip the message gate.
    const previous = readFileSync(pluginFile, "utf8").replaceAll("\"chat.message\"", "\"chat.legacy\"");
    expect(previous).not.toContain("\"chat.message\"");
    writeFileSync(pluginFile, previous, "utf8");
    const drifted = runDoctor(tempDir, { json: true, store });
    expect(drifted.exitCode).toBe(1);
    expect(drifted.stdout).toContain("hook drift");
    const repaired = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm([]));
    expect(repaired.exitCode).toBe(0);
    expect(JSON.parse(repaired.stdout) as object).toMatchObject({ ok: true, ready: true, step: "READY" });
    expect(repaired.stdout).not.toMatch(/run chrono rtk (verify|prove|promote)/);
    expect(repaired.stdout).not.toMatch(/run chrono setup/);
    const healed = readFileSync(pluginFile, "utf8");
    expect(healed).toContain("\"chat.message\"");
    expect(healed).toContain("experimental.chat.system.transform");
    expect(healed).toContain("chrono-gaspar-entry");
    const doctor = runDoctor(tempDir, { json: true, store });
    expect(doctor.exitCode).toBe(0);
    expect((JSON.parse(doctor.stdout) as { doctor: { rtk: { routing: Record<string, string> } } }).doctor.rtk.routing["opencode"]).toBe("proven");
  });

  it("re-proves stale routing bindings after hook replacement and promotes fresh candidates", async () => {
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const first = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm([]));
    expect(first.exitCode).toBe(0);
    const proofBefore = new ChronoCore({ projectPath: tempDir });
    let authoritativeBefore = "";
    try {
      authoritativeBefore = proofBefore.routingProofScopes("opencode").find((p) => p.authority === "authoritative")?.id ?? "";
    } finally {
      proofBefore.close();
    }
    expect(authoritativeBefore.length).toBeGreaterThan(0);
    driftEntryScript();
    const repaired = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm([]));
    expect(repaired.exitCode).toBe(0);
    const proofAfter = new ChronoCore({ projectPath: tempDir });
    try {
      const scopes = proofAfter.routingProofScopes("opencode");
      const authoritative = scopes.filter((p) => p.authority === "authoritative" && !p.expired);
      expect(authoritative.length).toBeGreaterThan(0);
      // Fresh promotion happened; history (including the superseded
      // proof) is preserved as non-authoritative evidence.
      const binding = proofAfter.routingProofBinding("opencode", "opencode");
      expect(binding.ok && binding.value?.inSync).toBe(true);
    } finally {
      proofAfter.close();
    }
    const doctor = runDoctor(tempDir, { json: true, store });
    expect(doctor.exitCode).toBe(0);
    expect((JSON.parse(doctor.stdout) as { doctor: { rtk: { routing: Record<string, string> } } }).doctor.rtk.routing["opencode"]).toBe("proven");
  });

  it("fails loudly at the repair step without leaving READY while doctor disagrees", async () => {
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const first = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm([]));
    expect(first.exitCode).toBe(0);
    driftEntryScript();
    staleRtkAttestation();
    // Inject a failure at the repair's RTK stage: the second gain call
    // (apply-phase verify) fails, so repair stops before READY.
    const failing = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { failGainOnce: true, doctorStore: store }), autoConfirm([]));
    expect(failing.exitCode).toBe(1);
    const parsed = JSON.parse(failing.stdout) as { ok: boolean; step: string; nextAction: string; resume: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.step).toBe("RTK_VERIFIED_AND_ROUTED");
    expect(parsed.nextAction).toContain("chrono init");
    expect(parsed.resume).toContain("chrono init");
    // Never READY while the public doctor disagrees (OC-P8 req 6).
    expect(storedStep()).not.toBe("READY");
    const doctor = runDoctor(tempDir, { json: true, store });
    expect(doctor.exitCode).toBe(1);
    expect((JSON.parse(doctor.stdout) as { doctor: { setupStep: string; entry: { ready: boolean } } }).doctor.setupStep).not.toBe("READY");
    // Resume with healthy fixtures completes to READY.
    const resumed = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm([]));
    expect(resumed.exitCode).toBe(0);
    expect(storedStep()).toBe("READY");
  });

  it("rotates a lost broker secret through one init without manual commands (OC-P9)", async () => {
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const first = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm([]));
    expect(first.exitCode).toBe(0);
    const brokerBefore = readFileSync(join(tempDir, ".chrono", "broker-account"), "utf8");
    // Lose the broker secret (wiped keychain / new machine): the public
    // doctor fails while everything else stays valid. The account binds
    // the canonical project spelling (OC-P6), not the symlinked /tmp one.
    const { brokerAccountFor } = await import("./keychain.js");
    const { canonicalProjectDir } = await import("./project.js");
    store.deleteKey(brokerAccountFor(canonicalProjectDir(tempDir)));
    const sick = runDoctor(tempDir, { json: true, store });
    expect(sick.exitCode).toBe(1);
    // One-command repair revokes the secret-less credential, issues a
    // fresh one, and returns to READY with no duplicates.
    const repaired = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm([]));
    expect(repaired.exitCode).toBe(0);
    expect(JSON.parse(repaired.stdout) as object).toMatchObject({ ok: true, ready: true, step: "READY" });
    expect(repaired.stdout).not.toMatch(/run chrono (rtk|broker|setup)/);
    expect(readFileSync(join(tempDir, ".chrono", "broker-account"), "utf8")).not.toBe(brokerBefore);
    const after = snapshotIdentity();
    expect(after.adapters).toEqual(["opencode"]);
    expect(after.approvals).toBe(1);
    const doctor = runDoctor(tempDir, { json: true, store });
    expect(doctor.exitCode).toBe(0);
  });

  it("installs native Gaspar agent configuration on repair (OC-P10)", async () => {
    const { buildOpenCodeAgentDefinition } = await import("./opencode-agent.js");
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const first = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm([]));
    expect(first.exitCode).toBe(0);
    // Fresh init selects Gaspar natively with a model-neutral definition.
    // Req 14: every generated asset is byte-identical to its builder —
    // disk and CLI options cannot drift.
    const { CHRONO_OPENCODE_ROLES } = await import("./opencode-agent.js");
    for (const role of CHRONO_OPENCODE_ROLES) {
      expect(readFileSync(join(tempDir, ".opencode", "agents", `${role}.md`), "utf8")).toBe(
        buildOpenCodeAgentDefinition(role as "gaspar")
      );
    }
    const configured = runDoctor(tempDir, { json: true, store });
    expect(configured.exitCode).toBe(0);
    const ready = JSON.parse(configured.stdout) as {
      ok: boolean;
      doctor: { activation: { observed: boolean; defaultAgent: string | null; selectedAgent: string | null } };
    };
    expect(ready.ok).toBe(true);
    // No runtime session ran yet: setup is READY but activation is
    // unobserved — static assets alone never prove Gaspar selection.
    expect(ready.doctor.activation.defaultAgent).toBe("gaspar");
    expect(ready.doctor.activation.selectedAgent).toBeNull();
    expect(ready.doctor.activation.observed).toBe(false);
    // Drift the agent file and the user-owned default away: repair
    // restores both in one command with zero manual instructions.
    writeFileSync(join(tempDir, ".opencode", "agents", "gaspar.md"), "hand-edited\n", "utf8");
    const configFile = join(tempDir, "opencode.json");
    writeFileSync(configFile, readFileSync(configFile, "utf8").replace("gaspar", "build"), "utf8");
    const drifted = runDoctor(tempDir, { json: true, store });
    expect(drifted.exitCode).toBe(1);
    expect(drifted.stdout).toContain("hook drift");
    const repaired = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm([]));
    expect(repaired.exitCode).toBe(0);
    expect(JSON.parse(repaired.stdout) as object).toMatchObject({ ok: true, ready: true, step: "READY" });
    expect(repaired.stdout).not.toMatch(/run chrono (rtk|setup|broker)/);
    expect(readFileSync(join(tempDir, ".opencode", "agents", "gaspar.md"), "utf8")).toBe(buildOpenCodeAgentDefinition("gaspar"));
    const healed = runDoctor(tempDir, { json: true, store });
    expect(healed.exitCode).toBe(0);
    expect((JSON.parse(healed.stdout) as { doctor: { activation: { defaultAgent: string } } }).doctor.activation.defaultAgent).toBe("gaspar");
  });

  it("explains default=gaspar but session=build without false activation (OC-P10)", async () => {
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const first = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins, { doctorStore: store }), autoConfirm([]));
    expect(first.exitCode).toBe(0);
    // Crafted runtime telemetry: projection injected, but the exact
    // session kept OpenCode's built-in Build primary.
    writeFileSync(
      join(tempDir, ".chrono", "runtime-activation.jsonl"),
      [
        JSON.stringify({ v: 1, ts: "2026-09-14T00:00:00.000Z", adapter: "opencode", kind: "plugin-load" }),
        JSON.stringify({ v: 1, ts: "2026-09-14T00:01:00.000Z", adapter: "opencode", kind: "projection-injected", session: "ses_old", entrySession: "SES-0001", projectionHash: "aa", hook: "experimental.chat.system.transform", skillIncluded: true }),
        JSON.stringify({ v: 1, ts: "2026-09-14T00:02:00.000Z", adapter: "opencode", kind: "agent-selected", session: "ses_old", agent: "build" }),
      ].join("\n") + "\n",
      "utf8"
    );
    const out = runDoctor(tempDir, { json: true, store });
    const parsed = JSON.parse(out.stdout) as {
      ok: boolean;
      doctor: { activation: { observed: boolean; defaultAgent: string | null; selectedAgent: string | null; detail: string } };
    };
    // Setup stays READY (static configuration is correct) while
    // activation is honestly unobserved for Gaspar.
    expect(parsed.ok).toBe(true);
    expect(parsed.doctor.activation.observed).toBe(false);
    expect(parsed.doctor.activation.defaultAgent).toBe("gaspar");
    expect(parsed.doctor.activation.selectedAgent).toBe("build");
    expect(parsed.doctor.activation.detail).toContain("ses_old");
    expect(parsed.doctor.activation.detail).toContain("build");
  });

  it("demotes setup state auditably without destroying history", () => {
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      expect(core.init().ok).toBe(true);
      for (const step of ["DETECTED", "CONSENTED", "PROJECT_INITIALIZED", "PO_ENROLLED", "RUNTIMES_SELECTED", "RTK_VERIFIED_AND_ROUTED"] as const) {
        expect(core.advanceSetupState(step as never, { seeded: true }).ok).toBe(true);
      }
      const eventsBefore = core.listEvents().filter((e) => e.entityId === "setup").length;
      const demoted = core.demoteSetupForRepair("RUNTIMES_SELECTED" as never, { cause: "OC-P8 test", rerunFrom: "RTK_VERIFIED_AND_ROUTED" });
      expect(demoted.ok).toBe(true);
      expect(core.getSetupState().value?.step).toBe("RUNTIMES_SELECTED");
      const eventsAfter = core.listEvents().filter((e) => e.entityId === "setup");
      expect(eventsAfter.length).toBe(eventsBefore + 1);
      expect(eventsAfter[eventsAfter.length - 1]?.eventType).toContain("StateTransition");
      // Forward-only advance is preserved: skip-ahead still denies.
      expect(core.advanceSetupState("READY" as never, {}).ok).toBe(false);
      // Forward resumption from the demoted step still works.
      expect(core.advanceSetupState("RTK_VERIFIED_AND_ROUTED" as never, { repaired: true }).ok).toBe(true);
      // Secret-bearing repair detail is rejected.
      expect(core.demoteSetupForRepair("RUNTIMES_SELECTED" as never, { token: "abc" }).ok).toBe(false);
    } finally {
      core.close();
    }
  });
});
