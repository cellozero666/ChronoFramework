# CHRONO Framework — Domain Model

**Status:** Normative — Phase 2 deliverable
**Source authority:** `docs/protocols/03-ARTIFACT-MODEL.md`, `docs/protocols/02-AUTHORITY-DECISION-PROTOCOL.md`, `docs/reference/FRAMEWORK-DEFINITION.md`
**Scope:** This document defines the runtime-independent domain entities, their identity and reference rules, ownership, relationships, events, gate conditions, and traceability rules. It is derived exclusively from the approved protocols. No runtime-specific or model-specific concept appears here.

---

## 1. Introduction

The Domain Model is the authoritative conceptual model that the deterministic Core must represent. The Core enforces domain rules; it does not invent them. Every entity, relationship, event, and gate below is traceable to a normative protocol rule. Citation format: `[FW §X]` = Framework Definition Section X, `[P1 §X]` = Protocol 1 Section X, `[REF §X]` = Reference Architecture Section X, `[PL Phase X]` = Implementation Plan Phase X.

### 1.1 Design principles

- **Semantic source**: protocols define meaning; the Core enforces mechanics.
- **Runtime independence**: no OpenCode, Claude Code, Kiro, Codex, Gemini, or provider/model concept appears in this model.
- **Human authority**: the Product Owner holds ultimate authority; all delegation is explicit and revocable.
- **Immutability of approval and evidence**: approval, waiver, evidence, and verification events are append-only.
- **Revision binding**: approvals, evidence, and attestation events bind to an exact artifact revision hash. Material change invalidates dependents.
- **Fail-closed**: any indeterminate, stale, missing, or contradictory mandatory state denies the affected gate.

---

## 2. Identity and Reference Model

### 2.1 Artifact identity families

Artifacts use prefixed identifiers whose families are specified in `[P3.7]`. The final concrete syntax, scope, and allocation are deferred to the Core Specification, but the model defines the families and their semantics.

```text
REQ        Requirement                Product Owner
BR         BusinessRule               Product Owner
CON        Constraint                  Project-wide
DEC        Decision                    Authority that made it
ADR        Architecture Decision       Gaspar (Level 2) / PO (Level 3)
SP         Specification               Gaspar
AC         AcceptanceCriterion         Gaspar (within Spec)
MOD        Module                      Gaspar
WP         WorkPackage                 Gaspar
TASK       Task                        Gaspar
APR        Approval                    Authority that issued it
BLK        Blocker                     Issuing agent/PO
DEF        Defect                      Issuing verifier (Spekkio)
EVD        Evidence                    Producing agent/tool
QA         QAReport                    Spekkio (or agent submitting evidence)
SEC        SecurityProfile             Gaspar + Glenn
WAIVER     Waiver                      Product Owner only
CR         ChangeRequest               Submitting agent
```

> `[P3.7]` Identity families: "The Domain Model SHOULD derive stable families such as `REQ`, `BR`, `CON`, `DEC`, `ADR`, `SP`, `AC`, `MOD`, `WP`, `TASK`, `APR`, `BLK`, `DEF`, `EVD`, `QA`, `SEC`, `WAIVER`, and `CR`."

### 2.2 Unique identity

Every artifact MUST carry a unique identifier within the project scope `[P3.2]`. Composite identity keys (e.g., `SP-002@revision`) MAY be used when revision binding is required `[P3.2]`.

### 2.3 Revision identity

Every authoritative artifact MUST have a revision identifier computed as a deterministic content hash of its canonical serialized form `[P3.5]`. The exact algorithm is specified in the Core Specification. The model requires:

- A material change to artifact content produces a different revision hash.
- Approvals, evidence, attestation, and verification events bind to an exact revision hash `[FW §13]` ("Every signature MUST bind action, scope, artifact identity, exact revision/hash, signer, and timestamp").
- A reference to a stale revision is invalid for execution/verification; the Core MUST detect it `[P7.3]`.

### 2.4 Reference rules

- References MUST resolve to an existing compatible artifact revision `[P3.3]`.
- Deletion MUST NOT silently break traceability `[P3.3]`; deletion is modeled as tombstone/supersession, preserving references.
- Reference resolution is the Core's responsibility `[P5.8]` ("The Core MUST be able to detect missing/incompatible references … broken traceability").
- Unresolved, stale, or incompatible references FAIL validation `[P7.2]`.

### 2.5 Human-readable vs. transactional ownership

- Human-readable authoritative contracts are stored as versioned Markdown/YAML `[P3.9, FW §13]`.
- Transactional operational state (events, locks, transitions, approvals, attestations, evidence indexes, migrations) is stored in `.chrono/chrono.db` (SQLite) `[P3.9, FW §13, REF §24]`.
- SQLite does NOT replace documents as contracts `[P3.9]`. The model treats documents as the reviewable contract and SQLite as the transactional event store.

---

## 3. Domain Entities

### 3.1 Project

**Purpose**: aggregate root of all authoritative project state `[P3.8]`.

**Attributes**:
- `id`: UUID
- `language`: IETF BCP 47 tag (default `en`) `[FW §23]`
- `gasparAutonomy`: `SUPERVISED` | `SEMI_AUTONOMOUS` | `AUTONOMOUS` (default `SEMI_AUTONOMOUS`) `[P2.4]`
- `runtime`: PO-selected runtime identifier (no default) `[FW §22]`
- `createdAt`, `updatedAt`

**State machine**: see `STATE-MODEL.md`.

**Ownership**: Product Owner. The project itself is not delegated.

### 3.2 Requirement (`REQ`)

**Purpose**: an approved need or quality obligation `[P3.3]`.

**Attributes**:
- `id`
- `type`: functional | non-functional | quality
- `description`
- `priority` / `criticality`
- `source`: PO decision | system analysis | …
- `status`: approved | draft | ... (must be approved before Specs consume it)

**Relationships**: Requirements feed Architecture and Specs `[P3.4]`. Acceptance Criteria trace to Requirements `[FW §14]`.

### 3.3 BusinessRule (`BR`)

**Purpose**: an authoritative domain rule `[P3.3]`.

**Attributes**: same general contract as Requirement.

**Relationships**: feeds Architecture and Specs `[P3.4]`.

### 3.4 Constraint (`CON`)

**Purpose**: a technical, legal, operational, security, cost, or scope boundary `[P3.3]`.

**Relationships**: feeds Architecture and Specs `[P3.4]`.

### 3.5 Decision (`DEC`)

**Purpose**: an authoritative choice and authority record `[P3.3]`.

**Attributes** `[P2.5]`:
- `id`
- `subject`: the decision topic
- `value`: the selected choice
- `level`: `LEVEL_1` | `LEVEL_2` | `LEVEL_3` `[P2.3]`
- `authority`: who may make this decision
- `status`: proposed | approved | rejected
- `rationale`
- `provenance`
- `timestamp`
- `affects`: list of artifact references

**Levels** `[P2.3, FW §18]`:
- **Level 1 — Implementation**: compatible with approved contracts; responsible agent may decide `[P2.3]`
- **Level 2 — Architecture**: Gaspar; creates/modifies ADRs `[P2.3]`
- **Level 3 — Product / significant architecture**: requires explicit PO decision `[P2.3]`

**Relationships**: Decisions feed Architecture, ADRs, and Specs `[P3.4]`. Conflicting active decisions block readiness `[P2.5]`.

### 3.6 OpenQuestion (`OPEN`)

**Purpose**: an unresolved knowledge gap with owner and blocking impact `[P3.3]`.

**Attributes**:
- `id`
- `question`
- `owner`: Gaspar | PO | agent
- `blocking`: boolean
- `blockingImpact`: description of what is blocked
- `status`: open | resolved | obsolete

### 3.7 Architecture

**Purpose**: the current approved structural design `[P3.3]`.

**Attributes**:
- `revision` (content hash)
- `status`: proposed | under-review | approved | superseded
- `content`: structural description (components, data, interfaces, integrations, runtime/deployment, security, observability, testing, recovery) `[P4.2]`

**Relationships**: Requirements, Business Rules, Constraints, and Decisions feed Architecture `[P3.4]`. Specs consume approved Architecture `[P5.1, P4.7]`.

**Rules**:
- Must be distinguished from proposed and approved architecture `[P4.2]`.
- Architecture MUST NOT be hidden inside code, Specs, or prompts `[P4.9]`.
- Material changes to Architecture MUST create/supersede ADRs `[P4.7]`.

### 3.8 ADR (`ADR`)

**Purpose**: an architectural decision record `[P3.3]`.

**Attributes** `[P4.5]`:
- `id`
- `title`
- `status`: proposed | accepted | rejected | superseded | deprecated `[P3.9]`
- `context`
- `decision`
- `alternatives`
- `consequences`
- `affectedArtifacts`
- `authority`
- `approval`: Approval reference when required
- `securityImpact`
- `supersededBy`: optional ADR reference
- `provenance`

**Relationships**: Significant Decisions MUST be represented by ADRs `[P3.4]`. Active ADRs MUST NOT conflict with explicit PO decisions or each other `[P4.6]`. Specs reference applicable ADRs `[P5.1, FW §17]`.

### 3.9 Specification (`SP`)

**Purpose**: a coherent, verifiable system contract `[FW §17, P5.2]`.

**Attributes** `[P5.3]`:
- `id`
- `title`, `purpose`
- `revision` (content hash)
- `status`: `DRAFT` | `REVIEW` | `READY` | `SUPERSEDED` `[P3.9, FW §11]`
- `inScope` / `outOfScope`
- `functionalRequirements` / `nonFunctionalRequirements`
- `businessRules` (references)
- `architecture` (references)
- `adrs` (references)
- `dependencies` (Spec references)
- `dataImpact`
- `interfaces` / `contracts`
- `securityRequirements` (references to SecurityProfile)
- `scenarios` (normal, error, abuse, boundary, recovery)
- `acceptanceCriteria` (references to AcceptanceCriterion)
- `testEvidenceRequirements`
- `changeControl`
- `revisionOf` / `supersedes`

**Relationships**:
- Every executable Spec MUST have exactly one authoritative Harness `[P3.4, P6.1]`.
- Spec is a contract; MUST NOT become a design notebook `[P5.8]`.
- Approved Specs MUST NOT be silently modified `[FW §19, P5.7]`.

**State**: defined in STATE-MODEL.md.

### 3.10 AcceptanceCriterion (`AC`)

**Purpose**: a verifiable obligation traceable to a Requirement or Spec `[P3.3]`.

**Attributes**:
- `id`
- `description`
- `testable`: boolean
- `traceability`: reference to Requirement or Spec
- `mandatory`: boolean (mandatory vs. recommendation) `[P5.4]`
- `security`: boolean (negative/security case) `[P5.4]`

### 3.11 Harness

**Purpose**: minimal curated execution context for one executable Spec `[P6.1]`.

**Attributes**:
- `specRevision`: reference to exact Spec revision
- `relevantRequirements`, `relevantBusinessRules`, `relevantConstraints` (references)
- `relevantAdrs` (references)
- `dependentSpecs` (references + dependency state)
- `architectureExcerpts` (references)
- `sourcePaths` (references + repository revision)
- `conventions`
- `acceptanceCriteria`
- `definitionOfReady`, `definitionOfDone`
- `assignedRoles`
- `securityProfileReference`
- `rtkAttestationReference`
- `skillAttestationReference`
- `moduleApprovalContext`
- `revision` (content hash) — one authoritative Harness per executable Spec revision `[P3.4, P6.1]`

**Rules**:
- Role-specific contexts are derived views, not independent Harnesses `[P6.1]`.
- Stale when any referenced artifact changes materially `[P6.7]`.
- Execution with a stale Harness MUST be denied `[P6.7]`.

### 3.12 Roadmap

**Purpose**: ordered implementation strategy `[FW §17, P8.2]`.

**Attributes**:
- `revision`
- `modules`: ordered list of Module references
- `notes`

### 3.13 Module (`MOD`)

**Purpose**: a meaningful PO-approvable delivery unit `[P3.3, FW §17]`.

**Attributes**:
- `id`
- `name`
- `purpose`
- `specs` (references, all Must be `READY`)
- `workPackages` (references)
- `dependencies` (Module references)
- `risks`
- `securityStatus`
- `approval` (Approval reference, bound to exact revision) `[P8.4, FW §12]`

**State machine**: defined in STATE-MODEL.md. `[FW §11, P3.8, P3.9]`

### 3.14 WorkPackage (`WP`)

**Purpose**: an assignable unit with inputs, outputs, owner, and dependencies `[P3.3, FW §17]`.

**Attributes**:
- `id`
- `name`
- `module` (reference)
- `inputs`, `outputs`
- `assignedRole`: Gaspar | Belthazar | Melchior | Prometheus | Lucca | Glenn | Spekkio
- `dependsOn`: list of WP references `[FW §17, P8.3]`
- `tasks` (references or derived)
- `evidenceRequirements`

**State machine**: defined in STATE-MODEL.md. `[FW §11, P3.8, P3.9]`

**Rules**:
- Every dependency MUST reference an existing target and declare why `[P8.3]`.
- The Core MUST reject cycles, missing nodes, inconsistent states `[P8.3]`.
- Work Packages declare dependencies; DAG must be acyclic `[FW §17]`.

### 3.15 Task (`TASK`)

**Purpose**: an implementation step traceable to a Work Package or approved technical requirement `[P3.3, FW §14]`.

**Attributes**:
- `id`
- `workPackage` (reference)
- `description`
- `traceability`: reference to AcceptanceCriterion, Requirement, or Spec `[FW §14]`
- `assignedRole`

**Rule**: Every implementation task MUST be traceable to an approved Spec or documented technical requirement `[FW §14]`. Untraceable changes are suspicious `[FW §14]`.

> Whether Task is persisted or derived is deferred to the Core Specification `[P3.9]`.

### 3.16 Approval (`APR`)

**Purpose**: explicit authority event bound to scope and revision `[P3.3, FW §12]`.

**Attributes** `[FW §13, P2.10]`:
- `id`
- `action`: module-approval | waiver | risk-acceptance | architecture-security | implementation-security
- `scope`: artifact reference + revision hash
- `authority`: who issued it
- `signer`: PO identity
- `signature`: cryptographic signature
- `timestamp`
- `rationale`

**Rules**:
- Append-only `[FW §13, P3.5]`.
- MUST bind to exact action, scope, artifact identity, revision/hash, signer, timestamp `[FW §13, P2.10]`.
- Material change to bound artifact invalidates the signature `[FW §13, P2.10]`.
- Issued ONLY through interactive human-only `chrono approve`/`waive`/risk commands `[P2.10, FW §13]`.
- Signing key outside project and agent context, preferably OS keychain `[FW §13]`.
- Agents/adapters MUST NOT impersonate or automate PO approval `[P2.10, FW §13]`.

### 3.17 Blocker (`BLK`)

**Purpose**: a condition preventing a defined gate or target `[P3.3, FW §7]`.

**Types** (derived from protocol-required failure modes):
- `PRODUCT_BLOCKER` — product ambiguity preventing architecture `[P1.6]`
- `SECURITY_BLOCKER` — material security condition `[FW §9, P1.6]`
- `APPROVAL_REQUIRED` — missing/invalid/interactive approval `[P2.10, FW §12]`
- `EXECUTION_DENIED` — authorization denied for dispatch `[P8.5, P7.5]`
- `COMPLETION_DENIED` — completion denied `[FW §10, P9.3]`
- `BLOCKED_RTK` — RTK missing/stale/incompatible/bypassed `[P1.4, P7.3]`
- `BLOCKED_PROCESS_SKILL` — Karpathy Guidelines missing/divergent/inactive/bypassed `[P1.4, P6.7, P7.3]`

**Attributes**:
- `id`
- `type`
- `issuer`: agent identity or system
- `target`: affected artifact(s)
- `reason`
- `evidence` (references)
- `createdAt`, `resolvedAt` (nullable)
- `resolvedBy` (nullable)

**Rules**:
- Blocker classification and existence MUST block the named target/gate `[P7.3]`.
- Resolved blockers may unblock only when deterministic validation proves independence `[P7.5]`.

### 3.18 Defect (`DEF`)

**Purpose**: a verified divergence with classification and routing `[P3.3, FW §7]`.

**Attributes** `[FW §8, P9.5]`:
- `id`
- `classification`: one of the defect routing types (§3.18.1)
- `severity`
- `evidence` (references)
- `affectedCriteria` / `affectedArtifacts`
- `owner`: responsible agent
- `blockingScope`
- `reproInfo`
- `createdAt`, `resolvedAt` (nullable)

**Defect routing** `[FW §8, P9.5]`:
```text
IMPLEMENTATION_DEFECT → Belthazar
UX_DEFECT             → Melchior
INFRASTRUCTURE_DEFECT → Prometheus
TEST_DEFECT           → Lucca
SECURITY_DEFECT       → Glenn
ARCHITECTURE_DEFECT   → Gaspar
SPECIFICATION_DEFECT  → Gaspar
PRODUCT_AMBIGUITY     → Product Owner
```

**Rules**:
- A Defect MUST exist only after Spekkio verification fails `[P9.4]`.
- The responsible agent corrects without changing elements outside its authority `[FW §8]`.
- Affected verification MUST be re-run after correction `[FW §8]`.

### 3.19 Evidence (`EVD`)

**Purpose**: immutable or append-only proof produced by tools/agents `[P3.3, P9.2]`.

**Attributes** `[P9.2]`:
- `id`
- `producer`: agent/tool identity
- `tool` / `model` (as configured; never hardcoded — see §4)
- `timestamp`
- `targetRevision`: the implementation/artifact revision proven
- `command` / `check`
- `result`: pass | fail | value
- `diagnostics`: retained diagnostics
- `integrity`: content hash

**Rules** `[P9.2]`:
- MUST identify producer, tool/model, timestamp, target revision, command/check, result, retained diagnostics, integrity/provenance.
- MUST bind to the implementation/artifact revision it proves `[P3.4]`.

### 3.20 QAReport (`QA`)

**Purpose**: Spekkio's quality evidence and verdict context `[P3.3]`.

**Attributes**:
- `id`
- `module` / `workPackage` reference
- `verdict`: `PASS` | `FAILED` | `WAIVED` `[FW §6, P9.4]`
- `reviewedEvidence`: list of Evidence references
- `defects`: list of Defect references (when FAILED)
- `waivers`: list of Waiver references (when WAIVED)
- `reviewer` (Spekkio role identity)
- `timestamp`

**Rules**:
- `WAIVED` MUST remain distinct from `PASS` `[FW §6, P2.8]`.
- Spekkio MUST NOT be forced to issue `PASS` `[FW §2]`.
- PASS requires no blocking defects and current security evidence `[P9.5]`.

### 3.21 SecurityProfile (`SEC`)

**Purpose**: versioned threats, trust boundaries, data classification, authentication, authorization, secrets, dependencies, infrastructure exposure, logging/privacy, test strategy, accepted risks, required evidence, controls `[P1.6, FW §9, REF §27]`.

**Attributes**:
- `id`
- `version` (incremented on material change)
- `assets`, `threatActors`, `trustBoundaries`
- `dataClassification`
- `authn`, `authz`
- `secretsPolicy`
- `dependencyPolicy`
- `infraExposure`
- `loggingPrivacy`
- `abuseCases`
- `controls`: recommended + implemented
- `rejectedAlternatives`
- `residualRisks`
- `testStrategy`
- `evidenceRequirements`
- `provenance`, `createdAt`, `updatedAt`

**Relationships**: Required for affected readiness `[P6.5, P5.5]`. Two PO security decisions depend on it `[P4.4, P9.3]`.

### 3.22 SecurityReport

**Purpose**: Glenn's review and evidence assessment `[P3.3]`.

**Attributes**:
- `id`
- `targetRevision`
- `findings`: list of security findings
- `controlsAssessed`: list
- `residualRisk`
- `recommendation`
- `verdict`: approve | reject | needs-work
- `reviewer` (Glenn)
- `timestamp`

### 3.23 SecurityBlocker

**Purpose**: material security condition preventing progress `[P3.3]`.

**Model**: A subclass/specialization of Blocker with type `SECURITY_BLOCKER`. Glenn issues it `[FW §9, P1.6]`.

**Rules**:
- Glenn's unresolved material `SECURITY_BLOCKER` prevents affected execution or completion `[FW §9, P2.7]`.
- Must remain distinct from risk acceptance `[P2.8]`.

### 3.24 Waiver (`WAIVER`)

**Purpose**: explicit PO acceptance of a known unresolved issue/risk `[P3.3, FW §6]`.

**Attributes** `[P2.8, FW §6]`:
- `id`
- `issue`: description
- `scope`: affected artifact(s) + revision
- `rationale`
- `evidence` (references)
- `acceptingAuthority`: PO identity
- `compensatingControls`
- `followUp`: task/reference
- `expiryReviewCondition`
- `timestamp`

**Rules** `[P2.8, FW §6]`:
- Only Product Owner MAY accept residual security or product risk `[P2.8, FW §9]`.
- MUST record issue, scope, rationale, evidence, accepting authority, timestamp, compensating controls, follow-up, and expiry/review condition.
- `WAIVED` MUST remain distinct from `PASS` `[P2.6, P9.3]`.
- Expired or invalidated waivers MUST block the affected gate `[P2.8]`.

### 3.25 ChangeRequest (`CR`)

**Purpose**: proposed change with impact analysis and authority status `[P3.3, FW §19]`.

**Attributes** `[FW §19, P4.7, P5.7]`:
- `id`
- `subject`
- `proposedChange`
- `impactAnalysis`: affected requirements/architecture/ADRs/Specs/Harnesses/WPs/tests/security/roadmap-DAG
- `authority`: Gaspar | PO
- `status`: proposed | approved | rejected | implemented
- `supersedes` / `affected`
- `rationale`, `provenance`, `timestamp`

**Rules** `[FW §19, P5.7]`:
- Initiated when a change affects product behavior, business rules, architecture, contracts, scope, or significant security assumptions.
- Approved Specs MUST NOT be silently modified during implementation `[FW §19, P5.7]`.
- Material change MUST create a new revision, preserve history, trigger impact analysis, invalidate dependent approvals/evidence `[P3.5]`.

### 3.26 RuntimeCapability

**Purpose**: verified runtime ability and configuration `[P3.3]`.

**Model**: Runtime-neutral. The model stores a capability descriptor (runtime type, dispatch proven, gate-hook proven, version) without embedding provider/model specifics. `[FW §21, P8.6, P1.4]`.

### 3.27 RTKAttestation (`RTK`)

**Purpose**: binary identity, version, provenance, integration mode, routing test, timestamp, adapter, bypass events, savings evidence `[P3.3]`.

**Attributes** `[P6.5, P1.4, REF §13]`:
- `binaryPath` / `binaryIdentity`
- `version`
- `provenance`: confirmed from `https://github.com/rtk-ai/rtk` (the canonical and only accepted upstream) `[P6.5, REF §13, FW §24]`
- `integrationMode`
- `routingTest`: result of command-routing self-test
- `adapter`
- `bypassEvents`: list
- `savingsEvidence`
- `timestamp`
- `status`: current | stale | invalid

**Rules** `[P6.5, P1.4, REF §13, P8.5]`:
- Every agent-driven CLI execution MUST reference a current RTKAttestation `[P6.5]`.
- Missing, stale, incompatible, unhealthy, or bypassed RTK MUST prevent dispatch `[P6.5, REF §13, P8.7]`.
- `rtk gain` must succeed to prove the binary is Rust Token Killer, not the collision package `[P1.4, REF §13]`.
- Configuration-file presence is NOT proof of operation `[P8.7]`.

### 3.28 SkillAttestation (`SKILL`)

**Purpose**: mandatory-process-skill upstream, pinned commit, source hash, generated hashes, converter version, license/attribution, runtime/agent identity, discovery, permission, activation, timestamp `[P3.3]`.

**Attributes** `[P6.6, P1.4, REF §13, P8.6, P9.8]`:
- `upstream`: `https://github.com/multica-ai/andrej-karpathy-skills` (canonical and only accepted) `[P6.6, REF §13]`
- `pinnedCommit`
- `sourceHash`: hash of `skills/karpathy-guidelines/SKILL.md`
- `generatedHashes`: per-runtime artifact hashes (Claude, OpenCode, Kiro) `[REF §13, P8.6]`
- `converterVersion`
- `licenseStatus` / `attribution` (MIT) `[REF §13, P8.6]`
- `runtimeIdentity` / `agentIdentity`
- `discoveryResult`
- `permissionResult`
- `activationSmokeTest`
- `timestamp`
- `status`: current | stale | invalid

**Rules** `[P6.6, P1.4, REF §13, P8.5, P8.6, P9.8]`:
- Every agent execution MUST reference a current SkillAttestation `[P6.6]`.
- The canonical upstream is pinned to an immutable reviewed commit `[P1.4, REF §13]`.
- Runtime artifacts MUST be deterministically generated from `skills/karpathy-guidelines/SKILL.md`, semantically equivalent, licensed/attributed, discoverable, permitted, activation-tested `[P6.6, P8.6]`.
- Missing, modified, untrusted, divergent, inactive, or bypassed skill state MUST block dispatch `[P6.6, REF §13, P8.6, P8.7]`.
- LLM rewriting of the skill is forbidden `[REF §13]`.

---

## 4. Model-Level Rules

### 4.1 Gaspar autonomy and delegation

- Gaspar's autonomy mode is PO-configured: `SUPERVISED` | `SEMI_AUTONOMOUS` | `AUTONOMOUS` (default `SEMI_AUTONOMOUS`) `[P2.4, FW §5]`.
- No mode permits Gaspar to invent requirements, silently change business rules, exceed approved scope, override explicit PO decisions, or accept risk for the PO `[P2.3, P2.1, FW §5]`.
- Gaspar may make autonomous decisions only when they are direct consequences of approved architecture, ADRs, established standards, approved requirements, previous PO decisions, or technical practices that do not alter product/business/scope/significant-architecture `[P2.2, FW §5]`.
- Gaspar may block when specifications are incomplete, decisions unresolved, artifacts inconsistent, or execution unsafe `[FW §5]`.

### 4.2 Product Owner authority

- The Product Owner is the highest authority over product, business rules, scope, significant architecture, risk acceptance, and authority conflicts `[P2.1, FW §5]`.
- No agent MAY override an explicit PO decision `[P2.1, FW §5]`.
- Two mandatory PO security decisions: Architecture Security Approval and Implementation Security Acceptance `[P2.6, P4.4, P9.3, FW §10]`.

### 4.3 Spekkio authority boundary

- Gaspar cannot override a Spekkio quality failure `[FW §5, P2.7]`.
- Spekkio cannot override architecture to make work pass `[FW §2, P2.7]`.
- Authority conflicts escalate to the Product Owner `[FW §5, P2.7]`.

### 4.4 Model/provider neutrality (domain rule, not implementation)

- No provider, model name, or model version appears in domain state `[FW §22, P1.4]`.
- Model selection is PO-owned external configuration; the domain stores only "PO-selected, model name omitted from policy" `[FW §22]`.
- Changing the model MUST NOT change authority, state, gates, evidence requirements, or behavior `[FW §22]`.

### 4.5 Security as cross-cutting (domain rule)

- Security accompanies architecture, specification, implementation, infrastructure, testing, and verification `[FW §9]`.
- The Security Profile and both PO security decisions are mandatory for their respective gates `[P3.6, P6.5, P5.5, P9.3]`.
- Material changes to threats, trust boundaries, dependencies, controls, infrastructure, or implementation assumptions invalidate affected security decisions `[P2.6, REF §27]`.
- All agents operate under least privilege, deny-by-default, secret non-disclosure, input/output validation, dependency provenance, safe tool use `[FW §10]`.

### 4.6 Approval authenticity (domain rule)

- PO approval, waiver, and risk acceptance MUST be human-interactive `[P2.10, FW §13]`.
- Signing key outside project and agent context, preferably OS keychain `[P2.10, FW §13]`.
- Signature binds action, scope, artifact identity, revision/hash, signer, timestamp `[P2.10, FW §13]`.
- Missing interactivity, identity, key, or signature validity → `APPROVAL_REQUIRED` `[P2.10, FW §13]`.
- Agents CANNOT impersonate or automate PO approval `[P2.10, FW §13]`.

### 4.7 RTK and process-skill as domain state

- RTKAttestation is mandatory for every agent-driven CLI execution `[P6.5, P3.6]`; its absence is `BLOCKED_RTK`.
- SkillAttestation is mandatory for every agent execution `[P6.6, P3.6]`; its absence is `BLOCKED_PROCESS_SKILL`.
- RTK is external to domain ownership; it does not define CHRONO state/governance/lifecycle `[REF §13, P6.5]`.

---

## 5. Core Events

### 5.1 Event types

| Event | Source | Effect |
|---|---|---|
| `ArtifactCreated` | Core / Gaspar | New artifact enters lifecycle |
| `ArtifactRevised` | Gaspar / agent | New revision hash; invalidates dependents |
| `StateTransition` | Core | Legal move in an entity's state machine |
| `ApprovalGranted` | PO (interactive) | Approval event persisted |
| `WaiverGranted` | PO (interactive) | Waiver event persisted |
| `BlockerRaised` | Agent / Core | Blocker active; blocks target gate |
| `BlockerResolved` | Responsible authority | Target gate re-evaluated |
| `DefectRaised` | Spekkio | Defect classified and routed |
| `DefectResolved` | Responsible agent | Re-verification triggered |
| `EvidenceRecorded` | Lucca / Glenn / agent | Evidence binds to revision |
| `RtKAttested` | Core / setup | RTK attestation current |
| `SkillAttested` | Core / setup | Skill attestation current |
| `ModuleCompleted` | Core | Module → COMPLETE |

### 5.2 Event sourcing invariants

- Approval, Waiver, and Evidence events are append-only `[FW §13, P3.5]`.
- Events are transactional in SQLite under the project `[P3.9]`.
- Every event carries a monotonic sequence number and timestamp.
- No event may bypass a gate; the Core validates each transition before persisting `[P7.5]`.

---

## 6. Gate Conditions (domain view)

Gates are the conditions that must hold for the Core to permit a transition. Each is a deterministic domain rule.

### 6.1 System Analysis completion `[P1.7-8]`

- Purpose, primary actors, critical workflows, business rules, constraints, integrations, and existing PO decisions are persisted.
- Repository inspected when applicable.
- Open questions classified and routed.
- Security Profile current enough for architecture.
- No `PRODUCT_BLOCKER` prevents architecture.
- Gaspar records evidence that architecture can begin without inventing product requirements.

### 6.2 Architecture approval `[P4.8]`

- Applicable decisions and ADRs resolved.
- Security Profile updated; threat model performed.
- Architecture Security Approval current (PO).
- Deterministic references validate.
- Semantic review passes.
- No blocking inconsistency remains.

### 6.3 Specification `READY` `[P5.6]`

- Scope and exclusions clear.
- Requirements and acceptance criteria traceable.
- Applicable architecture/ADRs and security decisions approved/current.
- Contracts, data impact, errors, edge cases, and dependencies sufficient.
- No blocking decision or inconsistency.
- Authoritative Harness exists and validates.
- Deterministic and semantic validation pass.
- Planning artifacts and module approval exist when execution requested.

### 6.4 Execution authorization `[P8.5]`

- Target, Spec, Module, Work Package, assigned role exist.
- Spec is `READY` and Harness is current.
- Architecture and security approvals current.
- Module approval covers the target revision.
- Dependencies satisfied; no blocker.
- Runtime capabilities and least-privilege permissions valid.
- Genuine RTK installation healthy and routing `[P8.5, P1.4]`.
- Pinned Karpathy Guidelines skill trusted, equivalent, discoverable, permitted, activation-tested `[P8.5, P1.4]`.
- No relevant artifact changed after validation/approval.

### 6.5 Verification `[P9.3]`

- Current test/security evidence exists.
- Implementation security decision current.
- No missing/stale/contradictory security evidence.

### 6.6 Completion `[P9.3, FW §16]`

- Implementation matches approved Specs.
- Acceptance criteria verified.
- Required automated tests pass.
- Lucca evidence current.
- Security blockers resolved or validly waived.
- Glenn evidence current.
- PO implementation-security decision current.
- Security evidence and approvals current for implemented revision.
- Documentation synchronized.
- No blocking defect remains.
- Spekkio PASS.
- RTKAttestation and SkillAttestation current.
- Traceability intact.
- Legal state transition.

---

## 7. Traceability Rules

- Implementation Task → Work Package → AcceptanceCriterion → Requirement → Specification → ADR `[FW §14]`.
- Not every implementation contains every level, but no task exists without an approved Spec or documented technical requirement `[FW §14]`.
- Evidence MUST bind to target revision `[P3.4]`.
- Approvals MUST bind to artifact scope and revision `[P3.4]`.
- Untraceable changes are suspicious and examined during verification `[FW §14]`.
- COMPLETE requires traceability from implementation through work, acceptance criteria, Specs, and authoritative knowledge `[P3.4]`.

---

## 8. Relationships Summary

```text
Project
├── Requirements (REQ) ──┐
├── BusinessRules (BR) ──┤
├── Constraints (CON) ───┤
│                         ├──→ Architecture ──→ ADRs
│                         ├──→ Decisions (DEC)
│                         └──→ Specifications (SP) ──→ Harnesses (per SP revision)
│                                        │              │
│                                        │              └──→ Source paths, roles,
│                                        │                  security, RTK/Skill refs
│                                        │
│                                        ├──→ AcceptanceCriteria (AC)
│                                        │
│                                        ├──→ dependent Specs (DAG edge)
│                                        │
│                                        └──→ Modules (MOD) ──→ WorkPackages (WP)
│                                                               │       │
│                                                               │       └──→ Tasks
│                                                               │
│                                                               └──→ approvals (APR, bound to revision)
│
├── SecurityProfile (SEC) ──→ SecurityReports ──→ SecurityBlockers
├── OpenQuestions (OPEN)
├── Blockers (BLK)
├── Defects (DEF) ──→ routed to responsible agent
├── Evidence (EVD)
├── QAReports (QA)
├── Waivers (WAIVER)
├── ChangeRequests (CR)
├── RuntimeCapabilities
├── RTKAttestations (RTK)
└── SkillAttestations (SKILL)
```

---

## 9. Model Completeness Check

Every entity above has a `[Px §Y]` traceability citation to a normative protocol. No runtime-specific, provider-specific, or model-specific concept is modeled here. Runtime/provider/model specifics appear only as PO-owned configuration that the Core stores opaquely without embedding defaults (§4.4).
