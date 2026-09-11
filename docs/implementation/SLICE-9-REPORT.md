# Slice 9 Implementation Report — Runtime Enforcement Closure

**Status:** HISTORICAL IMPLEMENTATION REPORT — Slice 9 is implemented but not
`COMPLETE`; current disposition and remaining work are recorded in
`SLICE-9.md` and `FIXES-SL-10.1.md`.
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
| `6386c75` | Slice 9 correction: better-sqlite3 12.11.1 → 13.0.3 (N-API teardown fix) |
| `1e34d65` | Slice 9 correction: final report with root cause, fix, and matrix evidence |
| `6b6a205` | Slice 9 bug review: revocation cascade, proof-submitter binding, identity families |

51 files changed, 5041 insertions(+), 719 deletions(-) (`git diff
--stat f21c313..HEAD` — the lockfile churn from dropping
`prebuild-install` dominates the deletion count). Full name list:

- `AGENTS.md`, `docs/README.md`, `docs/implementation/IMPLEMENTATION-PLAN.md`,
  `docs/implementation/IMPLEMENTER-TASKS.md`, `docs/implementation/SLICE-9.md`
  (checkpoint wording only), `docs/implementation/SLICE-10.md` (new, queued),
  `docs/implementation/SLICE-9-PO-TRUST-DECISION.md` (new, §1 below),
  `docs/implementation/SLICE-9-REPORT.md` (new, this file)
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

Independent reproduction (fresh `git archive HEAD` export, Node 24.20.0):

```text
npm ci                    PASS
npm run test:clean        FAIL — Test Files 24/25, Tests 226/242,
                          2 unhandled errors, process exit 1
Worker exited unexpectedly
Assertion failed: env != nullptr
node::RemoveEnvironmentCleanupHook
better-sqlite3 Statement::~Statement
```

The missing 16 tests exactly match `gate-cli.test.ts` (16 tests): one
forked worker aborted mid-file. The new `test:clean` gate behaved
correctly by detecting and rejecting the failure.

### Root cause (verified against upstream)

better-sqlite3 12.x inherits Node's raw `node::ObjectWrap`. Its
constructor registers an environment cleanup hook and its destructor
removes it. When a `Statement` object is finalized during or after
Environment teardown — a GC-timing-dependent race, which is why one
worker file can vanish intermittently — the destructor calls
`RemoveEnvironmentCleanupHook` with no current Environment and Node's
`CHECK_NOT_NULL(env)` aborts the process. References: upstream issue
#1507 ("process aborting from terminating worker threads", fixed in
v13.0.2) and the v13.0.0 N-API migration notes. The crash is
independent of test logic: no leaked Core/database ownership was found
(audit: all CLI entry points close in `finally`; all one-shot
statements; constructor throw paths close; no `.iterate()`/`.backup()`
handles; no cached statements).

### Implemented fix

better-sqlite3 `12.11.1` → `13.0.3` in `packages/core/package.json`,
`packages/persistence/package.json` (`@types/better-sqlite3` `7.6.13` →
`9.6.0`), and the root `allowScripts` key. Justification:

- v13.0.0 migrates the addon to `node-addon-api` (N-API), structurally
  removing the `ObjectWrap` cleanup-hook crash path; v13.0.2 explicitly
  fixes worker-termination aborts.
- `engines: node >= 22` covers the declared `^22.12.0 || ^24.0.0` range.
- N-API prebuilds ship inside the package for darwin-arm64/x64,
  linux-arm64/x64 (gnu + musl), and win32-arm64/x64 — verified present in
  the installed tree with no `build/Release/*.node`, so supported-OS
  installs need no compiler toolchain (and the same binary serves ABI
  127 and 137, eliminating the ABI-mismatch class).
- The deprecated `prebuild-install` dependency is gone (lockfile shrinks
  accordingly).
- API usage is unchanged (`Database`, `pragma`, `prepare`/`run`/`get`/
  `all`, `exec`, `transaction`, `close`); typecheck passes on the new
  types; migration, concurrency (`grants`, `sequence`), audit-immutability,
  and tamper suites all pass unmodified — no weakened transaction,
  concurrency, audit, or tamper guarantee.

Retained hardening (still valuable, not the fix): idempotent
`ChronoDatabase.close()` and guarded `afterEach` teardown in 21 test
files (a `beforeEach` failure can no longer mask itself with `TypeError`).
`test:clean` additionally fails on any Vitest `Errors N` section. No
Vitest configuration change, no suppression, no disabled suite, no
`passWithNoTests`, no forced exit, no count reduction, no narrowed Node
range.

## 4. Exact versions

| Component | Version |
|---|---|
| Node.js (matrix A) | v22.21.1, npm 11.18.0 |
| Node.js (matrix B / current 24 on host) | v24.4.1, npm 11.4.2 |
| Vitest | 2.1.9 |
| TypeScript | 5.9.3 |
| better-sqlite3 | 13.0.3 (N-API prebuilds bundled; `@types/better-sqlite3` 9.6.0) |
| opencode (real binary) | 1.18.30 |
| claude/Claude Code (real binary) | 2.1.206 |
| rtk/Rust Token Killer (real binary) | 0.44.0 (`rtk gain` dashboard ok) |
| kiro | ABSENT (`command not found`) — environmental blocker |

Node 24.20.0 (reviewers' environment) is unavailable on this host.

## 5. Clean-install matrix (fresh `git archive HEAD` exports)

Per environment: `npm ci` → `npm run test:clean` → `npm run lint` →
`npm run typecheck` → `npm run build` (`git diff --check` is clean in the
source repo; a bare export has no git tree to diff). Node 24.20.0 runs
from a checksum-verified official portable binary
(`SHASUMS256 b7bf7707…`, `/tmp`-local, no system installation); shell,
npm, npx, the gate script, the Vitest coordinator, and forked workers
all resolve to that single executable (`which node/npm/npx`,
`#!/usr/bin/env node` shebang, `process.execPath` forks), and the N-API
prebuild removes ABI coupling structurally.

| Env | Executable / ABI / npm | npm ci | test:clean (files/tests) | lint | typecheck | build |
|---|---|---|---|---|---|---|
| Node 22.21.1 (`/tmp/g22`) | ServBay `…/22/22.21.1/bin/node`, ABI 127, npm 11.18.0 | 0 | PASS — 25 files, 246 tests, exit 0, 0 unhandled, 0 crashes, 0 skips | 0 | 0 | 0 |
| Node 24.4.1 (`/tmp/g2441`) | Homebrew `/opt/homebrew/Cellar/node/24.4.1/bin/node`, ABI 137, npm 11.4.2 | 0 | PASS — 25 files, 246 tests, exit 0, 0 unhandled, 0 crashes, 0 skips | 0 | 0 | 0 |
| Node 24.20.0 (`/tmp/g2420`) | portable `node-v24.20.0-darwin-arm64/bin/node`, ABI 137, npm 11.19.0 | 0 | PASS ×5 consecutive — 25 files, 246 tests, exit 0, 0 unhandled, 0 crashes, 0 skips | 0 | 0 | 0 |

8 further consecutive PASS runs on 24.20.0 were recorded in the
pre-commit trial tree (identical code and dependency versions): **13
consecutive clean 24.20.0 runs total**, plus repeated full-suite,
single-file, and `--no-isolate` runs during diagnosis — zero markers in
every run.

Baseline is at 25 files / 246 tests (242 at the correction round plus 4
from the pre-review bug sweep: unapproved-submitter denial, revocation
cascade, nested-duplicate merge, operational identity families).
`test:clean` enforces the floor (now 246) and fails on any Vitest
`Errors` section. Source-repo `git diff --check`: clean (exit 0).

## 6. Packed-package / global CLI evidence (from the Node 24.20.0 export)

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
  (`rtk gain` dashboard statistics persist in RTK attestations as
  savings evidence — tool-generated counters, accepted residual.)

## 10. Pre-review bug sweep (2026-09-11, commit `6b6a205`)

A line-by-line re-review of the Slice 9 diff found and fixed four
issues before independent review; two further candidates were
investigated and closed with no change:

1. **Revocation did not cascade to sessions (fixed).** `revokeAdapter`
   burned grants lazily but left the adapter's sessions valid, so a
   revoked adapter's sessions could still submit routing proofs, record
   evidence, and — via `parentSession` delegation — mint new sessions
   indefinitely. Fix: revocation now revokes live bound sessions
   atomically in the same transaction (`SessionRepository.revokeByAdapter`),
   audited with the cascade count, surfaced as `revokedSessions` through
   the Core result and `chrono adapter revoke` output. Tests: cascade
   death (`was revoked`), delegation failure, survivor-adapter isolation.
2. **Cross-adapter proof submission (fixed).** `recordRoutingProof`
   checked the *proof's* adapter but not the *submitter's*: any valid
   session could mint proofs for any approved adapter. Fix: the
   submitter's session adapter must independently be approved
   (`requireApprovedAdapter`, spec-literal §9.3), without demanding
   submitter/proof identity (multi-runtime operators keep working).
   Tests: ghost (never-registered) and pending submitters deny;
   approved submitters pass; two fixtures corrected to the enforced
   semantics (both adapters approved).
3. **Core-minted IDs outside the validated families (fixed).**
   `sequences.allocate("RTE"/"SES")` minted routing-proof and session IDs
   that `parseArtifactId`/`isValidArtifactId` rejected (operational tables
   are never validated, so latent, not live). Fix: `RTE`/`SES` added to
   `ARTIFACT_ID_FAMILIES` and `ID_PATTERN` under the documented GRANT
   precedent, with identity tests and the CORE §3.1 table synced.
4. **Claude-settings duplicate via malformed nesting (fixed).**
   `mergeClaudeSettings` could append a second entry when the managed
   command hid inside an unparseable group. Fix: recursive command scan;
   dead structural walk removed; nested-duplicate test added.
5. **`runRtkProve` CLI (no change).** Verified airtight: command must
   start with the resolved RTK binary, `--version` + `gain` identity
   checks precede execution, exit 0 required, hashes computed from actual
   argv/stdout, only hashes (never raw output) persisted.
6. **`projectId: "default" `(no change).** Single-project v1 design,
   consistent across enrollment, proofs, grants, and sessions — not a bug.

## 11. Remaining blockers and external authorizations needed

1. **Independent Slice 9 review disposition** — implementation + second
   pass are committed; `COMPLETE` marking belongs to independent review
   and the PO. Exit criterion 4 (three-runtime conformance) is open on
   Kiro real-runtime evidence.
2. **Kiro runtime binary unavailable** on this host — environmental
   blocker for §8 acceptance (no install performed without authorization).
3. **Paid-model execution / provider login** not used — real-runtime
   acceptance requiring model spend awaits explicit PO authorization.
4. **No push / tag / publish / release / remote changes performed**
   (unauthorized); all commits remain local on `main`.
5. At the time of this report, Slice 10 and IMPLEMENTER-TASKS 3–7 were
   untouched. Slice 10 was implemented later; this statement is retained only
   as historical evidence for this report's original scope.

## 12. Documentation synchronization

`AGENTS.md`, `docs/README.md`, `IMPLEMENTATION-PLAN.md`,
At the time of this report, `IMPLEMENTER-TASKS.md`, `SLICE-9.md`, and
`SLICE-10.md` stated the then-current queue order. Their current status is now
maintained in those files and `FIXES-SL-10.1.md`; this historical report must
not be used as the live checkpoint. Runtime Contract, Core Specification,
schemas, and ADRs already specify the Slice 9 gate algorithms
(`gate_architecture_approval`, `gate_spec_ready`, `gate_verification`);
no normative change was needed for the teardown/lint corrections.
