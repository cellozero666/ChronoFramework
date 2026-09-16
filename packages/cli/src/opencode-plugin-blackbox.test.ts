/**
 * Packed black-box OpenCode plugin test (OC-P9 req 13). Exercises the
 * GENERATED plugin bytes (produced by the packed `chrono setup` inside
 * a packed `chrono init`) through the actual packed CLI across real
 * process boundaries: isolated tarball install, disposable OpenCode-only
 * project initialized through a pty-driven PO ceremony, PATH-injected
 * key-store boundary (a fake `security` backed by a disposable
 * directory — the host keychain is never touched), fixture `rtk` /
 * `opencode` as real executables, and the REAL entry script redeeming
 * through the packed `chrono entry` with the broker secret on stdin.
 *
 * The heavy flow runs only with CHRONO_BLACKBOX=1
 * (`npm run test:blackbox`): it needs `script(1)`/pty, a disposable
 * npm cache and HOME, and a few minutes. The pinned skill is
 * verified from a local hash-asserted fixture file (CF2-4) — no
 * network. Live-upstream skill verification lives in the explicit
 * network gate (`npm run test:network`). The default suite stays
 * hermetic; the placeholder below documents the entry point and
 * always passes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildRuntimeFingerprint, hashSkillSource, OPENCODE_TOOL_POLICY, SKILL_RELEASE } from "@chrono/domain";
import { FIXTURE_SKILL_MD } from "../test/test-skill-fixture.js";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { accessSync, constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const BLACKBOX = process.env["CHRONO_BLACKBOX"] === "1";
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

if (!BLACKBOX) {
  describe("Packed black-box OpenCode plugin flow (OC-P9 req 13)", () => {
    it("runs on demand via npm run test:blackbox (CHRONO_BLACKBOX=1)", () => {
      expect(BLACKBOX).toBe(false);
    });
  });
} else {
  const BOX_TIMEOUT = 600000;

  interface BlackBox {
    readonly dir: string;
    readonly install: string;
    readonly chronoBin: string;
    readonly fakeBin: string;
    readonly project: string;
    readonly tmp: string;
  }

  let box: BlackBox | null = null;

  function sh(cmd: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number }): { exit: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(cmd, args, {
        encoding: "utf8",
        cwd: options.cwd,
        env: options.env,
        input: options.input,
        timeout: options.timeout ?? 120000,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
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

  function writeExe(path: string, content: string): void {
    writeFileSync(path, content, "utf8");
    chmodSync(path, 0o755);
  }

  function findOnPath(name: string): string | null {
    const path = process.env["PATH"] ?? "";
    for (const dir of path.split(delimiter)) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  /** Run `chrono init` under a real pty, typing back typed-confirmation challenges. */
  function initUnderPty(
    box: BlackBox,
    chronoBin: string,
    projectDir: string,
    env: NodeJS.ProcessEnv
  ): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve, reject) => {
      const runner = join(box.dir, "pty-runner.py");
      writeFileSync(
        runner,
        [
          "import os, pty, sys, select, struct, fcntl, termios",
          "cmd = sys.argv[1:]",
          "pid, fd = pty.fork()",
          "if pid == 0:",
          "    os.execvp(cmd[0], cmd)",
          'fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))',
          "stdin_fd = sys.stdin.fileno()",
          "stdout_fd = sys.stdout.fileno()",
          "os.set_blocking(stdin_fd, False)",
          "watch = [fd, stdin_fd]",
          "status = 0",
          "while watch:",
          "    try:",
          "        r, _, _ = select.select(watch, [], [], 120)",
          "    except OSError:",
          "        break",
          "    if not r:",
          "        break",
          "    if fd in r:",
          "        try:",
          "            data = os.read(fd, 65536)",
          "        except OSError:",
          "            break",
          "        if not data:",
          "            break",
          "        os.write(stdout_fd, data)",
          "    if stdin_fd in r:",
          "        try:",
          "            data = os.read(stdin_fd, 65536)",
          "        except OSError:",
          "            data = b''",
          "        if not data:",
          "            watch.remove(stdin_fd)",
          "        else:",
          "            os.write(fd, data)",
          "try:",
          "    _, status = os.waitpid(pid, 0)",
          "except ChildProcessError:",
          "    pass",
          "sys.exit(os.waitstatus_to_exitcode(status))",
          "",
        ].join("\n"),
        "utf8"
      );
      const python =
        existsSync("/usr/bin/python3") && process.platform === "darwin"
          ? "/usr/bin/python3"
          : findOnPath("python3");
      if (python === null) {
        reject(new Error("black-box prerequisite: python3 (pty module) not found"));
        return;
      }
      const base = [chronoBin, "init", "--runtime", "opencode", "--yes", "--json", "--path", projectDir];
      const child = spawn(python, [runner, ...base], { cwd: projectDir, env, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      const answered = new Set<string>();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("black-box init timed out under pty"));
      }, 300000);
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8").replace(/\r/g, "");
        for (const match of output.matchAll(/Type exactly to confirm: (\S+)/g)) {
          const challenge = match[1] as string;
          if (!answered.has(challenge)) {
            answered.add(challenge);
            child.stdin?.write(`${challenge}\n`);
          }
        }
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, output });
      });
    });
  }

  /**
   * Child env (CF2-4 hermetic): fake fixtures first on PATH, a
   * disposable HOME (no user npmrc/gitconfig/keychain helpers), a
   * disposable npm cache (never the developer's), git without
   * system/global config, the pinned skill source from the local
   * hash-asserted fixture file (never the network), and no ambient
   * session credential. Every packed-binary child inherits exactly this.
   */
  function childEnv(box: BlackBox, extra?: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${box.fakeBin}${delimiter}${process.env["PATH"] ?? ""}`,
      HOME: join(box.tmp, "home"),
      TMPDIR: box.tmp,
      npm_config_cache: join(box.tmp, "npm-cache"),
      npm_config_update_notifier: "false",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(box.tmp, "home", ".gitconfig"),
      CHRONO_SKILL_SOURCE_FILE: join(box.tmp, "skill-source", "SKILL.md"),
      CHRONO_BIN: box.chronoBin,
    };
    delete env["CHRONO_SESSION_TOKEN"];
    if (extra !== undefined) {
      for (const [key, value] of Object.entries(extra)) {
        env[key] = value;
      }
    }
    return env;
  }

  function requireBox(): BlackBox {
    if (box === null) {
      throw new Error("black-box fixture not initialized");
    }
    return box;
  }

  async function generatedPlugin(projectDir: string): Promise<{
    event: (event: unknown) => Promise<unknown>;
    message: (input: unknown) => Promise<unknown>;
    transform: (input: unknown, output: { system: unknown[] }) => Promise<unknown>;
  }> {
    // The GENERATED bytes installed by the packed setup — not the source
    // tree. A file URL with a cache-busting query keeps repeated imports
    // across tests isolated per plugin instance below (each caller
    // invokes the exported factory for fresh closure state).
    const pluginFile = join(projectDir, ".opencode", "plugins", "chrono-gate.js");
    expect(existsSync(pluginFile)).toBe(true);
    const module = (await import(pathToFileURL(pluginFile).href)) as {
      ChronoGatePlugin: (ctx: unknown) => Promise<{
        event: (event: unknown) => Promise<unknown>;
        "chat.message": (input: unknown) => Promise<unknown>;
        "experimental.chat.system.transform": (input: unknown, output: { system: unknown[] }) => Promise<unknown>;
      }>;
    };
    const hooks = await module.ChronoGatePlugin({ directory: projectDir });
    return {
      event: hooks.event,
      message: hooks["chat.message"],
      transform: hooks["experimental.chat.system.transform"],
    };
  }

  function evidenceRecords(projectDir: string): Array<Record<string, unknown>> {
    try {
      return readFileSync(join(projectDir, ".chrono", "runtime-activation.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  describe("Packed black-box OpenCode plugin flow (OC-P9 req 13)", () => {
    beforeAll(() => {
      if (process.platform === "win32") {
        throw new Error("black-box plugin flow requires a POSIX platform (script/sh)");
      }
    }, BOX_TIMEOUT);

    it("packs, installs, and initializes a disposable OpenCode-only project", async () => {
      if (findOnPath("git") === null) {
        throw new Error("black-box prerequisite: git not found on PATH");
      }
      // Hermetic by construction (CF2-4): skill provenance verifies
      // from the local fixture file — no network gate.
      const dir = mkdtempSync(join(tmpdir(), "chrono-pluginbox-"));
      const tarballs = join(dir, "tarballs");
      const install = join(dir, "install");
      const fakeBin = join(dir, "fakebin");
      const project = join(dir, "project");
      const tmp = join(dir, "tmp");
      mkdirSync(tarballs, { recursive: true });
      mkdirSync(install, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(project, { recursive: true });
      mkdirSync(tmp, { recursive: true });
      mkdirSync(join(tmp, "npm-cache"), { recursive: true });
      mkdirSync(join(tmp, "home"), { recursive: true });
      mkdirSync(join(tmp, "skill-source"), { recursive: true });
      if (hashSkillSource(FIXTURE_SKILL_MD) !== SKILL_RELEASE.sourceHash) {
        throw new Error("black-box setup: skill fixture drifted from the pinned source hash");
      }
      writeFileSync(join(tmp, "skill-source", "SKILL.md"), FIXTURE_SKILL_MD, "utf8");
      // Disposable npm/home state for pack AND install (CF2-4): the
      // developer's cache, npmrc, gitconfig, and credentials are
      // never read. Each phase names itself on failure.
      const boxEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: join(tmp, "home"),
        TMPDIR: tmp,
        npm_config_cache: join(tmp, "npm-cache"),
        npm_config_update_notifier: "false",
        GIT_CONFIG_NOSYSTEM: "1",
        CHRONO_SKILL_SOURCE_FILE: join(tmp, "skill-source", "SKILL.md"),
      };
      delete boxEnv["CHRONO_SESSION_TOKEN"];
      try {
        execFileSync(
          "npm",
          ["pack", "--workspace=@chrono/domain", "--workspace=@chrono/persistence", "--workspace=@chrono/core", "--workspace=@chrono/cli", `--pack-destination=${tarballs}`],
          { cwd: REPO_ROOT, timeout: 300000, stdio: ["ignore", "pipe", "pipe"], env: boxEnv }
        );
      } catch (e) {
        throw new Error(`black-box setup: 'npm pack' phase failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      writeFileSync(join(install, "package.json"), JSON.stringify({ name: "chrono-pluginbox", version: "1.0.0" }), "utf8");
      const packed = readdirSync(tarballs)
        .filter((name) => name.endsWith(".tgz"))
        .map((name) => join(tarballs, name));
      if (packed.length !== 4) {
        throw new Error(`black-box prerequisite: expected 4 tarballs, found ${packed.length}`);
      }
      try {
        execFileSync("npm", ["install", "--no-audit", "--no-fund", ...packed], {
          cwd: install,
          timeout: 300000,
          stdio: ["ignore", "pipe", "pipe"],
          env: boxEnv,
        });
      } catch (e) {
        throw new Error(`black-box setup: 'npm install' phase failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const chronoBin = join(install, "node_modules", ".bin", "chrono");
      if (!existsSync(chronoBin)) {
        throw new Error("black-box install did not produce .bin/chrono");
      }
      box = { dir, install, chronoBin, fakeBin, project, tmp };
      const b = requireBox();
      writeExe(
        join(fakeBin, "security"),
        [
          "#!/bin/sh",
          'STORE="${TMPDIR:-/tmp}/chrono-blackbox-keystore"',
          'mkdir -p "$STORE" 2>/dev/null || true',
          'op=""; svc=""; acct=""; secret=""',
          "while [ $# -gt 0 ]; do",
          '  case "$1" in',
          "    find-generic-password|add-generic-password|delete-generic-password) op=\"$1\"; shift;;",
          '    -s) svc="$2"; shift 2;;',
          '    -a) acct="$2"; shift 2;;',
          '    -w) shift; if [ "$op" = "add-generic-password" ]; then secret="$1"; shift; fi;;',
          "    *) shift;;",
          "  esac",
          "done",
          'key="$(printf \'%s\' "$svc" | tr -c \'A-Za-z0-9_.-\' \'_\')__$(printf \'%s\' "$acct" | tr -c \'A-Za-z0-9_.-\' \'_\')"',
          'f="$STORE/$key"',
          'case "$op" in',
          "  find-generic-password)",
          '    if [ -f "$f" ]; then cat "$f"; exit 0;',
          '    else echo "security: SecKeychainSearchCopyNext: could not be found" >&2; exit 44; fi;;',
          "  add-generic-password)",
          '    printf \'%s\' "$secret" > "$f"; chmod 600 "$f"; exit 0;;',
          "  delete-generic-password)",
          '    if [ -f "$f" ]; then rm -f "$f"; exit 0;',
          '    else echo "security: SecKeychainSearchCopyNext: could not be found" >&2; exit 44; fi;;',
          '  *) echo "black-box security: unsupported $op" >&2; exit 1;;',
          "esac",
          "",
        ].join("\n")
      );
      writeExe(
        join(fakeBin, "rtk"),
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then echo "rtk 0.44.0-blackbox"; exit 0; fi',
          'if [ "$1" = "gain" ]; then echo "Token Killer savings dashboard (black-box)"; exit 0; fi',
          'if [ "$1" = "rewrite" ]; then shift; printf \'rtk\'; for w in "$@"; do printf " \'%s\'" "$w"; done; printf \'\\n\'; exit 0; fi',
          'if [ "$1" = "ls" ]; then shift; ls "$@"; exit $?; fi',
          'echo "rtk 0.44.0-blackbox: $*"',
          "exit 0",
          "",
        ].join("\n")
      );
      writeExe(
        join(fakeBin, "opencode"),
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then echo "opencode 9.9.9-blackbox"; exit 0; fi',
          'echo "opencode 9.9.9-blackbox: ok"',
          "exit 0",
          "",
        ].join("\n")
      );
      const git = sh("git", ["init", "-q", b.project], { cwd: b.project, env: childEnv(b) });
      expect(git.exit).toBe(0);
      const init = await initUnderPty(b, b.chronoBin, b.project, childEnv(b));
      if (init.exitCode !== 0) {
        console.log(`BLACKBOX-INIT-FAILED:\n${init.output.slice(-4000)}`);
      }
      expect(init.exitCode).toBe(0);
      const parsed = JSON.parse(init.output.slice(init.output.indexOf("{"))) as { ok: boolean; step: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.step).toBe("READY");
    }, BOX_TIMEOUT);

    it("blocks on a stale loaded plugin until a full restart loads the installed generation", async () => {
      // Stale-loaded-runtime repair (gate item 3, production sequence
      // 1-7): files upgraded under a live OpenCode process must block
      // with RUNTIME_RESTART_REQUIRED (never readiness from repaired
      // files alone); a fresh process loading the installed generation
      // clears automatically. Every load row below comes from a real
      // ChronoGatePlugin() initialization; only the "previous
      // generation" file bytes are fixture-derived (current template
      // with the embedded fingerprint replaced by the fingerprint the
      // real function derives for the pre-runway tool set), documented
      // as the vintage generation the live process still runs.
      const b = requireBox();
      const pluginFile = join(b.project, ".opencode", "plugins", "chrono-gate.js");
      expect(existsSync(pluginFile)).toBe(true);
      const RUNWAY_TOOLS = [
        "chrono_architecture_submit",
        "chrono_architecture_approve",
        "chrono_spec_submit",
        "chrono_spec_ready",
        "chrono_spec_needs_revision",
        "chrono_harness_record",
      ];
      const previousPolicy = Object.fromEntries(
        Object.entries(OPENCODE_TOOL_POLICY).filter(([name]) => !RUNWAY_TOOLS.includes(name))
      ) as Record<string, "read" | "mutate" | "planning" | "delegate" | "lifecycle">;
      const previousFingerprint = buildRuntimeFingerprint(previousPolicy);
      expect(previousFingerprint).not.toBe(buildRuntimeFingerprint());
      const currentBytes = readFileSync(pluginFile, "utf8");
      const currentFingerprint = buildRuntimeFingerprint();
      expect(currentBytes).toContain(`buildFingerprint: "${currentFingerprint}"`);
      // 1+2. Generation A installed and loaded (the still-alive old process).
      const generationA = currentBytes.split(`buildFingerprint: "${currentFingerprint}"`);
      expect(generationA).toHaveLength(2);
      writeFileSync(pluginFile, [generationA[0], `buildFingerprint: "${previousFingerprint}"`, generationA[1]].join(""), "utf8");
      const moduleA = (await import(`${pathToFileURL(pluginFile).href}?gen=a`)) as {
        ChronoGatePlugin: (ctx: unknown) => Promise<unknown>;
      };
      await moduleA.ChronoGatePlugin({ directory: b.project });
      const doctorRounds = (extraEnv?: Record<string, string>): { exit: number; stdout: string; stderr: string } => {
        try {
          const stdout = execFileSync(b.chronoBin, ["doctor", "--path", b.project, "--json"], {
            encoding: "utf8",
            cwd: b.project,
            env: childEnv(b, extraEnv),
            timeout: 120000,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
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
      };
      // 3+4. Upgrade + repair files to generation B while A stays
      // alive: disk is B, loaded runtime is A → doctor blocks.
      writeFileSync(pluginFile, currentBytes, "utf8");
      const stale = doctorRounds();
      expect(stale.exit).toBe(1);
      expect(stale.stdout).toContain("RUNTIME_RESTART_REQUIRED");
      expect(stale.stdout).toContain(`"runtimeStatus": "stale"`);
      // 5. The old runtime cannot be treated as current: no readiness.
      expect(stale.stdout).not.toMatch(/"ok":\s*true/);
      // 6. Full restart: a fresh process loads the installed generation.
      const moduleB = (await import(`${pathToFileURL(pluginFile).href}?gen=b`)) as {
        ChronoGatePlugin: (ctx: unknown) => Promise<unknown>;
      };
      await moduleB.ChronoGatePlugin({ directory: b.project });
      // 7. Doctor becomes ready: the blocker clears automatically.
      const ready = doctorRounds();
      expect(ready.exit).toBe(0);
      expect(ready.stdout).not.toContain("RUNTIME_RESTART_REQUIRED");
      expect(ready.stdout).toContain(`"runtimeStatus": "current"`);
    }, BOX_TIMEOUT);

    afterAll(() => {
      if (box !== null) {
        rmSync(box.dir, { recursive: true, force: true });
        box = null;
      }
    });

    it("activates Gaspar exactly once across racing message and transforms", async () => {
      const b = requireBox();
      const hooks = await generatedPlugin(b.project);
      // The generated bytes carry the OC-P9 contract (message gate +
      // shared per-session entry work), installed by packed setup.
      const generated = readFileSync(join(b.project, ".opencode", "plugins", "chrono-gate.js"), "utf8");
      expect(generated).toContain("\"chat.message\"");
      expect(generated).toContain("experimental.chat.system.transform");
      const sessionId = "ses_blackbox_race_1";
      // Like a real OpenCode process, the runtime environment is fixed
      // for the process lifetime: set it BEFORE any hook runs so the
      // prefetch also resolves the same binaries and keychain boundary.
      const env = childEnv(b);
      const savedPath = process.env["PATH"];
      const savedTmp = process.env["TMPDIR"];
      const savedBin = process.env["CHRONO_BIN"];
      process.env["PATH"] = env["PATH"] as string;
      process.env["TMPDIR"] = env["TMPDIR"] as string;
      process.env["CHRONO_BIN"] = env["CHRONO_BIN"] as string;
      // Delayed-entry race against the REAL entry subprocess: prefetch
      // fired without awaiting, message + transforms immediately after.
      const prefetch = hooks.event({ event: { type: "session.created", properties: { info: { id: sessionId } } } });
      const outputs = [{ system: [] as unknown[] }, { system: [] as unknown[] }];
      try {
        await Promise.all([
          hooks.message({ sessionID: sessionId }),
          hooks.transform({ sessionID: sessionId }, outputs[0] as { system: unknown[] }),
          hooks.transform({ sessionID: sessionId }, outputs[1] as { system: unknown[] }),
        ]);
      } finally {
        if (savedPath === undefined) {
          delete process.env["PATH"];
        } else {
          process.env["PATH"] = savedPath;
        }
        if (savedTmp === undefined) {
          delete process.env["TMPDIR"];
        } else {
          process.env["TMPDIR"] = savedTmp;
        }
        if (savedBin === undefined) {
          delete process.env["CHRONO_BIN"];
        } else {
          process.env["CHRONO_BIN"] = savedBin;
        }
      }
      await prefetch;
      const injected = outputs.filter((o) => o.system.length === 1);
      expect(injected).toHaveLength(1);
      const contract = String(injected[0]?.system[0]);
      expect(contract).toContain("chrono-gaspar-entry");
      expect(contract).toContain("You are Gaspar");
      expect(contract).toContain("Product Owner");
      expect(contract).toContain("karpathy-guidelines");
      expect(contract).not.toContain("secret");
      // Runtime evidence for the exact session, without secrets.
      const records = evidenceRecords(b.project);
      const kinds = records.map((r) => String(r["kind"]));
      expect(kinds).toContain("plugin-load");
      expect(kinds).toContain("entry-redeemed");
      expect(kinds.filter((k) => k === "projection-injected")).toHaveLength(1);
      const injection = records.find((r) => r["kind"] === "projection-injected") as Record<string, unknown>;
      expect(injection["session"]).toBe(sessionId);
      expect(typeof injection["projectionHash"]).toBe("string");
      const haystack = records.map((r) => JSON.stringify(r)).join("\n");
      expect(haystack).not.toMatch(/PRIVATE KEY/);
      expect(haystack).not.toMatch(/sk-(live|test)-/);
    }, BOX_TIMEOUT);

    it("resolves gaspar as the default primary through the real OpenCode binary", () => {
      // Real configuration parser/types oracle (OC-P10 req 13): no paid
      // model runs here — `debug` commands only resolve local config.
      const candidates = ["/opt/homebrew/bin/opencode", "/usr/local/bin/opencode"];
      const realOpenCode = candidates.find((c) => existsSync(c)) ?? findOnPath("opencode");
      if (realOpenCode === null || realOpenCode.includes("fakebin")) {
        throw new Error("black-box prerequisite: real opencode binary not found on PATH");
      }
      const b = requireBox();
      // Hermetic oracle env (CF2-4): the real binary resolves
      // project-local config only — disposable HOME (no user
      // config/credentials), no session carriers, no tool env.
      const cleanEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: join(b.tmp, "home"),
        TMPDIR: b.tmp,
        npm_config_cache: join(b.tmp, "npm-cache"),
        npm_config_update_notifier: "false",
      };
      delete cleanEnv["CHRONO_SESSION_TOKEN"];
      delete cleanEnv["CHRONO_BIN"];
      delete cleanEnv["CHRONO_SKILL_SOURCE_FILE"];
      const config = sh(realOpenCode, ["debug", "config"], { cwd: b.project, env: cleanEnv, timeout: 120000 });
      expect(config.exit).toBe(0);
      const resolved = JSON.parse(config.stdout) as { default_agent?: unknown; agent?: Record<string, unknown> };
      expect(resolved.default_agent).toBe("gaspar");
      const gaspar = sh(realOpenCode, ["debug", "agent", "gaspar"], { cwd: b.project, env: cleanEnv, timeout: 120000 });
      expect(gaspar.exit).toBe(0);
      const definition = JSON.parse(gaspar.stdout) as { name?: unknown; mode?: unknown };
      expect(definition.name).toBe("gaspar");
      expect(definition.mode).toBe("primary");
      // Model-neutral: the generated file carries no model override, so
      // the PO's externally selected OpenCode model governs (the
      // resolved `model` is runtime-owned and varies by machine, so it
      // is asserted at the file level, deterministically).
      const gasparFile = readFileSync(join(b.project, ".opencode", "agents", "gaspar.md"), "utf8");
      expect(gasparFile).not.toMatch(/^model:/m);
      expect(gasparFile).not.toMatch(/provider/i);
      // Built-in Build primary is preserved alongside Gaspar.
      const build = sh(realOpenCode, ["debug", "agent", "build"], { cwd: b.project, env: cleanEnv, timeout: 120000 });
      expect(build.exit).toBe(0);
      expect((JSON.parse(build.stdout) as { name?: unknown }).name).toBe("build");
    }, BOX_TIMEOUT);

    it("fails closed on lost broker secret and repairs through init", async () => {
      const b = requireBox();
      const hooks = await generatedPlugin(b.project);
      // Lose the broker secret (host keychain analogue): entry must
      // deny instead of answering as a default agent.
      const account = readFileSync(join(b.project, ".chrono", "broker-account"), "utf8").split("\n")[0] ?? "";
      const safe = (text: string): string => text.replace(/[^A-Za-z0-9_.-]/g, "_");
      rmSync(join(b.tmp, "chrono-blackbox-keystore", `${safe("chrono-gaspar-entry")}__${safe(account)}`), { force: true });
      const env = childEnv(b);
      const savedPath = process.env["PATH"];
      const savedTmp = process.env["TMPDIR"];
      const savedBin = process.env["CHRONO_BIN"];
      process.env["PATH"] = env["PATH"] as string;
      process.env["TMPDIR"] = env["TMPDIR"] as string;
      process.env["CHRONO_BIN"] = env["CHRONO_BIN"] as string;
      try {
        await expect(hooks.message({ sessionID: "ses_blackbox_lost" })).rejects.toThrow(/ENTRY_BLOCKED/);
        await expect(
          hooks.transform({ sessionID: "ses_blackbox_lost" }, { system: [] })
        ).rejects.toThrow(/ENTRY_BLOCKED/);
      } finally {
        if (savedPath === undefined) {
          delete process.env["PATH"];
        } else {
          process.env["PATH"] = savedPath;
        }
        if (savedTmp === undefined) {
          delete process.env["TMPDIR"];
        } else {
          process.env["TMPDIR"] = savedTmp;
        }
        if (savedBin === undefined) {
          delete process.env["CHRONO_BIN"];
        } else {
          process.env["CHRONO_BIN"] = savedBin;
        }
      }
      // One-command repair rotates the broker and returns to READY.
      const repaired = await initUnderPty(b, b.chronoBin, b.project, childEnv(b));
      expect(repaired.exitCode).toBe(0);
      const parsed = JSON.parse(repaired.output.slice(repaired.output.indexOf("{"))) as { ok: boolean; step: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.step).toBe("READY");
      const doctor = sh(b.chronoBin, ["doctor", "--path", b.project, "--json"], { cwd: b.project, env: childEnv(b) });
      expect(doctor.exit).toBe(0);
      expect((JSON.parse(doctor.stdout) as { ok: boolean }).ok).toBe(true);
    }, BOX_TIMEOUT);
  });
}
