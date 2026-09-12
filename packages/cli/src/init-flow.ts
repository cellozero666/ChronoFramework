/**
 * `chrono init` orchestration: one-command bootstrap and resume experience
 * [SLICE-10 §§1, 3, 7, 8].
 *
 * The flow composes the existing granular operations (init, enroll,
 * approve, rtk/skill verify+prove, adapter register/activate, setup,
 * gate) without re-implementing their policy: every authority, signature,
 * and gate decision stays Core-owned. Phases:
 *
 *   detect (read-only, zero project writes) → plan (deterministic) →
 *   consent (explicit, scoped, recorded) → apply (persisted state machine
 *   with idempotent steps and resume).
 *
 * Human-only authority (enrollment, adapter approval, privileged session
 * bootstrap) always requires a live terminal and the OS-keychain key;
 * without them the flow returns a stable structured result naming the
 * exact action required instead of hanging or guessing.
 */

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir as osHomedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ChronoCore } from "@chrono/core";
import {
  SKILL_RELEASE,
  buildSessionAuthorizationPayload,
  computeRevisionHash,
  setupStepIndex,
  signApprovalPayload,
} from "@chrono/domain";
import { CHRONO_VERSION } from "./version.js";
import {
  buildOpencodePlugin,
  runAdapterActivate,
  runAdapterRegister,
  runApprove,
  runEnroll,
  runGate,
  runRtkPromote,
  runRtkProve,
  runRtkVerify,
  runSetup,
  runSkillVerify,
  defaultFetchSkillSource,
  productionDeps,
  resolveExecutable,
  type CliOutput,
  type HumanCommandDeps,
} from "./index.js";
import { buildClaudeHook } from "./claude-hook.js";
import { buildKiroHook, buildKiroHookRegistration } from "./kiro-hook.js";
import { evaluateKiroSupport } from "./kiro-capability.js";
import {
  buildEntrySessionScript,
  buildGasparDefinition,
  buildKiroEntryRegistration,
  entrySessionCommand,
  kiroEntryRegistrationPath,
} from "./gaspar-entry.js";
import { BROKER_KEY_SERVICE, OsKeychainStore, PO_KEY_ACCOUNT, brokerAccountFor } from "./keychain.js";
import { constructionFailure } from "./project.js";
import { openReadProject } from "./project.js";
import type { KeyStore } from "./keychain.js";

/** Canonical runtime identifiers (never providers or models) [FW §22]. */
export { KNOWN_RUNTIME_IDS as RUNTIME_IDS };
export type RuntimeId = KnownRuntimeId;
import { KNOWN_RUNTIME_IDS, isKnownRuntimeId, type KnownRuntimeId } from "@chrono/domain";

/** Candidate executable names per runtime, probed on PATH. */
const RUNTIME_BINARIES: Record<RuntimeId, string[]> = {
  opencode: ["opencode"],
  "claude-code": ["claude"],
  kiro: ["kiro", "kiro-cli"],
};

export interface FlowExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface FlowProbes {
  execFile(cmd: string[], timeoutMs: number): FlowExecResult;
  fetchSkill(url: string): Promise<string>;
  readFile(path: string): string | null;
  fileExists(path: string): boolean;
  which(binary: string): string | null;
  homedir(): string;
  platform(): { os: string; arch: string; node: string };
}

function defaultExecFile(cmd: string[], timeoutMs: number): FlowExecResult {
  try {
    const stdout = execFileSync(cmd[0] as string, cmd.slice(1), {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
    return {
      exitCode: typeof err.status === "number" ? err.status : 1,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : err instanceof Error ? err.message : String(e),
    };
  }
}

export function defaultFlowProbes(): FlowProbes {
  return {
    execFile: defaultExecFile,
    fetchSkill: (url: string): Promise<string> => defaultFetchSkillSource(url),
    readFile: (path: string): string | null => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    fileExists: (path: string): boolean => {
      try {
        return existsSync(path);
      } catch {
        return false;
      }
    },
    which: (binary: string): string | null => resolveExecutable(binary),
    homedir: () => osHomedir(),
    platform: () => ({ os: process.platform, arch: process.arch, node: process.version }),
  };
}

export interface RuntimeDetection {
  readonly id: RuntimeId;
  readonly binary: string | null;
  readonly version: string | null;
  readonly selected: boolean;
  readonly reason: string;
}

export interface InitDetection {
  readonly projectRoot: string;
  readonly inProject: boolean;
  readonly gitPresent: boolean;
  readonly newRepository: boolean;
  readonly existingState: string | null;
  readonly setupStep: string | null;
  readonly platform: { os: string; arch: string; node: string };
  readonly keychain: { available: boolean; enrolled: boolean; reason: string };
  readonly runtimes: RuntimeDetection[];
  readonly rtk: { binary: string | null; version: string | null; attested: string; routing: Record<string, string> };
  readonly skill: { installed: boolean; state: string };
  readonly filesToCreate: string[];
  readonly filesToModify: string[];
  readonly backups: string[];
  readonly conflicts: string[];
  readonly needsNetwork: string[];
  readonly needsGlobal: string[];
  readonly modelSelectionDetected: boolean;
}

export interface InitPlanStep {
  readonly step: string;
  readonly title: string;
  readonly actions: string[];
  readonly effects: { files: boolean; keychain: boolean; network: boolean; global: boolean };
}

export interface InitPlan {
  readonly version: 1;
  readonly chronoVersion: string;
  readonly projectRoot: string;
  readonly detectionHash: string;
  readonly createdAt: string;
  readonly runtimeIds: string[];
  readonly steps: InitPlanStep[];
  readonly consentRequired: { files: boolean; keychain: boolean; network: boolean; global: boolean };
  readonly poDecisions: string[];
  readonly costNotice: string;
}

/**
 * Read-only detection across project, platform, runtimes, RTK, skill,
 * and configuration [§3.1]. Performs zero project writes: the Core is
 * opened read-only when a database exists, and every external probe is
 * a version/status query. `requestedRuntimes` narrows selection; unknown
 * ids are conflicts, never silent defaults.
 */
export function detectInit(
  projectRoot: string,
  options: { runtimeIds?: string[] | undefined } = {},
  probes: FlowProbes = defaultFlowProbes()
): InitDetection {
  const root = resolve(projectRoot);
  const dbExists = probes.fileExists(join(root, ".chrono", "chrono.db"));
  const gitDir = probes.fileExists(join(root, ".git"));
  let gitPresent = false;
  let newRepository = true;
  if (gitDir) {
    const rev = probes.execFile(["git", "-C", root, "rev-parse", "--is-inside-work-tree"], 15000);
    gitPresent = rev.exitCode === 0;
    if (gitPresent) {
      const head = probes.execFile(["git", "-C", root, "rev-parse", "HEAD"], 15000);
      newRepository = head.exitCode !== 0;
    }
  } else {
    newRepository = true;
  }
  let existingState: string | null = null;
  let setupStep: string | null = null;
  let rtkAttested = "missing";
  let skillInstalled = false;
  let skillState = "missing";
  const routing: Record<string, string> = {};
  if (dbExists) {
    let core: ChronoCore | null = null;
    try {
      core = new ChronoCore({ projectPath: root, pinnedVersion: CHRONO_VERSION, readOnly: true });
      const status = core.status();
      if (status.ok) {
        existingState = status.value?.state ?? null;
      }
      const setup = core.getSetupState();
      if (setup.ok && setup.value !== null && setup.value !== undefined) {
        setupStep = setup.value.step;
      }
      rtkAttested = core.attestationCurrency("rtk").state;
      const skill = core.describeSkillInstallation();
      skillInstalled = skill.installed;
      skillState = skill.installed ? "current" : skill.code;
    } catch {
      existingState = null;
    } finally {
      try {
        core?.close();
      } catch {
        // Read-only handle; nothing to compensate.
      }
    }
  }
  const platform = probes.platform();
  // Keychain capability without side effects: read the PO account.
  let keychain = { available: false, enrolled: false, reason: "keychain unavailable on this platform" };
  try {
    const store = new OsKeychainStore();
    const key = store.readKey(PO_KEY_ACCOUNT);
    keychain = { available: true, enrolled: key !== null, reason: key !== null ? "PO key present" : "no PO key stored" };
  } catch (e) {
    keychain = {
      available: false,
      enrolled: false,
      reason: e instanceof Error ? e.message : "keychain unavailable",
    };
  }
  // Runtimes: presence probe only, never execution beyond --version.
  const requested = options.runtimeIds;
  const runtimes: RuntimeDetection[] = KNOWN_RUNTIME_IDS.map((id) => {
    let binary: string | null = null;
    let version: string | null = null;
    for (const candidate of RUNTIME_BINARIES[id]) {
      const probed = probes.execFile([candidate, "--version"], 15000);
      if (probed.exitCode === 0) {
        binary = candidate;
        version = probed.stdout.trim().split("\n")[0] ?? null;
        break;
      }
    }
    if (requested !== undefined) {
      if (!requested.includes(id)) {
        return { id, binary, version, selected: false, reason: "not requested" };
      }
      if (binary === null) {
        return { id, binary, version, selected: true, reason: "requested but binary absent: setup will stop with remediation" };
      }
      return { id, binary, version, selected: true, reason: "requested and installed" };
    }
    if (binary === null) {
      return { id, binary, version, selected: false, reason: "binary absent" };
    }
    return { id, binary, version, selected: true, reason: "detected on PATH" };
  });
  const conflicts: string[] = [];
  if (requested !== undefined) {
    for (const id of requested) {
      if (!isKnownRuntimeId(id)) {
        conflicts.push(`Unknown runtime '${id}': expected one of ${KNOWN_RUNTIME_IDS.join(", ")}`);
      }
    }
  }
  const selected = runtimes.filter((r) => r.selected);
  for (const r of selected) {
    if (r.binary === null) {
      conflicts.push(`Runtime '${r.id}' selected but its binary is absent: install it, then re-run chrono init`);
      continue;
    }
    // Kiro capability gate [FIXES-SL-10.1 C4]: version floor plus
    // real-runtime evidence, reported as an environment blocker rather
    // than readiness. Without this, init would declare an adapter ready
    // whose automatic entry was never observed.
    if (r.id === "kiro") {
      const support = evaluateKiroSupport({ binary: r.binary, versionOutput: r.version });
      for (const reason of support.reasons) {
        conflicts.push(reason);
      }
    }
  }
  // RTK identity probe (version query only; attestation state from above).
  let rtkBinary: string | null = null;
  let rtkVersion: string | null = null;
  const rtkProbe = probes.execFile(["rtk", "--version"], 15000);
  if (rtkProbe.exitCode === 0) {
    rtkBinary = "rtk";
    rtkVersion = rtkProbe.stdout.trim().split("\n")[0] ?? null;
    const gain = probes.execFile(["rtk", "gain"], 60000);
    if (gain.exitCode !== 0) {
      conflicts.push("RTK_NAME_COLLISION: installed rtk is not Rust Token Killer (rtk gain failed)");
      rtkBinary = null;
      rtkVersion = null;
    }
  }
  for (const r of selected) {
    routing[r.id] = "unproven";
  }
  const filesToCreate = [
    ".chrono/chrono.db",
    ".opencode/plugins/chrono-gate.js",
    ".chrono/hooks/chrono-claude-gate.js",
    ".chrono/hooks/chrono-kiro-gate.js",
    ".kiro/hooks/chrono-gate.json",
    ".claude/agents/gaspar.md",
    ".chrono/broker-account",
  ];
  const filesToModify = [".claude/settings.json"];
  const backups = [".claude/settings.json.chrono-bak (only when an existing file changes)"];
  const needsNetwork: string[] = [];
  if (!skillInstalled) {
    needsNetwork.push("fetch the pinned Karpathy Guidelines skill release");
  }
  // Model selection: presence of runtime-owned configuration only; values
  // are never read and names are never persisted as framework policy.
  const home = probes.homedir();
  const modelSelectionDetected = [
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".config", "opencode", "opencode.jsonc"),
    join(home, ".claude.json"),
    join(home, ".kiro"),
  ].some((p) => probes.fileExists(p));
  return {
    projectRoot: root,
    inProject: dbExists,
    gitPresent,
    newRepository,
    existingState,
    setupStep,
    platform,
    keychain,
    runtimes,
    rtk: { binary: rtkBinary, version: rtkVersion, attested: rtkAttested, routing },
    skill: { installed: skillInstalled, state: skillState },
    filesToCreate,
    filesToModify,
    backups,
    conflicts,
    needsNetwork,
    needsGlobal: [],
    modelSelectionDetected,
  };
}

/** Stable hash binding a plan to its exact detection inputs. */
export function detectionHash(detection: InitDetection): string {
  return createHash("sha256").update(computeRevisionHash(detection), "utf8").digest("hex");
}

/** Deterministic plan derived from detection [§3.2]. */
export function buildInitPlan(detection: InitDetection, createdAt?: string): InitPlan {
  const runtimeIds = detection.runtimes.filter((r) => r.selected).map((r) => r.id);
  const steps: InitPlanStep[] = [
    { step: "PROJECT_INITIALIZED", title: "Initialize or validate project identity and persistence", actions: ["chrono init (project identity)"], effects: { files: true, keychain: false, network: false, global: false } },
    { step: "PO_ENROLLED", title: "Enroll the PO signing key (interactive ceremony)", actions: ["chrono enroll"], effects: { files: false, keychain: true, network: false, global: false } },
    { step: "RUNTIMES_SELECTED", title: `Record selected runtimes: ${runtimeIds.join(", ") || "none"}`, actions: ["record runtime selection"], effects: { files: false, keychain: false, network: false, global: false } },
    { step: "RTK_VERIFIED_AND_ROUTED", title: "Verify genuine RTK and prove routing per runtime", actions: ["chrono rtk verify", "chrono rtk prove"], effects: { files: false, keychain: false, network: false, global: false } },
    { step: "SKILL_VERIFIED_AND_EMITTED", title: "Verify pinned skill and emit runtime artifacts", actions: ["chrono skill verify"], effects: { files: true, keychain: false, network: !detection.skill.installed, global: false } },
    { step: "ADAPTERS_REGISTERED_AND_APPROVED", title: "Register, approve, and activate runtime adapters", actions: ["chrono adapter register/approve"], effects: { files: false, keychain: false, network: false, global: false } },
    { step: "NATIVE_HOOKS_INSTALLED", title: "Install native fail-closed hooks and role definitions, then promote routing proofs to authoritative", actions: ["chrono setup", "chrono rtk promote"], effects: { files: true, keychain: false, network: false, global: false } },
    { step: "RUNTIME_CONFORMANCE_PASSED", title: "Run black-box conformance per runtime", actions: ["conformance proofs", "live gate smoke"], effects: { files: false, keychain: false, network: false, global: false } },
    { step: "GASPAR_ENTRY_PREPARED", title: "Issue broker credential and prove entry loop", actions: ["chrono broker issue", "entry self-test"], effects: { files: true, keychain: true, network: false, global: false } },
    { step: "READY", title: "Persist readiness projection and next action", actions: ["readiness report"], effects: { files: false, keychain: false, network: false, global: false } },
  ];
  return {
    version: 1,
    chronoVersion: CHRONO_VERSION,
    projectRoot: detection.projectRoot,
    detectionHash: detectionHash(detection),
    createdAt: createdAt ?? new Date().toISOString(),
    runtimeIds,
    steps,
    consentRequired: {
      files: true,
      keychain: true,
      network: detection.needsNetwork.length > 0,
      global: false,
    },
    poDecisions: [
      "PO key enrollment (interactive ceremony)",
      "adapter-registration approvals, one per runtime (signed)",
      "no risk acceptance is requested by setup",
    ],
    costNotice: "Setup performs no model execution and incurs no provider cost. Later agent work may incur cost per the runtime's own configuration.",
  };
}

/** Human rendering of the plan for the consent ceremony. */
export function renderInitPlan(plan: InitPlan, detection: InitDetection): string {
  const lines = [
    "CHRONO init plan",
    `  project: ${plan.projectRoot}${detection.newRepository ? " (new repository)" : detection.inProject ? " (existing CHRONO project)" : " (existing repository)"}`,
    `  chrono: ${plan.chronoVersion}  plan: ${plan.detectionHash.slice(0, 12)}`,
    `  runtimes: ${plan.runtimeIds.join(", ") || "(none selected)"}`,
    "  steps:",
    ...plan.steps.map((s) => `    - ${s.step}: ${s.title}`),
    `  files to create: ${detection.filesToCreate.join(", ")}`,
    `  files to modify: ${detection.filesToModify.join(", ")}`,
    `  backups: ${detection.backups.join(", ")}`,
    `  keychain: OS keychain entries for the PO key and the Gaspar entry broker`,
    detection.needsNetwork.length > 0 ? `  network: ${detection.needsNetwork.join("; ")}` : "  network: none required",
    "  global: no global installation or configuration changes",
    `  PO decisions remain interactive: ${plan.poDecisions.join("; ")}`,
    `  ${plan.costNotice}`,
  ];
  if (detection.conflicts.length > 0) {
    lines.push(`  conflicts: ${detection.conflicts.join("; ")}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Consent                                                             */
/* ------------------------------------------------------------------ */

export interface InitConsent {
  readonly files: boolean;
  readonly keychain: boolean;
  readonly network: boolean;
  readonly global: boolean;
}

export interface ConsentFlags {
  readonly yes?: boolean | undefined;
  readonly yesFiles?: boolean | undefined;
  readonly yesKeychain?: boolean | undefined;
  readonly yesNetwork?: boolean | undefined;
  readonly yesGlobal?: boolean | undefined;
}

/** Resolve granted scopes; returns the missing ones for structured refusal. */
export function resolveConsent(
  required: InitConsent,
  flags: ConsentFlags,
  interactive: boolean
): { consent: InitConsent } | { missing: (keyof InitConsent)[] } {
  const granted = (scope: keyof InitConsent): boolean =>
    flags.yes === true || flags[`yes${scope[0]!.toUpperCase()}${scope.slice(1)}` as keyof ConsentFlags] === true;
  if (interactive) {
    // Interactive typed confirmation covers every required scope at once;
    // the grant is recorded per scope below.
    return {
      consent: {
        files: required.files ? true : granted("files"),
        keychain: required.keychain ? true : granted("keychain"),
        network: required.network ? true : granted("network"),
        global: required.global ? true : granted("global"),
      },
    };
  }
  const missing = (Object.keys(required) as (keyof InitConsent)[]).filter(
    (scope) => required[scope] && !granted(scope)
  );
  if (missing.length > 0) {
    return { missing };
  }
  return {
    consent: {
      files: granted("files"),
      keychain: granted("keychain"),
      network: granted("network"),
      global: granted("global"),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Init lock (concurrent-open safety)                                  */
/* ------------------------------------------------------------------------------------ */

function readLock(lockPath: string): { pid: number; startedAt: string } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record["pid"] !== "number" || typeof record["startedAt"] !== "string") {
      return null;
    }
    return { pid: record["pid"], startedAt: record["startedAt"] };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    // EPERM: process exists but belongs to another user. ESRCH: dead.
    return code === "EPERM";
  }
}

/**
 * Exclusive init lock with stale-takeover. A live holder denies with a
 * structured result (no hang); a dead or ancient holder is replaced.
 */
export function acquireInitLock(
  projectRoot: string,
  now: string = new Date().toISOString()
): { release: () => void } | { locked: string } {
  const lockPath = join(resolve(projectRoot), ".chrono", "init.lock");
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    return { locked: `Cannot create lock directory for '${lockPath}'` };
  }
  try {
    const fd = openSync(lockPath, "wx", 0o644);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now }));
    closeSync(fd);
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // Best effort; a stale file is taken over on next run.
        }
      },
    };
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") {
      return { locked: `Cannot acquire init lock: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const existing = readLock(lockPath);
  if (existing !== null) {
    const ageMs = Date.parse(now) - Date.parse(existing.startedAt);
    if ((Number.isFinite(ageMs) && ageMs < 3600000 && pidAlive(existing.pid)) || !Number.isFinite(ageMs)) {
      return {
        locked: `chrono init already running (pid ${String(existing.pid)} since ${existing.startedAt}): wait or remove '${lockPath}' after verifying no init is active`,
      };
    }
  }
  try {
    rmSync(lockPath, { force: true });
    const fd = openSync(lockPath, "wx", 0o644);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now }));
    closeSync(fd);
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // Best effort.
        }
      },
    };
  } catch (e) {
    return { locked: `Cannot acquire init lock: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/* ------------------------------------------------------------------ */
/* Privileged sessions inside the flow (PO-signed, keychain-held)      */
/* ------------------------------------------------------------------ */

interface FlowSession {
  readonly id: string;
  readonly token: string;
}

function safeReadKey(store: KeyStore, account: string, service?: string): string | null {
  try {
    return store.readKey(account, service);
  } catch {
    return null;
  }
}

function approvalFailure(message: string, suggestedAction: string, asJson: boolean): CliOutput {
  if (asJson) {
    return {
      exitCode: 1,
      stdout: JSON.stringify({ ok: false, error: { code: "APPROVAL_REQUIRED", message, suggestedAction } }, null, 2),
      stderr: "",
    };
  }
  return { exitCode: 1, stdout: "", stderr: `DENIED [APPROVAL_REQUIRED]: ${message}\n  suggested action: ${suggestedAction}` };
}

/** Open a gaspar/PO session through a PO-signed bootstrap using the keychain key. */
function bootstrapFlowSession(
  core: ChronoCore,
  role: "gaspar" | "PO",
  adapter: string,
  runtime: string,
  scopeModule: string | undefined,
  deps: HumanCommandDeps,
  asJson: boolean
): { session: FlowSession } | { failure: CliOutput } {
  if (!deps.interactive) {
    return {
      failure: approvalFailure(
        `Opening a ${role} session requires an interactive PO-signed bootstrap`,
        "Run chrono init in a live terminal as the Product Owner",
        asJson
      ),
    };
  }
  const privateKey = safeReadKey(deps.store, PO_KEY_ACCOUNT);
  if (privateKey === null) {
    return {
      failure: approvalFailure(
        "No PO signing key in the OS keychain",
        "Complete PO enrollment first, then resume chrono init",
        asJson
      ),
    };
  }
  const nonce = randomBytes(16).toString("hex");
  const timestamp = new Date().toISOString();
  const signature = signApprovalPayload(
    buildSessionAuthorizationPayload({
      sessionRole: role,
      adapter,
      runtime,
      scopeModule: scopeModule ?? null,
      scopeWp: null,
      ttlSeconds: 3600,
      nonce,
      authority: "PO",
      rationale: "chrono init privileged session",
      timestamp,
    }),
    privateKey
  );
  const opened = core.openSession(
    { role, adapter, runtime, ...(scopeModule !== undefined ? { scopeModule } : {}), ttlSeconds: 3600 },
    { poAuthorization: { nonce, authority: "PO", rationale: "chrono init privileged session", timestamp, signature } }
  );
  if (!opened.ok) {
    const err = opened.error ?? { code: "EXECUTION_DENIED", message: "Session bootstrap denied" };
    return {
      failure: asJson
        ? { exitCode: 1, stdout: JSON.stringify({ ok: false, error: err }, null, 2), stderr: "" }
        : { exitCode: 1, stdout: "", stderr: `DENIED [${err.code}]: ${err.message}` },
    };
  }
  return { session: { id: opened.value!.id, token: opened.value!.token } };
}

/* ------------------------------------------------------------------ */
/* Flow options and result envelopes                                   */
/* ------------------------------------------------------------------ */

export interface InitFlowOptions {
  readonly runtimeIds?: string[] | undefined;
  readonly language?: string | undefined;
  readonly gasparAutonomy?: string | undefined;
  readonly yes?: boolean | undefined;
  readonly yesFiles?: boolean | undefined;
  readonly yesKeychain?: boolean | undefined;
  readonly yesNetwork?: boolean | undefined;
  readonly yesGlobal?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly writePlan?: string | undefined;
  readonly fromPlan?: string | undefined;
  readonly json?: boolean | undefined;
}

function stepFailure(step: string, code: string, reason: string, asJson: boolean): CliOutput {
  if (asJson) {
    return {
      exitCode: 1,
      stdout: JSON.stringify(
        { ok: false, step, error: { code, message: reason }, resume: "Re-run chrono init to resume from the recorded step" },
        null,
        2
      ),
      stderr: "",
    };
  }
  return {
    exitCode: 1,
    stdout: "",
    stderr: [`FAILED [${code}] at ${step}: ${reason}`, "Resume: re-run chrono init to resume from the recorded step."].join("\n"),
  };
}

function consentFailure(missing: (keyof InitConsent)[], asJson: boolean): CliOutput {
  const reason = `Explicit consent required for: ${missing.join(", ")}. Pass --yes with scope flags or run interactively.`;
  if (asJson) {
    return {
      exitCode: 2,
      stdout: JSON.stringify({ ok: false, error: { code: "CONSENT_REQUIRED", message: reason } }, null, 2),
      stderr: "",
    };
  }
  return { exitCode: 2, stdout: "", stderr: `Error [CONSENT_REQUIRED]: ${reason}` };
}

/** Prompt for plan consent on the controlling terminal (never stdin). */
export function promptInitConsent(planText: string, challenge: string): string | null {
  const path = process.platform === "win32" ? "CON" : "/dev/tty";
  let fd = -1;
  try {
    fd = openSync(path, "r+");
  } catch {
    return null;
  }
  try {
    writeFileSync(fd, `\n${planText}\nType exactly to confirm: ${challenge}\n> `);
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
      if (line.length > 8192) {
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

/* ------------------------------------------------------------------ */
/* Plan files (automation without bypass)                              */
/* ------------------------------------------------------------------ */

export interface StoredInitPlan {
  readonly plan: InitPlan;
  readonly detection: InitDetection;
}

export function writeInitPlanFile(path: string, plan: InitPlan, detection: InitDetection): void {
  writeFileSync(path, JSON.stringify({ plan, detection } satisfies StoredInitPlan, null, 2), "utf8");
}

export function readInitPlanFile(path: string): StoredInitPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Plan file '${path}' is not parseable JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Plan file '${path}' is not a plan document`);
  }
  const doc = parsed as { plan?: unknown; detection?: unknown };
  if (typeof doc.plan !== "object" || doc.plan === null || typeof doc.detection !== "object" || doc.detection === null) {
    throw new Error(`Plan file '${path}' lacks a plan and its detection`);
  }
  const plan = doc.plan as Record<string, unknown>;
  if (plan["version"] !== 1) {
    throw new Error(`Plan file '${path}' has an unsupported plan version`);
  }
  return { plan: plan as unknown as InitPlan, detection: doc.detection as unknown as InitDetection };
}

/** A plan replays only against materially identical inputs [§8]. */
export function validatePlanReplay(stored: StoredInitPlan, fresh: InitDetection): string | null {
  if (stored.plan.chronoVersion !== CHRONO_VERSION) {
    return `Plan targets chrono ${stored.plan.chronoVersion}; this launcher is ${CHRONO_VERSION}`;
  }
  if (stored.plan.projectRoot !== fresh.projectRoot) {
    return `Plan targets project '${stored.plan.projectRoot}'; current project is '${fresh.projectRoot}'`;
  }
  if (stored.plan.detectionHash !== detectionHash(fresh)) {
    return "Detection changed since the plan was written (runtimes, RTK, skill, or project state differ): regenerate the plan";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Main orchestration                                                  */
/* ------------------------------------------------------------------ */

const ADAPTER_DISPLAY_NAMES: Record<string, string> = {
  opencode: "OpenCode",
  "claude-code": "Claude Code",
  kiro: "Kiro",
};

function parseJsonOutput(out: CliOutput): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(out.stdout);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run the init orchestration: detect → plan → consent → apply with
 * persisted resume. Returns when READY, on the first denial, or when a
 * human decision is missing (structured, never hanging).
 */
export async function runInitFlow(
  projectPath: string,
  options: InitFlowOptions = {},
  deps: HumanCommandDeps = productionDeps(),
  probes: FlowProbes = defaultFlowProbes(),
  confirm: (planText: string, challenge: string) => string | null = promptInitConsent
): Promise<CliOutput> {
  const asJson = options.json === true;
  const root = resolve(projectPath);
  const fail = (exitCode: number, code: string, reason: string): CliOutput =>
    asJson
      ? { exitCode, stdout: JSON.stringify({ ok: false, error: { code, message: reason } }, null, 2), stderr: "" }
      : { exitCode, stdout: "", stderr: `Error [${code}]: ${reason}` };

  // Detection is read-only and side-effect free.
  const detection = detectInit(root, { ...(options.runtimeIds !== undefined ? { runtimeIds: options.runtimeIds } : {}) }, probes);

  let plan = buildInitPlan(detection);
  if (options.fromPlan !== undefined) {
    let stored: StoredInitPlan;
    try {
      stored = readInitPlanFile(options.fromPlan);
    } catch (e) {
      return fail(2, "VALIDATION_ERROR", e instanceof Error ? e.message : String(e));
    }
    const replayError = validatePlanReplay(stored, detection);
    if (replayError !== null) {
      return fail(2, "VALIDATION_ERROR", replayError);
    }
    plan = stored.plan;
  }
  if (options.writePlan !== undefined) {
    try {
      writeInitPlanFile(options.writePlan, plan, detection);
    } catch (e) {
      return fail(2, "VALIDATION_ERROR", `Cannot write plan file: ${e instanceof Error ? e.message : String(e)}`);
    }
    const body = asJson
      ? JSON.stringify({ ok: true, plan: options.writePlan, detectionHash: plan.detectionHash }, null, 2)
      : `Plan written to '${options.writePlan}' (hash ${plan.detectionHash.slice(0, 12)}). Review it, then run: chrono init --from-plan '${options.writePlan}'`;
    return { exitCode: 0, stdout: body, stderr: "" };
  }
  if (options.dryRun === true) {
    const body = asJson
      ? JSON.stringify({ ok: true, dryRun: true, plan, detection }, null, 2)
      : ["Dry run: no writes performed.", renderInitPlan(plan, detection)].join("\n");
    return { exitCode: 0, stdout: body, stderr: "" };
  }
  if (detection.conflicts.length > 0) {
    return fail(2, "VALIDATION_ERROR", `Setup blocked: ${detection.conflicts.join("; ")}`);
  }

  // Consent: explicit, scoped, recorded. Interactive typed confirmation
  // covers every required scope; flags cover automation per scope.
  const consentResolution = resolveConsent(
    plan.consentRequired,
    { yes: options.yes, yesFiles: options.yesFiles, yesKeychain: options.yesKeychain, yesNetwork: options.yesNetwork, yesGlobal: options.yesGlobal },
    deps.interactive
  );
  let consent: InitConsent;
  if ("missing" in consentResolution) {
    return consentFailure(consentResolution.missing, asJson);
  }
  if (deps.interactive && options.yes !== true) {
    const challenge = `yes init ${plan.detectionHash.slice(0, 8)}`;
    const typed = confirm(renderInitPlan(plan, detection), challenge);
    if (typed === null) {
      return fail(2, "CONSENT_REQUIRED", "Init consent requires a controlling terminal with typed confirmation");
    }
    if (typed !== challenge) {
      return fail(2, "VALIDATION_ERROR", "Init confirmation does not match the plan challenge: consent denied");
    }
    consent = consentResolution.consent;
  } else {
    consent = consentResolution.consent;
  }
  if (!consent.files || !consent.keychain) {
    const missing = [
      ...(!consent.files ? ["files" as const] : []),
      ...(!consent.keychain ? ["keychain" as const] : []),
    ];
    return consentFailure(missing, asJson);
  }

  // Apply under an exclusive lock; every step advances persisted state
  // only after its own verification succeeds.
  const lock = acquireInitLock(root);
  if ("locked" in lock) {
    return fail(1, "EXECUTION_DENIED", lock.locked);
  }
  let core: ChronoCore;
  try {
    core = new ChronoCore({
      projectPath: root,
      pinnedVersion: CHRONO_VERSION,
      ...(options.language !== undefined ? { language: options.language } : {}),
      ...(options.gasparAutonomy !== undefined ? { gasparAutonomy: options.gasparAutonomy } : {}),
      // Single-runtime projects pin their runtime for strict session
      // matching; multi-runtime projects keep it unset (any runtime may
      // open sessions). Existing projects are never silently changed.
      ...(plan.runtimeIds.length === 1 && !detection.inProject ? { runtime: plan.runtimeIds[0] } : {}),
    });
  } catch (e) {
    lock.release();
    return constructionFailure(e, asJson);
  }
  try {
    const mark = (step: (typeof plan.steps)[number]["step"] | "DETECTED" | "CONSENTED" | "READY", detail: Record<string, unknown>): CliOutput | null => {
      const res = core.advanceSetupState(step as never, detail);
      if (!res.ok) {
        return stepFailure(step, res.error?.code ?? "ILLEGAL_TRANSITION", res.error?.message ?? "setup advance denied", asJson);
      }
      return null;
    };
    const current = core.getSetupState();
    const currentStep = current.ok && current.value !== null && current.value !== undefined ? current.value.step : null;
    if (currentStep === "READY") {
      const resumed = await resumeHealthCheck(core, root, asJson);
      lock.release();
      return resumed;
    }

    const need = (step: string): boolean =>
      currentStep === null || setupStepIndexOf(currentStep) < setupStepIndexOf(step);

    // DETECTED + CONSENTED backfill (detection/consent precede all writes).
    if (need("DETECTED")) {
      const failed =
        mark("DETECTED", { detectionHash: plan.detectionHash, runtimes: plan.runtimeIds }) ??
        mark("CONSENTED", {
          scopes: consent,
          planHash: plan.detectionHash,
          interactive: deps.interactive,
        });
      if (failed !== null) {
        lock.release();
        return failed;
      }
    }

    // PROJECT_INITIALIZED.
    if (need("PROJECT_INITIALIZED")) {
      const status = core.status();
      if (!status.ok) {
        const init = core.init();
        if (!init.ok) {
          lock.release();
          return stepFailure("PROJECT_INITIALIZED", init.error?.code ?? "EXECUTION_DENIED", init.error?.message ?? "init denied", asJson);
        }
      }
      const failed = mark("PROJECT_INITIALIZED", {
        language: options.language ?? "en",
        gasparAutonomy: options.gasparAutonomy ?? "SEMI_AUTONOMOUS",
      });
      if (failed !== null) {
        lock.release();
        return failed;
      }
    }

    // PO_ENROLLED.
    if (need("PO_ENROLLED")) {
      if (core.poKeyRevision() === null) {
        const enrolled = runEnroll(
          root,
          { rationale: "Initial PO enrollment via chrono init", json: true },
          deps,
          (challenge) => confirm(challenge, challenge)
        );
        if (enrolled.exitCode !== 0) {
          lock.release();
          return prefixStepFailure("PO_ENROLLED", enrolled, asJson);
        }
        const parsed = parseJsonOutput(enrolled);
        const failed = mark("PO_ENROLLED", { fingerprint: typeof parsed?.["fingerprint"] === "string" ? parsed["fingerprint"] : "enrolled" });
        if (failed !== null) {
          lock.release();
          return failed;
        }
      } else {
        const failed = mark("PO_ENROLLED", { verified: true });
        if (failed !== null) {
          lock.release();
          return failed;
        }
      }
    }

    // Privileged sessions for the remaining steps (PO-signed, keychain-held).
    // Each adapter gets sessions bound to its own id/runtime string so
    // routing proofs land in the scope dispatch will look up.
    const firstRuntime = plan.runtimeIds[0] ?? "init";
    const gasparSessions = new Map<string, { id: string; token: string }>();
    const openAdapterSession = (
      adapterId: string
    ): { session: { id: string; token: string } } | { failure: CliOutput } => {
      const existing = gasparSessions.get(adapterId);
      if (existing !== undefined) {
        return { session: existing };
      }
      const opened = bootstrapFlowSession(core, "gaspar", adapterId, adapterId, undefined, deps, asJson);
      if ("failure" in opened) {
        return opened;
      }
      gasparSessions.set(adapterId, opened.session);
      return { session: opened.session };
    };
    const primarySession = openAdapterSession(firstRuntime);
    if ("failure" in primarySession) {
      lock.release();
      return primarySession.failure;
    }
    const gasparSession = primarySession;
    const poSession = bootstrapFlowSession(core, "PO", firstRuntime, firstRuntime, undefined, deps, asJson);
    if ("failure" in poSession) {
      lock.release();
      return poSession.failure;
    }
    const gasparAuth = { actor: "gaspar", session: gasparSession.session };

    // RUNTIMES_SELECTED.
    if (need("RUNTIMES_SELECTED")) {
      const runtime = projectRuntimeOf(core);
      if (plan.runtimeIds.length === 0) {
        lock.release();
        return stepFailure("RUNTIMES_SELECTED", "CONFIG_ERROR", "No runtimes selected: install a runtime binary or pass --runtime explicitly", asJson);
      }
      if (plan.runtimeIds.length === 1 && runtime !== null && runtime !== plan.runtimeIds[0]) {
        lock.release();
        return stepFailure(
          "RUNTIMES_SELECTED",
          "INCONSISTENT_REFERENCE",
          `Project runtime is '${runtime}' but selection is '${plan.runtimeIds[0]}': reconfigure explicitly instead of silently changing it`,
          asJson
        );
      }
      if (plan.runtimeIds.length > 1 && runtime !== null) {
        lock.release();
        return stepFailure(
          "RUNTIMES_SELECTED",
          "INCONSISTENT_REFERENCE",
          `Project pins a single runtime ('${runtime}') but several were selected: multi-runtime projects keep project runtime unset`,
          asJson
        );
      }
      const failed = mark("RUNTIMES_SELECTED", { runtimes: plan.runtimeIds, mode: plan.runtimeIds.length === 1 ? "single" : "multi" });
      if (failed !== null) {
        lock.release();
        return failed;
      }
    }
    // RTK_VERIFIED_AND_ROUTED.
    if (need("RTK_VERIFIED_AND_ROUTED")) {
      const verify = runRtkVerify(root, { json: true, session: gasparSession.session, resolveBinary: (b) => probes.which(b) }, defaultRtkExec(probes));
      if (verify.exitCode !== 0) {
        lock.release();
        return prefixStepFailure("RTK_VERIFIED_AND_ROUTED", verify, asJson);
      }
      for (const runtimeId of plan.runtimeIds) {
        const adapterSession = openAdapterSession(runtimeId);
        if ("failure" in adapterSession) {
          lock.release();
          return adapterSession.failure;
        }
        const proof = runRtkProve(
          root,
          {
            adapter: runtimeId,
            as: "gaspar",
            session: adapterSession.session,
            binary: detection.rtk.binary ?? "rtk",
            resolveBinary: (b) => probes.which(b),
            ttlSeconds: 86400,
            json: true,
            // Raw pre-routing input: the flow maps it through
            // `rtk rewrite` itself (identity-only and already-routed
            // inputs can never prove routing) [FIXES-SL-10.1 C2].
            command: ["ls", root],
          },
          defaultRtkSpawn(probes)
        );
        if (proof.exitCode !== 0) {
          lock.release();
          return prefixStepFailure("RTK_VERIFIED_AND_ROUTED", proof, asJson);
        }
      }
      const failed = mark("RTK_VERIFIED_AND_ROUTED", { adapters: plan.runtimeIds });
      if (failed !== null) {
        lock.release();
        return failed;
      }
    }

    // SKILL_VERIFIED_AND_EMITTED.
    if (need("SKILL_VERIFIED_AND_EMITTED")) {
      const skill = core.describeSkillInstallation();
      if (!skill.installed) {
        if (!consent.network) {
          lock.release();
          return consentFailure(["network"], asJson);
        }
        const verified = await runSkillVerify(
          root,
          { as: "gaspar", session: gasparSession.session, json: true },
          probes.fetchSkill
        );
        if (verified.exitCode !== 0) {
          lock.release();
          return prefixStepFailure("SKILL_VERIFIED_AND_EMITTED", verified, asJson);
        }
      }
      const failed = mark("SKILL_VERIFIED_AND_EMITTED", { installed: true });
      if (failed !== null) {
        lock.release();
        return failed;
      }
    }

    // ADAPTERS_REGISTERED_AND_APPROVED.
    if (need("ADAPTERS_REGISTERED_AND_APPROVED")) {
      const activated: string[] = [];
      const tmpBase = mkdtempSync(join(tmpdir(), "chrono-init-adapters-"));
      try {
        for (const runtimeId of plan.runtimeIds) {
          let active = false;
          try {
            core.getAdapterForDispatch(runtimeId);
            active = true;
          } catch {
            active = false;
          }
          if (!active) {
            const binary = probes.which(RUNTIME_BINARIES[runtimeId as keyof typeof RUNTIME_BINARIES]?.[0] ?? runtimeId);
            if (binary === null) {
              lock.release();
              return stepFailure(
                "ADAPTERS_REGISTERED_AND_APPROVED",
                "CONFIG_ERROR",
                `Runtime '${runtimeId}' binary vanished after detection: reinstall it and resume`,
                asJson
              );
            }
            const display = ADAPTER_DISPLAY_NAMES[runtimeId] ?? runtimeId;
            const fileText = [
              `id: ${runtimeId}`,
              `name: ${display}`,
              `entrypoint: ${binary}`,
              "conformance_proof:",
              `  - ${binary} --version`,
              "",
            ].join("\n");
            const filePath = join(tmpBase, `${runtimeId}.adapter`);
            writeFileSync(filePath, fileText, "utf8");
            const registered = runAdapterRegister(root, { file: filePath, as: "PO", session: poSession.session, json: true });
            if (registered.exitCode !== 0) {
              lock.release();
              return prefixStepFailure("ADAPTERS_REGISTERED_AND_APPROVED", registered, asJson);
            }
            const regParsed = parseJsonOutput(registered);
            const registrationHash = regParsed?.["registrationHash"];
            if (typeof registrationHash !== "string") {
              lock.release();
              return stepFailure("ADAPTERS_REGISTERED_AND_APPROVED", "VALIDATION_ERROR", "Adapter registration did not return its hash", asJson);
            }
            const approved = runApprove(
              root,
              { action: "adapter-registration", scope: runtimeId, revision: registrationHash, authority: "PO", rationale: `Approve ${display} adapter via chrono init`, json: true },
              deps
            );
            if (approved.exitCode !== 0) {
              lock.release();
              return prefixStepFailure("ADAPTERS_REGISTERED_AND_APPROVED", approved, asJson);
            }
            const approvalId = parseJsonOutput(approved)?.["id"];
            if (typeof approvalId !== "string") {
              lock.release();
              return stepFailure("ADAPTERS_REGISTERED_AND_APPROVED", "VALIDATION_ERROR", "Adapter approval did not return its id", asJson);
            }
            const activatedOut = runAdapterActivate(root, { id: runtimeId, approval: approvalId, as: "PO", session: poSession.session, json: true });
            if (activatedOut.exitCode !== 0) {
              lock.release();
              return prefixStepFailure("ADAPTERS_REGISTERED_AND_APPROVED", activatedOut, asJson);
            }
          }
          activated.push(runtimeId);
        }
      } finally {
        rmSync(tmpBase, { recursive: true, force: true });
      }
      const failed = mark("ADAPTERS_REGISTERED_AND_APPROVED", { adapters: activated });
      if (failed !== null) {
        lock.release();
        return failed;
      }
    }

    // NATIVE_HOOKS_INSTALLED.
    if (need("NATIVE_HOOKS_INSTALLED")) {
      for (const runtimeId of plan.runtimeIds) {
        const installed = runSetup(
          root,
          { adapter: runtimeId, runtime: runtimeId, rtkBinary: detection.rtk.binary ?? "rtk", json: true },
          defaultSetupExec(probes)
        );
        if (installed.exitCode !== 0) {
          lock.release();
          return prefixStepFailure("NATIVE_HOOKS_INSTALLED", installed, asJson);
        }
      }
      // Promote each runtime's candidate proof to authoritative (ADR-006,
      // C3): adapters are approved above and managed hooks are installed,
      // so the promotion bindings (registration hash, asset manifest)
      // can snapshot. Idempotent: already-authoritative scopes skip.
      for (const runtimeId of plan.runtimeIds) {
        const scopes = core.routingProofScopes(runtimeId);
        const candidate = scopes.find(
          (proof) => proof.runtime === runtimeId && proof.authority === "candidate" && !proof.expired
        );
        if (candidate === undefined) {
          const authoritative = scopes.find(
            (proof) => proof.runtime === runtimeId && proof.authority === "authoritative" && !proof.expired
          );
          if (authoritative === undefined) {
            lock.release();
            return stepFailure(
              "NATIVE_HOOKS_INSTALLED",
              "RTK_ROUTING_FAILURE",
              `No current routing proof to promote for '${runtimeId}': re-run chrono init to re-prove routing`,
              asJson
            );
          }
          continue;
        }
        const promoted = runRtkPromote(
          root,
          { proof: candidate.id, as: "PO", session: poSession.session, json: true }
        );
        if (promoted.exitCode !== 0) {
          lock.release();
          return prefixStepFailure("NATIVE_HOOKS_INSTALLED", promoted, asJson);
        }
      }
      const failed = mark("NATIVE_HOOKS_INSTALLED", {
        hooks: [".opencode/plugins/chrono-gate.js", ".chrono/hooks/chrono-claude-gate.js", ".chrono/hooks/chrono-kiro-gate.js"],
      });
      if (failed !== null) {
        lock.release();
        return failed;
      }
    }

    // RUNTIME_CONFORMANCE_PASSED: conformance proofs already ran green
    // inside setup; the live gate smoke proves hooks reach the Core.
    if (need("RUNTIME_CONFORMANCE_PASSED")) {
      const smoke = runGate(root, {
        gate: "execution",
        module: "MOD-0000",
        as: "gaspar",
        role: "belthazar",
        sessionToken: `${gasparSession.session.id}/${gasparSession.session.token}`,
        requesterToken: `${gasparSession.session.id}/${gasparSession.session.token}`,
        json: true,
      });
      const smokeParsed = parseJsonOutput(smoke);
      if (smoke.exitCode !== 1 || smokeParsed?.["result"] !== "DENIED") {
        lock.release();
        return stepFailure("RUNTIME_CONFORMANCE_PASSED", "EXECUTION_DENIED", "Gate smoke test did not deny: hooks cannot reach the Core", asJson);
      }
      const failed = mark("RUNTIME_CONFORMANCE_PASSED", { adapters: plan.runtimeIds, gateSmoke: "DENIED" });
      if (failed !== null) {
        lock.release();
        return failed;
      }
    }

    // GASPAR_ENTRY_PREPARED: broker credential to the keychain, then prove
    // the redeem loop and revoke the probe session (no orphans). Resume
    // reuses a live credential whose secret is still held; a credential
    // without its secret is revoked and replaced (audited recovery).
    if (need("GASPAR_ENTRY_PREPARED")) {
      const account = brokerAccountFor(root);
      let brokerId: string | null = null;
      const listed = core.listBrokerCredentials(gasparAuth);
      if (listed.ok) {
        brokerId = listed.value?.find((c) => !c.revoked)?.id ?? null;
      }
      const heldSecret = safeReadKey(deps.store, account, BROKER_KEY_SERVICE);
      if (brokerId !== null && heldSecret === null) {
        const rotated = core.revokeBrokerCredential(brokerId, gasparAuth);
        if (!rotated.ok) {
          lock.release();
          return stepFailure("GASPAR_ENTRY_PREPARED", rotated.error?.code ?? "EXECUTION_DENIED", rotated.error?.message ?? "broker rotation denied", asJson);
        }
        brokerId = null;
      }
      if (brokerId === null) {
        const issued = core.issueBrokerCredential(gasparAuth);
        if (!issued.ok) {
          lock.release();
          return stepFailure("GASPAR_ENTRY_PREPARED", issued.error?.code ?? "EXECUTION_DENIED", issued.error?.message ?? "broker issue denied", asJson);
        }
        brokerId = issued.value!.id;
        try {
          deps.store.writeKey(account, issued.value!.secret, BROKER_KEY_SERVICE);
        } catch (e) {
          lock.release();
          return stepFailure("GASPAR_ENTRY_PREPARED", "KEYCHAIN_FAILURE", `Broker secret keychain write failed: ${e instanceof Error ? e.message : String(e)}`, asJson);
        }
      }
      try {
        writeFileSync(join(root, ".chrono", "broker-account"), `${account}\n${brokerId}\n`, "utf8");
      } catch (e) {
        lock.release();
        return stepFailure("GASPAR_ENTRY_PREPARED", "EXECUTION_DENIED", `Broker account file write failed: ${e instanceof Error ? e.message : String(e)}`, asJson);
      }
      const secret = safeReadKey(deps.store, account, BROKER_KEY_SERVICE);
      if (secret === null) {
        lock.release();
        return stepFailure("GASPAR_ENTRY_PREPARED", "KEYCHAIN_FAILURE", "Broker secret unreadable after keychain write", asJson);
      }
      const redeemed = core.redeemBrokerCredential({ brokerId, secret, adapterId: firstRuntime, runtime: firstRuntime });
      if (!redeemed.ok) {
        lock.release();
        return stepFailure("GASPAR_ENTRY_PREPARED", redeemed.error?.code ?? "EXECUTION_DENIED", redeemed.error?.message ?? "entry self-test denied", asJson);
      }
      core.revokeSession(redeemed.value!.session.id, gasparAuth);
      const failed = mark("GASPAR_ENTRY_PREPARED", { brokerId, entrySelfTest: "PASS" });
      if (failed !== null) {
        lock.release();
        return failed;
      }
    }

    // READY: readiness projection and next action.
    const readiness = buildReadiness(core, root, plan, probes);
    const done = mark("READY", readiness);
    if (done !== null) {
      lock.release();
      return done;
    }
    lock.release();
    const body = asJson
      ? JSON.stringify({ ok: true, ready: true, project: root, runtimes: plan.runtimeIds, readiness }, null, 2)
      : ["CHRONO project ready.", `  project: ${root}`, `  runtimes: ${plan.runtimeIds.join(", ")}`, `  next: ${String(readiness["nextAction"] ?? "open a configured runtime")}`].join("\n");
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    try {
      core.close();
    } catch {
      // Close is idempotent; teardown continues.
    }
  }
}

function projectRuntimeOf(core: ChronoCore): string | null {
  try {
    const status = core.status();
    if (status.ok) {
      return status.value?.details.runtime ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

function setupStepIndexOf(step: string): number {
  const order = [
    "DETECTED",
    "CONSENTED",
    "PROJECT_INITIALIZED",
    "PO_ENROLLED",
    "RUNTIMES_SELECTED",
    "RTK_VERIFIED_AND_ROUTED",
    "SKILL_VERIFIED_AND_EMITTED",
    "ADAPTERS_REGISTERED_AND_APPROVED",
    "NATIVE_HOOKS_INSTALLED",
    "RUNTIME_CONFORMANCE_PASSED",
    "GASPAR_ENTRY_PREPARED",
    "READY",
  ];
  return order.indexOf(step);
}

function prefixStepFailure(step: string, out: CliOutput, asJson: boolean): CliOutput {
  if (asJson) {
    let detail: unknown = null;
    try {
      detail = JSON.parse(out.stdout);
    } catch {
      detail = out.stderr;
    }
    return {
      exitCode: 1,
      stdout: JSON.stringify(
        { ok: false, step, error: detail, resume: "Re-run chrono init to resume from the recorded step" },
        null,
        2
      ),
      stderr: "",
    };
  }
  const reason = out.stderr.length > 0 ? out.stderr : out.stdout;
  return {
    exitCode: 1,
    stdout: "",
    stderr: [`FAILED at ${step}:`, reason, "Resume: re-run chrono init to resume from the recorded step."].join("\n"),
  };
}

function defaultRtkExec(probes: FlowProbes): (binary: string, args: string[]) => { exitCode: number; stdout: string } {
  return (binary, args) => {
    const res = probes.execFile([binary, ...args], 120000);
    return { exitCode: res.exitCode, stdout: res.stdout };
  };
}

function defaultRtkSpawn(
  probes: FlowProbes
): (cmd: string, args: string[], timeoutMs: number, env: Record<string, string>) => { status: number | null; stdout: string; stderr: string; timedOut: boolean } {
  return (cmd, args, timeoutMs) => {
    const res = probes.execFile([cmd, ...args], timeoutMs);
    return { status: res.exitCode, stdout: res.stdout, stderr: res.stderr, timedOut: false };
  };
}

function defaultSetupExec(
  probes: FlowProbes
): (cmd: string[], timeoutMs: number) => { exitCode: number; stdout: string; stderr: string } {
  return (cmd, timeoutMs) => probes.execFile(cmd, timeoutMs);
}

function buildReadiness(core: ChronoCore, root: string, plan: InitPlan, probes: FlowProbes): Record<string, unknown> {
  void probes;
  const status = core.status();
  const state = status.ok ? status.value?.state ?? "UNKNOWN" : "UNKNOWN";
  return {
    project: root,
    state,
    runtimes: plan.runtimeIds,
    nextAction: state === "ANALYZING" ? "Open a configured runtime: Gaspar begins product discovery" : "Open a configured runtime: Gaspar resumes the persisted state",
  };
}

async function resumeHealthCheck(core: ChronoCore, root: string, asJson: boolean): Promise<CliOutput> {
  const status = core.status();
  const body = asJson
    ? JSON.stringify({ ok: true, resumed: true, project: root, state: status.ok ? status.value?.state : "UNKNOWN" }, null, 2)
    : `CHRONO project already ready at '${root}'. State: ${status.ok ? status.value?.state : "UNKNOWN"}.`;
  return { exitCode: 0, stdout: body, stderr: "" };
}

/* ------------------------------------------------------------------ */
/* Doctor (read-only diagnostics)                                      */
/* ------------------------------------------------------------------ */

export interface DoctorReport {
  readonly found: boolean;
  readonly projectRoot: string;
  readonly launcherVersion: string;
  readonly pinnedVersion: string | null;
  readonly versionMatch: boolean;
  readonly setupStep: string | null;
  readonly projectState: string | null;
  readonly adapters: ReadonlyArray<{ id: string; status: string }>;
  readonly rtk: { attested: string; routing: Record<string, string> };
  readonly skill: { installed: boolean; state: string };
  readonly hooks: Record<string, boolean>;
  readonly broker: { visible: boolean; active: number; revoked: number };
  readonly entry: { ready: boolean; reasons: string[] };
}

export interface DoctorOptions {
  readonly json?: boolean | undefined;
  readonly as?: string | undefined;
  readonly session?: { id: string; token: string } | undefined;
}

/**
 * Read-only project diagnostics [§7]: compatibility, setup state,
 * adapters, RTK routing, skill activation, hooks, broker, and Gaspar
 * entry readiness. Opens the Core read-only and never writes. Broker
 * credentials are listed only with a gaspar/PO session; every other
 * check is unauthenticated.
 */
export function runDoctor(projectPath: string, options: DoctorOptions = {}): CliOutput {
  const asJson = options.json === true;
  const root = resolve(projectPath);
  const fail = (report: DoctorReport): CliOutput =>
    asJson
      ? { exitCode: 1, stdout: JSON.stringify({ ok: false, doctor: report }, null, 2), stderr: "" }
      : { exitCode: 1, stdout: "", stderr: renderDoctor(report) };
  const report: DoctorReport = {
    found: false,
    projectRoot: root,
    launcherVersion: CHRONO_VERSION,
    pinnedVersion: null,
    versionMatch: false,
    setupStep: null,
    projectState: null,
    adapters: [],
    rtk: { attested: "missing", routing: {} },
    skill: { installed: false, state: "missing" },
    hooks: {},
    broker: { visible: false, active: 0, revoked: 0 },
    entry: { ready: false, reasons: ["project not found"] },
  };
  const opened = openReadProject(root, asJson);
  if ("failure" in opened) {
    return fail(report);
  }
  const core = opened.core;
  try {
    const reasons: string[] = [];
    const pinnedVersion = core.pinnedCoreVersion();
    const setup = core.getSetupState();
    const setupStep = setup.ok && setup.value !== null && setup.value !== undefined ? setup.value.step : null;
    const status = core.status();
    const projectState = status.ok ? status.value?.state ?? null : null;
    let adapters: { id: string; status: string }[] = [];
    try {
      adapters = core.listAdapters().map((a: { id: string; status: string }) => ({ id: a.id, status: a.status }));
    } catch {
      reasons.push("adapter registry unreadable");
    }
    if (!adapters.some((a) => a.status === "active")) {
      reasons.push("no active adapter");
    }
    const rtkAttested = core.attestationCurrency("rtk").state;
    if (rtkAttested !== "current") {
      reasons.push(`RTK attestation ${rtkAttested}`);
    }
    const routing: Record<string, string> = {};
    for (const adapter of adapters) {
      if (adapter.status !== "active") {
        continue;
      }
      const scopes = core.routingProofScopes(adapter.id);
      const live = scopes.filter((proof) => !proof.expired);
      const authoritative = live.filter((proof) => proof.authority === "authoritative");
      if (authoritative.length > 0) {
        routing[adapter.id] = "proven";
        continue;
      }
      if (live.length > 0) {
        routing[adapter.id] = "candidate";
        reasons.push(`routing proof for '${adapter.id}' is a non-authoritative candidate: run chrono rtk promote after adapter approval`);
        continue;
      }
      routing[adapter.id] = "unproven";
      if (live.length === 0) {
        reasons.push(`no current routing proof for '${adapter.id}'`);
      }
    }
    // Kiro capability blocker [FIXES-SL-10.1 C4]: automatic Gaspar
    // entry on a real Kiro surface is unverified (no verified CLI
    // version on record; IDE version undetectable), so any Kiro
    // adapter — active or not — keeps entry unready. This is loud by
    // design: Kiro readiness requires genuine Kiro execution, and the
    // doctor must never report it on hermetic evidence alone.
    if (adapters.some((adapter) => adapter.id === "kiro")) {
      reasons.push(
        "Kiro adapter present but automatic Gaspar entry unverified (C4): real Kiro execution required before entry or dispatch; see FIXES-SL-10.1"
      );
    }
    const skill = core.describeSkillInstallation();
    if (!skill.installed) {
      reasons.push(`skill ${skill.code}`);
    }
    const hooks: Record<string, boolean> = checkManagedHooks(
      root,
      adapters.filter((a) => a.status === "active").map((a) => a.id)
    );
    for (const [path, intact] of Object.entries(hooks)) {
      if (!intact) {
        reasons.push(`hook drift: ${path}`);
      }
    }
    if (setupStep === null || setupStepIndex(setupStep) < setupStepIndex("ADAPTERS_REGISTERED_AND_APPROVED")) {
      reasons.push(`setup at '${setupStep ?? "not started"}': finish chrono init`);
    }
    let broker = { visible: false, active: 0, revoked: 0 };
    if (options.as !== undefined && options.session !== undefined) {
      const listed = core.listBrokerCredentials({ actor: options.as, session: options.session });
      if (listed.ok) {
        const creds = listed.value ?? [];
        const active = creds.filter((c: { revoked: boolean }) => !c.revoked).length;
        const revoked = creds.filter((c: { revoked: boolean }) => c.revoked).length;
        broker = { visible: true, active, revoked };
        if (active === 0) {
          reasons.push("no active broker credential");
        }
      } else {
        reasons.push(`broker list denied (${listed.error?.code ?? "unknown"})`);
      }
    } else {
      reasons.push("broker visibility needs a gaspar/PO session");
    }
    if (pinnedVersion !== CHRONO_VERSION) {
      reasons.push(`pinned Core ${pinnedVersion ?? "none"} mismatches launcher ${CHRONO_VERSION}`);
    }
    const filled: DoctorReport = {
      found: true,
      projectRoot: root,
      launcherVersion: CHRONO_VERSION,
      pinnedVersion,
      versionMatch: pinnedVersion === CHRONO_VERSION,
      setupStep,
      projectState,
      adapters,
      rtk: { attested: rtkAttested, routing },
      skill: { installed: skill.installed, state: skill.installed ? "current" : skill.code },
      hooks,
      broker,
      entry: { ready: reasons.length === 0, reasons },
    };
    const body = asJson ? JSON.stringify({ ok: filled.entry.ready, doctor: filled }, null, 2) : renderDoctor(filled);
    return filled.entry.ready
      ? { exitCode: 0, stdout: body, stderr: "" }
      : { exitCode: 1, stdout: asJson ? body : "", stderr: asJson ? "" : body };
  } finally {
    core.close();
  }
}

/** Byte-exact verification of managed hook/registration/definition assets. */
export function checkManagedHooks(
  projectRoot: string,
  activeAdapterIds: string[] = []
): Record<string, boolean> {
  const checkBytes = (relative: string, expected: string): boolean => {
    try {
      return readFileSync(join(projectRoot, relative), "utf8") === expected;
    } catch {
      return false;
    }
  };
  const checkContains = (relative: string, marker: string): boolean => {
    try {
      return readFileSync(join(projectRoot, relative), "utf8").includes(marker);
    } catch {
      return false;
    }
  };
  const checkPresent = (relative: string): boolean => {
    try {
      readFileSync(join(projectRoot, relative), "utf8");
      return true;
    } catch {
      return false;
    }
  };
  const checks: Record<string, boolean> = {
    // Shared assets: every setup installs these.
    ".opencode/plugins/chrono-gate.js": checkBytes(".opencode/plugins/chrono-gate.js", buildOpencodePlugin()),
    ".chrono/hooks/chrono-claude-gate.js": checkBytes(".chrono/hooks/chrono-claude-gate.js", buildClaudeHook()),
    ".chrono/hooks/chrono-kiro-gate.js": checkBytes(".chrono/hooks/chrono-kiro-gate.js", buildKiroHook()),
    ".chrono/hooks/chrono-entry-session.sh": checkBytes(
      ".chrono/hooks/chrono-entry-session.sh",
      buildEntrySessionScript()
    ),
    ".kiro/hooks/chrono-gate.json": checkBytes(".kiro/hooks/chrono-gate.json", buildKiroHookRegistration()),
    ".chrono/broker-account": checkPresent(".chrono/broker-account"),
    // The PreToolUse merge runs on every setup (shared enforcement
    // baseline); SessionStart and the agent definition are
    // Claude-scoped below.
    ".claude/settings.json:PreToolUse": checkContains(".claude/settings.json", "chrono-claude-gate.js"),
  };
  // Runtime-scoped assets apply only to active adapters carrying a known
  // runtime id (init registers adapters under runtime ids). Custom adapter
  // ids keep the shared assets; nothing is guessed for them.
  const runtimes = activeAdapterIds.filter((id): id is KnownRuntimeId => isKnownRuntimeId(id));
  if (runtimes.includes("claude-code")) {
    checks[".claude/agents/gaspar.md"] = checkBytes(".claude/agents/gaspar.md", buildGasparDefinition());
    checks[".claude/settings.json:SessionStart"] = checkContains(
      ".claude/settings.json",
      entrySessionCommand("claude-code")
    );
  }
  if (runtimes.includes("kiro")) {
    checks[".kiro/hooks/chrono-entry-kiro.json"] = checkBytes(
      kiroEntryRegistrationPath("kiro"),
      buildKiroEntryRegistration("kiro")
    );
  }
  return checks;
}

function renderDoctor(report: DoctorReport): string {
  const lines = [
    `project: ${report.projectRoot} (${report.found ? "found" : "missing"})`,
    `core: launcher ${report.launcherVersion}, pinned ${report.pinnedVersion ?? "none"} (${report.versionMatch ? "match" : "MISMATCH"})`,
    `setup: ${report.setupStep ?? "not started"}  state: ${report.projectState ?? "unknown"}`,
    `adapters: ${report.adapters.map((a) => `${a.id}[${a.status}]`).join(", ") || "none"}`,
    `rtk: ${report.rtk.attested} (${Object.entries(report.rtk.routing).map(([k, v]) => `${k}=${v}`).join(", ") || "no adapters"})`,
    `skill: ${report.skill.state}`,
    `hooks: ${Object.entries(report.hooks).map(([k, v]) => `${k}=${v ? "ok" : "DRIFT"}`).join(", ")}`,
    report.broker.visible
      ? `broker: ${String(report.broker.active)} active, ${String(report.broker.revoked)} revoked`
      : "broker: hidden (pass a gaspar/PO session to inspect)",
    report.entry.ready ? "entry: READY" : `entry: BLOCKED (${report.entry.reasons.join("; ")})`,
  ];
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Broker commands                                                     */
/* ------------------------------------------------------------------ */

export interface BrokerAuth {
  readonly as: string;
  readonly session: { id: string; token: string };
}

/**
 * Issue a broker credential. Prints the secret exactly once; with
 * `--store` it goes straight to the OS keychain under the broker
 * service (plus the non-secret account file for hook scripts) instead
 * of stdout. Either way the Core never sees the secret again.
 */
export function runBrokerIssue(
  projectPath: string,
  options: { json?: boolean | undefined; store?: boolean | undefined } & Partial<BrokerAuth>,
  deps: HumanCommandDeps = productionDeps()
): CliOutput {
  const asJson = options.json === true;
  const fail = (exitCode: number, code: string, reason: string): CliOutput =>
    asJson
      ? { exitCode, stdout: JSON.stringify({ ok: false, error: { code, message: reason } }, null, 2), stderr: "" }
      : { exitCode, stdout: "", stderr: `Error [${code}]: ${reason}` };
  if (options.as === undefined || options.as.length === 0 || options.session === undefined) {
    return fail(2, "VALIDATION_ERROR", "broker issue requires --as <gaspar|PO> and --session-token");
  }
  const root = resolve(projectPath);
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath: root, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const issued = core.issueBrokerCredential({ actor: options.as, session: options.session });
    if (!issued.ok) {
      return fail(1, issued.error?.code ?? "EXECUTION_DENIED", issued.error?.message ?? "broker issue denied");
    }
    const account = brokerAccountFor(root);
    if (options.store === true) {
      try {
        deps.store.writeKey(account, issued.value!.secret, BROKER_KEY_SERVICE);
        writeFileSync(join(root, ".chrono", "broker-account"), `${account}\n${issued.value!.id}\n`, "utf8");
      } catch (e) {
        return fail(1, "KEYCHAIN_FAILURE", `Broker secret store failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const body = asJson
        ? JSON.stringify({ ok: true, id: issued.value?.id, stored: true, account }, null, 2)
        : `Broker credential '${issued.value?.id}' issued and stored in the OS keychain (account '${account}'). The secret was never printed.`;
      return { exitCode: 0, stdout: body, stderr: "" };
    }
    const body = asJson
      ? JSON.stringify({ ok: true, id: issued.value?.id, secret: issued.value?.secret, account }, null, 2)
      : [
          `Broker credential '${issued.value?.id}' issued (account '${account}').`,
          `SECRET (shown once — place it in the OS keychain now, never in files or prompts): ${issued.value?.secret ?? ""}`,
        ].join("\n");
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

/** Revoke a broker credential (terminal; audited). */
export function runBrokerRevoke(
  projectPath: string,
  options: { id: string; json?: boolean | undefined } & Partial<BrokerAuth>
): CliOutput {
  const asJson = options.json === true;
  const fail = (exitCode: number, code: string, reason: string): CliOutput =>
    asJson
      ? { exitCode, stdout: JSON.stringify({ ok: false, error: { code, message: reason } }, null, 2), stderr: "" }
      : { exitCode, stdout: "", stderr: `Error [${code}]: ${reason}` };
  if (options.id.length === 0) {
    return fail(2, "VALIDATION_ERROR", "broker revoke requires --id");
  }
  if (options.as === undefined || options.as.length === 0 || options.session === undefined) {
    return fail(2, "VALIDATION_ERROR", "broker revoke requires --as <gaspar|PO> and --session-token");
  }
  const root = resolve(projectPath);
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath: root, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    const revoked = core.revokeBrokerCredential(options.id, { actor: options.as, session: options.session });
    if (!revoked.ok) {
      return fail(1, revoked.error?.code ?? "EXECUTION_DENIED", revoked.error?.message ?? "broker revoke denied");
    }
    const body = asJson
      ? JSON.stringify({ ok: true, id: options.id, revoked: true }, null, 2)
      : `Broker credential '${options.id}' revoked.`;
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

/** List broker credential metadata (never secret hashes). */
export function runBrokerList(
  projectPath: string,
  options: { json?: boolean | undefined } & Partial<BrokerAuth>
): CliOutput {
  const asJson = options.json === true;
  const opened = openReadProject(resolve(projectPath), asJson);
  if ("failure" in opened) {
    return opened.failure;
  }
  const core = opened.core;
  try {
    if (options.as === undefined || options.as.length === 0 || options.session === undefined) {
      const body = asJson
        ? JSON.stringify({ ok: false, error: { code: "VALIDATION_ERROR", message: "broker list requires --as <gaspar|PO> and --session-token" } }, null, 2)
        : "Error [VALIDATION_ERROR]: broker list requires --as <gaspar|PO> and --session-token";
      return { exitCode: 2, stdout: asJson ? body : "", stderr: asJson ? "" : body };
    }
    const listed = core.listBrokerCredentials({ actor: options.as, session: options.session });
    if (!listed.ok) {
      const body = asJson
        ? JSON.stringify({ ok: false, error: listed.error }, null, 2)
        : `Error [${listed.error?.code ?? "EXECUTION_DENIED"}]: ${listed.error?.message ?? "denied"}`;
      return { exitCode: 1, stdout: asJson ? body : "", stderr: asJson ? "" : body };
    }
    const body = asJson
      ? JSON.stringify({ ok: true, credentials: listed.value }, null, 2)
      : (listed.value?.length ?? 0) === 0
        ? "No broker credentials."
        : (listed.value ?? []).map((c) => `${c.id} [${c.revoked ? "revoked" : "active"}] issued ${c.createdAt}`).join("\n");
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

/* ------------------------------------------------------------------ */
/* Gaspar entry (adapter side)                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Gaspar entry (adapter side)                                         */
/* ------------------------------------------------------------------ */

export interface EntryOptions {
  readonly adapter: string;
  readonly broker: string;
  readonly runtime?: string | undefined;
  readonly tokenOut: string;
  readonly json?: boolean | undefined;
}

/**
 * Redeem Gaspar entry for a runtime adapter [§5.1]. The broker credential
 * id travels as `--broker` (public metadata, also kept in
 * `.chrono/broker-account` beside the keychain account name); the secret
 * arrives exclusively on stdin (piped by the adapter hook from the OS
 * keychain) and never appears in argv, env, logs, or output. The minted
 * session token is written to `--token-out` with 0600 permissions for
 * the adapter process; stdout carries only the safe entry projection.
 */
export function runEntry(projectPath: string, options: EntryOptions, stdinText: string): CliOutput {
  const asJson = options.json === true;
  const fail = (exitCode: number, code: string, reason: string): CliOutput =>
    asJson
      ? { exitCode, stdout: JSON.stringify({ ok: false, error: { code, message: reason } }, null, 2), stderr: "" }
      : { exitCode, stdout: "", stderr: `Error [${code}]: ${reason}` };
  if (options.adapter.length === 0) {
    return fail(2, "VALIDATION_ERROR", "entry requires --adapter <runtime adapter id>");
  }
  if (options.broker.length === 0) {
    return fail(2, "VALIDATION_ERROR", "entry requires --broker <credential id> (recorded in .chrono/broker-account)");
  }
  if (options.tokenOut.length === 0) {
    return fail(2, "VALIDATION_ERROR", "entry requires --token-out <path>: session tokens never print to stdout");
  }
  const secret = stdinText.trim();
  if (secret.length === 0) {
    return fail(2, "VALIDATION_ERROR", "entry requires the broker secret on stdin");
  }
  const root = resolve(projectPath);
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath: root, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    // Runtime defaults to the project's configured runtime (single-runtime
    // projects), else to the adapter id (multi-runtime convention from
    // setup, where each adapter proves under its own runtime string).
    let runtime = options.runtime;
    if (runtime === undefined) {
      const status = core.status();
      const configured = status.ok ? status.value?.details.runtime ?? null : null;
      runtime = configured ?? options.adapter;
    }
    const redeemed = core.redeemBrokerCredential({
      brokerId: options.broker,
      secret,
      adapterId: options.adapter,
      runtime,
    });
    if (!redeemed.ok) {
      return fail(1, redeemed.error?.code ?? "EXECUTION_DENIED", redeemed.error?.message ?? "entry denied");
    }
    try {
      writeFileSync(options.tokenOut, `${redeemed.value!.session.id}/${redeemed.value!.session.token}\n`, { mode: 0o600 });
    } catch (e) {
      return fail(1, "EXECUTION_DENIED", `Entry session token file write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const projection = redeemed.value!.projection;
    // Skill activation payload [FIXES-SL-10.1 C4]: the entry carries
    // everything the runtime needs to activate the pinned process
    // skill (pin, hashes, installed state). Whether the runtime honors
    // it is observed in real-runtime acceptance — the entry never
    // claims activation, only delivers the evidence for it.
    const skillInstallation = core.describeSkillInstallation();
    const skill = {
      installed: skillInstallation.installed,
      state: skillInstallation.installed ? "current" : skillInstallation.code,
      pinnedCommit: SKILL_RELEASE.pinnedCommit,
      sourceHash: SKILL_RELEASE.sourceHash,
      license: SKILL_RELEASE.license,
    };
    const body = asJson
      ? JSON.stringify({ ok: true, sessionId: redeemed.value!.session.id, projection, skill }, null, 2)
      : [
          `Gaspar entry: session '${redeemed.value!.session.id}' (expires ${redeemed.value!.session.expiresAt}).`,
          `state: ${projection.projectState}  next: ${projection.nextAction.key} — ${projection.nextAction.summary}`,
          ...projection.requiredDecisions.map((d) => `decision required: ${d}`),
          `skill: ${skill.installed ? `active (${skill.pinnedCommit.slice(0, 12)})` : `MISSING (${skill.state})`}`,
        ].join("\n");
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}

/* ------------------------------------------------------------------ */
/* Uninstall / removal (scoped, never silent about data)               */
/* ------------------------------------------------------------------ */

export type UninstallScope = "hooks" | "broker" | "adapters" | "project-data";

export interface UninstallOptions {
  readonly scope: string;
  readonly as?: string | undefined;
  readonly session?: { id: string; token: string } | undefined;
  readonly json?: boolean | undefined;
}

/** Project-local managed files owned by setup (never user data). */
const MANAGED_ASSET_PATTERNS: ReadonlyArray<{ dir: string; prefix: string; suffix: string }> = [
  { dir: ".opencode/plugins", prefix: "chrono-gate.", suffix: ".js" },
  { dir: ".chrono/hooks", prefix: "chrono-", suffix: ".js" },
  { dir: ".chrono/hooks", prefix: "chrono-", suffix: ".sh" },
  { dir: ".kiro/hooks", prefix: "chrono-", suffix: ".json" },
  { dir: ".claude/agents", prefix: "gaspar.", suffix: ".md" },
];

function removeManagedAssets(root: string): string[] {
  const removed: string[] = [];
  for (const pattern of MANAGED_ASSET_PATTERNS) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, pattern.dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(pattern.prefix) && entry.endsWith(pattern.suffix)) {
        try {
          rmSync(join(root, pattern.dir, entry));
          removed.push(join(pattern.dir, entry));
        } catch {
          // Best effort per file; the report lists what left.
        }
      }
    }
  }
  for (const relative of [".chrono/broker-account", ".chrono/init.lock"]) {
    try {
      rmSync(join(root, relative));
      removed.push(relative);
    } catch {
      // Absent files are not an error.
    }
  }
  return removed;
}

/** Strip CHRONO-managed entries from Claude settings, restoring backup. */
function removeClaudeManagedEntries(root: string): { removed: boolean; restored: boolean } {
  const settingsPath = join(root, ".claude", "settings.json");
  const backupPath = `${settingsPath}.chrono-bak`;
  let current: string;
  try {
    current = readFileSync(settingsPath, "utf8");
  } catch {
    return { removed: false, restored: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(current);
  } catch {
    return { removed: false, restored: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { removed: false, restored: false };
  }
  const doc = parsed as Record<string, unknown>;
  const hooks = doc["hooks"];
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return { removed: false, restored: false };
  }
  const table = { ...(hooks as Record<string, unknown>) };
  const isManaged = (node: unknown): boolean => {
    if (typeof node !== "object" || node === null) {
      return false;
    }
    if (Array.isArray(node)) {
      return node.some(isManaged);
    }
    const record = node as Record<string, unknown>;
    if (typeof record["command"] === "string" && record["command"].includes(".chrono/hooks/")) {
      return true;
    }
    return Object.values(record).some(isManaged);
  };
  let changed = false;
  for (const group of ["PreToolUse", "SessionStart"]) {
    const entries = table[group];
    if (!Array.isArray(entries)) {
      continue;
    }
    const kept = entries.filter((entry) => !isManaged(entry));
    if (kept.length !== entries.length) {
      changed = true;
      if (kept.length === 0) {
        delete table[group];
      } else {
        table[group] = kept;
      }
    }
  }
  if (!changed) {
    return { removed: false, restored: false };
  }
  if (Object.keys(table).length === 0) {
    delete doc["hooks"];
  } else {
    doc["hooks"] = table;
  }
  // Prefer the pre-CHRONO backup when it exists; otherwise persist the
  // stripped document. Either way the backup is consumed.
  try {
    const backup = readFileSync(backupPath, "utf8");
    JSON.parse(backup);
    writeFileSync(settingsPath, backup, "utf8");
    rmSync(backupPath);
    return { removed: true, restored: true };
  } catch {
    // No usable backup: persist stripped settings.
  }
  writeFileSync(settingsPath, JSON.stringify(doc, null, 2), "utf8");
  try {
    rmSync(backupPath, { force: true });
  } catch {
    // Best effort.
  }
  return { removed: true, restored: false };
}

/**
 * Scoped removal [§7]: hooks (generated assets + backup restoration),
 * broker (credential revocation), adapters (PO-only revocation), and
 * project-data (interactive PO-only destruction of `.chrono` with an
 * explicit typed challenge). Package uninstall never touches projects:
 * there are no install/uninstall lifecycle hooks, asserted by test.
 */
export function runUninstall(
  projectPath: string,
  options: UninstallOptions,
  deps: HumanCommandDeps = productionDeps(),
  confirm: (planText: string, challenge: string) => string | null = promptInitConsent
): CliOutput {
  const asJson = options.json === true;
  const fail = (exitCode: number, code: string, reason: string): CliOutput =>
    asJson
      ? { exitCode, stdout: JSON.stringify({ ok: false, error: { code, message: reason } }, null, 2), stderr: "" }
      : { exitCode, stdout: "", stderr: `Error [${code}]: ${reason}` };
  const root = resolve(projectPath);
  const scope = options.scope;
  if (scope !== "hooks" && scope !== "broker" && scope !== "adapters" && scope !== "project-data") {
    return fail(2, "VALIDATION_ERROR", "uninstall requires --scope hooks|broker|adapters|project-data");
  }
  if (scope === "hooks") {
    const removed = removeManagedAssets(root);
    const claude = removeClaudeManagedEntries(root);
    const body = asJson
      ? JSON.stringify({ ok: true, scope, removed, claudeSettingsRestored: claude.restored }, null, 2)
      : [`Removed ${String(removed.length)} managed asset(s).`, claude.restored ? "Claude settings restored from backup." : "Claude settings: no CHRONO entries found."].join("\n");
    return { exitCode: 0, stdout: body, stderr: "" };
  }
  if (scope === "project-data") {
    if (!deps.interactive) {
      return fail(2, "CONSENT_REQUIRED", "Removing project data requires an interactive PO with a typed challenge");
    }
    const fingerprint = createHash("sha256").update(root, "utf8").digest("hex").slice(0, 8);
    const challenge = `delete project data ${fingerprint}`;
    const typed = confirm(
      `DANGER: this permanently deletes '${join(root, ".chrono")}' including approvals, evidence, and audit history. This cannot be undone.`,
      challenge
    );
    if (typed === null) {
      return fail(2, "CONSENT_REQUIRED", "Project-data removal requires a controlling terminal with typed confirmation");
    }
    if (typed !== challenge) {
      return fail(2, "VALIDATION_ERROR", "Project-data confirmation does not match: nothing was deleted");
    }
    try {
      rmSync(join(root, ".chrono"), { recursive: true });
    } catch (e) {
      return fail(1, "EXECUTION_DENIED", `Project-data removal failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const body = asJson
      ? JSON.stringify({ ok: true, scope, removed: [".chrono"], warning: "Authoritative project data deleted with PO confirmation" }, null, 2)
      : "Deleted '.chrono' with PO confirmation. This cannot be undone.";
    return { exitCode: 0, stdout: body, stderr: "" };
  }
  // broker + adapters scopes need an authorized session (no new minting).
  if (options.as === undefined || options.as.length === 0 || options.session === undefined) {
    return fail(2, "VALIDATION_ERROR", `uninstall --scope ${scope} requires --as <gaspar|PO> and --session-token`);
  }
  let core: ChronoCore;
  try {
    core = new ChronoCore({ projectPath: root, pinnedVersion: CHRONO_VERSION });
  } catch (e) {
    return constructionFailure(e, asJson);
  }
  try {
    if (scope === "broker") {
      const listed = core.listBrokerCredentials({ actor: options.as, session: options.session });
      if (!listed.ok) {
        return fail(1, listed.error?.code ?? "EXECUTION_DENIED", listed.error?.message ?? "broker list denied");
      }
      const revoked: string[] = [];
      for (const cred of listed.value ?? []) {
        if (cred.revoked) {
          continue;
        }
        const res = core.revokeBrokerCredential(cred.id, { actor: options.as, session: options.session });
        if (!res.ok) {
          return fail(1, res.error?.code ?? "EXECUTION_DENIED", res.error?.message ?? "broker revoke denied");
        }
        revoked.push(cred.id);
      }
      try {
        deps.store.deleteKey(brokerAccountFor(root), BROKER_KEY_SERVICE);
      } catch {
        // Keychain absence is not fatal to revocation.
      }
      const body = asJson
        ? JSON.stringify({ ok: true, scope, revoked }, null, 2)
        : `Revoked ${String(revoked.length)} broker credential(s).`;
      return { exitCode: 0, stdout: body, stderr: "" };
    }
    // adapters scope: PO-only revocation of every active adapter.
    const adapters = core.listAdapters().filter((a) => a.status === "active");
    const revoked: string[] = [];
    for (const adapter of adapters) {
      const res = core.revokeAdapter(adapter.id, { actor: options.as, session: options.session });
      if (!res.ok) {
        return fail(1, res.error?.code ?? "EXECUTION_DENIED", res.error?.message ?? `adapter revoke denied for '${adapter.id}'`);
      }
      revoked.push(adapter.id);
    }
    const body = asJson
      ? JSON.stringify({ ok: true, scope, revoked }, null, 2)
      : `Revoked ${String(revoked.length)} adapter(s).`;
    return { exitCode: 0, stdout: body, stderr: "" };
  } finally {
    core.close();
  }
}
