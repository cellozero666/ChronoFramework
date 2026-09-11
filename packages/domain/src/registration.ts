/**
 * Artifact registration rules: entry states and required fields.
 * [DOM §3.9/3.13/3.14, STATE §2, Remediation §2]
 *
 * Creation (ArtifactCreated) may only enter the lifecycle entry state.
 * Every other state is reachable exclusively through its explicit
 * transition event — creating an artifact directly in a gated state
 * would bypass the gate that guards that transition.
 * No runtime-specific concepts [FW §22].
 */

import { ChronoError, ErrorCode, Severity } from "./errors.js";

/** Blocker types from the domain model [DOM §3.17]. */
export const BLOCKER_TYPES = [
  "PRODUCT_BLOCKER",
  "SECURITY_BLOCKER",
  "APPROVAL_REQUIRED",
  "EXECUTION_DENIED",
  "COMPLETION_DENIED",
  "BLOCKED_RTK",
  "BLOCKED_PROCESS_SKILL",
] as const;

export type BlockerType = (typeof BLOCKER_TYPES)[number];

/** Reject unknown blocker types [DOM §3.17, INV §14.4]. */
export function assertBlockerType(type: string): void {
  if (!(BLOCKER_TYPES as readonly string[]).includes(type)) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: `Unknown blocker type '${type}'`,
      invariantRef: "INV §14.4",
      affectedTarget: type,
      suggestedAction: `Use one of: ${BLOCKER_TYPES.join(", ")}`,
    });
  }
}

/** Defect classification → responsible owner routing [DOM §3.18, FW §8]. */
export const DEFECT_ROUTING = {
  IMPLEMENTATION_DEFECT: "belthazar",
  UX_DEFECT: "melchior",
  INFRASTRUCTURE_DEFECT: "prometheus",
  TEST_DEFECT: "lucca",
  SECURITY_DEFECT: "glenn",
  ARCHITECTURE_DEFECT: "gaspar",
  SPECIFICATION_DEFECT: "gaspar",
  PRODUCT_AMBIGUITY: "PO",
} as const;

export type DefectClassification = keyof typeof DEFECT_ROUTING;

/** Lifecycle entry state per artifact family [STATE §2]. */
export const ENTRY_STATES = {
  SP: "DRAFT",
  MOD: "DRAFT",
  WP: "PLANNED",
} as const;

export type RegistrableFamily = keyof typeof ENTRY_STATES;

/** Required content fields per artifact family [DOM §3.9, §3.13, §3.14]. */
export const REQUIRED_ARTIFACT_FIELDS: Record<RegistrableFamily, readonly string[]> = {
  SP: ["id", "title", "purpose"],
  MOD: ["id", "name", "purpose", "specs"],
  WP: ["id", "name", "module"],
};

/**
 * Reject creation in any non-entry state [Remediation §2].
 * SP as READY, MOD as APPROVED/COMPLETE, WP as AUTHORIZED (or any other
 * non-entry state) would bypass the gate guarding that transition.
 */
export function assertValidInitialState(family: RegistrableFamily, status: string): void {
  if (status !== ENTRY_STATES[family]) {
    throw new ChronoError({
      code: ErrorCode.INVALID_STATE,
      severity: Severity.ERROR,
      message: `Illegal initial state '${status}' for ${family}: artifacts are created as ${ENTRY_STATES[family]} and advance only through legal transitions`,
      invariantRef: "INV §3.1",
      affectedTarget: `${family}:${status}`,
      suggestedAction: `Register as ${ENTRY_STATES[family]}, then request the explicit transition event`,
    });
  }
}

/**
 * Reject content that is not a field-bearing object or that misses
 * required fields [P7.2, INV §14.4].
 */
export function assertRequiredFields(
  family: RegistrableFamily,
  content: unknown
): asserts content is Record<string, unknown> {
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: `Invalid ${family} content: must be an object carrying ${REQUIRED_ARTIFACT_FIELDS[family].join(", ")}`,
      invariantRef: "INV §14.4",
      affectedTarget: family,
      suggestedAction: "Provide the artifact content as a structured object",
    });
  }
  const record = content as Record<string, unknown>;
  const missing = REQUIRED_ARTIFACT_FIELDS[family].filter((f) => record[f] === undefined);
  if (missing.length > 0) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: `Invalid ${family} content: missing required fields: ${missing.join(", ")}`,
      invariantRef: "INV §14.4",
      affectedTarget: family,
      suggestedAction: `Provide ${missing.join(", ")} before registering`,
    });
  }
}
