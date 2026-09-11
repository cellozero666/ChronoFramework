# Slice 6 Report — Adapter Dispatch Contract (Phase 5 bootstrap)

**Status:** COMPLETE (implementation + verification loop, 2026-09-11)
**Scope:** `RUNTIME-CONTRACT.md` §4/§11/§13 and `IMPLEMENTATION-PLAN.md` Phase 5,
first increment: runtime adapter registry + authorized `chrono run` dispatch.
**Rule carried forward:** no publish, push, release, or remote change without
explicit Product Owner authorization.

## 1. Slice 5 closure (prerequisite, evidenced this turn)

`SLICE-5-REMEDIATION.md` was moved BLOCKING → COMPLETE only after fresh
evidence, all from file copies of the working tree (no manual links):

| Check | Node v22.21.1 | Node v24.20.0 |
|---|---|---|
| `npm ci` from clean copy | clean | clean |
| `eslint .` | clean | clean |
| `tsc --noEmit` | clean | clean |
| `tsc -b packages/cli` | clean | clean |
| Full suite | 18 files / 163 tests pass | 18 files / 163 tests pass |

- `better-sqlite3` native binding loads on Node 24.
- `npm pack` (4 tarballs, dist only, 0 test files) → isolated fixture
  installs all four tarballs → `chrono init/status/validate` each in a
  separate process → VALID.
- Repo-wide grep: no `.skip`/`.todo`/`it.only`/TODO stubs (only comments
  quoting the rule); `node_modules/@chrono/*` are npm-managed links only.
- Evidence table appended to `SLICE-5-REMEDIATION.md`, including the
  accepted fail-closed residual (`chrono skill verify` refuses until pinned
  release metadata lands; Core attestation path itself is real and tested).

## 2. Slice 6 scope (defined from the plan, not invented)

Phase 5 requires adapters that obey Core authorization without duplicating
policy. Slice 6 implements the runtime-neutral mechanism; runtime-specific
OpenCode/Claude Code/Kiro mappings remain later work:

1. **Adapter registry** — `registerAdapter` / `revokeAdapter` /
   `listAdapters` / `getAdapterForDispatch` (Core, PO-only for mutation).
2. **`chrono run`** — authorize → enact → spawn → evidence → advance,
   all through existing Core decisions.
3. **Conformance tests** against a real executable fixture runtime
   (the product path is never mocked; only the external binary is a fixture).

Out of scope for this slice (recorded as residuals, §5):
`chrono setup`/RTK installer, per-command `rtk exec` wrapping, live
OpenCode/Claude Code/Kiro hook conformance.

## 3. What was implemented

- `packages/domain/src/capabilities.ts` — new `adapter.register` /
  `adapter.revoke` capabilities (PO-only); `AUTHORITY_POLICY_VERSION`
  `"1"` → `"2"` (in-flight v1 grants burn fail-closed on revalidation).
- `packages/persistence/src/schema.ts` — migration 9: `adapter` table
  (id, name, entrypoint, gate_hook, dispatch_proof, rtk_routing,
  skill_activation, conformance_proof JSON, status, registered_by,
  registered_at); `SCHEMA_VERSION` 8 → 9.
- `packages/persistence/src/repositories.ts` — `AdapterRepository`
  (create with duplicate → `DUPLICATE_IDENTITY`, find, list, terminal
  revoke); `database.ts` / `index.ts` accessor + exports.
- `packages/core/src/chrono-core.ts` — `registerAdapter` (PO session;
  id shape, required fields, entrypoint exists + executable, no
  provider/model/secret assignments in declared specs), `revokeAdapter`,
  `listAdapters`, `getAdapterForDispatch` (active + entrypoint still
  executable, else fail-closed).
- `packages/cli/src/index.ts` — `runDispatch` + `chrono run` command:
  resolves requester + executor sessions, resolves the adapter,
  requires `argv[0] === entrypoint` (a grant cannot smuggle another
  binary), authorizes via Core, enacts `ExecutionStarted` /
  `ExecutionAssigned`, spawns with timeout (default 600s, bounded),
  injects `CHRONO_GRANT_ID/MODULE/ADAPTER/SESSION_TOKEN`, records
  evidence as the executor (integrity-hashed, secret-scanned by Core),
  re-authorizes and advances to `ImplementationComplete` /
  `ImplementationDone`. Nonzero exit or timeout leaves lifecycle state
  untouched for the correction loop.
- `packages/cli/src/keychain.ts` — unchanged surface (used as-is).
- `docs/core/RUNTIME-CONTRACT.md` — §3.1 table documents `chrono run`.
- Tests: `packages/core/src/adapter-registry.test.ts` (6: PO-only,
  field/entrypoint/duplicate/revocation/unknown denials),
  `packages/cli/src/run-cli.test.ts` (4: full APPROVED→VERIFYING cycle
  with evidence, failing command leaves EXECUTING, unregistered adapter
  + smuggled binary denials, session requirements),
  `migration.test.ts` asserts the `adapter` table after a v1→current upgrade.

## 4. Verification loop (code checked in a loop until zero findings)

Iteration 1 — full suite: 20 files / 173 tests pass. Sweeps found:
- Stale `CallerAuth` docstring ("or the orchestrating gaspar/PO") → fixed
  to exact role equality.
- `SLICE-5-REMEDIATION.md` evidence row cited `SCHEMA_VERSION = 8` →
  annotated as gate-time value.
- `RUNTIME-CONTRACT.md` §3.1 lacked the new `chrono run` command → added.

Iteration 2 — lint/typecheck/build/tests: 1 lint error
(`catch (e)` unused in `AdapterRepository.create`) → fixed to bare
`catch`; re-ran: lint clean, typecheck clean, build clean, 173/173 pass.

Iteration 3 — clean-checkout matrices with final code:
- Node 22.21.1 (`/tmp/chrono-clean`): ci + lint + typecheck + build +
  20 files / 173 tests pass.
- Node 24.20.0 (`/tmp/chrono-clean24`): ci + lint + typecheck + build +
  20 files / 173 tests pass.
- Pack from clean copy → isolated fixture (`/tmp/chrono-fixture6`):
  all four tarballs install, `chrono init/status/validate` across
  processes → VALID, `chrono run --help` serves the new command.
- Environment flake noted: two `npm ci` runs in freshly created dirs
  initially misfired because the shell cwd was `/tmp` instead of the
  target dir ("Missing script: lint"); re-running with the correct cwd
  succeeded. No product impact.

Iteration 4 (final, workspace): lint clean, typecheck clean, build
clean, 20 files / 173 tests pass. Loop terminated: zero findings.

## 5. Residuals and blockers (not concealed)

1. `chrono run` spawns the entrypoint directly; per-command
   `rtk exec adapter …` wrapping (`RUNTIME` §6.3) is not yet implemented.
   Pre-dispatch RTK currency is still enforced via `authorizeExecution`,
   so this is a hardening gap, not a bypass. → Slice 7 / adapter work.
2. `chrono setup`, RTK installer/skill fetcher, and live
   OpenCode/Claude Code/Kiro hook conformance remain Phase 5 work and
   require those runtimes plus PO approval for global config changes.
3. Carried from Slice 5: `chrono skill verify` stays fail-closed until
   pinned release metadata lands.
4. At the time of this report no publish/push/release was performed. These
   Slice 6 files were committed later; this sentence is retained as historical
   execution evidence, not a statement about the current working tree.

## 6. PO decisions recorded

- Slice 5 BLOCKING → COMPLETE on re-evidenced criteria (this turn).
- Slice 6 scope as §2 (registry + run + fixture conformance; live
  runtime mappings deferred).
- No security-policy waivers granted; all denials remain fail-closed.

## 7. Files changed (Slice 6 scope; committed later)

- `docs/core/RUNTIME-CONTRACT.md` (command table)
- `docs/implementation/SLICE-5-REMEDIATION.md` (COMPLETE + evidence)
- `docs/implementation/SLICE-6.md` (this report)
- `packages/cli/src/index.ts` (`runDispatch`, `chrono run`)
- `packages/cli/src/run-cli.test.ts` (new, 4 tests)
- `packages/core/src/adapter-registry.test.ts` (new, 6 tests)
- `packages/core/src/chrono-core.ts` (adapter registry API)
- `packages/domain/src/capabilities.ts` (adapter caps, policy v2)
- `packages/persistence/src/database.ts`, `index.ts`, `repositories.ts`,
  `schema.ts` (migration 9, `AdapterRepository`)
- `packages/persistence/src/migration.test.ts` (upgrade assertion)

Prior-turn security work is already committed (`28183b7`).
