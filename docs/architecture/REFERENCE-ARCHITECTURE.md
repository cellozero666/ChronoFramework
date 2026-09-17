# CHRONO Framework — Architecture and Implementation Specification

**Status:** Initial implementation specification  
**Language:** English  
**Purpose:** Define how CHRONO becomes an executable,
runtime-independent software architecture and Spec-Driven Development
framework rather than a collection of prompts, skills, or agent
personas.

------------------------------------------------------------------------

## 1. Framework Definition

CHRONO is a **multi-agent software architecture and Spec-Driven
Development framework**.

Its purpose is not to automate vibe coding. Its purpose is to formalize
and automate a disciplined software engineering process in which a human
Product Owner / Principal Architect works with specialized AI agents
under explicit authority, persistent project knowledge, deterministic
guardrails, traceable specifications, approval gates, and independent
verification.

CHRONO must guide a project from an initially incomplete product idea
to:

1.  structured system understanding;
2.  explicit technical and product decisions;
3.  approved architecture;
4.  Architecture Decision Records;
5.  modular specifications;
6.  specification-specific execution harnesses;
7.  consistency validation;
8.  an executable roadmap and dependency graph;
9.  Product Owner authorization of implementation modules;
10. parallel work by specialized AI agents;
11. automated testing and security review;
12. independent verification;
13. controlled correction loops;
14. documented completion.

The framework is not defined by any particular LLM, CLI, agent runtime,
prompt format, or skill system.

OpenCode, Claude Code, Kiro, Codex, Gemini and future agent runtimes are
**execution environments for CHRONO**, not CHRONO itself.

------------------------------------------------------------------------

## 2. Fundamental Boundary: Framework vs. Skill

A skill instructs an AI agent how to behave.

CHRONO must additionally **control and materialize the engineering
process independently from the temporary reasoning or memory of an AI
model**.

Therefore:

- prompts define agent behavior;
- role definitions define authority and responsibilities;
- runtime adapters connect CHRONO to a specific agent environment;
- the CHRONO Core owns project state, gates, traceability, context,
  validation and workflow;
- persistent project artifacts are the authoritative memory of the
  project.

A runtime-specific skill may be used by an adapter, but a skill is never
the framework itself.

The architectural boundary is:

``` text
                    CHRONO FRAMEWORK
                           │
          ┌────────────────┼────────────────┐
          │                │                │
     SDD ENGINE       CONTEXT ENGINE    AGENT ENGINE
          │                │                │
          │                │                ▼
          │                │         Runtime Adapters
          │                │          │   │   │   │
          │                │          ▼   ▼   ▼   ▼
          │                │         OC Claude Kiro Codex Gemini
          │                │
          ▼                ▼
    State / Gates      Project Artifacts
    Roadmap / DAG      ADRs / Specs / Harnesses
```

------------------------------------------------------------------------

## 3. Human Authority

The human user is the:

- Product Owner;
- Principal Architect;
- final authority over product requirements;
- final authority over business rules;
- final authority over significant architectural decisions;
- final authority over scope changes;
- final authority over conscious risk acceptance;
- final arbiter of authority conflicts.

No agent may silently override an explicit Product Owner decision.

Agent autonomy exists because the Product Owner delegates authority.
Autonomy never replaces Product Owner authority.

------------------------------------------------------------------------

## 4. Gaspar: Systems Analyst, Software Architect and Orchestrator

Gaspar is the primary interface between CHRONO and the Product Owner
during project setup and architecture.

Gaspar is not merely an orchestrator.

Gaspar performs three primary functions:

### 4.1 Systems Analyst

Gaspar interviews the Product Owner and investigates the project in
order to understand:

- the problem being solved;
- product goals;
- actors and users;
- workflows;
- business rules;
- permissions;
- data requirements;
- integrations;
- constraints;
- expected scale;
- security requirements;
- infrastructure constraints;
- existing systems;
- existing source code;
- existing documentation;
- operational requirements;
- unresolved questions.

The interview must be **adaptive**, not a fixed questionnaire.

Gaspar must ask questions based on information already obtained and must
not ask the Product Owner for information that can be reliably
discovered from authoritative project artifacts or the existing
repository.

### 4.2 Software Architect

Gaspar works with the Product Owner to establish the technical
foundation of the system.

Examples include:

- application type;
- programming languages;
- backend runtime and framework;
- database technology;
- frontend framework;
- UI library;
- responsive/mobile strategy;
- authentication approach;
- API style;
- deployment architecture;
- infrastructure;
- data architecture;
- security architecture;
- repository structure;
- coding conventions;
- testing strategy;
- observability requirements.

For example, a web project may establish:

``` yaml
backend:
  runtime: nodejs

database:
  engine: postgresql

frontend:
  framework: react
  ui_library: bootstrap
  strategy: mobile-first
```

A firmware project may instead establish C++, ESP32, hardware
interfaces, display technology, BLE communication, power constraints,
and embedded-specific architectural rules.

CHRONO must not assume a web application.

### 4.3 Orchestrator

After the architecture and specifications are sufficiently defined,
Gaspar:

- discovers the specifications required by the system;
- creates and maintains ADRs;
- creates modular Specs;
- creates or coordinates Spec Harness generation;
- validates cross-document consistency;
- decomposes work into modules and Work Packages;
- builds dependency graphs;
- assigns work to specialized agents;
- requests Product Owner approval at required gates;
- coordinates execution;
- handles escalations;
- coordinates completion.

------------------------------------------------------------------------

## 5. Initial Product Owner / Gaspar Setup

A new CHRONO project begins with a structured setup between Gaspar and
the Product Owner.

Conceptually:

``` text
PRODUCT OWNER
     │
     ▼
GASPAR — SYSTEM ANALYSIS
     │
     ├── adaptive interview
     ├── repository inspection
     ├── requirement discovery
     ├── constraint discovery
     ├── technical decision discovery
     └── ambiguity detection
     │
     ▼
PERSISTENT PROJECT KNOWLEDGE
     │
     ▼
ARCHITECTURE DEFINITION
     │
     ▼
PO CONFIRMATION / APPROVAL
```

Gaspar must register decisions as they are made instead of relying on
conversational memory.

The initial setup is complete only when the project contains enough
authoritative information for Gaspar to begin
architectural/specification work without inventing product requirements.

------------------------------------------------------------------------

## 6. Gaspar Autonomy Modes

CHRONO should allow the Product Owner to choose how much delegated
architectural autonomy Gaspar receives.

### 6.1 Supervised

Gaspar asks for approval before architectural decisions that are not
already implied by approved project decisions.

### 6.2 Semi-Autonomous

Gaspar independently makes ordinary technical decisions that are
compatible with existing architecture, requirements and constraints.

Significant architecture, product behavior, business rules, scope
changes and meaningful risk decisions are escalated to the Product
Owner.

This should be the recommended/default operating mode unless changed by
the Product Owner.

### 6.3 Autonomous

Gaspar may independently make architectural decisions within the
authority delegated by the Product Owner.

Even in autonomous mode, Gaspar may not invent or silently change:

- product requirements;
- business rules;
- explicit constraints;
- approved scope;
- explicit Product Owner decisions.

Product decisions remain Product Owner decisions.

------------------------------------------------------------------------

## 7. Persistent Project Knowledge

CHRONO must treat project knowledge as persistent data.

The LLM context window is not project memory.

The project must survive:

- closing a session;
- changing models;
- changing agent runtimes;
- context compaction;
- agent replacement;
- machine restarts where applicable.

The approved persistence model is hybrid. Versioned Markdown/YAML files are the human-readable authoritative contracts; `.chrono/chrono.db` is SQLite storage for transactional events, locks, lifecycle transitions, approvals, attestations, evidence indexes, and migrations. The database MUST NOT replace the documents as contracts.

An initial project structure is:

``` text
.chrono/
├── config.yaml
├── chrono.db
│
├── context/
│   ├── PROJECT.md
│   ├── REQUIREMENTS.md
│   ├── BUSINESS-RULES.md
│   ├── CONSTRAINTS.md
│   ├── DECISIONS.md
│   └── OPEN-QUESTIONS.md
│
├── architecture/
│   ├── ARCHITECTURE.md
│   └── adr/
│
├── specs/
│
├── harness/
│
├── roadmap/
│
└── reports/
```

Non-semantic directory details may evolve, but the Markdown/YAML plus SQLite boundary is normative.

The invariant is:

> Project truth must be persisted outside temporary AI conversation
> context.

Lifecycle state is hierarchical and fixed for v1:

```text
Project:       UNINITIALIZED | ANALYZING | ARCHITECTING | SPECIFYING | PLANNING | EXECUTING | VERIFYING | COMPLETE | BLOCKED
Specification: DRAFT | REVIEW | READY | SUPERSEDED
Module:        DRAFT | AWAITING_APPROVAL | APPROVED | EXECUTING | VERIFYING | PASSED | FAILED | COMPLETE | BLOCKED
WorkPackage:   PLANNED | AUTHORIZED | RUNNING | BLOCKED | IMPLEMENTED | VERIFYING | FAILED | COMPLETE
Verification:  PENDING | RUNNING | FAILED | PASSED | WAIVED
```

Project state is a deterministic projection and MUST NOT conceal a blocked, failed, running, or awaiting-approval child. `WAIVED` remains distinct from `PASSED`.

------------------------------------------------------------------------

## 8. Authoritative Knowledge and Decision Precedence

CHRONO must distinguish temporary conversation from authoritative
project knowledge.

Before an agent asks a question or makes a decision, it should
conceptually follow:

``` text
1. Is the answer in authoritative project context?
        ↓ no
2. Is the answer in an ADR?
        ↓ no
3. Is the answer in an approved Spec?
        ↓ no
4. Can it be reliably discovered from the repository?
        ↓ no
5. Is it a technical decision inside the agent's authority?
        ↓ no
6. Escalate to the appropriate authority.
```

Explicit Product Owner decisions must have the highest authority within
their domain.

Example:

``` text
Product Owner decision:
database.engine = PostgreSQL
```

A later model must not silently replace PostgreSQL with MongoDB because
it believes MongoDB is preferable.

CHRONO should detect the conflict and block the unauthorized change.

------------------------------------------------------------------------

## 9. Architecture Decision Records

Gaspar creates ADRs for relevant architectural decisions.

ADRs must:

- identify the decision;
- describe relevant context;
- describe the selected solution;
- record important alternatives where useful;
- document consequences;
- identify authority/approval when required;
- be traceable from affected Specs.

ADR generation follows the configured Gaspar autonomy mode.

A Product Owner decision may require an ADR when it has architectural
significance.

------------------------------------------------------------------------

## 10. Specification Discovery

Specs are not predefined by CHRONO.

Gaspar discovers which Specs are necessary from the system analysis and
approved architecture.

A web application may produce:

``` text
SP-001-database.md
SP-002-authentication.md
SP-003-users.md
SP-004-dashboard.md
SP-005-notifications.md
```

An embedded application may instead produce:

``` text
SP-001-hardware-abstraction.md
SP-002-display.md
SP-003-input-encoder.md
SP-004-ble-communication.md
SP-005-power-management.md
```

The framework must therefore be domain-independent.

The Spec graph is an output of systems analysis and architecture, not a
hardcoded project template.

------------------------------------------------------------------------

## 11. Modular Specifications

Each Spec represents a coherent, executable system contract.

For example, `SP-001-database.md` for a web application may define:

- database engine;
- schemas;
- tables;
- columns;
- data types;
- primary keys;
- foreign keys;
- unique constraints;
- nullability;
- indexes;
- relationships;
- deletion/update behavior;
- migration expectations;
- security considerations;
- relevant business rules;
- relevant ADR references;
- acceptance criteria.

`SP-002-authentication.md` may define:

- authentication methods;
- account creation;
- credential rules;
- session/token behavior;
- password reset;
- email verification;
- MFA where applicable;
- authorization boundaries;
- error behavior;
- security requirements;
- acceptance criteria.

The exact content depends on the subject of the Spec.

------------------------------------------------------------------------

## 12. Spec Harness

Every executable Spec must have a corresponding execution harness.

The Spec is the contract.

The Harness is the **minimal, curated execution context required by
agents to implement and verify that contract without needing the entire
project history**.

Conceptually:

``` text
SP-002-authentication.md
SP-002-authentication.harness.md
```

A Harness may include:

- Spec identifier;
- relevant requirements;
- relevant ADRs;
- dependent Specs;
- architecture excerpts/references;
- relevant business rules;
- relevant source directories/files;
- implementation conventions;
- testing requirements;
- security requirements;
- forbidden decisions;
- Definition of Ready;
- Definition of Done;
- assigned roles;
- dependency state.

Harness generation should combine deterministic context resolution from
CHRONO with semantic analysis by Gaspar.

The Harness is a primary mechanism for:

- reducing hallucination;
- preventing unauthorized decisions;
- reducing context pollution;
- reducing token consumption;
- allowing agents to work independently;
- allowing agents/models to be replaced without losing project
  understanding.

------------------------------------------------------------------------

## 13. Context Budgeting and Token Efficiency

Context efficiency is an architectural concern of CHRONO.

The framework should avoid loading the entire project into every agent
session.

Instead:

``` text
Project Knowledge
      │
      ▼
Spec Dependencies
      │
      ▼
Relevant ADRs
      │
      ▼
Relevant Source
      │
      ▼
Role Requirements
      │
      ▼
SPEC HARNESS
      │
      ▼
Agent Context
```

Rust Token Killer (RTK) is an advisory output-optimization dependency for all
CHRONO CLI runtime adapters (PO decision ADR-009).

The Core records RTK capability/health attestation for observability but
NEVER denies agent execution on RTK posture. Each adapter detects the genuine
RTK binary and compatible version, verifies provenance/integrity, configures
native RTK integration when officially supported or a tested hook/wrapper
otherwise, reports actual command routing, and persists health/bypass/savings
evidence. Missing, unhealthy, incompatible, stale, or bypassed RTK produces an
audited `RtkWarning` and execution proceeds.

RTK installation requires applicable user/system permission. RTK remains external to domain ownership: it does
not define CHRONO state, governance, gates, or lifecycle.

The Karpathy Guidelines skill is a second mandatory adapter-level process
dependency. Its canonical upstream is
`https://github.com/multica-ai/andrej-karpathy-skills`. CHRONO must pin an
immutable commit, verify integrity/provenance, preserve MIT attribution, and
generate Claude Code, OpenCode, and Kiro packages from the single canonical
`skills/karpathy-guidelines/SKILL.md` source. Upstream instructions that point
to another repository must not redirect installation silently.

Every CHRONO agent must apply: think before coding, simplicity first, surgical
changes, and goal-driven verified execution. The precedence is Product Owner,
CHRONO protocols/Core, approved artifacts/Harness, role rules, then the skill.
The skill cannot simplify away security, traceability, evidence, gates, error
handling, or approved scope. The Core must require a current SkillAttestation
covering source revision/hash, generated hashes, runtime discovery, permissions,
and activation. Missing, divergent, inactive, modified, untrusted, or bypassed
state must produce `BLOCKED_PROCESS_SKILL` and deny dispatch.

------------------------------------------------------------------------

## 14. Model Selection and Context Capacity

CHRONO agents represent roles, not models.

However, the framework may recommend models based on role requirements.

For example:

### Gaspar

Priority characteristics:

- strong reasoning;
- large context capacity;
- strong document synthesis;
- architecture reasoning;
- reliable tool use.

### Belthazar

Priority characteristics:

- software implementation quality;
- code reasoning;
- repository/tool use;
- instruction adherence.

### Melchior

Priority characteristics:

- UI/UX reasoning;
- frontend implementation;
- accessibility;
- responsive design.

### Prometheus

Priority characteristics:

- infrastructure reasoning;
- deployment tooling;
- shell/tool reliability;
- operational safety.

### Lucca

Priority characteristics:

- test design;
- code reasoning;
- adversarial edge-case discovery.

### Glenn

Priority characteristics:

- security reasoning;
- threat modeling;
- secure implementation review.

### Spekkio

Priority characteristics:

- strong independent reasoning;
- adversarial verification;
- specification comparison;
- defect classification.

When practical, Spekkio may use a different model family from the
implementation agent to reduce correlated reasoning failures.

Model recommendations must remain configuration, never agent identity.

------------------------------------------------------------------------

## 15. Consistency Validation

Before Gaspar produces the executable roadmap, CHRONO must validate
project consistency.

Validation has two layers.

### 15.1 Deterministic Validation

The CHRONO Core should verify rules such as:

- unique Spec IDs;
- valid ADR references;
- valid Spec references;
- valid Harness references;
- valid Work Package references;
- no missing required artifacts;
- no invalid state transitions;
- no circular Work Package dependencies;
- no execution before required approval;
- no orphaned implementation work;
- traceability requirements.

Example:

``` text
ERROR

SP-004 references ADR-017.
ADR-017 does not exist.
```

### 15.2 Semantic Validation

Gaspar and relevant specialized agents analyze contradictions that
cannot be reliably detected through schemas alone.

Examples:

``` text
SP-AUTH requires JWT authentication.
ADR-004 establishes server-side cookie sessions.

→ ARCHITECTURAL INCONSISTENCY
```

or:

``` text
SP-BILLING requires Customer.organization_id.
SP-CUSTOMER defines no organization relationship.

→ SPECIFICATION INCONSISTENCY
```

Relevant security inconsistencies should involve Glenn.

Unresolved inconsistencies block affected work.

------------------------------------------------------------------------

## 16. Roadmap Generation

Only after sufficient architecture, Specs, Harnesses and consistency
validation does Gaspar generate the project roadmap.

The roadmap organizes implementation into meaningful modules.

Example:

``` text
MODULE 01 — Foundation
  WP-001
  WP-002

MODULE 02 — Authentication
  WP-003
  WP-004
  WP-005

MODULE 03 — Customers
  WP-006
  WP-007

MODULE 04 — Billing
  WP-008
  WP-009
```

The roadmap must include dependencies and identify safe parallel work.

Conceptually:

``` text
Foundation
    │
    ▼
Authentication
    │
    ├─────────────┐
    ▼             ▼
Customers     Notifications
    │
    ▼
Billing
```

Gaspar should optimize for **safe parallelism**, not maximum agent
concurrency.

------------------------------------------------------------------------

## 17. Product Owner Module Approval

The Product Owner should not be required to manually approve every
implementation task.

Instead, Gaspar presents meaningful roadmap modules for authorization.

Example:

``` text
MODULE: Authentication

Specs:
- SP-002-authentication
- SP-003-authorization

Work Packages:
- WP-003 Backend
- WP-004 Frontend
- WP-005 Tests
- WP-006 Infrastructure

Dependencies:
- Foundation COMPLETE

Security:
- Reviewed

Consistency:
- PASS

Status:
- READY FOR APPROVAL
```

The Product Owner authorizes the module.

After approval, specialized agents may work independently within the
approved contracts and authority boundaries.

------------------------------------------------------------------------

## 18. Autonomous Parallel Execution

After module approval, CHRONO transitions from primarily Product
Owner/Gaspar interaction to controlled multi-agent execution.

Conceptually:

``` text
                 APPROVED MODULE
                       │
                       ▼
                 CHRONO / GASPAR
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   BELTHAZAR        MELCHIOR      PROMETHEUS
 Implementation       UI/UX       Infrastructure
        │              │              │
        └──────────────┼──────────────┘
                       │
               ┌───────┴───────┐
               ▼               ▼
             LUCCA           GLENN
         Automated Tests   Security Review
               │               │
               └───────┬───────┘
                       ▼
                    SPEKKIO
              Independent Verification
                       │
                PASS / DEFECT
```

Agents should receive only the Specs, Harnesses, project context and
source context relevant to their assigned work.

They must not need continuous Product Owner supervision.

The Product Owner is interrupted only when:

- a product decision is missing;
- a significant architectural decision exceeds Gaspar's delegated
  autonomy;
- an explicit Product Owner decision would need to change;
- a significant risk requires acceptance;
- a required waiver is proposed;
- a conflict between framework authorities requires arbitration.

------------------------------------------------------------------------

## 19. Agent Roles

### 19.1 Gaspar — Systems Analyst / Software Architect / Orchestrator

Owns discovery, architecture, ADRs, specification orchestration,
planning, consistency, delegation and escalation.

### 19.2 Belthazar — Implementation Engineer

Implements approved contracts.

May make implementation-level decisions compatible with the approved
architecture and Spec.

May not redefine product requirements or architecture.

### 19.3 Melchior — UI/UX Engineer

Implements and refines approved user experience, flows, components,
responsiveness and accessibility within approved product/architecture
boundaries.

### 19.4 Prometheus — Infrastructure & Operations Engineer

Handles environments, infrastructure, deployment, CI/CD, migrations,
observability, backup and rollback within approved architecture and
operational safety rules.

### 19.5 Lucca — Test Engineer

Creates and executes automated testing based on approved acceptance
criteria and contracts.

May work before or in parallel with implementation when Specs are
sufficiently complete.

### 19.6 Glenn — Security Engineer

Performs threat modeling, security requirements analysis, implementation
security review and infrastructure security review.

May issue SECURITY_BLOCKER.

### 19.7 Spekkio — QA / Verification Authority

Independently attempts to prove that the implementation does not satisfy
the approved contract.

Spekkio does not implement.

Spekkio may issue PASS or FAILED and classify defects.

Gaspar cannot force Spekkio to issue PASS.

Spekkio cannot override architecture to make implementation pass.

Authority conflicts escalate to the Product Owner.

------------------------------------------------------------------------

## 20. Deterministic CHRONO Core

CHRONO must contain executable software responsible for rules that
should not depend on LLM compliance.

The Core should eventually own capabilities such as:

- project initialization;
- project state;
- approval state;
- authority metadata;
- artifact identifiers;
- traceability;
- dependency graphs;
- gate validation;
- Spec registration;
- Harness registration;
- Work Package registration;
- blocker state;
- defect state;
- waiver state;
- consistency checks;
- execution authorization;
- runtime dispatch.
- RTK capability and routing attestation;
- mandatory process-skill provenance, conversion and activation attestation.

Conceptually, before an implementation agent starts:

``` text
Requested Spec
     │
     ▼
Does Spec exist?
     │
     ▼
Is Spec READY?
     │
     ▼
Is required PO approval present?
     │
     ▼
Are dependencies satisfied?
     │
     ▼
Is Harness valid?
     │
     ▼
Is work unblocked?
     │
     ▼
ALLOW EXECUTION
```

Failure at a required gate results in deterministic denial.

Example:

``` text
EXECUTION DENIED

SP-002-authentication

Current status:
AWAITING_APPROVAL

Required:
Product Owner approval
```

A prompt must not be able to bypass a Core gate.

------------------------------------------------------------------------

## 21. Gaspar vs. CHRONO Core Responsibility

A critical design principle is separation between semantic intelligence
and deterministic enforcement.

### Gaspar

Gaspar:

- reasons;
- interviews;
- analyzes;
- recommends;
- designs;
- identifies ambiguity;
- synthesizes documents;
- discovers Specs;
- proposes architecture;
- plans work.

### CHRONO Core

The Core:

- persists;
- identifies artifacts;
- tracks state;
- tracks approvals;
- resolves references;
- validates deterministic rules;
- controls gates;
- controls execution authorization;
- supplies curated context;
- records evidence;
- records blockers/defects/waivers.

In short:

> LLMs perform semantic engineering work. Deterministic software
> enforces process invariants.

------------------------------------------------------------------------

## 22. Agent Runtime Abstraction

CHRONO must expose an abstract execution model independent of any
particular agent CLI.

Conceptually:

``` text
AgentRuntime

start(role, context)
send(message)
handoff(from, to, artifact)
result()
stop()
```

Runtime adapters implement this behavior using capabilities available in
their environment.

Required v1 adapters are:

- OpenCode;
- Claude Code;
- Kiro;

Codex and Gemini may be added later through the same contract.

A runtime adapter may use:

- skills;
- agent definitions;
- runtime-specific instruction files;
- hooks;
- MCP/tool integrations;
- subprocesses;
- runtime-native subagents;
- runtime-native commands.

Those mechanisms belong to the adapter layer.

They must not redefine CHRONO governance or lifecycle rules.

Integration is bidirectional. `chrono run` MUST obtain Core authorization before dispatching a runtime, and each required runtime MUST install a native pre-tool hook that calls `chrono gate` before protected actions.   A direct OpenCode, Claude Code, or Kiro session therefore remains subject to CHRONO, process-skill, permission, approval, and security gates (RTK posture is advisory-only per ADR-009). Failure to prove either dispatch or hook enforcement denies agent execution.

------------------------------------------------------------------------

## 23. Proposed Software Architecture

A practical repository may begin as:

``` text
chrono/
├── packages/
│
│   ├── core/
│   │   ├── state/
│   │   ├── gates/
│   │   ├── context/
│   │   ├── decisions/
│   │   ├── specs/
│   │   ├── harness/
│   │   ├── validation/
│   │   ├── roadmap/
│   │   ├── work-packages/
│   │   ├── dag/
│   │   └── traceability/
│   │
│   ├── agents/
│   │   ├── gaspar/
│   │   ├── belthazar/
│   │   ├── melchior/
│   │   ├── prometheus/
│   │   ├── lucca/
│   │   ├── glenn/
│   │   └── spekkio/
│   │
│   ├── runtime/
│   │   └── interface/
│   │
│   ├── adapters/
│   │   ├── opencode/
│   │   ├── claude/
│   │   ├── kiro/
│   │   ├── codex/
│   │   └── gemini/
│   │
│   └── cli/
│
├── templates/
│   ├── project/
│   ├── adr/
│   ├── spec/
│   ├── harness/
│   ├── roadmap/
│   └── reports/
│
└── docs/
```

This is an initial implementation direction, not a frozen repository
structure.

------------------------------------------------------------------------

## 24. CLI as Framework Entry Point

A globally installed `chrono` command is the mandatory framework entry point and integration manager.

The v1 implementation MUST use a TypeScript monorepo on supported Node.js LTS releases. It MUST support macOS, Linux, and Windows and be distributed free under Apache License 2.0 (`Apache-2.0`) through npm and GitHub Releases with signatures, checksums, SBOM, provenance, and preserved third-party notices, without a paid service or server dependency.

Conceptual commands may include:

``` text
chrono init
chrono status
chrono interview
chrono validate
chrono gate <operation>
chrono specs
chrono roadmap
chrono approve <target>
chrono run <target>
```

Additional commands may be designed during implementation, but `chrono`, `chrono init`, `chrono setup`, `chrono status`, `chrono gate`, `chrono approve`, `chrono waive`, and `chrono run` are required.

The global launcher MUST locate the current project, resolve its pinned local CHRONO version, and delegate to that local Core. It MUST fail closed if the local Core is absent, incompatible, or unverifiable and MUST NOT silently execute a different global Core.

The CLI is the interface to the framework Core; it is not itself the
architectural definition of CHRONO.

------------------------------------------------------------------------

## 25. Initialization

`chrono init` should eventually be responsible for:

1.  detecting project/runtime environment;
2.  creating `.chrono/`;
3.  creating initial persistent state;
4.  selecting project language;
5.  selecting Gaspar autonomy mode;
6.  detecting supported agent runtimes;
7.  configuring the selected runtime adapter;
8.  detecting and health-checking the advisory RTK installation (warn-only per ADR-009);
9.  reporting RTK interception state for the selected runtime;
10. installing, converting, and activation-testing the mandatory Karpathy Guidelines skill;
11. recording Product Owner-selected agent/model configuration without embedding a provider or model default;
12. launching or preparing the initial Gaspar system-analysis session.

Initialization must not assume that the project is a web application.

No provider, model name, or model version may be hardcoded in source, templates, generated agent definitions, tests, defaults, or adapters. Model selection belongs to the Product Owner's project/runtime configuration and does not change role authority or deterministic policy.

------------------------------------------------------------------------

## 26. Context Guardrails Against Hallucination

CHRONO must reduce hallucination structurally rather than relying only
on prompt instructions.

Guardrails should include:

- authoritative decision persistence;
- artifact identifiers;
- explicit references;
- Spec/ADR traceability;
- Harness context minimization;
- unresolved-question tracking;
- authority classification;
- conflict detection;
- deterministic gates;
- semantic consistency review;
- repository inspection before asking;
- prohibition against silent requirement invention;
- prohibition against silent architecture changes;
- independent QA;
- persistent correction history.

A model's suggestion that conflicts with an authoritative decision is
not automatically a new decision.

It is a conflict requiring resolution according to authority.

------------------------------------------------------------------------

### 26.1 Security Guardrails and Mandatory PO Decisions

Security controls must fail closed across analysis, architecture, specification, execution, verification, and completion. The Core must persist and validate a versioned Security Profile, security-relevant approvals, residual-risk acceptances, blockers, and evidence; prompts and adapters cannot waive these gates.

Two distinct Product Owner decisions are mandatory for affected work:

1. architecture security approval, based on Gaspar and Glenn's threat model, recommended controls, alternatives, costs, and residual risks;
2. implementation security acceptance, based on current implementation, infrastructure, test, dependency, and security-review evidence.

A module cannot become `READY` without the first decision and cannot become `COMPLETE` without the second. Material changes to threats, trust boundaries, dependencies, controls, infrastructure exposure, or implementation assumptions invalidate affected security approval and return work to analysis or correction.

Gaspar coordinates and persists security decisions; Belthazar implements secure defaults and reports deviations; Prometheus enforces least privilege and hardened, recoverable operations; Lucca proves controls through negative and abuse-case testing; Glenn independently assesses and blocks material risks; Spekkio challenges the evidence and denies `PASS` when security obligations remain unresolved. Only the Product Owner may accept residual risk, explicitly and traceably. A waiver remains distinct from `PASS`.

PO approval, waiver, and risk acceptance MUST occur through interactive human-only `chrono` commands and be cryptographically signed with a key outside the project and agent context, preferably in the operating-system keychain. The signature binds action, scope, artifact identity, exact revision/hash, signer, and timestamp. The Core persists the event append-only in SQLite; changed content invalidates it. Missing interactivity, identity, key access, or signature validity yields `APPROVAL_REQUIRED`, and no adapter or agent may impersonate the PO.

The Core must return `EXECUTION_DENIED` or `COMPLETION_DENIED` when a required Security Profile, PO decision, current evidence, or blocker resolution is absent, stale, contradictory, or invalid.

------------------------------------------------------------------------

## 27. Traceability

Implementation work must be traceable to approved project knowledge.

Conceptually:

``` text
IMPLEMENTATION
      │
      ▼
    TASK
      │
      ▼
 WORK PACKAGE
      │
      ▼
ACCEPTANCE CRITERION
      │
      ▼
 REQUIREMENT
      │
      ▼
    SPEC
      │
      ▼
     ADR
```

Not every work item requires every level, but no implementation task
should exist without an approved Spec or explicitly documented technical
requirement.

------------------------------------------------------------------------

## 28. Change Control

Approved Specs must not be silently changed during implementation.

If an implementation discovers a required change to:

- product behavior;
- business rules;
- architecture;
- approved contracts;
- scope;
- significant security assumptions;

the affected work must enter change control.

Gaspar performs impact analysis and determines affected:

- requirements;
- ADRs;
- Specs;
- Harnesses;
- Work Packages;
- tests;
- security analysis;
- roadmap dependencies.

Product Owner approval is requested when the change exceeds delegated
authority.

Unaffected work may continue when the dependency graph proves it is
safe.

------------------------------------------------------------------------

## 29. Verification and Correction

Code completion is not project completion.

Lucca provides automated behavioral evidence.

Glenn provides security evidence.

Spekkio independently verifies the implementation against approved
artifacts.

A failed verification must classify the defect and route it to the
correct authority/agent.

Examples:

``` text
IMPLEMENTATION_DEFECT → Belthazar
UX_DEFECT             → Melchior
INFRASTRUCTURE_DEFECT → Prometheus
TEST_DEFECT           → Lucca
SECURITY_DEFECT       → Glenn
ARCHITECTURE_DEFECT   → Gaspar
SPECIFICATION_DEFECT  → Gaspar
PRODUCT_AMBIGUITY     → Product Owner
```

After correction, affected tests/reviews are rerun and Spekkio verifies
again.

------------------------------------------------------------------------

## 30. PASS, FAILED and WAIVED

CHRONO must preserve the distinction between:

``` text
PASS
FAILED
WAIVED
```

A Product Owner may consciously accept a known problem or risk through a
waiver.

A waiver never converts a failure into a pass.

Waivers must remain persistent and traceable.

------------------------------------------------------------------------

## 31. Definition of Ready

A Spec/module may enter autonomous execution only when applicable
readiness conditions are satisfied.

At minimum, CHRONO should evaluate:

- scope defined;
- out-of-scope defined;
- functional requirements identified;
- relevant non-functional requirements identified;
- business rules documented;
- relevant ADRs referenced;
- no blocking architectural decision unresolved;
- data impact documented;
- APIs/contracts defined when applicable;
- security requirements analyzed;
- Security Profile and threat model current;
- Product Owner architecture-security approval persisted;
- error scenarios defined;
- relevant edge cases identified;
- acceptance criteria defined;
- dependencies identified;
- Harness generated;
- consistency validation passed;
- Work Packages defined;
- DAG valid;
- required Product Owner approval persisted.

------------------------------------------------------------------------

## 32. Definition of Done

A module is complete only when applicable completion conditions are
satisfied.

At minimum:

- implementation matches approved Specs;
- acceptance criteria verified;
- required automated tests pass;
- Lucca evidence exists;
- security blockers are resolved or explicitly waived;
- Glenn evidence exists;
- Product Owner implementation-security decision exists;
- security evidence and approvals remain current for the implemented revision;
- documentation remains consistent;
- no blocking defects remain;
- Spekkio issued PASS;
- required state transitions are valid.

Gaspar coordinates completion but cannot bypass a valid blocker or
independent QA failure.

------------------------------------------------------------------------

## 33. Runtime and Model Independence

The following are CHRONO concepts:

``` text
ROLE
AUTHORITY
WORKFLOW
STATE
GATE
HANDOFF
BLOCKER
ESCALATION
ARTIFACT
REQUIREMENT
DECISION
ADR
SPECIFICATION
HARNESS
MODULE
WORK PACKAGE
TASK
QUALITY VERDICT
WAIVER
```

They must remain independent from:

- OpenCode;
- Claude Code;
- Kiro;
- Codex;
- Gemini;
- a particular model provider;
- a particular prompt syntax;
- a particular skill format.

Adapters translate these concepts into runtime-specific mechanisms.

------------------------------------------------------------------------

## 34. First Functional CHRONO Milestone

The first implementation should prove one complete path rather than
attempting to solve every possible scenario.

Target milestone:

``` text
chrono init
    ↓
Gaspar interviews Product Owner
    ↓
Project context is persisted
    ↓
Gaspar and PO define architecture
    ↓
Gaspar creates ADRs
    ↓
Gaspar discovers required Specs
    ↓
Gaspar creates SP-001, SP-002, ...
    ↓
Harness generated for each executable Spec
    ↓
CHRONO validates deterministic consistency
    ↓
Gaspar performs semantic consistency review
    ↓
Gaspar creates Roadmap + Work Packages + DAG
    ↓
Product Owner approves a module
    ↓
CHRONO authorizes execution
    ↓
Specialized agents execute in parallel
    ↓
Lucca tests
    ↓
Glenn reviews security
    ↓
Spekkio verifies
    ↓
PASS or correction loop
    ↓
Module COMPLETE
```

The first runtime implementation should target one environment, with
OpenCode being a reasonable first candidate.

Only after the complete CHRONO workflow works in one runtime should
additional adapters be prioritized.

------------------------------------------------------------------------

## 35. What Must Not Be Built First

The initial implementation should avoid unnecessary infrastructure.

Do not begin with:

- a web dashboard;
- a remote orchestration server;
- a database server when project-local persistence is sufficient;
- a custom LLM provider;
- a custom agent runtime;
- a complex plugin marketplace;
- distributed orchestration;
- elaborate telemetry;
- a graphical workflow editor.

The first objective is to prove the architecture and SDD process.

------------------------------------------------------------------------

## 36. Implementation Priority

Recommended implementation order:

1.  define CHRONO project state schema;
2.  define authoritative artifact model;
3.  define decision/authority model;
4.  define Gaspar System Analysis Protocol;
5.  define ADR format and lifecycle;
6.  define Spec format and lifecycle;
7.  define Harness generation rules;
8.  implement deterministic reference/consistency validation;
9.  define Roadmap/Module/Work Package/DAG model;
10. implement approval gates;
11. define agent runtime interface;
12. implement one runtime adapter;
13. implement parallel Work Package dispatch;
14. integrate Lucca/Glenn evidence;
15. implement Spekkio verification and defect routing;
16. implement correction loops;
17. report advisory RTK installation, interception, health, audit, and savings state (warn-only per ADR-009);
18. enforce pinned Karpathy Guidelines installation, conversion, activation, and equivalence checks;
19. add model recommendations/configuration;
20. validate the entire workflow end-to-end;
21. only then add additional runtime adapters.

------------------------------------------------------------------------

## 37. Core Design Principles

CHRONO development must preserve these principles:

> **UNDERSTAND before designing.**

> **SPECIFY before implementing.**

> **APPROVE before autonomy.**

> **VERIFY before completion.**

And additionally:

> **The Product Owner defines the product; Gaspar understands and
> architects it.**

> **Specs are discovered from the system, not imposed by a generic
> template.**

> **Agents are workers and authorities within a process; they are not
> the project's memory.**

> **Documents and structured state are the persistent project memory.**

> **A Spec is a contract; its Harness is the curated context required to
> execute that contract.**

> **LLMs perform semantic engineering work; deterministic software
> enforces process invariants.**

> **Parallelism begins only after sufficient understanding,
> specification and authorization.**

> **Autonomy is delegated and bounded, never assumed.**

> **A runtime adapter may change how CHRONO executes, but never what
> CHRONO means.**

> **Technology agnosticism is a tested Core boundary, not a marketing claim.**

The final implementation MUST pass the explainability, dry-run, drift, audit-export, metrics/privacy, bounded-loop, polyglot, non-web, and cross-runtime requirements in the [SDD Innovation Standard](../product/SDD-INNOVATION-STANDARD.md). These capabilities belong to the Core or stable ports; adapters and project templates MUST NOT encode them as technology-specific exceptions.

------------------------------------------------------------------------

## 38. Definition of CHRONO

The intended framework can be summarized as:

> **CHRONO is a runtime-independent, human-governed, multi-agent
> software architecture and Spec-Driven Development framework that
> converts Product Owner intent into persistent system knowledge,
> architecture, ADRs, modular specifications and execution harnesses;
> validates their consistency; converts approved specifications into an
> executable roadmap and dependency graph; and coordinates specialized
> AI agents working autonomously and in parallel under deterministic
> gates, traceable authority, automated testing, security review and
> independent verification.**

Conformance additionally requires a current `INNOVATION_PASS`; without it, CHRONO MUST NOT claim final v1 compliance.

The purpose is not autonomous code generation.

The purpose is **controlled, documented, traceable, context-aware and
verifiable software engineering using multiple AI agents as specialized
engineering participants.**
