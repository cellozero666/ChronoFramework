/**
 * OC-P7 producer/consumer contract tests. The generated
 * entry-session script once passed `--secret-stdin`, an option the
 * `entry` command never registered, and every first OpenCode prompt
 * died with ENTRY_BLOCKED. These tests pin the shared contract
 * (entry-contract.ts) against both sides: the generated shell and
 * the real Commander interface built by createProgram. Hermetic and
 * always-run; the packed black-box test proves the same contract
 * across real process boundaries.
 */
import { describe, it, expect } from "vitest";
import { buildEntrySessionScript } from "./gaspar-entry.js";
import {
  ENTRY_COMMAND_NAME,
  ENTRY_OPTIONS,
  entryCommanderOption,
  entryOptionFlags,
  entryShellValues,
  renderEntryInvocation,
  requiredEntryFlags,
} from "./entry-contract.js";
import { createProgram } from "./index.js";

function entryCommand(): { options: readonly { long?: string | undefined }[] } {
  const program = createProgram("/tmp/chrono-contract-probe");
  const found = program.commands.find((command) => command.name() === ENTRY_COMMAND_NAME);
  if (found === undefined) {
    throw new Error("entry command not registered");
  }
  return found;
}

/** Long flags on the generated `"$CHRONO_BIN" entry …` line. */
function scriptEntryFlags(script: string): string[] {
  const line = script.split("\n").find((candidate) => candidate.includes('entry --adapter'));
  if (line === undefined) {
    throw new Error("generated script has no entry invocation line");
  }
  return [...line.matchAll(/(--[a-z-]+)/g)].map((match) => match[1] as string);
}

describe("Entry invocation contract (OC-P7)", () => {
  it("generates the script invocation from the shared renderer", () => {
    const script = buildEntrySessionScript();
    expect(script).toContain(renderEntryInvocation('"$CHRONO_BIN"', entryShellValues()));
  });

  it("registers every contract flag on the real Commander command", () => {
    const registered = new Set(entryCommand().options.map((option) => option.long));
    for (const flag of entryOptionFlags()) {
      expect(registered.has(flag)).toBe(true);
    }
  });

  it("passes every required flag in the generated script, and nothing unregistered", () => {
    const script = buildEntrySessionScript();
    const used = scriptEntryFlags(script);
    const registered = new Set(entryCommand().options.map((option) => option.long));
    for (const flag of requiredEntryFlags()) {
      expect(used).toContain(flag);
    }
    for (const flag of used) {
      expect(registered.has(flag)).toBe(true);
    }
  });

  it("never defines or emits a secret-carrying or compat flag", () => {
    const script = buildEntrySessionScript();
    // Bare --secret / --token flags are banned; --token-out (a file
    // path, never the token) and --session-token (a caller credential
    // flag on other commands) are legitimate and must not trip this.
    const banned = /--secret-stdin|--secret(\s|$)|--token(\s|$)/;
    expect(banned.test(script)).toBe(false);
    // The secret travels on stdin: the invocation pipes it, and no
    // spec entry carries secret material.
    expect(script).toContain('printf \'%s\' "$SECRET" |');
    for (const spec of ENTRY_OPTIONS) {
      expect(/secret|token(?!-out)/i.test(spec.flag)).toBe(false);
    }
    expect(entryCommanderOption(ENTRY_OPTIONS[0]!)).toBe("--adapter <id>");
  });

  it("renders required flags positionally and omits unset optionals", () => {
    expect(
      renderEntryInvocation("chrono", {
        adapter: "opencode",
        broker: "BRK-0001",
        runtime: null,
        tokenOut: "/tmp/t.token",
        path: "/tmp/p",
        json: "",
      })
    ).toBe("chrono entry --adapter opencode --broker BRK-0001 --token-out /tmp/t.token --path /tmp/p --json");
    expect(() =>
      renderEntryInvocation("chrono", {
        adapter: "",
        broker: null,
        runtime: null,
        tokenOut: "/tmp/t.token",
        path: null,
        json: null,
      })
    ).toThrow("--broker");
  });

  it("fails loudly on an extra option through real Commander parsing", async () => {
    const program = createProgram("/tmp/chrono-contract-probe");
    program.exitOverride();
    // Commander writes parse errors to process.stderr, not console.
    const errors: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]): boolean => {
      errors.push(String(args[0] ?? ""));
      return true;
    };
    let failure: unknown = null;
    try {
      // All required options present so the obsolete flag is the only
      // fault: the parser must name it, not pass it to the action.
      await program.parseAsync(
        ["entry", "--adapter", "opencode", "--broker", "BRK-0001", "--token-out", "/tmp/t.token", "--secret-stdin"],
        { from: "user" }
      );
    } catch (e) {
      failure = e;
    } finally {
      (process.stderr as { write: (...args: unknown[]) => boolean }).write = originalWrite as (...args: unknown[]) => boolean;
    }
    // The exact pilot failure (obsolete flag) must die in the parser
    // with Commander's unknown-option error, never reach the action.
    expect(failure).not.toBeNull();
    expect((failure as { exitCode?: number }).exitCode).not.toBe(0);
    expect(errors.join("\n")).toContain("unknown option '--secret-stdin'");
  });

  it("fails loudly on missing required options through real Commander parsing", async () => {
    const program = createProgram("/tmp/chrono-contract-probe");
    program.exitOverride();
    const errors: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]): boolean => {
      errors.push(String(args[0] ?? ""));
      return true;
    };
    let failure: unknown = null;
    try {
      await program.parseAsync(["entry", "--adapter", "opencode"], { from: "user" });
    } catch (e) {
      failure = e;
    } finally {
      (process.stderr as { write: (...args: unknown[]) => boolean }).write = originalWrite as (...args: unknown[]) => boolean;
    }
    expect(failure).not.toBeNull();
    expect((failure as { exitCode?: number }).exitCode).not.toBe(0);
    expect(errors.join("\n")).toContain("required option");
  });
});
