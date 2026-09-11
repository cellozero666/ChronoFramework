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
import { ChronoCore } from "@chrono/core";
import {
  buildSessionAuthorizationPayload,
  signApprovalPayload,
} from "@chrono/domain";
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

  it("removes hooks and restores settings without touching user content", async () => {
    const project = await readyProject(tempDir, binDir);
    void project;
    const settingsPath = join(tempDir, ".claude", "settings.json");
    const before = readFileSync(settingsPath, "utf8");
    expect(before).toContain("chrono-claude-gate.js");
    const out = runUninstall(tempDir, { scope: "hooks", json: true });
    expect(out.exitCode).toBe(0);
    expect(existsSync(join(tempDir, ".opencode", "plugins", "chrono-gate.js"))).toBe(false);
    expect(existsSync(join(tempDir, ".chrono", "broker-account"))).toBe(false);
    // Backup consumed: settings no longer reference managed hooks.
    const after = readFileSync(settingsPath, "utf8");
    expect(after).not.toContain(".chrono/hooks/");
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

describe("Publish safety", () => {
  it("declares no install/uninstall lifecycle hooks", async () => {
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
