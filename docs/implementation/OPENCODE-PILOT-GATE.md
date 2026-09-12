# OpenCode-First Pilot Gate — `chrono init` Real-Runtime Validation

**Status:** BLOCKING — short OpenCode adapter correction required before the first real-runtime run
**Decision owner:** Product Owner
**Decision:** Validate the product with OpenCode first. Claude Code and Kiro remain supported roadmap targets but do not block the OpenCode pilot. This staging decision does not remove their final-v1 conformance requirements and does not authorize unsupported compatibility claims.
**Reviewed baseline:** Slice 9/10 corrective commit `b972cd5` on `main`; during review the local `origin/main` reference also pointed to `b972cd5`
**Non-authorization:** No push, publication, paid model execution, provider login, global installation, runtime installation, or global configuration mutation is authorized by this document.

## Purpose

Move from hermetic implementation verification to a controlled real OpenCode
test as soon as the OpenCode entry boundary is truthful. The pilot validates
the intended public journey:

```text
install release-shaped package
→ chrono init
→ open OpenCode normally
→ Gaspar is active before the first response
→ persisted CHRONO state governs the session
```

Claude Code and Kiro validation follow as separate compatibility milestones.
Failure or absence of either runtime must not prevent a project explicitly
configured only for OpenCode from initializing or running. Final v1 and any
claim of three-runtime conformance remain blocked until their matrices pass.

## Independent verification performed

The corrective tree that became commit `b972cd5` was checked directly on
2026-09-11:

- `npm run test:clean`: PASS — 32 files, 364 tests, zero skips, todos,
  unhandled errors, or worker crashes;
- `npm run lint`: PASS;
- `npm run typecheck`: PASS;
- `npm run build`: PASS;
- `git diff --check`: PASS;
- C1 projection handling is now fail-closed and covered by focused Core/CLI
  tests;
- C2 has a recorded production-path RTK 0.44.0 trace;
- C3 uses the ADR-006 candidate/promote authority model and migration v13;
- C4 remains hermetic-only and is intentionally deferred from this OpenCode
  pilot.

This evidence establishes readiness of the shared Core baseline, not readiness
of the OpenCode first-response experience.

## Finding OC-P1 — OpenCode entry failure is still swallowed

The generated OpenCode plugin currently treats automatic entry as best effort:

- a missing entry script returns silently;
- a nonzero entry-script result is ignored;
- exceptions in entry execution are swallowed;
- exceptions or invalid output during system-context injection are swallowed;
- the projection is truncated to 8,000 characters instead of being validated
  and rejected at a documented bound;
- the regression test explicitly expects silent degradation when the entry
  script is missing.

Inside a CHRONO project this violates Slice 10's requirement that Gaspar be
activated before the first response and that entry fail closed rather than
continue as an ungoverned agent. Pre-tool mutation gates remain protected, but
they do not make an incorrect first response acceptable.

### Required correction

For a directory containing `.chrono/chrono.db`, the OpenCode adapter must:

1. treat a missing/unreadable entry script, timeout, nonzero exit, malformed or
   oversized projection, and unavailable system-context injection as explicit
   entry failures;
2. prevent or visibly abort the first governed response when Gaspar context
   cannot be injected; a warning followed by an ordinary agent response is not
   sufficient;
3. validate a structured projection before injection and reject it atomically
   rather than truncating it;
4. surface stable, secret-safe diagnostic codes and a `chrono doctor` recovery
   action;
5. remain silent only outside a CHRONO project;
6. update tests so every failure above denies, while successful injection
   occurs exactly once per OpenCode session;
7. correct comments/documentation that say the session token is held in plugin
   memory: the current implementation writes it to a `0600` temporary file;
8. define and test token-file lifetime and cleanup on failed entry and runtime
   close/restart, without exposing its path or contents to the model.

The implementation must use the actual supported OpenCode plugin API. If the
API cannot abort the first response from the current event/transform hooks,
stop and document the exact capability mismatch instead of simulating success.

## Finding OC-P2 — Routing-proof promotion is not atomic with its audit event

`promoteRoutingProof()` currently updates the proof row and appends the
`ProofPromoted` event as separate writes. If event persistence fails after the
update, an authoritative proof can exist without its required audit event.
Additionally, migration v13 adds no database trigger constraining arbitrary
routing-proof updates to the single legal `candidate → authoritative`
transition.

### Required correction

- execute proof promotion and `ProofPromoted` event append in one database
  transaction;
- prove rollback when event append fails;
- enforce at the persistence layer that no routing-proof field can be updated
  except the one legal promotion, with non-null promotion hashes;
- prevent subsequent modification or deletion of authoritative proofs;
- add direct-SQL tamper tests and concurrent/double-promotion tests;
- preserve idempotent re-promotion without emitting duplicate audit events.

This is shared Core hardening and must close before the OpenCode pilot because
the pilot relies on the authoritative RTK proof to permit mutations.

## Finding OC-P3 — Project root escapes the Git repository

A real packed-CLI dry run found a blocking project-isolation bug:
with cwd `/tmp/chrono-opencode-project.bF0FCv` (a fresh Git repository
without `.chrono`) and an unrelated `/private/tmp/.chrono` present,
`chrono init --runtime opencode --dry-run` reported project
`/private/tmp`. Root cause: `findProjectRoot` walked to the filesystem
root with no repository boundary, and `/tmp` vs `/private/tmp`
spellings were never canonicalized before comparison.

### Required correction (shipped same session)

One canonical resolver used by every command, with Git root as the
maximum upward boundary, nearest-`.chrono` adoption only at or below
it, shared-temp ancestors never adopted from or traversed, full
`realpath` canonicalization (explicit `--path` included), stored
project identity (`runtime_config.project.root`, recorded at init)
verified on adoption with fail-closed rejection on mismatch (legacy
rows without it stay adoptable), and the same boundary rules ported to
the POSIX entry script and all three generated gate scripts (stored
identity needs SQLite and stays CLI/Core-side, documented). Canonical
binary/entrypoint identity was hardened alongside (attestation, proof,
and registration compare canonical spellings; `chrono run` accepts the
same binary under any equivalent spelling).

### Evidence

Adversarial suites: `project.test.ts` isolation describe (git
boundary, nested/non-git adoption preserved, nested independent repos,
symlinks, temp-ancestor skip, stored mismatch vs legacy, no-modification
purity, exact host repro under `/tmp`); `runtime-hooks.test.ts`
isolation describe (both gate scripts, same four cases);
`setup-cli.test.ts` OpenCode root parity; `kiro-capability.test.ts`
entry-script behavioral cases (skip/boundary/adopt/temp/missing
broker); canonical-spelling fixes covered by existing suites with no
test-logic changes. Live proof below: the exact disposable-project dry
run with the newly packed CLI while `/private/tmp/.chrono` still
exists, selecting `/private/tmp/chrono-opencode-project.<suffix>`.

Live repro proof (2026-09-12, newly packed `@chrono/* 0.1.0`
tarballs, isolated install, `/private/tmp/.chrono` present and
untouched, cwd `/tmp/chrono-opencode-project.bF0FCv` — a bare Git
repository without `.chrono`):

- `chrono init --runtime opencode --dry-run` → exit 0, reports
  `project: /private/tmp/chrono-opencode-project.bF0FCv (new
  repository)` (previously: `/private/tmp`);
- `--json` form reports the same canonical project with zero conflicts;
- probe directory afterwards contains only `.git/` (zero writes);
- the unrelated `/private/tmp/.chrono` was never modified, and was
  not deleted to make the test pass.

## Finding OC-P4 — PO enrollment fails on the real macOS Keychain round-trip

A real `chrono init --runtime opencode` failed at `PO_ENROLLED` with
`CORE_INIT_FAILURE: "Primary key verification failed before
enrollment; previous custody restored."` The project stayed safely
resumable at `PROJECT_INITIALIZED`. Root causes, both confirmed live
against the host Keychain:

1. Fragile string equality: `runEnroll` compared the read-back PEM
   with exact `!==` against the generated PEM, but macOS
   `security find-generic-password -w` output is not byte-identical
   (trailing-newline variance).
2. Worse, `security -w` **hex-encodes passwords containing newlines**
   (observed: 119-byte PEM → 239-byte lowercase hex + newline; single-line
   secrets return plain). The retrieved "PEM" could never parse.
3. Latent `isNotFound` defect: it inspected only the first line of
   `execFileSync` errors (`Command failed: ...`), never stderr, so real
   "could not be found" results threw `KeychainError` instead of
   returning null — misdiagnosing absent keys and masking the absent
   vs locked distinction.
4. Latent secret exposure: those same error messages embed the full
   argv including `-w <private key>`; failure paths surfaced them into
   CLI output. (Also fixed: Linux `deleteKey` ignored its `service`
   parameter.)

### Required correction (shipped same session)

Canonical `verifyKeyCustody` (`packages/cli/src/keychain.ts`), applied
identically at enrollment, rotation (staging included), and every
custody checkpoint: normalize transport-equivalent encodings only
(CRLF→LF; ASCII whitespace trimmed at the boundaries; interior bytes
untouched), accept the macOS hex transport form, then REQUIRE parsing
as Ed25519, public-key derivation, and fingerprint equality with the
expected public key. Null/empty/malformed/truncated/replaced/non-Ed25519
material returns false; nothing secret is printed, logged, or
persisted. Exec errors now surface sanitized stderr only (PEM-scrubbed,
length-capped) — argv with key material never reaches output — and
`isNotFound` inspects stderr, restoring the absent-vs-failure
distinction. Previous-key atomic restore is unchanged and covered under
trimming semantics.

### Evidence

Unit suites: `keychain.test.ts` (exact/trimmed/CRLF/whitespace
acceptance gated on proof; malformed/different/truncated/empty/EC-key/
garbage-identity/interior-corruption/hex-of-wrong-key rejections;
sanitizer redaction + caps) plus a real-`security` integration test on
a unique disposable service/account asserting write → provable custody
→ delete → absent, deleting only that credential.
`authority-cli.test.ts`: enrollment + rotation through a trimming
store (macOS read semantics), read-failure fail-closed with no
enrollment, previous-key restoration verified cryptographically.
Live proof (2026-09-12, newly packed `@chrono/* 0.1.0`, isolated
install, fresh disposable Git project — never the pilot project):
`chrono enroll` under a real pty with the challenge typed back →
exit 0, fingerprint recorded, no key material in output, Core
`poKeyRevision` set, keychain-held 239-byte hex material proving
custody; then exactly the enrolled credential deleted and the probe
project removed (verified absent afterwards). No model, no provider,
no OpenCode launch, no push/publish.

## OpenCode pilot entry criteria

The real test may start only when:

1. OC-P1 and OC-P2 are fixed and their adversarial tests pass;
2. the generated plugin imports and registers through the installed OpenCode
   version without experimental-hook errors;
3. a packed, isolated CHRONO installation passes `chrono init --dry-run` and
   non-paid setup smoke checks;
4. `chrono doctor` reports the selected OpenCode adapter, authoritative RTK
   proof, managed assets, broker, and Gaspar entry as ready;
5. the implementer provides a redacted step-by-step acceptance script and
   expected results;
6. no Claude/Kiro absence is treated as a blocker when only OpenCode was
   selected;
7. the final pre-pilot report says `READY_FOR_OPENCODE_PILOT`.

## Phase and completion semantics

The OpenCode run is **Phase 6A**, an incremental MVP proof for the first runtime.
It may validate the OpenCode product path and unlock continued OpenCode-focused
end-to-end work. It does not:

- mark Slice 9 or Slice 10 globally `COMPLETE`;
- complete the all-runtime Phase 6 task;
- qualify Claude Code or Kiro;
- authorize a final v1 release or claims of universal runtime conformance.

After a successful Phase 6A run, record an OpenCode acceptance report. Then
schedule Claude Code as Phase 6B and Kiro as Phase 6C. Failures found in shared
Core behavior during any runtime phase reopen the affected shared gate.

## Required OpenCode real-runtime observations

Using a disposable project and release-shaped packed packages, record:

- exact Node, npm, CHRONO, OpenCode, RTK, OS, architecture, and model metadata;
- `chrono init` detection, consent, enrollment, adapter approval, RTK proof and
  promotion, skill emission, hooks, broker, readiness, and resume behavior;
- normal OpenCode launch without a copied bootstrap prompt;
- Gaspar identification and PO interview before the first response;
- pinned Karpathy Guidelines activation evidence;
- one read-only operation and one harmless mutable operation reaching the live
  Core policy path;
- restart/session renewal and persisted-state resume;
- denial on hook drift, expired/revoked credentials, missing Core, missing
  entry script, invalid projection, and RTK/asset drift;
- redacted transcript, exit codes, hashes, audit references, and actual cost.

Provider login or model spend must be explicitly authorized immediately before
the real run. Publication remains separately unauthorized.

## Exit

This gate becomes `READY_FOR_OPENCODE_PILOT` only after OC-P1 and the pre-pilot
criteria pass. It becomes `OPENCODE_PILOT_PASSED` only after the real-runtime
observations above are independently reviewed. Claude Code and Kiro retain
their own later gates and final-v1 obligations.

## Pre-pilot evidence (2026-09-12, uncommitted on `main`)

Batteries on the corrective tree: `test:clean` PASS (32 files / 379 tests,
zero skips/todos/crashes), `lint` / `typecheck` / `build` /
`git diff --check` clean; clean-export matrix Node 22.21.1 + 24.20.0 (fresh
`npm ci`, full battery each) green; packed tarballs (0 `*.test.*` files)
installed isolated without workspace links with CLI smoke green.

### OC-P1 — FIXED (fail-closed OpenCode entry)

Reproduced all six silent-degradation paths in the generated plugin, then
rebuilt entry as mandatory inside CHRONO projects against the actual
installed OpenCode 1.18.30 plugin API (published types
`@opencode-ai/plugin@1.18.30` plus host-binary inspection):

- `session.created` handlers are fire-and-forget (`void hook[…]`): they
  cannot abort anything. Prefetch only.
- `experimental.chat.system.transform` IS present in 1.18.30 (types +
  binary). Hook exceptions fail the `Effect` chain inside request
  preparation, so a throw fails the LLM request with a user-visible
  error instead of producing a first response.
- `tool.execute.before` throws deny only the single tool call; the agent
  continues. It is the backstop, not the abort.
- No hook can suppress a text-only first response except by failing its
  request; the design does both (transform throws) and denies every tool
  including reads while entry is unproven (so a renamed/removed transform
  upstream degrades to denial, per the documented U6 risk).

Shipped (`packages/cli/src/opencode-plugin.ts`, generated bytes):
missing/unreadable script, timeout (30 s, `CHRONO_ENTRY_TIMEOUT_MS`
override), nonzero exit, malformed/non-JSON/`ok:false`/bad-shape
projection, >64 KiB projection (rejected, never truncated), and
unavailable injection surface all throw stable secret-safe
`ENTRY_BLOCKED[<code>]` with a `chrono doctor` recovery action; success
injects the canonical validated payload atomically exactly once per
session; outside CHRONO projects the plugin stays silent. The entry
script now emits `--json` and never prints the token path. Token
lifecycle: 0600 file written only after successful redeem, path never
printed/logged/modeled; plugin holds no credential; stale files
(CHRONO-namespaced, older than 2× broker TTL) swept best-effort on
session create/delete and dispose; failed entry creates no file.

Tests (`setup-cli.test.ts` "fail-closed, OC-P1": 13, replacing the old
silent-degradation test): once-only atomic injection, lazy entry without
prior event, outside-project silence (transform + tools), missing-script
denial on transform and on read/mutate/unknown tools, nonzero/timeout/
five malformed shapes, oversize atomicity, injection-unavailable,
3-attempt budget then terminal determinism, token-path redaction,
stale-sweep + state drop on session end, event-shape independence.

Cross-adapter note: the shared entry script now emits `chrono entry
--json` (structured validation for OpenCode) and no longer prints the
token path on success — Kiro surface injection receives the same safe
JSON fields instead of human text, with no secret or path exposure.

### OC-P2 — FIXED (atomic promotion with persistence guard)

`promoteRoutingProof` now commits the row update and its `ProofPromoted`
audit event in one database transaction: event failure rolls the row
back to candidate (reproduced pre-fix with a dropped `event_log`: the
row leaked to authoritative; post-fix it stays candidate and promotion
returns failure). `RoutingProofRepository.promote` returns
`{record, applied}`; a concurrent promotion landing first resolves to
`applied:false` with no duplicate event. Migration v14 adds
`routing_proof_permit_promotion_only` (exactly candidate → authoritative
with non-null hashes, all other columns frozen) and
`routing_proof_no_delete` triggers; Core validation stays primary.

Tests: rollback on dropped `event_log`; exactly-one-event across repeats;
two-connection concurrent promotion → one event; persistence suite
(trigger presence on v11/v12/v13 → v14 upgrades, legal-promotion shape
allowed, demotion/hash-less/evidence/binary/expiry/hash mutations and
both deletes denied with rows untouched, repository idempotency);
existing v11/v12 → v13 migration behavior preserved (vintage rows still
migrate as candidates and promote after approval).

### Pre-pilot criteria disposition

1. OC-P1 + OC-P2 fixed and adversarial tests pass — MET (above).
2. Plugin imports/registers through installed OpenCode 1.18.30 without
   experimental-hook errors — MET hermetically (packed-build plugin:
   `node --check` clean, hooks `dispose/event/transform/tool.execute.before`
   register, outside-project pass) AND API-verified (transform present in
   1.18.30 types and host binary with abort-on-throw semantics); live
   launch observed in the pilot itself.
3. Packed isolated install passes `init --dry-run` + non-paid smoke —
   MET (`/tmp/chrono-pilot` isolated tarballs; `--runtime opencode`
   dry-run exit 0 with opencode-only files and zero conflicts; host
   detection: opencode 1.18.30 + claude-code 2.1.206 selected, kiro
   absent/unselected, RTK 0.44.0, zero conflicts; packed plugin smoke).
4. `doctor` ready-report — MET hermetically (configured-project doctor
   asserts entry ready; OpenCode-only independence test asserts no
   Claude/Kiro reasons); live re-confirmation is pilot acceptance step 3.
5. Acceptance script + expected results — PROVIDED below.
6. No Claude/Kiro absence treated as blocker for OpenCode-only — MET
   (scoped setup/doctor/plan assets; `init-flow.test.ts` independence
   test; live dry-run evidence above).
7. Final pre-pilot report — the implementer's closing report carries the
   `READY_FOR_OPENCODE_PILOT` / `BLOCKED` recommendation.

Claude Code and Kiro implementations are untouched and stay fail-closed;
no three-runtime claim is made. Slices 9/10 stay globally
`IMPLEMENTED — NOT COMPLETE`.

## Phase 6A acceptance procedure (provider-backed; PO authorization required)

Do not begin until the PO explicitly authorizes provider-backed OpenCode
execution (this authorizes real, unknown-amount model spend — see cost).
All prior steps are non-paid and may be performed now.

Setup (non-paid, may be done immediately):

```sh
export PATH="/tmp/chrono-6a/bin:$PATH"   # isolated packed install (criterion 3 rerun)
mkdir -p /tmp/chrono-6a-pilot && cd /tmp/chrono-6a-pilot && git init -q .
chrono init --dry-run --runtime opencode --path .
```

Pilot (PO interactive; first provider-backed command is step 6):

1. `chrono init --runtime opencode --path .` — complete PO enrollment
   (typed ceremony), consent, adapter approval when prompted.
2. Close the setup terminal (proves no conversational dependency).
3. `chrono doctor --path .` — expect entry ready, authoritative RTK
   proof, managed assets, broker active.
4. Close everything; launch `opencode` normally in the project
   (no copied prompt, no token export, no extra command).
5. Observe: Gaspar introduces itself before the first response,
   identifies the human as Product Owner, starts product discovery,
   references the pinned Karpathy Guidelines skill.
6. Read-only operation (e.g. list files) succeeds through the gate.
7. Harmless mutable operation (e.g. create then remove a scratch file
   inside the project) succeeds only via live Core authorization;
   repeat with the entry script renamed away in a second session and
   confirm `ENTRY_BLOCKED` instead of a first response.
8. Restart OpenCode; confirm Gaspar resumes persisted state and the
   session renews without credential exposure.
9. Failure drills (each must fail closed with recovery text): hook
   drift (edit the generated plugin), revoked broker credential,
   stopped/unavailable Core (rename `.chrono/chrono.db` briefly),
   replaced RTK binary, edited managed asset.
10. Collect: redacted transcript, `node/npm/chrono/opencode/rtk`
    versions, exit codes, command/output hashes, `ProofPromoted` audit
    seq, grant ids, actual cost from the provider bill.

Expected observations: every step succeeds except drill step 9 items,
which deny with `ENTRY_BLOCKED[...]`, `TOOL_DENIED`, `RTK_ROUTING_FAILURE`,
`EXECUTION_DENIED`, or `BLOCKED_*` plus a `chrono doctor` pointer; no
token/secret/key material appears in transcripts, logs, or the repo.

Rollback/recovery: quit OpenCode; `chrono doctor --path .` to diagnose;
`chrono broker revoke <id>` + `chrono adapter revoke` to terminally revoke;
`chrono uninstall --scope hooks|broker|adapters` for scoped removal;
delete the disposable directory; OS-keychain PO key remains for reuse.
Nothing outside the disposable project is touched.

Cost: the pilot necessarily spends real model tokens (unknown amount —
depends on the PO's provider, model, and pricing); all setup/verification
above it is free. Authorizing step 4+ authorizes that spend.

## Exit

This gate becomes `READY_FOR_OPENCODE_PILOT` only after OC-P1 and the pre-pilot
criteria pass. It becomes `OPENCODE_PILOT_PASSED` only after the real-runtime
observations above are independently reviewed. Claude Code and Kiro retain
their own later gates and final-v1 obligations.
