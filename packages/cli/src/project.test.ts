/**
 * Slice 10 tests — project root discovery and read-only Core opening.
 * [SLICE-10 §2]: nested invocation finds the project; missing stores
 * fail closed without materializing files; legacy databases get one
 * audited upgrade touch before read-only use resumes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChronoCore } from "@chrono/core";
import { ChronoDatabase } from "@chrono/persistence";
import { runInit } from "./index.js";
import { findProjectRoot, resolveProjectDir, openReadProject } from "./project.js";

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
    expect(resolveProjectDir(tempDir)).toBe(tempDir);
    expect(resolveProjectDir(join(tempDir, "sub"), tempDir)).toBe(tempDir);
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
