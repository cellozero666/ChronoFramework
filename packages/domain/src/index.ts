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

// Planning/artifact-authoring path (OC-P11): Gaspar bootstrap without dispatch
export {
  APPROVAL_TICKET_TTL_SECONDS,
  FORBIDDEN_READ_SUBSTRINGS,
  PLANNING_ALLOC_FAMILY,
  PLANNING_BASH_PREFIXES,
  PLANNING_KINDS,
  PLANNING_KIND_DIR,
  PLANNING_KIND_FAMILY,
  PLANNING_MAX_BYTES,
  PLANNING_MIN_BYTES,
  approvalAnswerMatches,
  approvalChallenge,
  approvalQuestionLine,
  assertNoSecrets,
  assertPlanningContent,
  assertPlanningId,
  assertPlanningKind,
  canonicalizeJson,
  extractBashCommand,
  isPlanningBashCommand,
  isPlanningKind,
  planningFilename,
  referencesForbiddenState,
  type PlanningKind,
} from "./planning.js";

// Managed-asset inventory for routing drift binding [FIXES-SL-10.1 C2]
export {
  ENTRY_SESSION_SCRIPT_ASSET,
  LEGACY_MANAGED_ASSETS,
  OPENCODE_AGENT_ASSETS,
  OPENCODE_TOOL_ASSETS,
  OPENCODE_TOOLS_PACKAGE_MARKER,
  RUNTIME_MANAGED_ASSETS,
  claudeEntryAsset,
  kiroEntryAsset,
  managedAssetInventory,
  type ManagedAssetKind,
  type ManagedAssetSpec,
} from "./managed-assets.js";

// Authority/capability matrix [DOM §2.2, Remediation §3A]
export {
  AUTHORITY_POLICY_VERSION,
  EVENT_ROLE_ALLOWLIST,
  KNOWN_RUNTIME_IDS,
  OPENCODE_TOOL_POLICY,
  ROLE_CAPABILITIES,
  TOOL_POLICY_VERSION,
  classifyOpencodeTool,
  isCapable,
  isKnownRuntimeId,
  mayEnactEvent,
  type CapabilityHolder,
  type CoreOperation,
  type KnownRuntimeId,
  type ToolClassification,
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
  ENROLLMENT_FRESHNESS_MS,
  ROUTING_PROOF_FRESHNESS_MS,
  RTK_UPSTREAM,
  SKILL_UPSTREAM,
  buildApprovalPayload,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  buildWaiverPayload,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  parseApprovalPublicKey,
  signApprovalPayload,
  verifyApprovalSignature,
  type ApprovalAction,
  type ApprovalKeyPair,
  type ApprovalPayload,
  type EnrollmentPayload,
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

// Release metadata: PO-approved external trust pins [FW §22, PL Phase 4]
export {
  SKILL_RELEASE,
  SKILL_RUNTIME_PATHS,
  convertSkillSource,
  hashSkillSource,
  parseSkillFrontmatter,
  skillGeneratedHashes,
  skillRawSourceUrl,
  skillVendorPath,
  verifySkillRelease,
  type SkillFrontmatter,
  type SkillRuntime,
} from "./release.js";

// Setup state machine for init orchestration [SLICE-10 §3.3]
export {
  BROKER_SESSION_TTL_SECONDS,
  GASPAR_ENTRY_ACTIONS,
  SETUP_STEPS,
  isLegalSetupAdvance,
  setupStepIndex,
  type GasparEntryProjection,
  type SetupStep,
} from "./setup.js";

// Revision hashing
export {
  canonicalize,
  computeRevisionHash,
  isRevisionHash,
  isStaleReference,
  verifyRevisionHash,
} from "./revision.js";
