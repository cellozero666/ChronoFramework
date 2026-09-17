/**
 * Native governed dispatch CLI (post-planning deadlock repair).
 *
 * After planning approvals are current, Gaspar must initiate
 * Core-authorized dispatch entirely inside OpenCode — no shell, no
 * exported tokens, no PO terminal action. Two host-side commands back
 * the native tools:
 *
 * - `dispatch-request` (Gaspar session): validates every dispatch
 *   gate through `Core.requestDispatch` and records an intent in the
 *   append-only project ledger. Returns ids, revisions, and roles —
 *   never tokens or grants.
 * - `dispatch-claim` (worker subagent session, NO caller session
 *   flags): resolves the Gaspar credential host-side from the ledger,
 *   mints the delegated worker session, runs full
 *   `Core.authorizeExecution`, confines the worker credential to a
 *   0600 file keyed by the worker's OpenCode session, and records the
 *   binding. The model supplies only the dispatch id; its OpenCode
 *   session id and agent name arrive from ToolContext, never from
 *   model text.
 *
 * Key material NEVER travels through these commands in either
 * direction: the worker token is written host-side and read back
 * host-side by the pre-tool gate.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ChronoCore } from "@chrono/core";
import { DISPATCH_KIND_ROLES, isEnactmentRole, isRoleForDispatchKind } from "@chrono/domain";
import { CHRONO_VERSION } from "./version.js";
import { constructionFailure } from "./project.js";

export interface CliOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Append-only host ledger of dispatch intents, delegations, claims. */
export const DISPATCH_LEDGER_RELATIVE = ".chrono/opencode-dispatch.jsonl";

/** Dispatch intents live one hour: bounded, human-paced, never stale grants. */
export const DISPATCH_INTENT_TTL_MS = 3600_000;

/** Max rationale length enforced end to end (model-supplied text). */
export const DISPATCH_RATIONALE_MAX = 500;

const WORKER_TOKEN_PREFIX = "chrono-gaspar-host-";
const WORKER_TOKEN_SUFFIX = ".token";
const CLAIM_LOCK_TTL_MS = 60_000;

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

/** Canonical project root (same normalization the plugin host uses). */
export function canonicalDispatchRoot(projectPath: string): string {
  try {
    return realpathSync(projectPath);
  } catch {
    return projectPath;
  }
}

function sha16(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * Host-only session token path (byte-parity with the generated plugin
 * and native tool bytes: sha16(root|sessionKey), 0600, tmpdir).
 * Parity-locked by test — the gate, the tools, and this CLI must
 * agree or credentials orphan.
 */
export function dispatchHostTokenPath(root: string, sessionKey: string): string {
  return join(tmpdir(), `${WORKER_TOKEN_PREFIX}${sha16(`${root}|${sessionKey}`)}${WORKER_TOKEN_SUFFIX}`);
}

function readHostToken(root: string, sessionKey: string): { id: string; token: string } | null {
  let raw = "";
  try {
    raw = readFileSync(dispatchHostTokenPath(canonicalDispatchRoot(root), sessionKey), "utf8").trim();
  } catch {
    return null;
  }
  const slash = raw.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  return { id: raw.slice(0, slash), token: raw.slice(slash + 1) };
}

export interface DispatchIntentRecord {
  readonly v: 1;
  readonly kind: "dispatch-requested";
  readonly at: string;
  readonly dispatchId: string;
  readonly module: string;
  readonly wp: string | null;
  /** Validated dispatch kind (implementation default for pre-kind ledger rows). Drives kind-fit delegation. */
  readonly dispatchKind?: string | undefined;
  readonly rationale: string;
  readonly requesterCoreSession: string;
  readonly requestedBy: string;
  readonly gasparSessionKey: string | null;
  readonly moduleRevision: string;
  readonly workPackageRevision: string | null;
  readonly specRevisions: Record<string, string>;
  readonly expiresAt: string;
}

export interface DispatchClaimRecord {
  readonly v: 1;
  readonly kind: "dispatch-claimed";
  readonly at: string;
  readonly dispatchId: string;
  readonly workerSessionKey: string;
  readonly workerCoreSession: string;
  readonly grantId: string;
  readonly role: string;
}

export interface TaskDelegationRecord {
  readonly v: 1;
  readonly kind: "task-delegated";
  readonly at: string;
  readonly dispatchId: string;
  readonly parentSessionKey: string;
  readonly agent: string;
}

/**
 * Revocation marker: the Core revoked this dispatch (compensating or
 * reconcile revocation). The ledger intent stops resolving as live so
 * the session can delegate again without waiting out intent TTL; the
 * Core row stays authoritative and denies any late claim or replay.
 */
export interface DispatchRevokedRecord {
  readonly v: 1;
  readonly kind: "dispatch-revoked";
  readonly at: string;
  readonly dispatchId: string;
  readonly reason: string | null;
}

export type DispatchLedgerRecord = DispatchIntentRecord | DispatchClaimRecord | TaskDelegationRecord | DispatchRevokedRecord;

/** Append one record (single syscall-ish; human-paced traffic only). */
export function appendDispatchRecord(projectRoot: string, record: DispatchLedgerRecord): void {
  const path = join(canonicalDispatchRoot(projectRoot), DISPATCH_LEDGER_RELATIVE);
  mkdirSync(join(canonicalDispatchRoot(projectRoot), ".chrono"), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

/** Read the ledger; missing file reads empty, corrupt lines are skipped. */
export function readDispatchLedger(projectRoot: string): DispatchLedgerRecord[] {
  let raw: string;
  try {
    raw = readFileSync(join(canonicalDispatchRoot(projectRoot), DISPATCH_LEDGER_RELATIVE), "utf8");
  } catch {
    return [];
  }
  const records: DispatchLedgerRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as DispatchLedgerRecord;
      if (parsed !== null && typeof parsed === "object" && parsed.v === 1 && typeof parsed.kind === "string") {
        records.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return records;
}

/** Live intent: requested, unexpired, unclaimed, unrevoked. Corrupt ledger reads as absent (fail closed). */
export function findLiveIntent(
  records: readonly DispatchLedgerRecord[],
  dispatchId: string,
  nowMs: number
): { intent: DispatchIntentRecord; claimed: DispatchClaimRecord | null } | null {
  let intent: DispatchIntentRecord | null = null;
  for (const record of records) {
    if (record.kind === "dispatch-requested" && record.dispatchId === dispatchId) {
      intent = record;
    }
  }
  if (intent === null) {
    return null;
  }
  if (Number.isNaN(Date.parse(intent.expiresAt)) || Date.parse(intent.expiresAt) <= nowMs) {
    return null;
  }
  for (const record of records) {
    if (record.kind === "dispatch-revoked" && record.dispatchId === dispatchId) {
      return null;
    }
  }
  for (const record of records) {
    if (record.kind === "dispatch-claimed" && record.dispatchId === dispatchId) {
      return { intent, claimed: record };
    }
  }
  return { intent, claimed: null };
}

/** Latest unclaimed, unexpired, unrevoked intent for one Gaspar OpenCode session (null gaspar keys never match). */
export function findSessionIntent(
  records: readonly DispatchLedgerRecord[],
  gasparSessionKey: string,
  nowMs: number
): DispatchIntentRecord[] {
  const settled = new Set(
    records
      .filter((r) => r.kind === "dispatch-claimed" || r.kind === "dispatch-revoked")
      .map((r) => (r as DispatchClaimRecord | DispatchRevokedRecord).dispatchId)
  );
  return records.filter(
    (r): r is DispatchIntentRecord =>
      r.kind === "dispatch-requested" &&
      r.gasparSessionKey !== null &&
      r.gasparSessionKey === gasparSessionKey &&
      !Number.isNaN(Date.parse(r.expiresAt)) &&
      Date.parse(r.expiresAt) > nowMs &&
      !settled.has(r.dispatchId)
  );
}

export interface TaskCheckOptions {
  readonly session: string;
  readonly agent: string;
  readonly taskId?: string | undefined;
  readonly json?: boolean | undefined;
}

/**
 * Delegation decision for one native `task` call (single source of
 * truth; the plugin enforces the verdict, never its own parse).
 * Allows exactly: a resume of the caller's own claimed worker
 * session, or one live unclaimed dispatch for the caller session
 * with an exact dispatchable worker role. Records the delegation
 * durably so the later claim binds to it. Everything else denies
 * with the exact reason: unknown agents, builtins, gaspar/PO/
 * verification targets, worker callers, missing or ambiguous
 * intents, expired or claimed dispatches, and session hijack.
 */
export function runDispatchTaskCheck(projectPath: string, options: TaskCheckOptions): CliOutput {
  const asJson = options.json === true;
  if (options.session.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "task check requires the calling OpenCode session" },
      asJson
    );
  }
  if (!isEnactmentRole(options.agent)) {
    return coreError(
      {
        code: "TASK_DENIED",
        severity: "BLOCKER",
        message: `Delegation to '${options.agent || "(unnamed)"}' is denied: task delegates only to an enactment role (belthazar, melchior, prometheus, lucca, glenn, spekkio) through a live dispatch of a fitting kind`,
      },
      asJson
    );
  }
  const nowMs = Date.now();
  const records = readDispatchLedger(projectPath);
  // Resume path: re-entering the caller's own claimed worker session.
  if (options.taskId !== undefined && options.taskId.length > 0) {
    const claim = records.find(
      (r): r is DispatchClaimRecord => r.kind === "dispatch-claimed" && r.workerSessionKey === options.taskId
    );
    const intent = claim === undefined
      ? null
      : records.find((r): r is DispatchIntentRecord => r.kind === "dispatch-requested" && r.dispatchId === claim.dispatchId) ?? null;
    if (
      claim !== undefined &&
      intent !== null &&
      intent.gasparSessionKey === options.session &&
      claim.role === options.agent &&
      !Number.isNaN(Date.parse(intent.expiresAt)) &&
      Date.parse(intent.expiresAt) > nowMs
    ) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, dispatchId: intent.dispatchId, resume: true }, null, 2),
        stderr: "",
      };
    }
    return coreError(
      {
        code: "TASK_DENIED",
        severity: "BLOCKER",
        message: "Resuming that task is denied: it is not the caller's own live dispatched worker session",
      },
      asJson
    );
  }
  const live = findSessionIntent(records, options.session, nowMs);
  if (live.length === 0) {
    return coreError(
      {
        code: "TASK_DENIED",
        severity: "BLOCKER",
        message: "No live dispatch intent for this session: validate one first with chrono_dispatch, then delegate exactly one worker",
      },
      asJson
    );
  }
  if (live.length > 1) {
    return coreError(
      {
        code: "TASK_DENIED",
        severity: "BLOCKER",
        message: "Several live dispatch intents for this session: delegation cannot choose between them — let all but one expire or claim, then delegate once",
      },
      asJson
    );
  }
  const intent = live[0]!;
  // Kind fit: reviewers enact only review kinds, test only test, and
  // so on. The Core re-checks against its own row; this names the
  // exact mismatch early (glenn needs a security-review dispatch,
  // spekkio a verification dispatch).
  const intentKind = intent.dispatchKind ?? "implementation";
  if (!isRoleForDispatchKind(intentKind, options.agent)) {
    const fitting = (DISPATCH_KIND_ROLES as Record<string, readonly string[]>)[intentKind] ?? [];
    return coreError(
      {
        code: "TASK_DENIED",
        severity: "BLOCKER",
        message: `Role '${options.agent}' cannot enact '${intentKind}' dispatch '${intent.dispatchId}': that kind authorizes ${fitting.length > 0 ? fitting.join(", ") : "(no role)"}`,
      },
      asJson
    );
  }
  // Bind the delegation in the Core FIRST: the claim gate reads the
  // Core row (single delegation per dispatch), the file ledger is
  // only the host-side mirror. Core call is idempotent for the same
  // parent session + agent, so retries converge.
  if (intent.gasparSessionKey === null) {
    return coreError(
      {
        code: "TASK_DENIED",
        severity: "BLOCKER",
        message: "Dispatch intent carries no requesting session binding: dispatch again through the native tool",
      },
      asJson
    );
  }
  const delegatorToken = readHostToken(projectPath, intent.gasparSessionKey);
  if (delegatorToken === null) {
    return coreError(
      {
        code: "TASK_DENIED",
        severity: "BLOCKER",
        message: "Requesting entry session expired or missing: reopen OpenCode so entry redeems, then dispatch again",
      },
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
    const bound = core.recordTaskDelegation(
      { agent: options.agent, parentRuntimeSession: options.session },
      { actor: intent.requestedBy, session: delegatorToken }
    );
    if (!bound.ok) {
      return coreError(bound.error, asJson);
    }
    if (bound.value!.dispatchId !== intent.dispatchId) {
      return coreError(
        {
          code: "TASK_DENIED",
          severity: "BLOCKER",
          message: `Core delegation bound '${bound.value!.dispatchId}', ledger intent is '${intent.dispatchId}': state diverged, dispatch again`,
        },
        asJson
      );
    }
  } finally {
    core.close();
  }
  const record: TaskDelegationRecord = {
    v: 1,
    kind: "task-delegated",
    at: new Date(nowMs).toISOString(),
    dispatchId: intent.dispatchId,
    parentSessionKey: options.session,
    agent: options.agent,
  };
  try {
    appendDispatchRecord(projectPath, record);
  } catch (e) {
    return coreError(
      {
        code: "TASK_DENIED",
        severity: "BLOCKER",
        message: `delegation validated but not recorded: ${e instanceof Error ? e.message : String(e)}`,
      },
      asJson
    );
  }
  return {
    exitCode: 0,
    stdout: JSON.stringify({ ok: true, dispatchId: intent.dispatchId, resume: false }, null, 2),
    stderr: "",
  };
}

/** Claim mutex per dispatch (atomic mkdir; stale locks older than 60 s are stolen). */
export function withDispatchClaimLock<T>(projectRoot: string, dispatchId: string, fn: () => T): T {
  const lockDir = join(canonicalDispatchRoot(projectRoot), ".chrono", `dispatch-claim-${dispatchId}.lock`);
  const acquire = (): boolean => {
    try {
      mkdirSync(lockDir);
      return true;
    } catch {
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > CLAIM_LOCK_TTL_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          mkdirSync(lockDir);
          return true;
        }
      } catch {
        // Best-effort steal; contention below denies fail-closed.
      }
      return false;
    }
  };
  if (!acquire()) {
    throw new Error(`dispatch claim for '${dispatchId}' is already in progress: wait for it instead of claiming twice`);
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lockDir);
    } catch {
      // Best-effort release; TTL bounds a leak.
    }
  }
}

export interface DispatchRequestOptions {
  readonly module: string;
  readonly wp?: string | undefined;
  /** Dispatch kind: implementation work, test execution, reviews, verification, or correction. */
  readonly kind?: string | undefined;
  /** Correction only: defect whose open loop this dispatch serves (required when several loops are open). */
  readonly defect?: string | undefined;
  /** Proposed rigor profile: can only raise above project policy and content risk, never lower. */
  readonly proposedProfile?: string | undefined;
  readonly rationale: string;
  readonly as: string;
  readonly sessionToken?: string | undefined;
  readonly adapter?: string | undefined;
  /** OpenCode session key of the requesting Gaspar session (native tool passes ToolContext.sessionID). */
  readonly opencodeSession?: string | undefined;
  readonly json?: boolean | undefined;
}

/**
 * Phase 1: validate every dispatch gate and record the intent.
 * Gaspar/PO session required. Returns ids and revisions only.
 */
export function runDispatchRequest(projectPath: string, options: DispatchRequestOptions): CliOutput {
  const asJson = options.json === true;
  if (options.module.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "dispatch request requires --module <id>" },
      asJson
    );
  }
  if (options.rationale.trim().length === 0 || options.rationale.trim().length > DISPATCH_RATIONALE_MAX) {
    return coreError(
      {
        code: "VALIDATION_ERROR",
        severity: "ERROR",
        message: `dispatch request requires a rationale of 1 to ${DISPATCH_RATIONALE_MAX} characters`,
      },
      asJson
    );
  }
  if (options.as.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "dispatch request requires --as <gaspar|PO> matching the caller session" },
      asJson
    );
  }
  const session = resolveSessionToken(options.sessionToken);
  if (session === null) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "dispatch request requires --session-token (or CHRONO_SESSION_TOKEN)" },
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
    const result = core.requestDispatch(
      {
        moduleId: options.module,
        ...(options.wp !== undefined && options.wp.length > 0 ? { workPackageId: options.wp } : {}),
        ...(options.kind !== undefined && options.kind.length > 0 ? { kind: options.kind } : {}),
        ...(options.defect !== undefined && options.defect.length > 0 ? { defectId: options.defect } : {}),
        ...(options.proposedProfile !== undefined && options.proposedProfile.length > 0
          ? { proposedProfile: options.proposedProfile }
          : {}),
        rationale: options.rationale,
        ...(options.adapter !== undefined && options.adapter.length > 0 ? { adapterId: options.adapter } : {}),
      },
      { actor: options.as, session }
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    const now = new Date();
    // Single id space: the ledger mirrors the Core dispatch row it was
    // validated from. A ledger-only id could never bind the Core claim,
    // delegation, or confirm — every later phase addresses this id.
    const dispatchId = v.dispatchId;
    const record: DispatchIntentRecord = {
      v: 1,
      kind: "dispatch-requested",
      at: now.toISOString(),
      dispatchId,
      module: v.moduleId,
      wp: v.workPackageId,
      dispatchKind: v.kind,
      rationale: options.rationale.trim(),
      requesterCoreSession: session.id,
      requestedBy: v.requestedBy,
      gasparSessionKey: options.opencodeSession ?? null,
      moduleRevision: v.moduleRevision,
      workPackageRevision: v.workPackageRevision,
      specRevisions: v.specRevisions,
      expiresAt: new Date(now.getTime() + DISPATCH_INTENT_TTL_MS).toISOString(),
    };
    try {
      appendDispatchRecord(projectPath, record);
    } catch (e) {
      return coreError(
        {
          code: "VALIDATION_ERROR",
          severity: "ERROR",
          message: `dispatch intent validated but not recorded: ${e instanceof Error ? e.message : String(e)}`,
        },
        asJson
      );
    }
    if (asJson) {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          {
            ok: true,
            dispatchId,
            kind: v.kind,
            module: v.moduleId,
            wp: v.workPackageId,
            moduleRevision: v.moduleRevision,
            workPackageRevision: v.workPackageRevision,
            specRevisions: v.specRevisions,
            dispatchableRoles: v.dispatchableRoles,
            effectiveProfile: v.effectiveProfile,
            riskTriggers: v.riskTriggers,
            expiresAt: record.expiresAt,
            rtkWarnings: v.rtkWarnings,
          },
          null,
          2
        ),
        stderr: "",
      };
    }
    const warningLines = (v.rtkWarnings as string[]).map((w) => `  warning[RTK]: ${w}`);
    return {
      exitCode: 0,
      stdout: [
        `Dispatch validated for ${v.moduleId}${v.workPackageId !== null ? ` / ${v.workPackageId}` : ""}: delegate with the task tool, then the worker claims it.`,
        `  dispatch: ${dispatchId} [${v.kind}] (expires ${record.expiresAt})`,
        `  roles: ${v.dispatchableRoles.join(", ")}`,
        `  profile: ${v.effectiveProfile}${v.riskTriggers.length > 0 ? ` (risk: ${v.riskTriggers.join(", ")})` : ""}`,
        ...warningLines,
      ].join("\n"),
      stderr: "",
    };
  } finally {
    core.close();
  }
}

export interface DispatchClaimOptions {
  readonly dispatch: string;
  readonly agent: string;
  /** OpenCode session id of the claiming worker (ToolContext.sessionID, host-supplied). */
  readonly workerSessionKey: string;
  readonly adapter?: string | undefined;
  readonly json?: boolean | undefined;
}

/**
 * Phase 2: bind one worker subagent session to a validated dispatch.
 * No caller session flags: the Gaspar credential resolves host-side
 * from the ledger, and the worker credential is confined host-side.
 * The model supplies only the dispatch id; session and agent arrive
 * from ToolContext.
 */
export function runDispatchClaim(projectPath: string, options: DispatchClaimOptions): CliOutput {
  const asJson = options.json === true;
  if (options.dispatch.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "dispatch claim requires --dispatch <id>" },
      asJson
    );
  }
  if (!isEnactmentRole(options.agent)) {
    return coreError(
      {
        code: "EXECUTION_DENIED",
        severity: "BLOCKER",
        message: `Role '${options.agent}' is not delegable to a worker subagent: dispatched work enacts belthazar, melchior, prometheus, lucca, glenn, or spekkio through a fitting dispatch kind`,
      },
      asJson
    );
  }
  if (options.workerSessionKey.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "dispatch claim requires the worker OpenCode session" },
      asJson
    );
  }
  try {
    return withDispatchClaimLock(projectPath, options.dispatch, () => claimOnce(projectPath, options, asJson));
  } catch (e) {
    return coreError(
      { code: "EXECUTION_DENIED", severity: "BLOCKER", message: e instanceof Error ? e.message : String(e) },
      asJson
    );
  }
}

function claimOnce(projectPath: string, options: DispatchClaimOptions, asJson: boolean): CliOutput {
  const nowMs = Date.now();
  const found = findLiveIntent(readDispatchLedger(projectPath), options.dispatch, nowMs);
  if (found === null) {
    return coreError(
      {
        code: "EXECUTION_DENIED",
        severity: "BLOCKER",
        message: `Dispatch '${options.dispatch}' is unknown, expired, or already claimed: dispatch again for a fresh intent`,
      },
      asJson
    );
  }
  const { intent, claimed } = found;
  if (claimed !== null) {
    return coreError(
      {
        code: "EXECUTION_DENIED",
        severity: "BLOCKER",
        message: `Dispatch '${options.dispatch}' was already claimed by worker session '${claimed.workerSessionKey}': proceed there instead of claiming twice`,
      },
      asJson
    );
  }
  // A claim without a prior task delegation is ungated delegation:
  // the worker must arrive through the bound `task` call, never by
  // guessing a dispatch id.
  const delegation = readDispatchLedger(projectPath).find(
    (r): r is TaskDelegationRecord =>
      r.kind === "task-delegated" && r.dispatchId === options.dispatch && r.agent === options.agent
  );
  if (delegation === undefined) {
    return coreError(
      {
        code: "EXECUTION_DENIED",
        severity: "BLOCKER",
        message: `No task delegation binds dispatch '${options.dispatch}' to '${options.agent}': delegate first with the task tool`,
      },
      asJson
    );
  }
  // Kind fit at claim time mirrors the delegation gate: the Core
  // re-checks against its own row, this names the mismatch early.
  const intentKind = intent.dispatchKind ?? "implementation";
  if (!isRoleForDispatchKind(intentKind, options.agent)) {
    const fitting = (DISPATCH_KIND_ROLES as Record<string, readonly string[]>)[intentKind] ?? [];
    return coreError(
      {
        code: "EXECUTION_DENIED",
        severity: "BLOCKER",
        message: `Role '${options.agent}' cannot claim '${intentKind}' dispatch '${options.dispatch}': that kind authorizes ${fitting.length > 0 ? fitting.join(", ") : "(no role)"}`,
      },
      asJson
    );
  }
  if (intent.gasparSessionKey !== null && options.workerSessionKey === intent.gasparSessionKey) {
    return coreError(
      {
        code: "VALIDATION_ERROR",
        severity: "ERROR",
        message: "A dispatch cannot be claimed into its requesting session: the worker must arrive in its own subagent session",
      },
      asJson
    );
  }
  if (intent.gasparSessionKey === null) {
    return coreError(
      {
        code: "EXECUTION_DENIED",
        severity: "BLOCKER",
        message: "Dispatch intent carries no requesting session binding: dispatch again through the native tool",
      },
      asJson
    );
  }
  const gasparToken = readHostToken(projectPath, intent.gasparSessionKey);
  if (gasparToken === null) {
    return coreError(
      {
        code: "EXECUTION_DENIED",
        severity: "BLOCKER",
        message: "Requesting entry session expired or missing: reopen OpenCode so entry redeems, then dispatch again",
      },
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
    const result = core.claimDispatch(
      {
        dispatchId: options.dispatch,
        childRuntimeSession: options.workerSessionKey,
      },
      { actor: intent.requestedBy, session: gasparToken }
    );
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const v = result.value!;
    // Compensating revocation (CF-3): any failure after the Core
    // claim must not leave usable orphan authority behind.
    const compensate = (reason: string): CliOutput => {
      try {
        core.revokeDispatch(options.dispatch, { actor: intent.requestedBy, session: gasparToken }, reason);
      } catch {
        // Best-effort: the TTL/reconcile sweep bounds any remainder.
      }
      return coreError({ code: "EXECUTION_DENIED", severity: "BLOCKER", message: reason }, asJson);
    };
    try {
      writeFileSync(dispatchHostTokenPath(canonicalDispatchRoot(projectPath), options.workerSessionKey), `${v.session.id}/${v.session.token}`, { mode: 0o600 });
    } catch (e) {
      return compensate(
        `dispatch authorized but the worker credential could not be confined, claim revoked: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    try {
      appendDispatchRecord(projectPath, {
        v: 1,
        kind: "dispatch-claimed",
        at: new Date().toISOString(),
        dispatchId: options.dispatch,
        workerSessionKey: options.workerSessionKey,
        workerCoreSession: v.session.id,
        grantId: v.grantId,
        role: v.role,
      });
    } catch (e) {
      return compensate(
        `dispatch claimed but the binding record failed, claim revoked: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    // Confinement is proven by the 0600 file plus the ledger record
    // above: confirm the claim now so the binding is ACTIVE before any
    // worker tool runs. A crash between claim and this line leaves an
    // ENACTED row the reconcile sweep revokes — never usable authority.
    const confirmed = core.confirmClaim(options.dispatch, { actor: intent.requestedBy, session: gasparToken });
    if (!confirmed.ok) {
      return compensate(`dispatch claimed and confined but confirmation failed, claim revoked: ${confirmed.error?.message ?? "unknown"}`);
    }
    if (asJson) {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          {
            ok: true,
            dispatchId: options.dispatch,
            grantId: v.grantId,
            role: v.role,
            module: v.moduleId,
            wp: v.workPackageId,
            moduleRevision: v.moduleRevision,
            workPackageRevision: v.workPackageRevision,
            specRevisions: v.specRevisions,
            workerSession: v.session.id,
            expiresAt: v.session.expiresAt,
          },
          null,
          2
        ),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: [
        `Dispatch claimed: ${v.role} bound to ${v.moduleId}${v.workPackageId !== null ? ` / ${v.workPackageId}` : ""} (grant ${v.grantId}).`,
        `Work inside the assigned scope: mutable tools gate against this binding.`,
      ].join("\n"),
      stderr: "",
    };
  } finally {
    core.close();
  }
}

/** True when a host token file exists (used by the plugin gate; never reads the secret). */
export function hasHostToken(projectRoot: string, sessionKey: string): boolean {
  try {
    return existsSync(dispatchHostTokenPath(canonicalDispatchRoot(projectRoot), sessionKey));
  } catch {
    return false;
  }
}
