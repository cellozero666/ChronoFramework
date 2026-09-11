/**
 * Slice 5 tests — minimal usable CLI delegates to the Core.
 * Proves a fresh project can be initialized, reopened, and validated
 * through the CLI layer with no conversation memory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit, runStatus, runValidate, createProgram } from "./index.js";

describe("CLI: init", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-cli-test-"));
  });

  afterEach(() => {
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("initializes a fresh project", () => {
    const out = runInit(tempDir);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("Initialized CHRONO project");
    expect(out.stderr).toBe("");
  });

  it("fails closed on double init", () => {
    expect(runInit(tempDir).exitCode).toBe(0);
    const second = runInit(tempDir);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("PROJECT_EXISTS");
  });

  it("emits parseable JSON with --json", () => {
    const out = runInit(tempDir, { json: true });
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { ok: boolean; projectId: string; state: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.projectId).toBe("default");
  });
});

describe("CLI: status", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-cli-test-"));
  });

  afterEach(() => {
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when no project exists", () => {
    const out = runStatus(tempDir);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("ENTITY_NOT_FOUND");
  });

  it("shows status after init (fresh Core instance = reopen proof)", () => {
    expect(runInit(tempDir).exitCode).toBe(0);
    const out = runStatus(tempDir);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("state:");
    expect(out.stdout).toContain("specs: 0");
  });

  it("emits parseable JSON with --json", () => {
    expect(runInit(tempDir).exitCode).toBe(0);
    const out = runStatus(tempDir, { json: true });
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { ok: boolean; state: string; specCount: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.specCount).toBe(0);
  });
});

describe("CLI: validate", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-cli-test-"));
  });

  afterEach(() => {
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("validates a fresh project as VALID", () => {
    expect(runInit(tempDir).exitCode).toBe(0);
    const out = runValidate(tempDir);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("VALID");
  });

  it("fails closed when no project exists", () => {
    const out = runValidate(tempDir);
    expect(out.exitCode).toBe(1);
  });
});

describe("CLI: end-to-end init → status → validate", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-cli-test-"));
  });

  afterEach(() => {
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("completes the Slice 5 lifecycle with independent Core instances", () => {
    // Each run* call constructs and closes its own ChronoCore —
    // no shared memory, only .chrono/chrono.db persists.
    const init = runInit(tempDir);
    expect(init.exitCode).toBe(0);

    const status = runStatus(tempDir, { json: true });
    expect(status.exitCode).toBe(0);
    const parsed = JSON.parse(status.stdout) as { state: string; activeBlockers: number };
    expect(parsed.activeBlockers).toBe(0);

    const validate = runValidate(tempDir);
    expect(validate.exitCode).toBe(0);
    expect(validate.stdout).toContain("VALID");
  });
});

describe("CLI: construction failures", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-cli-test-"));
  });

  afterEach(() => {
    if (typeof tempDir === "string") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns structured exit-1 failure when no project exists (never materializing a store)", () => {
    // A regular file where the project directory should be.
    const blocker = join(tempDir, "file");
    writeFileSync(blocker, "not a directory");
    const target = join(blocker, "child");
    const out = runStatus(target);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("ENTITY_NOT_FOUND");
    expect(out.stderr).toContain("chrono init");
    // Read paths must not create store files as a side effect.
    expect(existsSync(join(target, ".chrono"))).toBe(false);
  });

  it("emits JSON on missing-project failure with --json", () => {
    const blocker = join(tempDir, "file");
    writeFileSync(blocker, "not a directory");
    const out = runValidate(join(blocker, "child"), { json: true });
    expect(out.exitCode).toBe(1);
    const parsed = JSON.parse(out.stdout) as { ok: boolean; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("ENTITY_NOT_FOUND");
  });
});

describe("CLI: program wiring", () => {
  it("registers init, status, and validate commands", () => {
    const program = createProgram("/tmp");
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("init");
    expect(names).toContain("status");
    expect(names).toContain("validate");
    expect(names).toContain("approve");
    expect(names).toContain("waive");
    expect(names).toContain("keys");
    expect(names).toContain("gate");
    expect(names).toContain("rtk");
    expect(names).toContain("skill");
    expect(names).toContain("run");
    expect(names).toContain("adapter");
    expect(names).toContain("setup");
    expect(names).toContain("session");
    expect(names).toContain("doctor");
    expect(names).toContain("broker");
    expect(names).toContain("entry");
    expect(names).toContain("uninstall");
  });

  it("runs init --dry-run end to end without writing state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chrono-wiring-"));
    try {
      const program = createProgram(dir);
      program.exitOverride();
      const lines: string[] = [];
      const originalLog = console.log;
      console.log = (text: unknown): void => {
        lines.push(String(text));
      };
      try {
        await program.parseAsync(["init", "--dry-run", "--path", dir], { from: "user" });
      } finally {
        console.log = originalLog;
      }
      expect(lines.join("\n")).toContain("Dry run");
      expect(existsSync(join(dir, ".chrono"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks rendered failures so bin.ts adds no second JSON envelope", async () => {
    const program = createProgram("/tmp");
    program.exitOverride();
    const failure = await program
      .parseAsync(["gate", "teleport"], { from: "user" })
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(failure).not.toBeNull();
    expect((failure as { exitCode?: number }).exitCode).toBe(2);
    expect((failure as { chronoEmitted?: boolean }).chronoEmitted).toBe(true);
  });
});
