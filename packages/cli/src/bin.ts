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
  process.exit(code);
}
