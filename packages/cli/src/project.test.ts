/**
 * Slice 10 tests — project root discovery and read-only Core opening.
 * [SLICE-10 §2]: nested invocation finds the project; missing stores
 * fail closed without materializing files; legacy databases get one
 * audited upgrade touch before read-only use resumes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ChronoCore } from "@chrono/core";
import { ChronoDatabase } from "@chrono/persistence";
import { runInit } from "./index.js";
import { findProjectRoot, resolveProject, resolveProjectDir, openReadProject } from "./project.js";

function gitInit(dir: string): void {
  const ran = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  expect(ran.status).toBe(0);
}

function writeEmptyDb(dir: string): void {
  mkdirSync(join(dir, ".chrono"), { recursive: true });
  writeFileSync(join(dir, ".chrono", "chrono.db"), "", "utf8");
}

describe("Project root discovery", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-root-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("finds the project from nested directories", () => {
    expect(runInit(tempDir).exitCode).toBe(0);
    const canonical = realpathSync(tempDir);
    const nested = join(tempDir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(canonical);
    expect(findProjectRoot(tempDir)).toBe(canonical);
    expect(resolveProjectDir(nested)).toBe(canonical);
  });

  it("returns null outside projects and honors explicit paths", () => {
    expect(findProjectRoot(tempDir)).toBe(null);
    expect(resolveProjectDir(tempDir)).toBe(realpathSync(tempDir));
    expect(resolveProjectDir(join(tempDir, "sub"), tempDir)).toBe(realpathSync(tempDir));
  });

  it("canonicalizes explicit symlinked paths identically to cwd resolution", () => {
    expect(runInit(tempDir).exitCode).toBe(0);
    const canonicalTemp = realpathSync(tempDir);
    const link = join(tmpdir(), `chrono-iso-explink-${process.pid}`);
    try {
      symlinkSync(tempDir, link);
      // Explicit --path through a symlink resolves to the same identity
      // as cwd-based resolution: no command may compute identity
      // differently based on spelling.
      expect(resolveProjectDir(canonicalTemp, link)).toBe(canonicalTemp);
      expect(resolveProjectDir(link)).toBe(canonicalTemp);
      // Nonexistent explicit paths cannot canonicalize: verbatim fallback.
      expect(resolveProjectDir(link, join(link, "sub"))).toBe(join(link, "sub"));
    } finally {
      // Symlink-to-directory cleanup: recursive removal unlinks on every
      // supported Node LTS (bare rmSync throws EISDIR on some versions).
      rmSync(link, { recursive: true, force: true });
    }
  });

  it("does not mistake sibling projects for parents", () => {
    expect(runInit(tempDir).exitCode).toBe(0);
    const sibling = mkdtempSync(join(tmpdir(), "chrono-root-sib-"));
    try {
      expect(findProjectRoot(sibling)).toBe(null);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});

describe("Read-only project opening", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-read-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("fails closed without creating store files", () => {
    const opened = openReadProject(tempDir, true);
    expect("failure" in opened).toBe(true);
    if ("failure" in opened) {
      expect(opened.failure.exitCode).toBe(1);
      const parsed = JSON.parse(opened.failure.stdout) as { error: { code: string } };
      expect(parsed.error.code).toBe("ENTITY_NOT_FOUND");
    }
    expect(existsSync(join(tempDir, ".chrono"))).toBe(false);
  });

  it("opens pinned projects read-only and denies version mismatch", () => {
    expect(runInit(tempDir).exitCode).toBe(0);
    const opened = openReadProject(tempDir, true);
    expect("core" in opened).toBe(true);
    if ("core" in opened) {
      expect(opened.core.status().ok).toBe(true);
      opened.core.close();
    }
    // Tamper the pin through the persistence layer (test-only): the
    // launcher must refuse to substitute cores instead of proceeding.
    const raw = new ChronoDatabase({ path: join(tempDir, ".chrono", "chrono.db") });
    try {
      raw.migrate();
      raw.runtimeConfig().set("chrono.version", "9.9.9");
    } finally {
      raw.close();
    }
    const denied = openReadProject(tempDir, true);
    expect("failure" in denied).toBe(true);
    if ("failure" in denied) {
      expect(denied.failure.exitCode).toBe(2);
      const parsed = JSON.parse(denied.failure.stdout) as { error: { code: string } };
      expect(parsed.error.code).toBe("CONFIG_ERROR");
    }
  });

  it("upgrades legacy databases once, then resumes read-only", () => {
    // Legacy project: created by direct Core use without a pin.
    const legacy = new ChronoCore({ projectPath: tempDir });
    try {
      expect(legacy.init().ok).toBe(true);
      expect(legacy.pinnedCoreVersion()).toBe(null);
    } finally {
      legacy.close();
    }
    const first = openReadProject(tempDir, true);
    expect("core" in first).toBe(true);
    if ("core" in first) {
      expect(first.core.status().ok).toBe(true);
      first.core.close();
    }
    const check = new ChronoCore({ projectPath: tempDir });
    try {
      expect(check.pinnedCoreVersion()).toBe("0.1.0");
    } finally {
      check.close();
    }
    // Unrelated files are untouched by the upgrade touch.
    writeFileSync(join(tempDir, "notes.txt"), "keep me");
    const second = openReadProject(tempDir, true);
    expect("core" in second).toBe(true);
    if ("core" in second) {
      second.core.close();
    }
    expect(readFileSync(join(tempDir, "notes.txt"), "utf8")).toBe("keep me");
  });
});

describe("Project isolation (git boundary, canonicalization)", () => {
  // Adversarial coverage for the packed-CLI dry-run finding: an
  // unrelated `.chrono` above (or beside, via /tmp) a fresh Git
  // repository must never be adopted. Git root is the maximum upward
  // boundary; canonical paths decide everything.
  let outer: string;
  const created: string[] = [];

  beforeEach(() => {
    outer = mkdtempSync(join(tmpdir(), "chrono-iso-test-"));
  });

  afterEach(() => {
    rmSync(outer, { recursive: true, force: true });
    while (created.length > 0) {
      rmSync(created.pop() as string, { recursive: true, force: true });
    }
  });

  function track(path: string): string {
    created.push(path);
    return path;
  }

  it("never adopts .chrono above the git root", () => {
    writeEmptyDb(outer);
    const repo = join(outer, "fresh-repo");
    mkdirSync(repo, { recursive: true });
    gitInit(repo);
    const nested = join(repo, "sub", "dir");
    mkdirSync(nested, { recursive: true });
    const canonicalRepo = realpathSync(repo);
    expect(findProjectRoot(repo)).toBe(null);
    expect(findProjectRoot(nested)).toBe(null);
    expect(resolveProjectDir(repo)).toBe(canonicalRepo);
    expect(resolveProjectDir(nested)).toBe(canonicalRepo);
  });

  it("preserves nested adoption inside non-git trees", () => {
    expect(runInit(outer).exitCode).toBe(0);
    const canonicalOuter = realpathSync(outer);
    const nested = join(outer, "sub", "dir");
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(canonicalOuter);
    expect(resolveProjectDir(nested)).toBe(canonicalOuter);
  });

  it("adopts an existing .chrono at the git root from nested dirs", () => {
    const repo = join(outer, "repo");
    mkdirSync(repo, { recursive: true });
    gitInit(repo);
    expect(runInit(repo).exitCode).toBe(0);
    const canonicalRepo = realpathSync(repo);
    const nested = join(repo, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(canonicalRepo);
    expect(resolveProjectDir(nested)).toBe(canonicalRepo);
  });

  it("keeps nested independent git repositories separate", () => {
    expect(runInit(outer).exitCode).toBe(0);
    gitInit(outer);
    const inner = join(outer, "inner");
    mkdirSync(inner, { recursive: true });
    gitInit(inner);
    const canonicalInner = realpathSync(inner);
    expect(findProjectRoot(inner)).toBe(null);
    expect(resolveProjectDir(inner)).toBe(canonicalInner);
  });

  it("canonicalizes symlinked project paths consistently", () => {
    expect(runInit(outer).exitCode).toBe(0);
    const canonicalOuter = realpathSync(outer);
    const link = track(join(tmpdir(), `chrono-iso-link-${process.pid}`));
    symlinkSync(outer, link);
    const nested = join(link, "sub");
    mkdirSync(nested, { recursive: true });
    // Through the symlink, above it, and at the target: one identity.
    expect(findProjectRoot(link)).toBe(canonicalOuter);
    expect(findProjectRoot(nested)).toBe(canonicalOuter);
    expect(resolveProjectDir(nested)).toBe(canonicalOuter);
  });

  it("never adopts temp-ancestor state in non-git trees", () => {
    // Deterministic mechanism test: the sandbox root carries an
    // unrelated `.chrono` and is declared a shared-temp boundary, so
    // the child project must not inherit it.
    writeEmptyDb(outer);
    const child = join(outer, "child");
    mkdirSync(child, { recursive: true });
    const boundaries = [realpathSync(outer)] as const;
    expect(findProjectRoot(child, { tempBoundaries: boundaries })).toBe(null);
    expect(resolveProject(child, { tempBoundaries: boundaries }).root).toBe(realpathSync(child));
    // Without the boundary declaration the nested project adopts
    // normally (non-git nested invocation keeps working).
    expect(findProjectRoot(child)).toBe(realpathSync(outer));
  });

  it("modifies no files outside the selected repository", () => {
    // Resolution is pure: parent stores keep byte-identical content
    // and mtimes across repeated resolution from nested probes.
    writeEmptyDb(outer);
    const repo = join(outer, "repo");
    mkdirSync(repo, { recursive: true });
    gitInit(repo);
    const nested = join(repo, "sub");
    mkdirSync(nested, { recursive: true });
    const dbPath = join(outer, ".chrono", "chrono.db");
    const before = readFileSync(dbPath);
    const mtimeBefore = statSync(dbPath).mtimeMs;
    for (let i = 0; i < 3; i++) {
      expect(findProjectRoot(nested)).toBe(null);
      expect(resolveProjectDir(nested)).toBe(realpathSync(repo));
    }
    expect(readFileSync(dbPath)).toEqual(before);
    expect(statSync(dbPath).mtimeMs).toBe(mtimeBefore);
  });

  it("reproduces the packed-CLI dry-run finding under the shared temp root", () => {
    // Best-effort host repro of the reported bug: a fresh Git
    // repository directly under /tmp must never adopt an unrelated
    // /private/tmp/.chrono, whether or not one exists on the host.
    // Never creates or modifies /tmp/.chrono itself.
    const probe = track(mkdtempSync("/tmp/chrono-dryrun-repro-"));
    gitInit(probe);
    const canonicalProbe = realpathSync(probe);
    expect(canonicalProbe.startsWith(realpathSync("/tmp"))).toBe(true);
    expect(findProjectRoot(probe)).toBe(null);
    expect(resolveProjectDir(probe)).toBe(canonicalProbe);
  });

  it("rejects adoption on stored-identity mismatch, allows legacy rows", () => {
    expect(runInit(outer).exitCode).toBe(0);
    const canonicalOuter = realpathSync(outer);
    const nested = join(outer, "sub");
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(canonicalOuter);
    // Tamper the stored identity: adoption must fail closed.
    const raw = new ChronoDatabase({ path: join(outer, ".chrono", "chrono.db") });
    try {
      raw.migrate();
      raw.runtimeConfig().set("project.root", join(outer, "elsewhere"));
    } finally {
      raw.close();
    }
    expect(findProjectRoot(nested)).toBe(null);
    // Legacy rows without a recorded identity stay adoptable.
    const direct = new Database(join(outer, ".chrono", "chrono.db"));
    try {
      direct.prepare("DELETE FROM runtime_config WHERE key = ?").run("project.root");
    } finally {
      direct.close();
    }
    expect(findProjectRoot(nested)).toBe(canonicalOuter);
  });
});
