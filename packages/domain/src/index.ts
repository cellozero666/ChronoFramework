/**
 * Domain module — pure types, state machines, validators, and error definitions.
 * No I/O. No runtime-specific concepts. No provider/model/version references.
 *
 * [FW §22, DOM §4.4] — Runtime/provider/model neutrality is a domain rule.
 */

// Errors and error codes
export {
  ChronoError,
  ErrorCode,
  Severity,
  CHRONO_ERROR_CODES,
  type ChronoErrorOptions,
  type ChronoErrorCode,
  type Severity as SeverityType,
} from "./errors.js";

// State definitions
export {
  ENTITY_STATE_SETS,
  type AdrState,
  type AgentRole,
  type ArchitectureState,
  type AttestationState,
  type BlockerState,
  type ChangeRequestState,
  type DecisionState,
  type DefectState,
  type EntityType,
  type ProjectState,
  type SpecificationState,
  type ModuleState,
  type StateSet,
  type StateOf,
  type VerificationState,
  type WaiverState,
} from "./state.js";

// State transitions
export {
  ADR_TRANSITIONS,
  ARCHITECTURE_TRANSITIONS,
  ATTESTATION_TRANSITIONS,
  BLOCKER_TRANSITIONS,
  CHANGE_REQUEST_TRANSITIONS,
  DECISION_TRANSITIONS,
  DEFECT_TRANSITIONS,
  MODULE_TRANSITIONS,
  SPECIFICATION_TRANSITIONS,
  PROJECT_DIRECTIONAL_CONSTRAINTS,
  TRANSITION_TABLES,
  VERIFICATION_TRANSITIONS,
  WAIVER_TRANSITIONS,
  WORK_PACKAGE_TRANSITIONS,
  type LegalTransition,
} from "./transitions.js";

// Validator and projection
export {
  isValidState,
  projectProjectState,
  validateBlockerTransition,
  validateTransition,
  type ProjectProjectionInput,
} from "./validator.js";

// Revision hashing
export {
  computeRevisionHash,
  isStaleReference,
  verifyRevisionHash,
} from "./revision.js";
