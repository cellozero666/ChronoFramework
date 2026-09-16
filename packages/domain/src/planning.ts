/**
 * Core-governed planning/artifact-authoring path (OC-P11).
 *
 * Bootstrap deadlock fixed here: Gaspar must be able to propose and
 * materialize planning artifacts BEFORE any implementation Module/WP
 * exists. `chrono run` execution grants stay reserved for authorized
 * implementation work; this module governs the distinct planning path.
 *
 * Runtime-neutral and model-neutral: no provider/model/runtime concepts,
 * no hardcoded defaults [FW §22]. Every operation is capability-gated
 * (`planning.propose`, `planning.revise`, `planning.status` — Gaspar and
 * PO only) and validated (type, identifier, lifecycle, revision,
 * references, destination, schema, size).
 *
 * Writes are restricted to canonical managed artifact locations under
 * the project root. There is deliberately NO caller-supplied path: the
 * destination derives deterministically from (kind, id), so path
 * traversal, symlinks, arbitrary product-code writes, and writes
 * outside the project are structurally impossible. Model-generated
 * content is untrusted DRAFT/PROPOSED material until validated; chat
 * text never becomes PO authority.
 */

import { createHash } from "node:crypto";
import { ChronoError, ErrorCode, Severity } from "./errors.js";

/** Planning artifact kinds Gaspar may propose before implementation exists. */
export const PLANNING_KINDS = [
  "discovery",
  "requirement",
  "architecture",
  "adr",
  "spec",
  "harness-draft",
  "security-profile",
  "roadmap",
  "module",
  "workpackage",
] as const;

export type PlanningKind = (typeof PLANNING_KINDS)[number];

/** Artifact family backing each kind (null = file + event only, no registry row). */
export const PLANNING_KIND_FAMILY: Record<PlanningKind, string | null> = {
  discovery: "OPEN",
  requirement: "REQ",
  architecture: null,
  adr: "ADR",
  spec: "SP",
  "harness-draft": null,
  "security-profile": "SEC",
  roadmap: null,
  module: "MOD",
  workpackage: "WP",
};

/** Canonical managed directory per kind (project-relative, under .chrono/). */
export const PLANNING_KIND_DIR: Record<PlanningKind, string> = {
  discovery: ".chrono/context",
  requirement: ".chrono/context/requirements",
  architecture: ".chrono/architecture",
  adr: ".chrono/architecture/adr",
  spec: ".chrono/specs",
  "harness-draft": ".chrono/harness",
  "security-profile": ".chrono/security",
  roadmap: ".chrono/roadmap",
  module: ".chrono/roadmap",
  workpackage: ".chrono/roadmap",
};

/** Deterministic filename per kind (id is sanitized before interpolation). */
export function planningFilename(kind: PlanningKind, id: string): string {
  switch (kind) {
    case "discovery":
      return id === "DISCOVERY" ? "DISCOVERY.md" : `${id}.md`;
    case "requirement":
      return `${id}.md`;
    case "architecture":
      return "ARCHITECTURE.md";
    case "adr":
      return `${id}.md`;
    case "spec":
      return `${id}.md`;
    case "harness-draft":
      return `${id}.harness.md`;
    case "security-profile":
      return `${id}.md`;
    case "roadmap":
      return id === "ROADMAP" ? "ROADMAP.md" : `${id}.md`;
    case "module":
      return `${id}.md`;
    case "workpackage":
      return `${id}.md`;
  }
}

/** Content size bounds for model-generated planning material. */
export const PLANNING_MIN_BYTES = 1;
export const PLANNING_MAX_BYTES = 65536;

/** Planned identifier pattern per kind (auto-allocated when omitted). */
const ID_PATTERN: Record<PlanningKind, RegExp> = {
  discovery: /^(DISCOVERY|OPEN-[0-9]{4})$/,
  requirement: /^REQ-[0-9]{4}$/,
  architecture: /^ARCH$/,
  adr: /^ADR-[0-9]{4}$/,
  spec: /^SP-[0-9]{4}$/,
  "harness-draft": /^SP-[0-9]{4}$/,
  "security-profile": /^SEC-[0-9]{4}$/,
  roadmap: /^(ROADMAP|MOD-[0-9]{4})$/,
  module: /^MOD-[0-9]{4}$/,
  workpackage: /^WP-[0-9]{4}$/,
};

/** Family prefix used when the Core auto-allocates an identifier. */
export const PLANNING_ALLOC_FAMILY: Record<PlanningKind, string | null> = {
  discovery: "OPEN",
  requirement: "REQ",
  architecture: null,
  adr: "ADR",
  spec: "SP",
  "harness-draft": null,
  "security-profile": "SEC",
  roadmap: null,
  module: "MOD",
  workpackage: "WP",
};

export function isPlanningKind(value: string): value is PlanningKind {
  return (PLANNING_KINDS as readonly string[]).includes(value);
}

export function assertPlanningKind(kind: string): asserts kind is PlanningKind {
  if (!isPlanningKind(kind)) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: `Unknown planning kind '${kind}': expected one of ${PLANNING_KINDS.join(", ")}`,
      invariantRef: "INV §14.4",
      affectedTarget: kind,
      suggestedAction: "Propose only a permitted planning artifact kind",
    });
  }
}

/** Validate a caller-supplied planning identifier (exact, no normalization). */
export function assertPlanningId(kind: PlanningKind, id: string): void {
  const pattern = ID_PATTERN[kind];
  if (!pattern.test(id)) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: `Invalid ${kind} identifier '${id}': must match ${String(pattern)}`,
      invariantRef: "INV §10.1",
      affectedTarget: id,
      suggestedAction: "Use the canonical identifier for this planning kind",
    });
  }
}

/**
 * Secret patterns that must never be persisted into planning artifacts
 * [INV I-14]. The scan is syntactic and fail-closed: any match denies.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN .*PRIVATE KEY-----/,
  /CHRONO_SESSION_TOKEN/,
  /chrono-gaspar-[^\s"']*\.token/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-(live|test)-[A-Za-z0-9]{8,}/,
];

export function assertNoSecrets(content: string, target: string): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      throw new ChronoError({
        code: ErrorCode.SECRET_DETECTED,
        severity: Severity.ERROR,
        message: `Planning content for '${target}' carries secret material: refusing to persist`,
        invariantRef: "INV §7.9",
        affectedTarget: target,
        suggestedAction: "Remove credentials, keys, and session tokens from the proposed content",
      });
    }
  }
}

/** Validate model-generated planning content (present, bounded, titled). */
export function assertPlanningContent(kind: PlanningKind, title: string, body: string, target: string): void {
  if (title.trim().length === 0) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: `Planning ${kind} '${target}' requires a non-empty title`,
      invariantRef: "INV §14.4",
      affectedTarget: target,
      suggestedAction: "Provide a title describing the proposed artifact",
    });
  }
  if (body.trim().length === 0) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: `Planning ${kind} '${target}' requires a non-blank body`,
      invariantRef: "INV §14.4",
      affectedTarget: target,
      suggestedAction: "Provide the draft content as Markdown",
    });
  }
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes < PLANNING_MIN_BYTES || bytes > PLANNING_MAX_BYTES) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: `Planning ${kind} '${target}' body is ${String(bytes)} bytes: must be within 1 and ${String(PLANNING_MAX_BYTES)} bytes`,
      invariantRef: "INV §14.4",
      affectedTarget: target,
      suggestedAction: "Provide focused planning content within the documented bound",
    });
  }
  assertNoSecrets(`${title}\n${body}`, target);
}

/**
 * Internal/security-state paths that generic read tools must never serve
 * (OC-P11 req 16). Adapters enforce this list; the Core never returns
 * these bytes through planning projections.
 */
export const FORBIDDEN_READ_SUBSTRINGS: readonly string[] = [
  ".chrono/chrono.db",
  ".chrono/broker-account",
  ".chrono/hooks/",
  "chrono-gaspar-",
  ".token",
  "CHRONO_SESSION_TOKEN",
];

/** True when tool input references forbidden internal/security state. */
export function referencesForbiddenState(input: string): boolean {
  return FORBIDDEN_READ_SUBSTRINGS.some((needle) => input.includes(needle));
}

/**
 * Bash commands governed by the planning path (narrow allowlist, OC-P11
 * req 13). A bash invocation whose normalized command starts with one of
 * these prefixes is a governed planning-artifact operation, NOT generic
 * shell access: it still requires an authenticated Gaspar/PO session and
 * passes through the planning capability gate. Everything else stays on
 * the implementation-dispatch path (blocked before dispatch).
 */
export const PLANNING_BASH_PREFIXES: readonly string[] = [
  "chrono artifact propose",
  "chrono artifact revise",
  "chrono artifact status",
  "chrono approval-request",
  "chrono approval-ticket",
  "chrono architecture-submit",
  "chrono architecture-approve",
  "chrono spec-submit",
  "chrono spec-ready",
  "chrono spec-needs-revision",
  "chrono harness-record",
  "chrono discovery record",
  "chrono plan status",
  "chrono status",
  "chrono validate",
  "chrono doctor",
];

/**
 * True when a bash command string is EXACTLY a governed planning
 * operation. Strict: no chaining, piping, substitution, or
 * backgrounding — a planning operation is exactly one chrono
 * invocation. Anything else stays on the implementation-dispatch path.
 */
export function isPlanningBashCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (/[;|&$`\\]/.test(normalized)) {
    return false;
  }
  // A binary path prefix (./bin, absolute) still names the same governed
  // surface: accept a trailing path segment before `chrono`.
  const withoutBinary = normalized.replace(/^([\w\-./\\:]+\/)?chrono(\.exe|\.cmd|\.bat)? /, "chrono ");
  if (withoutBinary === normalized && !normalized.startsWith("chrono ")) {
    return false;
  }
  return PLANNING_BASH_PREFIXES.some(
    (prefix) => withoutBinary === prefix || withoutBinary.startsWith(`${prefix} `),
  );
}

/**
 * Approval-ticket lifetime in seconds (OC-P11 ceremony). A ticket that
 * outlives its window can never authorize signing: finalize denies and
 * Gaspar requests a fresh ticket for the current revision.
 */
export const APPROVAL_TICKET_TTL_SECONDS = 900;

/** Correlation challenge for one approval ticket (not a secret). */
export function approvalChallenge(ticketId: string): string {
  return `approve-${ticketId}`;
}

/**
 * Canonical human-confirmation line Gaspar must include verbatim in the
 * native `question` call for one approval ticket (OC-P11 ceremony).
 * The plugin host acts only when the runtime-delivered question AND its
 * human answer both carry this line's challenge for a live ticket.
 */
export function approvalQuestionLine(input: {
  challenge: string;
  action: string;
  scopeId: string;
  revision: string;
  rationale: string;
}): string {
  return (
    `CHRONO approval ${input.challenge} :: ${input.action} ${input.scopeId} ` +
    `@${input.revision} :: ${input.rationale}`
  );
}

/**
 * True when a runtime-delivered question/answer pair carries the same
 * live challenge in both halves. Matching is exact and case-sensitive;
 * chat text never reaches this check (only tool runtime payloads do).
 */
export function approvalAnswerMatches(questionText: string, answerText: string, challenge: string): boolean {
  if (challenge.trim().length === 0) {
    return false;
  }
  return questionText.includes(challenge) && answerText.includes(challenge);
}

/**
 * Explicit human decision decoded from a runtime-delivered
 * question/answer pair (fail-open fix: `ask()` success is tool
 * permission, never approval).
 *
 * - `"approve"` only when BOTH halves carry the exact challenge AND
 *   the answer reads as approval AND carries no deny/cancel signal;
 * - `"decline"` when either half vetoes (deny/cancel wording) or the
 *   answer lacks approval wording;
 * - `"ignore"` when the challenge is absent from either half
 *   (unrelated question traffic).
 */
export function approvalAnswerDecision(
  questionText: string,
  answerText: string,
  challenge: string
): "approve" | "decline" | "ignore" {
  if (challenge.trim().length === 0) {
    return "ignore";
  }
  const question = String(questionText ?? "");
  const answer = String(answerText ?? "");
  if (!question.includes(challenge) || !answer.includes(challenge)) {
    return "ignore";
  }
  // Veto signals come from the HUMAN answer only: the question itself
  // legitimately carries a Deny option for the human to pick.
  if (/\bdeny\b/i.test(answer) || /\bcancel/i.test(answer)) {
    return "decline";
  }
  if (/\bapprov/i.test(answer)) {
    return "approve";
  }
  return "decline";
}

/**
 * Deterministic canonical JSON (lexicographically sorted keys, UTF-8).
 * Shared algorithm with the Core revision serializer, restricted to
 * plain JSON values: the plugin host uses it to sign approval payloads
 * byte-identically without importing domain code.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("canonicalizeJson: non-finite number");
      }
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalizeJson: unsupported typeof '${typeof value}'`);
  }
}

/**
 * Ceremony provenance judgment for one ApprovalGranted event payload
 * (fail-open fix). Classic interactive approvals carry no ticket
 * marker and are unaffected. Permission-bound approvals are
 * authoritative only with the explicit-answer ceremony marker
 * recorded at the current policy: anything older (including the
 * vulnerable ask()-gated ceremony) fails closed in every gate,
 * validator, and projection, while history stays append-only.
 */
export function permissionBoundApprovalAuthoritative(
  eventPayload: Record<string, unknown>,
  currentPolicyVersion: string
): boolean {
  return approvalGrantsAuthoritative([eventPayload], currentPolicyVersion);
}

/** Explicit-answer ceremony markers, oldest first. */
export const CEREMONY_MARKERS = ["question-answer-v1", "question-answer-v2"] as const;

/** Current explicit-answer ceremony marker (exactly-once repair). */
export const CEREMONY_MARKER_CURRENT = "question-answer-v2";

/**
 * Authority judgment over EVERY ApprovalGranted event payload recorded
 * for one approval id (exactly-once repair).
 *
 * One human Approve authorizes exactly one ceremony for exactly one
 * ticket: when several grant events share an approval id but name
 * DIFFERENT tickets decided by the SAME native observation (one
 * question fanning out over many tickets — the TICKET-0024 class),
 * the approval is NOT authoritative, even when each payload alone
 * carries a valid marker. Genuinely separate ceremonies that alias
 * one pre-existing approval row (distinct tickets, distinct native
 * observations) keep the row authoritative.
 *
 * Classic interactive approvals (no ticket marker) are unaffected.
 * The vulnerable ask()-gated ceremony (no valid marker) stays
 * non-authoritative. History is never rewritten: callers revoke the
 * row append-only when this returns false for fan-out.
 */
export function approvalGrantsAuthoritative(
  grantPayloads: ReadonlyArray<Record<string, unknown>>,
  currentPolicyVersion: string
): boolean {
  if (grantPayloads.length === 0) {
    return false;
  }
  const ticketed = grantPayloads.filter(
    (payload) => payload["ticketId"] !== undefined && payload["ticketId"] !== null
  );
  if (ticketed.length === 0) {
    return true;
  }
  for (const payload of ticketed) {
    const ceremony = payload["ceremony"];
    if (ceremony !== "question-answer-v1" && ceremony !== CEREMONY_MARKER_CURRENT) {
      return false;
    }
    if (payload["policyVersion"] !== currentPolicyVersion) {
      return false;
    }
  }
  const ticketIds = new Set(ticketed.map((payload) => String(payload["ticketId"])));
  if (ticketIds.size <= 1) {
    return true;
  }
  const observations = new Set(
    ticketed.map((payload) => {
      const observation = payload["nativeObservation"];
      if (typeof observation !== "object" || observation === null) {
        return `missing:${String(payload["ticketId"])}`;
      }
      const callId = (observation as Record<string, unknown>)["permissionCallId"];
      return typeof callId === "string" ? callId : `missing:${String(payload["ticketId"])}`;
    })
  );
  return observations.size > 1;
}

/** Components bound by one exactly-once approval ceremony. */
export interface CeremonyBinding {
  readonly project: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly ticketId: string;
  readonly scopeArtifactId: string;
  readonly action: string;
  readonly scopeRevision: string;
}

/**
 * Deterministic ceremony key binding canonical project, runtime
 * session, question/request id, exactly one ticket, scope, action,
 * and revision (exactly-once repair). The Core recomputes this key
 * from its own canonical root plus the presented components and the
 * ticket row, then claims it atomically inside the finalize
 * transaction: redelivery of the same ceremony is a durable no-op,
 * and a different ticket can never share the key. Uses SHA-256 over
 * canonical JSON (Node and the standalone generated plugin bytes
 * share the algorithm; parity is locked by test).
 */
export function buildCeremonyKey(binding: CeremonyBinding): string {
  for (const [name, value] of Object.entries(binding)) {
    if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
      throw new Error(`buildCeremonyKey: invalid ceremony component '${name}'`);
    }
  }
  if (!/^TICKET-[0-9]{4}$/.test(binding.ticketId)) {
    throw new Error("buildCeremonyKey: ticket id is not a well-formed approval ticket");
  }
  return createHash("sha256")
    .update(
      canonicalizeJson({
        action: binding.action,
        project: binding.project,
        requestId: binding.requestId,
        scopeArtifactId: binding.scopeArtifactId,
        scopeRevision: binding.scopeRevision,
        sessionId: binding.sessionId,
        ticketId: binding.ticketId,
      }),
      "utf8"
    )
    .digest("hex");
}

/**
 * Extract a best-effort command string from an OpenCode/Claude/Kiro tool
 * payload for planning classification. Returns null when no command is
 * present (not a shell invocation).
 */
export function extractBashCommand(toolInput: unknown): string | null {
  if (typeof toolInput === "string") {
    return toolInput;
  }
  if (typeof toolInput !== "object" || toolInput === null) {
    return null;
  }
  const record = toolInput as Record<string, unknown>;
  for (const key of ["command", "cmd", "input", "script"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}
