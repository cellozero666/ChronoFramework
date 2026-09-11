/**
 * State transition validator matching docs/domain/STATE-MODEL.md §6
 * [FW §596, P7.5] — Core MUST validate every state transition deterministically
 * No runtime-specific concepts [FW §22]
 */

import { ChronoError, ErrorCode, Severity } from "./errors.js";
import type { LegalTransition } from "./transitions.js";
import { TRANSITION_TABLES } from "./transitions.js";
import { ENTITY_STATE_SETS } from "./state.js";
import type { EntityType, ProjectState } from "./state.js";

/**
 * Validate that an entity's target state is in its legal state set.
 * [STATE §2, §3.1]
 */
export function isValidState(entityType: EntityType, state: string): boolean {
  const validStates = ENTITY_STATE_SETS[entityType];
  if (validStates === undefined) {
    return false;
  }
  return validStates.includes(state);
}

/**
 * Validate a state transition against the legal transition table.
 *
 * Rules:
 * - The target state MUST be in the entity's legal state set [STATE §3.1]
 * - The transition MUST be listed in the entity's transition table [STATE §6.1]
 * - "ANY" in fromState means the transition is legal from any state [STATE §2.2]
 * - Transitions not listed MUST be rejected [STATE §2]
 *
 * @returns the matched transition, or throws ChronoError
 */
export function validateTransition(
  entityType: EntityType | string,
  fromState: string,
  toState: string,
  eventType: string,
  _guardContext?: Record<string, unknown>
): LegalTransition {
  // 1. Validate target state is in the legal set
  const entityTypeKey = entityType as EntityType;
  if (!isValidState(entityTypeKey, toState)) {
    throw new ChronoError({
      code: ErrorCode.INVALID_STATE,
      severity: Severity.ERROR,
      message: `State '${toState}' is not a legal state for entity type ${entityType}`,
      invariantRef: "INV §3.1",
      affectedTarget: `${entityType}:${toState}`,
      suggestedAction: "Refer to STATE-MODEL.md §1 for the approved state set",
    });
  }

  // 2. Validate transition is legal
  const table = TRANSITION_TABLES[entityType as string];
  if (table === undefined) {
    throw new ChronoError({
      code: ErrorCode.ILLEGAL_TRANSITION,
      severity: Severity.ERROR,
      message: `No transition table defined for entity type ${entityType}`,
      invariantRef: "INV §3.2",
      affectedTarget: entityType,
      suggestedAction: "Refer to STATE-MODEL.md §2 for legal transitions",
    });
  }

  const matched = table.find(
    (t) =>
      (t.fromState === "ANY" || t.fromState === fromState) &&
      t.toState === toState &&
      t.eventType === eventType
  );

  if (matched === undefined) {
    throw new ChronoError({
      code: ErrorCode.ILLEGAL_TRANSITION,
      severity: Severity.ERROR,
      message: `Illegal transition: ${entityType} ${fromState} → ${toState} via '${eventType}'`,
      invariantRef: "INV §3.2",
      affectedTarget: `${entityType}:${fromState}`,
      suggestedAction:
        "Refer to STATE-MODEL.md §2 for legal state transitions for this entity type",
    });
  }

  return matched;
}

/**
 * Project state is a deterministic projection [STATE §3]
 * This function must be called by the Core after any state change.
 * The domain provides the projection algorithm; the Core provides the data.
 */
export interface ProjectProjectionInput {
  initialized: boolean;
  blockers: readonly { active: boolean; targetType: string }[];
  modules: readonly { state: string }[];
  workPackages: readonly { state: string }[];
  specifications: readonly { state: string }[];
  hasSpecs: boolean;
  systemAnalysisComplete: boolean;
  architectureState?: string | undefined;
  planningInProgress: boolean;
}

/**
 * Compute the projected Project state [STATE §3.1]
 * The first matching rule determines the state.
 */
export function projectProjectState(input: ProjectProjectionInput): ProjectState {
  // Step 1: BLOCKED — any active blocker targeting project or children
  const hasActiveBlocker = input.blockers.some((b) => b.active);
  if (hasActiveBlocker) {
    return "BLOCKED";
  }

  // Step 2: EXECUTING — any module APPROVED/EXECUTING or any WP RUNNING
  const hasExecutingModule = input.modules.some((m) =>
    ["APPROVED", "EXECUTING"].includes(m.state)
  );
  const hasRunningWP = input.workPackages.some((w) => w.state === "RUNNING");
  if (hasExecutingModule || hasRunningWP) {
    return "EXECUTING";
  }

  // Step 3: VERIFYING — any module in VERIFYING/PASSED/FAILED or WP in VERIFYING/FAILED
  const hasVerifyingModule = input.modules.some((m) =>
    ["VERIFYING", "PASSED", "FAILED"].includes(m.state)
  );
  const hasVerifyingWP = input.workPackages.some((w) =>
    ["VERIFYING", "FAILED"].includes(w.state)
  );
  if (hasVerifyingModule || hasVerifyingWP) {
    return "VERIFYING";
  }

  // Step 4: PLANNING — any module AWAITING_APPROVAL, or DRAFT with READY specs
  const hasAwaitingApproval = input.modules.some((m) => m.state === "AWAITING_APPROVAL");
  const hasDraftModuleWithReadySpec =
    input.modules.some((m) => m.state === "DRAFT") &&
    input.specifications.some((s) => s.state === "READY");
  if (hasAwaitingApproval || (hasDraftModuleWithReadySpec && input.planningInProgress)) {
    return "PLANNING";
  }

  // Step 5: SPECIFYING — any spec DRAFT/REVIEW, or harness/validation in progress
  const hasSpecDraftReview = input.specifications.some((s) =>
    ["DRAFT", "REVIEW"].includes(s.state)
  );
  if (hasSpecDraftReview) {
    return "SPECIFYING";
  }

  // Step 6: ARCHITECTING — system analysis complete, architecture proposed/under_review, no specs
  const hasArchInProgress =
    input.systemAnalysisComplete &&
    input.architectureState !== undefined &&
    ["proposed", "under_review"].includes(input.architectureState) &&
    !input.hasSpecs;
  if (hasArchInProgress) {
    return "ARCHITECTING";
  }

  // Step 7: ANALYZING — system analysis in progress
  // (project initialized but analysis not complete)
  if (input.initialized && !input.systemAnalysisComplete) {
    return "ANALYZING";
  }

  // Step 8: COMPLETE — all modules COMPLETE, no active blockers
  const allModulesComplete =
    input.modules.length > 0 && input.modules.every((m) => m.state === "COMPLETE");
  if (allModulesComplete && !hasActiveBlocker) {
    return "COMPLETE";
  }

  // Step 9: UNINITIALIZED
  return "UNINITIALIZED";
}
