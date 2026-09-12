/**
 * Public-tarball content guard (package hygiene).
 *
 * No test, fixture, mock, stub, snapshot, or other test-support file —
 * nor its compiled JS, declaration, or source map — may enter any
 * published workspace tarball. This test inspects what `npm pack`
 * would publish for every workspace package and fails on the first
 * offending entry. It deliberately does not rely only on the
 * `*.test.*` pattern: support files like `test-skill-fixture.ts`
 * carry no `.test.` segment yet must never ship.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKSPACES = ["@chrono/cli", "@chrono/core", "@chrono/domain", "@chrono/persistence"] as const;

// Path segments (or filename fragments) that mark test-support content.
// Matched case-insensitively against each tarball entry path.
const BANNED_SEGMENTS = [
  "__tests__",
  "__mocks__",
  "__snapshots__",
  "e2e",
  "fixture",
  "fixtures",
  "mock",
  "mocks",
  "snapshot",
  "snapshots",
  "spec",
  "stub",
  "stubs",
  "test",
  "testing",
  "tests",
];

function isBannedEntry(entry: string): boolean {
  const normalized = entry.toLowerCase().replace(/\\/g, "/");
  if (/\.test\.[^.]+$/.test(normalized)) {
    return true;
  }
  const segments = normalized.split("/");
  return segments.some((segment) => {
    const bare = segment.replace(/\.(js|mjs|cjs|d\.ts|d\.mts|d\.cts|js\.map|mjs\.map|cjs\.map|d\.ts\.map|json|md)$/, "");
    return BANNED_SEGMENTS.some((banned) => bare === banned || bare.startsWith(`${banned}-`) || bare.startsWith(`${banned}_`) || bare.endsWith(`-${banned}`) || bare.endsWith(`_${banned}`) || bare.includes(`-${banned}-`) || bare.includes(`_${banned}_`));
  });
}

function packFileList(workspace: string): string[] {
  const ran = spawnSync("npm", ["pack", "--dry-run", `--workspace=${workspace}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120000,
  });
  if (ran.status !== 0) {
    throw new Error(`npm pack --dry-run failed for ${workspace}: ${ran.stderr}`);
  }
  const combined = `${ran.stdout}\n${ran.stderr}`;
  const files: string[] = [];
  let inContents = false;
  for (const rawLine of combined.split("\n")) {
    const line = rawLine.replace(/^npm notice\s*/, "").trim();
    if (/^📦/.test(line)) {
      continue;
    }
    if (/^tarball contents$/i.test(line)) {
      inContents = true;
      continue;
    }
    if (!inContents || line.length === 0) {
      continue;
    }
    const match = /^(?:\d+(?:\.\d+)?\s*(?:B|kB|MB)\s+)?(\S+)\s*$/.exec(line);
    if (match !== null && match[1] !== undefined) {
      files.push(match[1]);
    }
  }
  if (files.length === 0) {
    throw new Error(`no tarball entries parsed for ${workspace}; npm output format may have changed`);
  }
  return files;
}

describe("public tarball contents", () => {
  for (const workspace of WORKSPACES) {
    it(`ships no test-support files in ${workspace}`, () => {
      const files = packFileList(workspace);
      expect(files.length).toBeGreaterThan(0);
      const offenders = files.filter(isBannedEntry);
      expect(offenders).toEqual([]);
    }, 120000);
  }
});
