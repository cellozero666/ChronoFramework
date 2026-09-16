/**
 * Planning-advancement CLI (pilot unblock): the governed native path
 * for the architecture/spec/harness runway that precedes module
 * activation. Every command takes the caller identity (--as) with
 * its session credential (--session-token or CHRONO_SESSION_TOKEN);
 * the Core enforces role capabilities (gaspar/PO planning authority)
 * and revision/approval gates, so denials name the exact unmet
 * prerequisite instead of failing silently. Output is ids, states,
 * and reasons — never tokens, keys, or content.
 *
 * These commands close the missing-transition-surface gap the pilot
 * exposed: registered specs and the architecture previously had no
 * native advancement path (only direct Core calls), so no native
 * workflow could move them to READY/approved.
 */

import { ChronoCore } from "@chrono/core";
import { readFileSync } from "node:fs";
import { CHRONO_VERSION } from "./version.js";
import { constructionFailure } from "./project.js";
import type { CliOutput } from "./dispatch-cli.js";

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

export interface SpecAuth {
  readonly as: string;
  readonly sessionToken?: string | undefined;
  readonly json?: boolean | undefined;
}

function openCore(projectPath: string, asJson: boolean): ChronoCore | CliOutput {
  try {
    return new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
}

function callerAuth(options: SpecAuth): { actor: string; session: { id: string; token: string } } | CliOutput {
  if (options.as.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "this command requires --as <actor> matching the caller session" },
      options.json === true
    );
  }
  const raw = options.sessionToken ?? process.env["CHRONO_SESSION_TOKEN"];
  if (raw === undefined || raw.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "this command requires --session-token (or CHRONO_SESSION_TOKEN)" },
      options.json === true
    );
  }
  const slash = raw.indexOf("/");
  if (slash <= 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "malformed session credential: expected <id>/<token>" },
      options.json === true
    );
  }
  return { actor: options.as, session: { id: raw.slice(0, slash), token: raw.slice(slash + 1) } };
}

function emitOk(value: unknown, lines: string[], asJson: boolean): CliOutput {
  if (asJson) {
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, ...(value as Record<string, unknown>) }, null, 2), stderr: "" };
  }
  return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
}

function enactTransition(
  projectPath: string,
  options: SpecAuth & { readonly spec: string },
  eventType: string,
  verb: string
): CliOutput {
  const asJson = options.json === true;
  const auth = callerAuth(options);
  if ("exitCode" in auth) {
    return auth;
  }
  if (options.spec.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: `${verb} requires --spec <id>` },
      asJson
    );
  }
  const core = openCore(projectPath, asJson);
  if ("exitCode" in core) {
    return core;
  }
  try {
    const result = core.transitionState(options.spec, eventType, { actor: auth.actor, session: auth.session });
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    return emitOk(
      { spec: options.spec, event: eventType, fromState: v.fromState, toState: v.toState },
      [`spec ${options.spec} ${v.fromState} → ${v.toState} (${eventType})`],
      asJson
    );
  } finally {
    core.close();
  }
}

/** Submit the proposed architecture for review (gaspar/PO). */
export function runArchitectureSubmit(projectPath: string, options: SpecAuth): CliOutput {
  const asJson = options.json === true;
  const auth = callerAuth(options);
  if ("exitCode" in auth) {
    return auth;
  }
  const core = openCore(projectPath, asJson);
  if ("exitCode" in core) {
    return core;
  }
  try {
    const result = core.submitArchitectureForReview(auth);
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    return emitOk(
      { revision: result.value, state: "under_review" },
      [`architecture submitted for review at revision ${result.value}`],
      asJson
    );
  } finally {
    core.close();
  }
}

/** Approve the architecture (gaspar/PO; needs a current architecture-security approval). */
export function runArchitectureApprove(projectPath: string, options: SpecAuth): CliOutput {
  const asJson = options.json === true;
  const auth = callerAuth(options);
  if ("exitCode" in auth) {
    return auth;
  }
  const core = openCore(projectPath, asJson);
  if ("exitCode" in core) {
    return core;
  }
  try {
    const result = core.approveArchitecture(auth);
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    return emitOk(
      { revision: result.value, state: "approved" },
      [`architecture approved at revision ${result.value}`],
      asJson
    );
  } finally {
    core.close();
  }
}

/** Submit a DRAFT spec for review (gaspar/PO). */
export function runSpecSubmit(projectPath: string, options: SpecAuth & { readonly spec: string }): CliOutput {
  return enactTransition(projectPath, options, "SpecSubmittedForReview", "spec-submit");
}

/** Release a reviewed spec to READY (gaspar/PO; needs arch-security, harness, unblocked). */
export function runSpecReady(projectPath: string, options: SpecAuth & { readonly spec: string }): CliOutput {
  return enactTransition(projectPath, options, "SpecApprovedReady", "spec-ready");
}

/** Return a spec to DRAFT for revision (gaspar/PO correction loop entry). */
export function runSpecNeedsRevision(projectPath: string, options: SpecAuth & { readonly spec: string }): CliOutput {
  return enactTransition(projectPath, options, "SpecNeedsRevision", "spec-needs-revision");
}

export interface HarnessRecordOptions extends SpecAuth {
  readonly revision: string;
  readonly contentHash: string;
  readonly contentFile?: string | undefined;
  readonly contentText?: string | undefined;
}

/** Record the authoritative Harness for an exact Spec revision (gaspar/PO). */
export function runHarnessRecord(projectPath: string, options: HarnessRecordOptions): CliOutput {
  const asJson = options.json === true;
  const auth = callerAuth(options);
  if ("exitCode" in auth) {
    return auth;
  }
  if (options.revision.length === 0 || options.contentHash.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "harness-record requires --revision <rev> and --content-hash <sha256>" },
      asJson
    );
  }
  const hasFile = options.contentFile !== undefined && options.contentFile.length > 0;
  const hasText = options.contentText !== undefined;
  if (hasFile === hasText) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "harness-record requires exactly one of --content-file or --content-stdin" },
      asJson
    );
  }
  let content: string;
  if (hasFile) {
    try {
      content = readFileSync(options.contentFile as string, "utf8");
    } catch (e) {
      return coreError(
        { code: "VALIDATION_ERROR", severity: "ERROR", message: `harness content unreadable: ${e instanceof Error ? e.message : String(e)}` },
        asJson
      );
    }
  } else {
    content = options.contentText as string;
  }
  const core = openCore(projectPath, asJson);
  if ("exitCode" in core) {
    return core;
  }
  try {
    const result = core.recordHarness(options.revision, options.contentHash, content, auth);
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    return emitOk(
      { id: result.value, specRevision: options.revision },
      [`recorded harness '${result.value}' for spec revision ${options.revision}`],
      asJson
    );
  } finally {
    core.close();
  }
}
