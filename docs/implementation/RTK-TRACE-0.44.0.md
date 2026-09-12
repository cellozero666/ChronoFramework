# Production-path RTK routing trace (FIXES-SL-10.1 gate item 5)

**Date:** 2026-09-11
**RTK:** `/Users/m6/.local/bin/rtk`, `rtk 0.44.0`, `gain` exit 0 (genuine)
**CHRONO:** packed `@chrono/* 0.1.0` tarballs, isolated install (no workspace links)
**Cost/installation:** none — no paid models, no provider login, no installation,
no standing credentials (fresh trace-only PO keypair; cryptographic enrollment,
session, and approval ceremonies run for real through production code under a
`script(1)` pty at explicit PO direction)
**Redaction:** command outputs and file contents never recorded — exit codes,
byte counts, truncated hashes, trace-local ids, and Core verdicts only

## Method

Disposable project (`/tmp/rtk-trace/proj`), production Core API for setup
(init, enroll, sessions, adapter register/approve, module lifecycle to
APPROVED, authorize + ExecutionStarted, negative dispatch), packed `chrono`
CLI for `rtk verify`, `skill verify` (live pinned-release fetch), `setup`,
`rtk prove`, `rtk promote`, and both negative prove paths. Raw command
`ls <fixture dir>`; mapped command executed through the genuine binary.

## Observed rewrite contract (0.44.0)

- `rewrite(ls <dir>)` → exit **3**, mapping `rtk ls <dir>` (28 bytes)
- `rewrite(git status)` → exit **3**, mapping `rtk git status`
- `rewrite(echo hello)` / unknown → exit **1**, empty
- Note: `rewrite --help` claims 0-with-map; observed success exit is 3.
  `chrono rtk prove` is deliberately exit-agnostic (stdout presence is the
  contract) and handles both. `rtk hook check` exits 0 with the same mapping.
- Behavioral interception: raw `ls` (10 bytes) vs `rtk ls` (15 bytes) differ.

## Result log (redacted)

- 0. identity: version `rtk 0.44.0`, gain exit 0 (dashboard redacted)
- 1b. interception: raw vs routed outputs differ (contents redacted)
- 2–3. enrollment ok; gaspar + PO sessions opened (material redacted)
- 4. `rtk verify`: exit 0, ok, attestation `RTK-0001`
- 5. adapter `trace-ad` registered + approved
- 6a. `skill verify`: exit 0, ok (live pinned-release fetch)
- 6. `setup`: exit 0, ok (hooks installed)
- 7. `rtk prove -- ls <dir>`: exit 0, ok, authority **candidate**, `RTE-0001`
- 8. stored row: 1 scope, candidate, unexpired
- 9. `rtk promote`: exit 0, ok, authority **authoritative**
- 10. negatives: `prove(gain)` → `RTK_ROUTING_FAILURE` (identity-only);
  `prove(rtk ls)` → `VALIDATION_ERROR` (already-routed)
- 11. `MOD-0001` APPROVED (all PO approvals signed)
- 12. **dispatch: authorize ok, grant `GRANT-0001`, ExecutionStarted**
- 13. negative dispatch (approved adapter, no proof): `RTK_ROUTING_FAILURE`,
  "no current RTK routing proof for this adapter/runtime"

## Findings for the gate

1. Effective routing through the production adapter path is demonstrated:
   real `rewrite` mapping → real execution → candidate → promotion →
   authorized dispatch with grant burn, plus live denials.
2. Trace-exposed bug fixed in-tree: `rtk verify` program action dropped
   `--json` (regression test: `rtk-cli.test.ts` "program level").
3. Remaining open (unchanged): real OpenCode/Claude/Kiro runtime acceptance
   with paid/provider execution still requires PO authorization.
