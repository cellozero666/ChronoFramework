/**
 * Kiro version and capability gating [FIXES-SL-10.1 C4].
 *
 * Vendor-grounded facts (https://kiro.dev/docs/hooks/,
 * https://kiro.dev/docs/hooks/types/, https://kiro.dev/docs/hooks/actions/,
 * https://kiro.dev/docs/skills/, all fetched 2026-09-11):
 *
 * - Hook files live at `.kiro/hooks/*.json`, schema `v1`, and activate
 *   automatically at session start. This file format was introduced in
 *   IDE 1.0 and CLI 3.0 — older surfaces cannot load it.
 * - `SessionStart` fires on the IDE surface only; `AgentSpawn` fires on
 *   the CLI surface only. `PreToolUse` fires on both and can block.
 * - Shell command actions: exit 0 adds stdout to agent context; any
 *   other exit sends stderr to the agent (and blocks PreToolUse).
 * - Workspace skills (`.kiro/skills/<name>/SKILL.md`, Agent Skills
 *   standard) load on IDE, CLI, and Web.
 *
 * What this means for readiness:
 *
 * 1. The Kiro CLI major version MUST be >= 3 (JSON hook format floor).
 *    Unparseable versions fail closed.
 * 2. Even a supported version is NOT sufficient: automatic Gaspar entry
 *    (stdout injection before the first response), exit-code blocking,
 *    and skill activation on a real Kiro surface are UNVERIFIED without
 *    genuine Kiro execution. `VERIFIED_KIRO_VERSIONS` records exactly
 *    the versions real-runtime acceptance has evidenced; it is empty
 *    until then, so Kiro readiness stays an environment blocker.
 * 3. The Kiro IDE version cannot be detected from the CLI — IDE entry
 *    stays acceptance-gated regardless of the CLI version.
 *
 * Hermetic checks in this module validate OUR artifacts (registration
 * structure, gate-script behavior, entry-script fail-loud shape);
 * `evaluateKiroSupport` combines them with the version gates. Only a
 * real Kiro execution can close C4.
 */

export const KIRO_CLI_MIN_MAJOR = 3;

/**
 * Kiro versions evidenced by genuine real-runtime acceptance
 * (entry before first response, blocking enforced, skill active).
 * Empty until acceptance records entries — never pre-filled, never
 * guessed. Format: exact `major.minor.patch` as reported by
 * `kiro --version` during the acceptance run, with the evidence
 * reference recorded in FIXES-SL-10.1.
 */
export const VERIFIED_KIRO_VERSIONS: readonly string[] = [];

export interface ParsedKiroVersion {
  readonly raw: string;
  readonly version: string | null;
  readonly major: number | null;
}

/** Best-effort parse of `kiro --version` output (fail-closed on garbage). */
export function parseKiroVersion(stdout: string): ParsedKiroVersion {
  const raw = stdout.trim().split("\n")[0] ?? "";
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (match === null) {
    return { raw, version: null, major: null };
  }
  return { raw, version: `${match[1]}.${match[2]}.${match[3]}`, major: Number(match[1]) };
}

export function isKiroVersionVerified(version: string, verified: readonly string[] = VERIFIED_KIRO_VERSIONS): boolean {
  return verified.includes(version);
}

export interface KiroSupportInput {
  /** Rationale: null when the binary is absent. */
  readonly binary: string | null;
  /** First line of `binary --version` output, or null when unprobed. */
  readonly versionOutput: string | null;
}

export interface KiroSupport {
  readonly supported: boolean;
  readonly version: string | null;
  readonly reasons: string[];
}

/**
 * Pure version/capability decision (testable without a runtime).
 * `supported` is true only when the binary is present, the version
 * parses, the CLI major meets the JSON-hooks floor, AND the exact
 * version carries real-runtime acceptance evidence.
 */
export function evaluateKiroSupport(
  input: KiroSupportInput,
  verified: readonly string[] = VERIFIED_KIRO_VERSIONS
): KiroSupport {
  if (input.binary === null) {
    return { supported: false, version: null, reasons: ["Kiro binary absent: install Kiro CLI, then re-run chrono init"] };
  }
  if (input.versionOutput === null) {
    return {
      supported: false,
      version: null,
      reasons: ["Kiro version unreadable: `kiro --version` produced no output"],
    };
  }
  const parsed = parseKiroVersion(input.versionOutput);
  if (parsed.version === null || parsed.major === null) {
    return {
      supported: false,
      version: null,
      reasons: [`Kiro version unparseable ('${parsed.raw}'): refusing to guess capability; report the exact output`],
    };
  }
  if (parsed.major < KIRO_CLI_MIN_MAJOR) {
    return {
      supported: false,
      version: parsed.version,
      reasons: [
        `Unsupported Kiro CLI ${parsed.version}: JSON hook files (.kiro/hooks/*.json) require CLI 3.0+ (kiro.dev/docs/hooks)`,
      ],
    };
  }
  if (!isKiroVersionVerified(parsed.version, verified)) {
    return {
      supported: false,
      version: parsed.version,
      reasons: [
        `Kiro ${parsed.version} has no verified capability record: automatic Gaspar entry is unproven on a real Kiro surface (FIXES-SL-10.1 C4). Deselect kiro (chrono init --runtime <verified>) or await real-runtime acceptance; entry and dispatch stay denied.`,
      ],
    };
  }
  return { supported: true, version: parsed.version, reasons: [] };
}
