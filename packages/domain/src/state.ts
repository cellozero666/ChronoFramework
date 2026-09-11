/**
 * State sets and entity types matching docs/domain/STATE-MODEL.md §1 and §3.18-3.28
 * [FW §594-598, P3.9] — No runtime-specific concepts [FW §22]
 */

export type ProjectState =
  | "UNINITIALIZED"
  | "ANALYZING"
  | "ARCHITECTING"
  | "SPECIFYING"
  | "PLANNING"
  | "EXECUTING"
  | "VERIFYING"
  | "COMPLETE"
  | "BLOCKED";

export type SpecificationState = "DRAFT" | "REVIEW" | "READY" | "SUPERSEDED";

export type ModuleState =
  | "DRAFT"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "EXECUTING"
  | "VERIFYING"
  | "PASSED"
  | "FAILED"
  | "COMPLETE"
  | "BLOCKED";

export type WorkPackageState =
  | "PLANNED"
  | "AUTHORIZED"
  | "RUNNING"
  | "BLOCKED"
  | "IMPLEMENTED"
  | "VERIFYING"
  | "FAILED"
  | "COMPLETE";

export type VerificationState = "PENDING" | "RUNNING" | "FAILED" | "PASSED" | "WAIVED";

// Auxiliary state sets [STATE §1.1]
export type AdrState = "proposed" | "accepted" | "rejected" | "superseded" | "deprecated";
export type ArchitectureState = "proposed" | "under_review" | "approved" | "superseded";
export type DecisionState = "proposed" | "approved" | "rejected";
export type BlockerState = "active" | "resolved";
export type DefectState = "open" | "in_progress" | "resolved" | "reopened";
export type WaiverState = "active" | "expired" | "invalidated";
export type ChangeRequestState = "proposed" | "approved" | "rejected" | "implemented";
export type AttestationState = "current" | "stale" | "invalid";

export type EntityType =
  | "PROJECT"
  | "REQ"
  | "BR"
  | "CON"
  | "DEC"
  | "ADR"
  | "SP"
  | "AC"
  | "MOD"
  | "WP"
  | "TASK"
  | "APR"
  | "BLK"
  | "DEF"
  | "EVD"
  | "QA"
  | "SEC"
  | "WAIVER"
  | "CR"
  | "OPEN"
  | "RTK"
  | "SKILL"
  | "VERIFICATION";

export type AgentRole =
  | "gaspar"
  | "belthazar"
  | "melchior"
  | "prometheus"
  | "luca"
  | "glenn"
  | "spekkio"
  | "PO";

export type Actor = AgentRole | string;

// Entity state registry: maps entity type to its allowed states
export const ENTITY_STATE_SETS: Record<EntityType, readonly string[]> = {
  PROJECT: [
    "UNINITIALIZED", "ANALYZING", "ARCHITECTING", "SPECIFYING",
    "PLANNING", "EXECUTING", "VERIFYING", "COMPLETE", "BLOCKED",
  ],
  REQ: ["approved", "draft", "superseded"],
  BR: ["approved", "draft", "superseded"],
  CON: ["active", "draft", "superseded"],
  DEC: ["proposed", "approved", "rejected"],
  ADR: ["proposed", "accepted", "rejected", "superseded", "deprecated"],
  SP: ["DRAFT", "REVIEW", "READY", "SUPERSEDED"],
  AC: ["draft", "ready", "superseded"],
  MOD: [
    "DRAFT", "AWAITING_APPROVAL", "APPROVED", "EXECUTING",
    "VERIFYING", "PASSED", "FAILED", "COMPLETE", "BLOCKED",
  ],
  WP: [
    "PLANNED", "AUTHORIZED", "RUNNING", "BLOCKED",
    "IMPLEMENTED", "VERIFYING", "FAILED", "COMPLETE",
  ],
  TASK: ["draft", "assigned", "in_progress", "done", "blocked"],
  APR: ["granted", "revoked"],
  BLK: ["active", "resolved"],
  DEF: ["open", "in_progress", "resolved", "reopened"],
  EVD: ["recorded"],
  QA: ["PASS", "FAILED", "WAIVED"],
  SEC: ["active", "superseded"],
  WAIVER: ["active", "expired", "invalidated"],
  CR: ["proposed", "approved", "rejected", "implemented"],
  OPEN: ["open", "resolved", "obsolete"],
  RTK: ["current", "stale", "invalid"],
  SKILL: ["current", "stale", "invalid"],
  VERIFICATION: ["PENDING", "RUNNING", "FAILED", "PASSED", "WAIVED"],
} as const;

export type StateSet = typeof ENTITY_STATE_SETS;
export type StateOf<T extends EntityType> = StateSet[T][number];
