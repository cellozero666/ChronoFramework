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
export const AUTHORITY_POLICY_VERSION = "2";

export type CapabilityHolder = AgentRole | "PO";

/** Core operations governed by the matrix. */
export type CoreOperation =
  | "artifact.register"
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
  | "session.revoke"
  | "attestation.record"
  | "adapter.register"
  | "adapter.revoke";

const ALL_WORKERS: readonly AgentRole[] = ["belthazar", "melchior", "prometheus"];

/**
 * Allowed identities per operation. `PO` appears by supremacy [I-01]
 * except where verdict independence forbids it (verification.record).
 */
export const ROLE_CAPABILITIES: Record<CoreOperation, readonly CapabilityHolder[]> = {
  "artifact.register": ["gaspar", "PO"],
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
  "session.revoke": ["gaspar", "PO"],
  "attestation.record": ["gaspar", "PO"],
  "adapter.register": ["PO"],
  "adapter.revoke": ["PO"],
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
