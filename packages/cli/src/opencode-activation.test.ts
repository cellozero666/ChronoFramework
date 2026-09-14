/**
 * OC-P9 — automatic Gaspar activation race/evidence tests.
 *
 * A provider-backed pilot answered a first message with a generic
 * greeting and no Gaspar activation. Contributing defects: session
 * correlation used fictional event shapes with a catch-all bucket,
 * prefetch was fire-and-forget while the transform assumed ordering,
 * and nothing gated the first *message*.
 *
 * These tests pin the corrected contract against the verified
 * @opencode-ai/plugin@1.18.30 shapes (session.created carries
 * properties.info.id; system.transform sessionID is optional):
 * one per-session promise shared by prefetch/message/transform/tools,
 * fail-closed chat.message gating, exactly-once injection, bounded
 * retries, and non-secret runtime evidence.
 *
 * Everything hermetic: fixture entry scripts stand in for
 * `chrono entry`; only the generated plugin bytes run for real.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildOpencodePlugin } from "./opencode-plugin.js";
import { readActivationEvidence } from "./init-flow.js";

function validPayload(sessionId = "SES-0001"): string {
  return JSON.stringify({
    ok: true,
    sessionId,
    projection: {
      projectState: "ANALYZING",
      nextAction: { key: "resume-discovery", summary: "Resume discovery" },
      requiredDecisions: [],
    },
    skill: { installed: true },
  });
}

describe("OC-P9 Gaspar activation (race-safe, fail-closed)", () => {
  let tempDir: string;
  let pluginPath: string;
  let savedEnv: Record<string, string | undefined>;

  function writeEntryScript(body: string): void {
    writeFileSync(join(tempDir, ".chrono", "hooks", "chrono-entry-session.sh"), `#!/bin/sh\n${body}\n`, "utf8");
    chmodSync(join(tempDir, ".chrono", "hooks", "chrono-entry-session.sh"), 0o755);
  }

  function countingScript(payload: string): string {
    // Appends one line per entry execution so tests prove single-flight.
    return `echo run >> "$CHRONO_COUNT"\necho '${payload}'`;
  }

  async function hooksFor(directory: string): Promise<{
    event: (event: unknown) => Promise<unknown>;
    message: (input: unknown) => Promise<unknown>;
    params: (input: unknown) => Promise<unknown>;
    transform: (input: unknown, output: { system: unknown[] }) => Promise<unknown>;
    before: (input: unknown) => Promise<unknown>;
  }> {
    const module = (await import(pathToFileURL(pluginPath).href)) as {
      ChronoGatePlugin: (ctx: unknown) => Promise<{
        event: (event: unknown) => Promise<unknown>;
        "chat.message": (input: unknown) => Promise<unknown>;
        "chat.params": (input: unknown) => Promise<unknown>;
        "experimental.chat.system.transform": (input: unknown, output: { system: unknown[] }) => Promise<unknown>;
        "tool.execute.before": (input: unknown) => Promise<unknown>;
      }>;
    };
    const hooks = await module.ChronoGatePlugin({ directory });
    return {
      event: hooks.event,
      message: hooks["chat.message"],
      params: hooks["chat.params"],
      transform: hooks["experimental.chat.system.transform"],
      before: hooks["tool.execute.before"],
    };
  }

  function createdEvent(id: string): unknown {
    return { event: { type: "session.created", properties: { info: { id } } } };
  }

  function deletedEvent(id: string): unknown {
    return { event: { type: "session.deleted", properties: { info: { id } } } };
  }

  function entryRuns(): number {
    const countFile = process.env["CHRONO_COUNT"];
    if (countFile === undefined) {
      return 0;
    }
    try {
      return readFileSync(countFile, "utf8").split("\n").filter((l) => l.length > 0).length;
    } catch {
      return 0;
    }
  }

  function evidenceLines(): Array<Record<string, unknown>> {
    try {
      return readFileSync(join(tempDir, ".chrono", "runtime-activation.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-ocp9-"));
    mkdirSync(join(tempDir, ".chrono", "hooks"), { recursive: true });
    writeFileSync(join(tempDir, ".chrono", "chrono.db"), "", "utf8");
    pluginPath = join(tempDir, "chrono-gate.js");
    writeFileSync(pluginPath, buildOpencodePlugin(), "utf8");
    writeEntryScript(`echo '${validPayload()}'`);
    savedEnv = { ...process.env };
    delete process.env["CHRONO_BIN"];
    delete process.env["CHRONO_ENTRY_ADAPTER"];
    delete process.env["CHRONO_ENTRY_TIMEOUT_MS"];
    delete process.env["TMPDIR"];
    delete process.env["CHRONO_COUNT"];
    delete process.env["CHRONO_FLAG"];
  });

  afterEach(() => {
    for (const key of ["CHRONO_BIN", "CHRONO_ENTRY_ADAPTER", "CHRONO_ENTRY_TIMEOUT_MS", "TMPDIR", "CHRONO_COUNT", "CHRONO_FLAG"]) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("gates the first message synchronously and injects exactly once", async () => {
    const hooks = await hooksFor(tempDir);
    // First message establishes entry (would previously sail through
    // to a default agent when the transform path was skipped).
    await expect(hooks.message({ sessionID: "m1" })).resolves.toBeUndefined();
    const output = { system: [] as unknown[] };
    await hooks.transform({ sessionID: "m1" }, output);
    expect(output.system).toHaveLength(1);
    const injected = String(output.system[0]);
    expect(injected).toContain("chrono-gaspar-entry");
    expect(injected).toContain("You are Gaspar");
    expect(injected).toContain("Product Owner");
    expect(injected).toContain("FIRST message");
    expect(injected).toContain("karpathy-guidelines");
    // No duplicate injection across message + transform + retry.
    await hooks.message({ sessionID: "m1" });
    await hooks.transform({ sessionID: "m1" }, output);
    expect(output.system).toHaveLength(1);
  });

  it("denies the first message when entry fails (never a default response)", async () => {
    writeEntryScript("echo denied >&2; exit 3");
    const hooks = await hooksFor(tempDir);
    await expect(hooks.message({ sessionID: "m-fail" })).rejects.toThrow(/ENTRY_BLOCKED/);
    await expect(hooks.transform({ sessionID: "m-fail" }, { system: [] })).rejects.toThrow(/ENTRY_BLOCKED/);
  });

  it("transforms before session.created establish entry lazily", async () => {
    const hooks = await hooksFor(tempDir);
    const output = { system: [] as unknown[] };
    await hooks.transform({ sessionID: "lazy-1" }, output);
    expect(output.system).toHaveLength(1);
    expect(String(output.system[0])).toContain("chrono-gaspar-entry");
  });

  it("dedicates one entry run to concurrent prefetch and transform", async () => {
    const countFile = join(tempDir, "entry-count");
    process.env["CHRONO_COUNT"] = countFile;
    writeEntryScript(`sleep 1; ${countingScript(validPayload())}`);
    const hooks = await hooksFor(tempDir);
    // Prefetch fired without awaiting (real runtime timing), transform
    // immediately after: both must share one entry execution.
    const prefetch = hooks.event(createdEvent("race-1"));
    const output = { system: [] as unknown[] };
    await hooks.transform({ sessionID: "race-1" }, output);
    await prefetch;
    expect(output.system).toHaveLength(1);
    expect(entryRuns()).toBe(1);
  });

  it("dedupes concurrent transforms into a single entry run and injection", async () => {
    const countFile = join(tempDir, "entry-count");
    process.env["CHRONO_COUNT"] = countFile;
    writeEntryScript(`sleep 1; ${countingScript(validPayload())}`);
    const hooks = await hooksFor(tempDir);
    const outputs = [{ system: [] as unknown[] }, { system: [] as unknown[] }, { system: [] as unknown[] }];
    await Promise.all([
      hooks.transform({ sessionID: "conc-1" }, outputs[0] as { system: unknown[] }),
      hooks.transform({ sessionID: "conc-1" }, outputs[1] as { system: unknown[] }),
      hooks.transform({ sessionID: "conc-1" }, outputs[2] as { system: unknown[] }),
    ]);
    expect(entryRuns()).toBe(1);
    // Exactly one of the three outputs carries the injection.
    const injected = outputs.filter((o) => o.system.length === 1);
    expect(injected).toHaveLength(1);
  });

  it("recovers after prefetch failure within the bounded budget", async () => {
    const flag = join(tempDir, "entry-ok");
    process.env["CHRONO_FLAG"] = flag;
    writeEntryScript(`if [ -f "$CHRONO_FLAG" ]; then echo '${validPayload()}'; else echo blocked >&2; exit 3; fi`);
    const hooks = await hooksFor(tempDir);
    await hooks.event(createdEvent("rec-1"));
    const output = { system: [] as unknown[] };
    await expect(hooks.transform({ sessionID: "rec-1" }, output)).rejects.toThrow(/ENTRY_BLOCKED/);
    expect(output.system).toHaveLength(0);
    // Recovery: first request may retry after the cause is fixed.
    writeFileSync(flag, "ok", "utf8");
    await hooks.transform({ sessionID: "rec-1" }, output);
    expect(output.system).toHaveLength(1);
    expect(String(output.system[0])).toContain("chrono-gaspar-entry");
  });

  it("fails terminally after the attempt budget without silent fallback", async () => {
    writeEntryScript("exit 3");
    const hooks = await hooksFor(tempDir);
    const output = { system: [] as unknown[] };
    await expect(hooks.transform({ sessionID: "term-1" }, output)).rejects.toThrow(/ENTRY_BLOCKED/);
    await expect(hooks.transform({ sessionID: "term-1" }, output)).rejects.toThrow(/ENTRY_BLOCKED/);
    await expect(hooks.transform({ sessionID: "term-1" }, output)).rejects.toThrow(/ENTRY_BLOCKED/);
    await expect(hooks.transform({ sessionID: "term-1" }, output)).rejects.toThrow(/will not be retried/);
    await expect(hooks.message({ sessionID: "term-1" })).rejects.toThrow(/will not be retried/);
    expect(output.system).toHaveLength(0);
  });

  it("treats delayed entry below the timeout as success", async () => {
    writeEntryScript(`sleep 1; echo '${validPayload()}'`);
    const hooks = await hooksFor(tempDir);
    const output = { system: [] as unknown[] };
    await hooks.transform({ sessionID: "slow-ok" }, output);
    expect(output.system).toHaveLength(1);
  });

  it("treats delayed entry above the timeout as ENTRY_TIMEOUT and stays retryable", async () => {
    process.env["CHRONO_ENTRY_TIMEOUT_MS"] = "200";
    writeEntryScript(`sleep 5; echo '${validPayload()}'`);
    const hooks = await hooksFor(tempDir);
    const output = { system: [] as unknown[] };
    await expect(hooks.transform({ sessionID: "slow-to" }, output)).rejects.toThrow(/ENTRY_BLOCKED\[ENTRY_TIMEOUT\]/);
    expect(output.system).toHaveLength(0);
    // Within budget: fixing the cause lets the next attempt succeed.
    delete process.env["CHRONO_ENTRY_TIMEOUT_MS"];
    writeEntryScript(`echo '${validPayload()}'`);
    await hooks.transform({ sessionID: "slow-to" }, output);
    expect(output.system).toHaveLength(1);
  });

  it("ignores duplicate session.created events with one entry run", async () => {
    const countFile = join(tempDir, "entry-count");
    process.env["CHRONO_COUNT"] = countFile;
    writeEntryScript(countingScript(validPayload()));
    const hooks = await hooksFor(tempDir);
    await hooks.event(createdEvent("dup-1"));
    await hooks.event(createdEvent("dup-1"));
    expect(entryRuns()).toBe(1);
    const output = { system: [] as unknown[] };
    await hooks.transform({ sessionID: "dup-1" }, output);
    expect(output.system).toHaveLength(1);
    expect(entryRuns()).toBe(1);
  });

  it("joins the observed session when the transform carries no session id", async () => {
    const countFile = join(tempDir, "entry-count");
    process.env["CHRONO_COUNT"] = countFile;
    writeEntryScript(countingScript(validPayload()));
    const hooks = await hooksFor(tempDir);
    await hooks.event(createdEvent("anon-owner"));
    const output = { system: [] as unknown[] };
    await hooks.transform({}, output);
    expect(output.system).toHaveLength(1);
    // Joined the observed session instead of minting a duplicate entry.
    expect(entryRuns()).toBe(1);
  });

  it("stays silent outside CHRONO projects on every hook", async () => {
    const plain = mkdtempSync(join(tmpdir(), "chrono-plain-"));
    try {
      const hooks = await hooksFor(plain);
      await expect(hooks.message({ sessionID: "p1" })).resolves.toBeUndefined();
      const output = { system: [] as unknown[] };
      await expect(hooks.transform({ sessionID: "p1" }, output)).resolves.toBeUndefined();
      expect(output.system).toHaveLength(0);
      await hooks.event(createdEvent("p1"));
      await expect(hooks.before({ tool: "bash" })).resolves.toBeUndefined();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("records non-secret runtime evidence for plugin, redeem, and injection", async () => {
    const hooks = await hooksFor(tempDir);
    await hooks.event(createdEvent("ev-1"));
    await hooks.message({ sessionID: "ev-1", junkSecret: "sk-test-should-never-appear" });
    const output = { system: [] as unknown[] };
    await hooks.transform({ sessionID: "ev-1" }, output);
    expect(output.system).toHaveLength(1);
    const lines = evidenceLines();
    const kinds = lines.map((l) => String(l["kind"]));
    expect(kinds).toContain("plugin-load");
    expect(kinds).toContain("entry-redeemed");
    expect(kinds).toContain("projection-injected");
    const injected = lines.filter((l) => l["kind"] === "projection-injected");
    expect(injected).toHaveLength(1);
    expect(injected[0]).toMatchObject({ session: "ev-1", hook: "experimental.chat.system.transform", skillIncluded: true });
    expect(typeof injected[0]?.["projectionHash"]).toBe("string");
    const redeemed = lines.filter((l) => l["kind"] === "entry-redeemed");
    expect(redeemed).toHaveLength(1);
    expect(redeemed[0]?.["entrySession"]).toBe("SES-0001");
    // Req 8: no prompts, user content, secrets, tokens, or credentials.
    const haystack = lines.map((l) => JSON.stringify(l)).join("\n");
    expect(haystack).not.toContain("sk-test-should-never-appear");
    expect(haystack).not.toContain("PRIVATE KEY");
    expect(haystack).not.toContain("Olá");
    expect(haystack).not.toMatch(/SES-0001\/[A-Za-z0-9]/);
    // Injection happened exactly once before generation.
    expect(lines.filter((l) => l["kind"] === "projection-injected")).toHaveLength(1);
  });

  it("restarts cleanly after session.deleted with a fresh entry", async () => {
    const countFile = join(tempDir, "entry-count");
    process.env["CHRONO_COUNT"] = countFile;
    writeEntryScript(countingScript(validPayload()));
    const hooks = await hooksFor(tempDir);
    await hooks.event(createdEvent("rs-1"));
    expect(entryRuns()).toBe(1);
    await hooks.event(deletedEvent("rs-1"));
    const output = { system: [] as unknown[] };
    await hooks.transform({ sessionID: "rs-1" }, output);
    expect(output.system).toHaveLength(1);
    expect(entryRuns()).toBe(2);
  });

  it("tolerates the legacy session.created shape without order dependence", async () => {
    const hooks = await hooksFor(tempDir);
    await hooks.event({ event: { type: "session.created", properties: { sessionID: "leg-1" } } });
    const output = { system: [] as unknown[] };
    await hooks.transform({ sessionID: "leg-1" }, output);
    expect(output.system).toHaveLength(1);
  });
});

describe("OC-P10 native selection evidence (injection alone never proves Gaspar)", () => {
  let dir: string;
  let pluginFile: string;
  let saved: Record<string, string | undefined>;

  function writeScript(body: string): void {
    writeFileSync(join(dir, ".chrono", "hooks", "chrono-entry-session.sh"), `#!/bin/sh\n${body}\n`, "utf8");
    chmodSync(join(dir, ".chrono", "hooks", "chrono-entry-session.sh"), 0o755);
  }

  async function localHooks(): Promise<{
    event: (event: unknown) => Promise<unknown>;
    message: (input: unknown) => Promise<unknown>;
    params: (input: unknown) => Promise<unknown>;
    transform: (input: unknown, output: { system: unknown[] }) => Promise<unknown>;
  }> {
    const module = (await import(pathToFileURL(pluginFile).href)) as {
      ChronoGatePlugin: (ctx: unknown) => Promise<{
        event: (event: unknown) => Promise<unknown>;
        "chat.message": (input: unknown) => Promise<unknown>;
        "chat.params": (input: unknown) => Promise<unknown>;
        "experimental.chat.system.transform": (input: unknown, output: { system: unknown[] }) => Promise<unknown>;
      }>;
    };
    const hooks = await module.ChronoGatePlugin({ directory: dir });
    return {
      event: hooks.event,
      message: hooks["chat.message"],
      params: hooks["chat.params"],
      transform: hooks["experimental.chat.system.transform"],
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chrono-ocp10-"));
    mkdirSync(join(dir, ".chrono", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".chrono", "chrono.db"), "", "utf8");
    pluginFile = join(dir, "chrono-gate.js");
    writeFileSync(pluginFile, buildOpencodePlugin(), "utf8");
    writeScript(`echo '${validPayload()}'`);
    saved = { ...process.env };
    delete process.env["CHRONO_BIN"];
    delete process.env["CHRONO_ENTRY_ADAPTER"];
    delete process.env["CHRONO_ENTRY_TIMEOUT_MS"];
    delete process.env["TMPDIR"];
  });

  afterEach(() => {
    for (const key of ["CHRONO_BIN", "CHRONO_ENTRY_ADAPTER", "CHRONO_ENTRY_TIMEOUT_MS", "TMPDIR"]) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function selectedSession(session: string, agent: string): Promise<void> {
    const hooks = await localHooks();
    await hooks.event({ event: { type: "session.created", properties: { info: { id: session } } } });
    await hooks.message({ sessionID: session });
    const output = { system: [] as unknown[] };
    await hooks.transform({ sessionID: session }, output);
    expect(output.system).toHaveLength(1);
    await hooks.params({ sessionID: session, agent });
  }

  it("reports observed only for exact-session Gaspar selection with prior injection", async () => {
    await selectedSession("sel-gaspar", "gaspar");
    const report = readActivationEvidence(dir);
    expect(report.observed).toBe(true);
    expect(report.selectedAgent).toBe("gaspar");
    expect(report.lastSelection).toMatchObject({ session: "sel-gaspar", agent: "gaspar" });
    expect(report.detail).toContain("sel-gaspar");
  });

  it("never reports a Build session as Gaspar activation", async () => {
    await selectedSession("sel-build", "build");
    const report = readActivationEvidence(dir);
    expect(report.observed).toBe(false);
    expect(report.selectedAgent).toBe("build");
    expect(report.detail).toContain("sel-build");
    expect(report.detail).toContain("build");
  });

  it("leaves projection-only evidence unobserved", async () => {
    const hooks = await localHooks();
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "proj-only" } } } });
    await hooks.message({ sessionID: "proj-only" });
    const output = { system: [] as unknown[] };
    await hooks.transform({ sessionID: "proj-only" }, output);
    expect(output.system).toHaveLength(1);
    const report = readActivationEvidence(dir);
    expect(report.observed).toBe(false);
    expect(report.selectedAgent).toBeNull();
    expect(report.detail).toContain("never proves Gaspar activation");
  });

  it("requires injection at or before the Gaspar selection", async () => {
    const hooks = await localHooks();
    // Selection observed before any injection for this session.
    await hooks.params({ sessionID: "order-1", agent: "gaspar" });
    await hooks.message({ sessionID: "order-1" });
    const output = { system: [] as unknown[] };
    await hooks.transform({ sessionID: "order-1" }, output);
    expect(output.system).toHaveLength(1);
    const report = readActivationEvidence(dir);
    expect(report.observed).toBe(false);
    expect(report.detail).toContain("injected after that selection");
  });

  it("ignores hidden system agents in the selected-primary verdict", async () => {
    await selectedSession("sel-hidden", "gaspar");
    const hooks = await localHooks();
    await hooks.params({ sessionID: "sel-hidden", agent: "title" });
    const report = readActivationEvidence(dir);
    expect(report.observed).toBe(true);
    expect(report.selectedAgent).toBe("gaspar");
  });
});

describe("OC-P9 doctor activation evidence (setup readiness vs runtime activation)", () => {
  let dir: string;

  function evidencePath(): string {
    return join(dir, ".chrono", "runtime-activation.jsonl");
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chrono-ocp9-doc-"));
    mkdirSync(join(dir, ".chrono"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("never claims activation from static assets alone", () => {
    const report = readActivationEvidence(dir);
    expect(report.observed).toBe(false);
    expect(report.lastInjection).toBeNull();
    expect(report.detail).toContain("never prove Gaspar activation");
  });

  it("reports the last injection with session metadata and ignores other adapters", () => {
    writeFileSync(
      evidencePath(),
      [
        JSON.stringify({ v: 1, ts: "2026-09-14T00:00:00.000Z", adapter: "opencode", generator: "x", kind: "plugin-load" }),
        JSON.stringify({ v: 1, ts: "2026-09-14T00:01:00.000Z", adapter: "kiro", kind: "projection-injected", session: "k", entrySession: "SES-9", projectionHash: "ab", hook: "h" }),
        "not-json{{",
        JSON.stringify({ v: 1, ts: "2026-09-14T00:02:00.000Z", adapter: "opencode", kind: "entry-blocked", code: "ENTRY_DENIED" }),
        JSON.stringify({ v: 1, ts: "2026-09-14T00:03:00.000Z", adapter: "opencode", kind: "projection-injected", session: "ses_live", entrySession: "SES-0007", projectionHash: "0123456789abcdef", hook: "experimental.chat.system.transform", skillIncluded: true }),
        JSON.stringify({ v: 1, ts: "2026-09-14T00:04:00.000Z", adapter: "opencode", kind: "agent-selected", session: "ses_live", agent: "gaspar" }),
      ].join("\n") + "\n",
      "utf8"
    );
    const report = readActivationEvidence(dir);
    expect(report.observed).toBe(true);
    expect(report.pluginLoads).toBe(1);
    expect(report.lastInjection).toMatchObject({
      session: "ses_live",
      entrySession: "SES-0007",
      projectionHash: "0123456789ab",
      hook: "experimental.chat.system.transform",
      skillIncluded: true,
    });
    expect(report.lastSelection).toMatchObject({ session: "ses_live", agent: "gaspar" });
    expect(report.selectedAgent).toBe("gaspar");
    expect(report.lastBlock).toMatchObject({ code: "ENTRY_DENIED" });
    expect(report.detail).toContain("ses_live");
  });

  it("reports blocked-only evidence as plugin-ran-but-never-injected", () => {
    writeFileSync(
      evidencePath(),
      JSON.stringify({ v: 1, ts: "2026-09-14T00:00:00.000Z", adapter: "opencode", kind: "entry-blocked", code: "ENTRY_SCRIPT_MISSING" }) + "\n",
      "utf8"
    );
    const report = readActivationEvidence(dir);
    expect(report.observed).toBe(false);
    expect(report.lastInjection).toBeNull();
    expect(report.lastBlock).toMatchObject({ code: "ENTRY_SCRIPT_MISSING" });
    expect(report.detail).toContain("last entry attempt was blocked");
  });
});
