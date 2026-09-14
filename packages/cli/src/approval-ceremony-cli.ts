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

import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
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
  /**
   * Refuse the ticket unless the OpenCode `question` surface is
   * available to the Gaspar agent (verified through
   * `opencode debug agent gaspar`). Prevents tickets that could only
   * wait for expiry because no human boundary can ever confirm them.
   */
  readonly requireQuestion?: boolean | undefined;
  /** Override for the OpenCode binary probe (tests inject a fixture). */
  readonly opencodeBinary?: string | undefined;
}

/**
 * Capability probe: is OpenCode's native `question` tool exposed to
 * the Gaspar agent in this project? Runs `opencode debug agent
 * gaspar` and reads the resolved `tools.question` verdict — the same
 * oracle used during development. Never touches sessions, models, or
 * paid APIs: pure local configuration inspection.
 */
export function checkQuestionSurface(
  projectPath: string,
  opencodeBinary?: string
): { available: boolean | null; reason: string } {
  const binary = opencodeBinary ?? process.env["CHRONO_OPENCODE_BIN"] ?? resolveOpenCodeBinary();
  if (binary === null) {
    return { available: null, reason: "opencode binary not found on PATH: question-surface availability is unknown" };
  }
  let stdout: string;
  try {
    stdout = execFileSync(binary, ["debug", "agent", "gaspar"], {
      encoding: "utf8",
      cwd: projectPath,
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return {
      available: false,
      reason: `opencode debug agent gaspar failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { available: false, reason: "opencode debug agent gaspar returned non-JSON output" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { available: false, reason: "opencode debug agent gaspar returned a non-object document" };
  }
  const tools = (parsed as Record<string, unknown>)["tools"];
  if (typeof tools !== "object" || tools === null) {
    return { available: false, reason: "opencode debug agent gaspar reported no tool table" };
  }
  const question = (tools as Record<string, unknown>)["question"];
  if (question === true) {
    return { available: true, reason: "OpenCode exposes the native question tool to the Gaspar agent" };
  }
  return {
    available: false,
    reason: "OpenCode does not expose the native question tool to the Gaspar agent (tools.question is not true): add `question: allow` to the Gaspar agent permission policy, then re-run",
  };
}

/** Resolve the OpenCode binary for capability probes (PATH lookup). */
export function resolveOpenCodeBinary(): string | null {
  const path = process.env["PATH"] ?? "";
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = join(dir, process.platform === "win32" ? "opencode.exe" : "opencode");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export interface ApprovalRecordOptions {
  readonly ticket: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly permissionCallId: string;
  readonly decidedAt: string;
  /**
   * Exactly-once ceremony binding (required): the Core recomputes
   * the ceremony key from its canonical root plus these components
   * and the ticket row, then claims it atomically inside the
   * finalize transaction. Redelivery is a durable no-op.
   */
  readonly ceremonyKey: string;
  readonly ceremonySession: string;
  readonly ceremonyRequest: string;
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
  if (options.requireQuestion === true) {
    const surface = checkQuestionSurface(projectPath, options.opencodeBinary);
    if (surface.available !== true) {
      return coreError(
        {
          code: "VALIDATION_ERROR",
          severity: "ERROR",
          message: `approval ticket refused: ${surface.reason}`,
        },
        asJson
      );
    }
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
        ceremony: {
          key: options.ceremonyKey,
          sessionId: options.ceremonySession,
          requestId: options.ceremonyRequest,
        },
      },
      { actor: options.as, session }
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    if (asJson) {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          {
            ok: true,
            approvalId: result.value!.approvalId,
            duplicate: result.value!.duplicate,
            aliased: result.value!.aliased,
          },
          null,
          2
        ),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout:
        result.value!.duplicate === true
          ? `Approval ceremony already processed: '${result.value!.approvalId}' (duplicate delivery, no state change)`
          : `Recorded permission-bound approval '${result.value!.approvalId}'`,
      stderr: "",
    };
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
