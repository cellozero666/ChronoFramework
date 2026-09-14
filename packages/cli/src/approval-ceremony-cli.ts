/**
 * Integrated approval ceremony CLI (OC-P11 req 5, ADR-007).
 *
 * - `approval-request`: Gaspar/PO session creates a single-use ticket
 *   binding action, scope, exact current revision, rationale, and
 *   security implications. The ticket authorizes nothing by itself.
 * - `approval-record`: records a permission-bound approval from a
 *   pre-made Ed25519 signature. The signature is the unforgeable proof:
 *   called without a valid PO signature it denies, so model invocation
 *   without the human-gated host signing step can never approve.
 * - `approval-ticket`: safe ticket projection for host re-validation
 *   (no secrets; tickets carry none).
 *
 * Key material NEVER travels through these commands: signing happens
 * in the plugin host (which reads the OS keychain after observing the
 * native human confirmation), and only the signature crosses here.
 */

import { ChronoCore } from "@chrono/core";
import { approvalChallenge } from "@chrono/domain";
import { CHRONO_VERSION } from "./version.js";
import { constructionFailure } from "./project.js";

export interface CliOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Session token from flag or process-local env (never from project files). */
function resolveSessionToken(explicit?: string): { id: string; token: string } | null {
  const raw = explicit ?? process.env["CHRONO_SESSION_TOKEN"];
  if (raw === undefined || raw.length === 0) {
    return null;
  }
  const slash = raw.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  return { id: raw.slice(0, slash), token: raw.slice(slash + 1) };
}

function coreError(
  error:
    | {
        code: string;
        severity: string;
        message: string;
        invariantRef?: string | undefined;
        affectedTarget?: string | undefined;
        suggestedAction?: string | undefined;
      }
    | undefined,
  asJson: boolean
): CliOutput {
  const body = asJson
    ? JSON.stringify({ ok: false, error }, null, 2)
    : [
        `Error [${error?.code ?? "UNKNOWN"}] (${error?.severity ?? "ERROR"}): ${error?.message ?? "Operation failed"}`,
        ...(error?.invariantRef !== undefined ? [`  invariant: ${error.invariantRef}`] : []),
        ...(error?.affectedTarget !== undefined ? [`  target: ${error.affectedTarget}`] : []),
        ...(error?.suggestedAction !== undefined ? [`  suggested action: ${error.suggestedAction}`] : []),
      ].join("\n");
  return asJson
    ? { exitCode: 1, stdout: body, stderr: "" }
    : { exitCode: 1, stdout: "", stderr: body };
}

export interface ApprovalRequestOptions {
  readonly action: string;
  readonly scope: string;
  readonly revision: string;
  readonly rationale: string;
  readonly securityImplications: string;
  readonly as: string;
  readonly sessionToken?: string | undefined;
  readonly json?: boolean | undefined;
}

export interface ApprovalRecordOptions {
  readonly ticket: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly permissionCallId: string;
  readonly decidedAt: string;
  readonly as: string;
  readonly sessionToken?: string | undefined;
  readonly json?: boolean | undefined;
}

export interface ApprovalTicketOptions {
  readonly ticket: string;
  readonly as: string;
  readonly sessionToken?: string | undefined;
  readonly json?: boolean | undefined;
}

/** Request a single-use approval ticket (planning path, Gaspar/PO). */
export function runApprovalRequest(projectPath: string, options: ApprovalRequestOptions): CliOutput {
  const asJson = options.json === true;
  if (options.as.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "approval-request requires --as <gaspar|PO> matching the caller session" },
      asJson
    );
  }
  const session = resolveSessionToken(options.sessionToken);
  if (session === null) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "approval-request requires --session-token (or CHRONO_SESSION_TOKEN)" },
      asJson
    );
  }
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const result = core.requestApprovalTicket(
      {
        action: options.action,
        scopeArtifactId: options.scope,
        scopeRevision: options.revision,
        rationale: options.rationale,
        securityImplications: options.securityImplications,
      },
      { actor: options.as, session }
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    if (asJson) {
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, ...v }, null, 2), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: [
        `Approval ticket issued: ${v.ticketId} (expires ${v.expiresAt})`,
        `Human confirmation challenge: ${v.challenge}`,
        `Ask the Product Owner through the native question tool with the exact challenge line, then finalize only from the observed human answer.`,
      ].join("\n"),
      stderr: "",
    };
  } finally {
    core.close();
  }
}

/**
 * Record a permission-bound approval from a host-made signature.
 * Without a valid PO signature this denies — model invocation alone
 * can never approve.
 */
export function runApprovalRecord(projectPath: string, options: ApprovalRecordOptions): CliOutput {
  const asJson = options.json === true;
  if (options.as.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "approval-record requires --as <gaspar|PO> matching the caller session" },
      asJson
    );
  }
  const session = resolveSessionToken(options.sessionToken);
  if (session === null) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "approval-record requires --session-token (or CHRONO_SESSION_TOKEN)" },
      asJson
    );
  }
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const result = core.finalizeApprovalTicket(
      {
        ticketId: options.ticket,
        timestamp: options.timestamp,
        signature: options.signature,
        observation: {
          permissionCallId: options.permissionCallId,
          decidedAt: options.decidedAt,
          autoModeProbed: true,
        },
      },
      { actor: options.as, session }
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    if (asJson) {
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, approvalId: result.value!.approvalId }, null, 2), stderr: "" };
    }
    return { exitCode: 0, stdout: `Recorded permission-bound approval '${result.value!.approvalId}'`, stderr: "" };
  } finally {
    core.close();
  }
}

/** Safe ticket projection for host re-validation (no secrets). */
export function runApprovalTicket(projectPath: string, options: ApprovalTicketOptions): CliOutput {
  const asJson = options.json === true;
  if (options.as.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "approval-ticket requires --as <gaspar|PO> matching the caller session" },
      asJson
    );
  }
  const session = resolveSessionToken(options.sessionToken);
  if (session === null) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "approval-ticket requires --session-token (or CHRONO_SESSION_TOKEN)" },
      asJson
    );
  }
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const result = core.describeApprovalTicket(options.ticket, { actor: options.as, session });
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    if (asJson) {
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, ...result.value }, null, 2), stderr: "" };
    }
    const v = result.value!;
    return {
      exitCode: 0,
      stdout: [
        `ticket: ${v.id} [${v.action}] ${v.scopeArtifactId}@${v.scopeRevision.slice(0, 16)}…`,
        `challenge: ${v.challenge}`,
        `live: ${String(v.live)} (consumed: ${String(v.consumed)}, expires: ${v.expiresAt})`,
      ].join("\n"),
      stderr: "",
    };
  } finally {
    core.close();
  }
}

export { approvalChallenge };
