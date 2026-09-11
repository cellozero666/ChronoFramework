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
