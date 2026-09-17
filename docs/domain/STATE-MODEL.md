# CHRONO Framework — State Model

**Status:** Normative — Phase 2 deliverable
**Source authority:** `docs/reference/FRAMEWORK-DEFINITION.md`, `docs/protocols/03-ARTIFACT-MODEL.md`, `docs/protocols/07-CONSISTENCY-VALIDATION-PROTOCOL.md`, `docs/protocols/08-ROADMAP-EXECUTION-PROTOCOL.md`, `docs/protocols/09-VERIFICATION-CORRECTION-PROTOCOL.md`, `docs/implementation/IMPLEMENTATION-PLAN.md`
**Scope:** This document defines the exact state sets, legal state transitions, Project-state projection precedence, freshness/invalidation rules, and verification status lifecycle. It encodes the approved hierarchical state model without modification and introduces no runtime-specific concepts.

---

## 1. Approved State Sets

These state sets are fixed by the approved protocols and MUST NOT change. They define the complete and exhaustive set of values for each entity type.

> `[FW.11, P3.9]`

```text
Entity             Allowed States (exhaustive)

Project            UNINITIALIZED | ANALYZING | ARCHITECTING | SPECIFYING
                      | PLANNING | EXECUTING | VERIFYING | COMPLETE | BLOCKED

Specification      DRAFT | REVIEW | READY | SUPERSEDED

Module             DRAFT | AWAITING_APPROVAL | APPROVED | EXECUTING
                      | VERIFYING | PASSED | FAILED | COMPLETE | BLOCKED

WorkPackage        PLANNED | AUTHORIZED | RUNNING | BLOCKED
                      | IMPLEMENTED | VERIFYING | FAILED | COMPLETE

Verification       PENDING | RUNNING | FAILED | PASSED | WAIVED
```

### 1.1 Auxiliary state sets (defined by protocol)

Additional entity lifecycle states defined in the protocols:

```text
Entity             Allowed States

ADR                proposed | accepted | rejected | superseded | deprecated
                   [P4.5] ("ADRs MUST use a lifecycle that preserves rejected,
                            accepted, superseded, and deprecated decisions")

Architecture       proposed | under_review | approved | superseded
                   [REF.5] ("distinguish current architecture, proposed architecture,
                            and approved architecture")

Decision           proposed | approved | rejected
                   [P2.5, P3.3] ("status" attribute)

Blocker            active | resolved
                   [P3.3] (condition preventing a gate)

Defect             open | in_progress | resolved | reopened
                   [FW.§484-507, P3.3]

Waiver             active | expired | invalidated
                   [P2.8] ("Expired or invalidated waivers MUST block")

ChangeRequest      proposed | approved | rejected | implemented
                   [FW.§937, P3.3]

SecurityProfile    versioned (monotonic integer version)
                   [P1.5, P6.5] (versioned, current until new version created)

RTKAttestation     current | stale | invalid
                   [P6.5, P7.3]

SkillAttestation   current | stale | invalid
                   [P6.6, P7.3]
```

> `Verification` status tracks the verdict on a unit of work: `PASSED` and `WAIVED` are distinct and `WAIVED` is never `PASSED` `[P3.9, FW.§598]`.

---

## 2. Legal State Transitions

Each transition is a deterministic, Core-validated event. The Core MUST reject illegal transitions and persist only legal ones. Transitions not listed here MUST be rejected as invalid.

### 2.1 Specification

```text
Event / Trigger                           Legal Transition
─────────────────────────────────────────────────────────────
Spec drafted from requirements             DRAFT
Content moved to review                    DRAFT → REVIEW
Consistency + semantic validation pass     REVIEW → READY
PO security approval present               (prerequisite for READY)
Planning approval exists (when exec asked) (prerequisite for READY when exec)
Approved Spec superseded by new revision   READY → SUPERSEDED
Superseded Spec referenced                 (blocked — stale reference)
Review finds issues                         REVIEW → DRAFT
```

> `[FW.§595-596, P5.6, P3.9]` A Spec becomes `READY` only after deterministic and semantic validation, Harness existence/validation, current security approvals, and (when execution is requested) planning artifacts and module approval.

### 2.2 Module

```text
Event / Trigger                           Legal Transition
─────────────────────────────────────────────────────────────
Planning finalized                         DRAFT → AWAITING_APPROVAL
PO approval (interactive, signed)          AWAITING_APPROVAL → APPROVED
Execution begins                           APPROVED → EXECUTING
Implementation complete                    EXECUTING → VERIFYING
Spekkio PASS (no blocking issues)          VERIFYING → PASSED
All DoD criteria satisfied                PASSED → COMPLETE
All Work Packages COMPLETE (aggregate)    APPROVED|EXECUTING|VERIFYING|PASSED → COMPLETE
Spekkio FAILED                             VERIFYING → FAILED
Correction complete, re-authorized         FAILED → EXECUTING
Blocker raised (any active state)          ANY → BLOCKED
Blocker resolved (validated re-entry)      BLOCKED → (prior valid state)
PO requests revision / change control      AWAITING_APPROVAL → DRAFT
```

> `[FW.§596, P3.9, P8.4, P8.5, P9.3]` Module approval binds to exact module and artifact revisions `[P8.4]`. Spekkio PASS triggers `PASSED`; final DoD yields `COMPLETE` `[P9.3]`. A module whose Work Packages are all COMPLETE completes by aggregate (`AllPackagesComplete`): each package carries its own Spekkio PASS verdict chain, so the module records no separate verdict; module-level traceability, architecture, blocker, defect, and currency gates still hold `[CORE_FIX CF-7]`.

### 2.3 WorkPackage

```text
Event / Trigger                           Legal Transition
─────────────────────────────────────────────────────────────
Dependencies satisfied, module approved    PLANNED → AUTHORIZED
Execution assigned                          AUTHORIZED → RUNNING
Implementation done                         RUNNING → IMPLEMENTED
Verification ready                          IMPLEMENTED → VERIFYING
Spekkio PASS                                VERIFYING → COMPLETE
Spekkio FAILED                              VERIFYING → FAILED
Correction complete, re-authorized          FAILED → RUNNING
Correction rework before verification       IMPLEMENTED → RUNNING
Blocker raised (any active state)           ANY → BLOCKED
Blocker resolved (validated re-entry)       BLOCKED → (prior valid state)
```

> `[FW.§597, P3.9, P8.3]` Work Packages must declare dependencies on existing targets `[P8.3]`. Authorization requires no blocker, satisfied dependencies, and execution authorization `[P8.5]`.

### 2.4 ADR

```text
Event / Trigger                           Legal Transition
─────────────────────────────────────────────────────────────
Proposed by Gaspar                         proposed
PO/architecture approval                   proposed → accepted
Explicit rejection                        proposed → rejected
Superseded by new revision                 accepted → superseded
Decision no longer applicable (no replacement) accepted → deprecated
```

> `[P4.5]` ADR lifecycle preserves rejected, accepted, superseded, and deprecated decisions.

### 2.5 Architecture

```text
Event / Trigger                           Legal Transition
─────────────────────────────────────────────────────────────
Proposed                                    proposed
Under security/architecture review         proposed → under_review
PO architecture security approval          under_review → approved
Material change / supersession             approved → superseded
```

> `[REF.5, P4.8]` Architecture must distinguish proposed, under-review, and approved. `[FW.§626]` Architecture Security Approval is mandatory before affected Specs become READY.

### 2.6 Decision

```text
Event / Trigger                           Legal Transition
─────────────────────────────────────────────────────────────
Proposed by authority                      proposed
Approved                                   proposed → approved
Rejected                                   proposed → rejected
Superseded by later decision               (reference only — no state transition;
                                            record `supersedes` on the new Decision)
```

> `[P2.5, P3.3]` Conflicting active decisions block readiness `[P2.5]`.
>
> Reconciliation note (Slice 5 remediation §6): the §1.1 state set
> (`proposed | approved | rejected`) contains no `superseded` state, so
> supersession is recorded exclusively through the supersession reference
> required by P2.5 — never through a state transition. No new lifecycle
> is introduced.

> `[P2.5, P3.3]` Conflicting active decisions block readiness `[P2.5]`.

### 2.7 Waiver

```text
Event / Trigger                           Legal Transition
─────────────────────────────────────────────────────────────
PO grants waiver (interactive, signed)     active
Waiver expires                             active → expired
Waiver invalidated (material change)       active → invalidated
```

> `[P2.8, FW.§398]` Expired or invalidated waivers MUST block the affected gate. `[P2.8]` WAIVED is never PASSED.

### 2.8 ChangeRequest

```text
Event / Trigger                           Legal Transition
─────────────────────────────────────────────────────────────
Proposed                                   proposed
Authority approves                         proposed → approved
Rejected                                   proposed → rejected
Implemented                                approved → implemented
```

> `[FW.§937, P3.3]` Material changes MUST create a ChangeRequest with impact analysis.

### 2.9 Attestations (RTK, Skill)

```text
Event / Trigger                           Legal Transition
─────────────────────────────────────────────────────────────
Attestation recorded (valid)               current
TTL elapsed / staleness detected           current → stale
Binary/skill change / bypass detected      current → invalid
                                             stale → invalid
Re-attested                                 stale → current
                                              invalid → current (requires full re-verification)
```

> `[P6.5, P6.6, P7.3]` Stale or invalid attestations MUST prevent dispatch. `[REF.§1188-1189]`

### 2.10 Blocker

```text
Event / Trigger                           Legal Transition
─────────────────────────────────────────────────────────────
Raised by agent/system                     active
Resolved by responsible authority          active → resolved
Material change (invalidates resolution)   resolved → active
```

> `[P3.3, P7.3]` An active blocker at any level blocks the named target/gate.

### 2.11 Defect

```text
Event / Trigger                           Legal Transition
─────────────────────────────────────────────────────────────
Raised by Spekkio                          open
Assigned to responsible agent              open → in_progress
Correction underway                        in_progress
Reopened (re-verification fails)           any → reopened → in_progress
Resolved (re-verification passes)          in_progress → resolved
```

> `[FW.§484-507, P9.4]` Defects are classified and routed to responsible authority. `[P9.4]` Correction triggers re-evidence.

---

## 3. Project State Projection

The Project state is a **deterministic projection** computed from aggregate child states. It is NOT manually set. The Core MUST NOT allow any Project state to hide a blocked, failed, running, or awaiting-approval child.

> `[FW.§596, P3.9]` "Project state is a deterministic projection of aggregate state and MUST NOT hide a blocked, failed, running, or awaiting-approval child."

### 3.1 Projection precedence

The Core computes the Project state by evaluating the following rules in order (highest precedence first). The first matching rule determines the projected state.

```text
Step 1:  BLOCKED
    If any active Blocker targets the Project itself or any child artifact
    (any Specification, Module, WorkPackage, SecurityProfile, etc.),
    AND that blocker prevents progress at the current gate,
    THEN Project.state = BLOCKED.

Step 2:  EXECUTING
    If any Module is APPROVED or EXECUTING,
    OR any WorkPackage is RUNNING,
    THEN Project.state = EXECUTING.

Step 3:  VERIFYING
    If any Module is in {VERIFYING, PASSED, FAILED},
    OR any WorkPackage is in {VERIFYING, FAILED},
    THEN Project.state = VERIFYING.
    (A FAILED module or WP is in the correction loop, which is part of
     the verification phase.)

Step 4:  PLANNING
    If any Module is AWAITING_APPROVAL,
    OR any Module is DRAFT and planning/DAG generation is in progress
    (at least one Specification is READY),
    THEN Project.state = PLANNING.

Step 5:  SPECIFYING
    If any Specification is DRAFT or REVIEW,
    OR Harness generation or Spec validation is in progress
    (but no Specification is READY yet),
    THEN Project.state = SPECIFYING.

Step 6:  ARCHITECTING
    If System Analysis is complete and Architecture/Security Profile
    work is in progress (Architecture proposed or under_review,
    ADRs in proposed/accepted state),
    AND no Specification exists yet,
    THEN Project.state = ARCHITECTING.

Step 7:  ANALYZING
    If System Analysis is in progress
    (project purpose/knowledge not yet sufficient for architecture),
    THEN Project.state = ANALYZING.

Step 8:  COMPLETE
    If every Module is COMPLETE
    AND no active Blocker exists
    AND no Module is in {FAILED, PASSED, VERIFYING, EXECUTING, APPROVED},
    THEN Project.state = COMPLETE.

Step 9:  UNINITIALIZED
    Otherwise (before init or no artifacts exist),
    Project.state = UNINITIALIZED.
```

### 3.2 Projection correctness invariants

The projection MUST satisfy these invariants (derived from `[FW.§596, P3.9]`):

1. **No hidden blockers**: If any child or the project itself has an active blocker → Project ≠ COMPLETE, ≠ ANALYZING, ≠ ARCHITECTING, ≠ SPECIFYING, ≠ PLANNING (if the blocker is at or above that phase). Project = BLOCKED.
2. **No hidden failures**: If any Module is FAILED (uncorrected) → Project ≠ COMPLETE. Project = VERIFYING (correction in progress).
3. **No hidden running work**: If any WorkPackage is RUNNING → Project ≥ EXECUTING.
4. **No hidden awaiting-approval**: If any Module is AWAITING_APPROVAL → Project ≥ PLANNING.
5. **No premature completion**: Project = COMPLETE requires ALL modules COMPLETE and zero active blockers.

### 3.3 Legal Project-level transitions

The Project state is projected (not directly transitioned), but the following directional constraints hold:

```text
Progression (forward):
UNINITIALIZED → ANALYZING → ARCHITECTING → SPECIFYING → PLANNING → EXECUTING → VERIFYING → COMPLETE

Interrupt:
ANY → BLOCKED (when blocker raised)
BLOCKED → (re-projected to prior phase when blocker resolved and re-validated)

Regression (only via correction loop):
COMPLETE, VERIFYING, EXECUTING → VERIFYING (when a Module returns to FAILED and enters correction)
VERIFYING → EXECUTING (when correction is re-authorized)

Terminal:
COMPLETE is terminal for the Project unless a material change triggers re-specification.
```

> A Project in `COMPLETE` may revert to an earlier phase only through Change Control that supersedes artifacts and reopens work `[FW.§606-611, P3.5]`.

---

## 4. Freshness and Invalidation

The Core MUST treat time-bound and change-bound state as "current" or "stale/invalid." Exact time windows are specified in the Core Specification; this model defines the invalidation triggers and the concept.

### 4.1 RTKAttestation freshness `[P6.5, REF.§1188]`

| Condition | State |
|---|---|
| Recorded with successful `rtk gain` (binary identity), within TTL | `current` |
| TTL elapsed (default: project-configured window) | `stale` |
| Binary changed, version mismatch, collision detected, bypass event | `invalid` |
| Re-tested and healthy | → `current` |

Attestation currency alone never authorizes dispatch: dispatch additionally
requires a current AUTHORITATIVE routing proof for the (adapter, runtime,
project) scope (`chrono rtk prove` records a CANDIDATE; `chrono rtk promote`
authorizes it after signed adapter approval) `[ADR-006, INV §8.7]`.

**Invalidation triggers:**
- RTK binary path or version changes `[REF.§123]`
- `rtk gain` fails (proves it is not Rust Token Killer) `[REF.§123]`
- No current AUTHORITATIVE routing proof, or any proof binding drifted (binary, registration, managed assets, attestation) `[ADR-006]`
- Bypass event detected `[P7.3, P8.7]`

**Effect:** `stale` or `invalid` → `BLOCKED_RTK` → dispatch denied `[P6.5, P7.3, P8.7]`; missing/drifted proof → `RTK_ROUTING_FAILURE` → dispatch denied.

### 4.2 SkillAttestation freshness `[P6.6, REF.§1189-1190]`

| Condition | State |
|---|---|
| Pinned commit verified, hashes match, activation smoke test passed, within TTL | `current` |
| TTL elapsed | `stale` |
| Pinned commit changed, hashes diverge, skill modified/untrusted/bypassed | `invalid` |
| Re-verified | → `current` |

**Invalidation triggers:**
- Canonical source commit hash changes `[REF.§1196]`
- Generated artifact hashes diverge from canonical `[REF.§1190]`
- Skill discovery fails or is unauthorized `[P6.6, P8.6]`
- Activation smoke test fails `[P6.6, P8.6]`
- Bypass event detected `[P7.3, P9.8]`

**Effect:** `stale` or `invalid` → `BLOCKED_PROCESS_SKILL` → dispatch denied `[P6.6, P8.6, P9.8]`.

### 4.3 SecurityProfile currency `[P1.5, P6.5, P5.5]`

| Condition | State |
|---|---|
| Current version, no material changes since last review | `current` |
| New version created | → previous becomes superseded; new is current |
| Material change to threats/trust boundaries/controls/dependencies | triggers invalidation of dependent security decisions |

### 4.4 Security decision currency `[P2.6, P4.4, P9.3]`

**Architecture Security Approval**: current until a material change to:
- threats
- trust boundaries
- dependencies
- controls
- infrastructure exposure
- Security Profile

**Implementation Security Acceptance**: current until a material change to:
- implemented revision (content hash)
- security assumptions
- implementation deviations from the approved architecture

**Effect**: Stale security decision → affected Spec/Module cannot become READY/COMPLETE `[P2.6, P9.3]`.

### 4.5 Harness freshness `[P6.7]`

A Harness is stale when any of the following material changes occur after Harness generation:

- Referenced Specification revision changes
- Referenced ADR accepted/rejected/superseded
- Referenced Requirement/BusinessRule/Constraint changes
- Security Profile version increments
- Source repository revision changes
- Dependent Spec revision changes
- Security Profile control changes
- Module approval revision changes
- RuntimeCapability changes
- RTKAttestation becomes stale/invalid
- SkillAttestation becomes stale/invalid
- Referenced acceptance criteria change

**Effect**: Stale Harness → execution denied `[P6.7]`.

### 4.6 Approval freshness `[FW.§1196, P2.10]`

An Approval is valid only when:
- The bound artifact revision hash matches the current artifact revision
- The signing key is verified
- The approval has not been revoked

**Invalidation triggers:**
- Material change to the bound artifact creates a new revision → approval becomes stale
- Signing key revoked or compromised
- Approval explicitly revoked

**Effect**: Stale/invalid approval → `APPROVAL_REQUIRED` or `EXECUTION_DENIED`/`COMPLETION_DENIED` `[P2.10, FW.§1196]`.

### 4.7 Evidence freshness `[P9.2]`

Evidence binds to an exact target revision. Evidence becomes stale/invalid when:
- The target artifact revision changes
- The evidence TTL (project-configured) elapses — for ephemeral checks
- The producing tool's integrity is compromised

**Effect**: Stale evidence → verification fails → Spekkio may not issue PASS `[P9.3, P9.5]`.

---

## 5. Verification Status Lifecycle

The Verification state tracks the quality verdict on a unit of verification (Module, WorkPackage, or Spec).

```text
PENDING → RUNNING → PASSED | FAILED | WAIVED
```

- `WAIVED` is terminal for the verification cycle and is distinct from `PASSED` `[P3.9, FW.§379, P2.6]`.
- `PASSED` requires all mandatory criteria satisfied and no unresolved blockers/security issues `[P9.3]`.
- `FAILED` triggers a correction loop `[P9.4]`.
- `WAIVED` requires an explicit PO Waiver bound to scope and revision `[P2.8]`.

### 5.1 Verification re-entry

```text
PASSED/WAIVED → PENDING (new revision requires re-verification)
FAILED → RUNNING (correction complete, re-run)
```

---

## 6. Transition Enforcement

### 6.1 Core responsibility

The Core MUST validate every state transition deterministically before persisting `[P7.5, FW.§1055]`. Transitions are:

- **Event-sourced**: each transition is an append-only event in SQLite `[P3.9]`.
- **Atomic**: a transition either fully succeeds or fails; partial states must not persist `[P3.9]`.
- **Guard-checked**: all gate conditions (§6 of DOMAIN-MODEL) are evaluated before a transition is accepted `[P7.5]`.
- **Auditable**: every transition records the triggering event, actor identity, prior state, new state, and reasoning `[P5.7]`.

### 6.2 Agent interaction

- Agents and adapters MAY request state transitions via the Core API.
- The Core makes the final deterministic decision.
- A prompt or agent instruction MUST NOT bypass a required gate `[FW.§648-649, P7.5]`.

### 6.3 Illegal transition handling

An illegal transition attempt MUST:
1. Be rejected by the Core.
2. Produce a structured error from the error taxonomy (see CORE-INVARIANTS.md).
3. NOT mutate any state.
4. Be auditable as a denied-transition event.

---

## 7. Summary of State Relationships

```text
Project (projected) ── aggregates ── Modules
                                │
                           WorkPackages
                                │
                          Tasks (derived/persisted)
                                │
                          AcceptanceCriteria
                                │
                          Specifications
                                │
                          SecurityProfiles
                                │
                          Decisions/Approvals/Waivers
                          Blockers/Defects/Evidence

Each level binds to revision hashes; material change cascades invalidation.
```

> `[FW.§601, P3.9]` Project state is a deterministic projection. `[FW.§677]` Approval state must be persistent, deterministic, and independent from the active AI session.
