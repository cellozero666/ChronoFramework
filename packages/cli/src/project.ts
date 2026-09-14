/**
 * Project location and read-only Core opening [SLICE-10 §§2, 7].
 *
 * The global launcher must locate the project root without depending on
 * the current subdirectory, delegate to the project-pinned Core, and
 * fail closed on missing or incompatible local state. Read paths never
 * create store files: a missing database fails with ENTITY_NOT_FOUND
 * instead of materializing an empty store, and legacy databases without
 * a pinned version get exactly one audited read-write upgrade touch
 * before read-only use resumes.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { ChronoCore } from "@chrono/core";
import { ChronoDatabase } from "@chrono/persistence";
import { CHRONO_VERSION } from "./version.js";
import type { CliOutput } from "./index.js";

/**
 * Canonical project-root resolution [OPENCODE-PILOT-GATE.md project
 * isolation finding]. One algorithm, used by every command:
 *
 * 1. Canonicalize the start directory (`realpathSync`): `/tmp` vs
 *    `/private/tmp`, symlinked checkouts, and `..` segments all collapse
 *    to one identity before any comparison.
 * 2. The innermost containing Git repository root (`git rev-parse
 *    --show-toplevel`, canonicalized) is the maximum upward boundary.
 *    A `.chrono` above that root is never adopted.
 * 3. Walk upward for the nearest `.chrono/chrono.db` at or below the
 *    boundary. Outside Git, shared temporary directories (`os.tmpdir()`,
 *    `/tmp`, `/var/tmp`) are never adopted from and never traversed:
 *    an unrelated `/tmp/.chrono` must not capture `/tmp` siblings.
 * 4. An adopted candidate whose stored project identity
 *    (`runtime_config.project.root`, recorded at init) disagrees with
 *    its directory is rejected (fail closed). Rows without a recorded
 *    identity (legacy databases) stay adoptable.
 * 5. With no adoption, the root is the Git root (new repository) or the
 *    canonical start directory.
 */
export interface ProjectResolution {
  /** Effective root: adopted `.chrono` dir, Git root, or canonical cwd. */
  readonly root: string;
  /** Innermost containing Git root (canonical), or null outside Git. */
  readonly gitRoot: string | null;
  /** Adopted `.chrono` directory (canonical), or null. */
  readonly chronoRoot: string | null;
}

function canonicalDir(path: string): string | null {
  try {
    return realpathSync(resolve(path));
  } catch {
    return null;
  }
}

/**
 * Canonical project spelling shared by init and doctor (OC-P6): the
 * realpath of an existing directory, otherwise the resolved path.
 * Broker account derivation must use this spelling on both sides or a
 * symlinked invocation (e.g. `/tmp` vs `/private/tmp`) mismatches the
 * account recorded at init.
 */
export function canonicalProjectDir(path: string): string {
  return canonicalDir(path) ?? resolve(path);
}

function gitToplevel(canonicalStart: string): string | null {
  try {
    const raw = execFileSync("git", ["-C", canonicalStart, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const root = realpathSync(String(raw).trim());
    // Defensive: the reported root must actually contain the start dir.
    return isWithinOrEqual(canonicalStart, root) ? root : null;
  } catch {
    // No git binary, not a repository, or unreadable: no git boundary.
    return null;
  }
}

function tempBoundaryDirs(): string[] {
  const candidates = [tmpdir(), "/tmp", "/var/tmp"];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    try {
      seen.add(realpathSync(candidate));
    } catch {
      // Absent temp dir: nothing to guard.
    }
  }
  return [...seen];
}

function hasChronoDb(dir: string): boolean {
  try {
    return existsSync(join(dir, ".chrono", "chrono.db"));
  } catch {
    return false;
  }
}

/** Stored project identity, or null when legacy/absent/unreadable. */
function storedProjectRoot(candidateDir: string): string | null {
  let db: ChronoDatabase | null = null;
  try {
    db = new ChronoDatabase({ path: join(candidateDir, ".chrono", "chrono.db"), readonly: true });
    return db.runtimeConfig().get("project.root");
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Read-only probe failure is not fatal to resolution.
    }
  }
}

function isWithinOrEqual(dir: string, boundary: string): boolean {
  return dir === boundary || dir.startsWith(boundary + sep);
}

export interface ResolveOptions {
  /** Override shared-temp boundaries (tests only; production probes the host). */
  readonly tempBoundaries?: readonly string[] | undefined;
}

export function resolveProject(startDir: string, options: ResolveOptions = {}): ProjectResolution {
  const canonicalStart = canonicalDir(startDir);
  if (canonicalStart === null) {
    return { root: startDir, gitRoot: null, chronoRoot: null };
  }
  const gitRoot = gitToplevel(canonicalStart);
  const tempBoundaries = gitRoot === null ? (options.tempBoundaries ?? tempBoundaryDirs()) : [];
  let current = canonicalStart;
  for (let depth = 0; depth < 64; depth++) {
    if (gitRoot !== null && !isWithinOrEqual(current, gitRoot)) {
      break;
    }
    if (gitRoot === null && current !== canonicalStart && tempBoundaries.includes(current)) {
      break;
    }
    if (hasChronoDb(current)) {
      const stored = storedProjectRoot(current);
      if (stored !== null && stored !== current) {
        // Foreign or relocated store: fail closed, adopt nothing.
        return { root: gitRoot ?? canonicalStart, gitRoot, chronoRoot: null };
      }
      return { root: current, gitRoot, chronoRoot: current };
    }
    if (gitRoot !== null && current === gitRoot) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return { root: gitRoot ?? canonicalStart, gitRoot, chronoRoot: null };
}

/** Walk up from `startDir` to the nearest adopted `.chrono` directory. */
export function findProjectRoot(startDir: string, options: ResolveOptions = {}): string | null {
  return resolveProject(startDir, options).chronoRoot;
}

/** Result of resolving the effective project directory for a command. */
export function resolveProjectDir(cwd: string, explicitPath?: unknown): string {
  if (typeof explicitPath === "string" && explicitPath.length > 0) {
    return canonicalDir(explicitPath) ?? explicitPath;
  }
  return resolveProject(cwd).root;
}

function notAProject(projectPath: string, asJson: boolean): CliOutput {
  const message = `No CHRONO project at '${projectPath}': run chrono init first`;
  if (asJson) {
    return {
      exitCode: 1,
      stdout: JSON.stringify(
        { ok: false, error: { code: "ENTITY_NOT_FOUND", severity: "ERROR", message } },
        null,
        2
      ),
      stderr: "",
    };
  }
  return { exitCode: 1, stdout: "", stderr: `Error [ENTITY_NOT_FOUND] (ERROR): ${message}` };
}

function errorCodeOf(e: unknown): string | null {
  if (typeof e === "object" && e !== null && "code" in e && typeof (e as { code?: unknown }).code === "string") {
    return (e as { code: string }).code;
  }
  return null;
}

/**
 * Open a project for reading: no store files are created, the pinned
 * Core version is enforced read-only, and a legacy database without a
 * pin gets one audited read-write upgrade touch (then read-only use
 * resumes). Returns the open Core or a stable failure envelope.
 */
export function openReadProject(
  projectPath: string,
  asJson: boolean
): { core: ChronoCore } | { failure: CliOutput } {
  if (!existsSync(join(projectPath, ".chrono", "chrono.db"))) {
    return { failure: notAProject(projectPath, asJson) };
  }
  try {
    return {
      core: new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION, readOnly: true }),
    };
  } catch (e) {
    if (errorCodeOf(e) === "UPGRADE_REQUIRED") {
      try {
        return { core: new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION }) };
      } catch (nested) {
        return { failure: constructionFailure(nested, asJson) };
      }
    }
    return { failure: constructionFailure(e, asJson) };
  }
}

/**
 * Structured fatal for Core-construction failures (bad path, migration
 * failure, unreadable store). Exit 2 = system error [RUNTIME §12];
 * exit 1 is reserved for Core gate denials. JSON on every failure path
 * when --json is set [Remediation §6].
 */
export function constructionFailure(e: unknown, asJson: boolean): CliOutput {
  const message = e instanceof Error ? e.message : String(e);
  // Preserve a deterministic Core failure (e.g. pinned-version mismatch)
  // instead of flattening every construction fault to CORE_INIT_FAILURE.
  const coreFault =
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof (e as { code?: unknown }).code === "string" &&
    "severity" in e &&
    typeof (e as { severity?: unknown }).severity === "string"
      ? (e as { code: string; severity: string; invariantRef?: string; affectedTarget?: string; suggestedAction?: string })
      : null;
  if (asJson) {
    return {
      exitCode: 2,
      stdout: JSON.stringify(
        {
          ok: false,
          error: {
            code: coreFault?.code ?? "CORE_INIT_FAILURE",
            severity: coreFault?.severity ?? "ERROR",
            message,
            ...(coreFault?.invariantRef !== undefined ? { invariantRef: coreFault.invariantRef } : {}),
            ...(coreFault?.affectedTarget !== undefined ? { affectedTarget: coreFault.affectedTarget } : {}),
            suggestedAction:
              coreFault?.suggestedAction ??
              "Verify the project path is writable and .chrono/chrono.db is intact",
          },
        },
        null,
        2,
      ),
      stderr: "",
    };
  }
  return {
    exitCode: 2,
    stdout: "",
    stderr: [
      `Fatal [${coreFault?.code ?? "CORE_INIT_FAILURE"}] (${coreFault?.severity ?? "ERROR"}): ${message}`,
      `  suggested action: ${coreFault?.suggestedAction ?? "Verify the project path is writable and .chrono/chrono.db is intact"}`,
    ].join("\n"),
  };
}

