/**
 * CHRONO CLI — minimal usable interface to the deterministic Core.
 * [Slice 5] — CLI code delegates to Core services; it owns no CHRONO policy.
 *
 * Commands: init, status, validate. Each returns a CliOutput with an exit
 * code so adapters and tests can consume decisions deterministically.
 */

import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { ChronoCore } from "@chrono/core";
import { RTK_UPSTREAM, buildApprovalPayload, buildWaiverPayload, generateApprovalKeyPair, signApprovalPayload } from "@chrono/domain";
import { CHRONO_VERSION } from "./version.js";
import {
  MemoryKeyStore,
  OsKeychainStore,
  PO_KEY_ACCOUNT,
  PO_KEY_SERVICE,
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
  readonly binary?: unknown;
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

/**
 * Interactive PO key generation: Ed25519 keypair, private key to the OS
 * keychain, public key registered with the project. The private key is
 * never printed, logged, or written to the project [ADR-003].
 */
export function runKeysGenerate(
  projectPath: string,
  options: OutputOptions = {},
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
    const pair = generateApprovalKeyPair();
    try {
      deps.store.writeKey(PO_KEY_ACCOUNT, pair.privateKeyPem);
    } catch (e) {
      return keychainFailure(e, asJson);
    }
    const registered = core.registerPoPublicKey(pair.publicKeyPem);
    if (!registered.ok) {
      return coreError(registered.error, asJson);
    }
    const body = asJson
      ? JSON.stringify({ ok: true, account: PO_KEY_ACCOUNT }, null, 2)
      : ["PO signing key generated.", `  private: OS keychain (${PO_KEY_SERVICE})`, "  public: registered with this project."].join(
          "\n"
        );
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
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
  readonly json?: boolean | undefined;
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
      const result = core.authorizeExecution(options.module, {
        ...(options.wp !== undefined ? { workPackageId: options.wp } : {}),
        actor: options.as,
        role: options.role,
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
      const result = core.authorizeCompletion(options.module, options.as);
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
  options: OutputOptions & { binaryPath?: string } = {},
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
    const recorded = core.recordRtkAttestation({
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

function rtkBlocked(reason: string, asJson: boolean): CliOutput {
  if (asJson) {
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
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      emitProgramResult(program, runKeysGenerate(projectPath, { json: opts.json === true }));
    });

  program
    .command("gate")
    .description("Evaluate a Core gate (adapters and pre-tool hooks must obey the result)")
    .argument("<gate>", "gate name (execution, completion)")
    .option("--module <id>", "module scope")
    .option("--wp <id>", "work-package scope")
    .option("--as <actor>", "requesting identity (canonical role or <runtime>:<session>)")
    .option("--role <role>", "assigned implementation role (execution gate)")
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
    .option("--json", "machine-readable JSON output")
    .action((opts: CommandOpts) => {
      const projectPath = typeof opts.path === "string" ? opts.path : cwd;
      emitProgramResult(
        program,
        runRtkVerify(projectPath, {
          ...(typeof opts.binary === "string" ? { binaryPath: opts.binary } : {}),
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
