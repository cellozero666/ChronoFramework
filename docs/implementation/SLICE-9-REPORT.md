# Slice 9 Implementation Report — Runtime Enforcement Closure

**Status:** IMPLEMENTED ON BRANCH — not marked `COMPLETE`; `SLICE-9.md`
remains `READY FOR IMPLEMENTATION` until independent review disposition.
**Branch:** `main` (no branch created or switched; nothing pushed, tagged,
published, or released).
**Report date:** 2026-09-11
**Scope:** `SLICE-9.md` §§9.1–9.5 plus the mandated reproducibility
correction round. No Slice 10 functionality was implemented.

## 1. Exact commits (all local, `f21c313..HEAD`)

| Commit | Subject |
|---|---|
| `7d48120` | Slice 9: runtime enforcement closure (enrollment, gates, routing proof, 3-runtime hooks) |
| `5bb827e` | Slice 9 review: runtime hook registration + Kiro canonical tools |
| `53eac5b` | Slice 9: record PO trust-boundary decision (exit criterion 1) |
| `249b15e` | Slice 9 correction: deterministic teardown lifecycle + clean-test gate |
| `01aa2e1` | Slice 9 correction: eslint Node globals for scripts/ gates |

44 files changed, 4378 insertions, 262 deletions (`git diff --stat
f21c313..HEAD`). Full name list:

- `AGENTS.md`, `docs/README.md`, `docs/implementation/IMPLEMENTATION-PLAN.md`,
  `docs/implementation/IMPLEMENTER-TASKS.md`, `docs/implementation/SLICE-9.md`
  (checkpoint wording only), `docs/implementation/SLICE-10.md` (new, queued),
  `docs/implementation/SLICE-9-PO-TRUST-DECISION.md` (new, §1 below)
- `eslint.config.mjs`, `package.json` (`test:clean` script only),
  `scripts/verify-test-clean.mjs` (new)
- `packages/cli/src/index.ts`, `opencode-plugin.ts`, `claude-hook.ts` (new),
  `kiro-hook.ts` (new), `runtime-hooks.test.ts` (new), `setup-cli.test.ts`,
  `gate-cli.test.ts`, `run-cli.test.ts`, `authority-cli.test.ts`,
  `adapter-cli.test.ts`, `cli.test.ts`, `skill-verify.test.ts`
- `packages/core/src/chrono-core.ts`, `index.ts`, all `*.test.ts` in
  `packages/core/src`
- `packages/domain/src/authority.ts`, `capabilities.ts`, `index.ts`
- `packages/persistence/src/database.ts`, `repositories.ts`, `schema.ts`,
  `index.ts`, `grants.test.ts`, `migration.test.ts`, `sequence.test.ts`

## 2. Implementation mapped to §§9.1–9.5

### §9.1 — PO enrollment trust boundary: IMPLEMENTED + PO DECISION RECORDED

- `ChronoCore.enrollPo` (packages/core/src/chrono-core.ts): single
  CLI-owned ceremony requiring a live interactive terminal, a human-typed
  challenge derived from project/fingerprint/nonce and read from
  `/dev/tty` (`readConfirmationFromTty`, never stdin), a fresh timestamp
  inside `ENROLLMENT_FRESHNESS_MS`, and a signature over the canonical
  enrollment payload verifiable under the enrolled key (key possession).
  Key, record, and audit event persist atomically; duplicate enrollment,
  replay, stale proof, malformed confirmation, and partial failure are
  denied with nothing persisted.
- `registerPoPublicKey` denies direct first registration
  (`APPROVAL_REQUIRED` → use the ceremony); rotation still requires the
  current-key signature.
- Adversarial tests (`approval-security.test.ts`, `authority-cli.test.ts`):
  non-TTY refusal, forged/mismatched signatures (`SIGNATURE_INVALID`),
  wrong confirmation/nonce/rationale (`VALIDATION_ERROR`), future/stale
  timestamps, duplicate enrollment, direct-Core enrollment denial.
- PO decision recorded in `SLICE-9-PO-TRUST-DECISION.md`: the PO accepts
  terminal-possession + key-possession + typed confirmation as the v1
  boundary with **no stronger human-identity claim**. Residual assumption:
  whoever holds the terminal at enrollment time is trusted (documented
  TOFU-with-ceremony; a stronger primitive is post-v1 scope).

### §9.2 — Every declared CLI gate: IMPLEMENTED

`chrono gate architecture-approval | spec-ready | verification` delegate
to named Core decisions (`gateArchitectureApproval`, `gateSpecReady`,
`gateVerification`); `execution` and `completion` already did. All gates
validate exact scope/revision/session/role/approval/security state and
return stable `AUTHORIZED`/`DENIED` JSON plus human envelopes with
`--json`. Adversarial coverage in `gate-cli.test.ts` (16 tests): missing /
stale / wrong-scope / wrong-role / confused-actor denials, unknown gates,
session-required errors, single parseable JSON envelope on every path.

### §9.3 — RTK routing proof mandatory: IMPLEMENTED

- `recordRoutingProof` (Core-validated, append-only): binds genuine binary
  identity + compatible version, canonical upstream/provenance, adapter,
  runtime, session scope, project, proof command, command/output hashes,
  exit status (only exit 0 proves), `rtk gain` availability, timestamp, and
  bounded TTL. Submitted only through approved adapter sessions.
- Dispatch (`requireCurrentRtk` → `requireCurrentRoutingProof`) denies on
  missing / expired / superseded-attestation / revoked-adapter /
  binary-changed proofs (`RTK_ROUTING_FAILURE`); attestation currency alone
  no longer suffices. `runRtkVerify` records `routingTestPassed: false`
  (test-only `true` cannot enter production authority).
- Adversarial tests (`authorization.test.ts`): forged, replayed, stale,
  cross-adapter, cross-runtime, cross-project, and revoked-adapter proofs
  all deny; binary replacement after proof invalidates.

### §9.4 — OpenCode enforcement: IMPLEMENTED

Core-owned tool policy (`OPENCODE_TOOL_POLICY`, `TOOL_POLICY_VERSION=1`):
read-only tools (`read`, `grep`, `glob`, `skill`, `todowrite`, `question`,
`lsp`) pass without scope; mutable tools (`bash`, `edit`, `write`,
`apply_patch`, `webfetch`, `websearch`) require a live
`chrono gate execution` verdict; **unknown tools (including `mcp_*` and
future built-ins) are denied** until classified. The generated
`.opencode/plugins/chrono-gate.js` enforces exactly this; session bearer
tokens never enter child environments.

### §9.5 — Claude Code and Kiro adapters: HOOK LOGIC IMPLEMENTED AND
PROVEN; RUNTIME REGISTRATION IMPLEMENTED; REAL-RUNTIME STATUS SPLIT

- `packages/cli/src/claude-hook.ts`: deterministic PreToolUse hook
  (stdin `{tool_name}`, exit 0 allow / exit 2 block — the documented
  contract at code.claude.com/docs/en/hooks); read/mutate/unknown handling
  mirrors §9.4; plus `mergeClaudeSettings` for backup-safe, idempotent,
  malformed-refusing `.claude/settings.json` registration.
- `packages/cli/src/kiro-hook.ts`: deterministic PreToolUse hook with the
  same contract (kiro.dev/docs/cli/hooks: stdin JSON, exit 2 denies);
  case-insensitive canonical names (`read`/`write`/`shell` + documented
  aliases `fs_write`/`execute_bash`); plus CHRONO-owned
  `.kiro/hooks/chrono-gate.json` registration (always-match matcher; the
  script performs Core-owned classification).
- `chrono setup` installs and reports all five managed assets
  (OpenCode plugin, both hook scripts, Kiro registration, Claude settings
  merge) byte-identically; malformed user settings fail with remediation
  instead of overwrite.
- **Exit criterion 4 remains OPEN**: OpenCode and Claude Code have
  real-binary evidence (§6); Kiro has hermetic hook-logic evidence only —
  the `kiro` binary is absent on this host (see §8). Hook generation and
  fixture execution are NOT presented as Kiro runtime conformance.

## 3. Reproducibility correction (independent-review finding)

Reported symptom (clean `git archive` install, Node 24.20.0 and 24.4.1):
`Test Files 23 passed (25)`, unhandled errors, `Worker exited
unexpectedly`, `Assertion failed: env != nullptr`,
`better-sqlite3 Statement::~Statement()`.

Reproduction attempt on this host: clean `git archive HEAD` exports +
`npm ci` on Node 22.21.1 and Node 24.4.1 pass repeatedly (4 consecutive
clean runs, exit 0, no markers). Node 24.20.0 is not installed on this
host and was not installed (no software installation without PO
authorization), so the exact reported crash could not be reproduced here.

Product-correct hardening applied regardless (the crash class is live
native handles at worker teardown):

- `ChronoDatabase.close()` is now idempotent; overlapping
  `finally`/`afterEach` cleanup can no longer fault teardown.
- Every test `afterEach` guards `close` / `db.close` / `restoreTty` /
  `rmSync` / env-restore with `typeof` checks, so a `beforeEach` failure
  can no longer throw `TypeError` that masks the real failure (21 test
  files).
- New gate `npm run test:clean` (`scripts/verify-test-clean.mjs`, linted):
  asserts exit 0, file/test counts ≥ baseline, zero failed/skipped/todo,
  and absence of `unhandled`, `worker exited`, `assertion failed`,
  native-teardown, and skip/todo markers. Negative control verified
  (fails closed, exit 1, on a bogus expectation).
- No Vitest configuration change, no suppression, no disabled suite, no
  `passWithNoTests`, no forced exit. better-sqlite3 stays pinned at
  12.11.1 (source-built via node-gyp on every clean install; no
  prebuilds); a speculative major upgrade was deliberately NOT made
  without reproduction evidence.

## 4. Exact versions

| Component | Version |
|---|---|
| Node.js (matrix A) | v22.21.1, npm 11.18.0 |
| Node.js (matrix B / current 24 on host) | v24.4.1, npm 11.4.2 |
| Vitest | 2.1.9 |
| TypeScript | 5.9.3 |
| better-sqlite3 | 12.11.1 (built from source on each clean install) |
| opencode (real binary) | 1.18.30 |
| claude/Claude Code (real binary) | 2.1.206 |
| rtk/Rust Token Killer (real binary) | 0.44.0 (`rtk gain` dashboard ok) |
| kiro | ABSENT (`command not found`) — environmental blocker |

Node 24.20.0 (reviewers' environment) is unavailable on this host.

## 5. Clean-install matrix (fresh `git archive HEAD` exports)

Per environment: `npm ci` → `npm run test:clean` → `npm run lint` →
`npm run typecheck` → `npm run build` (`git diff --check` is clean in the
source repo; a bare export has no git tree to diff).

| Env | npm ci | test:clean (files/tests) | lint | typecheck | build |
|---|---|---|---|---|---|
| Node 22.21.1 (`/tmp/chrono-m22`) | 0 | PASS — 25 files, 242 tests, exit 0, 0 unhandled, 0 crashes, 0 skips | 0 | 0 | 0 |
| Node 24.4.1 (`/tmp/chrono-m24`) | 0 | PASS — 25 files, 242 tests, exit 0, 0 unhandled, 0 crashes, 0 skips | 0 | 0 | 0 |

Baseline is unchanged at 25 files / 242 tests (no valid new tests were
added in the correction round beyond the teardown guards, which add no
test count). Source-repo `git diff --check`: clean (exit 0).

## 6. Packed-package / global CLI evidence (from the Node 24.4.1 export)

- `npm pack -w @chrono/{domain,persistence,core,cli}` → 4 tarballs;
  `chrono-cli-0.1.0.tgz` contains **0 test files** (dist only).
- Isolated fixture installed all four tarballs (`added 43 packages`);
  `chrono` bin linked.
- Separate processes, all exit 0: `--version` → `0.1.0`; `init` →
  `ANALYZING`; `status` → projected `ANALYZING`; `validate` → `VALID`.

## 7. Real-runtime evidence (OpenCode / Claude Code)

Hook bytes generated from the release build and executed against the
**packed** `chrono gate` binary (wrapper script; unmasked exit codes):

| Case | Result |
|---|---|
| Claude hook, no dispatch context, inside project | exit 2, fail-closed message |
| Kiro hook, no dispatch context, inside project | exit 2, fail-closed message |
| Claude hook + forged session token | live `DENIED` (`REFERENCE_UNRESOLVABLE`), exit 2 |
| Kiro hook (`write`) + forged session token | live `DENIED`, exit 2 |
| Claude `Read` / Kiro `read`, no context | exit 0 (read-only pass) |
| Kiro unknown tool (`mcp__x`) | exit 2 `TOOL_DENIED` |
| OpenCode plugin: `read`, `grep` | ALLOWED |
| OpenCode plugin: `edit`, `write`, `bash`, `webfetch` | BLOCKED via live gate verdict |
| OpenCode plugin: `mcp__x` | BLOCKED `TOOL_DENIED` |

Hermetic suite additionally proves AUTHORIZED/DENIED obedience, missing
gate-binary denial, and malformed-payload denial for all three hooks
(`setup-cli.test.ts`, `runtime-hooks.test.ts`).

## 8. Kiro: hook-logic vs real-runtime distinction (explicit)

Proven: deterministic Kiro hook bytes, `.kiro/hooks/chrono-gate.json`
registration validity, canonical tool-name handling, deny-by-default,
byte-identical installation, and live-gate obedience of the script
against the packed Core. **Not proven: execution inside a genuine Kiro
runtime** (binary absent; no installation, global-config change,
credential use, or paid-model spend performed without PO authorization).
Prepared acceptance procedure: install the Kiro CLI, run
`chrono setup --adapter <id>`, open Kiro normally in the configured
project, confirm the PreToolUse hook fires before a write tool, confirm a
missing-context mutation is denied with recovery text, and confirm a
forged-token dispatch is denied by the Core. Slice 9 exit criterion 4
stays open until that procedure passes.

## 9. Security / adversarial evidence

- Enrollment, approval, waiver, rotation, and session tests deny forged /
  stale / non-interactive / wrong-scope / wrong-authority inputs;
  `registerPoPublicKey` denies ceremony bypass; rotation failure preserves
  the active key and cleans staging.
- Routing-proof tests deny forged, replayed, stale, cross-adapter,
  cross-runtime, cross-project, revoked-adapter, and post-proof
  binary-replacement cases.
- Adapter specs reject `provider=` / `model:` / `api_key` / `token` /
  `password` bindings (`VALIDATION_ERROR`).
- Sweeps: no `PRIVATE KEY` material in packages/docs/scripts; no
  hardcoded provider/model/version strings (the single `provider=openai`
  hit is an adversarial test asserting rejection); no stubs, TODO-only
  paths, or `.skip`/`.todo`/`.only` markers (gate-enforced).
- Session tokens never enter child environments (`runDispatch`); secrets
  are redacted from evidence/diagnostics paths per Core invariants.

## 10. Remaining blockers and external authorizations needed

1. **Independent Slice 9 review disposition** — implementation + second
   pass are committed; `COMPLETE` marking belongs to independent review
   and the PO. Exit criterion 4 (three-runtime conformance) is open on
   Kiro real-runtime evidence.
2. **Kiro runtime binary unavailable** on this host — environmental
   blocker for §8 acceptance (no install performed without authorization).
3. **Node 24.20.0 unavailable** — the exact reported crash environment
   could not be re-tested here; the fix is validated on 24.4.1.
4. **Paid-model execution / provider login** not used — real-runtime
   acceptance requiring model spend awaits explicit PO authorization.
5. **No push / tag / publish / release / remote changes performed**
   (unauthorized); all commits remain local on `main`.
6. Slice 10 and IMPLEMENTER-TASKS 3–7 are untouched per instructions
   (remain on Slice 9).

## 11. Documentation synchronization

`AGENTS.md`, `docs/README.md`, `IMPLEMENTATION-PLAN.md`,
`IMPLEMENTER-TASKS.md`, `SLICE-9.md` (still `READY FOR IMPLEMENTATION`),
and `SLICE-10.md` (still `QUEUED`) were reviewed: they state
requirements and queue order, make no passing-conformance claims, and
required no changes in this round. Runtime Contract, Core Specification,
schemas, and ADRs already specify the Slice 9 gate algorithms
(`gate_architecture_approval`, `gate_spec_ready`, `gate_verification`);
no normative change was needed for the teardown/lint corrections.
