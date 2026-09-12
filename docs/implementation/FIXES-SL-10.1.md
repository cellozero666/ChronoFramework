# Slices 9–10 — Corrective Gate Before Real-Runtime Acceptance

**Status:** BLOCKING — coding and contract corrections required before real-runtime acceptance
**Baseline reviewed:** commit `593a2b6` on `main`, clean working tree before this documentation update
**Independent verification:** Node.js 24.20.0; clean archive; `npm ci`, `npm run test:clean`, `npm run lint`, `npm run typecheck`, and `npm run build` all passed; 30 test files and 300 tests passed with zero skipped, todo, worker-crash, or unhandled-error results.
**Non-authorization:** This document does not authorize paid model use, runtime installation, global configuration changes, publication, push, tags, releases, or risk acceptance.

## Purpose

Close the remaining differences between the implemented behavior and the
normative Slice 9/10 contracts before spending time or provider credits on
real-runtime acceptance. Passing hermetic tests proves the implementation
baseline; it does not substitute for effective routing or native runtime
behavior.

## Required coding corrections

### C1 — Fail closed when Gaspar entry context cannot be projected

`ChronoCore.buildGasparEntryProjection()` currently ignores failures from
`artifacts.listByType("MOD")` and returns a partial projection. Module approvals
are mandatory PO decisions, so missing them can cause Gaspar to present an
incomplete next action.

Required behavior:

- propagate a stable Core error or return a `BLOCKED` projection containing an
  explicit projection-failure predicate;
- never present partial artifact/approval context as ready;
- preserve secret-safe human and JSON output;
- add adversarial tests for repository read failure, malformed module data, and
  successful recovery after repair.

### C2 — Prove effective RTK interception/routing

The default proof based on `rtk gain` proves the genuine RTK binary and its
dashboard, but not the Slice 9 §9.3 requirement that a runtime command was
actually routed or rewritten. Replace or extend the production proof flow so
that it captures, validates, and binds:

- the pre-routing command/input;
- the effective RTK-routed or rewritten command;
- runtime, adapter, session, project, RTK identity/version, timestamp, and TTL;
- preserved exit status and redacted evidence hashes;
- invalidation after binary, adapter, configuration, or managed-asset drift.

The proof must use a documented, supported RTK integration path. A Boolean test
flag, fixture-only route, `rtk --version`, or `rtk gain` alone cannot authorize
dispatch. Add positive and negative tests and demonstrate that dispatch denies
identity-only, stale, forged, cross-runtime, cross-adapter, and drifted proofs.

### C3 — Align proof recording with adapter authority

Slice 9 §9.3 says only an approved adapter session may submit an authoritative
routing proof. The current bootstrap records a proof before adapter approval
and relies on dispatch-time adapter validation. Preserve the safe setup order
without silently weakening the contract by implementing one of these explicit
semantics:

1. record the pre-approval result as a non-authoritative `CANDIDATE` and promote
   or re-prove it only after signed adapter approval; or
2. reorder the ceremony so approval precedes authoritative proof while keeping
   every intermediate state fail closed.

Update the Core specification, runtime contract, schema/migrations, CLI help,
audit events, and tests consistently. No self-asserted adapter label may mint
authority.

### C4 — Make Kiro automatic entry truthful and testable

The generated Kiro hook currently proves hook logic and session warming, but
the documented runtime mechanism has not established that Gaspar context is
injected before the first model response. Implement a supported Kiro-native
entry mechanism if the real runtime test shows the current hook insufficient.
Fail loudly when automatic Gaspar activation cannot be guaranteed; do not
degrade to an ungoverned default agent.

Add a version/capability check so unsupported Kiro behavior is reported as an
environment blocker rather than readiness. Hermetic tests may validate the
adapter contract, but only a real Kiro execution can close this item.

## Documentation corrections required with the code

- Keep `SLICE-9.md` and `SLICE-10.md` as `IMPLEMENTED — NOT COMPLETE` until all
  mandatory exit criteria are evidenced.
- Describe `rtk gain` only as binary/dashboard verification, never as effective
  routing proof.
- Record the selected C3 authority semantics as a normative decision, not only
  an implementation rationale.
- Document exact supported runtime versions/capabilities discovered during the
  real-runtime matrix.
- Do not change this file to `COMPLETE` merely because unit tests pass.

## Correction verification gate

Before starting paid/provider-backed acceptance, the implementer must provide:

1. focused adversarial tests for C1–C4;
2. the full clean-export Node LTS matrix;
3. clean test, lint, typecheck, build, and `git diff --check` results;
4. packed tarball/global CLI verification without workspace links;
5. a real RTK routing trace using the production adapter path, with secrets and
   sensitive command content redacted;
6. an exact file/change inventory and an explicit
   `READY_FOR_REAL_RUNTIME_ACCEPTANCE` or `BLOCKED` recommendation.

## Real-runtime acceptance after the correction gate

For each of OpenCode, Claude Code, and Kiro, use a disposable project and the
packed release-shaped package:

1. install the package in an isolated location;
2. run only `chrono init` for the normal CHRONO setup path;
3. approve the displayed project/keychain/runtime changes interactively;
4. close and reopen the runtime normally in the configured project;
5. verify Gaspar is active before the first response, identifies the human as
   PO, activates the pinned process skill, and resumes from persisted Core
   state;
6. exercise one read operation and one harmless mutable operation, proving the
   native hook reaches the live Core gate and the mutable path has current RTK
   routing evidence;
7. restart and confirm session renewal without exposing credentials;
8. test hook drift, expired/revoked broker credentials, unavailable Core, and
   unsupported runtime version; all must fail closed;
9. save redacted transcripts, runtime/CLI versions, exit codes, hashes, audit
   references, and observed costs as acceptance evidence.

Real-runtime execution may begin only after C1–C4 are resolved or explicitly
shown not to require code by evidence from the installed runtime. Installing a
missing runtime, changing global configuration, logging into a provider, or
incurring model cost requires the applicable PO authorization.

## Correction evidence (implementation session 2026-09-11, uncommitted on `main`)

Working tree: 25 modified files + 4 new files (see inventory below).
Batteries: `test:clean` PASS (32 files / 364 tests, zero skipped/todo/crashes),
`lint` / `typecheck` / `build` / `git diff --check` clean; clean-export matrix
Node 22.21.1 + 24.20.0 (fresh `npm ci`, full battery each) green; packed
tarballs (0 `*.test.*` files) installed isolated without workspace links with
CLI smoke green. `SLICE-9.md` / `SLICE-10.md` remain `IMPLEMENTED — NOT
COMPLETE`; this document remains `BLOCKING`.

### C1 — entry projection fails closed (re-audited, hardened)

Re-audit found three fail-open gaps beyond the original `listByType` fix and
closed them in `ChronoCore.buildGasparEntryProjection()`; every failure uses
the stable `PROJECTION_FAILED` code with secret-safe messages:

| Gap found | Fix |
|---|---|
| Approval-gated module states (`APPROVED`/`EXECUTING`/`VERIFYING`/`PASSED`/`FAILED`/`COMPLETE`) never cross-checked their mandatory `module-approval` binding | `hasValidApproval` per gated module; repository failure and absent/revoked/stale bindings deny (`BLOCKED` excluded: reachable pre-approval) |
| `projectProjectState` tolerates unknown states by fall-through, so malformed WP/SP/blocker/architecture rows silently skewed lifecycle | `isValidState` per WP/SP row, blocker id + `assertBlockerType` per row, architecture-state allowlist |
| Stored project state vs computed projection divergence unchecked (tampering invisible) | mismatch denies (all 19 mutation paths sync, so divergence proves external tampering) |

Review discoveries (schema is stricter than assumed): approval rows cannot be
deleted ("revoke instead") and revocation is terminal (no un-revoke, unique
slot held) — recovery is revise + fresh PO approval, covered by test.

Tests (`setup-entry.test.ts` "Fail-closed entry context": 9; `entry-ops.test.ts`: 1):
unreadable approval/blocker registries; revoked binding + revise/re-approve
recovery; revision-outruns-approval + revert recovery; malformed blocker/WP/SP
+ delete recovery; lifecycle divergence + repair; tampered architecture state +
repair; message/JSON secrecy (no broker secret, no session token); CLI human +
JSON surfaces identify `PROJECTION_FAILED` with no session minted.

### C2 — effective routing (implemented, traced on production path)

`chrono rtk prove` maps the raw pre-routing command via `rtk rewrite`,
executes only mappings resolving to the genuine attested binary, and records
exit status plus pre/routed/output hashes with a bounded TTL and an 8 MiB
provability cap. Identity-only heads, rewrite refusals, mapping escapes,
non-zero exits, oversized outputs, and bare-binary mappings record nothing.
`rtk gain` is binary/dashboard verification only (spec, contract, invariants,
protocols, schema description, and CLI help updated consistently).

Production-path trace (`docs/implementation/RTK-TRACE-0.44.0.md`, genuine RTK
0.44.0, packed CLI, disposable project, no paid/provider/install actions):
`verify` → attestation; `skill verify` (live pinned fetch) → `setup` →
`prove(ls)` → candidate `RTE-0001` → `promote` → authoritative → dispatch
authorized with grant burn (`GRANT-0001`, ExecutionStarted); unproven adapter
denies `RTK_ROUTING_FAILURE`; `prove(gain)` and `prove(rtk …)` deny.
Findings: 0.44.0 `rewrite` exits **3** with a mapping / 1 empty (help claims
0 — implementation is exit-agnostic, documented in code); trace-exposed bug
fixed: `rtk verify` program action dropped `--json` (program-level regression
test added).

Tests: `rtk-cli.test.ts` (13: classifier, already-routed/identity/refusal/
escape/exec-fail/oversize/bare-binary denials, candidate record, PO-only +
pre-approval promote denial, promote + idempotency, input validation,
`--json` wiring); `authorization.test.ts` "Routing proof authority" (11:
candidate-deny, PO-only, idempotent promote, superseded attestation, binary
replaced pre/post promotion, expiry, asset drift, re-registration drift,
cross-runtime pin barrier + cross-adapter lookup deny).

### C3 — candidate/promote authority (normative: ADR-006)

Recorded proofs are non-authoritative `CANDIDATE`; `chrono rtk promote`
(PO-only) re-validates attestation/binary/approval/manifest, snapshots
registration + asset hashes, and is idempotent; dispatch consumes only the
latest unexpired `AUTHORITATIVE` proof per scope with full per-use
re-validation. Migration v13 preserves evidence and defaults unsafely-old
rows to candidate: proven from **both** affected baselines —
`authorization.test.ts` "Routing proof migration" (3 tests × v11/v12):
vintage rows survive with evidence intact + `authority=candidate` +
null hashes + empty pre-routing; `latestAuthoritative` is null;
dispatch denies naming the candidate; promotion after signed approval
succeeds and dispatch authorizes. Older rows cannot become authoritative
except through promotion (repository `promote` guards
`authority='candidate'`; dispatch reads `latestAuthoritative` only).

Review notes (accepted residual): `commandHash`/`outputHash` are
format-validated, not equality-reverified (evidence bindings; authority
derives from promotion + dispatch re-validation of live bindings, and
submitters are authenticated sessions); `gainAvailable` is caller-asserted
(the CLI asserts it only after a live `gain` check).

### C4 — Kiro truthful and testable (hermetic grade; real runtime open)

Vendor contract grounded in kiro.dev/docs (hooks, types, actions, skills,
built-in-tools; fetched 2026-09-11): `.kiro/hooks/*.json` v1 auto-activates;
`SessionStart` is IDE-only, `AgentSpawn` CLI-only, `PreToolUse` blocks on
both; shell exit 0 injects stdout, nonzero sends the stderr warning;
JSON hooks require CLI 3.0+; workspace skills (`.kiro/skills/<name>/SKILL.md`)
load on IDE/CLI/Web.

Shipped: dual-surface entry registration (`SessionStart` + `AgentSpawn`,
single file; cross-surface unknown-trigger handling is an explicit
acceptance check); Kiro CLI ≥ 3.0 floor with fail-closed version parsing;
`VERIFIED_KIRO_VERSIONS` (empty until real acceptance evidences exact
versions); `evaluateKiroSupport` gating `detectInit` conflicts (init stops
loud: absent/unparseable/<3.0/unverified); doctor Kiro environment blocker
for any Kiro adapter; entry script fail-loud (exit 3, no ungoverned
fallback; exit 0 only with nothing to govern); entry output carries the
skill activation payload (pin/hashes/state; activation itself is
acceptance-observed); tool policy regrounded in documented CLI tool names
(undocumented `ls`/`todowrite` removed from read; wrong `webfetch`/
`websearch` denied; effectful `aws`/`delegate`/`subagent`/`goal`/
`knowledge`/`session` gated); Kiro workspace skill format validated
(name/description/license); secrets discipline unchanged (stdin pipe,
0600 token file, stderr-only path) with script-shape tests.

Tests (`kiro-capability.test.ts`: 16; `entry-ops.test.ts` "Kiro entry": 3):
version table, support-decision table (incl. synthetic verified-accept),
registration structure, gate-script behavior for real (documented
read/mutate/unknown names, live AUTHORIZED/DENIED verdicts), entry-script
shape, skill frontmatter, init blocking for 3.x-unverified and 2.x,
setup emission of the dual-surface registration, doctor blocker + drift,
Kiro entry denial (unregistered → not found; approved-unproven →
`RTK_ROUTING_FAILURE`, no token file).

Hermetic vs real, stated plainly: no Kiro binary exists on this host
(`kiro`/`kiro-cli` absent); nothing above claims Kiro conformance. Still
requiring genuine Kiro execution: entry-before-first-response on IDE and
CLI surfaces, PreToolUse blocking observed live, unknown-trigger handling
per surface, skill auto-activation observed, exact supported CLI/IDE
versions recorded into `VERIFIED_KIRO_VERSIONS`.

## Still requiring real execution or PO authorization (gate items 5–6)

- Real-runtime acceptance per runtime (OpenCode 1.18.30 and Claude Code
  2.1.206 binaries present on host, versions only — no model executed;
  Kiro absent): disposable project, packed CLI, `init`, interactive
  approvals, close/reopen, Gaspar-before-first-response, skill active,
  read + harmless-mutable operations, restart/renewal, drift/expiry/
  revocation/unavailable-Core/unsupported-version behavior, redacted
  transcripts + versions + costs.
- Paid model use, provider login, runtime installation, global
  configuration changes, publication, push, tags, releases: each needs
  its applicable PO authorization (none granted in this session).
- C4 exit additionally needs either genuine-Kiro pass or a PO-approved
  scope change removing Kiro from mandatory v1 support.

**Recommendation: `BLOCKED`** — C1–C3 implemented, traced (RTK), and
independently reviewed; C4 hermetic-complete with the real-runtime half
open; Slices 9/10 stay `IMPLEMENTED — NOT COMPLETE`; no Phase 6.

## Exit criteria

This corrective gate is complete only when:

- C1–C3 are implemented and independently verified;
- C4 passes in a genuine supported Kiro runtime, including pre-first-response
  Gaspar activation, or a PO-approved scope change removes Kiro from mandatory
  v1 support without creating unsupported claims;
- OpenCode and Claude Code pass the same real-runtime path;
- Slice 9 effective-routing and three-runtime criteria pass;
- Slice 10 automatic-entry and three-runtime packed acceptance criteria pass;
- documentation and user-facing claims match the evidence exactly.

After completion, an independent reviewer may mark Slices 9 and 10 `COMPLETE`
and authorize progression to Phase 6. Publication remains a separate PO action.
