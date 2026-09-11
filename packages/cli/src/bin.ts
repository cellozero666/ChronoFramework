#!/usr/bin/env node
/**
 * chrono executable entry point. Thin wrapper over createProgram —
 * no CHRONO policy lives here.
 */
import { createProgram } from "./index.js";

const program = createProgram(process.cwd());
program.exitOverride();
try {
  await program.parseAsync(process.argv);
} catch (e) {
  const code =
    typeof e === "object" && e !== null && "exitCode" in e && typeof e.exitCode === "number"
      ? e.exitCode
      : 1;
  // Commander usage errors (unknown command, missing option) print its own
  // help text to stderr. When the caller asked for JSON, add a machine
  // envelope on stdout so every failure path stays JSON-parseable — unless
  // the command already rendered complete JSON output (branded
  // chronoEmitted error), in which case a second envelope would corrupt it.
  const emitted =
    typeof e === "object" && e !== null && "chronoEmitted" in e && e.chronoEmitted === true;
  if (process.argv.includes("--json") && !emitted) {
    console.log(
      JSON.stringify(
        { ok: false, error: { code: "VALIDATION_ERROR", severity: "ERROR", message: "CLI usage error", exitCode: code } },
        null,
        2
      )
    );
  }
  process.exit(code);
}
