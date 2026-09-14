# CHRONO Artifact Model

**Status:** Normative semantic model

## 1. Purpose

This protocol defines persistent CHRONO artifact semantics without fixing TypeScript classes, file formats, database tables, or physical layout.

## 2. Universal artifact contract

Every authoritative artifact MUST support, where applicable: unique identity; type; lifecycle status; revision; authority/owner; provenance; timestamps; relationships; references; traceability; mutability rules; approval requirements; integrity metadata; and supersession history.

References MUST resolve to an existing compatible artifact revision. Deletion MUST NOT silently break traceability. Conversation MUST NOT be an authoritative artifact.

## 3. Core artifact types

- `Project`: aggregate identity, configuration, language, autonomy, runtime, and lifecycle.
- `Requirement`: approved need or quality obligation.
- `BusinessRule`: authoritative domain rule.
- `Constraint`: technical, legal, operational, security, cost, or scope boundary.
- `Decision`: authoritative choice and authority record.
- `OpenQuestion`: unresolved knowledge gap with owner and blocking impact.
- `Architecture`: current approved structural design.
- `ADR`: architectural decision context, choice, alternatives, consequences, and status.
- `Specification`: coherent executable contract derived from approved knowledge.
- `AcceptanceCriterion`: verifiable obligation traceable to a requirement/Spec.
- `Harness`: minimal curated execution context for one executable Spec.
- `Roadmap`: ordered implementation strategy.
- `Module`: meaningful PO-approvable delivery unit.
- `WorkPackage`: assignable unit with inputs, outputs, owner, and dependencies.
- `Task`: implementation step traceable to a Work Package or approved technical requirement.
- `Approval`: explicit authority event bound to scope and revision.
- `Blocker`: condition preventing a defined gate or target.
- `Defect`: verified divergence with classification and routing.
- `Evidence`: immutable or append-only proof produced by tools/agents.
- `QAReport`: Lucca/Spekkio quality evidence and verdict context.
- `SecurityProfile`: versioned threats, trust boundaries, policy, controls, and residual risks.
- `SecurityReport`: Glenn's review and evidence assessment.
- `SecurityBlocker`: material security condition preventing progress.
- `Waiver`: explicit PO acceptance of a known unresolved issue/risk.
- `ChangeRequest`: proposed change with impact analysis and authority status.
- `ProjectState`: persistent lifecycle projection, never conversational memory.
- `RuntimeCapability`: verified runtime ability and configuration.
- `RTKAttestation`: binary identity, version, provenance, integration mode, routing test, timestamp, adapter, bypass events, and savings evidence.
- `SkillAttestation`: mandatory-process-skill upstream, pinned commit, source/generated hashes, converter version, license status, runtime/agent identity, discovery, permission, activation, and timestamp evidence.

## 4. Relationship invariants

- Requirements, rules, constraints, and decisions feed Architecture and Specs.
- Significant architectural Decisions MUST be represented by ADRs.
- Specs MUST reference applicable requirements, rules, constraints, architecture, and ADRs.
- Every executable Spec MUST have exactly one authoritative Harness revision for the execution revision; role-specific contexts are derived views, not independent Harnesses.
- Modules contain Work Packages; Work Packages contain or authorize Tasks and declare dependencies.
- Approvals MUST bind to artifact scope and revision.
- Evidence MUST bind to the implementation/artifact revision it proves.
- Defects, Blockers, Waivers, and ChangeRequests MUST identify affected targets.
- `COMPLETE` requires traceability from implementation through work, acceptance criteria, Specs, and authoritative knowledge where applicable.

## 5. Mutability and history

Approved artifacts MUST NOT be silently overwritten. Material changes MUST create a new revision, preserve history, trigger impact analysis, and invalidate dependent approvals/evidence when assumptions change. Evidence, approvals, verdicts, and waivers SHOULD be append-only.

## 6. Security, RTK, and process-skill invariants

A current SecurityProfile and Architecture Security Approval are required for affected readiness. Current SecurityReport/test evidence and Implementation Security Acceptance are required for final verification/completion. An unresolved SecurityBlocker fails closed.

Every agent-driven CLI execution MUST reference a current RTKAttestation for the active adapter. The accepted upstream is `https://github.com/rtk-ai/rtk`. Missing, incompatible, stale, unhealthy, or bypassed RTK state MUST prevent dispatch.

Every agent execution MUST reference a current SkillAttestation for the pinned `https://github.com/multica-ai/andrej-karpathy-skills` source. Runtime artifacts MUST be deterministically derived from its canonical `skills/karpathy-guidelines/SKILL.md`, semantically equivalent, licensed/attributed, discoverable, permitted, and activation-tested. Invalid or absent state MUST prevent dispatch.

## 7. Identity families

The Domain Model SHOULD derive stable families such as `REQ`, `BR`, `CON`, `DEC`, `ADR`, `SP`, `AC`, `MOD`, `WP`, `TASK`, `APR`, `BLK`, `DEF`, `EVD`, `SEC`, `WAIVER`, and `CR`. Final syntax, scope, and allocation are deferred.

## 8. Validation classes

The Core MUST be able to detect duplicate identities, missing/incompatible references, orphan work, stale revisions, invalid authority, illegal transitions, missing required artifacts, invalid DAG edges/cycles, and broken traceability.

## 8.1 Planning drafts (OC-P11)

Before any Module/WP exists, Gaspar materializes planning drafts of
kind `discovery`, `requirement`, `architecture`, `adr`, `spec`,
`harness-draft`, `security-profile`, `roadmap`, `module`, or
`workpackage` through Core-governed operations only. Drafts are
untrusted DRAFT/PROPOSED material in canonical managed locations;
destinations derive from (kind, id) with no caller-supplied path.
`planning-approval` binds draft ID to exact revision under the same
authenticity rules as all PO decisions; revision changes stale prior
approvals deterministically. Creating the artifacts that define a
Module MUST NOT require an approved Module.

## 9. Normative state and storage ownership

- Project uses `UNINITIALIZED | ANALYZING | ARCHITECTING | SPECIFYING | PLANNING | EXECUTING | VERIFYING | COMPLETE | BLOCKED` and is a deterministic projection that cannot hide child state.
- Specification uses `DRAFT | REVIEW | READY | SUPERSEDED`.
- Module uses `DRAFT | AWAITING_APPROVAL | APPROVED | EXECUTING | VERIFYING | PASSED | FAILED | COMPLETE | BLOCKED`.
- WorkPackage uses `PLANNED | AUTHORIZED | RUNNING | BLOCKED | IMPLEMENTED | VERIFYING | FAILED | COMPLETE`.
- Verification uses `PENDING | RUNNING | FAILED | PASSED | WAIVED`; `WAIVED` is never `PASSED`.

Versioned Markdown/YAML owns human-readable contracts. SQLite at `.chrono/chrono.db` owns atomic operational events, locks, transitions, approvals, attestations, evidence indexes, and migrations. Approval events are human-interactive and cryptographically signed as defined by the Authority protocol. Exact schemas, legal-transition tables, projection precedence, freshness periods, revision hash algorithm, and whether Task is persisted or derived MUST be specified before coding; they may not change these approved semantics.
