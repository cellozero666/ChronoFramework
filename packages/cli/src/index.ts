/**
 * CHRONO CLI — minimal usable interface to the deterministic Core.
 * [Slice 5] — CLI code delegates to Core services; it owns no CHRONO policy.
 *
 * Commands: init, status, validate. Each returns a CliOutput with an exit
 * code so adapters and tests can consume decisions deterministically.
 */

import { Command } from "commander";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, accessSync, constants, openSync, readSync, writeSync, closeSync, existsSync } from "node:fs";
import { get } from "node:https";
import { dirname, join, delimiter as pathDelimiter } from "node:path";
import { ChronoCore } from "@chrono/core";
import { RTK_UPSTREAM, SKILL_RELEASE, SKILL_RUNTIME_PATHS, buildApprovalPayload, buildEnrollmentChallenge, buildEnrollmentPayload, buildSessionAuthorizationPayload, buildWaiverPayload, computeRevisionHash, convertSkillSource, fingerprintPublicKey, generateApprovalKeyPair, parseSkillFrontmatter, signApprovalPayload, skillGeneratedHashes, skillRawSourceUrl, skillVendorPath, verifySkillRelease, type SkillRuntime } from "@chrono/domain";
import { CHRONO_VERSION } from "./version.js";
import { buildOpencodePlugin } from "./opencode-plugin.js";
import { CLAUDE_HOOK_RELATIVE_PATH, CLAUDE_SETTINGS_RELATIVE_PATH, buildClaudeHook, mergeClaudeHookGroup, mergeClaudeSettings } from "./claude-hook.js";
import { KIRO_HOOK_REGISTRATION_RELATIVE_PATH, KIRO_HOOK_RELATIVE_PATH, buildKiroHook, buildKiroHookRegistration } from "./kiro-hook.js";
import {
  ENTRY_SESSION_SCRIPT_RELATIVE_PATH,
  GASPAR_DEFINITION_RELATIVE_PATH,
  buildEntrySessionScript,
  buildGasparDefinition,
  buildKiroEntryRegistration,
  entrySessionCommand,
  kiroEntryRegistrationPath,
} from "./gaspar-entry.js";
import {
  CHRONO_OPENCODE_ROLES,
  OPENCODE_CONFIG_SIDECAR_RELATIVE,
  applyOpenCodeDefaultAgent,
  buildOpenCodeAgentDefinition,
  openCodeAgentPath,
} from "./opencode-agent.js";
import {
  ENTRY_COMMAND_NAME,
  ENTRY_OPTIONS,
  entryCommanderOption,
} from "./entry-contract.js";
import { constructionFailure, openReadProject, resolveProjectDir } from "./project.js";
import { runArtifactPropose, runArtifactRevise, runArtifactStatus } from "./artifact-cli.js";

export { buildOpencodePlugin };
export { CLAUDE_HOOK_RELATIVE_PATH, CLAUDE_SETTINGS_RELATIVE_PATH, buildClaudeHook, mergeClaudeHookGroup, mergeClaudeSettings };
export { KIRO_HOOK_REGISTRATION_RELATIVE_PATH, KIRO_HOOK_RELATIVE_PATH, buildKiroHook, buildKiroHookRegistration };
export { findProjectRoot, resolveProject, resolveProjectDir, openReadProject, constructionFailure } from "./project.js";
export type { ProjectResolution } from "./project.js";
import {
  MemoryKeyStore,
  OsKeychainStore,
  PO_KEY_ACCOUNT,
  PO_KEY_SERVICE,
  PO_KEY_STAGING_ACCOUNT,
  isInteractiveTerminal,
  readPoPrivateKey,
  verifyKeyCustody,
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
  readonly kind?: unknown;
  readonly title?: unknown;
  readonly bodyFile?: unknown;
  readonly ref?: unknown;
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
  readonly spec?: unknown;
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
  readonly file?: unknown;
  readonly approval?: unknown;
  readonly id?: unknown;
  readonly proof?: unknown;
  readonly rtkBinary?: unknown;
  readonly yes?: unknown;
  readonly yesFiles?: unknown;
  readonly yesKeychain?: unknown;
  readonly yesNetwork?: unknown;
  readonly yesGlobal?: unknown;
  readonly dryRun?: unknown;
  readonly writePlan?: unknown;
  readonly fromPlan?: unknown;
  readonly tokenOut?: unknown;
  readonly broker?: unknown;
  readonly store?: unknown;
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
      pinnedVersion: CHRONO_VERSION,
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
 * Show deterministic project status. Delegates to Core.status().
 */
export function runStatus(projectPath: string, options: OutputOptions = {}): CliOutput {
  const asJson = options.json === true;
  const opened = openReadProject(projectPath, asJson);
  if ("failure" in opened) {
    return opened.failure;
  }
  const core = opened.core;
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
  const opened = openReadProject(projectPath, asJson);
  if ("failure" in opened) {
    return opened.failure;
  }
  const core = opened.core;
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
    core = new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const privateKey = readPoPrivateKey(deps.store);
    if (privateKey === null) {
      return approvalRequired(
        "No PO signing key in the OS keychain",
        "Run chrono enroll interactively to enroll a PO key, then retry",
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
    let signature: string;
    try {
      signature = signApprovalPayload(payload, privateKey);
    } catch {
      return coreError(
        { code: "SIGNATURE_INVALID", severity: "ERROR", message: "PO signing key is not usable for approvals" },
        asJson
      );
    }
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
    core = new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const privateKey = readPoPrivateKey(deps.store);
    if (privateKey === null) {
      return approvalRequired(
        "No PO signing key in the OS keychain",
        "Run chrono enroll interactively to enroll a PO key, then retry",
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
    let signature: string;
    try {
      signature = signApprovalPayload(payload, privateKey);
    } catch {
      return coreError(
        { code: "SIGNATURE_INVALID", severity: "ERROR", message: "PO signing key is not usable for waivers" },
        asJson
      );
    }
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

export interface EnrollOptions extends OutputOptions {
  readonly rationale?: string | undefined;
}

/**
 * Read one typed line from the controlling terminal (/dev/tty, CON on
 * Windows), bypassing stdin entirely. Returns null when no controlling
 * terminal is available or the line is empty: redirected, piped, or
 * captured input can never satisfy human confirmation [SLICE-9 §9.1].
 */
export function readConfirmationFromTty(challenge: string): string | null {
  const path = process.platform === "win32" ? "CON" : "/dev/tty";
  let fd = -1;
  try {
    fd = openSync(path, "r+");
  } catch {
    return null;
  }
  try {
    writeSync(fd, `\nCHRONO PO enrollment\nType exactly to confirm: ${challenge}\n> `);
    let line = "";
    const buf = Buffer.alloc(1);
    for (;;) {
      let n = 0;
      try {
        n = readSync(fd, buf, 0, 1, null);
      } catch {
        return null;
      }
      if (n === 0) {
        break;
      }
      const ch = buf.toString("utf8", 0, n);
      if (ch === "\n") {
        break;
      }
      if (ch === "\r") {
        continue;
      }
      line += ch;
      if (line.length > 512) {
        break;
      }
    }
    const typed = line.trim();
    return typed.length === 0 ? null : typed;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore close errors; the read result stands
    }
  }
}

/**
 * Initial PO enrollment ceremony: `chrono enroll` [SLICE-9 §9.1, P2.10].
 *
 * The CLI-owned ceremony requires a live terminal, an explicit rationale,
 * a human-typed confirmation read from /dev/tty (never stdin), and
 * possession of the freshly generated private key (used to sign the
 * enrollment proof). The private key reaches the OS keychain BEFORE the
 * Core persists anything, and the previous keychain value is restored if
 * enrollment fails — partial failure never bricks PO authority and never
 * leaks key material to output, logs, or the project.
 */
export function runEnroll(
  projectPath: string,
  options: EnrollOptions = {},
  deps: HumanCommandDeps = productionDeps(),
  confirm: (challenge: string) => string | null = readConfirmationFromTty
): CliOutput {
  const asJson = options.json === true;
  if (!deps.interactive) {
    return humanOnlyRefusal("enroll", asJson);
  }
  const rationale = options.rationale?.trim() ?? "";
  if (rationale.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "enroll requires --rationale bound into the enrollment record" },
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
    if (core.poKeyRevision() !== null) {
      return approvalRequired(
        "A PO key is already enrolled for this project",
        "Rotate the active key with chrono keys generate --rotate; re-enrollment is denied",
        asJson
      );
    }
    const pair = generateApprovalKeyPair();
    const fingerprint = fingerprintPublicKey(pair.publicKeyPem);
    const nonce = randomBytes(16).toString("hex");
    const timestamp = new Date().toISOString();
    const challenge = buildEnrollmentChallenge("default", fingerprint, nonce);
    const typed = confirm(challenge);
    if (typed === null) {
      return approvalRequired(
        "PO enrollment requires a controlling terminal with typed confirmation",
        "Run chrono enroll in a live terminal and type the displayed challenge; redirected input is denied",
        asJson
      );
    }
    if (typed !== challenge) {
      return coreError(
        { code: "VALIDATION_ERROR", severity: "ERROR", message: "Enrollment confirmation does not match the ceremony challenge" },
        asJson
      );
    }
    let signature: string;
    try {
      signature = signApprovalPayload(
        buildEnrollmentPayload({
          projectId: "default",
          fingerprint,
          timestamp,
          nonce,
          authority: "PO",
          rationale,
          confirmation: typed,
        }),
        pair.privateKeyPem
      );
    } catch {
      return coreError(
        { code: "SIGNATURE_INVALID", severity: "ERROR", message: "Freshly generated PO key failed to sign" },
        asJson
      );
    }
    const previous = readPoKey(deps.store);
    try {
      deps.store.writeKey(PO_KEY_ACCOUNT, pair.privateKeyPem);
    } catch (e) {
      return keychainFailure(e, asJson);
    }
    if (!verifyKeyCustody(readPoKey(deps.store), pair.publicKeyPem)) {
      restorePreviousKey(deps.store, previous);
      return keychainFailure(
        new Error("Primary key verification failed before enrollment; previous custody restored."),
        asJson
      );
    }
    const enrolled = core.enrollPo({
      publicKeyPem: pair.publicKeyPem,
      nonce,
      timestamp,
      rationale,
      confirmation: typed,
      signature,
    });
    if (!enrolled.ok) {
      restorePreviousKey(deps.store, previous);
      return coreError(enrolled.error, asJson);
    }
    const body = asJson
      ? JSON.stringify({ ok: true, fingerprint: enrolled.value?.fingerprint }, null, 2)
      : ["PO enrolled.", `  key fingerprint: ${enrolled.value?.fingerprint ?? ""}`, "  private: OS keychain"].join("\n");
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

/** Best-effort custody restore after a failed enrollment (never throws). */
function restorePreviousKey(store: KeyStore, previous: string | null): void {
  try {
    if (previous === null) {
      store.deleteKey(PO_KEY_ACCOUNT);
    } else {
      store.writeKey(PO_KEY_ACCOUNT, previous);
    }
  } catch {
    // ignore: the failure is already being reported
  }
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
    core = new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const existingPrivate = readPoPrivateKey(deps.store);
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
    if (registeredRevision === null) {
      return approvalRequired(
        "No PO key enrolled for this project",
        "Run chrono enroll interactively to complete the enrollment ceremony first",
        asJson
      );
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
    if (!verifyKeyCustody(readPoKey(deps.store), pair.publicKeyPem)) {
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
  readonly spec?: string | undefined;
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
    // Gates authorize (minting grants) and audit every verdict, so they
    // open read-write; pure reads use openReadProject instead.
    core = new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
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
    if (options.gate === "architecture-approval") {
      const session = resolveSessionToken(options.sessionToken);
      if (session === null) {
        return respond(2, { result: "ERROR", code: "VALIDATION_ERROR", reason: "architecture-approval gate requires --session-token (or CHRONO_SESSION_TOKEN)" }, "Error [VALIDATION_ERROR]: architecture-approval gate requires --session-token (or CHRONO_SESSION_TOKEN)");
      }
      const result = core.gateArchitectureApproval({ actor: options.as, session });
      if (result.ok) {
        return respond(0, { result: "AUTHORIZED" }, "AUTHORIZED");
      }
      return respond(
        1,
        { result: "DENIED", code: result.error?.code ?? "EXECUTION_DENIED", reason: result.error?.message ?? "denied" },
        `DENIED [${result.error?.code ?? "EXECUTION_DENIED"}]: ${result.error?.message ?? "denied"}`
      );
    }
    if (options.gate === "spec-ready") {
      if (options.spec === undefined || options.spec.length === 0) {
        return respond(2, { result: "ERROR", code: "VALIDATION_ERROR", reason: "spec-ready gate requires --spec" }, "Error [VALIDATION_ERROR]: spec-ready gate requires --spec");
      }
      const session = resolveSessionToken(options.sessionToken);
      if (session === null) {
        return respond(2, { result: "ERROR", code: "VALIDATION_ERROR", reason: "spec-ready gate requires --session-token (or CHRONO_SESSION_TOKEN)" }, "Error [VALIDATION_ERROR]: spec-ready gate requires --session-token (or CHRONO_SESSION_TOKEN)");
      }
      const result = core.gateSpecReady(options.spec, { actor: options.as, session });
      if (result.ok) {
        return respond(0, { result: "AUTHORIZED" }, "AUTHORIZED");
      }
      return respond(
        1,
        { result: "DENIED", code: result.error?.code ?? "EXECUTION_DENIED", reason: result.error?.message ?? "denied" },
        `DENIED [${result.error?.code ?? "EXECUTION_DENIED"}]: ${result.error?.message ?? "denied"}`
      );
    }
    if (options.gate === "verification") {
      if (options.module === undefined || options.module.length === 0) {
        return respond(2, { result: "ERROR", code: "VALIDATION_ERROR", reason: "verification gate requires --module" }, "Error [VALIDATION_ERROR]: verification gate requires --module");
      }
      const session = resolveSessionToken(options.sessionToken);
      if (session === null) {
        return respond(2, { result: "ERROR", code: "VALIDATION_ERROR", reason: "verification gate requires --session-token (or CHRONO_SESSION_TOKEN)" }, "Error [VALIDATION_ERROR]: verification gate requires --session-token (or CHRONO_SESSION_TOKEN)");
      }
      const result = core.gateVerification(options.module, options.wp ?? null, { actor: options.as, session });
      if (result.ok) {
        return respond(0, { result: "AUTHORIZED" }, "AUTHORIZED");
      }
      return respond(
        1,
        { result: "DENIED", code: result.error?.code ?? "COMPLETION_DENIED", reason: result.error?.message ?? "denied" },
        `DENIED [${result.error?.code ?? "COMPLETION_DENIED"}]: ${result.error?.message ?? "denied"}`
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
  const opened = openReadProject(projectPath, asJson);
  if ("failure" in opened) {
    return opened.failure;
  }
  const core = opened.core;
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
  options: OutputOptions & {
    binaryPath?: string;
    session?: { id: string; token: string };
    resolveBinary?: ((binary: string) => string | null) | undefined;
  } = {},
  exec: (binary: string, args: string[]) => { exitCode: number; stdout: string } = defaultExec
): CliOutput {
  const asJson = options.json === true;
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
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
    const requested = options.binaryPath ?? "rtk";
    // Resolve to an absolute path BEFORE executing or recording: the
    // attestation's binaryPath must match the resolved path that
    // `rtk prove` (and dispatch-time hash checks) use, or every proof
    // fails closed on version/binary mismatch.
    const resolve = options.resolveBinary ?? resolveExecutable;
    const binary = resolve(requested);
    if (binary === null) {
      return rtkBlocked(`RTK binary '${requested}' not found: install Rust Token Killer from ${RTK_UPSTREAM}`, asJson);
    }
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
      routingTestLog: "attestation only: effective routing is proven per adapter through chrono rtk prove",
      gained: true,
      savingsEvidence: gain.stdout.slice(0, 2000),
      ttlSeconds: 3600,
    });
    if (!recorded.ok) {
      return coreError(recorded.error, asJson);
    }
    const body = asJson
      ? JSON.stringify({ ok: true, id: recorded.value?.id, version, routingProven: false }, null, 2)
      : `RTK verified (${version}); attestation '${recorded.value?.id}'. Routing is recorded unproven: per-command routing enforcement is adapter duty (see RUNTIME §6.3).`;
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

export interface RtkProveOptions extends OutputOptions {
  readonly adapter: string;
  readonly as?: string | undefined;
  readonly session?: { id: string; token: string } | undefined;
  readonly binary?: string | undefined;
  readonly resolveBinary?: ((binary: string) => string | null) | undefined;
  readonly ttlSeconds?: number | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly command: string[];
}

/**
 * Resolve a binary name to an absolute executable path for proof
 * binding (PATH search, no shell). Returns null when not found.
 */
export function resolveExecutable(binary: string): string | null {
  if (binary.length === 0) {
    return null;
  }
  const candidates =
    binary.includes("/") || (process.platform === "win32" && binary.includes("\\"))
      ? [binary]
      : (process.env["PATH"] ?? "").split(pathDelimiter).map((dir) => join(dir, binary));
  const suffixed =
    process.platform === "win32"
      ? candidates.flatMap((c) => [c, `${c}.exe`, `${c}.cmd`, `${c}.bat`])
      : candidates;
  for (const candidate of suffixed) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Maximum routed-command output hashed into a routing proof (8 MiB).
 * Larger outputs cannot be proven: hashing unbounded agent-visible
 * output into SQLite risks disk/memory exhaustion and the output is
 * never printed or persisted anyway [FIXES-SL-10.1 C2].
 */
export const RTK_PROOF_OUTPUT_CAP_BYTES = 8 * 1024 * 1024;

/**
 * RTK identity/operational command heads that can never demonstrate
 * effective interception [FIXES-SL-10.1 C2]. `gain`/`--version` prove
 * the genuine binary and its dashboard (verified by `rtk verify`), but
 * no runtime command passes through the hook path for them; the
 * operational heads (`config`, `init`, `help`) likewise route nothing.
 * Matching is exact and case-sensitive: anything else flows to
 * `rtk rewrite`, which refuses what it cannot map.
 */
const IDENTITY_ONLY_RTK_COMMANDS = new Set([
  "gain",
  "version",
  "--version",
  "-V",
  "config",
  "init",
  "help",
  "-h",
  "--help",
]);

export function isIdentityOnlyRtkCommand(head: string): boolean {
  return IDENTITY_ONLY_RTK_COMMANDS.has(head);
}

/**
 * RTK routing proof: `chrono rtk prove` (Slice 9 §9.3, [P8.5, INV §8.4],
 * ADR-006). Proves EFFECTIVE interception through the genuine RTK binary:
 * the raw pre-routing command is mapped with `rtk rewrite` (the documented
 * single source of truth for hooks), the mapped command is executed, and
 * exit status plus output hash are bound with adapter, runtime, session,
 * project, RTK identity, timestamp, and TTL.
 *
 * Recorded proofs are non-authoritative CANDIDATE rows: they authorize
 * nothing until `chrono rtk promote` (PO session) promotes them after
 * signed adapter approval. Identity-only commands (`gain`, `--version`,
 * `config`, `init`, `help`) and already-routed `rtk ...` inputs can never
 * prove routing and are denied. Raw output is hashed, capped, and never
 * printed or persisted.
 */
export function runRtkProve(
  projectPath: string,
  options: RtkProveOptions,
  spawn: (cmd: string, args: string[], timeoutMs: number, env: Record<string, string>) => SpawnResult = defaultSpawn
): CliOutput {
  const asJson = options.json === true;
  const fail = (exitCode: number, code: string, reason: string): CliOutput =>
    asJson
      ? { exitCode, stdout: JSON.stringify({ ok: false, error: { code, message: reason } }, null, 2), stderr: "" }
      : { exitCode, stdout: "", stderr: `Error [${code}]: ${reason}` };
  if (options.adapter.length === 0) {
    return fail(2, "VALIDATION_ERROR", "rtk prove requires --adapter <runtime adapter id>");
  }
  if (options.as === undefined || options.as.length === 0) {
    return fail(2, "VALIDATION_ERROR", "rtk prove requires --as <actor> matching the caller session");
  }
  if (options.session === undefined) {
    return fail(2, "VALIDATION_ERROR", "rtk prove requires --session-token");
  }
  if (options.command.length === 0) {
    return fail(2, "VALIDATION_ERROR", "rtk prove requires a command after --");
  }
  const ttlSeconds = options.ttlSeconds ?? 3600;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 86400) {
    return fail(2, "VALIDATION_ERROR", "rtk prove --ttl must be within 1 second and 24 hours");
  }
  const timeoutSeconds = options.timeoutSeconds ?? 120;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 3600) {
    return fail(2, "VALIDATION_ERROR", "rtk prove --timeout must be within 1 second and 1 hour");
  }
  const binary = options.binary ?? "rtk";
  const raw = options.command;
  if (raw.length === 0) {
    return fail(2, "VALIDATION_ERROR", "rtk prove requires a raw pre-routing command after -- (for example: ls <dir>)");
  }
  if (raw[0] === binary || (raw[0] !== undefined && raw[0].endsWith(`/${binary}`))) {
    return fail(2, "VALIDATION_ERROR", `rtk prove takes the raw pre-routing command without the RTK prefix (for example: ls <dir>, not rtk ls <dir>): the flow maps it through '${binary} rewrite' itself`);
  }
  if (isIdentityOnlyRtkCommand(raw[0] ?? "")) {
    return fail(1, "RTK_ROUTING_FAILURE", `identity-only command '${raw[0] ?? ""}' cannot prove routing: use a command RTK actually routes (for example: ls <dir>)`);
  }
  const resolved = (options.resolveBinary ?? resolveExecutable)(binary);
  if (resolved === null) {
    return fail(1, "BLOCKED_RTK", `RTK binary '${binary}' not found: install Rust Token Killer from ${RTK_UPSTREAM}`);
  }
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const versionResult = spawn(resolved, ["--version"], 30000, {});
    if (versionResult.status !== 0) {
      return fail(1, "BLOCKED_RTK", `RTK binary '${binary}' --version failed`);
    }
    const version = versionResult.stdout.trim().split("\n")[0] ?? "unknown";
    const gainResult = spawn(resolved, ["gain"], 120000, {});
    if (gainResult.status !== 0) {
      return fail(1, "RTK_NAME_COLLISION", "rtk gain failed: the binary is not proven Rust Token Killer");
    }
    const rewritten = spawn(resolved, ["rewrite", ...raw], 60000, {});
    // Deliberately exit-agnostic: `rtk rewrite --help` claims 0-with-map
    // / 1-empty, but genuine RTK 0.44.0 exits 3 with a mapping and 1
    // empty without one (production-path trace, FIXES-SL-10.1 gate
    // item 5). Stdout presence is the contract: a mapping must parse
    // and resolve to the genuine binary, otherwise no routing is proven.
    const mappedText = rewritten.stdout.trim();
    const mapped = mappedText.length === 0 ? null : splitCommandLine(mappedText);
    if (mapped === null || mapped.length === 0) {
      return fail(1, "RTK_ROUTING_FAILURE", "RTK refused to map the command: no interception route exists for this input");
    }
    const mappedHead = mapped[0] as string;
    const mappedResolved = (options.resolveBinary ?? resolveExecutable)(mappedHead);
    if (mappedResolved === null || mappedResolved !== resolved) {
      return fail(1, "RTK_ROUTING_FAILURE", "RTK mapping escapes the genuine RTK binary: no routing proven");
    }
    if (mapped.length < 2) {
      // A bare binary with no routed subcommand proves nothing was
      // intercepted: refuse even if executing it would exit 0.
      return fail(1, "RTK_ROUTING_FAILURE", "RTK mapping contains no routed command: no routing proven");
    }
    const routed = [resolved, ...mapped.slice(1)];
    const ran = spawn(resolved, mapped.slice(1), Math.floor(timeoutSeconds * 1000), {});
    if (ran.timedOut) {
      return fail(1, "RTK_ROUTING_FAILURE", `routed command timed out after ${timeoutSeconds}s: no routing proven`);
    }
    if (ran.status !== 0) {
      return fail(1, "RTK_ROUTING_FAILURE", `routed command failed with exit ${String(ran.status)}: only successful routings prove effectiveness`);
    }
    if (ran.stdout.length > RTK_PROOF_OUTPUT_CAP_BYTES) {
      return fail(1, "RTK_ROUTING_FAILURE", `routed output exceeds the ${String(RTK_PROOF_OUTPUT_CAP_BYTES)} byte provability cap: refusing to record`);
    }
    const recorded = core.recordRoutingProof(
      { actor: options.as, session: options.session },
      {
        adapterId: options.adapter,
        binaryPath: resolved,
        version,
        proofCommand: JSON.stringify(routed),
        preRoutingCommand: JSON.stringify(raw),
        commandHash: computeRevisionHash({ pre: raw, routed }),
        outputHash: computeRevisionHash(ran.stdout),
        exitStatus: 0,
        gainAvailable: true,
        timestamp: new Date().toISOString(),
        ttlSeconds,
      }
    );
    if (!recorded.ok) {
      return coreError(recorded.error, asJson);
    }
    const body = asJson
      ? JSON.stringify({ ok: true, id: recorded.value?.id, adapter: options.adapter, version, authority: "candidate" }, null, 2)
      : `Routing candidate recorded through '${binary}' (${version}) for adapter '${options.adapter}': proof '${recorded.value?.id ?? ""}' is non-authoritative until 'chrono rtk promote --proof ${recorded.value?.id ?? "<id>"}' runs after signed adapter approval.`;
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

/**
 * RTK routing-proof promotion: `chrono rtk promote` (ADR-006,
 * [FIXES-SL-10.1 C3]). Promotes a recorded CANDIDATE proof to
 * AUTHORITATIVE after the PO's signed adapter approval. PO session
 * required (`adapter.approve` capability): promotion executes a prior
 * approval, never substitutes for it. The Core re-validates attestation
 * currency, binary identity, adapter approval, and the managed-asset
 * manifest, then snapshots the registration and asset hashes; dispatch
 * re-validates both, so later drift invalidates. Already-authoritative
 * proofs return unchanged (idempotent, safe for resume).
 */
export interface RtkPromoteOptions extends OutputOptions {
  readonly proof: string;
  readonly as?: string | undefined;
  readonly session?: { id: string; token: string } | undefined;
}

export function runRtkPromote(projectPath: string, options: RtkPromoteOptions): CliOutput {
  const asJson = options.json === true;
  const fail = (exitCode: number, code: string, reason: string): CliOutput =>
    asJson
      ? { exitCode, stdout: JSON.stringify({ ok: false, error: { code, message: reason } }, null, 2), stderr: "" }
      : { exitCode, stdout: "", stderr: `Error [${code}]: ${reason}` };
  if (options.proof.length === 0) {
    return fail(2, "VALIDATION_ERROR", "rtk promote requires --proof <routing proof id>");
  }
  if (options.as === undefined || options.as.length === 0) {
    return fail(2, "VALIDATION_ERROR", "rtk promote requires --as <actor> matching the caller session");
  }
  if (options.session === undefined) {
    return fail(2, "VALIDATION_ERROR", "rtk promote requires --session-token");
  }
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const promoted = core.promoteRoutingProof(options.proof, { actor: options.as, session: options.session });
    if (!promoted.ok) {
      return coreError(promoted.error, asJson);
    }
    const body = asJson
      ? JSON.stringify({ ok: true, id: promoted.value?.id, authority: "authoritative" }, null, 2)
      : `Routing proof '${promoted.value?.id ?? ""}' promoted to authoritative: dispatch may now consume it while its bindings stay current.`;
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

/**
 * Skill verification against the PO-approved release pin (Slice 7,
 * [CORE §11, PL Phase 4, FW §1222]): fetch the immutable commit, verify
 * the byte-exact source hash, validate frontmatter, refuse on divergence
 * from the latest stored attestation, emit vendor + runtime artifacts
 * deterministically, prove discovery + activation at rest, and record the
 * SkillAttestation through the Core. No LLM rewriting anywhere; the fetch
 * is injectable so tests never touch the network.
 */
export interface SkillVerifyOptions extends OutputOptions {
  readonly as?: string | undefined;
  readonly session?: { id: string; token: string } | undefined;
  readonly ttlSeconds?: number | undefined;
}

export function defaultFetchSkillSource(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      { timeout: 30000 },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Skill fetch failed: HTTP ${String(response.statusCode)} for ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            request.destroy(new Error("Skill source exceeds the 1 MiB size cap"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
        response.on("error", reject);
      }
    );
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error("Skill fetch timed out after 30s"));
    });
  });
}

export async function runSkillVerify(
  projectPath: string,
  options: SkillVerifyOptions = {},
  fetchSource: (url: string) => Promise<string> = defaultFetchSkillSource
): Promise<CliOutput> {
  const asJson = options.json === true;
  const fail = (exitCode: number, code: string, reason: string): CliOutput =>
    asJson
      ? { exitCode, stdout: JSON.stringify({ ok: false, error: { code, message: reason } }, null, 2), stderr: "" }
      : { exitCode, stdout: "", stderr: `Error [${code}]: ${reason}` };
  if (options.as === undefined || options.as.length === 0) {
    return fail(2, "VALIDATION_ERROR", "skill verify requires --as <gaspar|PO> matching the caller session");
  }
  if (options.session === undefined) {
    return fail(2, "VALIDATION_ERROR", "skill verify requires --session-token");
  }
  const ttlSeconds = options.ttlSeconds ?? 86400;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return fail(2, "VALIDATION_ERROR", "skill verify requires a positive --ttl");
  }
  const caller = { actor: options.as, session: options.session };
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    let fetched: string;
    try {
      fetched = await fetchSource(skillRawSourceUrl());
    } catch (e) {
      return fail(1, "BLOCKED_PROCESS_SKILL", `skill source fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    let canonical: string;
    try {
      canonical = verifySkillRelease(fetched);
    } catch (e) {
      return fail(1, skillErrorCode(e), skillErrorMessage(e));
    }
    const artifacts = convertSkillSource(canonical);
    const generatedHashes = skillGeneratedHashes(artifacts);
    const latest = core.describeSkillAttestation();
    if (latest !== null) {
      const diverged =
        latest.pinnedCommit !== SKILL_RELEASE.pinnedCommit ||
        latest.sourceHash !== SKILL_RELEASE.sourceHash ||
        latest.generatedHashes !== generatedHashes ||
        latest.converterVersion !== SKILL_RELEASE.converterVersion;
      if (diverged) {
        return fail(
          1,
          "SKILL_PROVENANCE_FAILURE",
          "Stored skill attestation diverges from the pinned release: refusing to record over divergence"
        );
      }
    }
    const targets: Array<[SkillRuntime, string]> = [
      ["claude", join(projectPath, SKILL_RUNTIME_PATHS.claude)],
      ["opencode", join(projectPath, SKILL_RUNTIME_PATHS.opencode)],
      ["kiro", join(projectPath, SKILL_RUNTIME_PATHS.kiro)],
    ];
    const vendorTarget = join(projectPath, skillVendorPath(SKILL_RELEASE.pinnedCommit));
    try {
      mkdirSync(dirname(vendorTarget), { recursive: true });
      writeFileSync(vendorTarget, canonical, "utf8");
      for (const [, target] of targets) {
        mkdirSync(dirname(target), { recursive: true });
      }
      writeFileSync(targets[0]![1], artifacts.claude, "utf8");
      writeFileSync(targets[1]![1], artifacts.opencode, "utf8");
      writeFileSync(targets[2]![1], artifacts.kiro, "utf8");
    } catch (e) {
      return fail(1, "BLOCKED_PROCESS_SKILL", `skill artifact emission failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Discovery + activation at rest: every emitted file must read back
    // byte-identical with the MIT license preserved. A corrupt or
    // rewritten file fails here, before anything is recorded.
    try {
      const vendorBack = readFileSync(vendorTarget, "utf8");
      if (vendorBack !== canonical) {
        return fail(1, "SKILL_ACTIVATION_FAILURE", "vendor source failed round-trip verification");
      }
      for (const [runtime, target] of targets) {
        const back = readFileSync(target, "utf8");
        if (back !== artifacts[runtime]) {
          return fail(1, "SKILL_ACTIVATION_FAILURE", `runtime artifact '${target}' failed round-trip verification`);
        }
        if (parseSkillFrontmatter(back).license !== SKILL_RELEASE.license) {
          return fail(1, "SKILL_ACTIVATION_FAILURE", `runtime artifact '${target}' lost its MIT license`);
        }
      }
    } catch (e) {
      return fail(1, "SKILL_ACTIVATION_FAILURE", `skill discovery failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const recorded = core.recordSkillAttestation(caller, {
      upstream: SKILL_RELEASE.upstream,
      pinnedCommit: SKILL_RELEASE.pinnedCommit,
      sourceHash: SKILL_RELEASE.sourceHash,
      generatedHashes,
      converterVersion: SKILL_RELEASE.converterVersion,
      licenseStatus: SKILL_RELEASE.license,
      attribution: "multica-ai/andrej-karpathy-skills (MIT)",
      runtimeIdentity: core.projectRuntime(),
      agentIdentity: "chrono-skill-verify",
      // "granted" records filesystem permission proven by emission +
      // round-trip above. Whether the live agent is permitted to use the
      // skill inside its runtime stays adapter duty (not proven here).
      discoveryResult: "found",
      permissionResult: "granted",
      activationTestPassed: true,
      ttlSeconds,
    });
    if (!recorded.ok) {
      return coreError(recorded.error, asJson);
    }
    const body = asJson
      ? JSON.stringify(
          { ok: true, id: recorded.value?.id, pinnedCommit: SKILL_RELEASE.pinnedCommit, sourceHash: SKILL_RELEASE.sourceHash },
          null,
          2
        )
      : `Skill verified (${SKILL_RELEASE.pinnedCommit}); attestation '${recorded.value?.id}'. Runtime artifacts emitted for claude, opencode, kiro.`;
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

function skillErrorCode(e: unknown): string {
  if (typeof e === "object" && e !== null && "code" in e && typeof e.code === "string") {
    return e.code;
  }
  return "BLOCKED_PROCESS_SKILL";
}

function skillErrorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string") {
    return e.message;
  }
  return String(e);
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
    core = new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
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
      const privateKey = readPoPrivateKey(deps.store);
      if (privateKey === null) {
        return approvalRequired(
          "Privileged sessions require the PO signing key from the OS keychain",
          "Run chrono enroll interactively to enroll a PO key, then retry with --rationale",
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
    core = new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
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
 * for the correction loop; nothing is marked complete. The bearer session
 * token never crosses into the child environment: the adapter process
 * holds its own token and the grant id binds the dispatch.
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
    core = new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    let adapter: { id: string; entrypoint: string };
    try {
      adapter = core.getAdapterForDispatch(options.adapter);
    } catch (e) {
      const code =
        typeof e === "object" && e !== null && "code" in e && typeof e.code === "string"
          ? e.code
          : "ADAPTER_REJECTED";
      const message = e instanceof Error ? e.message : "Adapter rejected for dispatch";
      return coreError({ code, severity: "BLOCKER", message }, asJson);
    }
    let commandHead: string;
    try {
      commandHead = realpathSync(options.command[0] as string);
    } catch {
      commandHead = options.command[0] as string;
    }
    if (commandHead !== adapter.entrypoint) {
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
      adapterId: adapter.id,
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
    // The bearer session token is deliberately NOT passed down: the
    // adapter process is the session holder and authenticates its hooks
    // with the token it was issued out-of-band. Copying it into a child
    // environment would expose it to model context [RUNTIME §10.3].
    const [cmd, ...args] = options.command as [string, ...string[]];
    // Narrow the check-then-spawn window: re-verify the entrypoint is
    // still executable immediately before spawning, and bind its content
    // hash into the evidence diagnostics for the audit trail.
    let entrypointHash: string;
    try {
      entrypointHash = createHash("sha256").update(readFileSync(cmd)).digest("hex");
      accessSync(cmd, constants.X_OK);
    } catch {
      return fail(1, "EXECUTION_DENIED", `adapter entrypoint '${cmd}' became unreadable or non-executable after authorization: re-verify and dispatch again`);
    }
    const ran = spawn(cmd, args, Math.floor(timeoutSeconds * 1000), env);
    if (ran.timedOut) {
      return fail(1, "EXECUTION_DENIED", `run timed out after ${timeoutSeconds}s: '${target}' stays ${started.value!.toState} for the correction loop`);
    }
    if (ran.status !== 0) {
      const detail = ran.stderr.trim().length > 0 ? ran.stderr.trim().slice(-2000) : `exit ${String(ran.status)}`;
      return fail(1, "EXECUTION_DENIED", `run command failed: ${detail}: '${target}' stays ${started.value!.toState} for the correction loop`);
    }
    const output = `entrypoint-sha256:${entrypointHash}\nstdout:\n${ran.stdout}\nstderr:\n${ran.stderr}`;
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
      adapterId: adapter.id,
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

export interface AdapterFileInput {
  readonly id: string;
  readonly name: string;
  readonly entrypoint: string;
  readonly gateHook?: string | undefined;
  readonly dispatchProof?: string | undefined;
  readonly rtkRouting?: string | undefined;
  readonly skillActivation?: string | undefined;
  readonly conformanceProof?: string[] | undefined;
}

const ADAPTER_FILE_KEYS = [
  "id",
  "name",
  "entrypoint",
  "gate_hook",
  "dispatch_proof",
  "rtk_routing",
  "skill_activation",
  "conformance_proof",
] as const;

/**
 * Strict intake parser for `RUNTIME §13` adapter registration files.
 * Accepts only a flat subset: `key: value` lines from the §13 schema plus
 * a `conformance_proof:` list of `- item` lines; full-line `#` comments
 * are ignored. Anything else (indentation, nesting, anchors, unknown or
 * duplicate keys) is rejected. The Core re-validates every field, so this
 * parser owns no policy — it only shapes the intake.
 */
export function parseAdapterFile(text: string): AdapterFileInput {
  const fields: Record<string, string> = {};
  const proof: string[] = [];
  let inProofList = false;
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] as string;
    const line = raw.replace(/\r$/, "");
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      continue;
    }
    if (line.startsWith(" ") || line.startsWith("\t")) {
      const item = line.match(/^(\s*)-\s+(.*)$/);
      if (inProofList && item !== null) {
        const value = (item[2] as string).trim();
        if (value.length === 0) {
          throw new Error(`Adapter file line ${String(index + 1)}: empty list item`);
        }
        proof.push(value);
        continue;
      }
      throw new Error(`Adapter file line ${String(index + 1)}: indentation is only allowed for conformance_proof items`);
    }
    inProofList = false;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new Error(`Adapter file line ${String(index + 1)}: expected 'key: value'`);
    }
    const key = line.slice(0, colon).trim();
    if (!(ADAPTER_FILE_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Adapter file line ${String(index + 1)}: unknown key '${key}'`);
    }
    if (seen.has(key)) {
      throw new Error(`Adapter file line ${String(index + 1)}: duplicate key '${key}'`);
    }
    seen.add(key);
    const rest = line.slice(colon + 1).trim();
    if (key === "conformance_proof") {
      if (rest.length !== 0) {
        throw new Error(`Adapter file line ${String(index + 1)}: conformance_proof takes '- item' lines, not an inline value`);
      }
      inProofList = true;
      continue;
    }
    fields[key] = unquoteAdapterValue(rest, index + 1);
  }
  const id = fields["id"] ?? "";
  const name = fields["name"] ?? "";
  const entrypoint = fields["entrypoint"] ?? "";
  if (id.length === 0 || name.length === 0 || entrypoint.length === 0) {
    throw new Error("Adapter file requires non-empty id, name, and entrypoint");
  }
  return {
    id,
    name,
    entrypoint,
    ...(fields["gate_hook"] !== undefined ? { gateHook: fields["gate_hook"] } : {}),
    ...(fields["dispatch_proof"] !== undefined ? { dispatchProof: fields["dispatch_proof"] } : {}),
    ...(fields["rtk_routing"] !== undefined ? { rtkRouting: fields["rtk_routing"] } : {}),
    ...(fields["skill_activation"] !== undefined ? { skillActivation: fields["skill_activation"] } : {}),
    ...(proof.length > 0 ? { conformanceProof: proof } : {}),
  };
}

function unquoteAdapterValue(value: string, lineNumber: number): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
    if (first === '"' || first === "'" || last === '"' || last === "'") {
      throw new Error(`Adapter file line ${String(lineNumber)}: unbalanced quotes`);
    }
  }
  return value;
}

export interface AdapterCommandAuth {
  readonly as: string;
  readonly session: { id: string; token: string };
}

/**
 * Register an adapter from a `RUNTIME §13` file. Creates a `pending`
 * row and reports the registration hash the PO must sign with
 * `chrono approve --action adapter-registration`.
 */
export function runAdapterRegister(
  projectPath: string,
  options: { file: string } & AdapterCommandAuth & OutputOptions
): CliOutput {
  const asJson = options.json === true;
  let text: string;
  try {
    text = readFileSync(options.file, "utf8");
  } catch (e) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: `Adapter file unreadable: ${e instanceof Error ? e.message : String(e)}` },
      asJson
    );
  }
  let input: AdapterFileInput;
  try {
    input = parseAdapterFile(text);
  } catch (e) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: `Adapter file rejected: ${e instanceof Error ? e.message : String(e)}` },
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
    const result = core.registerAdapter(input, { actor: options.as, session: options.session });
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const hash = core.adapterRegistrationHash(result.value!.id);
    const body = asJson
      ? JSON.stringify({ ok: true, id: result.value?.id, status: "pending", registrationHash: hash }, null, 2)
      : [`Registered adapter '${result.value?.id ?? ""}' (pending).`, `  registration hash: ${hash}`, "Activate with: chrono approve --action adapter-registration --scope <id> --revision <hash> ..."].join("\n");
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

/** List adapter registrations (read-only project metadata). */
export function runAdapterList(projectPath: string, options: OutputOptions = {}): CliOutput {
  const asJson = options.json === true;
  const opened = openReadProject(projectPath, asJson);
  if ("failure" in opened) {
    return opened.failure;
  }
  const core = opened.core;
  try {
    const adapters = core.listAdapters().map((a) => ({ id: a.id, name: a.name, entrypoint: a.entrypoint, status: a.status }));
    if (asJson) {
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, adapters }, null, 2), stderr: "" };
    }
    const lines = adapters.length === 0
      ? ["No adapters registered."]
      : adapters.map((a) => `${a.id} [${a.status}] ${a.name} (${a.entrypoint})`);
    return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
  } finally {
    core.close();
  }
}

/** Activate a pending adapter with its signed PO approval (PO only). */
export function runAdapterActivate(
  projectPath: string,
  options: { id: string; approval: string } & AdapterCommandAuth & OutputOptions
): CliOutput {
  const asJson = options.json === true;
  if (options.id.length === 0 || options.approval.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "adapter activate requires --id and --approval" },
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
    const result = core.approveAdapter(options.id, options.approval, { actor: options.as, session: options.session });
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const body = asJson
      ? JSON.stringify({ ok: true, id: options.id, status: "active" }, null, 2)
      : `Adapter '${options.id}' active.`;
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

/** Revoke an adapter registration (terminal; PO only). */
export function runAdapterRevoke(
  projectPath: string,
  options: { id: string } & AdapterCommandAuth & OutputOptions
): CliOutput {
  const asJson = options.json === true;
  if (options.id.length === 0) {
    return coreError(
      { code: "VALIDATION_ERROR", severity: "ERROR", message: "adapter revoke requires --id" },
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
    const result = core.revokeAdapter(options.id, { actor: options.as, session: options.session });
    if (!result.ok) {
      return coreError(result.error, asJson);
    }
    const body = asJson
      ? JSON.stringify(
          { ok: true, id: options.id, status: "revoked", revokedSessions: result.value?.revokedSessions ?? 0 },
          null,
          2
        )
      : `Adapter '${options.id}' revoked (sessions revoked: ${String(result.value?.revokedSessions ?? 0)}).`;
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

export interface SetupOptions {
  readonly adapter: string;
  readonly rtkBinary?: string | undefined;
  /** Known runtime id for runtime-scoped entry assets (opencode, claude-code, kiro). */
  readonly runtime?: string | undefined;
  readonly json?: boolean | undefined;
}

export interface SetupExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Minimal quotes-aware command-line splitter for registered proof
 * commands (single/double quotes, backslash escapes). Returns null on
 * unbalanced quotes instead of guessing.
 */
export function splitCommandLine(command: string): string[] | null {
  const argv: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;
  let hasToken = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      hasToken = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      hasToken = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }
    if (char === " " || char === "\t") {
      if (hasToken) {
        argv.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (escaped || quote !== null) {
    return null;
  }
  if (hasToken) {
    argv.push(current);
  }
  return argv;
}

function defaultSetupExec(cmd: string[], timeoutMs: number): SetupExecResult {
  const [binary, ...args] = cmd as [string, ...string[]];
  try {
    const result = spawnSync(binary, args, { encoding: "utf8", timeout: timeoutMs });
    return {
      exitCode: result.status ?? 1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  } catch (e) {
    return { exitCode: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Adapter setup: `chrono setup` (Slice 8, [PL Phase 5]).
 *
 * Verifies an adapter end to end and installs its project-local
 * enforcement assets — all fail-closed, nothing global touched:
 * active approved registration with a live entrypoint, genuine RTK
 * (`--version` + `gain`, same bar as `rtk verify`) with a current
 * attestation, current skill installation with intact artifacts, every
 * registered conformance proof executed green, and the OpenCode
 * pre-tool plugin written byte-identically. No state is persisted
 * beyond the installed files: the proofs themselves (adapter row,
 * attestations, skill files) are the persisted state.
 */
export function runSetup(
  projectPath: string,
  options: SetupOptions,
  exec: (cmd: string[], timeoutMs: number) => SetupExecResult = defaultSetupExec
): CliOutput {
  const asJson = options.json === true;
  const fail = (exitCode: number, code: string, reason: string): CliOutput =>
    asJson
      ? { exitCode, stdout: JSON.stringify({ ok: false, error: { code, message: reason } }, null, 2), stderr: "" }
      : { exitCode, stdout: "", stderr: `Error [${code}]: ${reason}` };
  if (options.adapter.length === 0) {
    return fail(2, "VALIDATION_ERROR", "setup requires --adapter <registered runtime id>");
  }
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    let adapter: { id: string; entrypoint: string; dispatchProof: string | null; conformanceProof: string[] };
    try {
      adapter = core.getAdapterForDispatch(options.adapter);
    } catch (e) {
      const code =
        typeof e === "object" && e !== null && "code" in e && typeof e.code === "string"
          ? e.code
          : "ADAPTER_REJECTED";
      return fail(1, code, e instanceof Error ? e.message : "Adapter rejected for dispatch");
    }
    const live = exec([adapter.entrypoint, "--version"], 30000);
    if (live.exitCode !== 0) {
      return fail(1, "CONFIG_ERROR", `adapter entrypoint '${adapter.entrypoint}' did not respond to --version`);
    }
    const rtkBinary = options.rtkBinary ?? "rtk";
    const rtkVersion = exec([rtkBinary, "--version"], 30000);
    if (rtkVersion.exitCode !== 0) {
      return fail(1, "BLOCKED_RTK", `RTK binary '${rtkBinary}' not found or not genuine: install Rust Token Killer from ${RTK_UPSTREAM}`);
    }
    const gain = exec([rtkBinary, "gain"], 120000);
    if (gain.exitCode !== 0) {
      return fail(1, "BLOCKED_RTK", "RTK_NAME_COLLISION: installed rtk is not Rust Token Killer (rtk gain failed)");
    }
    if (core.attestationCurrency("rtk").state !== "current") {
      return fail(1, "BLOCKED_RTK", "RTK attestation is not current: run chrono rtk verify first");
    }
    const rtkDetail = core.describeRtkAttestation();
    const routingProven = rtkDetail?.routingTestPassed === true;
    const skill = core.describeSkillInstallation();
    if (!skill.installed) {
      return fail(1, skill.code, skill.reason);
    }
    const proofs = [
      ...(adapter.dispatchProof !== null ? [adapter.dispatchProof] : []),
      ...adapter.conformanceProof,
    ];
    for (const proof of proofs) {
      const argv = splitCommandLine(proof);
      if (argv === null || argv.length === 0) {
        return fail(1, "CONFIG_ERROR", `adapter conformance proof is not a parseable command: '${proof}'`);
      }
      const ran = exec(argv, 120000);
      if (ran.exitCode !== 0) {
        return fail(1, "CONFIG_ERROR", `adapter conformance proof failed: '${proof}'`);
      }
    }
    const pluginPath = join(projectPath, ".opencode", "plugins", "chrono-gate.js");
    const claudeHookPath = join(projectPath, CLAUDE_HOOK_RELATIVE_PATH);
    const kiroHookPath = join(projectPath, KIRO_HOOK_RELATIVE_PATH);
    const kiroRegistrationPath = join(projectPath, KIRO_HOOK_REGISTRATION_RELATIVE_PATH);
    const claudeSettingsPath = join(projectPath, CLAUDE_SETTINGS_RELATIVE_PATH);
    const sessionScriptPath = join(projectPath, ENTRY_SESSION_SCRIPT_RELATIVE_PATH);
    const gasparDefinitionPath = join(projectPath, GASPAR_DEFINITION_RELATIVE_PATH);
    // Runtime scoping [OPENCODE-PILOT-GATE.md]: only the selected
    // runtime's integration assets are installed or modified, plus the
    // shared entry-session script every runtime redeems through.
    // Unknown adapter ids (no declared runtime) keep the legacy full
    // baseline — never guessed into a runtime, never silently narrowed.
    const runtimeId = options.runtime ?? null;
    const scopedRuntime = runtimeId === "opencode" || runtimeId === "claude-code" || runtimeId === "kiro" ? runtimeId : null;
    const writesOpencode = scopedRuntime === null || scopedRuntime === "opencode";
    const writesClaude = scopedRuntime === null || scopedRuntime === "claude-code";
    const writesKiro = scopedRuntime === null || scopedRuntime === "kiro";
    const writeBytes = (full: string, content: string): void => {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
    };
    try {
      writeBytes(sessionScriptPath, buildEntrySessionScript());
      if (writesOpencode) {
        writeBytes(pluginPath, buildOpencodePlugin());
        // Native primary-agent activation (OC-P10): the canonical role
        // definitions plus the project default_agent merge. The merge is
        // user-owned configuration: backup-once, comment-preserving,
        // model-neutral, fail-closed on ambiguity.
        for (const role of CHRONO_OPENCODE_ROLES) {
          writeBytes(join(projectPath, openCodeAgentPath(role)), buildOpenCodeAgentDefinition(role));
        }
        try {
          applyOpenCodeDefaultAgent(projectPath, "gaspar", CHRONO_VERSION);
        } catch (e) {
          return fail(2, "VALIDATION_ERROR", e instanceof Error ? e.message : "OpenCode default_agent merge refused");
        }
      }
      if (writesClaude) {
        writeBytes(claudeHookPath, buildClaudeHook());
      }
      if (writesKiro) {
        writeBytes(kiroHookPath, buildKiroHook());
        writeBytes(kiroRegistrationPath, buildKiroHookRegistration());
      }
      // Claude settings are user-owned: merge the managed entry only
      // when the Claude runtime is in scope, backing up before any
      // overwrite; malformed content fails with remediation.
      let existingSettings: string | null = null;
      if (writesClaude) {
        try {
          existingSettings = readFileSync(claudeSettingsPath, "utf8");
        } catch (e) {
          if ((e as { code?: string }).code !== "ENOENT") {
            throw e;
          }
        }
        let mergedSettings: { merged: string; changed: boolean };
        try {
          mergedSettings = mergeClaudeSettings(existingSettings);
        } catch (e) {
          return fail(2, "VALIDATION_ERROR", e instanceof Error ? e.message : "Claude settings merge refused");
        }
        if (mergedSettings.changed) {
          mkdirSync(dirname(claudeSettingsPath), { recursive: true });
          if (existingSettings !== null && !existsSync(`${claudeSettingsPath}.chrono-bak`)) {
            writeFileSync(`${claudeSettingsPath}.chrono-bak`, existingSettings, "utf8");
          }
          writeFileSync(claudeSettingsPath, mergedSettings.merged, "utf8");
        }
      }
      // Runtime-scoped entry assets, only when the adapter declares a
      // known runtime: Claude SessionStart bootstrap, Kiro SessionStart
      // registration, and the canonical Gaspar definition. Unknown
      // adapter ids keep the shared assets above (never guessed). The
      // `.chrono-bak` always preserves the pre-CHRONO original: an
      // existing backup is never overwritten by a later merge.
      const backUpOnce = (path: string, original: string | null): void => {
        if (original === null || existsSync(`${path}.chrono-bak`)) {
          return;
        }
        writeFileSync(`${path}.chrono-bak`, original, "utf8");
      };
      if (runtimeId === "claude-code") {
        const beforeSessionStart = readFileSync(claudeSettingsPath, "utf8");
        const sessionStart = mergeClaudeHookGroup(beforeSessionStart, "SessionStart", {
          hooks: [{ type: "command", command: entrySessionCommand(options.adapter), timeout: 60 }],
        });
        if (sessionStart.changed) {
          backUpOnce(claudeSettingsPath, existingSettings);
          writeFileSync(claudeSettingsPath, sessionStart.merged, "utf8");
        }
        mkdirSync(dirname(gasparDefinitionPath), { recursive: true });
        writeFileSync(gasparDefinitionPath, buildGasparDefinition(), "utf8");
      }
      if (runtimeId === "kiro") {
        const entryRegistrationPath = join(projectPath, kiroEntryRegistrationPath(options.adapter));
        mkdirSync(dirname(entryRegistrationPath), { recursive: true });
        writeFileSync(entryRegistrationPath, buildKiroEntryRegistration(options.adapter), "utf8");
      }
    } catch (e) {
      return keychainFailure(e, asJson);
    }
    const managedHooks = [
      ENTRY_SESSION_SCRIPT_RELATIVE_PATH,
      ...(writesOpencode
        ? [".opencode/plugins/chrono-gate.js", ...CHRONO_OPENCODE_ROLES.map((role) => openCodeAgentPath(role)), OPENCODE_CONFIG_SIDECAR_RELATIVE]
        : []),
      ...(writesClaude ? [CLAUDE_HOOK_RELATIVE_PATH, CLAUDE_SETTINGS_RELATIVE_PATH] : []),
      ...(writesKiro ? [KIRO_HOOK_RELATIVE_PATH, KIRO_HOOK_REGISTRATION_RELATIVE_PATH] : []),
      ...(options.runtime === "claude-code" ? [GASPAR_DEFINITION_RELATIVE_PATH] : []),
      ...(options.runtime === "kiro" ? [kiroEntryRegistrationPath(options.adapter)] : []),
    ];
    const body = asJson
      ? JSON.stringify(
          {
            ok: true,
            adapter: adapter.id,
            entrypoint: adapter.entrypoint,
            rtk: rtkVersion.stdout.trim().split("\n")[0] ?? "unknown",
            routingProven,
            skill: "current",
            proofsRun: proofs.length,
            plugin: writesOpencode ? ".opencode/plugins/chrono-gate.js" : null,
            hooks: managedHooks,
          },
          null,
          2
        )
      : [
          `Adapter '${adapter.id}' setup complete.`,
          `  entrypoint: ${adapter.entrypoint} (live)`,
          `  rtk: ${rtkVersion.stdout.trim().split("\n")[0] ?? "unknown"} (gain ok, attestation current)`,
          `  routing: ${routingProven ? "proven" : "unproven (adapter duty, see RUNTIME §6.3)"}`,
          "  skill: current, artifacts intact",
          `  proofs: ${String(proofs.length)} green`,
          ...(writesOpencode ? ["  plugin: .opencode/plugins/chrono-gate.js"] : []),
          ...(writesOpencode
            ? [
                "  agents: .opencode/agents/{gaspar,belthazar,melchior,prometheus,lucca,glenn,spekkio}.md (gaspar is the primary; no model is written)",
                "  default_agent: gaspar (project config merged, backup preserved; close OpenCode and open a fresh session afterwards)",
              ]
            : []),
          `  hooks: ${managedHooks.join(", ")}`,
        ].join("\n");
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
/** Commander collector for repeatable flags (e.g. --runtime). */
function collectStrings(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function createProgram(cwd: string): Command {
  const program = new Command();
  program.name("chrono").description("CHRONO — structured SDD framework CLI").version(CHRONO_VERSION);
  program
    .command("init")
    .description("One-command bootstrap: detect, plan, consent, and apply CHRONO setup with resume")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--language <lang>", "project language (default: en)")
    .option("--gaspar-autonomy <mode>", "Gaspar autonomy mode")
    .option("--runtime <id>", "select a runtime (repeatable; default: all installed)", collectStrings, [])
    .option("--yes", "consent to every effect listed in the plan (recorded per scope)")
    .option("--yes-files", "consent to project-local file effects only")
    .option("--yes-keychain", "consent to OS keychain effects only")
    .option("--yes-network", "consent to network effects only")
    .option("--yes-global", "consent to global effects only")
    .option("--dry-run", "detect and render the plan with zero writes")
    .option("--write-plan <file>", "write the reviewed plan file and exit")
    .option("--from-plan <file>", "apply a reviewed plan file (rejected on drift)")
    .option("--json", "machine-readable JSON output")
    .action(async (opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      const { runInitFlow } = await import("./init-flow.js");
      const runtimes = Array.isArray(opts.runtime)
        ? opts.runtime.filter((r): r is string => typeof r === "string")
        : undefined;
      const out = await runInitFlow(projectPath, {
        ...(runtimes !== undefined && runtimes.length > 0 ? { runtimeIds: runtimes } : {}),
        language: typeof opts.language === "string" ? opts.language : undefined,
        gasparAutonomy: typeof opts.gasparAutonomy === "string" ? opts.gasparAutonomy : undefined,
        yes: opts.yes === true,
        yesFiles: opts.yesFiles === true,
        yesKeychain: opts.yesKeychain === true,
        yesNetwork: opts.yesNetwork === true,
        yesGlobal: opts.yesGlobal === true,
        dryRun: opts.dryRun === true,
        ...(typeof opts.writePlan === "string" ? { writePlan: opts.writePlan } : {}),
        ...(typeof opts.fromPlan === "string" ? { fromPlan: opts.fromPlan } : {}),
        json: opts.json === true,
      });
      emitProgramResult(program, out);
    });

  program
    .command("status")
    .description("Show deterministic project status")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      const out = runStatus(projectPath, { json: opts.json === true });
      if (out.stdout !== "") {
        console.log(out.stdout);
      }
      if (out.stderr !== "") {
        console.error(out.stderr);
      }
      if (out.exitCode !== 0) {
        throw programFailureExit(out.exitCode);
      }
    });

  program
    .command("validate")
    .description("Run deterministic project validation (fail-closed)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      const out = runValidate(projectPath, { json: opts.json === true });
      if (out.stdout !== "") {
        console.log(out.stdout);
      }
      if (out.stderr !== "") {
        console.error(out.stderr);
      }
      if (out.exitCode !== 0) {
        throw programFailureExit(out.exitCode);
      }
    });

  program
    .command("approve")
    .description("Record an interactive human-only signed PO approval")
    .requiredOption("--action <action>", "approval action (module-approval, planning-approval, architecture-security, implementation-security, adapter-registration)")
    .requiredOption("--scope <id>", "artifact scope identifier (or ARCH)")
    .requiredOption("--revision <rev>", "exact scope revision hash")
    .requiredOption("--authority <name>", "PO signer identity")
    .requiredOption("--rationale <text>", "decision rationale")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
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
      const projectPath = resolveProjectDir(cwd, opts.path);
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

  program
    .command("enroll")
    .description("Enroll the initial PO signing key through the interactive enrollment ceremony (one time per project)")
    .requiredOption("--rationale <text>", "rationale bound into the enrollment record")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      emitProgramResult(
        program,
        runEnroll(projectPath, {
          ...(typeof opts.rationale === "string" ? { rationale: opts.rationale } : {}),
          json: opts.json === true,
        })
      );
    });

  const keys = program.command("keys").description("PO signing-key management");

  keys
    .command("generate")
    .description("Rotate the enrolled PO key with a signed rotation (initial trust requires chrono enroll)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--rotate", "replace the active key with a signed rotation")
    .option("--rationale <text>", "rationale bound into a rotation signature")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
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
    .argument("<gate>", "gate name (execution, completion, architecture-approval, spec-ready, verification)")
    .option("--module <id>", "module scope")
    .option("--wp <id>", "work-package scope")
    .option("--spec <id>", "spec scope (spec-ready gate)")
    .option("--as <actor>", "requesting identity (canonical role)")
    .option("--role <role>", "assigned implementation role (execution gate)")
    .option("--session-token <id/token>", "executor session credential (or CHRONO_SESSION_TOKEN)")
    .option("--requester-token <id/token>", "requester session credential for orchestrated execution")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((gate: string, opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      emitProgramResult(
        program,
        runGate(projectPath, {
          gate,
          module: typeof opts.module === "string" ? opts.module : undefined,
          wp: typeof opts.wp === "string" ? opts.wp : undefined,
          spec: typeof opts.spec === "string" ? opts.spec : undefined,
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
      const projectPath = resolveProjectDir(cwd, opts.path);
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
      const projectPath = resolveProjectDir(cwd, opts.path);
      const token = resolveSessionToken(typeof opts.sessionToken === "string" ? opts.sessionToken : undefined);
      emitProgramResult(
        program,
        runRtkVerify(projectPath, {
          ...(typeof opts.binary === "string" ? { binaryPath: opts.binary } : {}),
          ...(token === null ? {} : { session: token }),
          json: opts.json === true,
        })
      );
    });

  rtk
    .command("prove")
    .description("Prove effective RTK routing for an adapter and record a non-authoritative candidate proof (promote it after adapter approval)")
    .requiredOption("--adapter <id>", "registered runtime adapter id")
    .requiredOption("--as <actor>", "requesting identity (canonical role, matching the caller session)")
    .option("--binary <path>", "rtk binary (default: rtk from PATH)")
    .option("--session-token <id/token>", "caller session credential (or CHRONO_SESSION_TOKEN)")
    .option("--ttl <seconds>", "proof lifetime in seconds (default 3600)")
    .option("--timeout <seconds>", "command timeout in seconds (default 120)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .argument("<command...>", "raw pre-routing command (without the rtk prefix: mapped through 'rtk rewrite' by the flow)")
    .action((command: string[], opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      const token = resolveSessionToken(typeof opts.sessionToken === "string" ? opts.sessionToken : undefined);
      const ttl = typeof opts.ttl === "string" ? Number(opts.ttl) : undefined;
      const timeout = typeof opts.timeout === "string" ? Number(opts.timeout) : undefined;
      emitProgramResult(
        program,
        runRtkProve(projectPath, {
          adapter: String(opts.adapter ?? ""),
          ...(typeof opts.as === "string" ? { as: opts.as } : {}),
          ...(token === null ? {} : { session: token }),
          ...(typeof opts.binary === "string" ? { binary: opts.binary } : {}),
          ...(ttl !== undefined && Number.isFinite(ttl) ? { ttlSeconds: ttl } : {}),
          ...(timeout !== undefined && Number.isFinite(timeout) ? { timeoutSeconds: timeout } : {}),
          command,
          json: opts.json === true,
        })
      );
    });

  rtk
    .command("promote")
    .description("Promote a candidate routing proof to authoritative after signed adapter approval (PO session required)")
    .requiredOption("--proof <id>", "candidate routing proof id from 'rtk prove'")
    .requiredOption("--as <actor>", "requesting identity (PO, matching the caller session)")
    .option("--session-token <id/token>", "caller session credential (or CHRONO_SESSION_TOKEN)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      const token = resolveSessionToken(typeof opts.sessionToken === "string" ? opts.sessionToken : undefined);
      emitProgramResult(
        program,
        runRtkPromote(projectPath, {
          proof: String(opts.proof ?? ""),
          ...(typeof opts.as === "string" ? { as: opts.as } : {}),
          ...(token === null ? {} : { session: token }),
          json: opts.json === true,
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
      const projectPath = resolveProjectDir(cwd, opts.path);
      emitProgramResult(program, runAttestationStatus(projectPath, "skill", { json: opts.json === true }));
    });

  skill
    .command("verify")
    .description("Verify the pinned Karpathy Guidelines skill and record the attestation")
    .requiredOption("--as <actor>", "requesting identity (gaspar or PO, matching the caller session)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--session-token <id/token>", "caller session credential (or CHRONO_SESSION_TOKEN)")
    .option("--ttl <seconds>", "attestation lifetime in seconds (default 86400)")
    .option("--json", "machine-readable JSON output")
    .action(async (opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      const token = resolveSessionToken(typeof opts.sessionToken === "string" ? opts.sessionToken : undefined);
      const ttl = typeof opts.ttl === "string" ? Number(opts.ttl) : undefined;
      emitProgramResult(
        program,
        await runSkillVerify(projectPath, {
          ...(typeof opts.as === "string" ? { as: opts.as } : {}),
          ...(token === null ? {} : { session: token }),
          ...(ttl !== undefined && Number.isFinite(ttl) ? { ttlSeconds: ttl } : {}),
          json: opts.json === true,
        })
      );
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
      const projectPath = resolveProjectDir(cwd, opts.path);
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

  const adapterCmd = program.command("adapter").description("runtime adapter registry (PO-only mutation)");

  adapterCmd
    .command("register")
    .description("Register an adapter from a RUNTIME §13 file (creates a pending row)")
    .requiredOption("--file <path>", "adapter registration file")
    .requiredOption("--as <actor>", "requesting identity (PO)")
    .requiredOption("--session-token <id/token>", "caller session credential (or CHRONO_SESSION_TOKEN)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      const token = resolveSessionToken(typeof opts.sessionToken === "string" ? opts.sessionToken : undefined);
      if (token === null || typeof opts.as !== "string" || typeof opts.file !== "string") {
        emitProgramResult(
          program,
          opts.json === true
            ? { exitCode: 2, stdout: JSON.stringify({ ok: false, error: { code: "VALIDATION_ERROR", message: "adapter register requires --file, --as, and --session-token" } }, null, 2), stderr: "" }
            : { exitCode: 2, stdout: "", stderr: "Error [VALIDATION_ERROR]: adapter register requires --file, --as, and --session-token" }
        );
        return;
      }
      emitProgramResult(
        program,
        runAdapterRegister(projectPath, { file: opts.file, as: opts.as, session: token, json: opts.json === true })
      );
    });

  adapterCmd
    .command("list")
    .description("List adapter registrations")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      emitProgramResult(program, runAdapterList(projectPath, { json: opts.json === true }));
    });

  adapterCmd
    .command("activate")
    .description("Activate a pending adapter with its signed PO approval (PO only)")
    .requiredOption("--id <id>", "adapter id")
    .requiredOption("--approval <id>", "adapter-registration approval id")
    .requiredOption("--as <actor>", "requesting identity (PO)")
    .requiredOption("--session-token <id/token>", "caller session credential (or CHRONO_SESSION_TOKEN)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      const token = resolveSessionToken(typeof opts.sessionToken === "string" ? opts.sessionToken : undefined);
      if (token === null || typeof opts.as !== "string") {
        emitProgramResult(
          program,
          opts.json === true
            ? { exitCode: 2, stdout: JSON.stringify({ ok: false, error: { code: "VALIDATION_ERROR", message: "adapter activate requires --as and --session-token" } }, null, 2), stderr: "" }
            : { exitCode: 2, stdout: "", stderr: "Error [VALIDATION_ERROR]: adapter activate requires --as and --session-token" }
        );
        return;
      }
      emitProgramResult(
        program,
        runAdapterActivate(projectPath, {
          id: String(opts.id ?? ""),
          approval: String(opts.approval ?? ""),
          as: opts.as,
          session: token,
          json: opts.json === true,
        })
      );
    });

  adapterCmd
    .command("revoke")
    .description("Revoke an adapter registration (terminal; PO only)")
    .requiredOption("--id <id>", "adapter id")
    .requiredOption("--as <actor>", "requesting identity (PO)")
    .requiredOption("--session-token <id/token>", "caller session credential (or CHRONO_SESSION_TOKEN)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      const token = resolveSessionToken(typeof opts.sessionToken === "string" ? opts.sessionToken : undefined);
      if (token === null || typeof opts.as !== "string") {
        emitProgramResult(
          program,
          opts.json === true
            ? { exitCode: 2, stdout: JSON.stringify({ ok: false, error: { code: "VALIDATION_ERROR", message: "adapter revoke requires --as and --session-token" } }, null, 2), stderr: "" }
            : { exitCode: 2, stdout: "", stderr: "Error [VALIDATION_ERROR]: adapter revoke requires --as and --session-token" }
        );
        return;
      }
      emitProgramResult(
        program,
        runAdapterRevoke(projectPath, { id: String(opts.id ?? ""), as: opts.as, session: token, json: opts.json === true })
      );
    });

  program
    .command("setup")
    .description("Verify an adapter end to end and install its project-local enforcement assets (fail-closed)")
    .requiredOption("--adapter <id>", "registered runtime adapter id")
    .option("--rtk-binary <path>", "rtk binary (default: rtk from PATH)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      emitProgramResult(
        program,
        runSetup(projectPath, {
          adapter: String(opts.adapter ?? ""),
          ...(typeof opts.rtkBinary === "string" ? { rtkBinary: opts.rtkBinary } : {}),
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
      const projectPath = resolveProjectDir(cwd, opts.path);
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
      const projectPath = resolveProjectDir(cwd, opts.path);
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

  program
    .command("doctor")
    .description("Read-only project diagnostics: compatibility, setup, hooks, RTK, skill, broker, entry readiness")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--as <actor>", "accepted for compatibility; broker inspection is public and needs no session")
    .option("--session-token <id/token>", "accepted for compatibility; the doctor never uses privileged sessions")
    .option("--json", "machine-readable JSON output")
    .action(async (opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      const { runDoctor } = await import("./init-flow.js");
      const token =
        typeof opts.sessionToken === "string" && opts.sessionToken.length > 0
          ? resolveSessionToken(opts.sessionToken)
          : resolveSessionToken(undefined);
      emitProgramResult(
        program,
        runDoctor(projectPath, {
          json: opts.json === true,
          ...(typeof opts.as === "string" ? { as: opts.as } : {}),
          ...(token !== null ? { session: token } : {}),
        })
      );
    });

  const broker = program.command("broker").description("Gaspar-entry broker credentials (no secret ever persists)");
  broker
    .command("issue")
    .description("Issue a broker credential (secret shown once, or stored with --store)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--as <actor>", "requesting identity (gaspar or PO)")
    .option("--session-token <id/token>", "caller session credential (or CHRONO_SESSION_TOKEN)")
    .option("--store", "write the secret straight to the OS keychain instead of printing it")
    .option("--json", "machine-readable JSON output")
    .action(async (opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      const { runBrokerIssue } = await import("./init-flow.js");
      const token =
        typeof opts.sessionToken === "string" && opts.sessionToken.length > 0
          ? resolveSessionToken(opts.sessionToken)
          : resolveSessionToken(undefined);
      if (typeof opts.as !== "string" || token === null) {
        emitProgramResult(
          program,
          opts.json === true
            ? { exitCode: 2, stdout: JSON.stringify({ ok: false, error: { code: "VALIDATION_ERROR", message: "broker issue requires --as and --session-token" } }, null, 2), stderr: "" }
            : { exitCode: 2, stdout: "", stderr: "Error [VALIDATION_ERROR]: broker issue requires --as and --session-token" }
        );
        return;
      }
      emitProgramResult(
        program,
        runBrokerIssue(
          projectPath,
          { as: opts.as, session: token, store: opts.store === true, json: opts.json === true }
        )
      );
    });
  broker
    .command("revoke")
    .description("Revoke a broker credential (terminal; audited)")
    .argument("<id>", "broker credential id")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--as <actor>", "requesting identity (gaspar or PO)")
    .option("--session-token <id/token>", "caller session credential (or CHRONO_SESSION_TOKEN)")
    .option("--json", "machine-readable JSON output")
    .action(async (id: string, opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      const { runBrokerRevoke } = await import("./init-flow.js");
      const token =
        typeof opts.sessionToken === "string" && opts.sessionToken.length > 0
          ? resolveSessionToken(opts.sessionToken)
          : resolveSessionToken(undefined);
      if (typeof opts.as !== "string" || token === null) {
        emitProgramResult(
          program,
          opts.json === true
            ? { exitCode: 2, stdout: JSON.stringify({ ok: false, error: { code: "VALIDATION_ERROR", message: "broker revoke requires --as and --session-token" } }, null, 2), stderr: "" }
            : { exitCode: 2, stdout: "", stderr: "Error [VALIDATION_ERROR]: broker revoke requires --as and --session-token" }
        );
        return;
      }
      emitProgramResult(program, runBrokerRevoke(projectPath, { id, as: opts.as, session: token, json: opts.json === true }));
    });
  broker
    .command("list")
    .description("List broker credential metadata (never secret hashes)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--as <actor>", "requesting identity (gaspar or PO)")
    .option("--session-token <id/token>", "caller session credential (or CHRONO_SESSION_TOKEN)")
    .option("--json", "machine-readable JSON output")
    .action(async (opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      const { runBrokerList } = await import("./init-flow.js");
      const token =
        typeof opts.sessionToken === "string" && opts.sessionToken.length > 0
          ? resolveSessionToken(opts.sessionToken)
          : resolveSessionToken(undefined);
      emitProgramResult(
        program,
        runBrokerList(projectPath, {
          json: opts.json === true,
          ...(typeof opts.as === "string" ? { as: opts.as } : {}),
          ...(token !== null ? { session: token } : {}),
        })
      );
    });

  // The `entry` interface is owned by entry-contract.ts (OC-P7):
  // Commander options derive from ENTRY_OPTIONS so the parser and
  // the generated script cannot drift independently. The broker
  // secret always travels on stdin; no flag may ever carry it.
  const entryCommand = program
    .command(ENTRY_COMMAND_NAME)
    .description("Redeem Gaspar entry for a runtime adapter (secret on stdin, token to --token-out only)");
  for (const spec of ENTRY_OPTIONS) {
    if (spec.required) {
      entryCommand.requiredOption(entryCommanderOption(spec), spec.description);
    } else {
      entryCommand.option(entryCommanderOption(spec), spec.description);
    }
  }
  entryCommand.action(async (opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      const { runEntry } = await import("./init-flow.js");
      if (process.stdin.isTTY === true) {
        emitProgramResult(
          program,
          opts.json === true
            ? { exitCode: 2, stdout: JSON.stringify({ ok: false, error: { code: "VALIDATION_ERROR", message: "entry requires the broker secret piped on stdin" } }, null, 2), stderr: "" }
            : { exitCode: 2, stdout: "", stderr: "Error [VALIDATION_ERROR]: entry requires the broker secret piped on stdin" }
        );
        return;
      }
      const { readFileSync: readStdin } = await import("node:fs");
      let stdinText = "";
      try {
        stdinText = readStdin(0, "utf8");
      } catch {
        emitProgramResult(
          program,
          opts.json === true
            ? { exitCode: 2, stdout: JSON.stringify({ ok: false, error: { code: "VALIDATION_ERROR", message: "entry could not read stdin" } }, null, 2), stderr: "" }
            : { exitCode: 2, stdout: "", stderr: "Error [VALIDATION_ERROR]: entry could not read stdin" }
        );
        return;
      }
      emitProgramResult(
        program,
        runEntry(
          projectPath,
          {
            adapter: String(opts.adapter ?? ""),
            broker: String(opts.broker ?? ""),
            ...(typeof opts.runtime === "string" ? { runtime: opts.runtime } : {}),
            tokenOut: String(opts.tokenOut ?? ""),
            json: opts.json === true,
          },
          stdinText
        )
      );
    });

  // OC-P11: Core-governed planning/artifact-authoring path. Narrow native
  // tools for Gaspar's bootstrap — distinct from implementation execution.
  // `chrono run` grants stay reserved for authorized implementation work;
  // these commands materialize planning drafts (analysis, requirements,
  // architecture/ADRs, Specs, harness drafts, security proposals, plans)
  // without generic write/edit/bash authority.
  const artifactCmd = program.command("artifact").description("Core-governed planning drafts (Gaspar/PO sessions; chat text is never authority)");

  artifactCmd
    .command("propose")
    .description("Propose and materialize a planning draft (untrusted DRAFT until PO-signed approval)")
    .requiredOption("--kind <kind>", "planning kind (discovery, requirement, architecture, adr, spec, harness-draft, security-profile, roadmap, module, workpackage)")
    .option("--id <id>", "canonical identifier (allocated by the Core when omitted)")
    .requiredOption("--title <text>", "draft title")
    .requiredOption("--body-file <path>", "markdown body file")
    .option("--ref <id>", "reference an existing artifact or draft (repeatable)", collectStrings, [])
    .requiredOption("--as <actor>", "requesting identity (gaspar or PO, matching the caller session)")
    .option("--session-token <id/token>", "caller session credential (or CHRONO_SESSION_TOKEN)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      const refs = Array.isArray(opts.ref) ? opts.ref.filter((r): r is string => typeof r === "string") : [];
      emitProgramResult(
        program,
        runArtifactPropose(projectPath, {
          kind: String(opts.kind ?? ""),
          ...(typeof opts.id === "string" && opts.id.length > 0 ? { id: opts.id } : {}),
          title: String(opts.title ?? ""),
          bodyFile: String(opts.bodyFile ?? ""),
          ...(refs.length > 0 ? { references: refs } : {}),
          as: String(opts.as ?? ""),
          ...(typeof opts.sessionToken === "string" ? { sessionToken: opts.sessionToken } : {}),
          json: opts.json === true,
        })
      );
    });

  artifactCmd
    .command("revise")
    .description("Revise a planning draft to a new revision (prior approvals go stale)")
    .requiredOption("--id <id>", "planning artifact identifier")
    .requiredOption("--title <text>", "revised title")
    .requiredOption("--body-file <path>", "revised markdown body file")
    .requiredOption("--as <actor>", "requesting identity (gaspar or PO, matching the caller session)")
    .option("--session-token <id/token>", "caller session credential (or CHRONO_SESSION_TOKEN)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      emitProgramResult(
        program,
        runArtifactRevise(projectPath, {
          id: String(opts.id ?? ""),
          title: String(opts.title ?? ""),
          bodyFile: String(opts.bodyFile ?? ""),
          as: String(opts.as ?? ""),
          ...(typeof opts.sessionToken === "string" ? { sessionToken: opts.sessionToken } : {}),
          json: opts.json === true,
        })
      );
    });

  artifactCmd
    .command("status")
    .description("Explicit planning status: proposed, awaiting PO signature, approved, rejected, stale (Core-signed rows only)")
    .requiredOption("--as <actor>", "requesting identity (gaspar or PO, matching the caller session)")
    .option("--session-token <id/token>", "caller session credential (or CHRONO_SESSION_TOKEN)")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      emitProgramResult(
        program,
        runArtifactStatus(projectPath, {
          as: String(opts.as ?? ""),
          ...(typeof opts.sessionToken === "string" ? { sessionToken: opts.sessionToken } : {}),
          json: opts.json === true,
        })
      );
    });

  program
    .command("uninstall")
    .description("Scoped removal: hooks, broker, adapters, or project-data (destructive scope is interactive PO-only)")
    .requiredOption("--scope <scope>", "hooks|broker|adapters|project-data")
    .option("--path <dir>", "project directory (default: current directory)")
    .option("--as <actor>", "requesting identity for broker/adapters scopes")
    .option("--session-token <id/token>", "caller session credential (or CHRONO_SESSION_TOKEN)")
    .option("--json", "machine-readable JSON output")
    .action(async (opts: CommandOpts) => {
      const projectPath = resolveProjectDir(cwd, opts.path);
      const { runUninstall } = await import("./init-flow.js");
      const token =
        typeof opts.sessionToken === "string" && opts.sessionToken.length > 0
          ? resolveSessionToken(opts.sessionToken)
          : resolveSessionToken(undefined);
      emitProgramResult(
        program,
        runUninstall(
          projectPath,
          {
            scope: String(opts.scope ?? ""),
            ...(typeof opts.as === "string" ? { as: opts.as } : {}),
            ...(token !== null ? { session: token } : {}),
            json: opts.json === true,
          }
        )
      );
    });

  return program;
}

/**
 * Print a CliOutput and exit non-zero on failure. Failures already
 * rendered above must NOT pass through `program.error`: commander would
 * print its own output and bin.ts would append a second JSON envelope,
 * corrupting machine-readable stdout. The branded error tells bin.ts the
 * output is complete — it only sets the exit code.
 */
export function programFailureExit(exitCode: number): never {
  const error = new Error("chrono command failed") as Error & {
    exitCode: number;
    chronoEmitted: boolean;
  };
  error.exitCode = exitCode;
  error.chronoEmitted = true;
  throw error;
}

/** Print a CliOutput and raise the branded exit on failure. */
function emitProgramResult(program: Command, out: CliOutput): void {
  void program;
  if (out.stdout !== "") {
    console.log(out.stdout);
  }
  if (out.stderr !== "") {
    console.error(out.stderr);
  }
  if (out.exitCode !== 0) {
    throw programFailureExit(out.exitCode);
  }
}
