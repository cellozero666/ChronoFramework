/**
 * CHRONO CLI — minimal usable interface to the deterministic Core.
 * [Slice 5] — CLI code delegates to Core services; it owns no CHRONO policy.
 *
 * Commands: init, status, validate. Each returns a CliOutput with an exit
 * code so adapters and tests can consume decisions deterministically.
 */

import { Command } from "commander";
import { ChronoCore } from "@chrono/core";

export interface CliOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface InitOptions {
  readonly language?: string | undefined;
  readonly gasparAutonomy?: string | undefined;
  readonly runtime?: string | null | undefined;
  readonly json?: boolean | undefined;
}

export interface OutputOptions {
  readonly json?: boolean | undefined;
}

interface CommandOpts {
  readonly path?: unknown;
  readonly language?: unknown;
  readonly gasparAutonomy?: unknown;
  readonly runtime?: unknown;
  readonly json?: unknown;
}

function formatCoreError(error: {
  code: string;
  severity: string;
  message: string;
  invariantRef?: string | undefined;
  affectedTarget?: string | undefined;
  suggestedAction?: string | undefined;
}): string {
  const lines = [`Error [${error.code}] (${error.severity}): ${error.message}`];
  if (error.invariantRef !== undefined) {
    lines.push(`  invariant: ${error.invariantRef}`);
  }
  if (error.affectedTarget !== undefined) {
    lines.push(`  target: ${error.affectedTarget}`);
  }
  if (error.suggestedAction !== undefined) {
    lines.push(`  suggested action: ${error.suggestedAction}`);
  }
  return lines.join("\n");
}

/**
 * Initialize a new CHRONO project at projectPath. Delegates to Core.init().
 */
export function runInit(projectPath: string, options: InitOptions = {}): CliOutput {
  const core = new ChronoCore({
    projectPath,
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(options.gasparAutonomy !== undefined ? { gasparAutonomy: options.gasparAutonomy } : {}),
    ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
  });
  try {
    const result = core.init();
    const asJson = options.json === true;
    if (!result.ok) {
      const body = asJson
        ? JSON.stringify({ ok: false, error: result.error }, null, 2)
        : formatCoreError({
            code: result.error?.code ?? "UNKNOWN",
            severity: result.error?.severity ?? "ERROR",
            message: result.error?.message ?? "Initialization failed",
            invariantRef: result.error?.invariantRef,
            affectedTarget: result.error?.affectedTarget,
            suggestedAction: result.error?.suggestedAction,
          });
      return asJson
        ? { exitCode: 1, stdout: body, stderr: "" }
        : { exitCode: 1, stdout: "", stderr: body };
    }
    if (asJson) {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          { ok: true, projectId: result.value?.projectId, state: result.value?.state },
          null,
          2,
        ),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: [
        `Initialized CHRONO project '${result.value?.projectId ?? "default"}'`,
        `state: ${result.value?.state ?? "UNKNOWN"}`,
        `store: ${projectPath}/.chrono/chrono.db`,
      ].join("\n"),
      stderr: "",
    };
  } finally {
    core.close();
  }
}

/**
 * Show deterministic project status. Delegates to Core.status().
 */
export function runStatus(projectPath: string, options: OutputOptions = {}): CliOutput {
  const core = new ChronoCore({ projectPath });
  try {
    const result = core.status();
    if (!result.ok) {
      const body =
        options.json === true
          ? JSON.stringify({ ok: false, error: result.error }, null, 2)
          : formatCoreError({
              code: result.error?.code ?? "UNKNOWN",
              severity: result.error?.severity ?? "ERROR",
              message: result.error?.message ?? "Status failed",
              invariantRef: result.error?.invariantRef,
              affectedTarget: result.error?.affectedTarget,
              suggestedAction: result.error?.suggestedAction,
            });
      return options.json === true
        ? { exitCode: 1, stdout: body, stderr: "" }
        : { exitCode: 1, stdout: "", stderr: body };
    }
    const v = result.value;
    if (options.json === true) {
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, ...v }, null, 2), stderr: "" };
    }
    const lines = [
      `state: ${v?.state ?? "UNKNOWN"}`,
      `specs: ${v?.specCount ?? 0}  modules: ${v?.moduleCount ?? 0}  work packages: ${v?.workPackageCount ?? 0}`,
      `active blockers: ${v?.activeBlockers ?? 0}`,
    ];
    for (const b of v?.activeBlockerList ?? []) {
      lines.push(`  - [${b.type}] ${b.id}: ${b.reason}`);
    }
    if (v !== undefined) {
      lines.push(`project state: ${v.details.projectState}  projected: ${v.details.projectedState}`);
    }
    return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
  } finally {
    core.close();
  }
}

/**
 * Run deterministic validation. Delegates to Core.validate().
 * Exit 0 when valid, 1 when invalid or on error (fail-closed).
 */
export function runValidate(projectPath: string, options: OutputOptions = {}): CliOutput {
  const core = new ChronoCore({ projectPath });
  try {
    const result = core.validate();
    if (!result.ok) {
      const body =
        options.json === true
          ? JSON.stringify({ ok: false, error: result.error }, null, 2)
          : formatCoreError({
              code: result.error?.code ?? "UNKNOWN",
              severity: result.error?.severity ?? "ERROR",
              message: result.error?.message ?? "Validation failed",
              invariantRef: result.error?.invariantRef,
              affectedTarget: result.error?.affectedTarget,
              suggestedAction: result.error?.suggestedAction,
            });
      return options.json === true
        ? { exitCode: 1, stdout: body, stderr: "" }
        : { exitCode: 1, stdout: "", stderr: body };
    }
    const valid = result.value?.valid ?? false;
    if (options.json === true) {
      return {
        exitCode: valid ? 0 : 1,
        stdout: JSON.stringify({ ok: true, ...result.value }, null, 2),
        stderr: "",
      };
    }
    const lines = [valid ? "VALID" : "INVALID"];
    for (const e of result.value?.errors ?? []) {
      lines.push(`  error: ${e}`);
    }
    for (const w of result.value?.warnings ?? []) {
      lines.push(`  warning: ${w}`);
    }
    return {
      exitCode: valid ? 0 : 1,
      stdout: lines.join("\n"),
      stderr: "",
    };
  } finally {
    core.close();
  }
}

/**
 * Build the commander program. The `cwd` is the default project path when
 * `--path` is not given. Actions print to console and set process exit code
 * via `program.exitOverride` errors handled by the caller (bin.ts).
 */
export function createProgram(cwd: string): Command {
  const program = new Command();
  program.name("chrono").description("CHRONO — structured SDD framework CLI").version("0.1.0");

  program
    .command("init")
    .description("Initialize a new CHRONO project")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--language <lang>", "project language (default: en)")
    .option("--gaspar-autonomy <mode>", "Gaspar autonomy mode")
    .option("--runtime <runtime>", "runtime adapter name (recorded only, no policy)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      const out = runInit(projectPath, {
        language: typeof opts.language === "string" ? opts.language : undefined,
        gasparAutonomy: typeof opts.gasparAutonomy === "string" ? opts.gasparAutonomy : undefined,
        runtime: typeof opts.runtime === "string" ? opts.runtime : null,
        json: opts.json === true,
      });
      if (out.stdout !== "") {
        console.log(out.stdout);
      }
      if (out.stderr !== "") {
        console.error(out.stderr);
      }
      if (out.exitCode !== 0) {
        program.error("", { exitCode: out.exitCode });
      }
    });

  program
    .command("status")
    .description("Show deterministic project status")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      const out = runStatus(projectPath, { json: opts.json === true });
      if (out.stdout !== "") {
        console.log(out.stdout);
      }
      if (out.stderr !== "") {
        console.error(out.stderr);
      }
      if (out.exitCode !== 0) {
        program.error("", { exitCode: out.exitCode });
      }
    });

  program
    .command("validate")
    .description("Run deterministic project validation (fail-closed)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      const out = runValidate(projectPath, { json: opts.json === true });
      if (out.stdout !== "") {
        console.log(out.stdout);
      }
      if (out.stderr !== "") {
        console.error(out.stderr);
      }
      if (out.exitCode !== 0) {
        program.error("", { exitCode: out.exitCode });
      }
    });

  return program;
}
