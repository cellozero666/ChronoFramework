/**
 * Error codes matching the taxonomy in docs/domain/CORE-INVARIANTS.md §14
 * No provider/model/version concepts here — runtime independence [FW §22]
 */
export const CHRONO_ERROR_CODES = [
  // Authorization failures [INV §14.1]
  "EXECUTION_DENIED",
  "COMPLETION_DENIED",
  "APPROVAL_REQUIRED",
  "SECURITY_BLOCKER",
  "BLOCKED_RTK",
  "BLOCKED_PROCESS_SKILL",
  "PRODUCT_BLOCKER",
  // State violations [INV §14.2]
  "INVALID_STATE",
  "ILLEGAL_TRANSITION",
  "STALE_REVISION",
  "HIDDEN_CHILD_STATE",
  // Reference integrity [INV §14.3]
  "ENTITY_NOT_FOUND",
  "DUPLICATE_IDENTITY",
  "REFERENCE_UNRESOLVABLE",
  "DAG_CYCLE",
  "ORPHAN_DETECTED",
  // Validation [INV §14.4]
  "VALIDATION_ERROR",
  "MISSING_REQUIRED_ARTIFACT",
  "INCONSISTENT_REFERENCE",
  // Security [INV §14.5]
  "SECURITY_EVIDENCE_MISSING",
  "SECURITY_APPROVAL_STALE",
  "SECRET_DETECTED",
  // RTK/skill [INV §14.6]
  "RTK_ROUTING_FAILURE",
  "RTK_NAME_COLLISION",
  "SKILL_PROVENANCE_FAILURE",
  "SKILL_ACTIVATION_FAILURE",
  // Evidence/audit [INV §14.7]
  "EVIDENCE_STALE",
  "EVIDENCE_MISSING",
  "SIGNATURE_INVALID",
] as const;

export type ChronoErrorCode = (typeof CHRONO_ERROR_CODES)[number];

export type Severity = "ERROR" | "WARNING" | "BLOCKER";

export interface ChronoErrorOptions {
  readonly code: ChronoErrorCode;
  readonly message: string;
  readonly severity: Severity;
  readonly invariantRef?: string | undefined;
  readonly affectedTarget?: string | undefined;
  readonly suggestedAction?: string | undefined;
}

export class ChronoError extends Error {
  readonly code: ChronoErrorCode;
  readonly severity: Severity;
  readonly invariantRef: string | undefined;
  readonly affectedTarget: string | undefined;
  readonly suggestedAction: string | undefined;

  constructor(options: ChronoErrorOptions) {
    super(options.message);
    this.name = "ChronoError";
    this.code = options.code;
    this.severity = options.severity;
    this.invariantRef = options.invariantRef ?? undefined;
    this.affectedTarget = options.affectedTarget ?? undefined;
    this.suggestedAction = options.suggestedAction ?? undefined;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      severity: this.severity,
      message: this.message,
      invariantRef: this.invariantRef,
      affectedTarget: this.affectedTarget,
      suggestedAction: this.suggestedAction,
    };
  }
}

export const ErrorCode = {
  EXECUTION_DENIED: "EXECUTION_DENIED" as const,
  COMPLETION_DENIED: "COMPLETION_DENIED" as const,
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED" as const,
  SECURITY_BLOCKER: "SECURITY_BLOCKER" as const,
  BLOCKED_RTK: "BLOCKED_RTK" as  const,
  BLOCKED_PROCESS_SKILL: "BLOCKED_PROCESS_SKILL" as const,
  PRODUCT_BLOCKER: "PRODUCT_BLOCKER" as const,
  INVALID_STATE: "INVALID_STATE" as const,
  ILLEGAL_TRANSITION: "ILLEGAL_TRANSITION" as const,
  STALE_REVISION: "STALE_REVISION" as const,
  HIDDEN_CHILD_STATE: "HIDDEN_CHILD_STATE" as const,
  ENTITY_NOT_FOUND: "ENTITY_NOT_FOUND" as const,
  DUPLICATE_IDENTITY: "DUPLICATE_IDENTITY" as const,
  REFERENCE_UNRESOLVABLE: "REFERENCE_UNRESOLVABLE" as const,
  DAG_CYCLE: "DAG_CYCLE" as const,
  ORPHAN_DETECTED: "ORPHAN_DETECTED" as const,
  VALIDATION_ERROR: "VALIDATION_ERROR" as const,
  MISSING_REQUIRED_ARTIFACT: "MISSING_REQUIRED_ARTIFACT" as const,
  INCONSISTENT_REFERENCE: "INCONSISTENT_REFERENCE" as const,
  SECURITY_EVIDENCE_MISSING: "SECURITY_EVIDENCE_MISSING" as const,
  SECURITY_APPROVAL_STALE: "SECURITY_APPROVAL_STALE" as const,
  SECRET_DETECTED: "SECRET_DETECTED" as const,
  RTK_ROUTING_FAILURE: "RTK_ROUTING_FAILURE" as const,
  RTK_NAME_COLLISION: "RTK_NAME_COLLISION" as const,
  SKILL_PROVENANCE_FAILURE: "SKILL_PROVENANCE_FAILURE" as const,
  SKILL_ACTIVATION_FAILURE: "SKILL_ACTIVATION_FAILURE" as const,
  EVIDENCE_STALE: "EVIDENCE_STALE" as const,
  EVIDENCE_MISSING: "EVIDENCE_MISSING" as const,
  SIGNATURE_INVALID: "SIGNATURE_INVALID" as const,
} as const satisfies Record<string, ChronoErrorCode>;

export const Severity = {
  ERROR: "ERROR" as const,
  WARNING: "WARNING" as const,
  BLOCKER: "BLOCKER" as const,
} as const;
