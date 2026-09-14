/**
 * OC-P10 — native OpenCode agent activation unit tests.
 *
 * Covers deterministic role-definition generation (exact names, Gaspar
 * primary, model-neutral, frontmatter validity, no secrets) and the
 * comment-preserving structural merge of the user-owned project
 * configuration: byte preservation, backup-once, sidecar ownership,
 * malformed/ambiguous fail-closed, idempotence, uninstall restoration,
 * and the absolute ban on provider/model writes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHRONO_OPENCODE_ROLES,
  applyOpenCodeDefaultAgent,
  buildOpenCodeAgentDefinition,
  checkOpenCodeDefaultAgent,
  mergeDefaultAgent,
  openCodeAgentPath,
  parseAgentFrontmatter,
  readProjectDefaultAgent,
  readTopLevelDefaultAgent,
  removeDefaultAgentKey,
  resolveOpenCodeConfigFile,
  stripJsonComments,
  type ChronoOpenCodeRole,
} from "./opencode-agent.js";

describe("OpenCode role definitions (OC-P10)", () => {
  it("uses the exact canonical role names", () => {
    expect([...CHRONO_OPENCODE_ROLES]).toEqual([
      "gaspar",
      "belthazar",
      "melchior",
      "prometheus",
      "lucca",
      "glenn",
      "spekkio",
    ]);
    for (const role of CHRONO_OPENCODE_ROLES) {
      expect(openCodeAgentPath(role)).toBe(`.opencode/agents/${role}.md`);
    }
  });

  it("makes Gaspar the visible primary and every other role a subagent", () => {
    for (const role of CHRONO_OPENCODE_ROLES) {
      const content = buildOpenCodeAgentDefinition(role as ChronoOpenCodeRole);
      const frontmatter = parseAgentFrontmatter(content);
      expect(frontmatter).not.toBeNull();
      expect(frontmatter?.mode).toBe(role === "gaspar" ? "primary" : "subagent");
      expect((frontmatter?.description ?? "").length).toBeGreaterThan(10);
    }
  });

  it("is model-neutral and secret-free", () => {
    for (const role of CHRONO_OPENCODE_ROLES) {
      const content = buildOpenCodeAgentDefinition(role as ChronoOpenCodeRole);
      expect(content).not.toMatch(/^model:/m);
      expect(content).not.toContain("sk-");
      expect(content).not.toContain("PRIVATE KEY");
      expect(content).not.toContain("apiKey");
      expect(content).not.toContain("password");
      expect(content).not.toContain("bearer");
      // No credential assignments (prose like "secret isolation" is fine).
      expect(content).not.toMatch(/secret\s*[:=]/i);
    }
    const gaspar = buildOpenCodeAgentDefinition("gaspar");
    expect(gaspar).toContain("Product Owner");
    expect(gaspar).toContain("Karpathy Guidelines");
    expect(gaspar).toContain("Core");
  });

  it("exposes the native question tool to Gaspar and to no other role", () => {
    // Availability fix: OpenCode denies tools by default, so the
    // native `question` confirmation boundary only renders when the
    // Gaspar agent policy explicitly allows it.
    const gaspar = buildOpenCodeAgentDefinition("gaspar");
    expect(gaspar).toContain("question: allow");
    for (const role of CHRONO_OPENCODE_ROLES) {
      if (role === "gaspar") {
        continue;
      }
      expect(buildOpenCodeAgentDefinition(role as ChronoOpenCodeRole)).not.toContain("question: allow");
    }
  });

  it("is deterministic across generations", () => {
    for (const role of CHRONO_OPENCODE_ROLES) {
      expect(buildOpenCodeAgentDefinition(role as ChronoOpenCodeRole)).toBe(
        buildOpenCodeAgentDefinition(role as ChronoOpenCodeRole)
      );
    }
  });
});

describe("OpenCode default_agent merge (OC-P10)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chrono-ocp10-cfg-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the canonical minimal configuration when absent", () => {
    const merged = mergeDefaultAgent(null, "gaspar");
    expect(merged.changed).toBe(true);
    expect(merged.previous).toBeNull();
    expect(JSON.parse(merged.content)).toMatchObject({ default_agent: "gaspar" });
    expect(merged.content).not.toMatch(/"model"/);
  });

  it("preserves unrelated keys, comments, and formatting byte-for-byte", () => {
    const existing = [
      "{",
      '  // the PO model stays exactly as configured',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "model": "example-oracle/qa-model",',
      '  "permission": { "edit": "ask" } /* trailing note */,',
      '  "mcp": {}',
      "}",
      "",
    ].join("\n");
    const merged = mergeDefaultAgent(existing, "gaspar");
    expect(merged.changed).toBe(true);
    expect(merged.previous).toBeNull();
    // Everything except the inserted key is untouched.
    expect(merged.content).toContain('  // the PO model stays exactly as configured');
    expect(merged.content).toContain('"model": "example-oracle/qa-model"');
    expect(merged.content).toContain('"permission": { "edit": "ask" } /* trailing note */');
    expect(merged.content).toContain('"mcp": {}');
    expect(readTopLevelDefaultAgent(merged.content).value).toBe("gaspar");
    // The user's own model key survives byte-identically (never removed).
    expect(merged.content).toContain('"model": "example-oracle/qa-model"');
  });

  it("replaces an existing default without touching siblings", () => {
    const existing = `{\n  "model": "m",\n  "default_agent": "build",\n  "snapshot": false\n}\n`;
    const merged = mergeDefaultAgent(existing, "gaspar");
    expect(merged.changed).toBe(true);
    expect(merged.previous).toBe("build");
    expect(merged.content).toContain('"default_agent": "gaspar"');
    expect(merged.content).toContain('"model": "m"');
    expect(merged.content).toContain('"snapshot": false');
    expect(merged.content).not.toContain("build");
  });

  it("is idempotent on identical input", () => {
    const existing = `{\n  "default_agent": "gaspar"\n}\n`;
    const merged = mergeDefaultAgent(existing, "gaspar");
    expect(merged.changed).toBe(false);
    expect(merged.content).toBe(existing);
  });

  it("refuses duplicate keys, non-string values, and malformed content", () => {
    expect(() => mergeDefaultAgent(`{"default_agent": "a", "default_agent": "b"}`, "gaspar")).toThrow(/more than once/);
    expect(() => mergeDefaultAgent(`{"default_agent": {"nested": true}}`, "gaspar")).toThrow(/must be a string/);
    expect(() => mergeDefaultAgent(`{"default_agent": 42}`, "gaspar")).toThrow(/must be a string/);
    expect(() => mergeDefaultAgent(`{oops`, "gaspar")).toThrow(/not parseable/);
    expect(() => mergeDefaultAgent(`{"default_agent": "build" /* unterminated`, "gaspar")).toThrow();
    expect(() => mergeDefaultAgent(`[1, 2]`, "gaspar")).toThrow(/root must be a JSON object/);
  });

  it("never writes a provider or model key", () => {
    for (const existing of [null, `{}`, `{"model": "keep-me"}`]) {
      const merged = mergeDefaultAgent(existing, "gaspar");
      if (existing === `{"model": "keep-me"}`) {
        expect(merged.content).toContain('"model": "keep-me"');
      } else {
        expect(merged.content).not.toMatch(/"model"\s*:/);
      }
      expect(merged.content).not.toMatch(/"provider"\s*:/);
      expect(merged.content).not.toMatch(/"apiKey"/);
    }
  });

  it("removes only the added key on uninstall", () => {
    const merged = mergeDefaultAgent(`{\n  "model": "m"\n}\n`, "gaspar");
    const removed = removeDefaultAgentKey(merged.content);
    expect(JSON.parse(removed.content)).toMatchObject({ model: "m" });
    expect(removed.content).not.toContain("default_agent");
    // Already absent is a no-op.
    expect(removeDefaultAgentKey(`{"a": 1}`).content).toBe(`{"a": 1}`);
  });

  it("resolves jsonc over json and refuses both present", () => {
    expect(resolveOpenCodeConfigFile(dir).kind).toBe("none");
    writeFileSync(join(dir, "opencode.json"), `{}`, "utf8");
    expect(resolveOpenCodeConfigFile(dir)).toMatchObject({ kind: "file", relative: "opencode.json" });
    writeFileSync(join(dir, "opencode.jsonc"), `{}`, "utf8");
    const ambiguous = resolveOpenCodeConfigFile(dir);
    expect(ambiguous.kind).toBe("ambiguous");
    rmSync(join(dir, "opencode.json"));
    expect(resolveOpenCodeConfigFile(dir)).toMatchObject({ kind: "file", relative: "opencode.jsonc" });
  });

  it("strips JSONC comments for validation without touching strings", () => {
    const raw = `{\n  // line\n  "a": "http://x /* not a comment */", /* block */\n  "b": "esc \\" // kept"\n}\n`;
    expect(JSON.parse(stripJsonComments(raw))).toMatchObject({ a: "http://x /* not a comment */", b: 'esc " // kept' });
    expect(() => stripJsonComments(`{"a": "unterminated`)).toThrow(/Unterminated string/);
    expect(() => stripJsonComments(`{"a": 1} /* open`)).toThrow(/Unterminated block comment/);
  });

  it("backs up once with preserved permissions and records ownership", () => {
    const original = `{\n  "model": "m",\n  "default_agent": "build"\n}\n`;
    const file = join(dir, "opencode.json");
    writeFileSync(file, original, "utf8");
    chmodSync(file, 0o640);
    const first = applyOpenCodeDefaultAgent(dir, "gaspar", "0.1.0-test");
    expect(first).toMatchObject({ file: "opencode.json", changed: true, previous: "build" });
    expect(readFileSync(`${file}.chrono-bak`, "utf8")).toBe(original);
    expect(statSync(`${file}.chrono-bak`).mode & 0o777).toBe(0o640);
    // User edits after the merge do not clobber the original backup.
    writeFileSync(file, `${readFileSync(file, "utf8").trimEnd()}\n`, "utf8");
    const second = applyOpenCodeDefaultAgent(dir, "gaspar", "0.1.0-test");
    expect(second.changed).toBe(false);
    expect(readFileSync(`${file}.chrono-bak`, "utf8")).toBe(original);
    expect(readProjectDefaultAgent(dir)).toBe("gaspar");
    expect(checkOpenCodeDefaultAgent(dir, "gaspar").state).toBe("ok");
  });

  it("restores the prior default and unrelated bytes on uninstall", async () => {
    const { runUninstall } = await import("./init-flow.js");
    const { MemoryKeyStore } = await import("./keychain.js");
    const original = `{\n  "model": "keep-me",\n  "default_agent": "build",\n  "snapshot": false\n}\n`;
    writeFileSync(join(dir, "opencode.json"), original, "utf8");
    const applied = applyOpenCodeDefaultAgent(dir, "gaspar", "0.1.0-test");
    expect(applied.previous).toBe("build");
    // CHRONO role files plus an unrelated user agent.
    mkdirSync(join(dir, ".opencode", "agents"), { recursive: true });
    for (const role of ["gaspar", "build"] as const) {
      writeFileSync(
        join(dir, ".opencode", "agents", `${role}.md`),
        role === "gaspar" ? buildOpenCodeAgentDefinition("gaspar") : "---\ndescription: user agent\nmode: primary\n---\n\nuser\n",
        "utf8"
      );
    }
    const out = runUninstall(dir, { scope: "hooks", json: true }, { interactive: false, store: new MemoryKeyStore() });
    expect(out.exitCode).toBe(0);
    // Prior default returns byte-exactly; unrelated keys survive.
    expect(readFileSync(join(dir, "opencode.json"), "utf8")).toBe(original);
    // Managed role files leave; the user agent stays.
    expect(() => readFileSync(join(dir, ".opencode", "agents", "gaspar.md"), "utf8")).toThrow();
    expect(readFileSync(join(dir, ".opencode", "agents", "build.md"), "utf8")).toContain("user agent");
  });

  it("removes an added key cleanly when the file had none", async () => {
    const { runUninstall } = await import("./init-flow.js");
    const { MemoryKeyStore } = await import("./keychain.js");
    const original = `{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "m"\n}\n`;
    writeFileSync(join(dir, "opencode.json"), original, "utf8");
    applyOpenCodeDefaultAgent(dir, "gaspar", "0.1.0-test");
    expect(readProjectDefaultAgent(dir)).toBe("gaspar");
    const out = runUninstall(dir, { scope: "hooks", json: true }, { interactive: false, store: new MemoryKeyStore() });
    expect(out.exitCode).toBe(0);
    const restored = readFileSync(join(dir, "opencode.json"), "utf8");
    expect(restored).not.toContain("default_agent");
    expect(JSON.parse(restored)).toMatchObject({ model: "m" });
  });

  it("detects drift when the default moves away or the file breaks", () => {
    mkdirSync(dir, { recursive: true });
    expect(checkOpenCodeDefaultAgent(dir, "gaspar").state).toBe("missing");
    applyOpenCodeDefaultAgent(dir, "gaspar", "0.1.0-test");
    expect(checkOpenCodeDefaultAgent(dir, "gaspar").state).toBe("ok");
    const file = join(dir, "opencode.json");
    writeFileSync(file, readFileSync(file, "utf8").replace("gaspar", "build"), "utf8");
    const drifted = checkOpenCodeDefaultAgent(dir, "gaspar");
    expect(drifted.state).toBe("drifted");
    if (drifted.state === "drifted") {
      expect(drifted.reason).toContain("build");
    }
    writeFileSync(file, `{broken`, "utf8");
    expect(checkOpenCodeDefaultAgent(dir, "gaspar").state).toBe("drifted");
  });
});
