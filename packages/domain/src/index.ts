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
  ADAPTER_SESSION_PATTERN,
  ENTITY_STATE_SETS,
  isAdapterSession,
  isAgentRole,
  parseActorIdentity,
  toRuntimeIdentity,
  toSessionIdentity,
  toToolIdentity,
  type ActorKind,
  type AdapterIdentity,
  type AdrState,
  type AgentRole,
  type ArchitectureState,
  type AttestationState,
  type BlockerState,
  type ChangeRequestState,
  type DecisionState,
  type DefectState,
  type EntityType,
  type HumanIdentity,
  type ModelIdentity,
  type ModuleState,
  type ParsedActor,
  type ProjectState,
  type RuntimeIdentity,
  type SessionIdentity,
  type SystemIdentity,
  type ToolIdentity,
  type SpecificationState,
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
  validateTransition,
  type ProjectProjectionInput,
} from "./validator.js";

// Authority/capability matrix [DOM §2.2, Remediation §3A]
export {
  AUTHORITY_POLICY_VERSION,
  EVENT_ROLE_ALLOWLIST,
  ROLE_CAPABILITIES,
  isCapable,
  mayEnactEvent,
  type CapabilityHolder,
  type CoreOperation,
} from "./capabilities.js";

// Registration rules (entry states, required fields)
export {
  BLOCKER_TYPES,
  DEFECT_ROUTING,
  ENTRY_STATES,
  REQUIRED_ARTIFACT_FIELDS,
  assertBlockerType,
  assertRequiredFields,
  assertValidInitialState,
  type BlockerType,
  type DefectClassification,
  type RegistrableFamily,
} from "./registration.js";

// Human-authority cryptography [ADR-003, CORE §8]
export {
  APPROVAL_ACTIONS,
  RTK_UPSTREAM,
  SKILL_UPSTREAM,
  buildApprovalPayload,
  buildSessionAuthorizationPayload,
  buildWaiverPayload,
  generateApprovalKeyPair,
  parseApprovalPublicKey,
  signApprovalPayload,
  verifyApprovalSignature,
  type ApprovalAction,
  type ApprovalKeyPair,
  type ApprovalPayload,
  type SessionAuthorizationPayload,
  type WaiverPayload,
} from "./authority.js";

// Artifact identity [CORE §3.1, INV §10.1]
export {
  ARTIFACT_ID_FAMILIES,
  formatArtifactId,
  isValidArtifactId,
  parseArtifactId,
  type ArtifactIdFamily,
  type ParsedArtifactId,
} from "./identity.js";

// Revision hashing
export {
  canonicalize,
  computeRevisionHash,
  isRevisionHash,
  isStaleReference,
  verifyRevisionHash,
} from "./revision.js";
