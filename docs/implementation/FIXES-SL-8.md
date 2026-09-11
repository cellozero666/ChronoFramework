# Audit Report — Slice 8: Verification Loop Errors

**Status:** CLEARED 2026-09-11 — every error below was fixed and re-verified
(workspace: lint/typecheck/build clean, 24 files / 205 tests pass; clean
checkouts on Node v22.21.1 and v24.20.0 green; packed install + global CLI
verified; live ceremony 13/13 green).
**Post-audit corrections (same day):** this document itself contained two
errors — the live ceremony count (was "14/14", actually 13 checks) and the
global-configuration sentence ("read for writing" nonsense) — both fixed
below. The clean-checkout / pack / fixture evidence was refreshed after
those doc edits because source files changed since the first round; the
usage-error envelope path (item 1) was additionally proven live against
the packed CLI (single envelope, exit 1).
**Re-verification round findings:** no new code errors. The clean / pack /
live evidence above was re-executed because source files changed after the
first round (branded exit, setup output, `latestFull`); all green with the
final code. The only corrections needed were in this document itself
(count, phrasing), fixed above.
**Scope:** `chrono setup`, the OpenCode `tool.execute.before` plugin,
`describeSkillInstallation` / `describeRtkAttestation`, and everything the
Slice 8 loop touched.

## 1. Double JSON envelope on `--json` failures (real bug — FIXED)

Failing commands emitted their machine-readable body via `emitProgramResult`
and then fell through `program.error`, so `bin.ts` appended a *second* JSON
envelope on stdout: two concatenated documents, unparseable — violating the
"every failure path stays JSON-parseable" rule. Caught by the live hook
proof (the plugin's `JSON.parse` rejected the gate output).
**Fix:** branded `programFailureExit` error carrying `{exitCode,
chronoEmitted: true}` at all four `program.error` sites; `bin.ts` skips its
envelope when the flag is set (genuine commander usage errors still get
one). Covered by a `parseAsync` test asserting the branded rejection.

## 2. Stale `rtk verify` success message (doc inconsistency — FIXED)

The message claimed "execution still denies until Slice 8" while
`requireCurrentRtk` checks currency only. **Fix:** message now states
routing is recorded unproven and per-command routing enforcement is
adapter duty (`RUNTIME §6.3`).

## 3. `routingTestPassed` recorded but never enforced (contract gap — DOCUMENTED, not closed)

`RUNTIME §6.3/§11.3` require proven routing, but no dispatch path reads
the flag — and no production path can ever set it (the CLI always records
`false`; only tests record `true`). Flipping enforcement on now would deny
every CLI-attested deployment with no compliance path (no proof-submission
API exists), i.e. bricking, not fixing.
**Fix applied:** `RtkRepository.latestFull()` + `Core.describeRtkAttestation()`;
`chrono setup` reports `routingProven` transparently while gating on
currency. **Remedy (residual):** adapter-submitted routing-proof API plus
dispatch enforcement — Slice 9 / live-adapter work.

## 4. Missing `buildOpencodePlugin` re-export (caught by live script — FIXED)

The generator was importable from `./opencode-plugin.js` but not from the
package surface. **Fix:** re-exported from `index.ts`.

## 5. Test-only issues (all fixed in-loop)

- Extra closing brace in `cli.test.ts` after adding the envelope test
  (transform failure).
- `skillRawSourceUrl` import already present before its test was added
  (no-op edit, cleaned).

## 6. Live evidence (manual, `/tmp` only — never committed)

Full ceremony against production code paths, real binaries, real network:
`init` → `keys generate` → PO session open → gaspar bootstrap → real
opencode adapter register → signed approval → activate → list →
**real `rtk verify` (`rtk 0.44.0`, genuine `gain` dashboard)** → **real
`skill verify` (network fetch, hash verified)** → **live `setup`
(`opencode-live`, proofs green, plugin installed)** → generated plugin +
real `chrono` binary denies an unknown module end to end. 13/13 PASS.
Only the TTY probe was faked (headless shell) and the PO key held in a
memory store (no keychain prompts headless). No global user configuration
was created or modified; global state was only read (binary versions, the
RTK telemetry store).

## 7. Residuals (not concealed)

- Live LLM agent runs (actual `opencode run` sessions) are out of scope:
  non-deterministic, require provider auth, and would spend budget.
- Kiro runtime absent in this environment: Kiro conformance unproven.
- The plugin gates only the `bash` tool; broader tool mapping is
  runtime-specific adapter work.
- Per-command `rtk exec` wrapping and `chrono setup` installers beyond
  project-local assets remain future work.
- At the time of the audit report the Slice 8 files were uncommitted. They are
  now committed in repository history; no publication or release authorization
  is implied.
