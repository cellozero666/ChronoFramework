/**
 * Collision-safe artifact identity model matching CORE-SPECIFICATION §3.
 * [DOM §2.1, CORE §3.1, INV §10.1]
 *
 * Identifiers use `<FAMILY>-<seq>` with a zero-padded 4-digit decimal
 * sequence assigned by the Core. Sequences are allocated from a persisted
 * counter, never derived from wall-clock time (collision-prone).
 * `GRANT` covers operational dispatch grants (Core-owned locks, not
 * reviewable artifacts); `RTE` covers routing-proof evidence rows,
 * `SES` covers authenticated adapter sessions, and `BRK` covers broker
 * credentials for automatic Gaspar entry (all Core-owned operational
 * records, same precedent); the protocol family list is
 * non-exhaustive ("such as", P3.7). No runtime-specific concepts [FW §22].
 */

import { ChronoError, ErrorCode, Severity } from "./errors.js";

/** Identity families with Core-assigned sequences [CORE §3.1]. */
export const ARTIFACT_ID_FAMILIES = [
  "REQ",
  "BR",
  "CON",
  "DEC",
  "ADR",
  "SP",
  "AC",
  "MOD",
  "WP",
  "TASK",
  "APR",
  "BLK",
  "DEF",
  "EVD",
  "QA",
  "SEC",
  "WAIVER",
  "CR",
  "OPEN",
  "RTK",
  "SKILL",
  "RTE",
  "SES",
  "BRK",
  "GRANT",
] as const;

export type ArtifactIdFamily = (typeof ARTIFACT_ID_FAMILIES)[number];

const ID_PATTERN = /^(REQ|BR|CON|DEC|ADR|SP|AC|MOD|WP|TASK|APR|BLK|DEF|EVD|QA|SEC|WAIVER|CR|OPEN|RTK|SKILL|RTE|SES|BRK|GRANT)-(\d{4,})$/;

export interface ParsedArtifactId {
  readonly family: ArtifactIdFamily;
  readonly seq: number;
}

/**
 * Parse and validate an artifact identifier [CORE §3.1, INV §10.1].
 * Throws ChronoError VALIDATION_ERROR when malformed.
 */
export function parseArtifactId(id: string): ParsedArtifactId {
  const match = ID_PATTERN.exec(id);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: `Malformed artifact identifier '${id}': expected <FAMILY>-<zero-padded sequence> per CORE §3.1`,
      invariantRef: "INV §10.1",
      affectedTarget: id,
      suggestedAction: "Use a Core-allocated identifier such as SP-0001",
    });
  }
  return { family: match[1] as ArtifactIdFamily, seq: Number(match[2]) };
}

/** Non-throwing identity check [INV §10.1]. */
export function isValidArtifactId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/**
 * Format a Core-allocated identifier [CORE §3.1].
 * Sequences beyond 9999 widen naturally (never truncated).
 */
export function formatArtifactId(family: ArtifactIdFamily, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: `Invalid sequence ${String(seq)} for family ${family}: must be a positive integer`,
      invariantRef: "INV §10.1",
      affectedTarget: family,
      suggestedAction: "Allocate sequences through the persisted Core counter",
    });
  }
  return `${family}-${String(seq).padStart(4, "0")}`;
}
