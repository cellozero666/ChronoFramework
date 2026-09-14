# CHRONO Specification Protocol

**Status:** Normative protocol
**Owner:** Gaspar

## 1. Purpose

A Specification is a coherent, verifiable system contract. Specs MUST be discovered from system analysis, requirements, business rules, approved architecture, ADRs, boundaries, and dependencies. CHRONO MUST NOT impose a universal fixed Spec list.

## 2. Spec discovery

Gaspar MUST identify independently understandable and executable contracts, minimize hidden coupling, and expose dependencies explicitly. Decomposition MUST optimize clarity, traceability, and safe execution rather than Spec count. The mandatory Karpathy Guidelines skill MUST reinforce explicit assumptions, minimal sufficient scope, surgical changes, and goal-driven acceptance criteria without weakening security, traceability, or gates.

Each proposed Spec MUST identify why it exists and which authoritative artifacts require it. Orphan Specs MUST fail validation.

## 3. Required content

An executable Spec MUST define, where applicable:

- identity, title, purpose, lifecycle, and revision;
- in-scope and out-of-scope behavior;
- functional and non-functional requirements;
- business rules, constraints, assumptions, and forbidden decisions;
- architecture and ADR references;
- dependencies and contracts/interfaces;
- data ownership, schema/impact, retention, and privacy;
- authentication, authorization, trust boundaries, and security requirements;
- normal, error, abuse, boundary, and recovery scenarios;
- observable outcomes and acceptance criteria;
- test and security evidence requirements;
- change-control and approval requirements.

Unknowns MUST remain explicit. A Spec MUST NOT become a design notebook or invent missing product behavior.

## 4. Acceptance criteria

Acceptance criteria MUST be objective, testable, traceable, implementation-neutral where practical, and include negative/security cases appropriate to the Security Profile. Criteria MUST distinguish mandatory behavior from recommendations.

## 5. Security requirements

Glenn MUST review security-relevant Specs. Security controls from the approved architecture and Security Profile MUST be propagated into the Spec and later Harness. Any conscious residual risk requires PO authority under the Authority & Decision Protocol.

A Spec MUST NOT be `READY` when security requirements, threat assumptions, or required Architecture Security Approval are absent, stale, or contradictory.

## 6. Readiness

An executable Spec becomes `READY` only when:

- scope and exclusions are clear;
- requirements and acceptance criteria are traceable;
- applicable architecture/ADRs and security decisions are approved/current;
- contracts, data impact, errors, edge cases, and dependencies are sufficient;
- no blocking decision or inconsistency remains;
- its authoritative Harness exists and validates;
- deterministic and semantic validation pass;
- planning artifacts and required module approval exist when execution is requested.

Readiness MUST be computed/validated by the Core; an agent assertion is insufficient.

## 7. Revision and change

Approved Specs MUST NOT be silently modified during implementation. Material change MUST create a ChangeRequest, impact analysis, new revision, revalidation, Harness regeneration, replanning, and renewed approvals/evidence where invalidated.

## 8. Prohibited behavior

An execution agent MUST NOT reinterpret acceptance criteria, expand scope, introduce architecture, weaken security, or mark a Spec ready. Ambiguities MUST be blocked and routed.

## 8.1 Draft materialization before execution (OC-P11)

Spec drafts reach the registry through the Core-governed planning
path (`planning.propose`/`planning.revise`, Gaspar/PO sessions only),
never through generic file writes and never through `chrono run`,
which stays reserved for authorized implementation work. A draft Spec
enters as DRAFT with draft-level scope and acceptance criteria; chat
acceptance never marks it approved. Only the signed PO ceremony
advances it toward READY through the normal gates.

## 9. Derived implementation details

Exact schema, granularity heuristics, and revision representation are defined by the Domain/Core specifications. Specification state ownership is fixed to `DRAFT | REVIEW | READY | SUPERSEDED`; derived schemas MUST preserve it.
