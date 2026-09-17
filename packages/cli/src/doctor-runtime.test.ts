/**
 * Stale-loaded-runtime detection (gate item 3) + build identity
 * (item 4): unit coverage for the generation handshake. Full
 * restart semantics (stale blocks, fresh load clears) run through
 * the packed binary in the plugin black-box; here the pure
 * comparison and the evidence reader are pinned without processes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeFingerprint } from "@chrono/domain";
import {
  expectedPluginGeneration,
  pluginLoadStatus,
  readActivationEvidence,
} from "./init-flow.js";

const FP = buildRuntimeFingerprint();
const EXPECTED = expectedPluginGeneration();

function loadRow(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    ts: "2026-09-16T00:00:00.000Z",
    adapter: "opencode",
    kind: "plugin-load",
    chronoVersion: "0.1.0",
    toolPolicyVersion: "10",
    buildFingerprint: FP,
    loadId: "123-test",
    ...overrides,
  });
}

describe("Plugin generation handshake (stale runtime repair)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-doctor-runtime-"));
    mkdirSync(join(tempDir, ".chrono"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeEvidence(lines: string[]): void {
    writeFileSync(join(tempDir, ".chrono", "runtime-activation.jsonl"), lines.join("\n") + "\n", "utf8");
  }

  it("expects the running launcher identity with a deterministic fingerprint", () => {
    expect(EXPECTED.toolPolicyVersion).toBe("10");
    expect(EXPECTED.buildFingerprint).toBe(FP);
    expect(FP).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("reports unknown when nothing was ever recorded", () => {
    expect(pluginLoadStatus(null).status).toBe("unknown");
    const report = readActivationEvidence(tempDir);
    expect(report.latestPluginLoad).toBe(null);
    expect(report.runtimeStatus).toBe("unknown");
  });

  it("reports unknown for pre-handshake rows that carry no generation claim", () => {
    writeEvidence([
      JSON.stringify({ v: 1, ts: "2026-09-16T00:00:00.000Z", adapter: "opencode", kind: "plugin-load" }),
    ]);
    const report = readActivationEvidence(tempDir);
    expect(report.pluginLoads).toBe(1);
    expect(report.latestPluginLoad).not.toBe(null);
    expect(report.latestPluginLoad?.chronoVersion).toBe(null);
    expect(report.runtimeStatus).toBe("unknown");
  });

  it("reports current on a full handshake match", () => {
    writeEvidence([loadRow()]);
    const report = readActivationEvidence(tempDir);
    expect(report.latestPluginLoad).toMatchObject({ loadId: "123-test", chronoVersion: "0.1.0", toolPolicyVersion: "10", buildFingerprint: FP });
    expect(report.runtimeStatus).toBe("current");
  });

  it("reports stale on any generation disagreement", () => {
    for (const overrides of [
      { toolPolicyVersion: "7" },
      { buildFingerprint: `sha256:${"0".repeat(64)}` },
      { chronoVersion: "0.0.0" },
    ]) {
      const verdict = pluginLoadStatus({
        at: "2026-09-16T00:00:00.000Z",
        loadId: "old-1",
        chronoVersion: "0.1.0",
        toolPolicyVersion: "10",
        buildFingerprint: FP,
        ...overrides,
      });
      expect(verdict.status).toBe("stale");
      expect(verdict.detail).toContain("fully terminate OpenCode");
    }
  });

  it("tracks the latest load across restarts (last row wins)", () => {
    writeEvidence([
      loadRow({ loadId: "first", buildFingerprint: `sha256:${"1".repeat(64)}`, ts: "2026-09-16T00:00:00.000Z" }),
      loadRow({ loadId: "second", ts: "2026-09-16T00:01:00.000Z" }),
    ]);
    const report = readActivationEvidence(tempDir);
    expect(report.pluginLoads).toBe(2);
    expect(report.latestPluginLoad?.loadId).toBe("second");
    expect(report.runtimeStatus).toBe("current");
  });
});
