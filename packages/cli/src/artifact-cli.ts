/**
 * Core-governed planning/artifact-authoring CLI (OC-P11).
 *
 * Narrow native tools for Gaspar's bootstrap path — distinct from
 * implementation execution (`chrono run` stays reserved for authorized
 * implementation work). Every command delegates to a Core planning
 * operation; the CLI owns no policy. Results are stable JSON plus
 * human-readable summaries without secrets. Gaspar may present the
 * exact approval ceremony but can never sign, proxy, or claim it:
 * chat text such as "approved" never becomes PO authority.
 */

import { readFileSync } from "node:fs";
import { ChronoCore } from "@chrono/core";
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

export interface ArtifactProposeOptions {
  readonly kind: string;
  readonly id?: string | undefined;
  readonly title: string;
  readonly bodyFile: string;
  readonly references?: string[] | undefined;
  readonly as: string;
  readonly sessionToken?: string | undefined;
  readonly json?: boolean | undefined;
}

export interface ArtifactReviseOptions {
  readonly id: string;
  readonly title: string;
  readonly bodyFile: string;
  readonly as: string;
  readonly sessionToken?: string | undefined;
  readonly json?: boolean | undefined;
}

export interface ArtifactStatusOptions {
  readonly as: string;
  readonly sessionToken?: string | undefined;
  readonly json?: boolean | undefined;
}

function readBodyFile(path: string): { ok: true; body: string } | { ok: false; error: string } {
  try {
    return { ok: true, body: readFileSync(path, "utf8") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Propose and materialize a planning draft through the Core.
 * Gaspar/PO session required; workers denied by the capability matrix.
 */
export function runArtifactPropose(projectPath: string, options: ArtifactProposeOptions): CliOutput {
  const asJson = options.json === true;
  if (options.kind.trim().length === 0 || options.title.trim().length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "artifact propose requires --kind, --title, and --body-file" },
      asJson
    );
  }
  if (options.as.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "artifact propose requires --as <gaspar|PO> matching the caller session" },
      asJson
    );
  }
  const session = resolveSessionToken(options.sessionToken);
  if (session === null) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "artifact propose requires --session-token (or CHRONO_SESSION_TOKEN)" },
      asJson
    );
  }
  const body = readBodyFile(options.bodyFile);
  if (body.ok === false) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: `artifact body unreadable: ${body.error}` },
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
    const result = core.proposePlanningArtifact(
      {
        kind: options.kind,
        ...(options.id !== undefined && options.id.length > 0 ? { id: options.id } : {}),
        title: options.title,
        body: body.body,
        ...(options.references !== undefined ? { references: options.references } : {}),
      },
      { actor: options.as, session }
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    if (asJson) {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          { ok: true, id: v.id, revision: v.revision, path: v.path, approvalCommand: v.approvalCommand },
          null,
          2
        ),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: [
        `Planning draft materialized: ${v.id} @ ${v.revision.slice(0, 16)}…`,
        `  file: ${v.path}`,
        `PO stated approval in chat is NOT registered. Only a successful Core-signed approval counts.`,
        `Request PO approval with exactly:`,
        `  ${v.approvalCommand}`,
      ].join("\n"),
      stderr: "",
    };
  } finally {
    core.close();
  }
}

/** Revise a planning draft to a new revision (prior approvals go stale). */
export function runArtifactRevise(projectPath: string, options: ArtifactReviseOptions): CliOutput {
  const asJson = options.json === true;
  if (options.id.length === 0 || options.title.trim().length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "artifact revise requires --id, --title, and --body-file" },
      asJson
    );
  }
  if (options.as.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "artifact revise requires --as <gaspar|PO> matching the caller session" },
      asJson
    );
  }
  const session = resolveSessionToken(options.sessionToken);
  if (session === null) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "artifact revise requires --session-token (or CHRONO_SESSION_TOKEN)" },
      asJson
    );
  }
  const body = readBodyFile(options.bodyFile);
  if (body.ok === false) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: `artifact body unreadable: ${body.error}` },
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
    const result = core.revisePlanningArtifact(
      options.id,
      { title: options.title, body: body.body },
      { actor: options.as, session }
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    if (asJson) {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          { ok: true, id: v.id, revision: v.revision, path: v.path, approvalCommand: v.approvalCommand },
          null,
          2
        ),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: [
        `Planning draft revised: ${v.id} @ ${v.revision.slice(0, 16)}… (prior approvals are stale)`,
        `  file: ${v.path}`,
        `Request a new PO signature with exactly:`,
        `  ${v.approvalCommand}`,
      ].join("\n"),
      stderr: "",
    };
  } finally {
    core.close();
  }
}

/**
 * Explicit planning status projection: proposed, awaiting PO signature,
 * approved, rejected, stale — from Core-signed rows only, no secrets.
 */
export function runArtifactStatus(projectPath: string, options: ArtifactStatusOptions): CliOutput {
  const asJson = options.json === true;
  if (options.as.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "artifact status requires --as <gaspar|PO> matching the caller session" },
      asJson
    );
  }
  const session = resolveSessionToken(options.sessionToken);
  if (session === null) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "artifact status requires --session-token (or CHRONO_SESSION_TOKEN)" },
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
    const result = core.planningStatus({ actor: options.as, session });
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const items = result.value!.items;
    if (asJson) {
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, items }, null, 2), stderr: "" };
    }
    if (items.length === 0) {
      return { exitCode: 0, stdout: "No planning drafts recorded.", stderr: "" };
    }
    const lines = ["Planning status (Core-signed approvals only; chat text is never authority):"];
    for (const item of items) {
      lines.push(`  - ${item.id} [${item.kind}] ${item.approval} @ ${item.revision.slice(0, 16)}… — ${item.detail}`);
    }
    return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
  } finally {
    core.close();
  }
}


