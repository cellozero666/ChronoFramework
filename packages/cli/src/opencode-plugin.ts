/**
 * OpenCode pre-tool enforcement + automatic Gaspar activation plugin,
 * generated deterministically (Slice 8–9, [RUNTIME §5]; OC-P9 hardening).
 * `chrono setup` writes these exact bytes to
 * `<project>/.opencode/plugins/chrono-gate.js`; the content never embeds
 * machine-specific paths, so identical inputs always produce identical
 * bytes.
 *
 * Verified against the installed OpenCode 1.18.30 plugin contract
 * (`@opencode-ai/plugin@1.18.30`, `@opencode-ai/sdk@1.18.30`):
 * - project plugins in `.opencode/plugins/` auto-load at startup;
 * - a plugin module exports one or more plugin functions
 *   `(ctx) => Promise<Hooks>`;
 * - `event` receives `{event}` where `session.created` carries
 *   `properties.info.id` (the OpenCode session id);
 * - `tool.execute.before` receives `{tool, sessionID, callID}`
 *   (sessionID required);
 * - `chat.message` receives `{sessionID, ...}` (sessionID required) and
 *   fires when a user message is received, before generation;
 * - `experimental.chat.system.transform` receives
 *   `{sessionID?, model}` (sessionID OPTIONAL) with `{system: string[]}`
 *   and fires while the LLM request is prepared.
 *
 * OC-P9 failure: a provider-backed pilot answered a first message with a
 * generic greeting and no Gaspar activation. Contributing defects fixed
 * here:
 * - session correlation used fictional shapes (`properties.sessionID`)
 *   and a catch-all `"default"` bucket, so prefetch state never matched
 *   the transform/message session;
 * - `session.created` prefetch was fire-and-forget while the transform
 *   assumed ordering that the runtime never guarantees;
 * - nothing gated the first *message*: when the transform path was
 *   skipped or silent, the default agent answered ungoverned.
 *
 * Enforcement contract (explicit environment, never invented identity):
 * - Outside a CHRONO project (no .chrono/chrono.db under the session
 *   directory): pass, plain OpenCode use is unaffected.
 * - Inside a CHRONO project: Gaspar entry is MANDATORY. `chat.message`
 *   synchronously ensures a validated entry projection exists for the
 *   exact session (fail-closed); `experimental.chat.system.transform`
 *   awaits the same per-session entry work (one promise per session —
 *   prefetch/transform/message deduplicate, never depend on ordering)
 *   and injects the deterministic Gaspar contract exactly once before
 *   the first model request. ANY missing, pending-unresolved, failed,
 *   malformed, oversized, or expired projection throws a stable
 *   secret-safe `ENTRY_BLOCKED` instead of answering ungoverned.
 * - `tool.execute.before` additionally denies EVERY tool (including
 *   reads) while entry is unproven, so a renamed/removed upstream hook
 *   degrades to denial, never to silent agency.
 * - Runtime evidence (plugin load, entry redeem, projection injection,
 *   entry blocks) is appended to `.chrono/runtime-activation.jsonl`
 *   with non-secret metadata only — never prompts, user content,
 *   secrets, tokens, or credentials. `chrono doctor` reports it without
 *   ever claiming activation from static assets.
 * - Session tokens: never held here, never logged, never modeled. The
 *   entry script confines the token to a 0600 file; only the safe JSON
 *   projection travels on stdout into this plugin. Stale token files
 *   (older than twice the broker session TTL, CHRONO-namespaced names
 *   only) are swept best-effort on session create/delete and plugin
 *   dispose; failed entry creates no file at all.
 *
 * The plugin uses only `node:child_process` / `node:fs` / `node:path` /
 * `node:crypto` (available in Bun and Node), so the generated file is
 * directly importable in tests: enforcement logic runs for real, with
 * only the gate/entry binaries substituted by fixtures.
 *
 * Tool policy version: TOOL_POLICY_VERSION=2 (see @chrono/domain
 * OPENCODE_TOOL_POLICY). The lists below are generated from that policy;
 * the Core remains the authority — the plugin only shapes the intake.
 *
 * OC-P11 planning distinction: `bash` invocations that are EXACTLY a
 * governed planning operation (`chrono artifact propose|revise|status`,
 * `chrono discovery record`, `chrono plan status`, `chrono status`,
 * `chrono validate`, `chrono doctor` — no chaining, no substitution)
 * follow the planning path (entry proven; session enforced by the CLI
 * through the host session environment, never through model-visible
 * arguments). Every other mutable tool — including generic
 * write/edit/bash — still requires Module dispatch context. Reads that
 * reference internal/security state (.chrono/chrono.db, broker-account,
 * token files, internal hooks) are denied even though reads otherwise
 * pass without dispatch scope.
 */

import { SKILL_RELEASE } from "@chrono/domain";

const READ_TOOLS = ["glob", "grep", "lsp", "question", "read", "skill", "todowrite"];
const MUTATE_TOOLS = [
  "apply_patch",
  "bash",
  "edit",
  "webfetch",
  "websearch",
  "write",
];

export function buildOpencodePlugin(): string {
  return `/**
  * CHRONO enforcement + Gaspar activation for OpenCode. GENERATED by
  * \`chrono setup --adapter <id>\` — do not hand-edit.
  *
  * Contract (verified against @opencode-ai/plugin@1.18.30):
  * - Outside a CHRONO project (no .chrono/chrono.db under the session
  *   directory): pass, plain OpenCode use is unaffected.
  * - Inside a CHRONO project: Gaspar entry is MANDATORY. \`chat.message\`
  *   ensures a validated entry projection for the exact session;
  *   \`experimental.chat.system.transform\` awaits the same per-session
  *   work and injects the Gaspar contract exactly once before the first
  *   model request. Prefetch on \`session.created\` is an optimization
  *   only — correctness never depends on event ordering or timing.
  *   ANY entry failure throws ENTRY_BLOCKED and fails the request
  *   instead of answering ungoverned.
   * - Read-only tools pass without dispatch scope once entry is proven,
   *   except reads referencing internal/security state (denied: use
   *   projections instead);
   *   \`bash\` invocations that are EXACTLY a governed planning operation
   *   (\`chrono artifact propose|revise|status\`, \`chrono doctor\`,
   *   \`chrono status|validate\`) pass with entry only — the planning CLI
   *   enforces the Gaspar/PO session itself;
   *   every other mutable tool requires CHRONO_GATE_MODULE (+ optional
   *   CHRONO_GATE_WP), CHRONO_GATE_AS, CHRONO_GATE_ROLE, and
   *   CHRONO_SESSION_TOKEN and a live \`chrono gate execution\` AUTHORIZED
   *   verdict. Unknown tools are denied until classified (deny-by-default).
   *   While entry is unproven, EVERY tool (including reads) is denied.
   *   Anything missing or DENIED throws (fail-closed).
  * - Runtime evidence lands in .chrono/runtime-activation.jsonl
  *   (non-secret metadata only). Session tokens are never held here,
  *   never logged, never modeled.
  */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, sep } from "node:path";

const READ_TOOLS = new Set(${JSON.stringify(READ_TOOLS)});
const MUTATE_TOOLS = new Set(${JSON.stringify(MUTATE_TOOLS)});
const SKILL_PINNED_COMMIT = ${JSON.stringify(SKILL_RELEASE.pinnedCommit)};
const SKILL_SOURCE_HASH = ${JSON.stringify(SKILL_RELEASE.sourceHash)};

// Fail-closed entry bounds (documented, deterministic).
// CHRONO_ENTRY_TIMEOUT_MS overrides the entry execution timeout per
// attempt (default 30000); non-numeric or non-positive values fall
// back. Read per attempt so host configuration applies without reload.
const ENTRY_TIMEOUT_DEFAULT_MS = 30000;
const ENTRY_MAX_ATTEMPTS = 3;
const ENTRY_PROJECTION_MAX_BYTES = 65536;
const ENTRY_CHILD_STDOUT_MAX_BYTES = 1048576;
const ENTRY_CHILD_STDERR_MAX_BYTES = 65536;
const TOKEN_STALE_MS = 3600 * 1000;
const TOKEN_FILE_PREFIX = "chrono-gaspar-";
const TOKEN_FILE_SUFFIX = ".token";
const ACTIVATION_EVIDENCE_REL = ".chrono/runtime-activation.jsonl";
const ACTIVATION_EVIDENCE_MAX_LINES = 300;
const PLUGIN_GENERATOR = "chrono-gate/oc-p9";

function readEnv(name) {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}

function tmpDir() {
  return process.env["TMPDIR"] ?? process.env["TMP"] ?? process.env["TEMP"] ?? "/tmp";
}

function sha256hex(text) {
  try {
    return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
  } catch {
    return "unhashable";
  }
}

function chronoProjectRoot(directory) {
  // Canonical project resolution (same contract as the CLI resolver in
  // packages/cli/src/project.ts): canonicalize once; the innermost Git
  // root is the maximum upward boundary; outside Git, shared temporary
  // directories are never adopted from and never traversed.
  // Deliberately uncached: a project initialized after plugin load must
  // be enforced immediately, never served a stale pass-through.
  const canonical = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  const canonicalStart = canonical(directory || process.cwd());
  if (canonicalStart === null) {
    return null;
  }
  let gitRoot = null;
  try {
    const raw = execFileSync("git", ["-C", canonicalStart, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    gitRoot = realpathSync(String(raw).trim());
  } catch {
    gitRoot = null;
  }
  const withinOrEqual = (dir, boundary) => dir === boundary || dir.startsWith(boundary + sep);
  const tempCandidates = [tmpDir(), "/tmp", "/private/tmp", "/var/tmp"];
  const tempBoundaries = [];
  if (gitRoot === null) {
    const seen = new Set();
    for (const candidate of tempCandidates) {
      const resolved = canonical(candidate);
      if (resolved !== null && !seen.has(resolved)) {
        seen.add(resolved);
        tempBoundaries.push(resolved);
      }
    }
  }
  let resolved = null;
  let current = canonicalStart;
  for (let depth = 0; depth < 64; depth++) {
    if (gitRoot !== null && !withinOrEqual(current, gitRoot)) {
      break;
    }
    if (gitRoot === null && current !== canonicalStart && tempBoundaries.includes(current)) {
      break;
    }
    let hasDb = false;
    try {
      hasDb = existsSync(join(current, ".chrono", "chrono.db"));
    } catch {
      break;
    }
    if (hasDb) {
      resolved = current;
      break;
    }
    if (gitRoot !== null && current === gitRoot) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return resolved;
}

function openCodeSessionId(value) {
  // Real @opencode-ai/sdk@1.18.30 shapes:
  // - hook inputs carry sessionID directly (tool.execute.before and
  //   chat.message require it; system.transform declares it optional);
  // - session.created/session.deleted events carry properties.info.id.
  // Legacy tolerated shapes follow; anything else is null (never a
  // catch-all bucket: anonymous callers resolve per project root).
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  if (typeof value !== "object") {
    return null;
  }
  const direct = value.sessionID ?? value.session_id ?? value.sessionId ?? value.id;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const props = value.properties;
  if (props !== null && typeof props === "object") {
    const info = props.info;
    if (info !== null && typeof info === "object" && typeof info.id === "string" && info.id.length > 0) {
      return info.id;
    }
    for (const key of ["sessionID", "session_id", "sessionId", "id"]) {
      const candidate = props[key];
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }
  }
  const nested = value.event;
  if (nested !== null && typeof nested === "object") {
    return openCodeSessionId(nested);
  }
  return null;
}

function redactTokenPaths(text) {
  return String(text ?? "").replace(/chrono-gaspar-[^\\s"']*\\.token/g, "[token path redacted]");
}

function doctorHint(root) {
  return "Run \`chrono doctor --path " + root + "\` for recovery.";
}

  function gateFor(tool) {
    if (READ_TOOLS.has(tool)) {
      return "read";
    }
    if (MUTATE_TOOLS.has(tool)) {
      return "mutate";
    }
    return "unknown";
  }

  // OC-P11: governed planning operations (narrow allowlist, mirrored
  // from @chrono/domain PLANNING_BASH_PREFIXES — the generated file
  // carries its own copy so enforcement never depends on an import).
  // A bash command qualifies ONLY when it is exactly one of these
  // operations with no shell chaining or substitution: anything else —
  // including a planning-looking string embedded in a larger script —
  // stays on the implementation-dispatch path.
  const PLANNING_BASH_PREFIXES = [
    "chrono artifact propose",
    "chrono artifact revise",
    "chrono artifact status",
    "chrono discovery record",
    "chrono plan status",
    "chrono status",
    "chrono validate",
    "chrono doctor",
  ];

  // Internal/security-state references that generic reads must never
  // serve (OC-P11 req 16). Safe Core projections (status, doctor,
  // artifact status) are the only way to observe this state.
  const FORBIDDEN_READ_SUBSTRINGS = [
    ".chrono/chrono.db",
    ".chrono/broker-account",
    ".chrono/hooks/",
    "chrono-gaspar-",
    ".token",
    "CHRONO_SESSION_TOKEN",
  ];

  function referencesForbiddenState(text) {
    const haystack = String(text ?? "");
    return FORBIDDEN_READ_SUBSTRINGS.some((needle) => haystack.includes(needle));
  }

  function extractBashCommand(toolInput) {
    if (typeof toolInput === "string") {
      return toolInput;
    }
    if (toolInput === null || typeof toolInput !== "object") {
      return null;
    }
    const record = toolInput;
    for (const key of ["command", "cmd", "input", "script"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
    // Fallback: some runtimes nest arguments one level deeper.
    for (const value of Object.values(record)) {
      if (value !== null && typeof value === "object") {
        const nested = extractBashCommand(value);
        if (nested !== null) {
          return nested;
        }
      }
    }
    return null;
  }

  function isPlanningBashCommand(command) {
    const normalized = String(command ?? "").trim().replace(/\\s+/g, " ");
    // No chaining, piping, substitution, or backgrounding: a planning
    // operation is exactly one chrono invocation.
    if (/[;|&$\\\`\\\\]/.test(normalized)) {
      return false;
    }
    // A bare chrono binary path prefix (./bin, absolute) still names
    // the same governed surface: accept a trailing path segment.
    const withoutBinary = normalized.replace(/^([\\w\\-./\\\\:]+\\/)?chrono(\\.exe|\\.cmd|\\.bat)? /, "chrono ");
    if (withoutBinary === normalized && !normalized.startsWith("chrono ")) {
      return false;
    }
    const candidate = withoutBinary;
    return PLANNING_BASH_PREFIXES.some(
      (prefix) => candidate === prefix || candidate.startsWith(prefix + " ")
    );
  }

export const ChronoGatePlugin = async (ctx) => {
  // Per-session entry state machine. Exactly one entry execution exists
  // per session key at a time: "pending" carries the shared promise so
  // prefetch (session.created), gating (chat.message), injection
  // (system.transform), and tool backstops deduplicate instead of
  // racing; "ok" carries the validated payload plus injection state;
  // "blocked" carries the stable failure with its attempt count.
  // Bounded: oldest sessions evict past 100 entries, and
  // session.deleted drops state immediately. A failed first request may
  // retry after recovery within ENTRY_MAX_ATTEMPTS; terminal sessions
  // fail fast until OpenCode restarts them.
  const entryStates = new Map();
  // Latest OpenCode session per project root (from session.created):
  // lets a transform without sessionID join the session it belongs to
  // instead of minting a duplicate entry.
  const latestByRoot = new Map();
  let pluginLoadLogged = false;

  function entryBlocked(code, reason, root, attempts) {
    const attemptNote = attempts >= ENTRY_MAX_ATTEMPTS ? " Entry will not be retried for this session: restart OpenCode after recovery." : "";
    return new Error(
      "[chrono] ENTRY_BLOCKED[" + code + "]: " + reason + "." + attemptNote + " " + doctorHint(root)
    );
  }

  function dirHash(root) {
    return sha256hex(root).slice(0, 16);
  }

  function logEvidence(root, record) {
    // Non-secret runtime evidence only: adapter/session/projection
    // metadata that proves the plugin loaded, entry redeemed, and the
    // projection reached the model request. Prompts, user content,
    // secrets, tokens, credentials, and key material MUST NEVER appear
    // here — keys are dropped defensively even if a caller passes one.
    try {
      const safe = { v: 1, ts: new Date().toISOString(), adapter: "opencode", generator: PLUGIN_GENERATOR, dir: dirHash(root) };
      for (const [key, value] of Object.entries(record ?? {})) {
        if (/secret|token|password|credential|keychain|private|prompt|content|message|args|env/i.test(key)) {
          continue;
        }
        safe[key] = value;
      }
      if (typeof safe.reason === "string") {
        safe.reason = redactTokenPaths(safe.reason).slice(0, 500);
      }
      const path = join(root, ACTIVATION_EVIDENCE_REL);
      let lines = [];
      try {
        const previous = readFileSync(path, "utf8");
        lines = previous.split("\\n").filter((line) => line.length > 0);
      } catch {
        lines = [];
      }
      lines.push(JSON.stringify(safe));
      while (lines.length > ACTIVATION_EVIDENCE_MAX_LINES) {
        lines = lines.slice(lines.length - ACTIVATION_EVIDENCE_MAX_LINES);
      }
      writeFileSync(path, lines.join("\\n") + "\\n", "utf8");
    } catch {
      // Evidence is observability, never enforcement: a logging failure
      // must not fail a request or leak anything.
    }
  }

  function publicSessionKey(key, root) {
    // Evidence-safe session label: the exact OpenCode session id when
    // known (opaque local metadata, not a credential), else "anonymous".
    if (typeof key === "string" && !key.startsWith("anonymous@")) {
      return key;
    }
    return "anonymous";
  }

  function validateProjection(text) {
    if (text.length > ENTRY_PROJECTION_MAX_BYTES) {
      return { error: { code: "ENTRY_OVERSIZED", reason: "entry projection exceeds the " + ENTRY_PROJECTION_MAX_BYTES + " byte bound" } };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { error: { code: "ENTRY_MALFORMED", reason: "entry projection is not parseable JSON" } };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: { code: "ENTRY_MALFORMED", reason: "entry projection is not a JSON object" } };
    }
    if (parsed.ok !== true) {
      const detail =
        parsed.error && typeof parsed.error.code === "string" ? " (" + parsed.error.code + ")" : "";
      return { error: { code: "ENTRY_DENIED", reason: "entry redeem refused" + detail } };
    }
    if (typeof parsed.sessionId !== "string" || !/^SES-[0-9]+$/.test(parsed.sessionId)) {
      return { error: { code: "ENTRY_MALFORMED", reason: "entry projection lacks a valid session id" } };
    }
    const projection = parsed.projection;
    if (typeof projection !== "object" || projection === null || Array.isArray(projection)) {
      return { error: { code: "ENTRY_MALFORMED", reason: "entry projection lacks a projection object" } };
    }
    if (typeof projection.projectState !== "string" || projection.projectState.length === 0) {
      return { error: { code: "ENTRY_MALFORMED", reason: "entry projection lacks projectState" } };
    }
    const nextAction = projection.nextAction;
    if (typeof nextAction !== "object" || nextAction === null || typeof nextAction.key !== "string" || nextAction.key.length === 0) {
      return { error: { code: "ENTRY_MALFORMED", reason: "entry projection lacks nextAction.key" } };
    }
    if (projection.requiredDecisions !== undefined && !Array.isArray(projection.requiredDecisions)) {
      return { error: { code: "ENTRY_MALFORMED", reason: "entry projection requiredDecisions is not an array" } };
    }
    const skill = typeof parsed.skill === "object" && parsed.skill !== null ? parsed.skill : null;
    // Atomic payload: canonical JSON of exactly the validated fields.
    // Never truncated: oversized input is rejected above, not sliced.
    const payload = JSON.stringify({
      sessionId: parsed.sessionId,
      projection: {
        projectState: projection.projectState,
        nextAction: { key: nextAction.key, summary: typeof nextAction.summary === "string" ? nextAction.summary : "" },
        requiredDecisions: Array.isArray(projection.requiredDecisions) ? projection.requiredDecisions.filter((d) => typeof d === "string") : [],
        blockers: Array.isArray(projection.blockers) ? projection.blockers : undefined,
      },
      skill: skill ?? undefined,
    });
    return { payload, entrySessionId: parsed.sessionId, skill };
  }

  function buildGasparContract(state) {
    // Deterministic Gaspar activation contract (OC-P9): identity,
    // Product Owner recognition, state-aware opening, mandatory skill
    // activation, Core-decision compliance, and Gaspar-only authority.
    // The validated projection travels as machine-readable JSON inside
    // <chrono-projection>; nothing here is conversation history.
    const body = JSON.parse(state.payload);
    const projection = body.projection;
    const skill = body.skill !== undefined && body.skill !== null ? body.skill : null;
    const skillState =
      skill !== null && skill.installed === true
        ? "The Core reports the mandatory process skill installed for this session."
        : "The Core does NOT report the mandatory process skill installed: stop and direct the Product Owner to run chrono init to repair skills; do not proceed ungoverned.";
    return [
      "<chrono-gaspar-entry>",
      "You are Gaspar, the Guru of Time — the CHRONO systems analyst, software architect, and orchestrator.",
      "The human you are speaking with is the Product Owner and Principal Architect: the final authority over product requirements, business rules, scope, significant architecture, conscious risk acceptance, and authority conflicts. Never override an explicit Product Owner decision. Never invent product requirements.",
      "Your FIRST message in this session MUST identify yourself as Gaspar, recognize the human as the Product Owner, and begin or resume the governed workflow described by the projection below. Never answer as a generic assistant.",
      "Authoritative entry projection from the project-pinned CHRONO Core. Derive your opening strictly from it, never from chat history:",
      "<chrono-projection>",
      state.payload,
      "</chrono-projection>",
      "Project state: " + projection.projectState + ". Required next action: " + projection.nextAction.key + " — " + projection.nextAction.summary,
      "Mandatory process skill — activate BEFORE any analysis, planning, implementation, testing, security review, or verification: karpathy-guidelines, pinned commit " + SKILL_PINNED_COMMIT + " (source " + SKILL_SOURCE_HASH + "). " + skillState + " Behaviors: think before coding; simplicity first (never simplify away security, traceability, evidence, gates, error handling, or approved scope); surgical changes; goal-driven verified execution. Precedence: Product Owner, then CHRONO protocols and Core, then approved artifacts and Harness, then role rules, then Karpathy Guidelines.",
      "Authority: act only inside the Gaspar role. Obey Core approvals, gates, blockers, waivers, and escalation paths. Do not claim Spekkio verification authority, Product Owner authority, or completion powers beyond Gaspar.",
      "Planning bootstrap (OC-P11): materialize analysis, requirements, architecture/ADRs, Specs, harness drafts, security proposals, and roadmap or Module/Work Package plans ONLY through the Core-governed chrono artifact propose|revise|status path (never generic write/edit/bash). Chrono run execution grants are reserved for authorized implementation work. A Product Owner statement in chat such as approved is NOT a registered approval: report it only as PO stated approval in chat and present the exact chrono approve ceremony. Only a successful Core-signed approval may be reported as registered. Never read internal database, broker account files, token files, or internal hook contents through generic tools: use the safe Core projections instead.",
      "</chrono-gaspar-entry>",
    ].join("\\n");
  }

  function runEntryChild(root, adapter, chronoBin, timeoutMs) {
    // Asynchronous entry execution with a hard timeout kill so the
    // awaiting hooks stay responsive and concurrent callers share one
    // per-session promise instead of spawning duplicate entries.
    return new Promise((resolve) => {
      const script = join(root, ".chrono", "hooks", "chrono-entry-session.sh");
      let scriptPresent = false;
      try {
        scriptPresent = existsSync(script);
      } catch {
        scriptPresent = false;
      }
      if (!scriptPresent) {
        resolve({ error: { code: "ENTRY_SCRIPT_MISSING", reason: "managed entry script is missing" } });
        return;
      }
      let child = null;
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (outcome) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        try {
          if (child !== null) {
            child.kill("SIGKILL");
          }
        } catch {
          // Kill is best-effort; the timeout outcome stands regardless.
        }
        finish({ error: { code: "ENTRY_TIMEOUT", reason: "entry execution timed out after " + timeoutMs + "ms" } });
      }, timeoutMs);
      try {
        // cwd is the validated project root (OC-P9 black-box finding):
        // the entry script resolves its project from its own working
        // directory, so inheriting an unrelated host cwd would redeem
        // (or silently skip) the wrong project. The plugin already
        // proved the root; the child starts exactly there.
        child = spawn("sh", [script, adapter], {
          cwd: root,
          env: { ...process.env, CHRONO_BIN: chronoBin },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        clearTimeout(timer);
        finish({ error: { code: "ENTRY_SPAWN_FAILED", reason: "entry execution failed to spawn" } });
        return;
      }
      if (child === null) {
        clearTimeout(timer);
        finish({ error: { code: "ENTRY_SPAWN_FAILED", reason: "entry execution failed to spawn" } });
        return;
      }
      if (child.stdout !== null) {
        child.stdout.on("data", (chunk) => {
          if (stdout.length < ENTRY_CHILD_STDOUT_MAX_BYTES) {
            stdout += chunk.toString("utf8").slice(0, ENTRY_CHILD_STDOUT_MAX_BYTES - stdout.length);
          }
        });
      }
      if (child.stderr !== null) {
        child.stderr.on("data", (chunk) => {
          if (stderr.length < ENTRY_CHILD_STDERR_MAX_BYTES) {
            stderr += chunk.toString("utf8").slice(0, ENTRY_CHILD_STDERR_MAX_BYTES - stderr.length);
          }
        });
      }
      child.on("error", () => {
        clearTimeout(timer);
        finish({ error: { code: "ENTRY_SPAWN_FAILED", reason: "entry execution failed to spawn" } });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const note = redactTokenPaths(String(stderr).trim().split("\\n")[0] ?? "").slice(0, 300);
          finish({
            error: {
              code: "ENTRY_DENIED",
              reason: "entry script exited " + String(code) + (note.length > 0 ? ": " + note : ""),
            },
          });
          return;
        }
        const out = String(stdout).trim();
        if (out.length === 0) {
          finish({ error: { code: "ENTRY_MALFORMED", reason: "entry script produced no output" } });
          return;
        }
        finish(validateProjection(out));
      });
    });
  }

  function entryTimeoutMs() {
    const timeoutOverride = Number(readEnv("CHRONO_ENTRY_TIMEOUT_MS"));
    return Number.isFinite(timeoutOverride) && timeoutOverride > 0 ? Math.floor(timeoutOverride) : ENTRY_TIMEOUT_DEFAULT_MS;
  }

  function ensureEntryAsync(root, sessionKey) {
    // One promise per session key: concurrent prefetch, message gate,
    // transform, and tool backstop callers await the SAME entry work.
    // Correctness never depends on event ordering or timing.
    const known = entryStates.get(sessionKey);
    if (known !== undefined && known.status === "ok") {
      return Promise.resolve(known);
    }
    if (known !== undefined && known.status === "pending") {
      return known.promise;
    }
    if (known !== undefined && known.status === "blocked" && known.attempts >= ENTRY_MAX_ATTEMPTS) {
      return Promise.reject(entryBlocked(known.code, known.reason, root, known.attempts));
    }
    const attempts = known !== undefined && known.status === "blocked" ? known.attempts + 1 : 1;
    const startedAt = Date.now();
    const adapter = readEnv("CHRONO_ENTRY_ADAPTER") ?? "opencode";
    const chronoBin = readEnv("CHRONO_BIN") ?? "chrono";
    const timeoutMs = entryTimeoutMs();
    const promise = runEntryChild(root, adapter, chronoBin, timeoutMs).then(
      (result) => {
        if (result.payload !== undefined) {
          const payloadHash = sha256hex(result.payload);
          const fresh = {
            status: "ok",
            payload: result.payload,
            payloadHash,
            entrySessionId: result.entrySessionId,
            skill: result.skill,
            injected: false,
            attempts,
            redeemedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
          };
          entryStates.set(sessionKey, fresh);
          logEvidence(root, {
            kind: "entry-redeemed",
            session: publicSessionKey(sessionKey, root),
            entrySession: result.entrySessionId,
            projectionHash: payloadHash,
            projectState: JSON.parse(result.payload).projection.projectState,
            nextAction: JSON.parse(result.payload).projection.nextAction.key,
            skillPin: SKILL_PINNED_COMMIT.slice(0, 12),
            skillIncluded: true,
            durationMs: fresh.durationMs,
            attempts,
          });
          return fresh;
        }
        const blocked = { status: "blocked", code: result.error.code, reason: result.error.reason, attempts };
        entryStates.set(sessionKey, blocked);
        logEvidence(root, {
          kind: "entry-blocked",
          session: publicSessionKey(sessionKey, root),
          code: result.error.code,
          reason: result.error.reason,
          attempts,
        });
        throw entryBlocked(result.error.code, result.error.reason, root, attempts);
      },
      () => {
        const blocked = { status: "blocked", code: "ENTRY_SPAWN_FAILED", reason: "entry runner failed unexpectedly", attempts };
        entryStates.set(sessionKey, blocked);
        logEvidence(root, {
          kind: "entry-blocked",
          session: publicSessionKey(sessionKey, root),
          code: blocked.code,
          reason: blocked.reason,
          attempts,
        });
        throw entryBlocked(blocked.code, blocked.reason, root, attempts);
      }
    );
    entryStates.set(sessionKey, { status: "pending", promise, attempts });
    return promise;
  }

  function resolveSessionKey(input, root) {
    // Exact OpenCode session when the runtime provides it; otherwise
    // the latest session observed for this project root (a transform
    // without sessionID joins the session it belongs to); otherwise a
    // directory-scoped anonymous key. Enforcement is identical in all
    // three cases — only the evidence label differs.
    const id = openCodeSessionId(input);
    if (id !== null) {
      return id;
    }
    const latest = latestByRoot.get(root);
    if (typeof latest === "string" && latest.length > 0) {
      return latest;
    }
    return "anonymous@" + dirHash(root);
  }

  function sweepStaleTokenFiles() {
    // Best-effort stale-token recovery: files older than twice the
    // broker session TTL are dead credentials (0600, path never
    // exposed). CHRONO-namespaced names only; failures never throw.
    let entries;
    try {
      entries = readdirSync(tmpDir());
    } catch {
      return;
    }
    const cutoff = Date.now() - TOKEN_STALE_MS;
    for (const entry of entries) {
      if (!entry.startsWith(TOKEN_FILE_PREFIX) || !entry.endsWith(TOKEN_FILE_SUFFIX)) {
        continue;
      }
      const full = join(tmpDir(), entry);
      try {
        if (statSync(full).mtimeMs < cutoff) {
          unlinkSync(full);
        }
      } catch {
        continue;
      }
    }
  }

  function dropSessionState(sessionId) {
    if (typeof sessionId === "string") {
      entryStates.delete(sessionId);
    }
    if (entryStates.size > 100) {
      const oldest = entryStates.keys().next();
      if (!oldest.done) {
        entryStates.delete(oldest.value);
      }
    }
  }

  try {
    const loadRoot = (ctx && ctx.directory) || process.cwd();
    const loadProject = chronoProjectRoot(loadRoot);
    if (loadProject !== null && !pluginLoadLogged) {
      pluginLoadLogged = true;
      logEvidence(loadProject, { kind: "plugin-load", toolPolicy: "v1" });
    }
  } catch {
    // Load evidence is observability only; enforcement never depends on it.
  }

  return {
    event: async ({ event }) => {
      // Prefetch optimization only (a throw here cannot abort
      // anything): starts entry early and sweeps stale token files.
      // Authoritative enforcement lives in chat.message, the system
      // transform, and the tool hooks below.
      try {
        if (!event || (event.type !== "session.created" && event.type !== "session.deleted")) {
          return;
        }
        const root = (ctx && ctx.directory) || process.cwd();
        if (chronoProjectRoot(root) === null) {
          return;
        }
        sweepStaleTokenFiles();
        const sessionId = openCodeSessionId(event);
        if (event.type !== "session.created") {
          if (sessionId !== null) {
            dropSessionState(sessionId);
            if (latestByRoot.get(root) === sessionId) {
              latestByRoot.delete(root);
            }
          }
          return;
        }
        if (sessionId !== null) {
          latestByRoot.set(root, sessionId);
          if (!entryStates.has(sessionId)) {
            try {
              await ensureEntryAsync(root, sessionId);
            } catch {
              // Recorded as blocked; the message/transform hooks enforce loudly.
            }
          }
        } else if (!entryStates.has("anonymous@" + dirHash(root))) {
          try {
            await ensureEntryAsync(root, "anonymous@" + dirHash(root));
          } catch {
            // Recorded as blocked; the message/transform hooks enforce loudly.
          }
        }
      } catch {
        // Event delivery never fails a session; enforcement lives in the
        // message, transform, and tool hooks below.
      }
    },
    "chat.message": async (input) => {
      // Fail-closed first-message gate (OC-P9): fires when a user message
      // is received, before generation, with a required sessionID.
      // Synchronously ensures the validated projection exists for the
      // exact session (awaiting bounded shared entry work). A missing,
      // pending-unresolved, failed, malformed, or expired projection
      // throws ENTRY_BLOCKED and fails the message instead of producing
      // an ordinary default-agent response.
      const root = (ctx && ctx.directory) || process.cwd();
      if (chronoProjectRoot(root) === null) {
        return;
      }
      const key = resolveSessionKey(input, root);
      await ensureEntryAsync(root, key);
    },
    "chat.params": async (input) => {
      // Native primary-agent selection evidence (OC-P10): fires with the
      // parameters sent to the LLM, including the requesting agent name.
      // Records which agent the exact session actually selected — the
      // authoritative counterpart to projection injection. Never blocks:
      // enforcement lives in chat.message, the system transform, and the
      // tool hooks. Hidden system agents (compaction/title/summary) are
      // recorded verbatim; the doctor excludes them from the selected
      // primary verdict.
      try {
        const root = (ctx && ctx.directory) || process.cwd();
        if (chronoProjectRoot(root) === null) {
          return;
        }
        const key = resolveSessionKey(input, root);
        const agent = input !== null && typeof input === "object" && typeof input.agent === "string" && input.agent.length > 0
          ? input.agent
          : "unknown";
        logEvidence(root, {
          kind: "agent-selected",
          session: publicSessionKey(key, root),
          agent,
        });
      } catch {
        // Selection telemetry is observability only; enforcement never
        // depends on it.
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      const root = (ctx && ctx.directory) || process.cwd();
      if (chronoProjectRoot(root) === null) {
        return;
      }
      const key = resolveSessionKey(input, root);
      // Authoritative injection gate: awaits the SAME shared per-session
      // entry work (never order-dependent) and throws ENTRY_BLOCKED on
      // ANY failure, which fails the LLM request instead of answering
      // ungoverned.
      const state = await ensureEntryAsync(root, key);
      if (state.injected) {
        return;
      }
      if (output === null || output === undefined || !Array.isArray(output.system)) {
        entryStates.set(key, {
          status: "blocked",
          code: "ENTRY_INJECTION_UNAVAILABLE",
          reason: "system-context injection surface is unavailable",
          attempts: ENTRY_MAX_ATTEMPTS,
        });
        logEvidence(root, {
          kind: "entry-blocked",
          session: publicSessionKey(key, root),
          code: "ENTRY_INJECTION_UNAVAILABLE",
          reason: "system-context injection surface is unavailable",
          attempts: ENTRY_MAX_ATTEMPTS,
        });
        throw entryBlocked("ENTRY_INJECTION_UNAVAILABLE", "system-context injection surface is unavailable", root, ENTRY_MAX_ATTEMPTS);
      }
      const contract = buildGasparContract(state);
      output.system.push(contract);
      state.injected = true;
      logEvidence(root, {
        kind: "projection-injected",
        session: publicSessionKey(key, root),
        entrySession: state.entrySessionId,
        projectionHash: state.payloadHash,
        hook: "experimental.chat.system.transform",
        skillPin: SKILL_PINNED_COMMIT.slice(0, 12),
        skillIncluded: true,
        bytes: contract.length,
      });
    },
    "tool.execute.before": async (input) => {
      const tool = input && typeof input.tool === "string" ? input.tool : "";
      const root = (ctx && ctx.directory) || process.cwd();
      if (chronoProjectRoot(root) === null) {
        return;
      }
      // Backstop: entry must be proven before ANY tool — including reads.
      // If the message/transform path was bypassed or renamed upstream,
      // tools still cannot act. Shared per-session work is awaited
      // (bounded); blocked state denies immediately.
      const key = resolveSessionKey(input, root);
      const known = entryStates.get(key);
      if (known === undefined || known.status !== "ok") {
        try {
          await ensureEntryAsync(root, key);
        } catch (e) {
          throw e instanceof Error ? e : new Error("[chrono] ENTRY_BLOCKED: entry unproven");
        }
      }
      const kind = gateFor(tool);
      if (kind === "read") {
        // OC-P11 req 16: generic reads never serve internal/security
        // state (.chrono/chrono.db, broker accounts, token files,
        // internal hooks). Safe Core projections are the only channel.
        let probe = "";
        try {
          probe = JSON.stringify(input ?? "");
        } catch {
          probe = "";
        }
        if (referencesForbiddenState(probe)) {
          throw new Error(
            "[chrono] SECRET_DETECTED: this read references CHRONO internal or security state: use chrono doctor or chrono artifact status projections instead; direct access is denied."
          );
        }
        return;
      }
      if (kind === "unknown") {
        throw new Error(
          \`[chrono] TOOL_DENIED: tool '\${tool}' is not classified by CHRONO tool policy v2: deny-by-default until reviewed.\`
        );
      }
      // OC-P11 planning path: a bash invocation that is EXACTLY a
      // governed planning operation needs entry only — never Module
      // dispatch. The chrono artifact CLI enforces the Gaspar/PO
      // session and capability matrix through the host session
      // environment; never pass --session-token in model-visible text.
      // Generic write/edit/bash stays on the dispatch path below.
      if (tool === "bash") {
        const command = extractBashCommand(input);
        if (command !== null && isPlanningBashCommand(command)) {
          return;
        }
      }
      const module = readEnv("CHRONO_GATE_MODULE");
      if (module === null) {
        throw new Error(
          "[chrono] CHRONO project without dispatch context: export CHRONO_GATE_MODULE (and CHRONO_GATE_WP when scoped) or dispatch via 'chrono run'."
        );
      }
      const token = readEnv("CHRONO_SESSION_TOKEN");
      if (token === null) {
        throw new Error(
          "[chrono] Dispatch context without a session: export CHRONO_SESSION_TOKEN from an authorized session."
        );
      }
      const as = readEnv("CHRONO_GATE_AS");
      const role = readEnv("CHRONO_GATE_ROLE");
      if (as === null || role === null) {
        throw new Error("[chrono] Export CHRONO_GATE_AS and CHRONO_GATE_ROLE for the dispatch.");
      }
      const chronoBin = readEnv("CHRONO_BIN") ?? "chrono";
      const args = [
        "gate",
        "execution",
        "--module",
        module,
        "--as",
        as,
        "--role",
        role,
        "--session-token",
        token,
        "--requester-token",
        readEnv("CHRONO_REQUESTER_TOKEN") ?? token,
        "--path",
        root,
        "--json",
      ];
      const wp = readEnv("CHRONO_GATE_WP");
      if (wp !== null) {
        args.push("--wp", wp);
      }
      let raw;
      try {
        raw = execFileSync(chronoBin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        raw = e && e.stdout ? String(e.stdout) : null;
        if (raw === null) {
          throw new Error(
            \`[chrono] gate unreachable: \${e instanceof Error ? e.message : String(e)}\`
          );
        }
      }
      let verdict;
      try {
        verdict = JSON.parse(raw);
      } catch {
        throw new Error("[chrono] gate returned non-JSON output: denying.");
      }
      if (verdict && verdict.result === "AUTHORIZED") {
        return;
      }
      const code = verdict && typeof verdict.code === "string" ? verdict.code : "DENIED";
      const reason = verdict && typeof verdict.reason === "string" ? verdict.reason : "denied";
      throw new Error(\`[chrono] \${code}: \${reason}\`);
    },
    dispose: async () => {
      // Best-effort stale-token sweep on unload (runtime close/restart).
      // Never throws into the host.
      try {
        sweepStaleTokenFiles();
      } catch {
        // Cleanup is advisory; enforcement never depends on it.
      }
    },
  };
};
`;
}
