/**
 * Packed black-box entry test (OC-P7 req 5). Exercises the REAL packed
 * CLI binary across real process boundaries: isolated tarball install,
 * disposable OpenCode-only project initialized through a pty-driven PO
 * ceremony, PATH-injected key-store boundary (a fake `security`
 * implementation backed by a disposable directory — the host keychain
 * is never touched), and the GENERATED entry script run unchanged
 * with the broker secret on stdin.
 *
 * The heavy flow runs only with CHRONO_BLACKBOX=1
 * (`npm run test:blackbox`): it needs `script(1)`, network access for
 * the pinned skill fetch (a genuine init dependency), and a few
 * minutes. The default suite stays hermetic; the placeholder below
 * documents the entry point and always passes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { accessSync, constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { get } from "node:https";

const BLACKBOX = process.env["CHRONO_BLACKBOX"] === "1";
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

if (!BLACKBOX) {
  describe("Packed black-box entry flow (OC-P7 req 5)", () => {
    it("runs on demand via npm run test:blackbox (CHRONO_BLACKBOX=1)", () => {
      expect(BLACKBOX).toBe(false);
    });
  });
} else {
  const BOX_TIMEOUT = 600000;

  interface BlackBox {
    readonly dir: string;
    readonly tarballs: string;
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

  function checkUrl(url: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const request = get(url, { timeout: timeoutMs }, (response) => {
        response.resume();
        resolve((response.statusCode ?? 0) < 500);
      });
      request.on("error", () => resolve(false));
      request.on("timeout", () => {
        request.destroy();
        resolve(false);
      });
    });
  }

  /** Run `chrono init` under a real pty, typing back typed-confirmation challenges. */
  function initUnderPty(
    box: BlackBox,
    chronoBin: string,
    projectDir: string,
    env: NodeJS.ProcessEnv
  ): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve, reject) => {
      // macOS `script(1)` refuses without a terminal of its own
      // (tcgetattr on a socket), so the box ships a minimal pty
      // runner: forkpty + exec + stdio shuttle. The child sees a
      // genuine controlling terminal (/dev/tty opens work); the
      // driver sees plain pipes and answers each challenge after it
      // appears — never blind-piped input.
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

  function childEnv(box: BlackBox, extra?: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${box.fakeBin}${delimiter}${process.env["PATH"] ?? ""}`,
      TMPDIR: box.tmp,
    };
    delete env["CHRONO_SESSION_TOKEN"];
    if (extra !== undefined) {
      for (const [key, value] of Object.entries(extra)) {
        env[key] = value;
      }
    }
    return env;
  }

  function safeName(text: string): string {
    return text.replace(/[^A-Za-z0-9_.-]/g, "_");
  }

  function storeSecret(box: BlackBox, service: string, account: string): string | null {
    const file = join(box.tmp, "chrono-blackbox-keystore", `${safeName(service)}__${safeName(account)}`);
    try {
      const content = readFileSync(file, "utf8");
      return content.length > 0 ? content : null;
    } catch {
      return null;
    }
  }

  function tokenFiles(box: BlackBox): string[] {
    try {
      return readdirSync(box.tmp)
        .filter((name) => name.startsWith("chrono-gaspar-opencode-") && name.endsWith(".token"))
        .map((name) => join(box.tmp, name));
    } catch {
      return [];
    }
  }

  describe("Packed black-box entry flow (OC-P7 req 5)", () => {
    beforeAll(() => {
      if (process.platform === "win32") {
        throw new Error("black-box entry flow requires a POSIX platform (script/sh)");
      }
      const dir = mkdtempSync(join(tmpdir(), "chrono-blackbox-"));
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
      // Isolated pack + install of the four workspace tarballs.
      execFileSync(
        "npm",
        ["pack", "--workspace=@chrono/domain", "--workspace=@chrono/persistence", "--workspace=@chrono/core", "--workspace=@chrono/cli", `--pack-destination=${tarballs}`],
        { cwd: REPO_ROOT, timeout: 300000, stdio: ["ignore", "pipe", "pipe"] }
      );
      writeFileSync(join(install, "package.json"), JSON.stringify({ name: "chrono-blackbox", version: "1.0.0" }), "utf8");
      const packed = readdirSync(tarballs)
        .filter((name) => name.endsWith(".tgz"))
        .map((name) => join(tarballs, name));
      if (packed.length !== 4) {
        throw new Error(`black-box prerequisite: expected 4 tarballs, found ${packed.length}`);
      }
      execFileSync("npm", ["install", "--no-audit", "--no-fund", ...packed], {
        cwd: install,
        timeout: 300000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chronoBin = join(install, "node_modules", ".bin", "chrono");
      if (!existsSync(chronoBin)) {
        throw new Error("black-box install did not produce .bin/chrono");
      }
      // Securely injected key-store boundary: a fake `security`
      // implementation backed by a disposable directory anchored at
      // $TMPDIR. TMPDIR passes the init gate's sanitized environment
      // (it carries no session or secret), so the boundary works in
      // every child — init, gate doctor, and entry script — while the
      // host keychain is never touched. Every read/write/delete flows
      // through real process spawning and file IPC.
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
      // Fixture runtime surfaces as real executables: genuine process
      // boundaries, deterministic behavior, no paid models, no network.
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
      box = { dir, tarballs, install, chronoBin, fakeBin, project, tmp };
    }, BOX_TIMEOUT);

    afterAll(() => {
      if (box !== null) {
        rmSync(box.dir, { recursive: true, force: true });
        box = null;
      }
    });

    function requireBox(): BlackBox {
      if (box === null) {
        throw new Error("black-box fixture not initialized");
      }
      return box;
    }

    it("initializes a disposable OpenCode-only project through the packed binary", async () => {
      const b = requireBox();
      if (findOnPath("git") === null) {
        throw new Error("black-box prerequisite: git not found on PATH");
      }
      if (!(await checkUrl("https://raw.githubusercontent.com/", 20000))) {
        throw new Error("black-box prerequisite: skill fetch network unreachable (genuine init dependency)");
      }
      const git = sh("git", ["init", "-q", b.project], { cwd: b.project, env: childEnv(b) });
      expect(git.exit).toBe(0);
      const init = await initUnderPty(b, b.chronoBin, b.project, childEnv(b));
      if (init.exitCode !== 0) {
        console.log(`BLACKBOX-INIT-FAILED:\n${init.output.slice(-4000)}`);
      }
      expect(init.exitCode).toBe(0);
      const parsed = JSON.parse(init.output.slice(init.output.indexOf("{"))) as {
        ok: boolean;
        step: string;
        project: string;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.step).toBe("READY");
      // Separate-process public doctor confirms the same READY.
      const doctor = sh(b.chronoBin, ["doctor", "--path", b.project, "--json"], {
        cwd: b.project,
        env: childEnv(b),
      });
      expect(doctor.exit).toBe(0);
      const report = JSON.parse(doctor.stdout) as {
        ok: boolean;
        doctor: { entry: { ready: boolean }; setupStep: string; broker: { state: string } };
      };
      expect(report.ok).toBe(true);
      expect(report.doctor.entry.ready).toBe(true);
      expect(report.doctor.setupStep).toBe("READY");
      expect(report.doctor.broker.state).toBe("active");
    }, BOX_TIMEOUT);

    it("runs the generated script unchanged: stdin secret, valid projection, 0600 token, no leaks", () => {
      const b = requireBox();
      const script = join(b.project, ".chrono", "hooks", "chrono-entry-session.sh");
      expect(existsSync(script)).toBe(true);
      expect(readFileSync(script, "utf8")).not.toContain("--secret-stdin");
      const before = tokenFiles(b);
      const run = sh("sh", [script, "opencode"], {
        cwd: b.project,
        env: childEnv(b, { CHRONO_BIN: b.chronoBin }),
      });
      expect(run.exit).toBe(0);
      const body = JSON.parse(run.stdout) as { ok: boolean; sessionId: string; projection: { projectState: string } };
      expect(body.ok).toBe(true);
      expect(body.projection.projectState).toBe("ANALYZING");
      const created = tokenFiles(b).filter((file) => !before.includes(file));
      expect(created).toHaveLength(1);
      const tokenPath = created[0] as string;
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
      const token = readFileSync(tokenPath, "utf8").trim();
      expect(token.startsWith(`${body.sessionId}/`)).toBe(true);
      // Neither the broker secret nor the session token may appear in
      // process output. Boolean-first assertions keep secrets out of
      // failure diffs.
      const account = readFileSync(join(b.project, ".chrono", "broker-account"), "utf8").split("\n")[0] ?? "";
      const secret = storeSecret(b, "chrono-gaspar-entry", account);
      expect(typeof secret === "string" && secret.length > 0).toBe(true);
      const combined = `${run.stdout}\n${run.stderr}`;
      expect(combined.includes(secret as string)).toBe(false);
      expect(combined.includes(token)).toBe(false);
      expect(combined.includes(tokenPath)).toBe(false);
    }, BOX_TIMEOUT);

    it("mints a fresh session per entry run (no token reuse)", () => {
      const b = requireBox();
      const script = join(b.project, ".chrono", "hooks", "chrono-entry-session.sh");
      const first = sh("sh", [script, "opencode"], {
        cwd: b.project,
        env: childEnv(b, { CHRONO_BIN: b.chronoBin }),
      });
      const second = sh("sh", [script, "opencode"], {
        cwd: b.project,
        env: childEnv(b, { CHRONO_BIN: b.chronoBin }),
      });
      expect(first.exit).toBe(0);
      expect(second.exit).toBe(0);
      const idOf = (stdout: string): string => (JSON.parse(stdout) as { sessionId: string }).sessionId;
      expect(idOf(first.stdout) === idOf(second.stdout)).toBe(false);
    }, BOX_TIMEOUT);

    it("stays fail-closed on corrupt or missing secrets without leaking", () => {
      const b = requireBox();
      const script = join(b.project, ".chrono", "hooks", "chrono-entry-session.sh");
      const account = readFileSync(join(b.project, ".chrono", "broker-account"), "utf8").split("\n")[0] ?? "";
      const secret = storeSecret(b, "chrono-gaspar-entry", account);
      expect(typeof secret === "string" && secret.length > 0).toBe(true);
      const env = childEnv(b, { CHRONO_BIN: b.chronoBin });
      // Corrupt secret: redemption denied, exit 3, no token file.
      writeFileSync(join(b.tmp, "chrono-blackbox-keystore", `${safeName("chrono-gaspar-entry")}__${safeName(account)}`), "0".repeat(64), "utf8");
      const before = tokenFiles(b);
      const denied = sh("sh", [script, "opencode"], { cwd: b.project, env });
      expect(denied.exit).toBe(3);
      expect(denied.stderr.includes("ENTRY BLOCKED")).toBe(true);
      expect(tokenFiles(b).filter((file) => !before.includes(file))).toHaveLength(0);
      expect(denied.stdout.includes(secret as string)).toBe(false);
      // Missing secret: same fail-closed shape.
      rmSync(join(b.tmp, "chrono-blackbox-keystore", `${safeName("chrono-gaspar-entry")}__${safeName(account)}`), { force: true });
      const missing = sh("sh", [script, "opencode"], { cwd: b.project, env });
      expect(missing.exit).toBe(3);
      expect(missing.stderr.includes("ENTRY BLOCKED")).toBe(true);
    }, BOX_TIMEOUT);

    it("fails loudly on malformed, missing, and extra entry options", () => {
      const b = requireBox();
      const env = childEnv(b);
      // The exact pilot defect: the obsolete flag dies in the parser.
      const obsolete = sh(b.chronoBin, ["entry", "--adapter", "opencode", "--broker", "BRK-0001", "--token-out", join(b.tmp, "x.token"), "--secret-stdin"], {
        cwd: b.project,
        env,
        input: "",
      });
      expect(obsolete.exit === 0).toBe(false);
      expect(obsolete.stderr.includes("unknown option")).toBe(true);
      // Missing required option (Commander usage error: nonzero + loud).
      const missing = sh(b.chronoBin, ["entry", "--adapter", "opencode", "--json"], { cwd: b.project, env, input: "" });
      expect(missing.exit === 0).toBe(false);
      expect(missing.stderr.includes("required option")).toBe(true);
      // Empty stdin.
      const empty = sh(
        b.chronoBin,
        ["entry", "--adapter", "opencode", "--broker", "BRK-0001", "--token-out", join(b.tmp, "y.token"), "--path", b.project, "--json"],
        { cwd: b.project, env, input: "" }
      );
      expect(empty.exit).toBe(2);
      expect(empty.stdout.includes("stdin") || empty.stderr.includes("stdin")).toBe(true);
    }, BOX_TIMEOUT);
  });
}
