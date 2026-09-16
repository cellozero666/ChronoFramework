/**
 * Lifecycle CLI (CORE_FIX CF-6, CF-8): governed status and workflow
 * commands over the Core lifecycle surface. Every command takes the
 * caller identity (--as) with its session credential (--session-token
 * or CHRONO_SESSION_TOKEN); the Core enforces role capabilities and
 * session scope, so workers see only their own binding and scope.
 * Output is ids, states, and reasons — never tokens, keys, or
 * evidence content.
 */

import { ChronoCore } from "@chrono/core";
import { computeRevisionHash } from "@chrono/domain";
import { CHRONO_VERSION } from "./version.js";
import { constructionFailure } from "./project.js";
import { appendDispatchRecord, canonicalDispatchRoot } from "./dispatch-cli.js";
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

/** Session credential from flag or process-local env (never from project files). */
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

export interface LifecycleAuth {
  readonly as: string;
  readonly sessionToken?: string | undefined;
  readonly json?: boolean | undefined;
}

export interface ScopeOptions extends LifecycleAuth {
  readonly module?: string | undefined;
  readonly wp?: string | undefined;
}

function openCore(projectPath: string, asJson: boolean): ChronoCore | CliOutput {
  try {
    return new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
}

function callerAuth(options: LifecycleAuth): { actor: string; session: { id: string; token: string } } | CliOutput {
  if (options.as.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "this command requires --as <actor> matching the caller session" },
      options.json === true
    );
  }
  const session = resolveSessionToken(options.sessionToken);
  if (session === null) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "this command requires --session-token (or CHRONO_SESSION_TOKEN)" },
      options.json === true
    );
  }
  return { actor: options.as, session };
}

function emitOk(value: unknown, lines: string[], asJson: boolean): CliOutput {
  if (asJson) {
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, ...(value as Record<string, unknown>) }, null, 2), stderr: "" };
  }
  return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
}

/** Highest-precedence next action for a module or work package scope. */
export function runNextAction(projectPath: string, options: ScopeOptions): CliOutput {
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
    const result = core.nextAction(
      {
        ...(options.module !== undefined && options.module.length > 0 ? { moduleId: options.module } : {}),
        ...(options.wp !== undefined && options.wp.length > 0 ? { workPackageId: options.wp } : {}),
      },
      auth
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    const lines = [
      `${v.action}: ${v.summary}`,
      `  target: ${v.targetKind} ${v.targetId}`,
      `  reason: ${v.reason}`,
      `  policy: ${v.policyRule}`,
      ...(v.alsoReady !== undefined && v.alsoReady.length > 0 ? [`  also ready: ${v.alsoReady.join(", ")}`] : []),
      ...(v.escalation !== undefined ? [`  ESCALATION: ${v.escalation}`] : []),
    ];
    return emitOk(v, lines, asJson);
  } finally {
    core.close();
  }
}

/** Worker execution projection: own binding, scope states, revision currency. */
export function runAdvance(projectPath: string, options: ScopeOptions): CliOutput {
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
    const result = core.advance(
      {
        ...(options.module !== undefined && options.module.length > 0 ? { moduleId: options.module } : {}),
        ...(options.wp !== undefined && options.wp.length > 0 ? { workPackageId: options.wp } : {}),
      },
      auth
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    const d = v.decision;
    // Human lines name the boundary and its structured routing only.
    // Prose fields travel in JSON for operators; orchestration must
    // switch on decision.type plus the structured ids, never parse them.
    const lines = [
      `decision: ${d.type}`,
      ...(d.type === "PO_DECISION_REQUIRED" ? [`  ceremony: ${d.action} ${d.scopeId} @${d.revision.slice(0, 16)}…`] : []),
      ...(d.type === "AGENT_WORK_REQUIRED" ? [`  work: ${d.phase} ${d.kind} ${d.workPackageId ?? d.moduleId} role=${d.role}`] : []),
      ...(d.type === "INDEPENDENT_REVIEW_REQUIRED" ? [`  review: ${d.kind} ${d.workPackageId ?? d.moduleId} by ${d.role}`] : []),
      ...(d.type === "BLOCKED" ? [`  blocked: ${d.code} owner=${d.owner}`] : []),
      ...(d.type === "COMPLETE" ? [`  complete: ${d.moduleId}`] : []),
      `  trail: ${v.trail.map((t) => t.action).join(", ") || "(none)"}`,
    ];
    return emitOk(v, lines, asJson);
  } finally {
    core.close();
  }
}

/** Worker execution projection: own binding, scope states, revision currency. */
export function runExecutionStatus(projectPath: string, options: ScopeOptions): CliOutput {
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
    const result = core.executionStatus(
      {
        ...(options.module !== undefined && options.module.length > 0 ? { moduleId: options.module } : {}),
        ...(options.wp !== undefined && options.wp.length > 0 ? { workPackageId: options.wp } : {}),
      },
      auth
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    const lines = [
      `module ${v.moduleId} [${v.moduleStatus}] profile=${v.profile}`,
      ...v.packages.map((p) => `  package ${p.workPackageId} [${p.status}] rev ${p.revision.slice(0, 16)}…`),
      ...(v.ownDispatch !== null
        ? [`  binding: ${v.ownDispatch.dispatchId} [${v.ownDispatch.kind}] ${v.ownDispatch.status} role=${v.ownDispatch.role} grant=${v.ownDispatch.grantId ?? "none"}`]
        : ["  binding: none"]),
      ...v.openDispatches
        .filter((d) => v.ownDispatch === null || d.dispatchId !== v.ownDispatch.dispatchId)
        .map((d) => `  open: ${d.dispatchId} [${d.kind}] ${d.status} role=${d.role}`),
    ];
    return emitOk(v, lines, asJson);
  } finally {
    core.close();
  }
}

/** Evidence projection for one content revision (current rows only, no diagnostics). */
export function runEvidenceStatus(
  projectPath: string,
  options: LifecycleAuth & { readonly revision: string }
): CliOutput {
  const asJson = options.json === true;
  const auth = callerAuth(options);
  if ("exitCode" in auth) {
    return auth;
  }
  if (options.revision.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "evidence-status requires --revision <hash>" },
      asJson
    );
  }
  const core = openCore(projectPath, asJson);
  if ("exitCode" in core) {
    return core;
  }
  try {
    const result = core.evidenceStatus({ targetRevision: options.revision }, auth);
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    const lines = [
      `revision ${v.targetRevision.slice(0, 16)}…: ${v.current.length} current, ${v.staleSuperseded} superseded`,
      ...v.current.map((e) => `  ${e.evidenceId} ${e.producer}/${e.check} → ${e.result} @${e.recordedAt}`),
    ];
    return emitOk(v, lines, asJson);
  } finally {
    core.close();
  }
}

/** Deep integrity check (gaspar/PO): cross-record consistency before completion. */
export function runDeepCheck(projectPath: string, options: LifecycleAuth): CliOutput {
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
    const result = core.deepIntegrityCheck(auth);
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    const lines = [
      `deep check @${v.checkedAt}: ${v.blockerCount} blockers, ${v.warningCount} warnings`,
      ...v.findings.map((f) => `  [${f.severity}] ${f.check}: ${f.detail}`),
    ];
    return emitOk(v, lines, asJson);
  } finally {
    core.close();
  }
}

/** Assign a Glenn security review or Spekkio verification (gaspar/PO). */
export function runReviewAssign(
  projectPath: string,
  options: ScopeOptions & { readonly kind: string }
): CliOutput {
  const asJson = options.json === true;
  const auth = callerAuth(options);
  if ("exitCode" in auth) {
    return auth;
  }
  if (options.module === undefined || options.module.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "review-assign requires --module <id>" },
      asJson
    );
  }
  const core = openCore(projectPath, asJson);
  if ("exitCode" in core) {
    return core;
  }
  try {
    const result = core.assignReview(
      {
        kind: options.kind,
        moduleId: options.module,
        ...(options.wp !== undefined && options.wp.length > 0 ? { workPackageId: options.wp } : {}),
      },
      auth
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    return emitOk(v, [`review ${v.reviewId} [${v.kind}] assigned to ${v.reviewerRole}`], asJson);
  } finally {
    core.close();
  }
}

/** Submit an assigned review from the reviewer session (glenn/spekkio). */
export function runReviewComplete(
  projectPath: string,
  options: LifecycleAuth & { readonly review: string }
): CliOutput {
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
    const result = core.completeReview({ reviewId: options.review }, auth);
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    return emitOk(v, [`review ${v.reviewId} submitted (${v.status})`], asJson);
  } finally {
    core.close();
  }
}

/** Open a bounded correction loop for a defect (gaspar/spekkio/PO). */
export function runCorrectionOpen(
  projectPath: string,
  options: LifecycleAuth & { readonly defect: string }
): CliOutput {
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
    const result = core.openCorrectionLoop(options.defect, auth);
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    return emitOk(
      v,
      [`correction loop ${v.loopId} owned by ${v.owner}: attempt ${v.attempt}/${v.maxAttempts}${v.escalated ? " ESCALATED" : ""}`],
      asJson
    );
  } finally {
    core.close();
  }
}

/** Complete a correction loop with evidenced fix (owning role). */
export function runCorrectionComplete(
  projectPath: string,
  options: LifecycleAuth & { readonly loop: string }
): CliOutput {
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
    const result = core.completeCorrectionLoop(options.loop, auth);
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    return emitOk(
      v,
      [`correction loop ${v.loopId} → ${v.status} (invalidated ${v.invalidatedEvidence} stale rows)`],
      asJson
    );
  } finally {
    core.close();
  }
}

/** Calibrate the project rigor profile (gaspar/PO; downgrades need a PO signature). */
export function runPolicySet(
  projectPath: string,
  options: LifecycleAuth & {
    readonly profile: string;
    readonly rationale: string;
    readonly signature?: string | undefined;
    readonly timestamp?: string | undefined;
  }
): CliOutput {
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
    const result = core.setPolicyProfile(
      {
        profile: options.profile,
        rationale: options.rationale,
        ...(options.signature !== undefined ? { signature: options.signature } : {}),
        ...(options.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
      },
      auth
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    return emitOk(v, [`policy profile: ${v.profile}${v.downgraded ? " (signed downgrade)" : ""}`], asJson);
  } finally {
    core.close();
  }
}

/** Show the calibrated rigor profile (public projection, no session needed). */
export function runPolicyStatus(projectPath: string, options: { readonly json?: boolean | undefined }): CliOutput {
  const asJson = options.json === true;
  const core = openCore(projectPath, asJson);
  if ("exitCode" in core) {
    return core;
  }
  try {
    const profile = core.projectProfile();
    const stored = core.describePolicy();
    const value = {
      profile,
      rationale: stored?.rationale ?? "(uncalibrated default)",
      updatedBy: stored?.updatedBy ?? "(none)",
      updatedAt: stored?.updatedAt ?? "(none)",
      signed: stored?.signed ?? false,
    };
    return emitOk(value, [`policy profile: ${profile} — ${value.rationale}`], asJson);
  } finally {
    core.close();
  }
}

/** Split a comma-separated flag into trimmed non-empty entries. */
function csv(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value.split(",").map((e) => e.trim()).filter((e) => e.length > 0);
}

/** Record evidence bound to an exact content revision (producer must equal the caller role). */
export function runEvidenceRecord(
  projectPath: string,
  options: LifecycleAuth & {
    readonly revision: string;
    readonly check: string;
    readonly result: string;
    readonly diagnostics?: string | undefined;
  }
): CliOutput {
  const asJson = options.json === true;
  const auth = callerAuth(options);
  if ("exitCode" in auth) {
    return auth;
  }
  if (options.revision.length === 0 || options.check.length === 0 || options.result.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "evidence-record requires --revision, --check, and --result" },
      asJson
    );
  }
  const core = openCore(projectPath, asJson);
  if ("exitCode" in core) {
    return core;
  }
  try {
    const diagnostics = options.diagnostics ?? null;
    const result = core.recordEvidence(
      {
        producer: auth.actor,
        tool: null,
        targetRevision: options.revision,
        checkName: options.check,
        result: options.result,
        diagnostics,
        integrityHash: computeRevisionHash({
          result: options.result,
          diagnostics,
          target_revision: options.revision,
        }),
      },
      auth
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    return emitOk(result.value!, [`evidence ${result.value!.id} recorded for ${options.revision.slice(0, 16)}…`], asJson);
  } finally {
    core.close();
  }
}

/** Record a defect (Spekkio authority; routes to the responsible owner). */
export function runDefectRecord(
  projectPath: string,
  options: LifecycleAuth & {
    readonly classification: string;
    readonly severity: string;
    readonly evidence?: string | undefined;
    readonly criteria?: string | undefined;
    readonly artifact?: string | undefined;
    readonly blockingScope?: string | undefined;
    readonly repro?: string | undefined;
  }
): CliOutput {
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
    const result = core.recordDefect(
      {
        classification: options.classification,
        severity: options.severity,
        evidenceRefs: csv(options.evidence),
        affectedCriteria: csv(options.criteria),
        affectedArtifacts: csv(options.artifact),
        blockingScope: options.blockingScope !== undefined && options.blockingScope.length > 0
          ? options.blockingScope
          : null,
        reproInfo: options.repro !== undefined && options.repro.length > 0 ? options.repro : null,
      },
      auth
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    return emitOk(result.value!, [`defect ${result.value!.id} recorded`], asJson);
  } finally {
    core.close();
  }
}

/** Record a Spekkio verification verdict (independent authority; nobody else, not even PO). */
export function runVerifyRecord(
  projectPath: string,
  options: LifecycleAuth & {
    readonly module: string;
    readonly verdict: string;
    readonly reviewer: string;
    readonly defects?: string | undefined;
    readonly waivers?: string | undefined;
    readonly evidence?: string | undefined;
    readonly wp?: string | undefined;
  }
): CliOutput {
  const asJson = options.json === true;
  const auth = callerAuth(options);
  if ("exitCode" in auth) {
    return auth;
  }
  if (options.verdict !== "PASS" && options.verdict !== "FAILED" && options.verdict !== "WAIVED") {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "verify-record requires --verdict PASS, FAILED, or WAIVED" },
      asJson
    );
  }
  const core = openCore(projectPath, asJson);
  if ("exitCode" in core) {
    return core;
  }
  try {
    const result = core.recordVerification(
      options.module,
      options.verdict,
      options.reviewer,
      csv(options.defects),
      csv(options.waivers),
      csv(options.evidence),
      auth,
      options.wp !== undefined && options.wp.length > 0 ? options.wp : undefined
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    return emitOk(result.value!, [`verdict ${result.value!.qaId} recorded (${options.verdict})`], asJson);
  } finally {
    core.close();
  }
}

/** Authorize one Work Package for execution (gaspar/PO planning authority). */
export function runWpAuthorize(
  projectPath: string,
  options: LifecycleAuth & { readonly wp: string }
): CliOutput {
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
    const result = core.transitionState(options.wp, "WorkPackageAuthorized", {
      actor: auth.actor,
      session: auth.session,
    });
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    return emitOk(result.value!, [`work package ${options.wp}: ${result.value!.fromState} → ${result.value!.toState}`], asJson);
  } finally {
    core.close();
  }
}

/** Advance a bound scope one legal forward step (the bound worker; kind-gated). */
export function runScopeAdvance(
  projectPath: string,
  options: LifecycleAuth & { readonly module: string; readonly wp?: string | undefined; readonly event: string }
): CliOutput {
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
    const result = core.advanceScope(
      {
        moduleId: options.module,
        ...(options.wp !== undefined && options.wp.length > 0 ? { workPackageId: options.wp } : {}),
        event: options.event,
      },
      auth
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    return emitOk(v, [`${v.scope}: ${v.fromState} → ${v.toState}`], asJson);
  } finally {
    core.close();
  }
}

/** Resolve a defect after its correction loop closed on re-verification (owner or PO). */
export function runDefectResolve(
  projectPath: string,
  options: LifecycleAuth & { readonly defect: string }
): CliOutput {
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
    const result = core.resolveDefect(options.defect, auth);
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    return emitOk(result.value!, [`defect ${result.value!.id} resolved`], asJson);
  } finally {
    core.close();
  }
}

/** Confirm credential confinement for an enacted dispatch (requester or worker session). */
export function runDispatchConfirm(
  projectPath: string,
  options: LifecycleAuth & { readonly dispatch: string }
): CliOutput {
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
    const result = core.confirmClaim(options.dispatch, auth);
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    return emitOk(v, [`dispatch ${v.dispatchId} confirmed (${v.status})`], asJson);
  } finally {
    core.close();
  }
}

/** Release an evidenced binding to COMPLETED (worker) or by oversight (gaspar/PO). */
export function runDispatchRelease(
  projectPath: string,
  options: LifecycleAuth & { readonly dispatch: string }
): CliOutput {
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
    const result = core.releaseDispatch(options.dispatch, auth);
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    return emitOk(v, [`dispatch ${v.dispatchId} released (${v.status})`], asJson);
  } finally {
    core.close();
  }
}

/** Compensating revocation for a failed or abandoned claim (gaspar/PO). */
export function runDispatchRevoke(
  projectPath: string,
  options: LifecycleAuth & { readonly dispatch: string; readonly reason?: string | undefined }
): CliOutput {
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
    const result = core.revokeDispatch(
      options.dispatch,
      auth,
      options.reason !== undefined && options.reason.length > 0 ? options.reason : undefined
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    // Mirror the revocation into the host ledger so the session's
    // intent stops resolving as live (the Core row stays
    // authoritative). A mirror failure denies fail-closed: the Core
    // revoke is idempotent, so retrying converges.
    try {
      appendDispatchRecord(canonicalDispatchRoot(projectPath), {
        v: 1,
        kind: "dispatch-revoked",
        at: new Date().toISOString(),
        dispatchId: options.dispatch,
        reason: options.reason !== undefined && options.reason.length > 0 ? options.reason : null,
      });
    } catch (e) {
      return coreError(
        {
          code: "VALIDATION_ERROR",
          severity: "ERROR",
          message: `dispatch revoked in the Core but the ledger mirror failed: ${e instanceof Error ? e.message : String(e)}`,
        },
        asJson
      );
    }
    const v = result.value!;
    return emitOk(v, [`dispatch ${v.dispatchId} revoked (${v.status})`], asJson);
  } finally {
    core.close();
  }
}

/** Crash-safety sweep: expire stale intents, revoke stale enactments (gaspar/PO). */
export function runDispatchReconcile(projectPath: string, options: LifecycleAuth): CliOutput {
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
    const result = core.reconcileStaleClaims(auth);
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    // Mirror revocations into the host ledger (best-effort; the Core
    // rows stay authoritative and TTL bounds any lag).
    for (const id of v.revoked) {
      try {
        appendDispatchRecord(canonicalDispatchRoot(projectPath), {
          v: 1,
          kind: "dispatch-revoked",
          at: new Date().toISOString(),
          dispatchId: id,
          reason: "stale unconfirmed enactment",
        });
      } catch {
        // Best-effort mirror; reconcile already converged the Core.
      }
    }
    return emitOk(v, [`reconciled: ${v.expired.length} expired, ${v.revoked.length} revoked`], asJson);
  } finally {
    core.close();
  }
}

/** Activate a planned module to APPROVED after both current approvals (gaspar/PO; idempotent replay). */
export function runModuleActivate(
  projectPath: string,
  options: LifecycleAuth & { readonly module: string }
): CliOutput {
  const asJson = options.json === true;
  const auth = callerAuth(options);
  if ("exitCode" in auth) {
    return auth;
  }
  if (options.module.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "module-activate requires --module <id>" },
      asJson
    );
  }
  const core = openCore(projectPath, asJson);
  if ("exitCode" in core) {
    return core;
  }
  try {
    const result = core.activateModule(options.module, auth);
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    return emitOk(
      v,
      [`module ${options.module} → ${v.state}${v.activated ? " (activated)" : " (already active)"}`],
      asJson
    );
  } finally {
    core.close();
  }
}

/** Reconcile a premature review as invalid append-only history (gaspar/PO). */
export function runReviewReconcile(
  projectPath: string,
  options: LifecycleAuth & { readonly review: string }
): CliOutput {
  const asJson = options.json === true;
  const auth = callerAuth(options);
  if ("exitCode" in auth) {
    return auth;
  }
  if (options.review.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "review-reconcile requires --review <id>" },
      asJson
    );
  }
  const core = openCore(projectPath, asJson);
  if ("exitCode" in core) {
    return core;
  }
  try {
    const result = core.reconcileReview({ reviewId: options.review }, auth);
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    return emitOk(v, [`review ${v.reviewId} reconciled (${v.status})`], asJson);
  } finally {
    core.close();
  }
}

/** Complete a module through its completion authorization (idempotent). */
export function runCompleteModule(
  projectPath: string,
  options: LifecycleAuth & { readonly module: string }
): CliOutput {
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
    const result = core.completeModule(options.module, auth);
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    return emitOk(result.value!, [`module ${options.module} → ${result.value!.state}`], asJson);
  } finally {
    core.close();
  }
}
