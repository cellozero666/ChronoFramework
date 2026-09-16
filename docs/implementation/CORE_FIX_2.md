# CORE FIX 2 — Authority, State, and Next-Action Convergence

**Status:** BLOCKING

**Purpose:** close the remaining executable lifecycle contradictions found by
an independent audit of the complete current working tree, including
uncommitted changes. This gate supersedes any readiness claim based only on the
green unit suite or on the previous CF-12 remediation.

## 1. Required invariant

For every lifecycle scope, these four results MUST agree at the same persisted
revision and without hidden mutations between observations:

1. current signed authority;
2. persisted lifecycle state;
3. the single action returned by `nextAction`;
4. acceptance of that exact action by the corresponding Core operation.

An operation MUST NOT report success if its authority has become stale or
revoked. `nextAction` MUST NOT advertise an operation that needs an additional
approval, transition, session, binding, or evidence not already represented in
the returned action. A successful terminal transition MUST NOT immediately
produce a validation or deep-check failure.

## 2. CF2-1 — Aggregate completion bypasses Module security acceptance

**Severity:** P0

`ChronoCore.checkAggregateCompletion()` currently permits aggregate Module
completion after all Work Packages are complete without requiring a current
Module-level `implementation-security` approval. However, project validation
requires that approval for a Module in `COMPLETE`.

This permits the contradictory sequence:

`nextAction -> complete-module -> successful transition -> validate/deep-check failure`

The existing lifecycle black-box tests hide the defect by asserting that
`nextAction` returns `complete-module` and then inserting an
`implementation-security` approval before calling the advertised operation.
That is not a valid next-action proof.

### Required correction

- Move the Module-level implementation-security requirement into the shared,
  side-effect-free completion precondition used by aggregate authorization,
  `nextAction`, deep reachability verification, and the real completion
  operation.
- When the approval is missing, `nextAction` MUST return an explicit
  approval/ceremony requirement. It MUST NOT return `complete-module`.
- After the exact current approval is recorded, `nextAction` MUST return
  `complete-module`, and executing it immediately MUST succeed.
- A successful completion MUST be followed by `nextAction=done`,
  `validate.valid=true`, and a deep check with zero blockers and warnings.
- Revoked, stale, wrong-scope, wrong-action, or wrong-revision security
  approvals MUST never satisfy completion.

## 3. CF2-2 — APPROVED activation replay skips authority validation

**Severity:** P0

Both `checkModuleActivation()` and `activateModule()` short-circuit when the
stored Module state is `APPROVED`. They return an acceptable/successful result
without revalidating the current `planning-approval` and `module-approval`.

The persisted state can therefore remain `APPROVED` after authority is revoked
or made stale while activation replay still reports success. A later dispatch
gate may then deny, recreating the same state/authority split-brain that CF-12
was intended to eliminate.

### Required correction

- Idempotent replay means "no duplicate transition", not "skip validation".
- Revalidate both exact-revision approvals before returning success for an
  already-`APPROVED` Module.
- If either approval is absent, revoked, stale, malformed, non-authoritative,
  or bound to another revision, activation MUST deny with the exact missing
  authority.
- `nextAction` and deep-check MUST expose the same hold. They MUST NOT advertise
  WP authorization, dispatch, evidence, review, or completion while the
  Module's required authority is invalid.
- Preserve append-only history. Do not silently demote or rewrite the Module;
  surface the signed decision required to resume.

## 4. CF2-3 — Gaspar cannot reliably execute the new lifecycle

**Severity:** P1

The native tools `chrono_module_activate`, `chrono_wp_authorize`, and
`chrono_next` exist, but the generated Gaspar contract does not explicitly map
the new next-action results to their tools. Its prose still summarizes an older
precedence order. This can leave a correct Core unreachable in the real model
runtime.

### Required correction

- Generate one exhaustive action-to-native-tool mapping for every action that
  `nextAction` can return.
- At minimum, encode the mandatory sequence:

  `activate-module -> chrono_module_activate`

  `authorize-wp -> chrono_wp_authorize`

  `request-dispatch -> chrono_dispatch, then exactly one task delegation`

- Cover claim, confirmation, execution/evidence, scope advancement, release,
  security review, verification, bounded correction, completion, reconciliation,
  approval holds, blockers, await states, and terminal `done`.
- Unknown action values MUST fail loudly instead of being handled with prose or
  guessed commands.
- Gaspar MUST continue autonomously through executable actions. It may stop for
  the PO only when `nextAction` identifies a genuine PO decision or signed
  approval requirement.
- Gaspar MUST never ask the PO to run CHRONO internal commands, copy tokens,
  export variables, or manually create dispatch context.

## 5. CF2-4 — Black-box gate is not reproducible or hermetic

**Severity:** P1

An independent execution of `npm run test:blackbox` on the current working tree
did not pass:

- four test files failed;
- five tests failed;
- ten tests were skipped after fixture initialization failures;
- some pack operations used the developer's global npm cache and failed with
  `EPERM`;
- the OpenCode plugin black-box required GitHub network access for the pinned
  skill and therefore was not hermetic;
- with a disposable npm cache, the isolated lifecycle black-box remained stuck
  during setup and had to be interrupted.

### Required correction

- Every black-box fixture MUST use its own disposable npm cache, HOME-like test
  state, keychain fixture, temporary install prefix, and project directory.
- Default black-box tests MUST not depend on the developer's global npm cache,
  credentials, keychain, package links, or existing installation.
- Split network-required verification into an explicit host/integration gate.
  The default lifecycle black-box MUST consume a pinned local fixture or
  previously materialized verified asset without weakening production checks.
- Every external process MUST have a bounded timeout and produce a useful
  failure naming the phase that stalled.
- A fixture setup failure MUST fail the owning setup once; dependent tests must
  not produce cascaded misleading failures or skipped-success claims.
- `test:blackbox` MUST exit zero with the exact expected file/test count and
  zero failed, skipped, todo, unhandled, timed-out, or crashed tests on clean
  Node 22 and Node 24 environments.

## 6. Mandatory regressions

Add tests that fail on the current implementation before the correction:

1. Module is `APPROVED`; revoke its module approval; activation replay denies,
   `nextAction` requests authority, deep-check identifies the contradiction,
   and dispatch is unreachable.
2. Repeat for stale approval after a material revision change.
3. All WPs are `COMPLETE`, but Module implementation-security approval is
   absent: `nextAction` does not return completion and the operation denies
   without changing state.
4. Record the exact current security approval: without any intervening hidden
   mutation, the advertised completion action succeeds and the terminal state
   validates cleanly.
5. Revoke or stale that security approval immediately before completion: both
   dry-run and operation deny identically.
6. Exercise the generated Gaspar action map against every `NextAction.action`
   union member. Missing mappings fail the build/test.
7. Run the migrated CF-12 fixture and the full greenfield vertical through the
   packed CLI without direct Core helpers inserting state between an advertised
   action and its execution.
8. Restart at activation, authorization, dispatch claim, review, correction,
   security approval, and completion boundaries; the same next action must be
   reproduced from SQLite.

## 7. Full code audit required before retry

Do not limit the correction to the two known branches. Audit every stateful
operation for the same defect class:

- Spec approval and `READY`;
- Architecture approval and architecture state;
- Module planning approval, module approval, and activation;
- WP authorization and dependency state;
- security review, implementation-security acceptance, and waivers;
- dispatch request, delegation, atomic claim, confirmation, release, expiry,
  and revocation;
- evidence currency and revision binding;
- Glenn and Spekkio independence;
- defect, bounded correction, re-verification, and completion;
- terminal replay and validation.

For each operation, prove that the shared precondition source drives the real
operation, `nextAction`, and deep reachability verification. Remove any test
that performs an undocumented state or approval mutation between reading the
next action and executing it.

## 8. Exit criteria

This gate remains `BLOCKING` until all of the following are true:

1. CF2-1 through CF2-4 are corrected in production code.
2. All mandatory regressions pass and demonstrably fail against the previous
   implementation.
3. No successful transition can immediately make `validate` or deep-check fail.
4. No `nextAction` result requires an unreported intermediate mutation.
5. Authority revocation/staleness invalidates every downstream operation at the
   same observation boundary.
6. Gaspar has a complete, tested action-to-tool mapping and never delegates an
   internal terminal step to the PO.
7. Unit, integration, migration, package-content, host-isolated, and black-box
   gates pass on clean Node 22 and Node 24 environments with zero skips/todos.
8. Packed tarballs contain production files only and the vertical flow uses the
   packed CLI in separate processes.
9. No real paid model is launched and no real pilot project is modified during
   remediation.
10. The final report lists exact files, schema changes, test counts, previous
    negative controls, clean-environment versions, and any remaining real
    runtime requirement.

Only after an independent review of this gate may the Product Owner authorize
one new end-to-end OpenCode pilot.

## 9. Remediation tranche (pilot TOOL_DENIED + architectural follow-ups)

**Status:** implemented, awaiting independent review (gate stays `BLOCKING`).

### 9.1 Verified root causes (pilot evidence + code execution, not inference)

1. **Missing native surface (immediate blocker):** architecture
   submit/approve, spec submit/ready/needs-revision, and harness
   record had Core operations and guards but no CLI command and no
   native tool, so no native workflow could move specs to READY.
   Proven by enumerating all 60+ CLI commands and by a full-runway
   test that previously had no native path to follow.
2. **Unclassified runway tools (pilot `TOOL_DENIED`):** the generated
   plugin gate keeps its own `LIFECYCLE_TOOLS`/`PLANNING_TOOLS`
   lists; the six runway tools were absent, so Gaspar sessions
   calling them hit `kind === "unknown"` → deny-by-default. The
   denial strings additionally hardcoded `tool policy v6` (and
   `plugin-load` reported `v4`) while `TOOL_POLICY_VERSION` is `7`
   (now `8`).
3. **Stale loaded runtime invisible:** `chrono init` repairs files on
   disk while a live OpenCode process keeps running old bytes, and
   no check compared the loaded generation against the installed
   one — readiness could be reported from repaired files alone.
4. **Next-action began too late:** `chrono_next` reported generic
   `await-approval` while the real missing work was an architecture
   submission, approval, spec submission, Harness, or READY
   transition. Gaspar prompts carried a competing ordered runway
   instead of deferring to the Core.

### 9.2 Exact corrections

- `packages/cli/src/readiness-cli.ts` (new): six governed CLI
  commands over the existing Core ops/guards (no new Core logic).
- `packages/cli/src/opencode-planning-tools.ts`: six native tools
  (surface is now 38).
- `packages/domain/src/capabilities.ts`: canonical
  `OPENCODE_TOOL_POLICY` classifies the six runway tools as
  `lifecycle`; `TOOL_POLICY_VERSION` bumped `7` → `8`; new
  deterministic `buildRuntimeFingerprint()` over the policy, tool
  list, and skill pin.
- `packages/cli/src/opencode-plugin.ts`: gate sets
  (`PLANNING_TOOLS`, `LIFECYCLE_TOOLS`, plus read/mutate via the
  pre-existing pattern) are DERIVED from the canonical policy at
  generation time — no hardcoded copy remains; denial strings and
  plugin-load evidence interpolate `TOOL_POLICY_VERSION`;
  plugin-load rows now carry CHRONO version, build fingerprint, and
  per-load process identifier.
- `packages/cli/src/init-flow.ts`: `readActivationEvidence` parses
  the latest plugin load; `pluginLoadStatus` compares it against
  the running expectations; `runDoctor` pushes
  `RUNTIME_RESTART_REQUIRED` (exit 1) on mismatch, clears
  automatically on a fresh matching load; unknown (no generation
  claim) stays neutral so init works without OpenCode ever running.
- `packages/core/src/chrono-core.ts`: shared pure checks
  (`checkArchitectureSubmit/Approve`, `checkHarnessRecord`;
  spec events dry-run through the exact
  mayEnact/validateTransition/guard sequence); `nextAction`
  resolves the planning runway first (architecture → specs →
  Harness → READY → activation → …); new actions
  `submit-architecture`, `approve-architecture`,
  `request-approval`, `submit-spec`, `record-harness`, `ready-spec`
  (all in `NEXT_ACTIONS`, all dry-runnable, all verified by
  `verifyReportedAction`); obsolete `missing-transition-surface`
  check retired (every scope is now actionable).
- `packages/cli/src/opencode-agent.ts`: six map routes (single
  source of truth remains the Core union); planning-runway prose
  rewritten to defer ordering to `chrono_next`; ceremony
  verification loop and one-ticket rule kept (ceremony guidance,
  not workflow).
- Normative sync: `CORE-SPECIFICATION.md` §16 (`next_action`
  runway), `RUNTIME-CONTRACT.md` §3.1 (six commands) + §11
  (generation handshake), `FIRST-RUN.md` + `OPENCODE-PILOT-GATE.md`
  (restart requirement).

### 9.3 Canonical policy architecture

One effective source of truth: `OPENCODE_TOOL_POLICY` in
`packages/domain/src/capabilities.ts`. The generated plugin
derives all four gate sets from it at generation time; the
`policy-surface-parity` regression parses the emitted sets and
compares them exactly (either direction of drift fails), and
`CHRONO_NATIVE_TOOLS` must equal the policy's `chrono_*` entries
exactly (a tool added to either surface without the other fails).

### 9.4 Runtime generation handshake

`buildRuntimeFingerprint()` (domain, deterministic) over tool
policy version + sorted classified tools + skill pin. Embedded in
generated plugin bytes at generation; emitted on every plugin load
with versions and load id; `doctor` compares the latest load
against running expectations. Generations are distinguishable
without timestamps or operator memory.

### 9.5 Complete Core next-action runway

Order: architecture submission → architecture approval (or
`request-approval` ceremony naming `architecture-security`) →
per-spec planning ceremony (`request-approval` naming
`planning-approval`) → spec submission → spec `architecture-security`
ceremony → Harness recording → spec READY → module activation → WP
authorization → dispatch → (existing chain). Executable steps
surface only when their shared dry-run holds for the caller;
ceremony needs surface as informative `request-approval` with
approval action, scope, and revision.

### 9.6 Tests and evidence

- `policy-surface-parity.test.ts` (new, 4 tests): canonical
  coverage both directions, generated-set equality, version stamp,
  hook passage for the six runway tools + unknown denial.
- `doctor-runtime.test.ts` (new, 6 tests): handshake matrix
  (current/stale/unknown), evidence parsing, last-wins.
- `planning-runway.test.ts` (new, 1 vertical): approved planning
  artifacts → DRAFT arch/spec states → only Core-returned actions
  → architecture approved → Harness recorded → spec READY →
  module activated → WP authorized → `request-dispatch`
  available; every observation in `NEXT_ACTIONS` and
  independently verified.
- `readiness-cli.test.ts` (+1 wiring test), `planning-tools.test.ts`
  (+runway bash/gate/version tests), `skill-verify`, `gaspar map`
  extended.
- Restart black-box in `opencode-plugin-blackbox.test.ts`:
  files-A/load-A → upgrade files to B → doctor blocks
  `RUNTIME_RESTART_REQUIRED` → fresh B load → doctor ready, all
  through the packed binary in fresh processes.
- Negative controls: new suites fail against the pre-fix tree
  (worktree control); pre-existing suites green on Node 22.21.1
  and 24.20.0.

### 9.7 Remaining blockers (no code changes accepted here)

- Independent review of this tranche (this gate).
- Pilot redeploy (pack/install current tree into the pilot prefix +
  `init` repair + full OpenCode termination and fresh process);
  no pilot state was touched during remediation.
- One live end-to-end OpenCode pilot thereafter (real model,
  any tier — tier is irrelevant to the ceremony mechanics).
