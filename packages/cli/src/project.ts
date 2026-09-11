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

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ChronoCore } from "@chrono/core";
import { CHRONO_VERSION } from "./version.js";
import type { CliOutput } from "./index.js";

/** Walk up from `startDir` to the nearest directory holding `.chrono/chrono.db`. */
export function findProjectRoot(startDir: string): string | null {
  let current: string;
  try {
    current = realpathSync(resolve(startDir));
  } catch {
    return null;
  }
  for (let depth = 0; depth < 64; depth++) {
    try {
      if (existsSync(join(current, ".chrono", "chrono.db"))) {
        return current;
      }
    } catch {
      return null;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}

/** Result of resolving the effective project directory for a command. */
export function resolveProjectDir(cwd: string, explicitPath?: string): string {
  if (explicitPath !== undefined && explicitPath.length > 0) {
    return explicitPath;
  }
  return findProjectRoot(cwd) ?? cwd;
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

