/**
 * CHRONO CLI — minimal usable interface to the deterministic Core.
 * [Slice 5] — CLI code delegates to Core services; it owns no CHRONO policy.
 *
 * Commands: init, status, validate. Each returns a CliOutput with an exit
 * code so adapters and tests can consume decisions deterministically.
 */

import { Command } from "commander";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ChronoCore } from "@chrono/core";
import { RTK_UPSTREAM, buildApprovalPayload, buildSessionAuthorizationPayload, buildWaiverPayload, computeRevisionHash, generateApprovalKeyPair, signApprovalPayload } from "@chrono/domain";
import { CHRONO_VERSION } from "./version.js";
import {
  MemoryKeyStore,
  OsKeychainStore,
  PO_KEY_ACCOUNT,
  PO_KEY_SERVICE,
  PO_KEY_STAGING_ACCOUNT,
  isInteractiveTerminal,
  type KeyStore,
} from "./keychain.js";

export interface HumanCommandDeps {
  readonly interactive: boolean;
  readonly store: KeyStore;
}

export function productionDeps(): HumanCommandDeps {
  return { interactive: isInteractiveTerminal(), store: new OsKeychainStore() };
}

export function testDeps(store?: KeyStore): HumanCommandDeps {
  return { interactive: true, store: store ?? new MemoryKeyStore() };
}

export interface ApproveOptions {
  readonly action: string;
  readonly scope: string;
  readonly revision: string;
  readonly authority: string;
  readonly rationale: string;
  readonly json?: boolean | undefined;
}

export interface WaiveOptions {
  readonly scope: string;
  readonly revision: string;
  readonly authority: string;
  readonly issue: string;
  readonly rationale: string;
  readonly expiry: string;
  readonly evidenceRef?: string | null | undefined;
  readonly controls?: string | null | undefined;
  readonly followUp?: string | null | undefined;
  readonly json?: boolean | undefined;
}

export interface CliOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface InitOptions {
  readonly language?: string | undefined;
  readonly gasparAutonomy?: string | undefined;
  readonly runtime?: string | null | undefined;
  readonly json?: boolean | undefined;
}

export interface OutputOptions {
  readonly json?: boolean | undefined;
}

interface CommandOpts {
  readonly path?: unknown;
  readonly language?: unknown;
  readonly gasparAutonomy?: unknown;
  readonly runtime?: unknown;
  readonly json?: unknown;
  readonly action?: unknown;
  readonly scope?: unknown;
  readonly revision?: unknown;
  readonly authority?: unknown;
  readonly rationale?: unknown;
  readonly issue?: unknown;
  readonly expiry?: unknown;
  readonly evidence?: unknown;
  readonly controls?: unknown;
  readonly followUp?: unknown;
  readonly module?: unknown;
  readonly wp?: unknown;
  readonly as?: unknown;
  readonly role?: unknown;
  readonly sessionToken?: unknown;
  readonly requesterToken?: unknown;
  readonly binary?: unknown;
  readonly adapter?: unknown;
  readonly scopeModule?: unknown;
  readonly scopeWp?: unknown;
  readonly ttl?: unknown;
  readonly parentToken?: unknown;
  readonly rotate?: unknown;
  readonly timeout?: unknown;
}

function formatCoreError(error: {
  code: string;
  severity: string;
  message: string;
  invariantRef?: string | undefined;
  affectedTarget?: string | undefined;
  suggestedAction?: string | undefined;
}): string {
  const lines = [`Error [${error.code}] (${error.severity}): ${error.message}`];
  if (error.invariantRef !== undefined) {
    lines.push(`  invariant: ${error.invariantRef}`);
  }
  if (error.affectedTarget !== undefined) {
    lines.push(`  target: ${error.affectedTarget}`);
  }
  if (error.suggestedAction !== undefined) {
    lines.push(`  suggested action: ${error.suggestedAction}`);
  }
  return lines.join("\n");
}

/**
 * Initialize a new CHRONO project at projectPath. Delegates to Core.init().
 */
export function runInit(projectPath: string, options: InitOptions = {}): CliOutput {
  const asJson = options.json === true;
  let core: ChronoCore;
  try {
    core = new ChronoCore({
      projectPath,
      ...(options.language !== undefined ? { language: options.language } : {}),
      ...(options.gasparAutonomy !== undefined ? { gasparAutonomy: options.gasparAutonomy } : {}),
      ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
    });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const result = core.init();
    if (!result.ok) {
      const body = asJson
        ? JSON.stringify({ ok: false, error: result.error }, null, 2)
        : formatCoreError({
            code: result.error?.code ?? "UNKNOWN",
            severity: result.error?.severity ?? "ERROR",
            message: result.error?.message ?? "Initialization failed",
            invariantRef: result.error?.invariantRef,
            affectedTarget: result.error?.affectedTarget,
            suggestedAction: result.error?.suggestedAction,
          });
      return asJson
        ? { exitCode: 1, stdout: body, stderr: "" }
        : { exitCode: 1, stdout: "", stderr: body };
    }
    if (asJson) {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          { ok: true, projectId: result.value?.projectId, state: result.value?.state },
          null,
          2,
        ),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: [
        `Initialized CHRONO project '${result.value?.projectId ?? "default"}'`,
        `state: ${result.value?.state ?? "UNKNOWN"}`,
        `store: ${projectPath}/.chrono/chrono.db`,
      ].join("\n"),
      stderr: "",
    };
  } finally {
    core.close();
  }
}

/**
 * Structured fatal for Core-construction failures (bad path, migration
 * failure, unreadable store). Exit 2 = system error [RUNTIME §12];
 * exit 1 is reserved for Core gate denials. JSON on every failure path
 * when --json is set [Remediation §6].
 */
function constructionFailure(e: unknown, asJson: boolean): CliOutput {
  const message = e instanceof Error ? e.message : String(e);
  if (asJson) {
    return {
      exitCode: 2,
      stdout: JSON.stringify(
        {
          ok: false,
          error: {
            code: "CORE_INIT_FAILURE",
            severity: "ERROR",
            message,
            suggestedAction: "Verify the project path is writable and .chrono/chrono.db is intact",
          },
        },
        null,
        2,
      ),
      stderr: "",
    };
  }
  return {
    exitCode: 2,
    stdout: "",
    stderr: [
      `Fatal [CORE_INIT_FAILURE] (ERROR): ${message}`,
      "  suggested action: Verify the project path is writable and .chrono/chrono.db is intact",
    ].join("\n"),
  };
}

/**
 * Show deterministic project status. Delegates to Core.status().
 */
export function runStatus(projectPath: string, options: OutputOptions = {}): CliOutput {
  const asJson = options.json === true;
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const result = core.status();
    if (!result.ok) {
      const body =
        options.json === true
          ? JSON.stringify({ ok: false, error: result.error }, null, 2)
          : formatCoreError({
              code: result.error?.code ?? "UNKNOWN",
              severity: result.error?.severity ?? "ERROR",
              message: result.error?.message ?? "Status failed",
              invariantRef: result.error?.invariantRef,
              affectedTarget: result.error?.affectedTarget,
              suggestedAction: result.error?.suggestedAction,
            });
      return options.json === true
        ? { exitCode: 1, stdout: body, stderr: "" }
        : { exitCode: 1, stdout: "", stderr: body };
    }
    const v = result.value;
    if (options.json === true) {
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, ...v }, null, 2), stderr: "" };
    }
    const lines = [
      `state: ${v?.state ?? "UNKNOWN"}`,
      `specs: ${v?.specCount ?? 0}  modules: ${v?.moduleCount ?? 0}  work packages: ${v?.workPackageCount ?? 0}`,
      `active blockers: ${v?.activeBlockers ?? 0}`,
    ];
    for (const b of v?.activeBlockerList ?? []) {
      lines.push(`  - [${b.type}] ${b.id}: ${b.reason}`);
    }
    if (v !== undefined) {
      lines.push(`project state: ${v.details.projectState}  projected: ${v.details.projectedState}`);
    }
    return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
  } finally {
    core.close();
  }
}

/**
 * Run deterministic validation. Delegates to Core.validate().
 * Exit 0 when valid, 1 when invalid or on error (fail-closed).
 */
export function runValidate(projectPath: string, options: OutputOptions = {}): CliOutput {
  const asJson = options.json === true;
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const result = core.validate();
    if (!result.ok) {
      const body =
        options.json === true
          ? JSON.stringify({ ok: false, error: result.error }, null, 2)
          : formatCoreError({
              code: result.error?.code ?? "UNKNOWN",
              severity: result.error?.severity ?? "ERROR",
              message: result.error?.message ?? "Validation failed",
              invariantRef: result.error?.invariantRef,
              affectedTarget: result.error?.affectedTarget,
              suggestedAction: result.error?.suggestedAction,
            });
      return options.json === true
        ? { exitCode: 1, stdout: body, stderr: "" }
        : { exitCode: 1, stdout: "", stderr: body };
    }
    const valid = result.value?.valid ?? false;
    if (options.json === true) {
      return {
        exitCode: valid ? 0 : 1,
        stdout: JSON.stringify({ ok: true, ...result.value }, null, 2),
        stderr: "",
      };
    }
    const lines = [valid ? "VALID" : "INVALID"];
    for (const e of result.value?.errors ?? []) {
      lines.push(`  error: ${e}`);
    }
    for (const w of result.value?.warnings ?? []) {
      lines.push(`  warning: ${w}`);
    }
    return {
      exitCode: valid ? 0 : 1,
      stdout: lines.join("\n"),
      stderr: "",
    };
  } finally {
    core.close();
  }
}

/**
 * Interactive human-only PO approval [ADR-003, P2.10].
 * Non-interactive invocation or missing key returns APPROVAL_REQUIRED
 * WITHOUT persisting anything. Agents cannot impersonate this path:
 * it requires a live TTY plus the OS-keychain private key.
 */
export function runApprove(
  projectPath: string,
  options: ApproveOptions,
  deps: HumanCommandDeps = productionDeps()
): CliOutput {
  const asJson = options.json === true;
  if (!deps.interactive) {
    return humanOnlyRefusal("approve", asJson);
  }
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const privateKey = readPoKey(deps.store);
    if (privateKey === null) {
      return approvalRequired(
        "No PO signing key in the OS keychain",
        "Generate one with chrono keys generate, then retry interactively",
        asJson
      );
    }
    const timestamp = new Date().toISOString();
    const payload = buildApprovalPayload({
      action: options.action,
      scopeArtifactId: options.scope,
      scopeRevision: options.revision,
      authority: options.authority,
      rationale: options.rationale,
      timestamp,
    });
    const signature = signApprovalPayload(payload, privateKey);
    const result = core.recordApproval({
      action: options.action,
      scopeArtifactId: options.scope,
      scopeRevision: options.revision,
      authority: options.authority,
      rationale: options.rationale,
      timestamp,
      signature,
    });
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const body = asJson
      ? JSON.stringify({ ok: true, id: result.value?.id, action: options.action }, null, 2)
      : `Recorded signed approval '${result.value?.id}' (${options.action} on ${options.scope})`;
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

/**
 * Interactive human-only PO waiver [CORE §8.3, P2.8].
 * Same non-bypassable bar as approve.
 */
export function runWaive(
  projectPath: string,
  options: WaiveOptions,
  deps: HumanCommandDeps = productionDeps()
): CliOutput {
  const asJson = options.json === true;
  if (!deps.interactive) {
    return humanOnlyRefusal("waive", asJson);
  }
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const privateKey = readPoKey(deps.store);
    if (privateKey === null) {
      return approvalRequired(
        "No PO signing key in the OS keychain",
        "Generate one with chrono keys generate, then retry interactively",
        asJson
      );
    }
    const timestamp = new Date().toISOString();
    const payload = buildWaiverPayload({
      scopeArtifactId: options.scope,
      scopeRevision: options.revision,
      authority: options.authority,
      issue: options.issue,
      rationale: options.rationale,
      evidenceRef: options.evidenceRef ?? null,
      compensatingControls: options.controls ?? null,
      followUpTaskId: options.followUp ?? null,
      expiryReviewCondition: options.expiry,
      timestamp,
    });
    const signature = signApprovalPayload(payload, privateKey);
    const result = core.recordWaiver({
      scopeArtifactId: options.scope,
      scopeRevision: options.revision,
      authority: options.authority,
      issue: options.issue,
      rationale: options.rationale,
      evidenceRef: options.evidenceRef ?? null,
      compensatingControls: options.controls ?? null,
      followUpTaskId: options.followUp ?? null,
      expiryReviewCondition: options.expiry,
      timestamp,
      signature,
    });
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const body = asJson
      ? JSON.stringify({ ok: true, id: result.value?.id }, null, 2)
      : `Recorded signed waiver '${result.value?.id}' (scope ${options.scope})`;
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

export interface KeysGenerateOptions extends OutputOptions {
  readonly rotate?: boolean | undefined;
  readonly rationale?: string | undefined;
}

/**
 * Interactive PO key generation: Ed25519 keypair, private key to the OS
 * keychain, public key registered with the project. The private key is
 * never printed, logged, or written to the project [ADR-003].
 */
export function runKeysGenerate(
  projectPath: string,
  options: KeysGenerateOptions = {},
  deps: HumanCommandDeps = productionDeps()
): CliOutput {
  const asJson = options.json === true;
  if (!deps.interactive) {
    return humanOnlyRefusal("keys generate", asJson);
  }
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const existingPrivate = readPoKey(deps.store);
    const registeredRevision = core.poKeyRevision();
    if (registeredRevision !== null) {
      if (existingPrivate === null) {
        return approvalRequired(
          "A PO public key is already registered, but no matching private key is available",
          "Recover the registered private key; keys generate cannot replace it without a signed rotation",
          asJson
        );
      }
      if (options.rotate !== true) {
        return coreError(
          {
            code: "VALIDATION_ERROR",
            severity: "ERROR",
            message: "Refusing to replace the active PO key: pass --rotate with --rationale for a signed rotation",
          },
          asJson
        );
      }
      const rationale = options.rationale?.trim() ?? "";
      if (rationale.length === 0) {
        return coreError(
          { code: "VALIDATION_ERROR", severity: "ERROR", message: "Key rotation requires --rationale bound into the PO signature" },
          asJson
        );
      }
    }

    const pair = generateApprovalKeyPair();
    // Stage the new private key before changing project trust: if Core
    // registration fails, the active key is untouched and staging is
    // removed. The primary account is replaced only after acceptance.
    try {
      deps.store.writeKey(PO_KEY_STAGING_ACCOUNT, pair.privateKeyPem);
    } catch (e) {
      return keychainFailure(e, asJson);
    }
    if (registeredRevision === null) {
      const registered = core.registerPoPublicKey(pair.publicKeyPem);
      if (!registered.ok) {
        cleanupStaging(deps.store);
        return coreError(registered.error, asJson);
      }
    } else {
      if (existingPrivate === null) {
        cleanupStaging(deps.store);
        return approvalRequired(
          "A PO public key is already registered, but no matching private key is available",
          "Recover the registered private key; keys generate cannot replace it without a signed rotation",
          asJson
        );
      }
      const timestamp = new Date().toISOString();
      let signature: string;
      try {
        signature = signApprovalPayload(
          buildApprovalPayload({
            action: "key-rotation",
            scopeArtifactId: "PO-KEY",
            scopeRevision: registeredRevision,
            authority: "PO",
            rationale: options.rationale?.trim() ?? "",
            timestamp,
          }),
          existingPrivate
        );
      } catch {
        cleanupStaging(deps.store);
        return coreError(
          { code: "SIGNATURE_INVALID", severity: "ERROR", message: "Active PO key is not a valid PEM private key" },
          asJson
        );
      }
      const registered = core.registerPoPublicKey(pair.publicKeyPem, {
        signature,
        authority: "PO",
        rationale: options.rationale?.trim() ?? "",
        timestamp,
      });
      if (!registered.ok) {
        cleanupStaging(deps.store);
        return coreError(registered.error, asJson);
      }
    }

    try {
      deps.store.writeKey(PO_KEY_ACCOUNT, pair.privateKeyPem);
    } catch (e) {
      return keychainFailure(
        new Error(
          `Primary key storage failed after the new public key was accepted. The new private key remains staged as '${PO_KEY_STAGING_ACCOUNT}'; restore it before approving. ${e instanceof Error ? e.message : String(e)}`
        ),
        asJson
      );
    }
    if (readPoKey(deps.store) !== pair.privateKeyPem) {
      return keychainFailure(
        new Error(
          `Primary key verification failed after the new public key was accepted. The new private key remains staged as '${PO_KEY_STAGING_ACCOUNT}'; restore it before approving.`
        ),
        asJson
      );
    }
    const cleanup = cleanupStaging(deps.store);
    const body = asJson
      ? JSON.stringify(
          {
            ok: true,
            account: PO_KEY_ACCOUNT,
            ...(cleanup === null ? {} : { stagingCleanup: cleanup }),
          },
          null,
          2
        )
      : ["PO signing key generated.", `  private: OS keychain (${PO_KEY_SERVICE})`, "  public: registered with this project."].join(
          "\n"
        );
    if (cleanup === null) {
      return { exitCode: 0, stdout: body, stderr: "" };
    }
    return { exitCode: 0, stdout: body, stderr: `Warning: staging cleanup failed: ${cleanup}` };
  } finally {
    core.close();
  }
}

function cleanupStaging(store: KeyStore): string | null {
  try {
    store.deleteKey(PO_KEY_STAGING_ACCOUNT);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function readPoKey(store: KeyStore): string | null {
  try {
    return store.readKey(PO_KEY_ACCOUNT);
  } catch {
    return null;
  }
}

function humanOnlyRefusal(command: string, asJson: boolean): CliOutput {
  return approvalRequired(
    `chrono ${command} requires an interactive human terminal`,
    "Run this command in a live terminal as the Product Owner; agents and scripts cannot approve",
    asJson
  );
}

function approvalRequired(message: string, suggestedAction: string, asJson: boolean): CliOutput {
  if (asJson) {
    return {
      exitCode: 1,
      stdout: JSON.stringify(
        { ok: false, error: { code: "APPROVAL_REQUIRED", severity: "BLOCKER", message, suggestedAction } },
        null,
        2
      ),
      stderr: "",
    };
  }
  return {
    exitCode: 1,
    stdout: "",
    stderr: `Error [APPROVAL_REQUIRED] (BLOCKER): ${message}\n  suggested action: ${suggestedAction}`,
  };
}

function keychainFailure(e: unknown, asJson: boolean): CliOutput {
  const message = e instanceof Error ? e.message : String(e);
  if (asJson) {
    return {
      exitCode: 2,
      stdout: JSON.stringify(
        { ok: false, error: { code: "CORE_INIT_FAILURE", severity: "ERROR", message } },
        null,
        2
      ),
      stderr: "",
    };
  }
  return { exitCode: 2, stdout: "", stderr: `Fatal [CORE_INIT_FAILURE] (ERROR): ${message}` };
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
    : formatCoreError({
        code: error?.code ?? "UNKNOWN",
        severity: error?.severity ?? "ERROR",
        message: error?.message ?? "Operation failed",
        invariantRef: error?.invariantRef,
        affectedTarget: error?.affectedTarget,
        suggestedAction: error?.suggestedAction,
      });
  return asJson
    ? { exitCode: 1, stdout: body, stderr: "" }
    : { exitCode: 1, stdout: "", stderr: body };
}

export interface GateOptions {
  readonly gate: string;
  readonly module?: string | undefined;
  readonly wp?: string | undefined;
  readonly as?: string | undefined;
  readonly role?: string | undefined;
  readonly sessionToken?: string | undefined;
  readonly requesterToken?: string | undefined;
  readonly json?: boolean | undefined;
}

/** Parse an explicit session token without environment fallback. */
function parseSessionToken(raw?: string): { id: string; token: string } | null {
  if (raw === undefined || raw.length === 0) {
    return null;
  }
  const slash = raw.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  return { id: raw.slice(0, slash), token: raw.slice(slash + 1) };
}

/** Session token from flag or process-local env (never from project files). */
export function resolveSessionToken(explicit?: string): { id: string; token: string } | null {
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

/**
 * Evaluate a Core gate for adapters and pre-tool hooks.
 * Implements `chrono gate` [RUNTIME §3.2]: JSON {result, code, reason},
 * exit 0 AUTHORIZED, 1 DENIED, 2 error. Adapters must obey the result.
 */
export function runGate(projectPath: string, options: GateOptions): CliOutput {
  const asJson = options.json === true;
  const respond = (exitCode: number, body: unknown, human: string): CliOutput =>
    asJson
      ? { exitCode, stdout: JSON.stringify(body, null, 2), stderr: "" }
      : { exitCode, stdout: exitCode === 0 ? human : "", stderr: exitCode === 0 ? "" : human };
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    if (options.as === undefined || options.as.length === 0) {
      return respond(
        2,
        { result: "ERROR", code: "VALIDATION_ERROR", reason: "gate requires --as <actor> (canonical role or <runtime>:<session>)" },
        "Error [VALIDATION_ERROR]: gate requires --as <actor> (canonical role or <runtime>:<session>)"
      );
    }
    if (options.gate === "execution") {
      if (options.module === undefined || options.module.length === 0) {
        return respond(2, { result: "ERROR", code: "VALIDATION_ERROR", reason: "execution gate requires --module" }, "Error [VALIDATION_ERROR]: execution gate requires --module");
      }
      if (options.role === undefined || options.role.length === 0) {
        return respond(2, { result: "ERROR", code: "VALIDATION_ERROR", reason: "execution gate requires --role (assigned implementation role)" }, "Error [VALIDATION_ERROR]: execution gate requires --role (assigned implementation role)");
      }
      const session = resolveSessionToken(options.sessionToken);
      if (session === null) {
        return respond(2, { result: "ERROR", code: "VALIDATION_ERROR", reason: "execution gate requires --session-token (or CHRONO_SESSION_TOKEN)" }, "Error [VALIDATION_ERROR]: execution gate requires --session-token (or CHRONO_SESSION_TOKEN)");
      }
      const requesterSession = parseSessionToken(options.requesterToken);
      if (options.requesterToken !== undefined && requesterSession === null) {
        return respond(2, { result: "ERROR", code: "VALIDATION_ERROR", reason: "execution gate requires --requester-token <id/token>" }, "Error [VALIDATION_ERROR]: execution gate requires --requester-token <id/token>");
      }
      if (requesterSession === null && options.as !== options.role) {
        return respond(2, { result: "ERROR", code: "VALIDATION_ERROR", reason: "orchestrated execution requests require --requester-token for the requesting session" }, "Error [VALIDATION_ERROR]: orchestrated execution requests require --requester-token for the requesting session");
      }
      const result = core.authorizeExecution(options.module, {
        ...(options.wp !== undefined ? { workPackageId: options.wp } : {}),
        actor: options.as,
        role: options.role,
        session,
        ...(requesterSession === null ? {} : { requesterSession }),
      });
      if (result.ok) {
        return respond(0, { result: "AUTHORIZED", grantId: result.value?.grantId }, "AUTHORIZED");
      }
      return respond(
        1,
        { result: "DENIED", code: result.error?.code ?? "EXECUTION_DENIED", reason: result.error?.message ?? "denied" },
        `DENIED [${result.error?.code ?? "EXECUTION_DENIED"}]: ${result.error?.message ?? "denied"}`
      );
    }
    if (options.gate === "completion") {
      if (options.module === undefined || options.module.length === 0) {
        return respond(2, { result: "ERROR", code: "VALIDATION_ERROR", reason: "completion gate requires --module" }, "Error [VALIDATION_ERROR]: completion gate requires --module");
      }
      const completionSession = resolveSessionToken(options.sessionToken);
      if (completionSession === null) {
        return respond(2, { result: "ERROR", code: "VALIDATION_ERROR", reason: "completion gate requires --session-token (or CHRONO_SESSION_TOKEN)" }, "Error [VALIDATION_ERROR]: completion gate requires --session-token (or CHRONO_SESSION_TOKEN)");
      }
      const result = core.authorizeCompletion(options.module, { actor: options.as, session: completionSession });
      if (result.ok) {
        return respond(0, { result: "AUTHORIZED" }, "AUTHORIZED");
      }
      return respond(
        1,
        { result: "DENIED", code: result.error?.code ?? "COMPLETION_DENIED", reason: result.error?.message ?? "denied" },
        `DENIED [${result.error?.code ?? "COMPLETION_DENIED"}]: ${result.error?.message ?? "denied"}`
      );
    }
    if (
      options.gate === "architecture-approval" ||
      options.gate === "spec-ready" ||
      options.gate === "verification"
    ) {
      return respond(
        2,
        { result: "ERROR", code: "CONFIG_ERROR", reason: `gate '${options.gate}' is not implemented yet` },
        `Error [CONFIG_ERROR]: gate '${options.gate}' is not implemented yet`
      );
    }
    return respond(
      2,
      { result: "ERROR", code: "VALIDATION_ERROR", reason: `unknown gate '${options.gate}'` },
      `Error [VALIDATION_ERROR]: unknown gate '${options.gate}'`
    );
  } finally {
    core.close();
  }
}

/**
 * Show the latest RTK/skill attestation currency (read-only).
 */
export function runAttestationStatus(
  projectPath: string,
  kind: "rtk" | "skill",
  options: OutputOptions = {}
): CliOutput {
  const asJson = options.json === true;
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const status = core.attestationCurrency(kind);
    const body = asJson
      ? JSON.stringify({ ok: true, kind, ...status }, null, 2)
      : `${kind} attestation: ${status.state}${status.id === null ? " (none recorded)" : ` (${status.id}, valid until ${status.validUntil ?? "unknown"})`}`;
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

/**
 * Verify a genuine RTK installation by executing the real commands:
 * `rtk --version` and `rtk gain` (identity proof [ADR-004]). Records the
 * attestation only when both succeed. Adapter routing self-test arrives
 * with Slice 8 adapters; until then routing is recorded unproven and the
 * execution gate denies on it — fail-closed, never silent fallback.
 */
export function runRtkVerify(
  projectPath: string,
  options: OutputOptions & { binaryPath?: string; session?: { id: string; token: string } } = {},
  exec: (binary: string, args: string[]) => { exitCode: number; stdout: string } = defaultExec
): CliOutput {
  const asJson = options.json === true;
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    if (options.session === undefined) {
      return coreError(
        { code: "VALIDATION_ERROR", severity: "ERROR", message: "rtk verify requires --session-token" },
        asJson
      );
    }
    const caller = { actor: "gaspar", session: options.session };
    const binary = options.binaryPath ?? "rtk";
    let version: string;
    try {
      const versionResult = exec(binary, ["--version"]);
      if (versionResult.exitCode !== 0) {
        return rtkBlocked(`'${binary} --version' failed`, asJson);
      }
      version = versionResult.stdout.trim().split("\n")[0] ?? "unknown";
    } catch {
      return rtkBlocked(`RTK binary '${binary}' not found: install Rust Token Killer from ${RTK_UPSTREAM}`, asJson);
    }
    let gain: { exitCode: number; stdout: string };
    try {
      gain = exec(binary, ["gain"]);
    } catch {
      return rtkBlocked("'rtk gain' could not execute: the binary is not proven Rust Token Killer", asJson);
    }
    if (gain.exitCode !== 0) {
      return rtkBlocked("RTK_NAME_COLLISION: installed rtk is not Rust Token Killer (rtk gain failed)", asJson);
    }
    const recorded = core.recordRtkAttestation(caller, {
      binaryPath: binary,
      binaryIdentity: `rtk gain ok :: ${version}`,
      version,
      provenance: RTK_UPSTREAM,
      integrationMode: null,
      routingTestPassed: false,
      routingTestLog: "adapter routing self-test pending (Slice 8 adapters)",
      gained: true,
      savingsEvidence: gain.stdout.slice(0, 2000),
      ttlSeconds: 3600,
    });
    if (!recorded.ok) {
      return coreError(recorded.error, asJson);
    }
    const body = asJson
      ? JSON.stringify({ ok: true, id: recorded.value?.id, version, routingProven: false }, null, 2)
      : `RTK verified (${version}); attestation '${recorded.value?.id}'. Adapter routing unproven: execution still denies until Slice 8.`;
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

/**
 * Skill re-verification. Fail-closed until pinned release metadata exists:
 * without an immutable pinned commit to compare against, provenance is
 * unverifiable, so nothing is recorded and dispatch stays denied. The
 * Core.recordSkillAttestation path remains fully tested; this command
 * becomes functional when release metadata lands (Slice 8).
 */
export function runSkillVerify(
  projectPath: string,
  options: OutputOptions = {}
): CliOutput {
  const asJson = options.json === true;
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const status = core.attestationCurrency("skill");
    const reason =
      `Karpathy Guidelines skill is ${status.state}: no pinned release metadata to verify provenance against; ` +
      "recording is refused until release metadata lands";
    if (asJson) {
      return {
        exitCode: 1,
        stdout: JSON.stringify(
          { ok: false, error: { code: "BLOCKED_PROCESS_SKILL", severity: "BLOCKER", message: reason } },
          null,
          2
        ),
        stderr: "",
      };
    }
    return { exitCode: 1, stdout: "", stderr: `Error [BLOCKED_PROCESS_SKILL] (BLOCKER): ${reason}` };
  } finally {
    core.close();
  }
}

function rtkBlocked(reason: string, asJson: boolean): CliOutput {  if (asJson) {
    return {
      exitCode: 1,
      stdout: JSON.stringify({ ok: false, error: { code: "BLOCKED_RTK", severity: "BLOCKER", message: reason } }, null, 2),
      stderr: "",
    };
  }
  return { exitCode: 1, stdout: "", stderr: `Error [BLOCKED_RTK] (BLOCKER): ${reason}` };
}

function defaultExec(binary: string, args: string[]): { exitCode: number; stdout: string } {
  try {
    const stdout = execFileSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { exitCode: 0, stdout };
  } catch (e) {
    const code = (e as { status?: number }).status ?? 1;
    const stdout = (e as { stdout?: unknown }).stdout;
    return { exitCode: code, stdout: typeof stdout === "string" ? stdout : "" };
  }
}

export interface SessionOpenOptions {
  readonly role: string;
  readonly adapter: string;
  readonly runtime: string;
  readonly scopeModule?: string | undefined;
  readonly scopeWp?: string | undefined;
  readonly ttlSeconds?: number | undefined;
  readonly parentToken?: string | undefined;
  readonly rationale?: string | undefined;
  readonly json?: boolean | undefined;
}

/**
 * Open an authenticated session. Worker sessions use interactive minting;
 * privileged gaspar/PO sessions require a one-time PO-signed bootstrap;
 * delegation requires a valid parent session token. The bearer
 * token is returned once and never persisted.
 */
export function runSessionOpen(
  projectPath: string,
  options: SessionOpenOptions,
  deps: HumanCommandDeps = productionDeps()
): CliOutput {
  const asJson = options.json === true;
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const ttlSeconds = options.ttlSeconds ?? 3600;
    const request = {
      role: options.role,
      adapter: options.adapter,
      runtime: options.runtime,
      ...(options.scopeModule !== undefined ? { scopeModule: options.scopeModule } : {}),
      ...(options.scopeWp !== undefined ? { scopeWp: options.scopeWp } : {}),
      ttlSeconds,
    };
    if (options.parentToken !== undefined) {
      const parent = resolveSessionToken(options.parentToken);
      if (parent === null) {
        return coreError(
          { code: "VALIDATION_ERROR", severity: "ERROR", message: "Malformed parent session token" },
          asJson
        );
      }
      const result = core.openSession(request, { parentSession: parent });
      if (!result.ok) {
        return coreError(result.error, asJson);
      }
      return {
        exitCode: 0,
        stdout: asJson
          ? JSON.stringify({ ok: true, id: result.value?.id, token: result.value?.token, expiresAt: result.value?.expiresAt }, null, 2)
          : [`session: ${result.value?.id ?? ""}`, `token: ${result.value?.token ?? ""}`, "Store the token securely; it is never shown again."].join("\n"),
        stderr: "",
      };
    }
    if (!deps.interactive) {
      return humanOnlyRefusal("session open", asJson);
    }
    if (options.role === "gaspar" || options.role === "PO") {
      const privateKey = readPoKey(deps.store);
      if (privateKey === null) {
        return approvalRequired(
          "Privileged sessions require the PO signing key from the OS keychain",
          "Generate one with chrono keys generate, then retry interactively with --rationale",
          asJson
        );
      }
      const rationale = options.rationale?.trim() ?? "";
      if (rationale.length === 0) {
        return coreError(
          {
            code: "VALIDATION_ERROR",
            severity: "ERROR",
            message: "Privileged session open requires --rationale bound into the PO signature",
          },
          asJson
        );
      }
      const nonce = randomBytes(16).toString("hex");
      const timestamp = new Date().toISOString();
      let signature: string;
      try {
        signature = signApprovalPayload(
          buildSessionAuthorizationPayload({
            sessionRole: options.role,
            adapter: options.adapter,
            runtime: options.runtime,
            scopeModule: options.scopeModule ?? null,
            scopeWp: options.scopeWp ?? null,
            ttlSeconds,
            nonce,
            authority: "PO",
            rationale,
            timestamp,
          }),
          privateKey
        );
      } catch {
        return coreError(
          { code: "SIGNATURE_INVALID", severity: "ERROR", message: "PO signing key is not a valid PEM private key" },
          asJson
        );
      }
      const result = core.openSession(request, {
        poAuthorization: { nonce, authority: "PO", rationale, timestamp, signature },
      });
      if (!result.ok) {
        return coreError(result.error, asJson);
      }
      return {
        exitCode: 0,
        stdout: asJson
          ? JSON.stringify({ ok: true, id: result.value?.id, token: result.value?.token, expiresAt: result.value?.expiresAt }, null, 2)
          : [`session: ${result.value?.id ?? ""}`, `token: ${result.value?.token ?? ""}`, "Store the token securely; it is never shown again."].join("\n"),
        stderr: "",
      };
    }
    const result = core.openSession(request, { interactive: true });
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    return {
      exitCode: 0,
      stdout: asJson
        ? JSON.stringify({ ok: true, id: result.value?.id, token: result.value?.token, expiresAt: result.value?.expiresAt }, null, 2)
        : [`session: ${result.value?.id ?? ""}`, `token: ${result.value?.token ?? ""}`, "Store the token securely; it is never shown again."].join("\n"),
      stderr: "",
    };
  } finally {
    core.close();
  }
}

/** Revoke a session (gaspar/PO caller with a valid session). */
export function runSessionRevoke(
  projectPath: string,
  id: string,
  auth: { actor: string; session: { id: string; token: string } },
  options: OutputOptions = {}
): CliOutput {
  const asJson = options.json === true;
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const result = core.revokeSession(id, auth);
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    return { exitCode: 0, stdout: asJson ? JSON.stringify({ ok: true, id }, null, 2) : `revoked session ${id}`, stderr: "" };
  } finally {
    core.close();
  }
}

export interface RunOptions {
  readonly module: string;
  readonly wp?: string | undefined;
  readonly adapter: string;
  readonly as: string;
  readonly requesterToken: string;
  readonly role: string;
  readonly sessionToken?: string | undefined;
  readonly command: string[];
  readonly timeoutSeconds?: number | undefined;
  readonly json?: boolean | undefined;
}

export interface SpawnResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function defaultSpawn(cmd: string, args: string[], timeoutMs: number, env: Record<string, string>): SpawnResult {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, env });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    timedOut: result.error !== undefined && (result.error as { code?: string }).code === "ETIMEDOUT",
  };
}

/**
 * Authorized dispatch: `chrono run` (Slice 6, [RUNTIME §4]).
 *
 * The CLI owns no policy: every step is a Core decision. The flow is
 * authorize → enact dispatch → spawn the registered adapter entrypoint
 * (argv[0] must equal it, so a grant cannot smuggle another binary) →
 * record evidence as the executor → advance to VERIFYING/IMPLEMENTED.
 * A failing or timing-out command leaves the lifecycle state untouched
 * for the correction loop; nothing is marked complete.
 */
export function runDispatch(
  projectPath: string,
  options: RunOptions,
  spawn: (cmd: string, args: string[], timeoutMs: number, env: Record<string, string>) => SpawnResult = defaultSpawn
): CliOutput {
  const asJson = options.json === true;
  const fail = (exitCode: number, code: string, reason: string): CliOutput =>
    asJson
      ? { exitCode, stdout: JSON.stringify({ ok: false, error: { code, message: reason } }, null, 2), stderr: "" }
      : { exitCode, stdout: "", stderr: `Error [${code}]: ${reason}` };
  if (options.module.length === 0) {
    return fail(2, "VALIDATION_ERROR", "run requires --module");
  }
  if (options.adapter.length === 0) {
    return fail(2, "VALIDATION_ERROR", "run requires --adapter <registered runtime id>");
  }
  if (options.as.length === 0) {
    return fail(2, "VALIDATION_ERROR", "run requires --as <requester identity>");
  }
  if (options.role.length === 0) {
    return fail(2, "VALIDATION_ERROR", "run requires --role <assigned role>");
  }
  if (options.command.length === 0) {
    return fail(2, "VALIDATION_ERROR", "run requires a command after --");
  }
  const executor = resolveSessionToken(options.sessionToken);
  if (executor === null) {
    return fail(2, "VALIDATION_ERROR", "run requires --session-token (or CHRONO_SESSION_TOKEN) for the executor session");
  }
  const requester = parseSessionToken(options.requesterToken);
  if (requester === null) {
    return fail(2, "VALIDATION_ERROR", "run requires --requester-token <id/token> for the requesting session");
  }
  const timeoutSeconds = options.timeoutSeconds ?? 600;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86400) {
    return fail(2, "VALIDATION_ERROR", "run --timeout must be within 1 second and 24 hours");
  }
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    let adapter: { id: string; entrypoint: string };
    try {
      adapter = core.getAdapterForDispatch(options.adapter);
    } catch (e) {
      return coreError(e instanceof Error ? { code: "ADAPTER_REJECTED", severity: "BLOCKER", message: e.message } : undefined, asJson);
    }
    if (options.command[0] !== adapter.entrypoint) {
      return fail(2, "VALIDATION_ERROR", `run command must start with the registered entrypoint '${adapter.entrypoint}': grants cannot smuggle another binary`);
    }
    const target = options.wp ?? options.module;
    const startEvent = options.wp !== undefined ? "ExecutionAssigned" : "ExecutionStarted";
    const doneEvent = options.wp !== undefined ? "ImplementationDone" : "ImplementationComplete";
    const authorized = core.authorizeExecution(options.module, {
      ...(options.wp !== undefined ? { workPackageId: options.wp } : {}),
      actor: options.as,
      role: options.role,
      session: executor,
      requesterSession: requester,
    });
    if (!authorized.ok) {
      return coreError(authorized.error, asJson);
    }
    const started = core.transitionState(target, startEvent, {
      actor: options.role,
      session: executor,
      grantId: authorized.value!.grantId,
    });
    if (!started.ok) {
      return coreError(started.error, asJson);
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    env["CHRONO_GRANT_ID"] = authorized.value!.grantId;
    env["CHRONO_MODULE"] = options.module;
    env["CHRONO_ADAPTER"] = adapter.id;
    env["CHRONO_SESSION_TOKEN"] = `${executor.id}/${executor.token}`;
    const [cmd, ...args] = options.command as [string, ...string[]];
    const ran = spawn(cmd, args, Math.floor(timeoutSeconds * 1000), env);
    if (ran.timedOut) {
      return fail(1, "EXECUTION_DENIED", `run timed out after ${timeoutSeconds}s: '${target}' stays ${started.value!.toState} for the correction loop`);
    }
    if (ran.status !== 0) {
      const detail = ran.stderr.trim().length > 0 ? ran.stderr.trim().slice(-2000) : `exit ${String(ran.status)}`;
      return fail(1, "EXECUTION_DENIED", `run command failed: ${detail}: '${target}' stays ${started.value!.toState} for the correction loop`);
    }
    const output = `stdout:\n${ran.stdout}\nstderr:\n${ran.stderr}`;
    const diagnostics = output.length > 8000 ? `${output.slice(0, 8000)}\n[truncated]` : output;
    const targetRevision = core.getArtifact(target).revision;
    const evidence = core.recordEvidence({
      producer: options.role,
      tool: adapter.id,
      targetRevision,
      checkName: `run:${target}`,
      result: "pass",
      diagnostics,
      integrityHash: computeRevisionHash({ result: "pass", diagnostics, target_revision: targetRevision }),
    }, { actor: options.role, session: executor });
    if (!evidence.ok) {
      return coreError(evidence.error, asJson);
    }
    const resumed = core.authorizeExecution(options.module, {
      ...(options.wp !== undefined ? { workPackageId: options.wp } : {}),
      actor: options.role,
      role: options.role,
      session: executor,
    });
    if (!resumed.ok) {
      return coreError(resumed.error, asJson);
    }
    const done = core.transitionState(target, doneEvent, {
      actor: options.role,
      session: executor,
      grantId: resumed.value!.grantId,
    });
    if (!done.ok) {
      return coreError(done.error, asJson);
    }
    const body = asJson
      ? JSON.stringify({ ok: true, module: options.module, state: done.value!.toState, evidenceId: evidence.value!.id }, null, 2)
      : `Dispatched '${target}' through '${adapter.id}' → ${done.value!.toState} (evidence '${evidence.value!.id}')`;
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

/**
 * Build the commander program. The `cwd` is the default project path when
 * `--path` is not given. Actions print to console and set process exit code
 * via `program.exitOverride` errors handled by the caller (bin.ts).
 */
export function createProgram(cwd: string): Command {
  const program = new Command();
  program.name("chrono").description("CHRONO — structured SDD framework CLI").version(CHRONO_VERSION);

  program
    .command("init")
    .description("Initialize a new CHRONO project")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--language <lang>", "project language (default: en)")
    .option("--gaspar-autonomy <mode>", "Gaspar autonomy mode")
    .option("--runtime <runtime>", "runtime adapter name (recorded only, no policy)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      const out = runInit(projectPath, {
        language: typeof opts.language === "string" ? opts.language : undefined,
        gasparAutonomy: typeof opts.gasparAutonomy === "string" ? opts.gasparAutonomy : undefined,
        runtime: typeof opts.runtime === "string" ? opts.runtime : null,
        json: opts.json === true,
      });
      if (out.stdout !== "") {
        console.log(out.stdout);
      }
      if (out.stderr !== "") {
        console.error(out.stderr);
      }
      if (out.exitCode !== 0) {
        program.error("", { exitCode: out.exitCode });
      }
    });

  program
    .command("status")
    .description("Show deterministic project status")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      const out = runStatus(projectPath, { json: opts.json === true });
      if (out.stdout !== "") {
        console.log(out.stdout);
      }
      if (out.stderr !== "") {
        console.error(out.stderr);
      }
      if (out.exitCode !== 0) {
        program.error("", { exitCode: out.exitCode });
      }
    });

  program
    .command("validate")
    .description("Run deterministic project validation (fail-closed)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      const out = runValidate(projectPath, { json: opts.json === true });
      if (out.stdout !== "") {
        console.log(out.stdout);
      }
      if (out.stderr !== "") {
        console.error(out.stderr);
      }
      if (out.exitCode !== 0) {
        program.error("", { exitCode: out.exitCode });
      }
    });

  program
    .command("approve")
    .description("Record an interactive human-only signed PO approval")
    .requiredOption("--action <action>", "approval action (module-approval, architecture-security, implementation-security)")
    .requiredOption("--scope <id>", "artifact scope identifier (or ARCH)")
    .requiredOption("--revision <rev>", "exact scope revision hash")
    .requiredOption("--authority <name>", "PO signer identity")
    .requiredOption("--rationale <text>", "decision rationale")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      const out = runApprove(projectPath, {
        action: String(opts.action ?? ""),
        scope: String(opts.scope ?? ""),
        revision: String(opts.revision ?? ""),
        authority: String(opts.authority ?? ""),
        rationale: String(opts.rationale ?? ""),
        json: opts.json === true,
      });
      emitProgramResult(program, out);
    });

  program
    .command("waive")
    .description("Record an interactive human-only signed PO waiver")
    .requiredOption("--scope <id>", "artifact scope identifier")
    .requiredOption("--revision <rev>", "exact scope revision hash")
    .requiredOption("--authority <name>", "PO signer identity")
    .requiredOption("--issue <text>", "issue description")
    .requiredOption("--rationale <text>", "acceptance rationale")
    .requiredOption("--expiry <condition>", "expiry/review condition")
    .option("--evidence <ref>", "evidence reference")
    .option("--controls <text>", "compensating controls")
    .option("--follow-up <id>", "follow-up task")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      const out = runWaive(projectPath, {
        scope: String(opts.scope ?? ""),
        revision: String(opts.revision ?? ""),
        authority: String(opts.authority ?? ""),
        issue: String(opts.issue ?? ""),
        rationale: String(opts.rationale ?? ""),
        expiry: String(opts.expiry ?? ""),
        evidenceRef: typeof opts.evidence === "string" ? opts.evidence : null,
        controls: typeof opts.controls === "string" ? opts.controls : null,
        followUp: typeof opts.followUp === "string" ? opts.followUp : null,
        json: opts.json === true,
      });
      emitProgramResult(program, out);
    });

  const keys = program.command("keys").description("PO signing-key management");

  keys
    .command("generate")
    .description("Generate an Ed25519 PO key (private to OS keychain, public to project)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--rotate", "replace the active key with a signed rotation")
    .option("--rationale <text>", "rationale bound into a rotation signature")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      emitProgramResult(
        program,
        runKeysGenerate(projectPath, {
          rotate: opts.rotate === true,
          ...(typeof opts.rationale === "string" ? { rationale: opts.rationale } : {}),
          json: opts.json === true,
        })
      );
    });

  program
    .command("gate")
    .description("Evaluate a Core gate (adapters and pre-tool hooks must obey the result)")
    .argument("<gate>", "gate name (execution, completion)")
    .option("--module <id>", "module scope")
    .option("--wp <id>", "work-package scope")
    .option("--as <actor>", "requesting identity (canonical role)")
    .option("--role <role>", "assigned implementation role (execution gate)")
    .option("--session-token <id/token>", "executor session credential (or CHRONO_SESSION_TOKEN)")
    .option("--requester-token <id/token>", "requester session credential for orchestrated execution")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((gate: string, opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      emitProgramResult(
        program,
        runGate(projectPath, {
          gate,
          module: typeof opts.module === "string" ? opts.module : undefined,
          wp: typeof opts.wp === "string" ? opts.wp : undefined,
          as: typeof opts.as === "string" ? opts.as : undefined,
          role: typeof opts.role === "string" ? opts.role : undefined,
          sessionToken: typeof opts.sessionToken === "string" ? opts.sessionToken : undefined,
          requesterToken: typeof opts.requesterToken === "string" ? opts.requesterToken : undefined,
          json: opts.json === true,
        })
      );
    });

  const rtk = program.command("rtk").description("RTK attestation");

  rtk
    .command("status")
    .description("Show RTK attestation currency")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      emitProgramResult(program, runAttestationStatus(projectPath, "rtk", { json: opts.json === true }));
    });

  rtk
    .command("verify")
    .description("Verify a genuine RTK installation (runs rtk --version and rtk gain)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--binary <path>", "rtk binary (default: rtk from PATH)")
    .option("--session-token <id/token>", "caller session credential (or CHRONO_SESSION_TOKEN)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      const token = resolveSessionToken(typeof opts.sessionToken === "string" ? opts.sessionToken : undefined);
      emitProgramResult(
        program,
        runRtkVerify(projectPath, {
          ...(typeof opts.binary === "string" ? { binaryPath: opts.binary } : {}),
          ...(token === null ? {} : { session: token }),
        })
      );
    });

  const skill = program.command("skill").description("process-skill attestation");

  skill
    .command("status")
    .description("Show skill attestation currency")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      emitProgramResult(program, runAttestationStatus(projectPath, "skill", { json: opts.json === true }));
    });

  skill
    .command("verify")
    .description("Re-verify the pinned Karpathy Guidelines skill (fail-closed until release metadata lands)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--session-token <id/token>", "caller session credential (or CHRONO_SESSION_TOKEN)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      emitProgramResult(program, runSkillVerify(projectPath, { json: opts.json === true }));
    });

  program
    .command("run")
    .description("Authorize and dispatch a command through a registered adapter (Core-authorized, evidence-recorded)")
    .requiredOption("--module <id>", "module scope")
    .option("--wp <id>", "work-package scope")
    .requiredOption("--adapter <id>", "registered runtime adapter id")
    .requiredOption("--as <actor>", "requesting identity (canonical role)")
    .requiredOption("--requester-token <id/token>", "requester session credential")
    .requiredOption("--role <role>", "assigned implementation role (executor)")
    .option("--session-token <id/token>", "executor session credential (or CHRONO_SESSION_TOKEN)")
    .option("--timeout <seconds>", "command timeout in seconds (default 600)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .argument("<command...>", "command to dispatch (must start with the adapter entrypoint)")
    .action((command: string[], opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      const timeout = typeof opts.timeout === "string" ? Number(opts.timeout) : undefined;
      emitProgramResult(
        program,
        runDispatch(projectPath, {
          module: String(opts.module ?? ""),
          ...(typeof opts.wp === "string" ? { wp: opts.wp } : {}),
          adapter: String(opts.adapter ?? ""),
          as: String(opts.as ?? ""),
          requesterToken: String(opts.requesterToken ?? ""),
          role: String(opts.role ?? ""),
          ...(typeof opts.sessionToken === "string" ? { sessionToken: opts.sessionToken } : {}),
          command,
          ...(timeout !== undefined && Number.isFinite(timeout) ? { timeoutSeconds: timeout } : {}),
          json: opts.json === true,
        })
      );
    });

  const session = program.command("session").description("authenticated session management");

  session
    .command("open")
    .description("Open an authenticated session (interactive, or delegated from a parent session token)")
    .requiredOption("--role <role>", "canonical agent role (or PO)")
    .requiredOption("--adapter <name>", "adapter holding the token")
    .requiredOption("--runtime <name>", "runtime the session operates in")
    .option("--scope-module <id>", "assigned module scope (required for worker roles)")
    .option("--scope-wp <id>", "assigned work-package scope")
    .option("--ttl <seconds>", "lifetime in seconds (default 3600, max 86400)")
    .option("--parent-token <id/token>", "delegate from an existing session instead of a terminal")
    .option("--rationale <text>", "purpose bound into a privileged-session PO signature")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      const ttl = typeof opts.ttl === "string" ? Number(opts.ttl) : undefined;
      emitProgramResult(
        program,
        runSessionOpen(
          projectPath,
          {
            role: String(opts.role ?? ""),
            adapter: String(opts.adapter ?? ""),
            runtime: String(opts.runtime ?? ""),
            ...(typeof opts.scopeModule === "string" ? { scopeModule: opts.scopeModule } : {}),
            ...(typeof opts.scopeWp === "string" ? { scopeWp: opts.scopeWp } : {}),
            ...(ttl !== undefined && Number.isFinite(ttl) ? { ttlSeconds: ttl } : {}),
            ...(typeof opts.parentToken === "string" ? { parentToken: opts.parentToken } : {}),
            ...(typeof opts.rationale === "string" ? { rationale: opts.rationale } : {}),
            json: opts.json === true,
          }
        )
      );
    });

  session
    .command("revoke")
    .description("Revoke a session (gaspar/PO caller with a valid session)")
    .argument("<id>", "session id")
    .requiredOption("--as <actor>", "requesting identity")
    .requiredOption("--session-token <id/token>", "caller session credential (or CHRONO_SESSION_TOKEN)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((id: string, opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      const token = resolveSessionToken(typeof opts.sessionToken === "string" ? opts.sessionToken : undefined);
      if (token === null || typeof opts.as !== "string") {
        emitProgramResult(
          program,
          opts.json === true
            ? { exitCode: 2, stdout: JSON.stringify({ ok: false, error: { code: "VALIDATION_ERROR", message: "revoke requires --as and --session-token" } }, null, 2), stderr: "" }
            : { exitCode: 2, stdout: "", stderr: "Error [VALIDATION_ERROR]: revoke requires --as and --session-token" }
        );
        return;
      }
      emitProgramResult(
        program,
        runSessionRevoke(projectPath, id, { actor: opts.as, session: token }, { json: opts.json === true })
      );
    });

  return program;
}

/** Print a CliOutput and raise the commander's exit override on failure. */
function emitProgramResult(program: Command, out: CliOutput): void {
  if (out.stdout !== "") {
    console.log(out.stdout);
  }
  if (out.stderr !== "") {
    console.error(out.stderr);
  }
  if (out.exitCode !== 0) {
    program.error("", { exitCode: out.exitCode });
  }
}
