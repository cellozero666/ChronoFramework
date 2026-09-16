# WORKFLOW STABILIZATION — Minimum Functional Lifecycle

**Status:** BLOCKING

**Purpose:** stop incremental fixes. Define the minimum functional
CHRONO lifecycle as ONE Core-owned decision loop, prove the current
implementation cannot run it without manual transition selection
(RED acceptance test), and specify the single missing operation
that closes the gap. No production behavior is changed by this
document.

## 1. The problem (verified, not inferred)

The Core exposes ~27 fine-grained `nextAction` values
(`submit-spec`, `claim-dispatch`, `submit-review`,
`scope-advance` events, …). Every one of them names a specific
tool/operation the orchestrator must choose, credential, and
execute itself. There is no Core operation that consumes a
mechanical step on the orchestrator's behalf. Consequences,
each demonstrated by `packages/cli/src/workflow-stabilization.test.ts`
(run: `npm run test:workflow`):

- reaching `COMPLETE` from a new project requires 20+ manually
  selected transitions (the test logs every one);
- no Core result names a workflow boundary — only tool steps;
- a bounded-loop exhaustion (escalated loop + PO blocker) surfaces
  as scattered tool actions, never as a single `BLOCKED` boundary;
- `ChronoCore.advance` does not exist.

The lifecycle works only because the orchestrator guesses
correctly at every step. That is the architectural defect this
gate closes.

## 2. Canonical result type: `WorkflowDecision`

One Core-owned result type. Exactly these five boundaries — no
tool names, no event names, no prose:

```ts
type WorkflowDecision =
  | {
      type: "PO_DECISION_REQUIRED";
      action: string;      // approval action the ceremony must bind
      scopeId: string;     // architecture, spec, or module under approval
      revision: string;    // exact revision the ceremony must bind
      rationale: string;   // why the ceremony blocks (Core-observed)
    }
  | {
      type: "AGENT_WORK_REQUIRED";
      role: AgentRole;     // worker identity that must act
      kind: string;        // dispatch/enactment kind (incl. "harness")
      moduleId: string;
      workPackageId: string | null;
      objective: string;   // fixed-format directive naming ids in play
    }
  | {
      type: "INDEPENDENT_REVIEW_REQUIRED";
      role: "glenn" | "spekkio";
      kind: string;        // "security-review" | "verification"
      moduleId: string;
      workPackageId: string | null;
      targetRevision: string;
    }
  | {
      type: "BLOCKED";
      code: string;        // CORRECTION_ESCALATED | NO_PROGRESS | ...
      reason: string;      // blocking condition + what unblocks it
      owner: AgentRole | "PO" | "system";
      recoverable: boolean;
    }
  | {
      type: "COMPLETE";
      moduleId: string;
      summary: string;
    };
```

Semantics (normative):

- `PO_DECISION_REQUIRED` — the workflow cannot proceed without a
  signed Product Owner decision. Covers: missing or stale
  planning/module approvals, missing implementation-security
  acceptance, missing architecture-security approval, waiver
  decisions, and any correction-loop escalation awaiting PO
  triage. The Core names the exact approval action, scope, and
  revision; the ceremony (ticket + native question + verified
  landing) is the only path through. Gaspar never asks the PO to
  run CHRONO commands, handle tokens, or plumb internal IDs —
  the PO decides in the UI and the Core records.
- `AGENT_WORK_REQUIRED` — the next step needs a bound worker
  identity (implementation, test, or correction enactment,
  evidence, claim/confirm). The Core names the scope, kind, and
  binding required; it never impersonates the worker and never
  performs worker mutations itself.
- `INDEPENDENT_REVIEW_REQUIRED` — the next step needs Glenn or
  Spekkio acting independently (security review, verification
  verdict, review submission). The Core names the kind, scope, and
  revision; reviewer independence is enforced, never bypassed.
- `BLOCKED` — the workflow cannot proceed mechanically:
  escalated bounded loop, unresolvable denial, or any state from
  which no safe mechanical transition exists. The Core names the
  blocking condition and what would unblock it. Terminal until a
  human changes the underlying state.
- `COMPLETE` — terminal success. The scope validates cleanly
  (`validate.valid`, deep-check zero findings); nothing further is
  executable.

## 3. Specified operation: `ChronoCore.advance()`

Implemented (signature; the RED-test prohibition on faking it stands —
every step below runs through the same guarded operation the
corresponding native tool calls):

```
advance(scope, auth) -> CoreResult<{
  decision: WorkflowDecision;
  trail: NextAction[];       // every mechanical step consumed, in order
  lastAction: NextAction | null;
}>
```

Loop semantics (normative):

1. Observe `nextAction` for the scope.
2. Resolve it to a `WorkflowDecision` boundary per §2.
3. If it is already a boundary (`COMPLETE`, or a hold requiring
   PO/worker/reviewer/escalation handling), return it with the
   trail so far. Do not execute anything.
4. Else, if the step is safe-mechanical, execute it through the
   same guarded operation the corresponding tool would call
   (single-use grants consumed atomically), append it to the
   trail, and repeat from 1.
5. If no progress is possible (same action twice with no state
   change) or a step cap is reached, return `BLOCKED` naming the
   condition. Never loop unboundedly, never skip a denial.

Safe-mechanical (all must hold): the shared dry-run is acceptable
for the caller; no PO ceremony is required; no worker or reviewer
session beyond the caller's own is required; no choice among
alternatives exists (deterministic single next step); the step
changes persisted lifecycle state or it does not count as
progress. Architecture submission/approval, spec submission/READY,
Harness-adjacent readiness excluded, module activation, WP
authorization, review assignment, and completion transitions that
meet all five are consumable; dispatch requests (rationale,
adapter, and runtime delegation belong outside the Core),
Harness content, claims, evidence, verdicts, reviews, and
corrections owned by another identity always resolve to
`AGENT_WORK_REQUIRED` / `INDEPENDENT_REVIEW_REQUIRED`; missing
approvals always resolve to `PO_DECISION_REQUIRED`.

## 4. Minimum functional lifecycle (acceptance shape)

`new project → planning artifacts → PO approval →
architecture/spec/harness ready → module activated → WP authorized
→ implementation dispatch → worker mutation → evidence → Spekkio
PASS → WP complete → module complete`

Acceptance properties (asserted by the RED test):

- Gaspar never asks the PO to run CHRONO commands;
- no manual session tokens or internal IDs are handled by the PO;
- approval registration, lifecycle state, and next decision remain
  consistent at every step;
- no transition tool is manually selected by Gaspar (the driver may
  only call `advance()`);
- the process ends in `COMPLETE`;
- a bounded-loop failure becomes `BLOCKED`.

## 5. Implementation evidence (current tree)

`ChronoCore.advance()` is implemented in
`packages/core/src/chrono-core.ts` (discriminated `WorkflowDecision`
union beside it; both re-exported from `@chrono/core`). Behavior:

- Terminal escalation is checked before every observation, so a
  live worker binding can never hide an ESCALATED loop: the fourth
  FAILED verdict resolves to `BLOCKED` (`CORRECTION_ESCALATED`,
  owner `PO`) with an empty trail.
- Boundary derivation re-reads rows through the ACTION's own
  target scope — a module-scope observation naming a package
  binding resolves the package rows, never the empty module scope.
- The progress snapshot covers lifecycle states plus dispatch,
  review, evidence, verdict, loop, blocker, and approval counts,
  so every legitimate external input moves it; a repeated action
  on one target with an identical snapshot resolves to `BLOCKED`
  (`NO_PROGRESS`), and the loop is strictly bounded (default 50,
  overridable).
- Dispatch requests, Harness content, claims, evidence, verdicts,
  reviews, and corrections stay boundaries; architecture/spec
  transitions, activation, authorization, review assignment, and
  completion consume mechanically through the same guarded
  operations the native tools call. A denied step aborts with its
  exact denial — every consumed step is itself transactional, so
  no partial write ever persists.
- External-input operations (finalized approval, Harness record,
  evidence, verdict, review submit, correction completion,
  dispatch release) converge by re-invoking `advance()`: the
  engine is stateless over persisted rows, so no op needed code
  changes.

`npm run test:workflow` passes (3/3): the full lifecycle walks on
`advance()` alone to `COMPLETE` (validate clean, deep-check
zero/zero, all three module approvals current), Gaspar initiates
no lifecycle transition outside boundary-cited handlers, every
external input cites its preceding boundary, and exhaustion
resolves to `BLOCKED`. Focused engine coverage lives in
`packages/core/src/advance.test.ts` (12 tests: all five variants,
multi-transition advancement, no-fabrication, held-dependency
blocking, iteration bound, lean exhaustion, restart persistence,
idempotency, authority-loss abort, post-op convergence).

`npm test` stays green: the workflow suite runs only under
`WORKFLOW_STABILIZATION=1` (established gate pattern), asserting
the flag is off by default. No existing test was modified for the
engine; existing security checks are unchanged (all denial codes
preserved and asserted).

### 5.1 Structured boundary fields (no prose parsing)

`AGENT_WORK_REQUIRED` carries `phase` (`request` | `claim` |
`execute` | `correct` | `record-harness`) plus exactly the ids each
phase needs: `dispatchId` (claim/execute phases), `specId` /
`specRevision` (record-harness phase), `loopId` / `defectId` /
`attempt` (correct phase); `adapterId` is always null because adapter
choice belongs to the orchestrator side, never the Core.
`INDEPENDENT_REVIEW_REQUIRED` carries `reviewId` (set whenever an
ASSIGNED review exists; null for request-completion, which names the
verification still to be assigned). Orchestration switches on these
fields plus the scope ids; `objective` / `reason` / `rationale` /
`summary` prose is descriptive only. Proven by `advance.test.ts`
"routes every boundary on structured fields with garbled prose"
(every prose field overwritten with garbage containing decoy ids —
any parser would deflect onto a wrong scope and fail) and by the
removal of every prose-regex id recovery from the default suite
(review ids arrive on assignment results; loop ids arrive on
`advance()` boundaries and structured `CorrectionOpened` events).

### 5.2 Canonical evidence rule

Evidence must ride a live binding held by the recording session: an
ACTIVE dispatch (native track) or a live grant (legacy `chrono run`
track — unconsumed, unexpired, bound to the same session, role, and
scope). Validation precedence is fixed: secret-bearing evidence
denies `SECRET_DETECTED` and malformed evidence denies its
`VALIDATION_ERROR` before any binding evaluation, so a binding
denial never masks a leak or a malformed payload; only structurally
valid, secret-free evidence reaches binding validation. `chrono run`
re-authorizes before recording so its proof rides the same live
grant that then carries the completion transition. Every Core
fixture records through request → delegate → claim → confirm
bindings; binding-less recording denies `EXECUTION_DENIED`.

### 5.3 Restart-safe step transactions (not whole-call atomicity)

`advance()` offers no whole-call atomicity: each consumed step is
its own transaction, a crash keeps exactly the committed prefix, and
the next `advance()` resumes past it with no repetition. Proven by
`advance.test.ts` "injected failure commits the prefix only" (the
`failAfterSteps` diagnostic seam aborts after exactly 2 committed
steps with `WORKFLOW_INJECTED_FAILURE`; the N+1th transition leaves
no partial write; close/reopen/resume emits only the 3-step suffix
and the exact 8-transition sequence once) and "injection past the
mechanical prefix never fires".

### 5.4 What the Core tests prove — and do not prove

The workflow/advance suites prove STATE CONVERGENCE of the
deterministic Core: lifecycle transitions, gates, bindings, evidence
indexes, and boundary routing, including across close/reopen. They
do NOT prove product-file mutation: worker commands are fixture
executables, Harnesses are fixture strings, and no real product
repository is modified by any Core test. Runtime integration
(OpenCode native tools calling `advance()`, Gaspar contract
simplifications, real worker mutation of product files) remains open
work — see §6.

## 6. What unblocks this gate (separate authorization required)

1. ~~Implement `advance()` per §3~~ — done, this tranche (engine,
   structured boundary fields, canonical evidence rule, restart-safe
   step transactions, prose-independence; full suite green).
2. Runtime integration (OpenCode tools calling `advance()`,
   Gaspar contract simplifications, real worker mutation of product
   files) — explicitly later work.
3. Independent review, then pilot.

(End of file)
