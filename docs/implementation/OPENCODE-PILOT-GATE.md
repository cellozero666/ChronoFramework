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

## Finding OC-P5 — Resumed init silently returns after PO_ENROLLED

A real `chrono init --runtime opencode` failed at `PO_ENROLLED` on
macOS: fresh project initialized, enrollment completed, doctor
reported `PO_ENROLLED`, and the re-run accepted `yes init <hash>`
then returned silently with nothing created (no adapter, RTK, skill,
hooks, broker) and no error, resume hint, or nonzero result. Root
cause: the macOS Keychain returns multiline PEM material hex-encoded,
so PO-session bootstrap crashed inside `signApprovalPayload` with an
uncaught throw that escaped `runInitFlow` and died silently in the
CLI's top-level catch (exit 1, zero output without `--json`).

### Required correction (shipped same session)

- Canonical key transport (`normalizeKeyTransport`) plus a single
  `readPoPrivateKey` rule used at every PO signing site (approve,
  waive, rotation, privileged sessions, flow bootstrap): boundary-only
  normalization, hex-decode only into PEM-armored bytes, parse proof
  required; broker secrets pass through byte-identical. Approve/waive
  signer throws now map to stable `SIGNATURE_INVALID` envelopes.
- The apply driver tracks the executing step and converts ANY
  unexpected throw into a stable step failure (step, code, resume
  action) — silent exits are structurally impossible. Exit 0 requires
  `READY` (now gated on the doctor's own readiness verdict, so a
  tampered/skipped flow can never complete silently) or the deliberate
  already-ready path. Consent/resume/READY envelopes all carry step
  and next action.
- `newRepository` means "no CHRONO project here" (not "no git
  commits"): an initialized repo reads as an existing CHRONO project
  even before its first commit. Plan hash covers detection inputs and
  moves only on material change (e.g. key enrolled).
- Second live-found defect (same session): every command passed explicit
  `--path` through verbatim, bypassing the canonical resolver — an
  explicit `--path /tmp/...` displayed and recorded the non-canonical
  spelling. All 28 `--path` call sites now route through
  `resolveProjectDir(cwd, explicitPath)` (signature widened to accept
  the raw option value), so explicit and cwd-derived resolution compute
  identical identity; nonexistent explicit paths keep the verbatim
  fallback.

### Evidence

`init-flow.test.ts` "resume and fail-closed driver" (6): full init
through macOS hex keychain semantics in one invocation (the exact
repro); resume past PO_ENROLLED with no duplicate adapters/approvals/
broker state; loud JSON+human envelopes with step/code/resume;
exit-code semantics (0 READY / 2 consent+blockers / 1 failures);
plan-hash stability + material-change sensitivity; resume from every
persisted step never exiting silently incomplete (tampered jumps fail
loud at the READY doctor gate). `project.test.ts` gains an
explicit-symlink case: `resolveProjectDir` through a symlinked path
returns the same canonical identity as cwd resolution under both
spellings. Live proof (2026-09-12, repacked `@chrono/* 0.1.0`
`chrono-cli` sha256
`e7e36f2a33febfc13dcfe12af942987574e04835da0758ea8736194588b97f14`,
isolated install, fresh disposable projects): explicit
`--path /tmp/chrono-ocp5-final2-<suffix>` AND cwd-form dry runs both
report `project: /private/tmp/chrono-ocp5-final2-<suffix>` with 10
planned steps and zero writes afterwards. Earlier live proof below:
packed-CLI dry run
in a new disposable Git project plus read-only doctor on the failed
pilot project (untouched); enrollment itself re-proves on the
PO-authorized pilot retry, which now flows through the fixed path.

## Finding OC-P6 — READY/doctor consistency defect on the packed-CLI pilot

A real `chrono init --runtime opencode` reported `step: READY`
(`runtime: opencode`, `next: open runtime`), but a separate-process
`chrono doctor --json` on the same project reported `setupStep:
READY` with `broker.visible=false`, `broker.active=0`,
`entry.ready=false` (`"broker visibility needs a gaspar/PO
session"`), top-level `ok=false`. Root cause: the init completion
gate ran the doctor **in-process with a gaspar session**, while the
documented normal-user doctor had no session and therefore could
never see the broker. READY was persisted on privileged evidence
that public verification could not reproduce — a one-command
readiness violation.

### Required correction (shipped same session)

- New Core-owned public broker health projection
  (`brokerHealth`: active/missing/revoked/inconsistent/unknown over
  counts plus the single active id and a non-sensitive reason; never
  secret hashes) and a read-only digest-match check
  (`verifyBrokerSecretHash`: timing-safe boolean only, no audit, no
  distinguishing detail). Both unauthenticated, like the other
  doctor-read projections.
- The doctor verifies broker health publicly with no session:
  registry projection × non-secret `.chrono/broker-account` file
  (id and account cross-checked; forged/mismatched/malformed reads
  as inconsistent) × non-destructive keychain read validated by a
  local SHA-256 comparison inside the Core. Nothing secret is
  printed, logged, or persisted. Unreadable registry or keychain
  reads as `unknown` (inaccessible) — never conflated with "no
  active broker".
- The init completion gate (and the already-ready path) re-invoke
  `chrono doctor --json` as a **separate process** (`[node, entry,
  doctor, --path, root, --json]`) with an allowlist-sanitized
  environment (no `CHRONO_SESSION_TOKEN`, no secret carriers, no
  `NODE_OPTIONS`/`LD_PRELOAD`/`DYLD_*` preload vectors). READY
  persists only on exit 0 + `ok:true` + `entry.ready:true`;
  anything else is a loud READY-step refusal.
- Doctor and init share one canonical project spelling, so
  symlinked invocations derive the same broker account.

### Evidence

`chrono-core.test.ts` "Broker health projection" (4): missing /
single-active / all-revoked states, hash non-exposure, digest
match/mismatch/unknown/revoked/malformed semantics.
`entry-ops.test.ts` "Broker health projection (OC-P6)" (7):
missing DB record, missing keychain secret, revoked-with-READY
setup, inaccessible-keychain unknown without absence conflation,
forged/mismatched/malformed account files, JSON/human/exit-code
consistency on both verdicts, zero secret leakage on every
surface. `init-flow.test.ts`: gate argv/env sanitization test
(separate-process invocation shape, session/secret/preload
exclusion, PATH allowlist) plus `sanitizeDoctorEnv` unit test;
every full-flow fixture now verifies through the simulated child
doctor.

Live repro proof (2026-09-13, repacked `@chrono/* 0.1.0`
`chrono-cli` sha256
`9df8d3695d238ca3db155fe6798c98db41fc541a79dbb0c2f735c529679222e7`,
isolated install, fresh disposable Git project
`/tmp/chrono-ocp6-live-<suffix>`, separate processes, clean env
without `CHRONO_SESSION_TOKEN`):

- `init --runtime opencode --dry-run --json` → 10 planned steps,
  canonical `project: /private/tmp/chrono-ocp6-live-<suffix>`,
  zero writes afterwards;
- real `init --runtime opencode --yes --json` (headless) stops LOUD
  at `PO_ENROLLED`, exit 1: `APPROVAL_REQUIRED` — "chrono enroll
  requires an interactive human terminal … agents and scripts
  cannot approve" — with step and resume action. The human-only
  refusal precedes key generation, so the global PO keychain
  custody is untouched; enrollment stays a PO act, never an
  agent-automated one;
- separate-process `doctor --json` then reports, exit 1:
  `setupStep: PROJECT_INITIALIZED` (READY was never persisted),
  `broker.state: missing` ("no broker credential: run chrono init
  to resume setup"), `entry.ready: false`, `ok: false` — the exact
  consistency the defect violated, now holding from the other
direction. The full init→READY→doctor loop to double-READY
requires the PO ceremony in a live terminal and re-runs on the
PO-authorized pilot retry.

## Finding OC-P7 — Generated entry script invokes a nonexistent CLI option

The first neutral prompt in the real OpenCode Phase 6A pilot died
with `[chrono] ENTRY_BLOCKED[ENTRY_DENIED]: entry script exited 3:
error: unknown option '--secret-stdin'`. Root cause: producer/
consumer drift — the generated
`.chrono/hooks/chrono-entry-session.sh` passed `--secret-stdin`
while the `chrono entry` command never registered it (it reads the
broker secret from stdin unconditionally). The generator and the
parser evolved independently with no shared contract, and one
hermetic test even enshrined the obsolete flag.

### Required correction (shipped same session)

- Single source of truth (`packages/cli/src/entry-contract.ts`):
  the `ENTRY_OPTIONS` spec owns every flag, its placeholder,
  required-ness, and help text. The Commander `entry` command
  builds its options from the spec; the generated script renders
  its invocation through `renderEntryInvocation` with shell
  values. No compatibility flag was added (the CLI's stdin
  behavior was already correct); the obsolete flag is gone from
  the generator. The broker secret travels on stdin only — never
  argv, environment, output, or logs.
- Binding currency (upgrade safety): new Core projection
  `routingProofBinding` mirrors dispatch's registration/asset
  checks, and the doctor reports `routing: stale` with a
  re-prove/promote reason when the snapshot no longer matches —
  so a regenerated script can never silently ride an old proof.
- Upgrade/repair path (no project deletion, no weakened drift
  protection): the doctor stays read-only and keeps reporting
  drift; `chrono setup --adapter <id>` (documented scoped repair)
  and re-running `chrono init --runtime <id>` both regenerate the
  script from the shared contract without moving setup state;
  when the regenerated bytes differ from the promoted snapshot
  (generator upgrade), the READY gate refuses until a fresh
  routing proof is recorded and promoted (entry itself supplies
  the gaspar session for re-proving; promotion stays a PO act).
  When repair restores byte-identity, the gate passes — healing
  without authority re-confirmation is impossible by construction.

### Evidence

`entry-contract.test.ts` (7, always-run): script invocation equals
the renderer output; every contract flag registered on the real
Commander command; required flags present and nothing unregistered
in the script; secret/compat flags banned; renderer omission
semantics; unknown-option and missing-required failures through
real Commander parsing. `entry-ops.test.ts` repair loop: obsolete
plant → doctor reports drift + stale bindings → init re-run heals
→ upgrade simulation (proof snapshotted over obsolete bytes) →
gate refuses with re-prove → fresh prove/promote → doctor and
init agree on READY. `entry-blackbox.test.ts`
(`npm run test:blackbox`, `CHRONO_BLACKBOX=1`): isolated install
of the four packed tarballs, disposable OpenCode-only project
initialized through the packed binary under a pty-driven PO
ceremony, PATH-injected file-backed `security` boundary (host
keychain untouched), fixture `rtk`/`opencode` as real executables;
the generated script runs unchanged via the packed binary with
the secret on stdin — valid projection, fresh 0600 token per run,
no secret/token/path in output; corrupt/missing secrets stay
fail-closed (exit 3, no token); malformed/missing/extra options
fail loudly against the packed binary. Live proof (2026-09-13,
final `@chrono/* 0.1.0`, `chrono-cli` sha256
`fcf26b4160b3804322742a4a1c24b1bc97381ac25beefd9fd9ca821361a484a0`,
isolated installs, disposable OpenCode-only projects): the
black-box ran green three times end to end (packed install →
pty-driven PO ceremony → packed `init` READY → separate-process
packed `doctor` READY → generated script unchanged through the
packed binary with stdin secret → valid projection, fresh 0600
token per run, zero leaks), and `chrono entry --help` on the final
packed CLI shows exactly the contract flags (no `--secret-stdin`).

Repair and retry on the pilot project (no deletion, drift
protection intact): re-run `chrono init --runtime opencode` (it
regenerates the obsolete script, then gates); if the gate demands
it, record a fresh proof and promote
(`chrono entry` supplies the gaspar session, promotion stays a PO
act); the first OpenCode prompt then redeems through the fixed
invocation.

## Finding OC-P8 — Upgrade/repair leaves READY persisted and demands manual granular commands

A real `chrono init --runtime opencode` on an existing READY project
under the previous entry script failed repair at
`NATIVE_HOOKS_INSTALLED` with `BLOCKED_RTK: "RTK attestation is not
current: run chrono rtk verify first"`, instructed a bare re-run, and
a separate `chrono doctor --json` then reported `setupStep: READY`
with a stale attestation, `opencode` routing `proven`, a
drifted/false entry hook, and `entry.ready: false`. The repair both
left READY persisted while public verification disagreed and required
an internal granular command even though `chrono init` is the public
orchestrator. The live pilot project was preserved unrepaired as
regression evidence; no granular fix, OpenCode launch, push, or
publication was performed for it.

### Required correction (shipped same session)

- READY is a verified projection, not an irreversible stored label:
  new Core `demoteSetupForRepair()` moves strictly backward to an
  earlier valid step with an audited `SetupRepairDemoted` event,
  preserving project identity, PO key/enrollment, valid broker,
  unrelated files, audit history, and previous evidence as
  historical non-authoritative data. Forward-only
  `advanceSetupState` semantics are unchanged; secret-bearing repair
  detail is rejected; forward resumption re-advances normally.
- `chrono init --runtime opencode` assesses drift/stale evidence on
  every existing project run and demotes before re-running: stale
  attestation or routing (missing/candidate/expired/out-of-sync
  bindings) demotes to `RUNTIMES_SELECTED` to re-run
  `RTK_VERIFIED_AND_ROUTED`; managed-hook drift demotes to the
  routing stage as well (healing changes the asset manifest, so a
  fresh prove pre-heal plus post-heal promotion must happen in the
  same run). The forward flow then re-verifies genuine RTK, records a
  fresh attestation, proves effective routing, regenerates managed
  assets, promotes the fresh candidate interactively (PO promotion
  stays a human act), revalidates bindings, runs the separate-process
  doctor gate, and persists READY only on agreement. No adapter,
  identity, broker, approval, or authoritative-proof duplication.
- Normal repair never instructs `chrono rtk verify/prove/promote`,
  `setup`, session, or adapter commands; granular commands remain
  diagnostic/expert interfaces. Failed repair returns nonzero with
  the exact step plus one `chrono init` resume action and never
  leaves `setupStep=READY` while the public doctor disagrees.
- Doctor reports routing as `stale` (never simply `proven`) when its
  bound attestation is not current or managed assets drifted, with an
  explicit re-verify/re-prove reason; on a stored READY project with
  blocked entry it projects the earliest repair step as `setupStep`
  (keeping `storedSetupStep` for audit transparency).

### Evidence

Hermetic suites: `init-flow.test.ts` "Init upgrade/repair
orchestration (OC-P8)" (4: READY demotion + one-command repair with
zero manual instructions, stale-binding re-prove/promote, loud step
failure without READY while doctor disagrees + resume, audited
demotion without history loss); updated `entry-ops.test.ts`
(revoked-broker projection `GASPAR_ENTRY_PREPARED` + stored READY;
OC-P7 repair now asserts orchestrated prove/promote with exit 0 and
an interactive terminal); full `test:clean` PASS (36 files / 459
tests), `lint` / `typecheck` / `build` / `git diff --check` clean.

Live repro proof (2026-09-14, packed `@chrono/* 0.1.0` built from
this tree, isolated install, disposable Git project, PATH-injected
file-backed `security` boundary with host keychain untouched, real
RTK 0.44.0 + OpenCode 1.18.30 binaries, network for the pinned skill
fetch only, no model/provider spend, no OpenCode launch, no
push/publish — every step a separate process):

- `init --dry-run` → exit 0, canonical project, zero writes;
- pty-driven `init --runtime opencode --yes --json` → exit 0,
  `step: READY`; separate-process `doctor` → `setupStep: READY`,
  attestation current, routing proven, `entry.ready: true`;
- planted previous-generator state (obsolete `--secret-stdin`
  script) + trigger-legal attestation staleness
  (`current → stale`, row preserved): separate-process `doctor` →
  exit 1, `setupStep: RTK_VERIFIED_AND_ROUTED` (stored READY),
  attestation stale, routing stale with re-verify + drift reasons,
  `entry.ready: false` — the fixed contract (previously: READY +
  proven while blocked);
- pty-driven repair `init --runtime opencode --yes --json` →
  exit 0, `step: READY`, zero `run chrono rtk/setup` instructions;
  separate-process `doctor` → exit 0, READY/current/proven/ready;
  script healed (no `--secret-stdin`); second `init` → idempotent
  resume (`resumed: true`);
- registry audit: 1 active adapter, 1 approval, single active broker
  `BRK-0001` preserved; `RTK-0001` retained stale + `RTK-0002`
  current; `RTE-0001` retained + `RTE-0002` authoritative; 1
  `SetupRepairDemoted` event among 20 setup events; no secret
  material in outputs, logs, or the repo.

## Finding OC-P9 — Automatic Gaspar activation failed on the provider-backed run

Real provider-backed observation (2026-09-14, PO-authorized model
spend, no other paid execution in this session):

1. Packed CHRONO 0.1.0 project was READY; separate-process `chrono
   doctor` returned `ok=true` with `entry.ready=true`.
2. OpenCode 1.18.30 opened in the project without visible plugin errors.
3. The Product Owner sent only: "Olá".
4. The first response was a generic greeting ("Olá! Como posso ajudar
   você hoje?") with no Gaspar identification, PO recognition, CHRONO
   state, mandatory skill activation, or discovery interview.

This is an actual provider-backed failure. Startup success and doctor
readiness are NOT proof of Gaspar activation. The live pilot project
was preserved as regression evidence; no paid retry, push, or
publication was performed here.

### Diagnosis against the installed OpenCode 1.18.30 contract

Verified against `@opencode-ai/plugin@1.18.30` /
`@opencode-ai/sdk@1.18.30` sources and the installed binary:

- Project plugins in `.opencode/plugins/` auto-load; a module exports
  one or more `(ctx) => Promise<Hooks>` functions. Path and export
  shape were correct.
- `session.created`/`session.deleted` events carry
  `properties.info.id` — the previous plugin correlated on fictional
  shapes (`properties.sessionID`) with a catch-all `"default"`
  bucket, so prefetch state never matched the requesting session.
- `experimental.chat.system.transform` declares `sessionID?`
  (OPTIONAL) and fires during request preparation; `chat.message`
  declares `sessionID` (required) and fires when a user message is
  received, before generation; `tool.execute.before` declares
  `sessionID` (required). Nothing gated the first *message*, so a
  skipped or silent transform path fell through to the default agent.
- A second live-found defect: the plugin spawned the entry script
  inheriting the host process cwd while the script resolves its
  project from its own working directory — redeeming (or silently
  skipping) the wrong project when they differ.

### Required correction (shipped same session)

- One per-session promise/state machine (`pending`/`ok`/`blocked`,
  bounded attempts, terminal determinism): `session.created`
  prefetch, `chat.message` gating, system-transform injection, and
  the tool backstop all await the SAME shared entry work.
  Correctness never depends on event ordering or timing; concurrent
  callers deduplicate to a single entry execution.
- `chat.message` is now a fail-closed first-message gate: missing,
  pending-unresolved, failed, malformed, oversized, or expired
  projections throw stable secret-safe `ENTRY_BLOCKED` instead of
  producing an ordinary default-agent response.
- Transform awaits bounded entry completion (async execution with
  hard timeout kill, `CHRONO_ENTRY_TIMEOUT_MS` override) and injects
  a strong deterministic contract exactly once: Gaspar identity, PO
  recognition, state-aware opening from the validated projection,
  mandatory karpathy-guidelines activation (pinned commit + source
  hash, Core-reported install state), Core-decision compliance, and
  Gaspar-only authority. A failed first request may retry after
  recovery within the documented budget; it never falls through.
- Entry children start with `cwd` set to the validated project root.
- Non-secret runtime evidence (plugin load, entry redeem, projection
  injection with session/entry-session/projection-hash/skill metadata)
  appends to `.chrono/runtime-activation.jsonl`. Prompts, user
  content, secrets, tokens, and credentials are structurally excluded.
  `chrono doctor` reports it as a separate `activation` section that
  NEVER claims activation from static assets and never changes the
  setup-readiness verdict — the PO diagnostic after a failed attempt.
- Repair path: the corrected plugin bytes change the managed-asset
  manifest, so the existing OC-P8 machinery demotes, regenerates,
  re-proves, and promotes automatically on `chrono init --runtime
  opencode`; broker-secret loss additionally demotes to the entry
  rotation step (revoke secret-less credential, issue fresh) in the
  same run.

### Evidence

Hermetic: `opencode-activation.test.ts` (18: message gate,
transform-before-event, pending-join, prefetch-failure recovery,
concurrent-transform dedup, below/above-timeout delays, duplicate
events, anonymous-transform join, silence outside projects, evidence
content/secrecy, restart, legacy shape; plus 3 doctor-evidence
unit tests); updated OC-P1 legacy tests to the real event shape;
`init-flow.test.ts` gains plugin-repair (previous-generator bytes →
healed `chat.message` bytes + READY, zero manual instructions) and
broker-rotation tests. Full `test:clean` PASS (38 files / 480
tests), `lint` / `typecheck` / `build` / `git diff --check` clean;
Node 22.21.1 + 24.4.1 clean-export matrices green.

Packed black-box (`npm run test:blackbox`, 8/8 with the OC-P7 entry
suite): isolated tarball install, pty-driven PO ceremony to READY,
GENERATED plugin bytes driven through the packed CLI with a real
entry subprocess — racing message + transforms inject the Gaspar
contract exactly once with matching session evidence and zero
secrets; lost-secret fail-closed plus one-command init repair back
to READY verified live in separate processes.

## Finding OC-P10 — Projection injected, but OpenCode stayed on Build

Real provider-backed observation (2026-09-14, PO-authorized model
spend, no other paid execution in this session):

- OpenCode first response: "Olá! Como posso ajudar você hoje?";
  the UI still displayed the built-in Build primary agent.
- `chrono doctor` reported `activation.observed=true` because a
  projection had been injected.
- Therefore the OC-P9 telemetry was a false positive:
  projectionInjected != GasparSelected.

The live pilot project was preserved as regression evidence; no paid
retry, push, or publication was performed here.

### Diagnosis against the installed OpenCode 1.18.30 contract

Verified against the docs, `@opencode-ai/sdk` v2 types, the installed
binary oracles (`opencode debug config`, `opencode debug agent
<name>`), and a scratch project:

- Custom primary agents are project-local markdown files in
  `.opencode/agents/` (filename becomes the agent name; `description`
  required; `mode: primary`; no `model` field means the agent uses the
  externally configured OpenCode model).
- The project `default_agent` (`opencode.json` or `opencode.jsonc`,
  merged with global config, project winning) decides which primary a
  new session uses; unknown/subagent defaults fall back to `build`.
- CHRONO generated no agent definition and never set
  `default_agent`, so new sessions correctly kept Build no matter how
  perfect the injected context was. No prompt injection can substitute
  for native primary-agent selection, and model self-identification
  ("I am Gaspar") is behavioral hearsay, never runtime evidence.

### Required correction (shipped same session)

- `chrono setup`/`chrono init --runtime opencode` generate the seven
  canonical role definitions
  (`.opencode/agents/{gaspar,belthazar,melchior,prometheus,lucca,glenn,spekkio}.md`):
  Gaspar is the visible `primary`; the rest are subagents per the
  normative role model. Model-neutral (no `model` field ever), no
  secrets/tokens/credentials, deterministic bytes, drift-checked like
  every managed asset (proof bindings invalidate on regeneration).
- The user-owned project configuration is merged structurally, never
  rewritten: exactly the top-level `default_agent` key becomes
  `gaspar`; unrelated keys, comments, and formatting survive
  byte-for-byte; no provider/model is ever written. `opencode.jsonc`
  wins when only it exists; both files present, duplicate keys,
  non-string values, or malformed JSON/JSONC fail closed with
  remediation. Permission-preserving backup (`<file>.chrono-bak`,
  once) precedes the first change; a managed sidecar
  (`.chrono/opencode-config.json`) records ownership and the prior
  value for drift repair and exact uninstall restoration (prior
  default returns, or the added key is removed; unrelated bytes stay;
  user agents in the same directory are never touched).
- `init` discloses every agent/config file it will create or modify
  and requests consent; re-runs are byte-idempotent; uninstall
  restores the prior default exactly.
- The plugin records native selection via the official `chat.params`
  hook (`agent` per session; hidden `compaction`/`title`/`summary`
  excluded from the verdict). Activation evidence is now five distinct
  fields: plugin load, broker redemption, projection injection,
  skill-context injection, native primary-agent selection.
  `activation.observed` requires the exact session to have selected
  Gaspar with projection+skill injected at or before that selection.
  Doctor reports `default_agent`, the latest selected agent, and
  explains mismatches (`default_agent=gaspar` but session=build:
  close OpenCode, open a fresh session — existing sessions keep their
  agent by OpenCode behavior; nothing is forced silently).

### Evidence

Hermetic: `opencode-agent.test.ts` (17: exact role names, Gaspar
primary / others subagent, model-neutrality, determinism, merge
preservation/idempotence, duplicate/non-string/malformed refusal,
no-model/provider writes, key removal, jsonc resolution, comment
stripping, backup-once with mode bits, drift, uninstall restore with
user-agent preservation); `opencode-activation.test.ts` +5 (exact-
session Gaspar observed, Build never Gaspar, projection-only
unobserved, injection-before-selection ordering, hidden agents);
`init-flow.test.ts` +2 (fresh init writes byte-identical agents and
selects gaspar; drift repair reheals; default=gaspar/session=build
mismatch reported without false activation). Full `test:clean` PASS
(39 files / 504 tests), `lint` / `typecheck` / `build` /
`git diff --check` clean; Node 22.21.1 + 24.4.1 clean-export
matrices green.

Packed black-box (9/9 with the OC-P7/OC-P9 suites): the GENERATED
plugin plus the GENERATED agents/config, driven through the packed
CLI and the REAL `opencode` binary oracles — `debug config`
resolves `default_agent: gaspar`, `debug agent gaspar` resolves
`name=gaspar mode=primary` with no model override, built-in `build`
preserved; racing message/transforms inject exactly once with
matching session evidence; lost-secret fail-closed plus one-command
init repair back to READY verified live in separate processes.

### Pilot retry procedure (prepared, not executed)

On the existing pilot project (untouched by this session):

1. `chrono init --runtime opencode` — installs/merges the native
   agent configuration, invalidates affected asset bindings, and
   automatically re-proves/re-promotes RTK to READY (OC-P8
   machinery; no granular commands).
2. Fully quit OpenCode (existing sessions retain Build by OpenCode
   behavior — never force them).
3. Reopen OpenCode in the project into a NEW session; confirm the UI
   shows Gaspar as the primary agent.
4. Send the probe message; Gaspar must identify itself, recognize
   the PO, and begin/resume from persisted state.
5. `chrono doctor --json` must show setup READY plus
   `activation.observed=true` with the exact session selected as
   Gaspar. Any paid step needs fresh PO authorization immediately
   beforehand.

## Finding OC-P11 — CHRONO cannot materialize its initial governed artifacts

**Status:** IMPLEMENTED — NOT VERIFIED (blocking live acceptance; the
defect below is blocking, this label must not be read as completion)

Real Phase 6A workflow observation (provider-backed OpenCode run,
`/Volumes/Studio/HOSTS/CHRONOTESTAPP`, initialized READY, Gaspar
genuinely selected, session closed with no chat approval accepted):

1. Gaspar completed product discovery.
2. Gaspar attempted `chrono artifact status` through OpenCode's bash tool.
3. CHRONO denied it as generic implementation mutation:
   `[chrono] CHRONO project without dispatch context: export
   CHRONO_GATE_MODULE ... or dispatch via 'chrono run'.`
4. Gaspar created no Markdown documents and no Core artifact records.
5. Gaspar created no approval ticket.
6. OpenCode displayed no native approval UI.
7. Gaspar fell back to a chat-only Approve/Deny proposal, correctly
   admitting that it could not register it.

The governed artifact flow is therefore NOT functional in the real
OpenCode runtime. The pilot did not advance beyond the planning
deadlock. Chat text was reported as registered authority, and the
only offered recovery required the very authorization the flow could
not yet produce.

### Proven code-level root causes (C1–C6)

- **C1 — `tool.execute.before` reads the wrong argument.** The hook
  declared `(input)` and read the command from the first argument,
  but OpenCode 1.18.30 passes `(input { tool, sessionID, callID },
  output { args })` (verified in the installed SDK
  `@opencode-ai/plugin` and corroborated by the installed official
  RTK plugin, which reads `output?.args.command`). The hook never saw
  the real command, classified bash as generic mutation, and demanded
  implementation dispatch.
- **C2 — tests encoded a fictional hook payload** (`command` in the
  first argument) in `planning-tools.test.ts` and
  `approval-ceremony.test.ts`. They passed without proving runtime
  conformance. Corrected to the exact two-argument SDK shape, plus a
  regression test proving the old shape alone authorizes nothing.
- **C3 — no authenticated session reached the CLI process.** Planning
  CLI requires `--session-token`/`CHRONO_SESSION_TOKEN`, correctly
  hidden from Gaspar, with no host binding for shell-spawned
  commands. Corrected by preferring native tools (below): the token
  never enters a generic shell environment.
- **C4 — `--body-file` was a second deadlock.** Gaspar cannot create
  the temp file blocked tools would require. Corrected: bodies travel
  inline (`--body-stdin`, native tool `body` argument); the flag
  remains for operator use only and Gaspar is never instructed to use
  it.
- **C5 — no native planning tools were registered.** Comments claimed
  "narrow native tools" while only bash strings were allowlisted.
  Corrected: real model-callable tools in the generated plugin's
  `Hooks.tool` collection (`.opencode/tools/chrono.ts`, six tools),
  with stable Zod schemas, host-held sessions, and Core validation.
- **C6 — the claimed E2E did not execute the claimed flow** (hook
  permitted, then direct Core helpers). Corrected: E2E tests cross
  the plugin/tool/CLI/Core/filesystem boundary OpenCode uses; the
  prior claim is withdrawn below.

### Evidence taxonomy (binding for this finding)

- **Generated-byte tests**: byte-exact assertions on emitted files,
  never runtime proof.
- **Direct-Core tests**: Core semantics without runtime traversal.
- **Packed tests**: isolated tarball install plus CLI behavior.
- **Real-runtime evidence**: observed TUI behavior with a paid model.
  Only the last closes OC-P11. Unit, byte, and packed evidence are
  necessary but insufficient, and must be labeled as such wherever
  OC-P11 completion is discussed.

### Required correction (corrected implementation)

A Core-governed planning/artifact-authoring path distinct from
implementation execution, exposed as REAL native OpenCode tools
(C1–C6 corrected; unauthorized claims withdrawn):

- Gaspar proposes and materializes permitted planning artifacts
  (discovery, requirements, architecture proposals, ADRs, Specs,
  harness drafts, security-profile proposals, roadmap/Module/Work
  Package plans) before any implementation Module/WP exists — with no
  arbitrary filesystem, shell, or implementation authority.
- `chrono run` execution grants stay reserved for authorized
  implementation work.
- Runtime-neutral Core operations (`proposePlanningArtifact`,
  `revisePlanningArtifact`, `planningStatus`) plus CLI tools
  (`chrono artifact propose|revise|status`) create or revise the
  planning set. Every operation enforces the Gaspar capability matrix
  (`planning.propose`, `planning.revise`, `planning.status` — Gaspar
  and PO only; workers denied).
- Validation covers artifact type, identifier, lifecycle entry state,
  revision, references, allowed destination, schema, and content size
  (1 byte to 64 KiB; secrets denied without persisting).
- Authoritative Markdown and SQLite registry/event changes land
  atomically or recoverably (file first via tmp + rename, so a
  filesystem failure denies with nothing persisted; registry second,
  removing the created file when the transaction fails; revise keeps a
  backup and restores the last good draft — no half-materialized draft
  is ever presented as ready).
- Writes reach only canonical managed artifact locations derived from
  (kind, id) — there is no caller-supplied path, so traversal,
  symlinks, product-code writes, and escapes are structurally denied.
- Model content enters as untrusted DRAFT/PROPOSED material.
- Chat text never becomes PO authority: `planning-approval` (plus the
  existing `architecture-security` / `module-approval` actions) binds
  artifact ID, exact revision/hash, decision type, timestamp,
  rationale, and security implications through the existing signed,
  interactive ceremony. Revision changes stale prior approvals
  deterministically. Gaspar presents the exact ceremony and reports
  chat acceptance only as "PO stated approval in chat".
- OpenCode exposes REAL native tools (`.opencode/tools/chrono.ts`,
  six tools: `chrono_artifact_status/propose/revise/supersede`,
  `chrono_approval_request/status`) with stable Zod schemas,
  host-held sessions, stdin bodies, and Core validation of role,
  session, project, kind, destination, size, secrets, revision, and
  lifecycle. There is deliberately NO approval-confirm tool: signing
  never follows model tool invocation. Bash compatibility uses the
  real two-argument `(input, output)` contract but is NOT a
  substitute for native tools; gaspar.md names the native tools
  (shell planning instructions removed) and explicitly allows the
  native `question` tool (`question: allow` in the Gaspar agent
  permission policy — OpenCode denies tools by default, so without
  this line the confirmation boundary never renders). Claude/Kiro
  keep hook-level planning classification.
- Safe Core projections (`chrono_artifact_status`: proposed, awaiting
  PO signature, approved, rejected, stale) replace direct reads of
  internal state. Discovery persists incrementally, so restart resumes
  accepted answers without chat history.
- The circular dependency is closed ONLY through the native tools
  (hermetic + packed evidence below); the prior bash-only claim is
  withdrawn pending the live pilot in the retry procedure.
- The sample tasks-app fixture separates administrative database
  bootstrap (`admin-bootstrap.sql`, superuser: roles, database,
  grants) from the application schema (`app-schema.sql`, schema
  owner: tables plus DML-only grants). The runtime `tasks_app`
  account never receives CREATE DATABASE/TABLE privileges.

### Repair defects D1–D4 (pilot findings, corrected without touching the pilot)

All four root causes below are corrected and hermetically proven; the
pilot project was never modified. The live retry still requires
separate PO authorization for provider spend:

- **D1 — macOS native approval signing.** The generated tool sent raw
  Keychain output to `createPrivateKey()`, missing the canonical hex
  PEM transport normalization. Corrected by sharing one normalizer
  (`key-transport.ts`, delegated by `keychain.ts`) with a
  parity-locked embedded copy in generated bytes, plus Ed25519
  validation and fingerprint binding. The production
  `CHRONO_KEY_HELPER` seam is removed; hermetic tests inject a
  fixture `security` on PATH, and a disposable-keychain integration
  runs where macOS helpers exist.
- **D2 — security-profile revision collision.** `revise` re-INSERTed
  the same `security_profile.id`. Corrected: revisions UPDATE the
  versioned row (stable id, monotonic version, moved hash) inside the
  governing transaction; prior approvals stale deterministically.
- **D3 — superseded artifact consistency.** Retired drafts now record
  a replacement pointer, keep a bannered file over the preserved
  body, and project `lifecycle: superseded`; missing files heal in
  place via identical-content revise; revise-after-supersede denies.
- **D4 — approval retry semantics.** Deterministic and reported:
  host-boundary failures (no session/key, non-Approve answer,
  `--auto`, malformed ticket) never consume the ticket — the same
  ticket is retryable; Core stale/expired/consumed tickets burn and
  need a fresh request; bad signatures leave the ticket live. The
  doctor ceremony section names the failing layer so Gaspar reports
  host vs Core exactly, never blanket Core blame.
- **Fail-open fix — `ask()` is permission, not approval.** The pilot
  recorded `APR-0002` with no human UI because a confirm tool signed
  on execution permission. Corrected: the `chrono_approval_confirm`
  tool is DELETED (unknown `chrono_approval_confirm` is
  deny-by-default); signing lives only in generated plugin bytes and
  fires only on an explicit human Approve observed in a
  runtime-delivered `question` result (exact challenge, approval
  wording, no deny/cancel). Permission `allow`/`always`, wildcards,
  cached grants, auto mode, chat text, and missing/timeout responses
  can never produce a signature.
- **Vulnerable-approval invalidation.** Permission-bound approvals
  recorded without the explicit-answer ceremony marker at the
  current policy (including the pilot's `APR-0002`, identified by
  ceremony/policy provenance, never by hardcoded ID) are
  non-authoritative: every gate, validator, and status projection
  rejects them while audit history stays append-only. Repair is one
  `chrono init --runtime opencode` (code upgrade activates the rule;
  no database surgery, no DRAFT deletion).
- **Availability fix — the question tool must actually render.**
  Investigation against the real OpenCode 1.18.30 runtime proved the
  native `question` tool absent for Gaspar (`opencode debug agent
  gaspar` reports `tools.question: deny`, the secure default) even
  after the fail-open fix — so tickets could still wait for expiry
  with no human boundary able to confirm them, and `TICKET-0004`
  stayed `live:true` / `consumed:false` with no approval recorded.
  Corrected without touching the pilot:
  - `gaspar.md` carries `question: allow` in its agent permission
    policy (verified: the same oracle then reports
    `tools.question: True`), plus native-tool instructions and no
    `--body-file`/token/`chrono run` planning paths.
  - `checkQuestionSurface` probes the exact oracle (`opencode debug
    agent gaspar`, `tools.question === true`) — pure local
    configuration inspection, no sessions/models/spend, overridable
    via `CHRONO_OPENCODE_BIN` for hermetic tests.
  - `chrono approval-request --require-question` refuses tickets the
    human boundary could never confirm (fail-closed with the repair
    spelled out); the native `chrono_approval_request` tool ALWAYS
    passes this gate, so no ticket can issue into a project where the
    confirmation UI cannot render.
  - `chrono doctor` reports the surface in the ceremony section
    (`questionSurface.available/reason`), so Gaspar names the exact
    layer: unavailable surface vs host vs Core.
  - Finalization runs through the `question.asked/replied/rejected`
    event chain (asked records the exact rendered questions keyed by
    `sessionID|requestID`; replied carries the explicit human answer
    and is the single authoritative path; rejected is the explicit
    cancel path); `tool.execute.after` is observation-only, so a
    cross-session or replayed answer can never spend another
    session's ticket (see the exactly-once repair below).
- **Exactly-once repair — the TICKET-0024 provider-backed failure
  (ADR-007 Addendum E1).** The PO explicitly selected `Approve
  approve-TICKET-0024` for `planning-approval OPEN-0001
  @sha256:bdad…25e`, yet the runtime recorded BOTH
  `approval-finalized` (producing APR-0002) AND
  `approval-answer-declined` for the same ticket/question flow,
  ending with TICKET-0024 consumed, OPEN-0001 stale, and no current
  authoritative approval. Root causes, all corrected without
  touching the pilot:
  - Dual finalization paths (`question.replied` AND
    `tool.execute.after` both finalized).
  - A multi-ticket fan-out loop (every `TICKET-dddd` in
    question+answer text finalized; several tickets collapsed onto
    one shared approval id — the APR-0002 reuse; the sequence
    allocator is atomic/monotonic and never collides).
  - A false decline: the after-path answer text included the
    unselected Deny option label, tripping the deny-veto.
  - No durable ceremony deduplication (in-memory only).
  - Corrected authority invariant: one human Approve authorizes at
    most one ceremony claim and at most one approval row. The
    `question.replied` event is the SINGLE authoritative path for
    exactly one bound ticket; `tool.execute.after` is
    observation-only and can never finalize, deny, or consume. The
    Core recomputes the ceremony key (canonical project, session,
    request, ticket, scope, action, revision) and claims it
    atomically with ticket consumption and approval registration
    (all or nothing); redelivery is a durable no-op, a new ceremony
    on a consumed ticket is replay-denied, one question can never
    approve several tickets, and invalid provenance leaves the
    ticket live. New grants carry marker `question-answer-v2`;
    one-observation fan-out grants are non-authoritative.
  - Repair behavior: migration v16 adds the `ceremony_claim`
    ledger and revokes fan-out approval rows append-only (history
    preserved, affected artifacts return to
    stale/awaiting-signature for re-request and re-confirmation);
    `chrono init --runtime opencode` installs the corrected managed
    assets (plugin generator `chrono-gate/oc-p10`); `chrono doctor
    --json` reports per-observation decision, result,
    Core-reported authoritative/current state, rejection reason,
    and duplicate/replay detection without secrets.

### The single repair command for the existing pilot

On the pilot project (data-preserving; DRAFTs untouched):

```sh
chrono init --runtime opencode
```

This regenerates the plugin, agents (native-tool instructions),
native tool module, runtime manifest, permission policy, and managed
assets, then re-proves RTK routing and re-promotes through the
existing OC-P8 machinery. It never deletes or rewrites planning
DRAFTs; drifted managed bytes heal to the pinned versions.

### Evidence (labeled per the taxonomy above)

Hermetic suites: `planning.test.ts` (direct-Core adversarial);
`artifact-cli.test.ts` + `approval-commands.test.ts` (CLI surface);
`planning-tools.test.ts` (generated-byte classification with the
exact two-argument SDK shape, plus the C2 regression);
`native-tools.test.ts` (EXACT generated tool bytes executed for real
against a REAL Core project and the REAL built CLI: registration,
schemas, inline propose/revise, status, tickets, ask()-gated
confirmation, signed approval, cancel/replay/stale/forge/auto/
ticketless/cross-session/cross-project denial, setup repair);
`approval-ceremony.test.ts` (conversational orchestration across
plugin gate, native tools, question audit, Core, and filesystem;
single-path event finalize on explicit Approve with Core-reported
authority; observation-only tool results (no false decline);
rejected/unmatched/cross-session denial; multi-ticket refusal;
restart-replay inertness; artifact scope isolation; malformed-event
survival; key/sanitizer parity; doctor decision/result/authority/
duplicate reporting without secrets);
`approval-commands.test.ts` (question-surface oracle matrix:
exposed/unexposed/missing/non-JSON/failing binary; `--require-
question` refuse/allow; doctor `questionSurface`);
`opencode-agent.test.ts` (`question: allow` present for Gaspar and
no other role);
`approval-tickets.test.ts` (Core ticket adversarial + same-ticket
retry survival + same-ceremony no-op + forged-key/binding denial +
concurrent-claim atomicity + fan-out guard + alias/monotonic-id
proofs); `ceremony.test.ts` (domain key determinism/binding +
multi-grant authority matrix); `migration.test.ts` (v16 ledger on
v1/v15 upgrade paths + fan-out revocation precision +
idempotence);
`key-transport-parity.test.ts` (D1 vectors + disposable-keychain
integration where available);
`planning-blackbox.test.ts` (hermetic discovery-to-grant flow).
Packed: isolated tarball install, `init --dry-run` with zero writes,
ceremony command surface (`--body-stdin`, `--security-implications`,
`--require-question`), dist tool-runtime presence. Full
`test:clean` PASS (49 files / 626 tests on Node 22.21.1 and Node
24.20.0 clean exports — `npm ci`, lint, typecheck, build, suite
each green from clean checkouts), `test:blackbox` 13/13,
package-contents green, `lint` 0 errors,
`git diff --check` clean. Real-runtime evidence: NONE YET — the
retry below must produce it.

### Integrated approval UX (in-OpenCode, no external command)

The PO never leaves OpenCode, copies a CLI command, exports a token,
obtains an internal ID, or runs `chrono run` to approve planning
artifacts. Gaspar uses the NATIVE tools (`.opencode/tools/chrono.ts`);
shell planning instructions were removed from its definition. The
conversational flow is:

1. Gaspar materializes a draft (`chrono_artifact_propose`, inline
   body) and opens a ticket (`chrono_approval_request`), receiving a
   challenge such as `approve-TICKET-0001`. The request refuses
   outright when the native `question` tool is not exposed to
   Gaspar (`chrono doctor` names the surface unavailable) — no
   ticket can wait for a confirmation UI that cannot render.
2. Gaspar asks the PO through the **native `question` tool**, showing
   the exact canonical line, e.g.
   `CHRONO approval approve-TICKET-0001 :: planning-approval REQ-0001
   @sha256:… :: <rationale>`, with Approve / Deny options.
3. The PO answers **in the OpenCode UI**. A chat "approved" alone only
   makes Gaspar start this flow — it never records anything.
4. On an explicit Approve (exact challenge, approval wording, no
   deny/cancel), the plugin host — never the model — re-validates
   ticket liveness, revision currency, and session binding, refuses
   `--auto` mode, reads the OS-keychain PO key host-side, signs, and
   records. There is no approval-confirm tool to call and no
   permission that can substitute: execution permission, cached or
   wildcard allows, and auto behavior can never produce a signature.
   The model sees the Core status update and continues — no restart,
   no shell, no token handling.
5. On Deny, cancel, malformed, or missing answers, nothing changes:
   the model continues from Core status, which still reads
   `awaiting-signature`, and `chrono doctor` names the failing layer.
6. `chrono_artifact_status` proves every state (proposed, awaiting PO
   signature, approved, rejected, stale, superseded) from Core-signed
   rows only.

Key/trust facts for the retry: signatures are Ed25519 under the
enrolled PO key (same cryptography as the classic ceremony);
tickets are single-use and revision-bound (drift burns them);
`--auto` launch refuses deterministically; question traffic is
audited without secrets. Two items stay explicitly
live-acceptance (unverifiable without a paid-model TUI session): the
exact TUI rendering of the question prompt, and mid-session
auto-approve palette toggling (launch-time `--auto` is covered;
never enable auto-approve in approval sessions).

### Pilot retry procedure (governed artifact flow)

STOP before any paid step and request PO authorization (provider
spend, provider login, and any global/runtime change each need
explicit applicable authorization immediately beforehand).

On a disposable project (never the live pilot project until this
gate passes):

1. `chrono init --runtime opencode` to READY (existing machinery;
   repairs/upgrades regenerate plugin, agents, native tools,
   permission policy, manifest, and managed assets).
2. `chrono doctor --json` must report
   `ceremony.questionSurface.available: true`; if unavailable, add
   `question: allow` to the Gaspar agent permission policy and
   re-run init (the refusal message spells this out).
3. Open OpenCode normally (never with `--auto` for approval
   sessions); Gaspar begins discovery from the entry projection.
4. Gaspar materializes each draft with the NATIVE
   `chrono_artifact_propose` tool (inline body; no temp files, no
   shell, no tokens).
5. For each draft: native `chrono_approval_request` (refuses unless
   the question surface is available), then the native `question`
   with the exact challenge line; the PO confirms with an explicit
   Approve in the OpenCode UI and the host records the signed
   approval. Chat acceptance is reported only as "PO stated
   approval in chat" until the Core records the approval.
6. Native `chrono_artifact_status` shows approved for every draft;
   stale drafts require re-request and re-confirmation after revise.
7. Harness, Module/WP plans, module approval (same ceremony), then
   dispatch — exactly the proven black-box order.
8. Observe and record: Gaspar's actual native tool invocations; the
   created `.md` files at Core-derived paths; same artifact+revision
   from a separate process; the native PO interaction rendering;
   the signed Core approval; continuation without shell/token/run
   requests; no product writes pre-dispatch; generic mutation still
   denied; redacted transcript with approval/ticket/grant ids.

## OpenCode pilot entry criteria

The real test may start only when:

1. OC-P1, OC-P2, OC-P8, OC-P9, OC-P10, and OC-P11 are fixed and their adversarial tests pass;
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
