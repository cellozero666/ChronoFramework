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
 * Tool policy version: TOOL_POLICY_VERSION=4 (see @chrono/domain
 * OPENCODE_TOOL_POLICY). The lists below are generated from that policy;
 * the Core remains the authority — the plugin only shapes the intake.
 *
 * OC-P11 planning distinction: `bash` invocations that are EXACTLY a
 * governed planning operation (`chrono artifact propose|revise|status`,
 * `chrono approval-request|approval-ticket`, `chrono discovery record`,
 * `chrono plan status`, `chrono status`, `chrono validate`,
 * `chrono doctor` — no chaining, no substitution) follow the planning
 * path (entry proven; session enforced by the CLI through the host
 * session environment, never through model-visible arguments). Every
 * other mutable tool — including generic write/edit/bash — still
 * requires Module dispatch context. Reads that reference
 * internal/security state (.chrono/chrono.db, broker-account, token
 * files, internal hooks) are denied even though reads otherwise pass
 * without dispatch scope.
 *
 * OC-P11 integrated approval ceremony (ADR-007, fail-open fix,
 * exactly-once repair): the native `question` tool carries the human
 * confirmation for display AND decision. The `question.replied`
 * event is the SINGLE authoritative finalization path: it carries
 * the exact requestID correlation plus the human-selected answers
 * only, and finalizes ONLY on explicit human Approve (exact ticket
 * challenge, approval wording, no deny/cancel signal) for EXACTLY
 * ONE bound ticket. `tool.execute.after` on question results is
 * observation-only (audit, never finalize/deny/consume): its output
 * payload includes unselected option labels, which once produced a
 * false `approval-answer-declined` contradicting the authoritative
 * `approval-finalized` for the same ceremony. The single path
 * revalidates ticket liveness, revision currency, and session
 * binding through the Core, refuses --auto, reads the OS-keychain
 * PO key host-side (never to the model), signs, and records through
 * one atomic Core transaction (ceremony claim, ticket consume,
 * approval record, audit event — all or nothing). There is
 * deliberately NO approval-confirm tool: signing never follows
 * model tool invocation or execution permission. The plugin uses only
 * `node:child_process` / `node:fs` / `node:path` / `node:crypto`, so
 * the generated file stays directly importable in tests with only
 * binaries substituted by fixtures.
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
   *   \`bash\` invocations that are EXACTLY a governed planning or
   *   approval-request operation (\`chrono artifact propose|revise|status\`,
   *   \`chrono approval-request|approval-ticket\`, \`chrono doctor\`,
   *   \`chrono status|validate\`) pass with entry only — the planning CLI
   *   enforces the Gaspar/PO session itself (\`chrono approval-record\`
   *   is deliberately NOT on this path: recording needs a host-made PO
   *   signature that model text can never supply);
   *   every other mutable tool requires CHRONO_GATE_MODULE (+ optional
   *   CHRONO_GATE_WP), CHRONO_GATE_AS, CHRONO_GATE_ROLE, and
   *   CHRONO_SESSION_TOKEN and a live \`chrono gate execution\` AUTHORIZED
   *   verdict. Unknown tools are denied until classified (deny-by-default).
   *   While entry is unproven, EVERY tool (including reads) is denied.
   *   Anything missing or DENIED throws (fail-closed).
    * - Integrated approval ceremony (ADR-007, fail-open fix,
    *   exactly-once repair): the native \`question\` tool carries the
    *   human confirmation. The \`question.replied\` event is the SINGLE
    *   authoritative finalization path (exact requestID correlation,
    *   exactly one bound ticket, explicit Approve only).
    *   \`tool.execute.after\` on question results is observation-only
    *   and never finalizes, denies, or consumes. There is deliberately
    *   NO approval-confirm tool: signing never follows model
    *   invocation or execution permission.
   * - Runtime evidence lands in .chrono/runtime-activation.jsonl
   *   (non-secret metadata only). Session tokens are never held here,
   *   never logged, never modeled.
   */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { dirname, join, sep } from "node:path";

const READ_TOOLS = new Set(${JSON.stringify(READ_TOOLS)});
const MUTATE_TOOLS = new Set(${JSON.stringify(MUTATE_TOOLS)});
// Native governed planning tools (OC-P11 correction, C5): real
// model-callable tools registered by this same setup
// (.opencode/tools/chrono.ts). Planning-governed, not generic shell
// mutation and not implementation dispatch: each enforces its Gaspar
// session itself and the Core validates every call. The gate requires
// proven entry, nothing more.
const PLANNING_TOOLS = new Set([
  "chrono_artifact_status",
  "chrono_artifact_propose",
  "chrono_artifact_revise",
  "chrono_artifact_supersede",
  "chrono_approval_request",
  "chrono_approval_status",
]);
const SKILL_PINNED_COMMIT = ${JSON.stringify(SKILL_RELEASE.pinnedCommit)};
const SKILL_SOURCE_HASH = ${JSON.stringify(SKILL_RELEASE.sourceHash)};

// Approval tickets referenced from runtime-delivered question payloads.
// Only an explicit human Approve (exact challenge, approval wording,
// no deny/cancel signal) may trigger host-side signing; everything
// else is audited and left alone.
const TICKET_PATTERN = /TICKET-[0-9]{4}/g;
const CHALLENGE_PREFIX = "approve-";

/**
 * Deterministic canonical JSON (sorted keys). Byte-identical to the
 * Core revision serializer for plain JSON values: the host signs
 * approval payloads with exactly the bytes the Core verifies.
 * Exported for hermetic contract tests.
 */
export function chronoCanonicalizeJson(value) {
  if (value === null) {
    return "null";
  }
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") {
    return JSON.stringify(value);
  }
  if (kind === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("chronoCanonicalizeJson: non-finite number");
    }
    return JSON.stringify(value);
  }
  if (kind === "object") {
    if (Array.isArray(value)) {
      return "[" + value.map((item) => chronoCanonicalizeJson(item)).join(",") + "]";
    }
    const keys = Object.keys(value).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + chronoCanonicalizeJson(value[key])).join(",") + "}";
  }
  throw new Error("chronoCanonicalizeJson: unsupported value");
}

/**
 * Explicit human decision decoded from a runtime-delivered
 * question/answer pair. Approve requires the exact challenge in both
 * halves plus approval wording with no deny/cancel signal; anything
 * else declines or is ignored. Exported for hermetic contract tests.
 */
export function chronoApprovalDecision(questionText, answerText, challenge) {
  if (typeof challenge !== "string" || challenge.trim().length === 0) {
    return "ignore";
  }
  const question = String(questionText ?? "");
  const answer = String(answerText ?? "");
  if (question.indexOf(challenge) === -1 || answer.indexOf(challenge) === -1) {
    return "ignore";
  }
  // Veto signals come from the HUMAN answer only: the question itself
  // legitimately carries a Deny option for the human to pick.
  if (/deny/i.test(answer) || /cancel/i.test(answer)) {
    return "decline";
  }
  if (/approv/i.test(answer)) {
    return "approve";
  }
  return "decline";
}

/** Extract ticket ids (TICKET-0001) from runtime-delivered text. */
export function chronoExtractTicketIds(text) {
  const found = String(text ?? "").match(TICKET_PATTERN);
  return found === null ? [] : [...new Set(found)];
}

/**
 * Byte-parity copy of the shared key-transport normalizer (D1):
 * CRLF to LF, edge trim, lower/UPPERCASE hex decode to PEM armor.
 * Parity-locked by key-transport tests; never logs key text.
 */
export function normalizeKeyMaterial(material) {
  const edge = String(material).replace(/\\r\\n/g, "\\n").replace(/^[ \\t\\n\\r\\f\\v]+|[ \\t\\n\\r\\f\\v]+$/g, "");
  if (/^[0-9a-f]+$/i.test(edge) && edge.length % 2 === 0 && edge.length >= 2) {
    try {
      const decoded = Buffer.from(edge, "hex").toString("utf8");
      if (decoded.startsWith("-----BEGIN")) {
        return decoded;
      }
    } catch {
      // Not decodable hex: fall through to the edge-trimmed form.
    }
  }
  return edge;
}

/**
 * Normalize, require a parseable Ed25519 private key, and bind the
 * derived public-key fingerprint (non-secret). Returns
 * { pem, fingerprint } or null. Secret-safe: no key text escapes.
 */
export function parsePoKey(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  const normalized = normalizeKeyMaterial(raw);
  if (normalized.length === 0) {
    return null;
  }
  try {
    const key = createPrivateKey(normalized);
    if (key.asymmetricKeyType !== "ed25519") {
      return null;
    }
    const publicPem = createPublicKey(key).export({ format: "pem", type: "spki" }).toString();
    return { pem: normalized, fingerprint: createHash("sha256").update(publicPem, "utf8").digest("hex") };
  } catch {
    return null;
  }
}

/** Exact challenge correlation between a question and its human answer. */
export function chronoApprovalMatch(questionText, answerText, challenge) {
  if (typeof challenge !== "string" || challenge.trim().length === 0) {
    return false;
  }
  return String(questionText ?? "").includes(challenge) && String(answerText ?? "").includes(challenge);
}

/**
 * Parity copy of domain buildCeremonyKey (exactly-once repair): the
 * ceremony key binds canonical project, runtime session,
 * question/request id, exactly one ticket, scope, action, and
 * revision as SHA-256 over canonical JSON with sorted keys
 * (action, project, requestId, scopeArtifactId, scopeRevision,
 * sessionId, ticketId — the literal below is already in that
 * order, so JSON.stringify is byte-identical to the domain
 * canonicalizer for these plain string values). The Core recomputes
 * the same key and claims it atomically. Returns null on invalid
 * components (fail-closed, never throws). Exported for hermetic
 * parity tests.
 */
export function chronoCeremonyKey(binding) {
  if (binding === null || typeof binding !== "object") {
    return null;
  }
  const action = binding.action;
  const project = binding.project;
  const requestId = binding.requestId;
  const scopeArtifactId = binding.scopeArtifactId;
  const scopeRevision = binding.scopeRevision;
  const sessionId = binding.sessionId;
  const ticketId = binding.ticketId;
  for (const part of [action, project, requestId, scopeArtifactId, scopeRevision, sessionId, ticketId]) {
    if (typeof part !== "string" || part.length === 0 || part.length > 1024) {
      return null;
    }
  }
  if (!/^TICKET-[0-9]{4}$/.test(ticketId)) {
    return null;
  }
  try {
    const canonical = JSON.stringify({
      action,
      project,
      requestId,
      scopeArtifactId,
      scopeRevision,
      sessionId,
      ticketId,
    });
    return createHash("sha256").update(canonical, "utf8").digest("hex");
  } catch {
    return null;
  }
}

/**
 * Signing payload built ONLY from validated plain strings
 * (exactly-once repair, hardening): every required field must be a
 * non-empty string, else null (fail-closed BEFORE canonical
 * signing — an undefined property must never reach
 * chronoCanonicalizeJson, which throws "unsupported value" by
 * contract). Exported for hermetic contract tests.
 */
export function sanitizeSigningPayload(ticket, observedAt) {
  if (ticket === null || typeof ticket !== "object") {
    return null;
  }
  const payload = {
    action: ticket.action,
    scope_artifact_id: ticket.scopeArtifactId,
    scope_revision: ticket.scopeRevision,
    authority: "PO",
    rationale: ticket.rationale,
    timestamp: observedAt,
    security_implications: ticket.securityImplications,
  };
  for (const value of Object.values(payload)) {
    if (typeof value !== "string" || value.length === 0) {
      return null;
    }
  }
  return payload;
}

/**
 * Non-throwing canonical JSON wrapper (hardening): malformed or
 * hostile values yield null instead of an uncaught
 * "chronoCanonicalizeJson: unsupported value" escaping plugin
 * initialization or an event observer.
 */
export function safeCanonicalizeJson(value) {
  try {
    return chronoCanonicalizeJson(value);
  } catch {
    return null;
  }
}

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
const PLUGIN_GENERATOR = "chrono-gate/oc-p10";

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
  // stays on the implementation-dispatch path. approval-record is
  // deliberately absent: recording needs a host-made PO signature that
  // model text can never supply.
  const PLANNING_BASH_PREFIXES = [
    "chrono artifact propose",
    "chrono artifact revise",
    "chrono artifact status",
    "chrono approval-request",
    "chrono approval-ticket",
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

  function toolArgs(output) {
    // Real OpenCode 1.18.30 contract (C1): tool.execute.before receives
    // (input { tool, sessionID, callID }, output { args }). The command
    // lives in output.args — never in the first argument. Anything else
    // is not a classifiable invocation.
    if (output === null || typeof output !== "object") {
      return null;
    }
    const args = output.args;
    if (args === null || typeof args !== "object") {
      return null;
    }
    return args;
  }

  function extractBashCommand(output) {
    const args = toolArgs(output);
    if (args === null) {
      return null;
    }
    for (const key of ["command", "cmd", "input", "script"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
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
      "Planning bootstrap (OC-P11): materialize analysis, requirements, architecture/ADRs, Specs, harness drafts, security proposals, and roadmap or Module/Work Package plans ONLY through the Core-governed chrono artifact propose|revise|status path (never generic write/edit/bash). Chrono run execution grants are reserved for authorized implementation work. A Product Owner statement in chat such as approved is NOT a registered approval: report it only as PO stated approval in chat, then confirm for real — chrono approval-request for a single-use ticket, then the native question tool carrying the exact CHRONO approval challenge line with Approve and Deny options, then verify through chrono artifact status. Never run approval recording, never handle keys or tokens: host-side signing follows the human answer, never your context. Only a Core-recorded approval counts. Never read internal database, broker account files, token files, or internal hook contents through generic tools: use the safe Core projections instead.",
      "</chrono-gaspar-entry>",
    ].join("\\n");
  }

  function hostTokenPath(root, sessionKey) {
    // Deterministic host-only session token path (OC-P11 ceremony):
    // the plugin tells the entry script exactly where to confine the
    // token (CHRONO_TOKEN_OUT override) so later host-side Core calls
    // (ticket query, approval record) authenticate without ever
    // exposing the credential to model context. Same naming family as
    // the default, so the stale sweep covers it; 0600 enforced by the
    // entry script.
    return join(tmpDir(), TOKEN_FILE_PREFIX + "host-" + sha256hex(root + "|" + sessionKey).slice(0, 16) + TOKEN_FILE_SUFFIX);
  }

  function canonicalRoot(root) {
    // Single normalization for every host-side path derivation (C-fix:
    // the token file hash must agree between the entry flow here and
    // the native tool modules, which canonicalize ToolContext paths;
    // a raw-vs-canonical skew (/var vs /private/var) would orphan the
    // credential and silently break the ceremony).
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  }

  function runEntryChild(root, adapter, chronoBin, timeoutMs, sessionKeyForToken) {
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
      const tokenOut = hostTokenPath(canonicalRoot(root), typeof sessionKeyForToken === "string" ? sessionKeyForToken : "anonymous");
      try {
        // cwd is the validated project root (OC-P9 black-box finding):
        // the entry script resolves its project from its own working
        // directory, so inheriting an unrelated host cwd would redeem
        // (or silently skip) the wrong project. The plugin already
        // proved the root; the child starts exactly there.
        // CHRONO_TOKEN_OUT pins the 0600 token to a plugin-known path
        // (host only, never model-visible) for later ceremony calls.
        child = spawn("sh", [script, adapter], {
          cwd: root,
          env: { ...process.env, CHRONO_BIN: chronoBin, CHRONO_TOKEN_OUT: tokenOut },
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
    const promise = runEntryChild(root, adapter, chronoBin, timeoutMs, sessionKey).then(
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
      for (const key of [...pendingQuestions.keys()]) {
        if (key.startsWith(sessionId + "|")) {
          pendingQuestions.delete(key);
        }
      }
    }
    if (entryStates.size > 100) {
      const oldest = entryStates.keys().next();
      if (!oldest.done) {
        entryStates.delete(oldest.value);
      }
    }
  }

  // Pending native questions by "sessionID|requestID" (fail-open fix):
  // question.asked records the exact rendered questions; a later
  // question.replied for the same pair carries the explicit human
  // answer; question.rejected is the explicit cancel path. Bounded
  // (single-shot correlation, oldest evicted past 50).
  const pendingQuestions = new Map();
  function pendingKey(sessionID, requestID) {
    return String(sessionID) + "|" + String(requestID);
  }
  function rememberQuestion(sessionID, requestID, questionText) {
    pendingQuestions.set(pendingKey(sessionID, requestID), { questionText, at: new Date().toISOString() });
    if (pendingQuestions.size > 50) {
      const oldest = pendingQuestions.keys().next();
      if (!oldest.done) {
        pendingQuestions.delete(oldest.value);
      }
    }
  }
  function takeQuestion(sessionID, requestID) {
    const key = pendingKey(sessionID, requestID);
    const pending = pendingQuestions.get(key);
    if (pending !== undefined) {
      pendingQuestions.delete(key);
    }
    return pending;
  }

  function eventShape(raw) {
    // Real OpenCode event shapes (verified against the installed SDK):
    // either a flat { type, properties } event or a GlobalEvent-style
    // { payload: { type, properties } } wrapper. Anything else is not
    // classifiable and is ignored (fail-closed: no action).
    if (raw === null || typeof raw !== "object") {
      return null;
    }
    if (typeof raw.type === "string" && raw.properties !== undefined) {
      return { type: raw.type, properties: raw.properties };
    }
    const payload = raw.payload;
    if (payload !== null && typeof payload === "object" && typeof payload.type === "string") {
      return { type: payload.type, properties: payload.properties };
    }
    return null;
  }

  function readHostToken(root, sessionKey) {
    // Host-held Gaspar session credential for ceremony Core calls.
    // File only, 0600, never logged, never returned to model context.
    // Returns "id/token" or null.
    try {
      const raw = readFileSync(hostTokenPath(canonicalRoot(root), sessionKey), "utf8").trim();
      if (raw.length === 0 || raw.indexOf("/") <= 0) {
        return null;
      }
      return raw;
    } catch {
      return null;
    }
  }

  function runChronoJson(chronoBin, args, timeoutMs) {
    // Synchronous host-side Core call (human-paced ceremony traffic
    // only, never the hot path). Returns parsed stdout JSON or null.
    try {
      const out = execFileSync(chronoBin, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
      return JSON.parse(String(out));
    } catch (e) {
      try {
        const stdout = e && e.stdout ? String(e.stdout) : "";
        if (stdout.trim().length > 0) {
          return JSON.parse(stdout);
        }
      } catch {
        // Fall through to null: unparseable is a denial signal.
      }
      return null;
    }
  }

  function readHostPoKey() {
    // OS keychain read, host only, through PATH-resolved platform
    // helpers (no test seam in production bytes). Returns raw material
    // or null; callers validate through parsePoKey (D1 parity).
    try {
      const out = execFileSync(
        "security",
        ["find-generic-password", "-s", "chrono-po-signing-key", "-a", "po", "-w"],
        { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }
      );
      if (String(out).trim().length > 0) {
        return String(out);
      }
    } catch {
      // Fall through to secret-tool.
    }
    try {
      const out = execFileSync(
        "secret-tool",
        ["lookup", "service", "chrono-po-signing-key", "account", "po"],
        { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }
      );
      if (String(out).trim().length > 0) {
        return String(out);
      }
    } catch {
      return null;
    }
    return null;
  }

  function signHostApprovalPayload(keyPem, payload) {
    // Null (never throws) on any key or canonicalization failure:
    // callers audit approval-sign-failed with no state change.
    try {
      const key = createPrivateKey(String(keyPem));
      const canonical = safeCanonicalizeJson(payload);
      if (canonical === null) {
        return null;
      }
      const bytes = Buffer.from(canonical, "utf8");
      return sign(null, bytes, key).toString("base64");
    } catch {
      return null;
    }
  }

  async function maybeFinalizeApproval(root, sessionKey, callID, questionText, answerText, ceremony) {
    // Explicit-answer ceremony (fail-open fix, exactly-once repair):
    // ONLY an explicit human Approve arriving through the SINGLE
    // authoritative path (question.replied event, exact requestID
    // correlation) may trigger host-side signing, for EXACTLY ONE
    // bound ticket. Permission to execute, chat text, cached or
    // auto-resolved answers, and malformed output all end here as
    // audits with no state change. Never throws into the runtime.
    //
    // Single-ticket binding (TICKET-0024 repair): the ceremony binds
    // the ticket named in the RENDERED QUESTION ONLY — never the
    // answer, never accumulated context. Zero tickets: unrelated
    // question traffic, ignored silently. Several tickets: one human
    // Approve must never authorize many tickets — refused fail-closed
    // (approval-multi-ticket), nothing consumed.
    const ticketIds = chronoExtractTicketIds(questionText);
    if (ticketIds.length === 0) {
      return;
    }
    const publicKey = typeof sessionKey === "string" && !sessionKey.startsWith("anonymous@") ? sessionKey : "anonymous";
    if (ticketIds.length > 1) {
      logEvidence(root, {
        kind: "approval-multi-ticket", session: publicKey,
        ticket: ticketIds[0] ?? null, call: callID, count: ticketIds.length,
      });
      return;
    }
    const ticketId = ticketIds[0];
    if (process.argv.includes("--auto")) {
      logEvidence(root, { kind: "approval-skipped-auto", session: publicKey, ticket: ticketId, call: callID });
      return;
    }
    const token = readHostToken(root, sessionKey);
    if (token === null) {
      logEvidence(root, { kind: "approval-no-session", session: publicKey, ticket: ticketId, call: callID });
      return;
    }
    const tokenId = token.slice(0, token.indexOf("/"));
    const chronoBin = readEnv("CHRONO_BIN") ?? "chrono";
    const observedAt = new Date().toISOString();
    const challenge = CHALLENGE_PREFIX + ticketId;
    const decision = chronoApprovalDecision(questionText, answerText, challenge);
    if (decision !== "approve") {
      logEvidence(root, {
        kind: decision === "decline" ? "approval-answer-declined" : "approval-answer-no-match",
        session: publicKey, ticket: ticketId, call: callID,
      });
      return;
    }
    // Liveness, revision currency, AND session binding through the
    // Core immediately before signing: a stale, consumed, foreign,
    // or cross-session ticket can never authorize.
    const ticket = runChronoJson(chronoBin, [
      "approval-ticket", "--ticket", ticketId, "--as", "gaspar",
      "--session-token", token, "--path", root, "--json",
    ], 30000);
    if (ticket === null || ticket.ok !== true || ticket.live !== true) {
      logEvidence(root, { kind: "approval-ticket-not-live", session: publicKey, ticket: ticketId, call: callID });
      return;
    }
    if (typeof ticket.requesterSession === "string" && ticket.requesterSession.length > 0 && ticket.requesterSession !== tokenId) {
      logEvidence(root, { kind: "approval-cross-session", session: publicKey, ticket: ticketId, call: callID });
      return;
    }
    const parsed = parsePoKey(readHostPoKey());
    if (parsed === null) {
      logEvidence(root, { kind: "approval-no-key", session: publicKey, ticket: ticketId, call: callID });
      return;
    }
    // Exactly-once ceremony key (TICKET-0024 repair): binds canonical
    // project, runtime session, question/request id, the one ticket,
    // scope, action, and revision. The Core recomputes and claims it
    // atomically; redelivery is a durable no-op.
    const ceremonyKey = ceremony !== null && typeof ceremony === "object"
      ? chronoCeremonyKey({
        action: ticket.action,
        project: canonicalRoot(root),
        requestId: ceremony.requestId,
        scopeArtifactId: ticket.scopeArtifactId,
        scopeRevision: ticket.scopeRevision,
        sessionId: ceremony.sessionId,
        ticketId,
      })
      : null;
    if (ceremonyKey === null) {
      logEvidence(root, { kind: "approval-sign-failed", session: publicKey, ticket: ticketId, call: callID });
      return;
    }
    const payload = sanitizeSigningPayload(ticket, observedAt);
    if (payload === null) {
      logEvidence(root, { kind: "approval-sign-failed", session: publicKey, ticket: ticketId, call: callID });
      return;
    }
    const signature = signHostApprovalPayload(parsed.pem, payload);
    if (signature === null) {
      logEvidence(root, { kind: "approval-sign-failed", session: publicKey, ticket: ticketId, call: callID });
      return;
    }
    const receipt = runChronoJson(chronoBin, [
      "approval-record", "--ticket", ticketId, "--timestamp", observedAt,
      "--signature", signature, "--permission-call-id", callID,
      "--decided-at", observedAt,
      "--ceremony-key", ceremonyKey,
      "--ceremony-session", ceremony.sessionId,
      "--ceremony-request", ceremony.requestId,
      "--as", "gaspar",
      "--session-token", token, "--path", root, "--json",
    ], 60000);
    if (receipt !== null && receipt.ok === true && typeof receipt.approvalId === "string") {
      if (receipt.duplicate === true) {
        logEvidence(root, {
          kind: "approval-duplicate-ceremony", session: publicKey, ticket: ticketId,
          approval: receipt.approvalId, call: callID,
        });
        return;
      }
      logEvidence(root, {
        kind: "approval-finalized", session: publicKey, ticket: ticketId,
        approval: receipt.approvalId, scope: ticket.scopeArtifactId, call: callID,
        revision: ticket.scopeRevision, action: ticket.action,
        aliased: receipt.aliased === true,
        superseded: typeof receipt.superseded === "string" ? receipt.superseded : null,
      });
      return;
    }
    const code = receipt !== null && typeof receipt.error === "object" && receipt.error !== null && typeof receipt.error.code === "string"
      ? receipt.error.code
      : "RECORD_DENIED";
    logEvidence(root, { kind: "approval-record-denied", session: publicKey, ticket: ticketId, call: callID, code });
  }

  // auditApprovalQuestion was removed with the permission-gated
  // confirm tool (fail-open fix): question traffic is handled by
  // maybeFinalizeApproval below, which acts ONLY on explicit human
  // Approve and audits every other outcome without state change.

  async function observeQuestionEvent(shaped, directory) {
    // Native question event chain (fail-open fix, exactly-once
    // repair): question.asked records the exact rendered questions;
    // question.replied carries the explicit human answer bound by
    // requestID and is the SINGLE authoritative finalization path;
    // question.rejected is the explicit cancel path (audit only).
    // The in-memory pending map is single-shot correlation: a reply
    // without a prior asked (unknown requestID, or any replay after
    // restart when the map is empty) is audited with no state change,
    // so old events can never create approvals after restart. Never
    // throws: hostile shapes are ignored safely.
    const root = directory || process.cwd();
    if (chronoProjectRoot(root) === null) {
      return;
    }
    const props = shaped.properties;
    if (props === null || typeof props !== "object") {
      return;
    }
    const sessionID = typeof props.sessionID === "string" && props.sessionID.length > 0 ? props.sessionID : null;
    if (sessionID === null) {
      return;
    }
    const requestID =
      typeof props.requestID === "string" && props.requestID.length > 0
        ? props.requestID
        : typeof props.id === "string" && props.id.length > 0
          ? props.id
          : null;
    if (shaped.type === "question.asked") {
      if (requestID === null) {
        return;
      }
      let questionText = "";
      try {
        questionText = JSON.stringify(props.questions ?? "");
      } catch {
        questionText = "";
      }
      rememberQuestion(sessionID, requestID, questionText);
      return;
    }
    if (shaped.type === "question.rejected") {
      if (requestID === null) {
        return;
      }
      const pending = takeQuestion(sessionID, requestID);
      logEvidence(root, {
        kind: "approval-answer-declined",
        session: publicSessionKey(sessionID, root),
        ticket: pending === undefined ? null : chronoExtractTicketIds(pending.questionText)[0] ?? null,
        call: requestID,
      });
      return;
    }
    if (shaped.type !== "question.replied" || requestID === null) {
      return;
    }
    const pending = takeQuestion(sessionID, requestID);
    if (pending === undefined) {
      logEvidence(root, {
        kind: "approval-answer-no-match",
        session: publicSessionKey(sessionID, root),
        ticket: null,
        call: requestID,
      });
      return;
    }
    let answerText = "";
    try {
      const answers = Array.isArray(props.answers) ? props.answers : [];
      answerText = answers.map((a) => (Array.isArray(a) ? a.join(" ") : String(a ?? ""))).join(" ");
    } catch {
      answerText = "";
    }
    await maybeFinalizeApproval(root, sessionID, requestID, pending.questionText, answerText, {
      sessionId: sessionID,
      requestId: requestID,
    });
  }

  try {
    const loadRoot = (ctx && ctx.directory) || process.cwd();
    const loadProject = chronoProjectRoot(loadRoot);
    if (loadProject !== null && !pluginLoadLogged) {
      pluginLoadLogged = true;
      logEvidence(loadProject, { kind: "plugin-load", toolPolicy: "v4" });
    }
  } catch {
    // Load evidence is observability only; enforcement never depends on it.
  }

  return {
    event: async ({ event }) => {
      // Prefetch optimization only (a throw here cannot abort
      // anything): starts entry early and sweeps stale token files.
      // Authoritative enforcement lives in chat.message, the system
      // transform, and the tool hooks below. Native question events
      // (asked/replied/rejected) feed the explicit-answer ceremony.
      try {
        const shaped = eventShape(event);
        if (shaped !== null && typeof shaped.type === "string" && shaped.type.indexOf("question.") === 0) {
          await observeQuestionEvent(shaped, (ctx && ctx.directory) || process.cwd());
          return;
        }
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
    "tool.execute.before": async (input, output) => {
      // Real OpenCode 1.18.30 contract (C1): (input { tool, sessionID,
      // callID }, output { args }). Tool identity comes from the first
      // argument; tool arguments — including any shell command — come
      // from the second. Shapes that do not match are not classifiable
      // and stay on the deny-by-default path.
      const tool = input !== null && typeof input === "object" && typeof input.tool === "string" ? input.tool : "";
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
        // Probed on the real second-argument payload (C1).
        let probe = "";
        try {
          probe = JSON.stringify(output !== undefined ? output : "");
        } catch {
          probe = "";
        }
        if (referencesForbiddenState(probe)) {
          throw new Error(
            "[chrono] SECRET_DETECTED: this read references CHRONO internal or security state: use chrono doctor or the chrono_artifact_status native tool instead; direct access is denied."
          );
        }
        return;
      }
      if (kind === "planning" || PLANNING_TOOLS.has(tool)) {
        // Native governed planning tools (OC-P11 correction, C5): real
        // model-callable tools registered by this same setup
        // (.opencode/tools/chrono.ts). Planning-governed, not generic
        // shell mutation and not implementation dispatch: each enforces
        // its Gaspar session itself and the Core validates every call.
        // The gate requires proven entry, nothing more.
        return;
      }
      if (kind === "unknown") {
        throw new Error(
          \`[chrono] TOOL_DENIED: tool '\${tool}' is not classified by CHRONO tool policy v3: deny-by-default until reviewed.\`
        );
      }
      // Bash compatibility: a bash invocation that is EXACTLY a governed
      // planning or approval-request operation (read from the real
      // second-argument payload, C1) needs entry only — never Module
      // dispatch. Operator sessions supply the session through the host
      // environment; never pass --session-token in model-visible text.
      // Generic write/edit/bash stays on the dispatch path below. Bash
      // compatibility is NOT a substitute for the native planning tools
      // Gaspar must use.
      if (tool === "bash") {
        const command = extractBashCommand(output);
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
    "tool.execute.after": async (input, output) => {
      // Observation ONLY (exactly-once repair, ADR-007). The
      // question.replied event is the single authoritative
      // finalization path; this handler NEVER finalizes, denies, or
      // consumes, so its output payload — which includes UNSELECTED
      // option labels and once produced a false
      // approval-answer-declined contradicting the authoritative
      // approval-finalized for the same ceremony — can never
      // contradict the authoritative decision again. It records one
      // audit row per runtime-delivered question result for
      // duplicate/replay visibility in chrono doctor. Never throws
      // into the runtime; hostile payload shapes yield an
      // unticketed observation, never a crash.
      try {
        const root = (ctx && ctx.directory) || process.cwd();
        if (chronoProjectRoot(root) === null) {
          return;
        }
        const toolName = input !== null && typeof input === "object" && typeof input.tool === "string" ? input.tool : "";
        if (toolName !== "question") {
          return;
        }
        const key = resolveSessionKey(input, root);
        let questionText = "";
        try {
          questionText = JSON.stringify(input !== null && typeof input === "object" && input.args !== undefined ? input.args : "");
        } catch {
          questionText = "";
        }
        const ticketIds = chronoExtractTicketIds(questionText);
        const callID =
          input !== null && typeof input === "object" && typeof input.callID === "string" && input.callID.length > 0
            ? input.callID
            : "unknown-call";
        logEvidence(root, {
          kind: "approval-result-observed",
          session: publicSessionKey(key, root),
          ticket: ticketIds.length > 0 ? (ticketIds[0] ?? null) : null,
          call: callID,
        });
        void output;
      } catch {
        // Observation is advisory; enforcement lives in the Core.
      }
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
