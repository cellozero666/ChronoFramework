/**
 * State sets and entity types matching docs/domain/STATE-MODEL.md §1 and §3.18-3.28
 * [FW §594-598, P3.9] — No runtime-specific concepts [FW §22]
 */
import { ChronoError, ErrorCode, Severity } from "./errors.js";

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
  | "ARCHITECTURE"
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
  | "lucca"
  | "glenn"
  | "spekkio";

/**
 * Closed identity model [DOM §2.2, Remediation §3A].
 *
 * The seven canonical agent roles, the human PO identity, the Core's own
 * machine identity, and authenticated adapter sessions are DISTINCT
 * concepts. A free-form string MUST NOT erase the closed agent-role set:
 * every identity crossing a trust boundary is parsed by
 * parseActorIdentity, which rejects `luca`, `agent`, case variants, and
 * unknown roles instead of silently normalizing them.
 */
export type HumanIdentity = "PO";
export type SystemIdentity = "system";

export const ADAPTER_SESSION_PATTERN = /^[A-Za-z0-9][\w.-]*:[\w.-]+$/;

export type ActorKind = "agent" | "po" | "system" | "session";

export interface ParsedActor {
  readonly kind: ActorKind;
  readonly identity: string;
  readonly role?: AgentRole;
}

/**
 * Distinct identity concepts [DOM §2.2, Remediation §3A]. Each is a
 * branded string so the type system keeps them apart; constructors
 * validate shape. `ModelIdentity` is deliberately opaque: the Core never
 * reads a model name (policy omits it [DOM §4.4, ADR-001]).
 */
export type AdapterIdentity = string & { readonly __adapter: unique symbol };
export type RuntimeIdentity = string & { readonly __runtime: unique symbol };
export type SessionIdentity = string & { readonly __session: unique symbol };
export type ModelIdentity = string & { readonly __model: unique symbol };
export type ToolIdentity = string & { readonly __tool: unique symbol };

/** An adapter session `<runtime>:<session>` with a validated shape. */
export function toSessionIdentity(value: string): SessionIdentity {
  if (!ADAPTER_SESSION_PATTERN.test(value)) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: `Malformed adapter session '${value}': expected <runtime>:<session>`,
      invariantRef: "INV §14.4",
      affectedTarget: value,
      suggestedAction: "Identify the session as <runtime>:<session>",
    });
  }
  return value as SessionIdentity;
}

/** A runtime name: non-empty, never a session or provider claim. */
export function toRuntimeIdentity(value: string): RuntimeIdentity {
  if (value.trim().length === 0 || value.includes(":")) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: "Runtime identity must be a non-empty name without session parts",
      invariantRef: "INV §14.4",
      suggestedAction: "Configure the PO-selected runtime name",
    });
  }
  return value as RuntimeIdentity;
}

/** A tool name as it appears in evidence: non-empty. */
export function toToolIdentity(value: string): ToolIdentity {
  if (value.trim().length === 0) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: "Tool identity must be non-empty",
      invariantRef: "INV §14.4",
      suggestedAction: "Name the tool that produced the evidence",
    });
  }
  return value as ToolIdentity;
}

export function isAgentRole(value: string): value is AgentRole {
  return (
    value === "gaspar" ||
    value === "belthazar" ||
    value === "melchior" ||
    value === "prometheus" ||
    value === "lucca" ||
    value === "glenn" ||
    value === "spekkio"
  );
}

export function isAdapterSession(value: string): boolean {
  return ADAPTER_SESSION_PATTERN.test(value);
}

/**
 * Parse and authenticate an identity string [RUNTIME §2, Remediation §3A].
 * Accepts exactly: the seven canonical roles, `PO`, the Core machine
 * identity `system`, and `<runtime>:<session>` adapter sessions.
 * Everything else — including `luca`, `agent`, case variants, and empty
 * strings — is rejected, never normalized.
 */
export function parseActorIdentity(actor: unknown): ParsedActor {
  if (typeof actor !== "string" || actor.length === 0) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: "Missing actor identity: protected operations require an explicit identity",
      invariantRef: "INV §14.4",
      suggestedAction: "Pass a canonical role, PO, or <runtime>:<session>",
    });
  }
  if (isAgentRole(actor)) {
    return { kind: "agent", identity: actor, role: actor };
  }
  if (actor === "PO") {
    return { kind: "po", identity: actor };
  }
  if (actor === "system") {
    return { kind: "system", identity: actor };
  }
  if (isAdapterSession(actor)) {
    return { kind: "session", identity: actor };
  }
  throw new ChronoError({
    code: ErrorCode.VALIDATION_ERROR,
    severity: Severity.ERROR,
    message: `Unknown actor identity '${actor}': not a canonical role, PO, or adapter session`,
    invariantRef: "INV §14.4",
    affectedTarget: actor,
    suggestedAction: "Use gaspar, belthazar, melchior, prometheus, lucca, glenn, spekkio, PO, or <runtime>:<session>",
  });
}

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
  ARCHITECTURE: ["proposed", "under_review", "approved", "superseded"],
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
