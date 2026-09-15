/**
 * Core-owned authority/capability matrix [DOM §2.2, P2.8, Remediation §3A].
 *
 * Derived from the Authority Protocol's authority domains: Gaspar owns
 * analysis/architecture/specification/planning; Belthazar, Melchior, and
 * Prometheus own implementation inside approved contracts; Lucca owns
 * testing evidence; Glenn owns security evidence and security blockers;
 * Spekkio owns independent verdicts and defect issuance; the PO is supreme
 * over product decisions but cannot issue Spekkio's verdict (verdict
 * independence) and cannot skip signatures (cryptography still applies).
 *
 * Deny-by-default: an operation not listed here, or an identity not listed
 * for an operation, is denied. Adapter sessions are resolved to their bound
 * role before consulting this matrix: there is deliberately no generic
 * "session" holder, so a session string alone never confers capabilities
 * [Remediation §3A, review finding 3].
 * No runtime-specific concepts [FW §22].
 */

import type { AgentRole } from "./state.js";

/** Version of this authority policy, persisted with authorization evidence. */
export const AUTHORITY_POLICY_VERSION = "9";

/**
 * Version of the runtime tool-classification policy below. Bumped
 * independently from the authority matrix: tool classification affects
 * pre-tool gate decisions, never grant semantics.
 */
export const TOOL_POLICY_VERSION = "7";

export type CapabilityHolder = AgentRole | "PO";

/** Core operations governed by the matrix. */
export type CoreOperation =
  | "artifact.register"
  | "planning.propose"
  | "planning.revise"
  | "planning.status"
  | "planning.supersede"
  | "approval.request"
  | "approval.finalize"
  | "architecture.propose"
  | "architecture.enact"
  | "harness.record"
  | "harness.invalidate"
  | "security.profile"
  | "evidence.record"
  | "defect.record"
  | "verification.record"
  | "blocker.raise"
  | "blocker.resolve"
  | "waiver.expire"
  | "execution.request"
  | "completion.request"
  | "review.assign"
  | "review.complete"
  | "review.reconcile"
  | "module.activate"
  | "correction.open"
  | "policy.set"
  | "dispatch.reconcile"
  | "dispatch.release"
  | "scope.advance"
  | "status.next"
  | "status.execution"
  | "status.evidence"
  | "status.deep"
  | "session.revoke"
  | "attestation.record"
  | "adapter.register"
  | "adapter.approve"
  | "adapter.revoke"
  | "broker.issue"
  | "broker.revoke";

const ALL_WORKERS: readonly AgentRole[] = ["belthazar", "melchior", "prometheus"];

/**
 * Allowed identities per operation. `PO` appears by supremacy [I-01]
 * except where verdict independence forbids it (verification.record).
 */
export const ROLE_CAPABILITIES: Record<CoreOperation, readonly CapabilityHolder[]> = {
  "artifact.register": ["gaspar", "PO"],
  "planning.propose": ["gaspar", "PO"],
  "planning.revise": ["gaspar", "PO"],
  "planning.status": ["gaspar", "PO"],
  "planning.supersede": ["gaspar", "PO"],
  "approval.request": ["gaspar", "PO"],
  "approval.finalize": ["gaspar", "PO"],
  "architecture.propose": ["gaspar", "PO"],
  "architecture.enact": ["gaspar", "PO"],
  "harness.record": ["gaspar", "PO"],
  "harness.invalidate": ["gaspar", "PO"],
  "security.profile": ["glenn", "gaspar", "PO"],
  "evidence.record": ["gaspar", "belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio", "PO"],
  "defect.record": ["spekkio"],
  "verification.record": ["spekkio"],
  "blocker.raise": ["gaspar", "belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio", "PO"],
  "blocker.resolve": ["gaspar", "belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio", "PO"],
  "waiver.expire": ["gaspar", "PO"],
  "execution.request": ["gaspar", "PO"],
  "completion.request": ["gaspar", "spekkio", "PO"],
  "review.assign": ["gaspar", "PO"],
  "review.complete": ["glenn", "spekkio"],
  "review.reconcile": ["gaspar", "PO"],
  "module.activate": ["gaspar", "PO"],
  "correction.open": ["gaspar", "spekkio", "PO"],
  "policy.set": ["gaspar", "PO"],
  "dispatch.reconcile": ["gaspar", "PO"],
  "dispatch.release": ["belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio", "gaspar", "PO"],
  "scope.advance": ["belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio"],
  "status.next": ["gaspar", "belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio", "PO"],
  "status.execution": ["gaspar", "belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio", "PO"],
  "status.evidence": ["gaspar", "belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio", "PO"],
  "status.deep": ["gaspar", "PO"],
  "session.revoke": ["gaspar", "PO"],
  "attestation.record": ["gaspar", "PO"],
  "adapter.register": ["PO"],
  "adapter.approve": ["PO"],
  "adapter.revoke": ["PO"],
  "broker.issue": ["gaspar", "PO"],
  "broker.revoke": ["gaspar", "PO"],
};

/**
 * Transition-enactment allowlist by event type. BlockerRaised and
 * BlockerResolved are linkage-governed (an active/resolved blocker record
 * is required) rather than role-governed. Unlisted events are denied.
 */
export const EVENT_ROLE_ALLOWLIST: Record<string, readonly CapabilityHolder[]> = {
  SpecSubmittedForReview: ["gaspar", "PO"],
  SpecNeedsRevision: ["gaspar", "PO"],
  SpecSuperseded: ["gaspar", "PO"],
  SpecApprovedReady: ["gaspar", "PO"],
  ModulePlanned: ["gaspar", "PO"],
  ModuleApproved: ["gaspar", "PO"],
  ExecutionStarted: [...ALL_WORKERS, "gaspar", "PO"],
  ImplementationComplete: [...ALL_WORKERS, "gaspar", "PO"],
  SpekkioPassed: ["spekkio"],
  SpekkioFailed: ["spekkio"],
  CorrectionComplete: [...ALL_WORKERS, "gaspar", "PO"],
  ChangeControlInitiated: ["gaspar", "PO"],
  DefinitionOfDoneSatisfied: ["gaspar", "PO"],
  // Aggregate module completion rides the completion authority
  // (gaspar/spekkio/PO), never worker execution roles.
  AllPackagesComplete: ["gaspar", "spekkio", "PO"],
  WorkPackageAuthorized: ["gaspar", "PO"],
  ExecutionAssigned: [...ALL_WORKERS, "gaspar", "PO"],
  ImplementationDone: [...ALL_WORKERS, "gaspar", "PO"],
  VerificationReady: [...ALL_WORKERS, "gaspar", "PO"],
  ArchitectureReviewed: ["gaspar", "PO"],
  ArchitectureSecurityApproved: ["gaspar", "PO"],
  // Blocker linkage events: role-gated here AND linkage-governed in the
  // Core (an active/resolved blocker record is additionally required).
  BlockerRaised: ["gaspar", "belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio", "PO"],
  BlockerResolved: ["gaspar", "belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio", "PO"],
};

/**
 * Check a session-resolved role against a capability row. Callers resolve
 * adapter sessions to their bound role first; the "session" kind never
 * reaches this function. PO passes by supremacy wherever listed; the
 * machine identity never authorizes.
 */
export function isCapable(
  operation: CoreOperation,
  kind: "agent" | "po",
  role?: AgentRole
): boolean {
  const row = ROLE_CAPABILITIES[operation];
  if (row === undefined) {
    return false;
  }
  if (kind === "po") {
    return row.includes("PO");
  }
  if (kind === "agent" && role !== undefined) {
    return row.includes(role);
  }
  return false;
}

/**
 * OpenCode built-in tool classification [SLICE-9 §9.4, P8.6].
 * Source: https://opencode.ai/docs/tools/ (names only; policy is Core-owned).
 *
 * - "read": local read-only tools. They cannot mutate project state, so
 *   the gate authorizes without a dispatch scope. (Secret exfiltration via
 *   reads is governed separately by secret redaction, INV §7.9.)
 * - "mutate": tools capable of filesystem, process, network, package, Git,
 *   credential, deployment, destructive, or production-impacting effects.
 *   They require a full execution-gate decision with dispatch scope.
 * - "delegate": OpenCode's real subagent-delegation tool (`task`,
 *   args `description`/`prompt`/`subagent_type`, child sessions with
 *   `parentID`). Delegation is NEVER broadly allowed: one `task` call
 *   passes only when bound to a live CHRONO dispatch for the exact
 *   worker role. Unknown, builtin, or ungated delegation stays denied.
 *
 * Deny-by-default: any tool not listed here — including future built-ins,
 * MCP tools (`mcp_*`), and custom tools — is DENIED until classified in a
 * reviewed policy release. Tool names are adapter data, never authority.
 */
export type ToolClassification = "read" | "mutate" | "planning" | "delegate" | "lifecycle";

export const OPENCODE_TOOL_POLICY: Record<string, ToolClassification> = {
  read: "read",
  grep: "read",
  glob: "read",
  skill: "read",
  todowrite: "read",
  question: "read",
  lsp: "read",
  bash: "mutate",
  edit: "mutate",
  write: "mutate",
  apply_patch: "mutate",
  webfetch: "mutate",
  websearch: "mutate",
  task: "delegate",
  // Native governed planning tools (OC-P11 correction): real
  // model-callable tools registered by the generated plugin. They are
  // neither generic shell mutation nor implementation dispatch: each
  // enforces its Gaspar session itself and the Core validates every
  // call. The gate requires proven entry, nothing more.
  chrono_artifact_status: "planning",
  chrono_artifact_propose: "planning",
  chrono_artifact_revise: "planning",
  chrono_artifact_supersede: "planning",
  chrono_approval_request: "planning",
  chrono_approval_status: "planning",
  // Native governed dispatch tools (post-planning deadlock repair):
  // chrono_dispatch opens a dispatch intent after full gate
  // validation (Gaspar session, host-held); chrono_dispatch_claim
  // binds one worker subagent session to it. Entry only at the gate;
  // every deeper check lives in the Core.
  chrono_dispatch: "planning",
  chrono_dispatch_claim: "planning",
  // Native governed lifecycle tools (CORE_FIX vertical): narrow,
  // capability-gated state operations for the executable workflow
  // (evidence, completion, reviews, defects, verdicts, corrections,
  // orchestration). Entry plus Core role/scope/binding checks at the
  // gate; every deeper check lives in the Core.
  chrono_next: "lifecycle",
  chrono_execution_status: "lifecycle",
  chrono_evidence_record: "lifecycle",
  chrono_evidence_status: "lifecycle",
  chrono_complete_request: "lifecycle",
  chrono_review_request: "lifecycle",
  chrono_review_complete: "lifecycle",
  chrono_defect_record: "lifecycle",
  chrono_defect_resolve: "lifecycle",
  chrono_verify_record: "lifecycle",
  chrono_correction_open: "lifecycle",
  chrono_correction_complete: "lifecycle",
  chrono_module_complete: "lifecycle",
  chrono_module_activate: "lifecycle",
  chrono_review_reconcile: "lifecycle",
  chrono_wp_authorize: "lifecycle",
  chrono_deep_check: "lifecycle",
  chrono_policy_set: "lifecycle",
  chrono_policy_status: "lifecycle",
  chrono_dispatch_confirm: "lifecycle",
  chrono_dispatch_release: "lifecycle",
  chrono_dispatch_revoke: "lifecycle",
  chrono_dispatch_reconcile: "lifecycle",
  chrono_scope_advance: "lifecycle",
};

/**
 * Canonical worker roles a native `task` delegation may target
 * without a kind-fitting dispatch: implementation (belthazar,
 * melchior, prometheus) and test evidence (lucca). Review kinds
 * additionally admit glenn (security-review) and spekkio
 * (verification) through a live dispatch of that kind — see
 * DISPATCH_KIND_ROLES and isEnactmentRole. Orchestration (gaspar),
 * human (PO), builtins, and unknown names are never delegable.
 */
export const DISPATCHABLE_WORKER_ROLES = ["belthazar", "melchior", "prometheus", "lucca"] as const;

export type DispatchableWorkerRole = (typeof DISPATCHABLE_WORKER_ROLES)[number];

/** True only for the four WP execution roles delegable via `task`. */
export function isDispatchableWorkerRole(role: string): role is DispatchableWorkerRole {
  return (DISPATCHABLE_WORKER_ROLES as readonly string[]).includes(role);
}

/**
 * Check an OpenCode tool name against the classification policy.
 * Returns undefined for unlisted (hence denied) tools.
 */
export function classifyOpencodeTool(tool: string): ToolClassification | undefined {
  if (tool.trim().length === 0) {
    return undefined;
  }
  return OPENCODE_TOOL_POLICY[tool];
}

/**
 * Canonical required runtime identifiers [SLICE-9 §9.5]. These are stable
 * integration targets named normatively by the framework — not providers,
 * models, or versions. Adapter ids registered under these names receive
 * runtime-scoped managed assets and entry wiring; all other adapter ids
 * keep the shared baseline and are never guessed into a runtime.
 */
export const KNOWN_RUNTIME_IDS = ["opencode", "claude-code", "kiro"] as const;
export type KnownRuntimeId = (typeof KNOWN_RUNTIME_IDS)[number];

/** True when the adapter id carries a known runtime identity. */
export function isKnownRuntimeId(id: string): id is KnownRuntimeId {
  return (KNOWN_RUNTIME_IDS as readonly string[]).includes(id);
}

/**
 * Check a session-resolved role against a transition event row.
 * BlockerRaised/Resolved are linkage-governed (the blocker record carries
 * the authority); every other event requires its listed role.
 */
export function mayEnactEvent(
  eventType: string,
  kind: "agent" | "po",
  role?: AgentRole
): boolean {
  const row = EVENT_ROLE_ALLOWLIST[eventType];
  if (row === undefined) {
    return false;
  }
  if (kind === "po") {
    return row.includes("PO");
  }
  if (kind === "agent" && role !== undefined) {
    return row.includes(role);
  }
  return false;
}
