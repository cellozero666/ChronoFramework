/**
 * Setup state machine for `chrono init` orchestration [SLICE-10 §3.3].
 *
 * The ordered step chain is the resumable backbone of first-run setup:
 * every step is idempotent, independently verifiable, and either atomic
 * or compensatable. Advance is same-step or exactly-next-step (no
 * skip-ahead). Progress persists (non-secret only) so a crash,
 * cancellation, or failed external command leaves a deterministic resume
 * point instead of duplicate identities, approvals, adapters, sessions,
 * hooks, or audit events. No runtime-specific concepts [FW §22].
 */

/** Ordered setup steps; forward-only with same-step re-entry for retry. */
export const SETUP_STEPS = [
  "DETECTED",
  "CONSENTED",
  "PROJECT_INITIALIZED",
  "PO_ENROLLED",
  "RUNTIMES_SELECTED",
  "RTK_VERIFIED_AND_ROUTED",
  "SKILL_VERIFIED_AND_EMITTED",
  "ADAPTERS_REGISTERED_AND_APPROVED",
  "NATIVE_HOOKS_INSTALLED",
  "RUNTIME_CONFORMANCE_PASSED",
  "GASPAR_ENTRY_PREPARED",
  "READY",
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

/** Position of a step in the chain, or -1 for unknown steps. */
export function setupStepIndex(step: string): number {
  return (SETUP_STEPS as readonly string[]).indexOf(step);
}

/** True when `next` is a legal advance from `current`: same step
 * (idempotent retry) or exactly the next step. Skip-ahead is denied so no
 * step can be marked complete without performing it. */
export function isLegalSetupAdvance(current: string | null, next: SetupStep): boolean {
  if (current === null) {
    return next === "DETECTED";
  }
  const from = setupStepIndex(current);
  if (from < 0) {
    return false;
  }
  const to = setupStepIndex(next);
  return to === from || to === from + 1;
}

/** Bounded lifetime for broker-minted Gaspar sessions (30 minutes). */
export const BROKER_SESSION_TTL_SECONDS = 1800;

/**
 * Sliding session renewal: an authenticated call landing inside this
 * window before expiry extends the session by its original TTL, so
 * active work never dies mid-flight (entry sessions included).
 * Renewal is hard-capped by SESSION_MAX_LIFETIME_SECONDS: activity
 * prolongs, never immortalizes. Expired or revoked sessions never
 * renew — re-entry mints a fresh session.
 */
export const SESSION_RENEW_WINDOW_SECONDS = 600;

/** Absolute session lifetime cap from issuance (30 days). */
export const SESSION_MAX_LIFETIME_SECONDS = 2592000;

/** Required opening behavior per persisted project state [SLICE-10 §5.3]. */
export const GASPAR_ENTRY_ACTIONS: Record<string, { key: string; summary: string }> = {
  UNINITIALIZED: { key: "begin-discovery", summary: "Explain CHRONO/PO authority briefly and begin adaptive product discovery." },
  ANALYZING: { key: "resume-discovery", summary: "Resume unanswered discovery topics without repeating accepted answers." },
  ARCHITECTING: { key: "continue-architecture", summary: "Summarize current constraints/decisions and continue architecture work or request the exact PO decision." },
  SPECIFYING: { key: "resume-specs", summary: "Resume the affected Specs/Harnesses and expose missing acceptance or security information." },
  PLANNING: { key: "present-approvals", summary: "Present dependency-ready work, blockers, and approvals needed; do not execute prematurely." },
  EXECUTING: { key: "resume-coordination", summary: "Resume coordination from persisted grants/work packages; never assume a prior conversational handoff." },
  VERIFYING: { key: "route-evidence", summary: "Route current evidence to Lucca, Glenn, and Spekkio under their authority rules." },
  BLOCKED: { key: "explain-blocker", summary: "Explain the blocking predicate, responsible authority, evidence, and safe next action." },
  COMPLETE: { key: "await-change-request", summary: "Present the verified state and wait for an explicit change request; do not restart discovery." },
};

/** Deterministic Gaspar entry projection (data only, no prose) [§5.3]. */
export interface GasparEntryProjection {
  readonly projectState: string;
  readonly language: string;
  readonly gasparAutonomy: string;
  readonly runtime: string | null;
  readonly specCount: number;
  readonly moduleCount: number;
  readonly activeBlockers: number;
  readonly blockers: ReadonlyArray<{ id: string; type: string; reason: string }>;
  readonly awaitingApprovalModules: string[];
  readonly architectureSecurityPending: boolean;
  readonly requiredDecisions: string[];
  readonly nextAction: { key: string; summary: string };
}
