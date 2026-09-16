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
export type WorkflowDecision =
  | "PO_DECISION_REQUIRED"
  | "AGENT_WORK_REQUIRED"
  | "INDEPENDENT_REVIEW_REQUIRED"
  | "BLOCKED"
  | "COMPLETE";
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

**Not implemented** (implementing it is a separate authorized task;
the RED test below forbids faking it).

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
progress. Dispatch requests, activation, authorization, review
assignment, releases, reconciliations, and transitions that meet
all five are consumable; claims, evidence, verdicts, reviews, and
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

## 5. RED evidence (current tree)

`npm run test:workflow` fails, proving the gap architecturally:

- `ChronoCore.advance` does not exist (`typeof` check);
- the walk to `COMPLETE` requires N manually selected transitions
  (logged; must be zero);
- no `nextAction` resolves to a `WorkflowDecision` boundary
  (tool steps only);
- loop exhaustion surfaces tool actions, never `BLOCKED`.

`npm test` stays green: the RED suite runs only under
`WORKFLOW_STABILIZATION=1` (established gate pattern, same as the
black-box/network/host gates), asserting the flag is off by
default. No existing test was modified; no production behavior
was changed to make anything pass.

## 6. What unblocks this gate (separate authorization required)

1. Implement `advance()` per §3 (Core only; no prompt/prose logic).
2. Turn this RED suite green without weakening a single
   assertion (especially: zero manual selections, `BLOCKED` on
   exhaustion, contract hygiene).
3. Independent review, then pilot.

(End of file)
