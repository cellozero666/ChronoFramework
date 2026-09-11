/**
 * CHRONO release metadata: PO-approved pins for external trust sources.
 * [FW §22, FW §1222, P8.6, PL Phase 4]
 *
 * The Karpathy Guidelines skill pin below was approved by the Product Owner
 * (Slice 7): immutable upstream commit, byte-exact source hash of the
 * canonical `skills/karpathy-guidelines/SKILL.md`, and the deterministic
 * converter version. The Core enforces these values at attestation time;
 * nothing here selects a provider, model, or runtime.
 */

import { createHash } from "node:crypto";
import { ChronoError, ErrorCode, Severity } from "./errors.js";
import { canonicalize } from "./revision.js";
import { SKILL_UPSTREAM } from "./authority.js";

/** PO-approved Karpathy Guidelines release pin (Slice 7). */
export const SKILL_RELEASE = {
  upstream: SKILL_UPSTREAM,
  pinnedCommit: "2c606141936f1eeef17fa3043a72095b4765b9c2",
  sourcePath: "skills/karpathy-guidelines/SKILL.md",
  sourceHash: "sha256:6e22cc54cb02a5e98ae42d06d9d7292db0c1b43894831b32879beb0166b2aea7",
  license: "MIT",
  converterVersion: "chrono-skill-converter/1",
} as const;

/** Runtime skill artifact paths derived from one project root [PL Phase 4]. */
export const SKILL_RUNTIME_PATHS = {
  claude: ".claude/skills/karpathy-guidelines/SKILL.md",
  opencode: ".opencode/skills/karpathy-guidelines/SKILL.md",
  kiro: ".kiro/skills/karpathy-guidelines/SKILL.md",
} as const;

export type SkillRuntime = keyof typeof SKILL_RUNTIME_PATHS;

/** Vendor path for the pinned canonical source [PL Phase 4]. */
export function skillVendorPath(pinnedCommit: string): string {
  return `vendor/karpathy-guidelines/${pinnedCommit}/SKILL.md`;
}

/** SHA-256 over raw source bytes, in revision-hash form [INV §11.1]. */
export function hashSkillSource(bytes: Uint8Array | string): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${digest}`;
}

export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly license: string;
}

/**
 * Strict Agent Skills frontmatter parser [PL Phase 4, P6.6]. The source
 * must open with a `---` block carrying non-empty name, description, and
 * license fields. Anything else is rejected, never normalized.
 */
export function parseSkillFrontmatter(source: string): SkillFrontmatter {
  const lines = source.split("\n");
  if (lines[0] !== "---") {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: "Skill source lacks an Agent Skills frontmatter block: expected '---' on the first line",
      invariantRef: "INV §14.4",
      suggestedAction: "Fetch the canonical SKILL.md source unmodified",
    });
  }
  const fields: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line === "---") {
      break;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: `Malformed frontmatter line ${String(i + 1)}: expected 'key: value'`,
        invariantRef: "INV §14.4",
        suggestedAction: "Fetch the canonical SKILL.md source unmodified",
      });
    }
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  if (i >= lines.length) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: "Skill source frontmatter block is never closed with '---'",
      invariantRef: "INV §14.4",
      suggestedAction: "Fetch the canonical SKILL.md source unmodified",
    });
  }
  const name = fields["name"] ?? "";
  const description = fields["description"] ?? "";
  const license = fields["license"] ?? "";
  if (name.length === 0 || description.length === 0 || license.length === 0) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: "Skill frontmatter requires non-empty name, description, and license",
      invariantRef: "INV §14.4",
      suggestedAction: "Fetch the canonical SKILL.md source unmodified",
    });
  }
  return { name, description, license };
}

/**
 * Deterministic converter [PL Phase 4, P6.6, REF §13]: runtime artifacts
 * are emitted byte-identical to the canonical source — no LLM rewriting,
 * no per-runtime divergence. Any future runtime-specific wrapper must be
 * versioned through a new converter version and re-pinned.
 */
export function convertSkillSource(canonicalSource: string): Record<SkillRuntime, string> {
  return {
    claude: canonicalSource,
    opencode: canonicalSource,
    kiro: canonicalSource,
  };
}

/** Canonical per-runtime artifact hashes for the attestation [DOM §3.28]. */
export function skillGeneratedHashes(artifacts: Record<SkillRuntime, string>): string {
  return canonicalize({
    claude: hashSkillSource(artifacts.claude),
    kiro: hashSkillSource(artifacts.kiro),
    opencode: hashSkillSource(artifacts.opencode),
  });
}

/**
 * Verify fetched bytes against the PO-approved release pin: exact source
 * hash, MIT license in frontmatter, and the expected skill name. Returns
 * the canonical source text for the converter.
 */
export function verifySkillRelease(bytes: Uint8Array | string): string {
  const text = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
  const actual = hashSkillSource(text);
  if (actual !== SKILL_RELEASE.sourceHash) {
    throw new ChronoError({
      code: ErrorCode.SKILL_PROVENANCE_FAILURE,
      severity: Severity.BLOCKER,
      message: `Skill source hash mismatch: fetched ${actual}, pinned ${SKILL_RELEASE.sourceHash}`,
      invariantRef: "INV §9.2",
      suggestedAction: "Fetch the pinned commit unmodified; do not use floating branches",
    });
  }
  const frontmatter = parseSkillFrontmatter(text);
  if (frontmatter.name !== "karpathy-guidelines") {
    throw new ChronoError({
      code: ErrorCode.SKILL_PROVENANCE_FAILURE,
      severity: Severity.BLOCKER,
      message: `Skill name '${frontmatter.name}' is not the pinned 'karpathy-guidelines'`,
      invariantRef: "INV §9.2",
      suggestedAction: "Fetch the canonical SKILL.md source unmodified",
    });
  }
  if (frontmatter.license !== SKILL_RELEASE.license) {
    throw new ChronoError({
      code: ErrorCode.SKILL_PROVENANCE_FAILURE,
      severity: Severity.BLOCKER,
      message: "Skill license/attribution is not preserved as MIT",
      invariantRef: "INV §9.5",
      suggestedAction: "Preserve the upstream MIT license and attribution",
    });
  }
  return text;
}
