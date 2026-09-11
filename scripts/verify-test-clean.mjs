#!/usr/bin/env node
/**
 * Slice 9 regression gate: proves the test suite exits 0 with no hidden
 * failures. Asserts on the Vitest output (not just the exit code):
 *
 * - process exit code is 0;
 * - "Test Files N passed (N)" with N >= EXPECTED_FILES;
 * - "Tests M passed (M)" with M >= EXPECTED_TESTS and zero failed/skipped/todo;
 * - no "Unhandled", "Worker exited", "Assertion failed", or native-assert text;
 * - no `.skip` / `.todo` / `it.only` / `describe.only` in test sources.
 *
 * Usage: node scripts/verify-test-clean.mjs [--expected-files N] [--expected-tests M]
 * Exit 0 only when every check passes; otherwise prints the violation and
 * exits 1. This script never suppresses failures — it only observes them.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = Number(args[i + 1]);
  if (!Number.isFinite(v)) {
    console.error(`verify-test-clean: non-numeric value for ${name}`);
    process.exit(1);
  }
  return v;
}
const EXPECTED_FILES = flag("--expected-files", 30);
const EXPECTED_TESTS = flag("--expected-tests", 299);

const violations = [];

/* 1. Run the suite exactly as CI does. */
const run = spawnSync("npm", ["test"], { encoding: "utf8", timeout: 600000 });
const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
if (run.error) {
  violations.push(`could not spawn 'npm test': ${run.error.message}`);
}
if (run.status !== 0) {
  violations.push(`'npm test' exited with code ${String(run.status)} (signal ${String(run.signal)})`);
}

/* 2. File/test counts. */
const filesMatch = output.match(/Test Files\s+(\d+) passed \((\d+)\)/);
const testsMatch = output.match(/Tests\s+(\d+) passed \((\d+)\)/);
if (!filesMatch) {
  violations.push("missing 'Test Files N passed (N)' summary line");
} else {
  const passed = Number(filesMatch[1]);
  const total = Number(filesMatch[2]);
  if (passed !== total) violations.push(`test files passed ${passed}/${total}`);
  if (total < EXPECTED_FILES) violations.push(`test files ${total} < expected ${EXPECTED_FILES}`);
}
if (!testsMatch) {
  violations.push("missing 'Tests M passed (M)' summary line");
} else {
  const passed = Number(testsMatch[1]);
  const total = Number(testsMatch[2]);
  if (passed !== total) violations.push(`tests passed ${passed}/${total}`);
  if (total < EXPECTED_TESTS) violations.push(`tests ${total} < expected ${EXPECTED_TESTS}`);
}
if (/\b\d+ failed\b/.test(output) && !/0 failed/.test(output)) {
  const m = output.match(/(\d+) failed/);
  if (m && m[1] !== "0") violations.push(`output reports ${m[1]} failed`);
}

/* 3. Crash / unhandled-error markers (case-insensitive). */
for (const marker of [
  "unhandled",
  "worker exited",
  "assertion failed",
  "removeenvironmentcleanuphook",
  "statement::~statement",
  "was terminated",
  "heap out of memory",
]) {
  if (output.toLowerCase().includes(marker)) {
    violations.push(`output contains crash marker '${marker}'`);
  }
}
/* Vitest prints an "Errors  N errors" section for unhandled errors that
   escape individual test files (e.g. a crashed worker). Any nonzero count
   fails the gate even if the per-file tallies look complete. */
{
  const m = output.match(/^\s*Errors\s+([1-9][0-9]*)\s+errors?\s*$/m);
  if (m) violations.push(`output reports an Errors section with ${m[1]} error(s)`);
}

/* 4. Skipped / todo tests are forbidden for mandatory suites. */
const skipped = output.match(/(\d+) skipped/);
if (skipped && skipped[1] !== "0") violations.push(`output reports ${skipped[1]} skipped tests`);
if (/[\s(]todo[\s:]/i.test(output) && !/TODO-only paths/i.test(output)) {
  violations.push("output mentions todo tests");
}

/* 5. Source-level skip/todo/only markers. */
const testFiles = globSync("packages/*/src/*.test.ts");
let skipHits = 0;
for (const f of testFiles) {
  const src = readFileSync(f, "utf8");
  for (const pat of [/\.skip\(/, /\.todo\(/, /it\.only\(/, /describe\.only\(/, /test\.only\(/]) {
    const hits = src.match(new RegExp(pat.source, "g"));
    if (hits) skipHits += hits.length;
  }
}
if (skipHits > 0) violations.push(`${skipHits} skip/todo/only markers in test sources`);

if (violations.length > 0) {
  console.error("verify-test-clean: FAILED");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(
  `verify-test-clean: PASS (files ${filesMatch?.[2] ?? "?"}, tests ${testsMatch?.[2] ?? "?"}, ` +
    `exit 0, no unhandled errors, no worker crashes, no skips)`
);
