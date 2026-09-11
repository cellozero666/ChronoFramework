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
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChronoCore } from "@chrono/core";
import { MemoryKeyStore } from "./keychain.js";
import { hashSkillSource, SKILL_RELEASE } from "@chrono/domain";
import {
  buildInitPlan,
  detectInit,
  detectionHash,
  readInitPlanFile,
  runInitFlow,
  validatePlanReplay,
  writeInitPlanFile,
  type FlowProbes,
  type InitDetection,
} from "./init-flow.js";
import { runAdapterList } from "./index.js";
import { FIXTURE_SKILL_MD } from "./test-skill-fixture.js";


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

function flowProbes(bins: FixtureBins, opts: { failGainOnce?: boolean } = {}): FlowProbes & { gainCalls: () => number } {
  let gainCalls = 0;
  let failedOnce = false;
  return {
    gainCalls: () => gainCalls,
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
    const out = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins), autoConfirm(seen));
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
    // Managed assets installed; broker secret in keychain only.
    expect(existsSync(join(tempDir, ".opencode", "plugins", "chrono-gate.js"))).toBe(true);
    expect(existsSync(join(tempDir, ".kiro", "hooks", "chrono-gate.json"))).toBe(true);
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

  it("re-running on READY is a health path, not a duplicate identity", async () => {
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const seen: string[] = [];
    expect((await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins), autoConfirm(seen))).exitCode).toBe(0);
    const again = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins), autoConfirm(seen));
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
    const failing = flowProbes(bins, { failGainOnce: true });
    const seen: string[] = [];
    const first = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), failing, autoConfirm(seen));
    expect(first.exitCode).toBe(1);
    expect(first.stdout).toContain("RTK_VERIFIED_AND_ROUTED");
    const second = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins), autoConfirm(seen));
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
      flowProbes(bins),
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
    const out = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins), autoConfirm([]));
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("already running");
  });

  it("keeps output model-neutral", async () => {
    const bins = makeBins(binDir);
    const store = new MemoryKeyStore();
    const seen: string[] = [];
    const out = await runInitFlow(tempDir, { json: true, yes: true }, depsOf(store), flowProbes(bins), autoConfirm(seen));
    expect(out.exitCode).toBe(0);
    const haystack = `${out.stdout} ${seen.join("\n")}`.toLowerCase();
    for (const banned of ["openai", "anthropic", "gpt-", "claude-sonnet", "gemini", "sonnet-4", "opus-4"]) {
      expect(haystack).not.toContain(banned);
    }
  });

  it("configures two runtimes with per-adapter sessions, proofs, and entry", async () => {
    const bins = makeBins(binDir);
    const claudeBin = join(binDir, "claude");
    writeFileSync(claudeBin, "#!/bin/sh\necho 'claude 9.9.9-test'\n", "utf8");
    chmodSync(claudeBin, 0o755);
    const probes = flowProbes(bins);
    const multi: FlowProbes = {
      ...probes,
      execFile: (cmd: string[]) => {
        const [binary, ...args] = cmd as [string, ...string[]];
        if (binary === claudeBin || binary === "claude") {
          return { exitCode: 0, stdout: "claude 9.9.9-test\n", stderr: "" };
        }
        void args;
        return probes.execFile(cmd, 120000);
      },
      which: (binary: string): string | null => {
        if (binary === "claude") {
          return claudeBin;
        }
        return probes.which(binary);
      },
    };
    const store = new MemoryKeyStore();
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
