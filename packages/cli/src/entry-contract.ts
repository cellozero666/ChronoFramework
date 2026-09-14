/**
 * Single source of truth for the Gaspar-entry command invocation
 * (OC-P7). The generated entry-session script (producer,
 * `gaspar-entry.ts`) and the Commander `entry` command (consumer,
 * `index.ts`) both derive from this spec, so they cannot drift
 * independently the way `--secret-stdin` did: the script once passed
 * an option the CLI never registered, and every first OpenCode
 * prompt died with `ENTRY_BLOCKED[ENTRY_DENIED]`.
 *
 * Rules:
 * - The broker secret ALWAYS travels on stdin (piped). No flag may
 *   ever carry it: not in argv, environment, output, or logs.
 * - No compatibility flag may be added here merely to hide generator
 *   drift. A flag exists only as a deliberate, documented public API
 *   decision recorded in this spec.
 * - Rendered shell values arrive pre-quoted by the caller (e.g.
 *   `"$ADAPTER"`); the renderer concatenates without requoting.
 */

/** Option keys of the `entry` command, in canonical invocation order. */
export type EntryOptionKey = "adapter" | "broker" | "runtime" | "tokenOut" | "path" | "json";

export interface EntryOptionSpec {
  readonly key: EntryOptionKey;
  /** Long flag as registered on the Commander command. */
  readonly flag: string;
  /** Value placeholder for help/usage, or null for boolean flags. */
  readonly valuePlaceholder: string | null;
  readonly required: boolean;
  readonly description: string;
}

export const ENTRY_COMMAND_NAME = "entry";

/**
 * The complete `entry` interface. `adapter`, `broker`, and
 * `token-out` are mandatory (the script always passes them); `runtime`
 * defaults server-side; `path` and `json` are invocation context.
 */
export const ENTRY_OPTIONS: readonly EntryOptionSpec[] = [
  { key: "adapter", flag: "--adapter", valuePlaceholder: "<id>", required: true, description: "runtime adapter id" },
  {
    key: "broker",
    flag: "--broker",
    valuePlaceholder: "<id>",
    required: true,
    description: "broker credential id (recorded in .chrono/broker-account)",
  },
  {
    key: "runtime",
    flag: "--runtime",
    valuePlaceholder: "<name>",
    required: false,
    description: "adapter runtime (default: project runtime, else adapter id)",
  },
  {
    key: "tokenOut",
    flag: "--token-out",
    valuePlaceholder: "<path>",
    required: true,
    description: "0600 file receiving the session token",
  },
  {
    key: "path",
    flag: "--path",
    valuePlaceholder: "<dir>",
    required: false,
    description: "project directory (default: current directory)",
  },
  { key: "json", flag: "--json", valuePlaceholder: null, required: false, description: "machine-readable JSON output" },
];

/** Commander option string for one spec entry (`--flag <placeholder>` or bare `--flag`). */
export function entryCommanderOption(spec: EntryOptionSpec): string {
  return spec.valuePlaceholder === null ? spec.flag : `${spec.flag} ${spec.valuePlaceholder}`;
}

/** Every registered long flag, in canonical order. */
export function entryOptionFlags(): string[] {
  return ENTRY_OPTIONS.map((spec) => spec.flag);
}

/** Flags the generated script must always pass. */
export function requiredEntryFlags(): string[] {
  return ENTRY_OPTIONS.filter((spec) => spec.required).map((spec) => spec.flag);
}

export type EntryInvocationValues = Record<EntryOptionKey, string | null>;

/**
 * Render `$CHRONO_BIN entry …` argv from the spec. A null value omits
 * an optional flag (booleans render bare when non-null); omitting a
 * required flag throws. Values are used verbatim — shell callers pass
 * pre-quoted `$VARS`, programmatic callers pass literals.
 */
export function renderEntryInvocation(binary: string, values: EntryInvocationValues): string {
  const parts = [binary, ENTRY_COMMAND_NAME];
  for (const spec of ENTRY_OPTIONS) {
    const value = values[spec.key];
    if (value === null) {
      if (spec.required) {
        throw new Error(`entry invocation requires ${spec.flag}`);
      }
      continue;
    }
    parts.push(spec.valuePlaceholder === null ? spec.flag : `${spec.flag} ${value}`);
  }
  return parts.join(" ");
}

/** Shell-variable values for the generated entry-session script. */
export function entryShellValues(): EntryInvocationValues {
  return {
    adapter: '"$ADAPTER"',
    broker: '"$BROKER"',
    runtime: null,
    tokenOut: '"$TOKEN_FILE"',
    path: '"$ROOT"',
    json: "",
  };
}
