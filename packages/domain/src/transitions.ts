/**
 * Legal state transition tables matching docs/domain/STATE-MODEL.md §2
 * [FW §596, P7.5] — The Core MUST reject illegal transitions
 * No runtime-specific concepts [FW §22]
 */

/**
 * A transition is identified by (fromState, toState, eventType).
 * Transitions not listed are rejected.
 * [STATE §2, §6.1]
 */
export interface LegalTransition {
  readonly fromState: string;
  readonly toState: string;
  readonly eventType: string;
}

/**
 * Specification transitions [STATE §2.1]
 * [FW §595-596, P5.6, P3.9]
 */
export const SPECIFICATION_TRANSITIONS: readonly LegalTransition[] = [
  // Initial creation handled by Core (ArtifactCreated event), not a state-to-state transition
  { fromState: "DRAFT", toState: "REVIEW", eventType: "SpecSubmittedForReview" },
  { fromState: "REVIEW", toState: "READY", eventType: "SpecApprovedReady" },
  { fromState: "DRAFT", toState: "DRAFT", eventType: "SpecRevised" },
  { fromState: "REVIEW", toState: "DRAFT", eventType: "SpecNeedsRevision" },
  { fromState: "READY", toState: "SUPERSEDED", eventType: "SpecSuperseded" },
  { fromState: "SUPERSEDED", toState: "SUPERSEDED", eventType: "SpecArchived" },
];

/**
 * Module transitions [STATE §2.2]
 * [FW §596, P3.9, P8.4, P8.5, P9.3]
 */
export const MODULE_TRANSITIONS: readonly LegalTransition[] = [
  { fromState: "DRAFT", toState: "AWAITING_APPROVAL", eventType: "ModulePlanned" },
  { fromState: "AWAITING_APPROVAL", toState: "APPROVED", eventType: "ModuleApproved" },
  { fromState: "APPROVED", toState: "EXECUTING", eventType: "ExecutionStarted" },
  { fromState: "EXECUTING", toState: "VERIFYING", eventType: "ImplementationComplete" },
  { fromState: "VERIFYING", toState: "PASSED", eventType: "SpekkioPassed" },
  { fromState: "PASSED", toState: "COMPLETE", eventType: "DefinitionOfDoneSatisfied" },
  { fromState: "VERIFYING", toState: "FAILED", eventType: "SpekkioFailed" },
  { fromState: "FAILED", toState: "EXECUTING", eventType: "CorrectionComplete" },
  { fromState: "EXECUTING", toState: "BLOCKED", eventType: "BlockerRaised" },
  { fromState: "VERIFYING", toState: "BLOCKED", eventType: "BlockerRaised" },
  { fromState: "APPROVED", toState: "BLOCKED", eventType: "BlockerRaised" },
  { fromState: "AWAITING_APPROVAL", toState: "BLOCKED", eventType: "BlockerRaised" },
  { fromState: "ANY", toState: "BLOCKED", eventType: "BlockerRaised" },
  { fromState: "BLOCKED", toState: "AWAITING_APPROVAL", eventType: "BlockerResolved" },
  { fromState: "BLOCKED", toState: "APPROVED", eventType: "BlockerResolved" },
  { fromState: "BLOCKED", toState: "EXECUTING", eventType: "BlockerResolved" },
  { fromState: "BLOCKED", toState: "VERIFYING", eventType: "BlockerResolved" },
  { fromState: "AWAITING_APPROVAL", toState: "DRAFT", eventType: "ChangeControlInitiated" },
];

/**
 * WorkPackage transitions [STATE §2.3]
 * [FW §597, P3.9, P8.3, P8.5]
 */
export const WORK_PACKAGE_TRANSITIONS: readonly LegalTransition[] = [
  { fromState: "PLANNED", toState: "AUTHORIZED", eventType: "WorkPackageAuthorized" },
  { fromState: "AUTHORIZED", toState: "RUNNING", eventType: "ExecutionAssigned" },
  { fromState: "RUNNING", toState: "IMPLEMENTED", eventType: "ImplementationDone" },
  { fromState: "IMPLEMENTED", toState: "VERIFYING", eventType: "VerificationReady" },
  { fromState: "VERIFYING", toState: "COMPLETE", eventType: "SpekkioPassed" },
  { fromState: "VERIFYING", toState: "FAILED", eventType: "SpekkioFailed" },
  { fromState: "FAILED", toState: "RUNNING", eventType: "CorrectionComplete" },
  { fromState: "RUNNING", toState: "BLOCKED", eventType: "BlockerRaised" },
  { fromState: "AUTHORIZED", toState: "BLOCKED", eventType: "BlockerRaised" },
  { fromState: "IMPLEMENTED", toState: "BLOCKED", eventType: "BlockerRaised" },
  { fromState: "VERIFYING", toState: "BLOCKED", eventType: "BlockerRaised" },
  { fromState: "PLANNED", toState: "BLOCKED", eventType: "BlockerRaised" },
  { fromState: "BLOCKED", toState: "AUTHORIZED", eventType: "BlockerResolved" },
  { fromState: "BLOCKED", toState: "RUNNING", eventType: "BlockerResolved" },
  { fromState: "BLOCKED", toState: "IMPLEMENTED", eventType: "BlockerResolved" },
  { fromState: "BLOCKED", toState: "VERIFYING", eventType: "BlockerResolved" },
];

/**
 * Verification transitions [STATE §5]
 * [FW §379, P3.9, P9.3, P2.6]
 */
export const VERIFICATION_TRANSITIONS: readonly LegalTransition[] = [
  { fromState: "PENDING", toState: "RUNNING", eventType: "VerificationStarted" },
  { fromState: "RUNNING", toState: "PASSED", eventType: "VerificationPassed" },
  { fromState: "RUNNING", toState: "FAILED", eventType: "VerificationFailed" },
  { fromState: "RUNNING", toState: "WAIVED", eventType: "VerificationWaived" },
  { fromState: "FAILED", toState: "RUNNING", eventType: "CorrectionComplete" },
  { fromState: "PASSED", toState: "PENDING", eventType: "NewRevisionRequiresReverification" },
  { fromState: "WAIVED", toState: "PENDING", eventType: "NewRevisionRequiresReverification" },
];

/**
 * ADR transitions [STATE §2.4]
 * [P4.5]
 */
export const ADR_TRANSITIONS: readonly LegalTransition[] = [
  { fromState: "proposed", toState: "accepted", eventType: "AdrAccepted" },
  { fromState: "proposed", toState: "rejected", eventType: "AdrRejected" },
  { fromState: "accepted", toState: "superseded", eventType: "AdrSuperseded" },
  { fromState: "accepted", toState: "deprecated", eventType: "AdrDeprecated" },
];

/**
 * Architecture transitions [STATE §2.5]
 * [REF §5, P4.8]
 */
export const ARCHITECTURE_TRANSITIONS: readonly LegalTransition[] = [
  { fromState: "proposed", toState: "under_review", eventType: "ArchitectureReviewed" },
  { fromState: "under_review", toState: "approved", eventType: "ArchitectureSecurityApproved" },
  { fromState: "approved", toState: "superseded", eventType: "ArchitectureSuperseded" },
];

/**
 * Decision transitions [STATE §2.6]
 * [P2.5, P3.3]
 *
 * Reconciliation note [Remediation §6]: STATE §1.1 fixes the Decision state
 * set to proposed | approved | rejected (no `superseded` state). A later
 * decision replaces an earlier one through the `supersedes` reference
 * recorded on the Decision (P2.5), not through a state transition. There is
 * therefore no approved → superseded transition: supersession is a
 * reference, and any such transition attempt is rejected as INVALID_STATE.
 */
export const DECISION_TRANSITIONS: readonly LegalTransition[] = [
  { fromState: "proposed", toState: "approved", eventType: "DecisionApproved" },
  { fromState: "proposed", toState: "rejected", eventType: "DecisionRejected" },
];

/**
 * Waiver transitions [STATE §2.7]
 * [P2.8, FW §398]
 */
export const WAIVER_TRANSITIONS: readonly LegalTransition[] = [
  { fromState: "active", toState: "expired", eventType: "WaiverExpired" },
  { fromState: "active", toState: "invalidated", eventType: "WaiverInvalidated" },
];

/**
 * ChangeRequest transitions [STATE §2.8]
 * [FW §937, P3.3]
 */
export const CHANGE_REQUEST_TRANSITIONS: readonly LegalTransition[] = [
  { fromState: "proposed", toState: "approved", eventType: "ChangeRequestApproved" },
  { fromState: "proposed", toState: "rejected", eventType: "ChangeRequestRejected" },
  { fromState: "approved", toState: "implemented", eventType: "ChangeRequestImplemented" },
];

/**
 * Attestation transitions [STATE §2.9]
 * [P6.5, P6.6, P7.3]
 */
export const ATTESTATION_TRANSITIONS: readonly LegalTransition[] = [
  { fromState: "current", toState: "stale", eventType: "AttestationStale" },
  { fromState: "current", toState: "invalid", eventType: "AttestationInvalid" },
  { fromState: "stale", toState: "invalid", eventType: "AttestationInvalid" },
  { fromState: "stale", toState: "current", eventType: "AttestationReverified" },
  { fromState: "invalid", toState: "current", eventType: "AttestationReverified" },
];

/**
 * Blocker transitions [STATE §2.10]
 * [P3.3, P7.3]
 */
export const BLOCKER_TRANSITIONS: readonly LegalTransition[] = [
  { fromState: "active", toState: "resolved", eventType: "BlockerResolved" },
  { fromState: "resolved", toState: "active", eventType: "BlockerReactivated" },
];

/**
 * Defect transitions [STATE §2.11]
 * [FW §484-507, P9.4]
 */
export const DEFECT_TRANSITIONS: readonly LegalTransition[] = [
  { fromState: "open", toState: "in_progress", eventType: "DefectAssigned" },
  { fromState: "in_progress", toState: "resolved", eventType: "DefectResolved" },
  { fromState: "in_progress", toState: "reopened", eventType: "DefectReopened" },
  { fromState: "reopened", toState: "in_progress", eventType: "DefectReopenedAssigned" },
  { fromState: "resolved", toState: "reopened", eventType: "DefectReopened" },
];

/**
 * Project transitions are projection-only — not directly transitionable.
 * But we track the directional constraints [STATE §3.3].
 */
export const PROJECT_DIRECTIONAL_CONSTRAINTS = {
  progression: [
    "UNINITIALIZED", "ANALYZING", "ARCHITECTING",
    "SPECIFYING", "PLANNING", "EXECUTING",
    "VERIFYING", "COMPLETE",
  ],
  interrupt: "ANY → BLOCKED",
  terminal: "COMPLETE",
} as const;

/**
 * Registry mapping entity type to its transition table.
 * "ANY" in fromState means the transition is legal from any state.
 */
export const TRANSITION_TABLES: Record<string, readonly LegalTransition[]> = {
  SP: SPECIFICATION_TRANSITIONS,
  MOD: MODULE_TRANSITIONS,
  WP: WORK_PACKAGE_TRANSITIONS,
  VERIFICATION: VERIFICATION_TRANSITIONS,
  ADR: ADR_TRANSITIONS,
  ARCHITECTURE: ARCHITECTURE_TRANSITIONS,
  DEC: DECISION_TRANSITIONS,
  WAIVER: WAIVER_TRANSITIONS,
  CR: CHANGE_REQUEST_TRANSITIONS,
  RTK: ATTESTATION_TRANSITIONS,
  SKILL: ATTESTATION_TRANSITIONS,
  BLK: BLOCKER_TRANSITIONS,
  DEF: DEFECT_TRANSITIONS,
};
