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
 * for an operation, is denied. Adapter sessions may act only where the row
 * explicitly includes "session", and only under an assigned role enforced
 * by adapters (Phase 5 maps sessions to real runtime definitions).
 * No runtime-specific concepts [FW §22].
 */

import type { AgentRole } from "./state.js";

/** Version of this authority policy, persisted with authorization evidence. */
export const AUTHORITY_POLICY_VERSION = "1";

export type CapabilityHolder = AgentRole | "PO" | "session";

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
  | "completion.request";

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
  "evidence.record": ["gaspar", "belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio", "PO", "session"],
  "defect.record": ["spekkio", "PO"],
  "verification.record": ["spekkio"],
  "blocker.raise": ["gaspar", "belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio", "PO", "session"],
  "blocker.resolve": ["gaspar", "belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio", "PO", "session"],
  "waiver.expire": ["gaspar", "PO"],
  "execution.request": ["gaspar", "PO", "session"],
  "completion.request": ["gaspar", "spekkio", "PO", "session"],
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
  ExecutionStarted: [...ALL_WORKERS, "gaspar", "PO", "session"],
  ImplementationComplete: [...ALL_WORKERS, "gaspar", "PO", "session"],
  SpekkioPassed: ["spekkio", "gaspar", "PO"],
  SpekkioFailed: ["spekkio", "gaspar", "PO"],
  CorrectionComplete: [...ALL_WORKERS, "gaspar", "PO", "session"],
  ChangeControlInitiated: ["gaspar", "PO"],
  DefinitionOfDoneSatisfied: ["gaspar", "PO"],
  WorkPackageAuthorized: ["gaspar", "PO"],
  ExecutionAssigned: [...ALL_WORKERS, "gaspar", "PO", "session"],
  ImplementationDone: [...ALL_WORKERS, "gaspar", "PO", "session"],
  VerificationReady: [...ALL_WORKERS, "gaspar", "PO", "session"],
  ArchitectureReviewed: ["gaspar", "PO"],
  ArchitectureSecurityApproved: ["gaspar", "PO"],
};

/**
 * Check an authenticated identity against a capability row.
 * PO passes by supremacy wherever listed; sessions pass only where the
 * row includes "session"; the machine identity never authorizes.
 */
export function isCapable(
  operation: CoreOperation,
  kind: "agent" | "po" | "session" | "system",
  role?: AgentRole
): boolean {
  const row = ROLE_CAPABILITIES[operation];
  if (row === undefined) {
    return false;
  }
  if (kind === "po") {
    return row.includes("PO");
  }
  if (kind === "session") {
    return row.includes("session");
  }
  if (kind === "agent" && role !== undefined) {
    return row.includes(role);
  }
  return false;
}

/** Check an authenticated identity against a transition event row. */
export function mayEnactEvent(
  eventType: string,
  kind: "agent" | "po" | "session" | "system",
  role?: AgentRole
): boolean {
  if (eventType === "BlockerRaised" || eventType === "BlockerResolved") {
    // Linkage-governed: any authenticated identity may request; the
    // blocker record carries the authority.
    return kind === "agent" || kind === "po" || kind === "session";
  }
  const row = EVENT_ROLE_ALLOWLIST[eventType];
  if (row === undefined) {
    return false;
  }
  if (kind === "po") {
    return row.includes("PO");
  }
  if (kind === "session") {
    return row.includes("session");
  }
  if (kind === "agent" && role !== undefined) {
    return row.includes(role);
  }
  return false;
}
