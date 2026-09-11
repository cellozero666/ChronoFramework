# Slice 10 — Bug Verification Pass

**Scope:** implementation bugs, inconsistencies, and execution failures
found by adversarial review during Slice 10 implementation
(`chrono init` orchestration, launcher contract, broker/entry,
doctor/uninstall, runtime assets), with fixes and evidence.
**Status note:** this file records the implementer's own verification
pass. It does not mark Slice 10 `COMPLETE`; exit criteria 4 and 9
remain open on real-runtime acceptance (see §4).

**Method:** line-by-line review of the Slice 10 diff against
`SLICE-10.md` §§1–11 and the normative chain; hermetic reproduction of
every suspected defect before fixing; full suite (`30 files / 297
tests`), lint, typecheck, build, and `git diff --check` after each fix;
clean-export matrix on Node 22.21.1, 24.4.1, and 24.20.0 (×5
consecutive); packed-tarball install with global-CLI, `npx`-form, and
live-gate hook verification.

## 1. Execution failures found and fixed

### F1. Read-only open broke authorizing gates (execution failure)
`runGate` was converted to the read-only project open along with pure
reads. Gates authorize: `authorizeExecution` mints dispatch grants and
every verdict appends an audit event, so SQLite refused the write and
all gate decisions failed closed with `VALIDATION_ERROR` (8 gate tests
failed). Fix: `runGate` opens read-write with the pinned version;
only side-effect-free commands (`status`, `validate`, `gate` is
excluded, attestation status, adapter list, doctor) use
`openReadProject`. Lesson encoded: authorizing reads are writes.

### F2. Pinned-version check ran before repository assignment (crash)
`enforcePinnedVersion` touched `this.events` before the constructor
assigned it — every pinned open would have thrown `TypeError` instead
of enforcing. Found by inspection before any test ran. Fix: assign the
event repository first inside the guarded block.

### F3. Setup machine allowed skip-ahead (gate bypass)
`isLegalSetupAdvance` accepted any forward jump, so `DETECTED → READY`
marked setup complete without performing a step. Caught by its own
test. Fix: same-step (idempotent retry) or exactly-next-step only;
skip-ahead returns `ILLEGAL_TRANSITION`.

### F4. Stale tests masked the F3 defect class (test bug)
The pinned-version test expected `status()` to succeed without a
project. Fixed to `init()` first — a test must not assert success
where the Core must deny.

### F5. Verify/prove binary-path mismatch denied every proof (production path)
`runRtkVerify` recorded the unresolved name (`rtk`) while `runRtkProve`
recorded the resolved absolute path, so the Core's version/binary
binding denied every routing proof with `RTK_ROUTING_FAILURE`. This
defect lived in the Slice 9 granular commands and only surfaced when
the init flow composed them end to end. Fix: both commands resolve to
an absolute path through an injectable resolver before executing or
recording; existing tests pin a fixture resolver so they stay
hermetic and host-independent.

### F6. Proof-submitter binding broke setup bootstrap (reverted with rationale)
A strict "submitter session must belong to an approved adapter" rule
denied the legitimate setup flow: proofs are submitted before any
adapter is approved. Deeper analysis showed the check is security
theater — adapter labels are self-asserted at `openSession`, so a
label check cannot bear weight, while revoked adapters are already
neutralized by the Slice 9 session-revocation cascade. Reverted;
documented in code. The enforced boundary remains: valid session +
approved proof target at submission, full re-validation at dispatch.

### F7. Proof target required a registered adapter (ordering conflict)
`recordRoutingProof` resolved the adapter row, but setup proves routing
*before* the PO's adapter-approval decision (normative step order:
RTK before adapters). Fix: record time validates id shape only, so
evidence precedes approval — the approver reviews evidence, not
promises. Dispatch-time checks (registered, active, entrypoint,
attestation, binary hash, expiry) are unchanged and re-validated per
dispatch; proofs for unknown, pending, or revoked adapters can never
authorize execution.

### F8. Template-escaping slip emitted unparseable plugin bytes
A literal newline inside a double-quoted string of the generated
OpenCode plugin made every plugin test fail at import. Fix plus a
permanent guard: all three generated JS assets pass `node --check`
in-suite.

### F9. Session `touch()` write broke read-only opens
`validateSessionToken` updates `last_seen` on every validation, so any
authenticated operation (e.g. doctor with a session) failed on
read-only handles. Fix: skip the observability write when opened
read-only; authorization checks are unchanged.

### F10. Duplicated skill fixture drifted (hash mismatch)
A third copy of the canonical skill fixture silently diverged from the
pinned hash. Fix: single shared `test-skill-fixture.ts` with a
hash assertion on import.

### F11. Claude-settings merge could duplicate entries
A managed command nested inside an unparseable group escaped the
duplicate scan and would have been appended twice. Fix: recursive
command scan; dead structural walk removed; nested-duplicate test added.

### F12. Core-minted `RTE`/`SES`/`BRK` ids outside the validated families
`parseArtifactId` rejected what the Core itself mints (latent: those
rows live outside the artifact table). Fix: families, pattern, identity
tests, and the CORE §3.1 table extended under the documented GRANT
precedent.

### F13. Secret scanner blocked legitimate metadata
The setup-detail scanner rejected the `keychain` consent-scope key.
Fix: `keychain` is legitimate metadata; the scanner now also inspects
string *values* for key material patterns (PEM blocks, live secret
prefixes) at any depth.

### F14. Flow sessions shared one adapter label and runtime
Setup sessions bound to `init-flow` landed proofs in scopes dispatch
would never look up, and multi-runtime matching was undeclared. Fix:
per-adapter sessions bound to each adapter's own id/runtime string;
single-runtime projects pin `project.runtime` at creation,
multi-runtime projects keep it unset (strict matching where possible,
documented convention elsewhere).

### F15. Broker account file lacked the credential id
`chrono entry` needs `--broker`, but hooks only knew the keychain
account. Fix: `.chrono/broker-account` carries account + credential id
(both non-secret); the session script reads line 1, passes line 2 as
`--broker`.

### F16. Single-row setup state overwrites step detail
`setup_state` keeps only the latest step, so the broker id vanished
from the readable projection after `READY`. Fix: the id persists in
`.chrono/broker-account` and in the `SetupAdvanced` audit payload
(detail is now included; it was already secret-scanned).

### F17. Toolchain and hygiene findings
Unused imports, an unused catch binding, a duplicated method from an
anchor edit, a duplicated comment header, and `constructionFailure`
flattening every fault to `CORE_INIT_FAILURE` (now preserves
deterministic Core codes). The `rtk`-prefixed shell invocations used
during verification were found to garble subcommand output and were
removed from all procedures.

## 2. State-machine and contract corrections
- `runGate` documented as read-write-by-necessity (F1).
- New `UPGRADE_REQUIRED` code (INV §14.4 table synced) for legacy
  databases on read-only opens; one audited upgrade touch, then
  read-only resumes. CLI read commands fail closed with
  `ENTITY_NOT_FOUND` instead of materializing empty stores.
- `mergeClaudeHookGroup` generalized for `SessionStart`; backups
  preserve the pre-CHRONO original exactly once.
- `runSetup` installs runtime-scoped entry assets only for declared
  known runtimes; unknown adapter ids keep shared assets (never guessed).

## 3. Evidence after fixes
- `npm run test:clean`: PASS — 30 files / 297 tests, exit 0, zero
  failed/skipped/todo, zero unhandled errors, zero worker crashes
  (working tree and clean exports).
- Clean-export matrix: Node 22.21.1 (ABI 127), 24.4.1 and 24.20.0
  (ABI 137, 5 consecutive on 24.20.0) — `npm ci`, `test:clean`,
  `lint`, `typecheck`, `build` all exit 0; `git diff --check` clean.
- Packed tarballs (0 test files): isolated install; global `chrono`
  and `npx --prefix` bootstrap locate the pinned Core across separate
  processes (`--version`/`init`/`status`/`validate`/`doctor`);
  non-interactive init stops at `CONSENT_REQUIRED`, `--yes` flows stop
  at `APPROVAL_REQUIRED` for PO steps with resume hints, never hanging.
- Live-gate hook evidence re-proven on the final build for OpenCode,
  Claude Code, and Kiro scripts (deny 2 without context, allow 0 for
  reads, live `DENIED` on forged tokens, unknown-tool denial).
- Sweeps: no secrets, no hardcoded providers/models, no stubs,
  no `.skip`/`.todo`/`.only`, no lifecycle npm hooks; Markdown links
  validated.

## 4. Explicitly open (not defects, not claimed)
1. Real-runtime automatic entry (OpenCode/Claude/Kiro live sessions,
   paid model execution, provider login) — hermetic assets and
   enforcement tests pass; live acceptance awaits PO authorization.
   Exit criteria 4 and 9 stay open.
2. Kiro binary absent on this host — Kiro conformance unproven beyond
   hook logic; exit criterion 4 stays open on this leg.
3. `rtk gain` as the proof command proves binary identity, not
   adapter-interception routing — Slice 9 residual, unchanged; the
   proof format already binds arbitrary commands for a tighter future
   command.
4. Kiro SessionStart stdout injection is undocumented upstream — the
   hook warms an authenticated session and degrades loudly; context
   injection there is not claimed.
5. Windows paths and line endings exercised by contract only (darwin
   host); `experimental.chat.system.transform` follows a documented
   but experimental OpenCode namespace.
6. Gain-dashboard statistics persist in RTK attestations as savings
   evidence — tool-generated counters, accepted residual.
