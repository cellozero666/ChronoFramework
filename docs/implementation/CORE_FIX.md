# CHRONO Core End-to-End Remediation Gate

**Status:** BLOCKING — reopened 2026-09-15 by provider-backed reachability failure (CF-12)
**Scope:** CHRONO v1 OpenCode vertical workflow
**Purpose:** End the test/fix loop by requiring one complete, restart-safe lifecycle before another provider-backed pilot.

**Verification record:** every §8 exit criterion is proven by the
evidence in §8a below. Returned
`READY_FOR_SINGLE_END_TO_END_OPENCODE_PILOT` per §9. This closes the
remediation gate only; final v1 completion, real-runtime Claude/Kiro
evidence, publication, and release remain PO decisions
(`IMPLEMENTER-TASKS.md` Task 7).

## 1. Executive finding

CHRONO does not currently fail because of one isolated OpenCode hook defect. It
fails because independently implemented entry points are not yet connected into
one executable lifecycle.

The real pilot has already proven these individual capabilities:

- packed installation and resumable `chrono init`;
- project isolation and deterministic managed assets;
- Gaspar selection and projection injection;
- governed planning-file creation;
- explicit native PO approval with current Core authority;
- deny-by-default mutation before dispatch.

The current patch adds native dispatch request, `task` delegation, and worker
claim. That is necessary, but it covers only the beginning of execution. The
workflow still has no complete, model-callable route from worker claim through
evidence, security review, independent verification, correction, completion,
and selection of the next Work Package.

No further paid/provider-backed pilot is justified until the entire vertical
path in this document passes without manual terminal intervention.

This remediation MUST NOT turn the Core into a rigid workflow engine that makes
ordinary development impractical. CHRONO governs authority, risk, evidence, and
state integrity; it does not prescribe one fixed number of documents, agents,
reviews, Work Packages, or ceremonies for every project. Safety invariants are
strict. Process shape and evidence depth are proportional and configurable.

## 2. Audited runtime path

| Stage | Current runtime surface | Core capability | Finding |
|---|---|---|---|
| Install/setup | `chrono init`, generated hooks | setup and adapter APIs | Proven in the real pilot |
| Gaspar entry | OpenCode plugin and broker | session entry/projection | Proven in the real pilot |
| Planning | native artifact tools | propose/revise/status/supersede | Proven in the real pilot |
| PO approval | native `question` ceremony | ticket and signed approval | Proven after exactly-once and fresh-approval fixes |
| Dispatch request | `chrono_dispatch` | `requestDispatch` | Implemented, not yet provider-verified |
| Worker delegation | OpenCode `task` | host ledger check | Implemented, but authority is outside Core |
| Worker claim | `chrono_dispatch_claim` | `claimDispatch` | Incomplete enactment and recovery |
| Worker mutation | plugin pre-tool gate | `authorizeExecution` | Reissues/ignores grants instead of validating an enacted binding |
| Progress/evidence | no native workflow | Core methods exist | BLOCKING |
| WP completion | no native workflow | transitions exist | BLOCKING |
| Lucca testing | worker dispatch exists in principle | evidence APIs exist | No complete orchestration or handoff |
| Glenn review | no permitted delegation/review surface | security APIs exist | BLOCKING |
| Spekkio verification | no permitted delegation/verification surface | verification APIs exist | BLOCKING |
| Defect correction | no native closed loop | defect/correction APIs exist | BLOCKING |
| Module completion | no native workflow | completion gate exists | BLOCKING |
| Next WP/final completion | no deterministic orchestrator | state model describes it | BLOCKING |

## 3. Critical defects

### CF-1 — A claimed dispatch is not enacted

`ChronoCore.claimDispatch()` creates a delegated worker session and calls
`authorizeExecution()`, returning a single-use grant. The native claim flow then
stores that grant identifier, but does not consume it through the required
`ExecutionAssigned` or `ExecutionStarted` transition.

For later mutable tools, the plugin calls the execution authorization gate
again. The newly returned grant is not used. This creates two violations:

1. authorization is repeatedly minted instead of validating one enacted
   dispatch binding;
2. the lifecycle need not enter the state that authorizes implementation before
   mutations occur.

**Required correction:** claim must atomically issue and consume exactly one
grant while enacting the legal execution transition. Per-tool checks must
validate the committed dispatch binding and its freshness; they must not mint
new grants.

### CF-2 — Dispatch authority is split between SQLite and JSONL

Dispatch intent, task delegation, and worker claim are currently represented in
`.chrono/opencode-dispatch.jsonl`, while sessions, grants, artifacts, approvals,
and lifecycle state live in the Core database.

The JSONL reader skips corrupt lines. File append, Core mutation, token-file
creation, and audit events are not one transaction. Therefore the following
states are possible:

- Core session/grant exists but no claim record exists;
- token exists without a committed claim;
- delegation record exists for an expired or revoked Core authority;
- a corrupt authoritative line disappears from the projection silently;
- restart recovery cannot determine which side is authoritative.

**Required correction:** intents, delegations, claims, bindings, status, expiry,
and revocation must be Core-owned SQLite records with migrations, constraints,
transactions, and append-only audit events. JSONL may be retained only as a
non-authoritative diagnostic projection.

### CF-3 — Claim is not atomic across external credential confinement

The current sequence is Core session/grant creation, then token-file write, then
JSONL append. A failure after the Core mutation returns an error but may leave
usable orphan authority.

**Required correction:** implement a recoverable claim protocol, for example
`PENDING -> ENACTED -> ACTIVE`, with compensating session/grant revocation on
failure. Startup and `doctor` must identify and revoke or safely resume every
incomplete claim. No error path may leave usable authority.

### CF-4 — No executable lifecycle exists after worker mutation

Core methods for evidence, verification, defects, blockers, and completion do
not make those operations reachable from a correctly bound OpenCode session.
The current native tool set ends at dispatch/claim.

**Required correction:** provide narrow native host-side tools for all required
state-changing operations. Each tool must derive project, role, runtime session,
module, WP, revision, and dispatch binding host-side. No bearer credential,
grant, filesystem path, or authority selector may be model-supplied or returned.

The minimum surface is:

- execution status/progress;
- evidence record/status;
- implementation-complete request for a WP;
- test evidence and test-complete request;
- security review, finding, blocker, resolution, and review-complete request;
- independent verification, defect, PASS/FAIL, and correction request;
- correction claim/completion and re-verification;
- module completion request/status;
- deterministic next-action projection.

Tool names are adapter details. Policy must be expressed as Core capabilities,
not trusted because a tool has a particular name.

### CF-5 — Glenn and Spekkio are unreachable

The delegation policy permits only Belthazar, Melchior, Prometheus, and Lucca.
That prevents arbitrary impersonation, but there is no separate governed path
for Glenn or Spekkio. The documented completion gate requires current Glenn
security evidence and a Spekkio PASS, so completion is unreachable.

**Required correction:** add distinct review dispatch types:

- implementation dispatch: Belthazar, Melchior, Prometheus;
- test dispatch: Lucca;
- security-review dispatch: Glenn;
- independent-verification dispatch: Spekkio;
- correction dispatch: exact owner determined from the defect.

These must not be interchangeable. Gaspar coordinates but cannot produce their
evidence or verdicts. Workers cannot select their own reviewer or verifier.
Spekkio cannot mutate product code. Glenn cannot waive findings. Only the PO can
approve risk acceptance where policy requires it.

### CF-6 — The correction loop is documentary, not executable

The state model describes defects and correction cycles, but the adapter does
not provide a complete route:

`Spekkio FAIL -> defect owner -> correction dispatch -> new revision/evidence ->
Lucca/Glenn refresh -> Spekkio re-verification`.

**Required correction:** persist correction-loop identity and attempt count;
bind every correction to the exact defect and affected revision; invalidate
stale evidence automatically; enforce bounded retry/escalation policy; and
return control to Gaspar with one deterministic next action.

### CF-7 — Completion and sequencing are unreachable

There is no end-to-end adapter behavior that consumes current Lucca evidence,
Glenn review, Spekkio verdict, documentation state, and traceability to complete
a WP/module and dispatch the next WP.

**Required correction:** Core must expose a safe next-action projection and an
idempotent orchestrator operation. It must be impossible for the model to guess
the next role or skip a gate. Completion must produce a terminal, independently
reopenable state.

### CF-8 — Spec recovery can synthesize lost semantics

The recovery path for a missing structured Spec row reconstructs fields such as
purpose, dependencies, in-scope items, and acceptance criteria from title/body
defaults. Matching a revision derived from only part of the content does not
prove semantic equivalence to the lost row.

**Required correction:** persist a canonical recovery envelope containing every
structured field needed for exact reconstruction. Identical recovery must prove
byte- and semantic-equivalence. Otherwise require a new revision or formal
supersession and stale dependent approvals.

### CF-9 — Diagnostics do not yet prove lifecycle health

`chrono doctor` proves setup and selected runtime surfaces, but it does not
currently prove that every active lifecycle state has a reachable legal next
operation. Historical ceremony output has also demonstrated that a latest
observation event can obscure the preceding authoritative result.

**Required correction:** add a deep, safe consistency projection that checks:

- orphan/pending sessions, grants, dispatches, credentials, and claims;
- consumed grants without enactment;
- enacted bindings without a live worker session;
- missing canonical structured artifacts;
- current approvals and evidence against exact revisions;
- reachable role/tool path for every required next transition;
- correction-loop owner and bounded progress;
- completion prerequisites and legal terminal transition;
- managed-asset and adapter drift.

The summary must report the authoritative outcome, not merely the last duplicate
observation.

### CF-10 — The test strategy validates components, not completion

The current tests prove many local properties, but the real pilot repeatedly
found missing connections between them. A report containing a large passing
test count is not sufficient unless one test crosses the complete runtime
lifecycle.

Additionally, the audit run in the current host did not reproduce the claimed
clean result: Keychain/broker tests and npm package-content tests were affected
by host Keychain and npm-cache state. These may be environmental rather than
product failures, but the default verification command is not fully hermetic.

**Required correction:** use a disposable npm cache and isolated test keychain
fixtures for the default suite. Keep real macOS Keychain verification as a
separate named host-integration gate. A developer's existing credentials, npm
cache ownership, PATH, or pilot project must never affect the default battery.

### CF-11 — Excessive rigidity would make the framework unusable

A literal implementation of every documented role and gate on every change
would make small, exploratory, maintenance, and low-risk projects slower than
the work they govern. Conversely, allowing agents to self-declare work as
"low-risk" would create a bypass.

**Required correction:** separate immutable safety invariants from adaptable
workflow policy.

Immutable invariants include:

- authenticated role and project/session binding;
- explicit PO authority for product, architecture, and risk decisions;
- no forged, implicit, or conversational approval;
- secret isolation and deny-by-default handling of unknown effectful tools;
- revision-bound approvals and evidence;
- independent verification where the selected policy requires it;
- no silent bypass, corruption, privilege escalation, or cross-project action;
- auditable waivers and recovery for destructive or material-risk operations.

Adaptable policy includes:

- how many Specs, ADRs, Modules, and Work Packages are needed;
- whether separate Lucca/Glenn reviews are required for a particular change;
- evidence depth and TTL;
- whether compatible low-risk Work Packages can be batched;
- whether a documentation-only or analysis-only change needs an implementation
  dispatch;
- how much autonomy Gaspar has to advance between non-authority steps;
- correction-loop limits and escalation thresholds;
- which checks apply to a language, runtime, repository, or deployment class.

The Core must calculate requirements from a versioned, PO-approved project and
change risk profile. Agents may propose classifications but may not lower them.
The PO may raise rigor at any time. Lowering a previously applicable security or
verification requirement is a signed policy/risk decision, never a prompt-side
shortcut.

Provide at least three policy profiles without hardcoding technology choices:

| Profile | Intended use | Expected workflow |
|---|---|---|
| `lean` | local prototypes, small maintenance, low-impact tools | minimal artifacts, batched low-risk WPs, focused evidence, one independent completion check |
| `standard` | normal application development | role separation and evidence proportional to affected areas |
| `critical` | sensitive data, production infrastructure, destructive/high-impact systems | explicit security review, stronger evidence, narrower dispatch, no review batching |

Profiles are starting policies, not provider/model presets. Risk triggers must
escalate requirements automatically regardless of profile, including secrets,
authentication/authorization, personal or regulated data, network exposure,
database/schema changes, dependency/supply-chain changes, infrastructure,
deployment, destructive operations, cryptography, and changes to CHRONO's own
guards.

The system must expose one concise `nextAction` rather than dumping internal
commands or every possible gate on the user. Normal progress should be
conversation-first and require PO interaction only for genuine product,
architecture, security/risk, destructive, publication, or acceptance decisions.
Internal retries, dispatch mechanics, evidence routing, and agent handoffs are
the framework's responsibility.

## 4. Required Core-owned state

The implementation may choose names, but it must persist equivalent concepts:

| Record | Required binding |
|---|---|
| Dispatch intent | project, kind, module/WP, exact revisions, requester session, required role, adapter, expiry |
| Delegation | intent, parent runtime session, child runtime session, selected role, runtime call/task id |
| Claim | delegation, Core worker session, grant, enactment event, state, expiry |
| Execution binding | claim, role, module/WP, revisions, policy/adapter/RTK/skill snapshots |
| Review assignment | review kind, target revision, reviewer role/session, independence constraints |
| Evidence submission | producer, tool/check, exact target revision, integrity, result, TTL |
| Defect/correction | verifier finding, owner role, affected revision, attempt, status, replacement evidence |
| Completion decision | all prerequisite evidence/reviews, exact final revision, verifier PASS, transition event |

All uniqueness, freshness, single-use, append-only, and cross-project rules must
be database-enforced where possible and revalidated by the Core on every use.

## 5. Required executable state machine

The following must run without external operator commands after setup and PO
decisions:

1. Gaspar reads Core next action.
2. Gaspar creates one implementation/test/review/verification dispatch through
   the appropriate native tool.
3. The adapter creates exactly one correctly named child session.
4. The child claims; Core atomically enacts the binding and consumes its grant.
5. Every operation validates that committed binding without minting grants.
6. The child records bounded, revision-bound evidence and requests completion.
7. Core advances or returns one exact unmet prerequisite.
8. Gaspar dispatches Lucca when implementation evidence is ready.
9. Gaspar dispatches Glenn when security review is ready.
10. Gaspar dispatches Spekkio only after test and security prerequisites hold.
11. On FAIL, Core selects the correction owner and creates a correction path.
12. Correction changes invalidate affected evidence and force required reviews.
13. On PASS, Core evaluates completion and advances to the next WP/module.
14. Restart at every numbered boundary resumes from Core state without replaying
    authority or asking the PO to operate internal commands.

The state machine must support safe fast paths. A fast path is a shorter legal
route selected by policy, not skipped validation. Examples:

- documentation-only work may require no product implementation dispatch;
- a small low-risk change may use one Module and one WP;
- Lucca evidence may be produced in the same implementation cycle when
  independence is not required, but Spekkio's final verdict remains independent;
- Glenn may return `NOT_REQUIRED` only from a deterministic risk rule with an
  auditable explanation; an agent cannot simply omit security review;
- several compatible WPs may be dispatched sequentially under one approved
  module plan, while each execution remains revision- and scope-bound.

Every shortened route must be visible in the next-action projection and must
explain which policy rule made a step required, optional, combined, or not
applicable.

## 6. Mandatory end-to-end proof

Before another provider-backed pilot, one deterministic black-box test must use:

- freshly packed tarballs installed without workspace links;
- the actual generated OpenCode plugin, agent files, and native tools;
- exact OpenCode 1.18.30 hook/event/tool shapes;
- real Core and SQLite migrations/state;
- deterministic model/child responses may be fixtures;
- no fake Core decisions or direct database setup after initialization.

The scenario must execute:

`fresh init -> Gaspar entry -> planning -> explicit PO approval -> implementation
dispatch -> worker claim/enactment -> product mutation -> evidence -> Lucca tests
-> Glenn security review -> Spekkio FAIL -> correction dispatch -> corrected
evidence -> Lucca/Glenn refresh -> Spekkio PASS -> WP completion -> next WP ->
module/project completion -> process restart -> terminal state confirmed`.

At every boundary assert:

- exact lifecycle state and next action;
- exact role and runtime/Core session binding;
- one consumed grant and no orphan grants;
- current artifact/evidence revisions;
- expected audit event and no duplicate authority event;
- forbidden operations remain denied;
- no secret, token, private path, or raw key reaches model-visible output;
- crash/restart recovery is deterministic.

Run the vertical scenario under `lean`, `standard`, and `critical` profiles.
Prove that the same safety invariants hold while the amount of ceremony and
evidence changes. Include automatic escalation from `lean` when a change adds a
risk trigger, and prove that neither Gaspar nor a worker can downgrade it.

The test must include negative cases for stale approvals/evidence, missing
Harness, wrong role, wrong WP, cross-project/session claim, replay, expiry,
revocation, corrupted projection, interrupted claim, reviewer impersonation,
Spekkio mutation, and attempted gate skipping.

## 7. Release-blocking verification commands

The final gate must run from clean exports on both supported Node lines:

- clean dependency installation with a disposable npm cache;
- lint with zero errors;
- typecheck;
- build;
- complete hermetic test suite with zero skipped/todo/unhandled failures;
- complete vertical OpenCode black-box test;
- migration tests from every supported schema version;
- concurrency, crash, replay, and recovery tests;
- package-content test with no fixtures/tests shipped;
- packed isolated installation and CLI smoke tests;
- `git diff --check`;
- separate explicitly reported macOS Keychain host-integration test.

Test totals are evidence only after the vertical scenario passes.

## 8. Exit criteria

This gate becomes `COMPLETE` only when all statements are true:

1. Every row in §2 is implemented and automatically proven.
2. Core/SQLite is the sole source of dispatch and lifecycle authority.
3. Claim consumes/enacts one grant atomically and leaves no orphan authority.
4. Glenn and Spekkio are reachable through independent governed paths.
5. A real correction loop reaches re-verification.
6. Completion reaches a terminal state and survives restart.
7. No step asks the PO for terminal commands, tokens, grants, internal IDs, or
   framework maintenance during normal operation.
8. `doctor --deep` (or equivalent) reports no integrity or reachability issue.
9. Default tests are hermetic; host integrations are clearly separated.
10. Normative documents describe only behavior that exists and is proven.
11. A low-risk project can reach completion through the documented lean path
    without unnecessary ceremonies, while a triggered high-risk change
    automatically receives the stronger applicable gates.

Until then, reports such as `READY_TO_RETRY_NATIVE_DISPATCH` are partial and do
not authorize another paid pilot.

## 8a. Exit-criterion evidence (2026-09-15)

> **Superseded as completion evidence:** the provider-backed pilot immediately
> disproved lifecycle reachability. The evidence below remains useful test
> history, but it cannot close this gate until CF-12 is corrected and the same
> migrated-state shape is covered by the vertical test.

Commands run from a clean checkout on Node 22.21.1 and Node 24.20.0
(`/private/tmp/node24test`); packed tarballs installed without
workspace links; disposable npm cache; isolated keychain fixture
(`test:host` separate).

1. **§2 rows implemented and proven:** dispatch request/delegate/
   claim/confirm/release/revoke/reconcile, binding-validated tool
   gate (no grant minting), 30 native tools, WP/module advance,
   reviews, corrections, policy calibration, next-action,
   execution/evidence status, deep check — covered by
   `dispatch.test.ts`, `lifecycle-status.test.ts`,
   `lifecycle-cli.test.ts`, `dispatch-cli.test.ts`,
   `native-tools.test.ts`, `native-dispatch.test.ts`, and
   `lifecycle-blackbox.test.ts` (3 profiles + negatives).
2. **Core/SQLite sole authority:** dispatch/review/correction/
   policy/lifecycle records are Core-owned (schema v19); the JSONL
   ledger is a non-authoritative diagnostic mirror; corrupt lines
   read as absent (fail closed).
3. **Atomic claim/enactment:** `claimDispatch` mints the worker
   session, authorizes, issues/consumes one grant with the
   enactment transition, and flips `PENDING → ENACTED` in one
   transaction; the CLI confines the credential and confirms to
   `ACTIVE`, with compensating revocation on any failure step.
4. **Glenn/Spekkio reachable:** `security-review`/`verification`
   dispatch kinds with kind-fitting delegation, claim, review
   assignment/completion, independence enforcement, read-only
   review bindings.
5. **Correction loop to re-verification:** `FAILED → defect owner →
   correction dispatch → fix → stale invalidation → refresh →
   PASS → WP COMPLETE`, proven in the standard black-box vertical
   and `authorization.test.ts`.
6. **Terminal state survives restart:** `WP COMPLETE → next WP →
   module COMPLETE (aggregate) → deep-check clean → reconcile
   empty → status/validate green`, every step a fresh process.
7. **No PO terminal operation in normal flow:** all mechanics run
   through native tools/CLI with host-held credentials; human
   steps (PO enroll, approvals, waivers, signed downgrades)
   require a live terminal and deny otherwise.
8. **`doctor --deep` clean:** `deep-check` (also `doctor --deep`)
   reports versions, backlog, stale citations, loop bounds,
   orphan sessions, dangling index, scope reachability, and the
   full validation fold; 0 blockers / 0 warnings on terminal state.
9. **Hermetic default:** `vitest.config.ts` excludes
   `*.host.test.ts`; `test:clean` PASS (57 files / 688 tests, zero
   failures/skips); `test:host` (macOS keychain) reported
   separately; `npm pack` uses a disposable cache.
10. **Docs describe proven behavior:** `CORE-SPECIFICATION.md`
    §16/§17.2, `STATE-MODEL.md` §2.2 (`AllPackagesComplete`),
    `RUNTIME-CONTRACT.md` §6.4, `FIRST-RUN.md` §3.2 synced;
    `git diff --check` clean.
11. **Lean path + escalation:** lean short path (focused evidence +
    one independent check, no Glenn ceremony) proven; secrets
    content escalates effective `critical` automatically; gaspar
    downgrade denies, PO-signed downgrade succeeds.

`READY_FOR_SINGLE_END_TO_END_OPENCODE_PILOT`

## 8b. CF-12 — Approved module remains DRAFT and every diagnostic misses it

**Status:** BLOCKING — reproduced in the real OpenCode pilot on 2026-09-15.

### Exact persisted state

- `MOD-0002` has a current `planning-approval` and a current
  `module-approval` for revision `96aad529…`.
- Creating another module approval correctly returns `DUPLICATE_IDENTITY`.
- The Module artifact nevertheless remains `DRAFT`.
- `WP-0001` remains `PLANNED`.
- `chrono_next` reports `record-evidence WP-0001`, an action that cannot legally
  occur before dispatch and implementation.
- `chrono_deep_check` reports zero blockers and zero warnings.

### Real denials

- implementation dispatch for `MOD-0002/WP-0001`:
  `EXECUTION_DENIED: Module MOD-0002 is in state DRAFT`;
- `wp_authorize WP-0001`:
  owning Module `MOD-0002` is `DRAFT`;
- verification dispatch is denied for the same reason;
- module completion is correctly denied because WPs are incomplete.

`review_request verification WP-0001` nevertheless created `REV-0001`, even
though the target cannot enter verification. This leaves an unreachable review
assignment and proves the precondition ordering is incomplete.

### Root cause

The state machine requires:

`MOD DRAFT -> AWAITING_APPROVAL (ModulePlanned) -> APPROVED (ModuleApproved)`.

The approval ceremony records authoritative approvals but does not enact these
state transitions. The native lifecycle surface exposes WP authorization but no
reachable Gaspar operation for the Module transitions. Approval authority and
artifact lifecycle therefore diverge permanently.

The generated next-action projection assumes evidence work is next without
first proving that the Module and WP occupy dispatchable states. The deep check
verifies record consistency but not actual transition reachability. Review
assignment validates identity/revision but not whether the target has reached a
reviewable state.

### Required correction

1. Define one canonical, idempotent Module activation operation. Prefer an
   atomic Core operation that, after confirming both current planning and
   module approvals, legally enacts `ModulePlanned` and `ModuleApproved` in
   order. If approval finalization triggers activation, it must be transactional
   and must never turn a mere planning approval into module authority.
2. Expose that operation as a native Gaspar tool. It must require no terminal,
   token, grant, or internal identifier from the PO.
3. Make replay return the current `APPROVED` projection without duplicating
   transitions. Partial state (`AWAITING_APPROVAL` with current approval) must
   resume safely.
4. `chrono_next` must compute only actions whose immediate Core preconditions
   currently hold. For this state it must return module activation, then WP
   authorization, then dispatch — never `record-evidence`.
5. `deep_check` must flag every current approval/state contradiction and every
   advertised next action that fails a dry Core precondition evaluation.
6. `review_request` must reject before creating an assignment unless the target
   is in a state appropriate for that review kind. No unreachable `REV-*` row
   may be committed.
7. Reconcile `REV-0001` append-only as invalid/unreachable history without
   deleting it; ensure it cannot block the repaired path.
8. Audit every other approval-bearing entity for the same split-brain pattern:
   Spec approval vs `READY`, Architecture approval vs `approved`, security
   decision vs security state, WP approval/authorization, waiver state, and
   completion approval vs terminal transition.
9. Generate the transition graph from the same executable precondition source
   used by `nextAction` and `deep_check`; do not maintain three divergent rule
   copies.

### Mandatory regression

Build a migrated pilot fixture with the exact shape above: current planning and
module approvals, Module `DRAFT`, WP `PLANNED`, recovered/superseded Specs, and
historical invalid approval/review rows. Starting only from public/native
operations, prove:

1. deep check initially reports the contradiction;
2. next action says activate Module;
3. native activation produces `MOD APPROVED` exactly once;
4. next action says authorize `WP-0001`;
5. WP becomes `AUTHORIZED` exactly once;
6. implementation dispatch, delegation, atomic claim/enactment, mutation, and
   evidence succeed;
7. review assignment cannot be created prematurely;
8. the full Lucca/Glenn/Spekkio correction-and-completion path reaches the
   terminal state;
9. restart at each boundary preserves the same next action;
10. `deep_check` ends with zero blockers/warnings and independently verifies
    that executing the reported next action would be accepted.

The fixture must not pre-seed final lifecycle states or call private Core
helpers to bypass the public path. This regression is required in addition to,
not instead of, the greenfield vertical test.

## 9. Implementer execution prompt

Read this file completely and treat it as a blocking remediation gate. Do not
patch only the next observed failure. Implement and prove the complete vertical
lifecycle defined in §§4–8. Start by mapping every required transition to a Core
method, Core-owned persisted record, native runtime tool, authorized role,
failure transition, recovery rule, and automated test. Any missing mapping is a
blocker.

Do not use JSONL as authority, repeatedly mint unused grants, synthesize lost
Spec semantics, expose credentials, ask the PO to run internal commands, or make
Glenn/Spekkio ordinary implementation workers. Preserve approval security,
role independence, RTK/skill enforcement, fail-closed policy, bounded correction
loops, audit history, and model/provider neutrality.

Do not implement one rigid universal workflow. Implement the proportional policy
model in CF-11: strict authority/safety invariants, PO-approved `lean`,
`standard`, and `critical` profiles, deterministic risk escalation, explainable
fast paths, and one concise next action. Agents may propose but never silently
downgrade rigor. Demonstrate usability as well as enforcement.

Do not launch a paid model, touch the real pilot project, push, publish, tag, or
mark a slice complete. Return only after the complete deterministic vertical
black-box scenario and every exit criterion pass, using exactly:

`READY_FOR_SINGLE_END_TO_END_OPENCODE_PILOT`

Report exact changed files, schema migrations, lifecycle coverage matrix, clean
Node 22/24 results, vertical test evidence, crash/recovery results, remaining
environmental requirements, and any genuinely unavoidable PO decision.
