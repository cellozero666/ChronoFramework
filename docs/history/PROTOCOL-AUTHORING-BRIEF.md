# CHRONO — Protocol-Authoring Brief (Historical)

> Historical record only. Current navigation and authority are defined in the [documentation index](../README.md); paths below have been normalized to the current repository structure.

You are working on the CHRONO Framework repository.

The conceptual definition and high-level architecture of CHRONO already exist. Your current task is **NOT to implement the framework, write application code, redesign the architecture, or simplify the existing concepts**.

Your task is to transform the existing conceptual architecture into a set of **formal, normative protocol documents** that will later be used to derive the CHRONO domain model, deterministic Core, state machine, schemas, validators, runtime interface, and implementation.

All documents created in this phase MUST be written in English and saved under:

```text
docs/protocols
```

Create the directory if it does not exist.

---

# 1. Authoritative Sources

Before writing anything, read the existing CHRONO documentation available in the repository, especially:

```text
docs/reference/FRAMEWORK-DEFINITION.md
docs/architecture/REFERENCE-ARCHITECTURE.md
```

Treat these documents as the current architectural source of truth.

Do not silently replace, reinterpret, or simplify decisions already established there.

If the two documents appear to conflict:

1. identify the conflict;
2. determine whether the newer architecture document explicitly refines an older concept;
3. preserve the most recently established architectural intent when the refinement is clear;
4. otherwise document the ambiguity instead of inventing a resolution.

The purpose of this task is to **formalize the existing CHRONO design**, not redesign it.

---

# 2. Current CHRONO Definition

CHRONO is a:

> Runtime-independent, human-governed, multi-agent software architecture and Spec-Driven Development framework.

It is specifically intended to prevent vibe coding by enforcing a controlled engineering lifecycle.

CHRONO is NOT:

- a prompt collection;
- a skill collection;
- an agent persona package;
- a vibe-coding orchestrator;
- an OpenCode extension;
- a Claude Code extension;
- an MCP server pretending to be the framework;
- a workflow that depends on one particular LLM.

Skills, prompts, hooks, MCP tools, runtime-specific agents, instruction files, and similar mechanisms may exist inside runtime adapters.

They are not the CHRONO Framework itself.

The architectural boundary is:

```text
CHRONO
│
├── DOCUMENTATION / PROTOCOLS
│      define what CHRONO means
│
├── DETERMINISTIC CORE
│      enforces what can be enforced by software
│
├── AGENT DEFINITIONS
│      provide semantic intelligence and specialized roles
│
└── RUNTIME ADAPTERS
       translate CHRONO behavior into
       OpenCode, Claude Code, Kiro, Codex, Gemini, etc.
```

A fundamental principle is:

> LLMs perform semantic engineering work. Deterministic software enforces process invariants.

---

# 3. Current Development Stage

CHRONO is currently between:

```text
VISION                         COMPLETE
    ↓
INITIAL.md                     COMPLETE
    ↓
FRAMEWORK ARCHITECTURE         COMPLETE
    ↓
FORMAL PROTOCOLS               COMPLETE
    ↓
DOMAIN MODEL                   ← NEXT PHASE
    ↓
CORE SPECIFICATION
    ↓
RUNTIME INTERFACE
    ↓
FIRST RUNTIME ADAPTER
    ↓
MVP IMPLEMENTATION
```

Do NOT skip directly to implementation.

We need to formally specify the behavior of the framework before deriving the software architecture from it.

CHRONO itself follows:

> UNDERSTAND → SPECIFY → IMPLEMENT

The CHRONO framework should be developed according to the same principle.

The ordered execution roadmap for the subsequent phases is maintained in
[`docs/implementation/IMPLEMENTATION-PLAN.md`](../implementation/IMPLEMENTATION-PLAN.md). That roadmap does not authorize implementation before the
formal protocols and their derived domain model pass their respective review
gates.

---

# 4. Documentation to Produce

Create the following documents under `docs/protocols`:

```text
docs/protocols
├── 01-SYSTEM-ANALYSIS-PROTOCOL.md
├── 02-AUTHORITY-DECISION-PROTOCOL.md
├── 03-ARTIFACT-MODEL.md
├── 04-ARCHITECTURE-ADR-PROTOCOL.md
├── 05-SPECIFICATION-PROTOCOL.md
├── 06-HARNESS-PROTOCOL.md
├── 07-CONSISTENCY-VALIDATION-PROTOCOL.md
├── 08-ROADMAP-EXECUTION-PROTOCOL.md
└── 09-VERIFICATION-CORRECTION-PROTOCOL.md
```

These documents together define the formal CHRONO lifecycle.

They should reference one another where appropriate instead of duplicating entire definitions.

---

# 5. Normative Language

These are protocol specifications, not essays.

Use normative language consistently.

Prefer terms such as:

```text
MUST
MUST NOT
SHOULD
SHOULD NOT
MAY
```

Use `MUST` for framework invariants.

Use `SHOULD` for recommended behavior that may legitimately vary.

Use `MAY` for optional behavior.

Avoid vague language such as:

```text
normally
probably
ideally
maybe
could perhaps
```

when defining framework behavior.

Clearly distinguish:

```text
REQUIRED
OPTIONAL
IMPLEMENTATION-DEFINED
RUNTIME-SPECIFIC
PROJECT-CONFIGURABLE
```

Do not accidentally turn implementation suggestions into protocol requirements.

---

# 6. Document 01 — System Analysis Protocol

Create:

```text
docs/protocols/01-SYSTEM-ANALYSIS-PROTOCOL.md
```

This document formalizes Gaspar's behavior from CHRONO initialization until enough system understanding exists to proceed into architecture.

Gaspar is explicitly:

```text
Systems Analyst
Software Architect
Orchestrator
```

During this phase, his primary role is **Systems Analyst**.

The protocol must define:

- initialization of system analysis;
- greenfield vs. existing-project discovery;
- repository inspection;
- existing CHRONO state detection;
- existing documentation inspection;
- adaptive Product Owner interview;
- requirement discovery;
- actor discovery;
- workflow discovery;
- business-rule discovery;
- constraint discovery;
- integration discovery;
- data-domain discovery;
- security concern discovery;
- infrastructure constraint discovery;
- technical preference discovery;
- existing Product Owner decision discovery;
- open-question management;
- ambiguity detection;
- gap analysis;
- blocker classification;
- persistence of discovered knowledge;
- completion criteria for System Analysis.

The interview MUST NOT be a fixed questionnaire.

Gaspar must adapt subsequent questions according to:

- project type;
- existing repository;
- previous Product Owner answers;
- existing decisions;
- discovered constraints;
- unresolved gaps.

Example:

If the Product Owner already states:

```text
Backend: Node.js
Database: PostgreSQL
Frontend: React
UI: Bootstrap
Strategy: mobile-first
```

Gaspar MUST record these decisions and MUST NOT ask the Product Owner to choose those technologies again.

Instead, Gaspar should investigate relevant missing information.

For PostgreSQL, this may include questions about:

```text
single-tenant vs multi-tenant
organizations
data isolation
relationships
scale
retention
```

For authentication:

```text
registration
email verification
password recovery
MFA
session behavior
RBAC
external identity providers
```

The exact questions depend on the system.

Define a deterministic conceptual discovery hierarchy:

```text
1. Persistent authoritative project context
2. ADRs
3. Approved Specs
4. Existing repository/project evidence
5. Agent-authorized technical decision
6. Ask / escalate to Product Owner
```

Gaspar MUST NOT interrupt the Product Owner for information that can be reliably discovered from authoritative artifacts or repository evidence.

The protocol must explicitly define **when Gaspar may stop asking questions**.

It must also require Gaspar and Glenn to produce a versioned Security Profile and obtain an explicit, persistent Product Owner architecture-security decision before affected Specs may become `READY`. The decision must record selected controls, rejected alternatives, residual risks, rationale, scope, evidence, and review/expiry conditions. Silence or generic approval MUST NOT count as security approval.

For example, System Analysis may complete when:

```text
✓ product purpose is sufficiently understood
✓ primary actors are identified
✓ critical workflows are understood
✓ known business rules are persisted
✓ relevant constraints are persisted
✓ known integrations are identified
✓ existing Product Owner decisions are persisted
✓ unresolved questions are classified
✓ no unresolved PRODUCT_BLOCKER prevents architecture
```

This does NOT mean every possible detail must be known.

It means enough authoritative information exists to begin architecture without inventing product requirements.

---

# 7. Document 02 — Authority & Decision Protocol

Create:

```text
docs/protocols/02-AUTHORITY-DECISION-PROTOCOL.md
```

Formalize CHRONO's authority model.

Authorities include:

```text
Product Owner / Principal Architect
Gaspar
Belthazar
Melchior
Prometheus
Lucca
Glenn
Spekkio
```

Define the distinction between:

```text
Product Authority
Architecture Authority
Process Authority
Implementation Authority
UI/UX Authority
Infrastructure Authority
Testing Authority
Security Authority
Quality / Verification Authority
```

Formalize the existing three decision levels:

```text
LEVEL 1 — Implementation Decision
LEVEL 2 — Architectural Decision
LEVEL 3 — Product / Significant Architecture Decision
```

Define:

- who may make each decision;
- when escalation is required;
- how Product Owner decisions become authoritative;
- how Gaspar's delegated authority works;
- how conflicts are detected;
- how conflicts are resolved;
- how risk acceptance works;
- how waivers work;
- how explicit Product Owner decisions override agent preferences.

Formalize Gaspar autonomy modes:

```text
SUPERVISED
SEMI-AUTONOMOUS
AUTONOMOUS
```

Semi-autonomous should remain the recommended default unless existing documentation explicitly establishes otherwise.

Even in autonomous mode:

```text
Gaspar MUST NOT invent product requirements.
Gaspar MUST NOT silently change business rules.
Gaspar MUST NOT silently override explicit PO decisions.
```

Formalize the Gaspar/Spekkio authority boundary:

> Gaspar cannot override a Spekkio quality failure. Spekkio cannot override a Gaspar architectural decision.

Unresolved authority conflict escalates to the Product Owner.

---

# 8. Document 03 — Artifact Model

Create:

```text
docs/protocols/03-ARTIFACT-MODEL.md
```

This is extremely important.

Define the conceptual artifact/domain model of CHRONO before implementation.

Identify persistent artifact types such as:

```text
Project
Requirement
BusinessRule
Constraint
Decision
OpenQuestion
Architecture
ADR
Specification
Harness
AcceptanceCriterion
Roadmap
Module
WorkPackage
Task
Approval
Blocker
Defect
SecurityBlocker
QAReport
SecurityReport
Waiver
ChangeRequest
ProjectState
RuntimeCapability
RTKAttestation
SkillAttestation
```

Do NOT prematurely lock the implementation into TypeScript classes, YAML files, database tables, or JSON schemas.

First define the **semantic model**.

For each artifact define, where applicable:

```text
purpose
identity
authority
lifecycle
status
relationships
source/provenance
traceability
mutability
approval requirements
references
```

For example, a Decision may conceptually contain:

```yaml
id: DEC-014
type: product
authority: product-owner
status: approved

subject: database.engine
value: postgresql

source:
  type: system-analysis

affects:
  - ADR-003
  - SP-001
```

This is an example, not necessarily the final schema.

The document should identify what the future deterministic Core must be capable of representing.

---

# 9. Document 04 — Architecture & ADR Protocol

Create:

```text
docs/protocols/04-ARCHITECTURE-ADR-PROTOCOL.md
```

Formalize the transition:

```text
SYSTEM ANALYSIS
      ↓
PERSISTENT KNOWLEDGE
      ↓
ARCHITECTURE
      ↓
ARCHITECTURAL DECISIONS
      ↓
ADRs
      ↓
SPEC DISCOVERY
```

Define:

- when architecture work may begin;
- how existing architecture is discovered;
- how Gaspar proposes architecture;
- how Product Owner preferences become authoritative;
- when an architectural decision requires an ADR;
- when an ADR requires Product Owner approval;
- how Gaspar autonomy mode affects approval;
- ADR lifecycle;
- superseded ADRs;
- conflicting ADRs;
- architecture consistency;
- security participation by Glenn;
- how architectural blockers prevent Spec readiness.

Very important:

Architecture MUST NOT accidentally migrate into Specs as undocumented architectural decisions.

Specs consume approved architecture.

They do not silently redefine it.

---

# 10. Document 05 — Specification Protocol

Create:

```text
docs/protocols/05-SPECIFICATION-PROTOCOL.md
```

Formalize Spec discovery and creation.

Specs MUST be discovered from:

```text
system analysis
requirements
business rules
architecture
ADRs
system boundaries
dependencies
```

CHRONO MUST NOT contain a fixed universal Spec list.

Examples may demonstrate differences:

Web:

```text
SP-001-database
SP-002-authentication
SP-003-users
SP-004-dashboard
```

Embedded:

```text
SP-001-hardware-abstraction
SP-002-display
SP-003-input-encoder
SP-004-ble-communication
SP-005-power-management
```

Define:

- Spec identity;
- Spec scope;
- out-of-scope;
- requirements;
- business rules;
- architecture references;
- ADR references;
- dependencies;
- data impact;
- APIs/contracts;
- security requirements;
- errors;
- edge cases;
- acceptance criteria;
- lifecycle;
- readiness;
- change control.

A Spec is a **contract**.

It MUST NOT become an uncontrolled design notebook.

---

# 11. Document 06 — Harness Protocol

Create:

```text
docs/protocols/06-HARNESS-PROTOCOL.md
```

Every executable Spec MUST have a corresponding Harness.

Formalize the principle:

> The Spec is the contract. The Harness is the minimal curated execution context required to implement and verify that contract.

Define Harness generation as a combination of:

```text
Deterministic Context Resolution
+
Gaspar Semantic Analysis
```

The Harness may include:

```text
Spec
relevant requirements
relevant ADRs
dependent Specs
architecture references
business rules
relevant source files
implementation conventions
testing requirements
security requirements
forbidden decisions
Definition of Ready
Definition of Done
assigned roles
dependency state
```

Define context budgeting.

Agents SHOULD NOT receive the entire project by default.

Conceptually:

```text
Project Knowledge
      ↓
Spec Dependencies
      ↓
Relevant ADRs
      ↓
Relevant Source
      ↓
Role Requirements
      ↓
Harness
      ↓
Agent Context
```

Also formalize that:

```text
AGENTS.md
skills
runtime instruction files
```

may be generated from or consume Harness information, but are runtime artifacts and are not the authoritative CHRONO Harness itself unless a future adapter explicitly maps them that way.

RTK is a REQUIRED operational dependency for every CHRONO CLI runtime adapter. The Core specification MUST require a current RTK health/integration attestation before agent execution, while keeping RTK outside ownership of domain state and lifecycle policy. Absence, incompatibility, failed interception, or bypass MUST fail closed; silent fallback to raw command output is forbidden. Installation requires applicable user/system permission, and provenance, version, integrity, configuration, integration mode, bypass events, and savings evidence MUST be auditable.

OpenCode and Claude adapters SHOULD use RTK's officially supported native integration. The Kiro adapter MUST implement and test explicit shell-command interception through Kiro's blocking `PreToolUse` hook or an equivalent wrapper because native RTK support MUST NOT be assumed. Every adapter MUST verify effective routing rather than treating configuration-file presence as proof.

The Karpathy Guidelines skill is a REQUIRED process dependency for every CHRONO agent runtime. Its canonical upstream MUST be `https://github.com/multica-ai/andrej-karpathy-skills`, pinned to an immutable reviewed commit. All Claude Code, OpenCode, and Kiro artifacts MUST be deterministically generated from `skills/karpathy-guidelines/SKILL.md`, remain semantically equivalent, preserve the MIT license/attribution, and pass runtime discovery/activation tests. Upstream documentation that references another repository MUST NOT redirect CHRONO installation without an explicit reviewed source change.

The skill MUST require think-before-coding, simplicity, surgical changes, and goal-driven verification throughout CHRONO work. Its authority is lower than Product Owner decisions, CHRONO protocols/Core, approved artifacts/Harnesses, and role rules. It MUST NOT justify removal or weakening of security, traceability, evidence, gates, error handling, or approved behavior. A missing, modified, untrusted, divergent, inactive, or bypassed skill MUST create `BLOCKED_PROCESS_SKILL` and deterministically deny agent dispatch. Applicable installation/configuration permission remains required.

---

# 12. Document 07 — Consistency Validation Protocol

Create:

```text
docs/protocols/07-CONSISTENCY-VALIDATION-PROTOCOL.md
```

Formalize the two validation layers:

## Deterministic Validation

Performed by CHRONO Core.

Examples:

```text
unique IDs
valid references
valid ADR references
valid Spec references
valid Harness references
required artifacts
valid states
approval state
DAG cycles
dependency existence
traceability
orphan artifacts
```

## Semantic Validation

Performed by Gaspar and relevant specialized agents.

Examples:

```text
SP-AUTH requires JWT
ADR-004 requires server-side cookie sessions

→ conflict
```

or:

```text
SP-BILLING requires Customer.organization_id
SP-CUSTOMER defines no organization relationship

→ conflict
```

Define:

```text
ERROR
WARNING
BLOCKER
```

or another clearly documented severity model if supported by existing architecture.

Do not invent arbitrary severity semantics without documenting them.

Define what prevents:

```text
Spec READY
Module READY
Execution Authorization
Completion
```

Security-related inconsistencies should involve Glenn.

---

# 13. Document 08 — Roadmap & Execution Protocol

Create:

```text
docs/protocols/08-ROADMAP-EXECUTION-PROTOCOL.md
```

Formalize:

```text
READY SPECS
      ↓
DEPENDENCY ANALYSIS
      ↓
ROADMAP
      ↓
MODULES
      ↓
WORK PACKAGES
      ↓
TASKS
      ↓
DAG
      ↓
PRODUCT OWNER MODULE APPROVAL
      ↓
EXECUTION AUTHORIZATION
      ↓
PARALLEL AGENT EXECUTION
```

Define:

```text
Module
Work Package
Task
Dependency
DAG
Execution Authorization
```

The Product Owner should approve meaningful Modules rather than manually approving every implementation Task.

After Module approval, agents work independently within approved scope.

Parallelism MUST mean:

> Safe parallelism.

Not:

> Maximum possible number of concurrent agents.

Define deterministic execution checks such as:

```text
Does Spec exist?
Is Spec READY?
Does Harness exist?
Is Harness valid?
Is Module approved?
Are dependencies satisfied?
Is work blocked?
Is execution authorized?
```

If not:

```text
EXECUTION DENIED
```

The Core must own these gates.

An agent prompt cannot override them.

Also define the conceptual AgentRuntime boundary:

```text
start(role, context)
send(message)
handoff(...)
result()
stop()
```

Do NOT design OpenCode-specific implementation here.

Runtime adapters come later.

The execution protocol must define fail-closed security authorization. Belthazar, Prometheus, Lucca, and Glenn MUST provide current security-relevant implementation, infrastructure, test, dependency, and review evidence. Material deviation from the approved threat model or controls MUST create a blocker/change request and invalidate affected authorization until Gaspar updates impacted artifacts and the Product Owner makes the required decision.

It must also define mandatory process-skill authorization: every agent dispatch requires a current `SkillAttestation` for the pinned Karpathy Guidelines source and its runtime-specific generated artifact. The protocol MUST validate provenance, hashes, semantic equivalence, runtime discovery, permissions, and activation rather than merely checking that a file exists.

---

# 14. Document 09 — Verification & Correction Protocol

Create:

```text
docs/protocols/09-VERIFICATION-CORRECTION-PROTOCOL.md
```

Formalize the post-execution quality process.

Roles:

```text
Lucca
→ automated behavioral evidence

Glenn
→ security evidence

Spekkio
→ independent verification
```

Formalize:

```text
PASS
FAILED
WAIVED
```

A waiver MUST NOT convert a failure into PASS.

Formalize defect classification:

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

Define the correction loop:

```text
SPEKKIO
   ↓
DEFECT
   ↓
CLASSIFICATION
   ↓
RESPONSIBLE AGENT
   ↓
CORRECTION
   ↓
LUCCA / GLENN
when applicable
   ↓
SPEKKIO
   ├── FAILED → repeat
   └── PASS   → continue
```

Gaspar MUST NOT become involved in every ordinary implementation defect.

Gaspar becomes involved when correction requires:

```text
architecture change
Spec change
Harness change
replanning
DAG change
contract change
PO escalation
```

Define Definition of Done and completion authorization.

Before final verification, the Product Owner MUST make a separate, persistent implementation-security decision based on the current evidence and residual risks. Spekkio MUST NOT issue `PASS`, and the Core MUST NOT authorize `COMPLETE`, while that decision or required evidence is missing/stale, a security control is failing, or a `SECURITY_BLOCKER` remains unresolved. Only the Product Owner may accept residual risk; such acceptance remains `WAIVED`, never `PASS`, and must be scoped, reasoned, time-bounded or review-bound, and traceable.

The protocol must assign mandatory security behavior to Gaspar, Belthazar, Prometheus, Lucca, Glenn, and Spekkio, including least privilege, deny-by-default behavior, secret protection, trust-boundary validation, dependency provenance, negative/abuse testing, evidence independence, safe tool use, and escalation instead of silent control weakening.

---

# 15. Cross-Document Consistency

All nine documents MUST use the same terminology.

Do not alternate between different names for the same concept.

Use canonical terms such as:

```text
Product Owner
Principal Architect
Gaspar
System Analysis
Architecture
ADR
Spec
Harness
Roadmap
Module
Work Package
Task
DAG
Approval
Execution Authorization
Verification
Correction Loop
```

Every document should reference the appropriate related protocol rather than redefining another protocol differently.

For example:

```text
SYSTEM-ANALYSIS-PROTOCOL
        ↓
produces knowledge consumed by
        ↓
ARCHITECTURE-ADR-PROTOCOL
        ↓
produces architecture consumed by
        ↓
SPECIFICATION-PROTOCOL
        ↓
produces Specs consumed by
        ↓
HARNESS-PROTOCOL
```

The overall lifecycle should remain:

```text
PRODUCT OWNER
      ↓
GASPAR SYSTEM ANALYSIS
      ↓
PERSISTENT PROJECT KNOWLEDGE
      ↓
ARCHITECTURE
      ↓
ADRs
      ↓
SPEC DISCOVERY
      ↓
SPECS
      ↓
HARNESS PER SPEC
      ↓
CONSISTENCY VALIDATION
      ↓
ROADMAP / MODULES / WPs / DAG
      ↓
PRODUCT OWNER MODULE APPROVAL
      ↓
EXECUTION AUTHORIZATION
      ↓
PARALLEL SPECIALIZED AGENTS
      ↓
LUCCA + GLENN
      ↓
SPEKKIO
      ↓
PASS / CORRECTION
      ↓
COMPLETE
```

---

# 16. Approved Post-Protocol Implementation Baseline

The prohibition on implementation below governed the completed protocol-writing phase. The subsequent implementation is now authorized only against the following approved baseline:

- TypeScript monorepo on supported Node.js LTS releases;
- mandatory globally installed `chrono` launcher delegating to the version-pinned local Core;
- free npm and GitHub Releases distribution for macOS, Linux, and Windows, with signatures, checksums, SBOM, and provenance, and no required paid/server dependency;
- Apache License 2.0 (`Apache-2.0`) for CHRONO-authored software and documentation, with preservation of third-party licenses and attribution;
- versioned Markdown/YAML contracts plus `.chrono/chrono.db` SQLite operational storage;
- hierarchical Project, Specification, Module, WorkPackage, and Verification states defined in `docs/reference/FRAMEWORK-DEFINITION.md` and `docs/implementation/IMPLEMENTATION-PLAN.md`;
- cryptographically signed, interactive, human-only PO approval/waiver/risk commands with signing keys outside agent/project reach;
- required OpenCode, Claude Code, and Kiro adapters, each enforcing both authorized `chrono run` dispatch and native pre-tool calls to `chrono gate`;
- RTK and Karpathy Guidelines attestations remain mandatory and fail closed.

The Product Owner selects the implementation and agent models through external project/runtime configuration. No provider, model name, or model version may be hardcoded in framework source, defaults, templates, tests, generated agent definitions, or adapters. The selected model generates code but cannot define policy, grant approval, or alter gates.

# 17. Historical Phase Boundary: Do Not Prematurely Implement

During the completed protocol-authoring task:

DO NOT create:

```text
TypeScript implementation
Node.js CLI implementation
MCP server
OpenCode adapter
Claude Code adapter
Kiro adapter
JSON schemas
database schemas
npm package
runtime hooks
production agent prompts
```

unless a tiny pseudocode/schema fragment is required purely to explain a protocol.

Examples and pseudocode are allowed.

Production implementation is not.

The purpose of these documents is to make the future implementation derivable from the protocol.

---

# 18. Approved Physical Storage

CHRONO uses a deliberate hybrid: versioned Markdown/YAML are human-readable authoritative contracts; `.chrono/chrono.db` (SQLite) contains transactional operational events, locks, states, approvals, attestations, evidence indexes, and migrations. SQLite does not replace the documents as contracts. Exact schemas and non-semantic paths are derived in the Core Specification within this boundary.

---

# 19. Framework vs. Agent Responsibility

Preserve this separation throughout all documents.

Gaspar and other LLM agents perform semantic work:

```text
reason
analyze
interview
recommend
architect
discover
interpret
classify semantically
implement
test
review
verify
```

CHRONO Core performs deterministic work:

```text
persist
identify
reference
track state
track approvals
validate schemas/references
enforce gates
resolve dependencies
authorize execution
record evidence
record blockers
record defects
record waivers
```

Do not assign semantic architecture reasoning to deterministic code.

Do not assign deterministic gate enforcement solely to prompts.

---

# 20. Important Design Constraint

The future Core may expose commands conceptually similar to:

```text
chrono init
chrono status
chrono validate
chrono approve
chrono run
```

But these command names are NOT yet the protocol.

Do not design the documentation around CLI commands.

The protocol defines framework behavior.

The CLI will later expose that behavior.

Likewise:

```text
OpenCode
Claude Code
Kiro
Codex
Gemini
```

are runtime adapters.

They do not define the framework lifecycle.

---

# 21. Expected Result

At the end of this task, `docs/protocols` should contain a coherent formal specification of CHRONO's internal engineering methodology.

The documents should be detailed enough that the next phase can read them and derive:

```text
CHRONO DOMAIN MODEL
        ↓
STATE MODEL
        ↓
ARTIFACT SCHEMAS
        ↓
CORE MODULES
        ↓
VALIDATORS
        ↓
GATE ENGINE
        ↓
CONTEXT RESOLVER
        ↓
DAG ENGINE
        ↓
AGENT RUNTIME INTERFACE
        ↓
FIRST RUNTIME ADAPTER
```

The goal is that we do NOT invent the software architecture first and then force CHRONO into it.

Instead:

> **Formalize the process → discover the domain model → implement the domain model.**

This is deliberate.

CHRONO itself requires:

> **UNDERSTAND before designing. SPECIFY before implementing.**

Its own development must follow the same discipline.

---

# 22. Final Review Before Completion

Before considering this documentation task complete:

1. Read all nine generated documents again.
2. Compare them against `INITIAL.md`.
3. Compare them against `docs/architecture/REFERENCE-ARCHITECTURE.md`.
4. Check terminology across all documents.
5. Check authority boundaries.
6. Check lifecycle consistency.
7. Check that no runtime-specific mechanism became a Core requirement.
8. Check that no LLM responsibility became incorrectly deterministic.
9. Check that no deterministic gate became merely a prompt instruction.
10. Check that Specs remain discovered rather than predefined.
11. Check that every executable Spec has a Harness.
12. Check that Product Owner authority remains supreme.
13. Check that Gaspar remains Systems Analyst + Software Architect + Orchestrator.
14. Check that Spekkio remains independently responsible for verification.
15. Check that safe parallelism occurs only after sufficient specification and approval.
16. Check that persistent project artifacts, not agent memory, remain the source of project truth.
17. Check that architecture and implementation security decisions are separately persisted by the Product Owner.
18. Check that missing or stale security evidence fails closed.
19. Check that every named execution/verification role has explicit security duties and escalation rules.
20. Check that the Karpathy Guidelines skill is mandatory, pinned, single-source, subordinate to CHRONO authority, and activation-tested in each runtime.

If inconsistencies are found, correct the documentation before finishing.

Do not begin framework implementation after completing the documents.

Stop after the formal protocol documentation and report:

```text
- files created
- major protocol decisions formalized
- ambiguities discovered
- unresolved decisions that require Product Owner input
- recommendations for the next phase
```
