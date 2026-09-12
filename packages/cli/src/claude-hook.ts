/**
 * Claude Code pre-tool enforcement hook, generated deterministically
 * (Slice 9 §9.5, [RUNTIME §5]). `chrono setup` writes these exact bytes
 * to `<project>/.chrono/hooks/chrono-claude-gate.js`; the content never
 * embeds machine-specific paths, so identical inputs always produce
 * identical bytes.
 *
 * Native contract: Claude Code `PreToolUse` hooks receive a JSON payload
 * on stdin (`{ tool_name, tool_input, ... }`). Exit 0 allows the tool;
 * exit 2 blocks it with the stderr reason shown to the model. Any other
 * failure (missing context, unreachable gate, non-JSON verdict) also
 * blocks (fail-closed).
 *
 * Slice 9 §9.5: every Claude Code tool capable of filesystem, process,
 * network, package, Git, credential, deployment, destructive, or
 * production-impacting effects is gated through `chrono gate execution`.
 * Read-only tools pass without dispatch scope. Unknown tools — including
 * future built-ins, `mcp_*`, and custom tools — are denied until
 * classified in a reviewed Core policy release (deny-by-default).
 * The Core remains the authority; this hook only shapes the intake.
 */

export const CLAUDE_HOOK_RELATIVE_PATH = ".chrono/hooks/chrono-claude-gate.js";
export const CLAUDE_SETTINGS_RELATIVE_PATH = ".claude/settings.json";

/** Project-relative hook command registered in Claude settings. */
export function claudeHookCommand(): string {
  return "node .chrono/hooks/chrono-claude-gate.js";
}

/**
 * Merge a CHRONO hook entry into a hook group of `.claude/settings.json`
 * without disturbing unrelated user configuration [REF §13 adapter
 * ownership]. `existing` is the current file content or null when
 * absent. Returns the merged document and whether it changed. Throws
 * on malformed or ambiguous content — setup must fail with an
 * explainable remediation path rather than overwrite blindly.
 */
export function mergeClaudeHookGroup(
  existing: string | null,
  group: string,
  entry: { matcher?: string | undefined; hooks: { type: string; command: string; timeout: number }[] }
): { merged: string; changed: boolean } {
  const command = entry.hooks[0]?.command ?? "";
  if (existing === null) {
    return {
      merged: JSON.stringify({ hooks: { [group]: [entry] } }, null, 2),
      changed: true,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    throw new Error("Existing .claude/settings.json is not parseable JSON: refusing to overwrite user configuration");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Existing .claude/settings.json is not a JSON object: refusing to overwrite user configuration");
  }
  const doc = parsed as Record<string, unknown>;
  const hooks = doc["hooks"];
  if (hooks === undefined) {
    return { merged: JSON.stringify({ ...doc, hooks: { [group]: [entry] } }, null, 2), changed: true };
  }
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new Error("Existing .claude/settings.json 'hooks' is not an object: refusing to overwrite user configuration");
  }
  const table = hooks as Record<string, unknown>;
  const current = table[group];
  if (current === undefined) {
    return { merged: JSON.stringify({ ...doc, hooks: { ...table, [group]: [entry] } }, null, 2), changed: true };
  }
  if (!Array.isArray(current)) {
    throw new Error(`Existing .claude/settings.json 'hooks.${group}' is not an array: refusing to overwrite user configuration`);
  }
  // Recursive scan: the managed command may hide inside a group with
  // extra nesting or unknown keys. Finding it anywhere means already
  // installed — appending again would duplicate enforcement.
  const containsCommand = (node: unknown): boolean => {
    if (typeof node !== "object" || node === null) {
      return false;
    }
    if (Array.isArray(node)) {
      return node.some(containsCommand);
    }
    const record = node as Record<string, unknown>;
    if (record["command"] === command) {
      return true;
    }
    return Object.values(record).some(containsCommand);
  };
  if (command.length > 0 && containsCommand(current)) {
    return { merged: existing, changed: false };
  }
  return {
    merged: JSON.stringify({ ...doc, hooks: { ...table, [group]: [...current, entry] } }, null, 2),
    changed: true,
  };
}

/**
 * Merge the CHRONO PreToolUse entry into `.claude/settings.json`
 * (same ownership and failure contract as mergeClaudeHookGroup).
 */
export function mergeClaudeSettings(existing: string | null): { merged: string; changed: boolean } {
  return mergeClaudeHookGroup(existing, "PreToolUse", {
    matcher: "*",
    hooks: [{ type: "command", command: claudeHookCommand(), timeout: 30 }],
  });
}

const CLAUDE_READ_TOOLS = ["Glob", "Grep", "LS", "Read", "TodoWrite"];
const CLAUDE_MUTATE_TOOLS = [
  "Bash",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Task",
  "WebFetch",
  "WebSearch",
  "Write",
];

export function buildClaudeHook(): string {
  return `#!/usr/bin/env node
/**
 * CHRONO pre-tool enforcement for Claude Code. GENERATED by
 * \`chrono setup --adapter <id>\` — do not hand-edit.
 *
 * Input: PreToolUse JSON on stdin ({ tool_name, ... }).
 * Exit 0 allows; exit 2 blocks with the stderr reason.
 *
 * Enforcement contract (explicit environment, never invented identity):
 * - Outside a CHRONO project (no .chrono/chrono.db under cwd): allow (0).
 * - Inside a CHRONO project: read-only tools allow without scope;
 *   mutable tools require CHRONO_GATE_MODULE (+ optional CHRONO_GATE_WP),
 *   CHRONO_GATE_AS, CHRONO_GATE_ROLE, CHRONO_SESSION_TOKEN and a live
 *   \`chrono gate execution\` AUTHORIZED verdict; unknown tools deny.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";

const READ_TOOLS = new Set(${JSON.stringify(CLAUDE_READ_TOOLS)});
const MUTATE_TOOLS = new Set(${JSON.stringify(CLAUDE_MUTATE_TOOLS)});

// Canonical project resolution (same contract as the CLI resolver in
// packages/cli/src/project.ts): canonicalize once; the innermost Git
// root is the maximum upward boundary; outside Git, shared temporary
// directories are never adopted from and never traversed. Cached per
// process (bounded) because this script runs per tool call.
// Stored-identity verification needs SQLite and lives in the CLI/Core;
// this script enforces the boundary rules. Deliberately uncached: a
// project initialized after load must be enforced immediately.
function canonicalDir(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
function tempBoundaryDirs() {
  const out = [];
  const seen = new Set();
  const candidates = [
    process.env["TMPDIR"] ?? null,
    process.env["TMP"] ?? null,
    process.env["TEMP"] ?? null,
    "/tmp",
    "/private/tmp",
    "/var/tmp",
  ];
  for (const candidate of candidates) {
    if (candidate === null || candidate.length === 0) {
      continue;
    }
    try {
      const canonical = realpathSync(candidate);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        out.push(canonical);
      }
    } catch {
      // Absent temp dir: nothing to guard.
    }
  }
  return out;
}
function gitRootOf(canonicalStart) {
  try {
    const raw = execFileSync("git", ["-C", canonicalStart, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return realpathSync(String(raw).trim());
  } catch {
    return null;
  }
}
function findChronoRootUncached(canonicalStart) {
  const gitRoot = gitRootOf(canonicalStart);
  const withinOrEqual = (dir, boundary) => dir === boundary || dir.startsWith(boundary + sep);
  const tempBoundaries = gitRoot === null ? tempBoundaryDirs() : [];
  let current = canonicalStart;
  for (let depth = 0; depth < 64; depth++) {
    if (gitRoot !== null && !withinOrEqual(current, gitRoot)) {
      return null;
    }
    if (gitRoot === null && current !== canonicalStart && tempBoundaries.includes(current)) {
      return null;
    }
    try {
      if (existsSync(join(current, ".chrono", "chrono.db"))) {
        return current;
      }
    } catch {
      return null;
    }
    if (gitRoot !== null && current === gitRoot) {
      return null;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}
function resolveChronoRoot(startDir) {
  const canonicalStart = canonicalDir(startDir || process.cwd());
  if (canonicalStart === null) {
    return null;
  }
  return findChronoRootUncached(canonicalStart);
}

function readEnv(name) {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}

function deny(reason) {
  process.stderr.write("[chrono] " + reason + "\\n");
  process.exit(2);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    if (process.stdin.isTTY) {
      resolve("");
    }
  });
}

async function main() {
  const root = resolveChronoRoot(process.cwd());
  if (root === null) {
    process.exit(0);
  }
  const raw = await readStdin();
  let tool = "";
  try {
    const parsed = raw.trim().length > 0 ? JSON.parse(raw) : {};
    tool = typeof parsed.tool_name === "string" ? parsed.tool_name : "";
  } catch {
    deny("TOOL_DENIED: PreToolUse payload is not parseable JSON.");
  }
  if (READ_TOOLS.has(tool)) {
    process.exit(0);
  }
  if (!MUTATE_TOOLS.has(tool)) {
    deny("TOOL_DENIED: tool '" + tool + "' is not classified by CHRONO tool policy v1: deny-by-default until reviewed.");
  }
  const module = readEnv("CHRONO_GATE_MODULE");
  if (module === null) {
    deny("CHRONO project without dispatch context: export CHRONO_GATE_MODULE (and CHRONO_GATE_WP when scoped) or dispatch via 'chrono run'.");
  }
  const token = readEnv("CHRONO_SESSION_TOKEN");
  if (token === null) {
    deny("Dispatch context without a session: export CHRONO_SESSION_TOKEN from an authorized session.");
  }
  const as = readEnv("CHRONO_GATE_AS");
  const role = readEnv("CHRONO_GATE_ROLE");
  if (as === null || role === null) {
    deny("Export CHRONO_GATE_AS and CHRONO_GATE_ROLE for the dispatch.");
  }
  const chronoBin = readEnv("CHRONO_BIN") ?? "chrono";
  const args = [
    "gate", "execution", "--module", module,
    "--as", as, "--role", role,
    "--session-token", token,
    "--requester-token", readEnv("CHRONO_REQUESTER_TOKEN") ?? token,
    "--path", root, "--json",
  ];
  const wp = readEnv("CHRONO_GATE_WP");
  if (wp !== null) {
    args.push("--wp", wp);
  }
  let out;
  try {
    out = execFileSync(chronoBin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const stdout = e && e.stdout ? String(e.stdout) : "";
    if (stdout.trim().length > 0) {
      out = stdout;
    } else {
      deny("gate unreachable: " + (e instanceof Error ? e.message : String(e)));
    }
  }
  let verdict;
  try {
    verdict = JSON.parse(out);
  } catch {
    deny("gate returned non-JSON output.");
  }
  if (verdict && verdict.result === "AUTHORIZED") {
    process.exit(0);
  }
  const code = verdict && typeof verdict.code === "string" ? verdict.code : "DENIED";
  const reason = verdict && typeof verdict.reason === "string" ? verdict.reason : "denied";
  deny(code + ": " + reason);
}

await main();
`;
}
