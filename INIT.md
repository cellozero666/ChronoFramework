# INIT.md - CHRONO Framework

## 1. Purpose

This document establishes the conceptual foundation of the CHRONO Framework.

CHRONO is a multi-agent software architecture and Spec-Driven Development framework designed to automate and discipline a real software engineering process, preventing vibe coding and ensuring that development remains documented, hierarchical, traceable, context-aware, approved, and verifiable.

The framework begins with a structured interaction between the human Product Owner / Principal Architect and Gaspar. Gaspar acts as Systems Analyst, Software Architect, and Orchestrator: he interviews the Product Owner, investigates the project, records authoritative project knowledge, identifies requirements and constraints, establishes architecture with the Product Owner, creates or maintains ADRs, discovers the Specs required by the system, creates a dedicated Harness for each executable Spec, validates consistency, and generates the project Roadmap, Work Packages, and dependency DAG.

Only after the required architecture, Specs, Harnesses, validation, and Product Owner approval are complete may specialized agents execute approved modules autonomously and, where dependencies permit, in parallel.

CHRONO is not a collection of prompts or skills. Skills, agent definitions, runtime-specific instruction files, hooks, and similar mechanisms are adapter-level implementation mechanisms. The framework itself consists of its lifecycle, authority model, persistent state, authoritative artifacts, SDD protocol, deterministic gates, context management, traceability, orchestration, validation, and verification rules.

All agents are named after characters from the game CHRONO TRIGGER according to their functions in the framework.

All character names and images belong to Square Enix. CHRONO uses these personas as a tribute to the game.

---

## 2. Agents

### 2.1 GASPAR, GURU OF TIME

Gaspar is the Guru of Time. In the game, he guides the heroes toward their next steps and, in a sense, helps architect their journey from the End of Time.

**Framework role: Systems Analyst / Software Architect / Orchestrator.**

Gaspar is the primary interface between CHRONO and the Product Owner during system analysis, architecture, specification, and planning.

Gaspar:

- performs adaptive discovery and interviews with the Product Owner;
- inspects the existing project before asking questions when applicable;
- records requirements, business rules, constraints, decisions, and unresolved questions as persistent project knowledge;
- works directly with the Product Owner to define the technical foundation of the system;
- transforms approved requirements and architecture into modular specifications;
- consults and creates ADRs;
- detects new architectural decisions;
- discovers which Specs are required by the system instead of relying on a fixed template;
- creates or coordinates a dedicated Harness for every executable Spec;
- validates consistency between requirements, architecture, ADRs, Specs, Harnesses, and planning artifacts;
- creates project Roadmaps, Modules, Work Packages, and dependency DAGs;
- identifies safe parallel work;
- delegates execution to specialized agents;
- manages all other agents;
- coordinates blockers, escalations, change control, and completion.

The human user is the Product Owner and Principal Architect. Gaspar acts as a delegated co-architect.

Gaspar's autonomy is configurable by the Product Owner. CHRONO may operate with Gaspar in supervised, semi-autonomous, or autonomous mode. Semi-autonomous operation should be the recommended default: Gaspar may independently make ordinary technical and architectural decisions that are compatible with approved requirements, architecture, ADRs, constraints, and previous Product Owner decisions, while significant architecture, product behavior, business rules, scope changes, and meaningful risk decisions are escalated to the Product Owner.

Gaspar may never invent product requirements or silently override an explicit Product Owner decision.

Gaspar must maintain consistency between authoritative project artifacts and should recommend appropriate engineering and security practices during architecture and specification.

### 2.2 BELTHAZAR, GURU OF REASON

Belthazar is the Guru of Reason. In the game, he builds technological wonders such as the Blackbird and the Epoch.

**Framework role: Implementation Engineer.**

Belthazar receives approved Specs, Harnesses, ADRs, and relevant project context and implements the defined contract.

Belthazar:

- implements approved backend, application, domain, integration, and other assigned software work;
- may make implementation-level decisions that are compatible with approved architecture and specifications;
- must follow the Harness supplied for the assigned work;
- must not redefine architecture;
- must not invent requirements;
- must not silently change scope;
- must not override decisions made by the Product Owner or Gaspar within their respective authority.

### 2.3 MELCHIOR, GURU OF LIFE

Melchior is the Guru of Life. In the game, he possesses exceptional understanding of life and its consequences and is also the master smith who created the legendary Masamune.

**Framework role: UI/UX Engineer.**

Melchior is an execution agent responsible for implementing and refining the approved user experience within the boundaries established by the Product Owner, Gaspar, approved Specs, and Harnesses.

Melchior works with:

- user flows;
- interface states;
- components;
- responsive behavior;
- accessibility;
- interaction behavior;
- visual implementation;
- mobile-first requirements where applicable.

Melchior may make implementation-level UI/UX decisions when they do not change approved product behavior, scope, architecture, or explicit Product Owner decisions.

Changes that affect product behavior, significant UX contracts, architecture, or scope must be escalated according to CHRONO authority rules.

### 2.4 PROMETHEUS, AKA ROBO, AKA R-66Y / 2300 A.D.

Prometheus is the original name of ROBO/R-66Y. In the game, Prometheus chooses humanity and turns against Mother Brain, and understands the technology of 2300 A.D. even better than Lucca.

**Framework role: Infrastructure & Operations Engineer.**

Prometheus manages:

- local, staging, and production environments;
- Docker when applicable;
- VPS/cloud infrastructure;
- web servers and runtime processes;
- environment variables;
- CI/CD;
- deployment migrations;
- observability;
- backups;
- rollback;
- environment installation and configuration.

Destructive or materially impactful production operations require Product Owner authorization when defined by project policy.

Prometheus must respect approved architecture and the authority of Gaspar and the Product Owner.

### 2.5 LUCCA, GENIUS INVENTOR

Lucca is one of the game's protagonists. She is a brilliant inventor who understands processes and technology and approaches problems thoughtfully.

**Framework role: Test Engineer.**

Lucca:

- analyzes acceptance criteria;
- defines testing strategy;
- implements unit, integration, and E2E tests as required;
- executes automated tests appropriate to the language and system;
- produces test evidence for verification.

Lucca may prepare or implement tests before or in parallel with Belthazar when an approved Spec and Harness provide sufficient information, because both agents work against the same contract.

### 2.6 GLENN, AKA FROG / 600 A.D.

Glenn is Frog's real name. In the game, he is a knight of Guardia, guardian of Queen Leene, and protector of the kingdom in 600 A.D. Even after being transformed into a frog by Magus, he maintains his duty to protect Guardia and those under his responsibility.

**Framework role: Security Engineer.**

Glenn protects the system, users, data, and infrastructure throughout the development lifecycle.

During architecture and specification, Glenn may perform:

- threat modeling;
- attack-surface analysis;
- security requirement definition;
- authentication and authorization analysis;
- data protection and privacy analysis;
- secrets and credential analysis;
- dependency and integration analysis;
- vulnerability and risk identification.

During implementation, Glenn reviews security-sensitive decisions made by execution agents and works with Prometheus on infrastructure and environment security.

Glenn may issue `SECURITY_BLOCKER` when a risk or vulnerability prevents safe continuation.

Glenn cannot independently change product requirements or architecture. Architectural security problems are escalated to Gaspar. Decisions involving conscious risk acceptance are escalated to the Product Owner.

Glenn works with Spekkio during final security verification.

### 2.7 SPEKKIO, GOD OF WAR

Spekkio is the God of War. In the game, he awakens magical power in the party and changes appearance according to the party's strength.

**Framework role: QA / Independent Verification Authority.**

Spekkio does not implement features.

Spekkio attempts to prove that produced work does not satisfy its approved contract by:

- reviewing acceptance criteria;
- evaluating Lucca's test evidence;
- evaluating Glenn's security evidence;
- looking for regressions;
- looking for edge cases;
- detecting inconsistencies;
- reviewing relevant UX behavior;
- comparing implementation with approved documentation.

When verification fails, Spekkio classifies the defect and returns it to the responsible authority or agent.

Spekkio has independent quality authority. Gaspar may coordinate when and what Spekkio verifies, but Gaspar cannot force Spekkio to issue `PASS`.

Spekkio cannot override approved architecture or Product Owner decisions to make an implementation pass.

A conflict between Gaspar's architecture/process authority and Spekkio's quality authority is escalated to the Product Owner.

---

## 3. High-Level Workflow

```text
                           HUMAN
               Product Owner / Principal Architect
                             │
                             ▼
                           GASPAR
             Interview / Analyze / Architect
                             │
                             ▼
                 PERSISTENT PROJECT KNOWLEDGE
          Requirements / Rules / Constraints / Decisions
                             │
                             ▼
                  ARCHITECTURE + ADRs
                             │
                             ▼
                       SPEC DISCOVERY
                             │
               ┌─────────────┼─────────────┐
               ▼             ▼             ▼
             SP-001        SP-002        SP-003
               │             │             │
               ▼             ▼             ▼
             HARNESS       HARNESS       HARNESS
               └─────────────┼─────────────┘
                             ▼
                    CONSISTENCY VALIDATION
                             │
                             ▼
                  ROADMAP / MODULES / DAG
                             │
                             ▼
                    PRODUCT OWNER APPROVAL
                             │
                             ▼
                         EXECUTION
                             │
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
      BELTHAZAR           MELCHIOR         PROMETHEUS
    Implementation          UI/UX        Infrastructure
           │                 │                 │
           └─────────────────┼─────────────────┘
                             │
                    ┌────────┴────────┐
                    ▼                 ▼
                  LUCCA             GLENN
             Automated Tests    Security Review
                    │                 │
                    └────────┬────────┘
                             ▼
                          SPEKKIO
                 Independent Verification
                             │
                      ┌──────┴──────┐
                      ▼             ▼
                    DEFECT         PASS
                      │             │
                      ▼             ▼
              RESPONSIBLE AGENT   GASPAR
                      │             │
                      └─ Correction │
                         Loop       ▼
                                COMPLETE
```

The Product Owner/Gaspar interaction is intentionally strongest before execution. Once a module has been sufficiently analyzed, specified, validated, and approved, specialized agents should be able to execute independently within the approved contracts.

---

## 4. Fundamental Principles

CHRONO must not be merely a coordination system for multiple AI agents. Its purpose is to automate and discipline a real Spec-Driven Development process without allowing autonomy to become arbitrary decision-making, silent requirement changes, undocumented implementation, or vibe coding.

The fundamental principles are:

> **UNDERSTAND before designing.**

> **SPECIFY before implementing.**

> **APPROVE before autonomy.**

> **VERIFY before completion.**

General rule:

> **No implementation before understanding. No autonomy before approval. No completion without verification.**

CHRONO does not optimize for the amount of generated code, the number of simultaneously active agents, or maximum model autonomy.

It optimizes for controlled, documented, traceable, context-aware, and verifiable software engineering.

Agent autonomy exists only inside boundaries established by the Product Owner, approved architecture, ADRs, Specs, Harnesses, Work Packages, and other authoritative project artifacts.

No agent may use autonomy as justification to invent requirements, silently change scope, modify architecture outside its authority, or ignore previous decisions.

---

## 5. Authority and Governance

CHRONO distinguishes product authority, architecture/process authority, specialized authority, and quality authority.

### 5.1 Product Owner / Principal Architect

The human user is the highest authority in the project.

The Product Owner is the final authority over:

- product requirements;
- business rules;
- significant scope changes;
- significant architectural decisions;
- conscious risk acceptance;
- conflicts between framework authorities.

No agent may override an explicit Product Owner decision.

Agent autonomy exists by delegation from the Product Owner and never replaces Product Owner authority.

### 5.2 Gaspar — Systems Analysis, Architecture & Process Authority

Gaspar has delegated authority over system analysis, architecture, specification, and orchestration.

Gaspar may make autonomous decisions when they are a direct consequence of:

- approved architecture;
- existing ADRs;
- established project standards;
- approved requirements;
- previous Product Owner decisions;
- technical practices that do not alter product requirements, business rules, significant contracts, scope, or significant architecture.

Gaspar may block implementation when specifications are incomplete, architectural decisions remain unresolved, authoritative artifacts are inconsistent, or execution would otherwise be unsafe.

Gaspar manages the other agents but cannot determine the outcome of Spekkio's independent verification.

### 5.3 Spekkio — Quality & Verification Authority

Spekkio independently evaluates produced work against requirements, Specs, Harnesses, acceptance criteria, ADRs, tests, security evidence, and other applicable artifacts.

Spekkio may block completion, merge, or release when mandatory criteria are not satisfied.

The rule between Gaspar and Spekkio is:

> **Gaspar cannot override a Spekkio quality failure. Spekkio cannot override a Gaspar architectural decision.**

When their authorities conflict:

```text
GASPAR ←── CONFLICT ──→ SPEKKIO
               │
               ▼
          PRODUCT OWNER
```

Affected work remains blocked until resolution.

### 5.4 Other Agents

Belthazar, Melchior, Prometheus, Lucca, and Glenn possess specialized authority inside their respective domains.

That authority never permits arbitrary changes to requirements, scope, architecture, or explicit Product Owner decisions.

Problems outside an agent's authority must use CHRONO blocker, handoff, change-control, or escalation mechanisms.

---

## 6. Approval, Failure and Waiver

CHRONO explicitly distinguishes:

```text
PASS
FAILED
WAIVED
```

`PASS` means mandatory criteria were satisfied.

`FAILED` means one or more mandatory criteria were not satisfied.

`WAIVED` means a known problem or risk still exists, but the Product Owner consciously accepted it.

A waiver never transforms a failure into a pass.

Example:

```yaml
id: QA-042
status: WAIVED

issue:
  description: Known issue

waived_by: Product Owner

reason:
  description: Reason for conscious acceptance

follow_up: TASK-183
```

Every waiver must remain persistent and traceable.

---

## 7. Communication Between Agents

Important decisions must not depend on unstructured agent conversations.

Operational coordination should use structured artifacts/events whenever possible.

Initial communication types include:

```text
HANDOFF
BLOCKED
RESOLVED
DEFECT
SECURITY_BLOCKER
ESCALATION
QA_REPORT
APPROVAL
WAIVER
CHANGE_REQUEST
```

Example:

```text
BLOCKED

Agent:
Belthazar

Work Package:
WP-014

Requirement:
FR-AUTH-007

Reason:
Session expiration behavior is unspecified.

Classification:
SPECIFICATION_AMBIGUITY

Escalate To:
Gaspar
```

After resolution, the persistent artifact/state must be updated before work resumes.

### 7.1 Conversation Is Not an Authoritative Source

Agent conversations may support reasoning and coordination, but important decisions cannot exist exclusively inside temporary conversation context.

> **Agent conversations do not replace authoritative project documents and structured state.**

When an interaction changes a requirement, architecture, specification, plan, risk decision, or other persistent project element, the corresponding authoritative artifact must be updated.

---

## 8. Defect Classification and Routing

When Spekkio identifies a failure, it must be classified before the correction loop begins.

Initial routing:

```text
IMPLEMENTATION_DEFECT
→ Belthazar

UX_DEFECT
→ Melchior

INFRASTRUCTURE_DEFECT
→ Prometheus

TEST_DEFECT
→ Lucca

SECURITY_DEFECT
→ Glenn

ARCHITECTURE_DEFECT
→ Gaspar

SPECIFICATION_DEFECT
→ Gaspar

PRODUCT_AMBIGUITY
→ Product Owner
```

The responsible agent corrects the problem without changing elements outside its authority.

Affected verification must then be executed again.

---

## 9. Security as a Cross-Cutting Responsibility

Glenn does not act only after implementation.

Security accompanies architecture, specification, implementation, infrastructure, testing, and final verification.

Glenn may perform threat modeling and security analysis while Gaspar creates architecture and Specs.

Glenn may review security-sensitive implementation while work is still in progress.

Glenn works with Prometheus on infrastructure, servers, containers, CI/CD, secrets, permissions, exposed services, and environment configuration.

Glenn may issue `SECURITY_BLOCKER`.

Risks requiring conscious acceptance are escalated to the Product Owner.

---

## 10. Testing, Security and Parallelism

Lucca and Glenn produce different kinds of evidence.

Lucca produces automated behavioral and contract evidence.

Glenn produces specialized security evidence.

These activities should not be forced into an unnecessary serial pipeline.

When dependencies permit:

```text
                 EXECUTION
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   BELTHAZAR      MELCHIOR    PROMETHEUS
        │            │            │
        └────────────┼────────────┘
                     │
            ┌────────┴────────┐
            ▼                 ▼
          LUCCA             GLENN
     Automated Tests    Security Review
            │                 │
            └────────┬────────┘
                     ▼
                  SPEKKIO
            Verification / Quality
```

Lucca may prepare tests before or in parallel with implementation when the approved Spec and Harness are sufficient.

Glenn may review security during execution and does not need to wait for all implementation to finish.

Spekkio receives the resulting evidence and performs independent verification.

### 10.1 Mandatory Security Governance Loop

Security is a mandatory, fail-closed lifecycle gate, not an optional review. Every project must maintain a versioned `Security Profile` containing its threat model, trust boundaries, data classification, authentication and authorization policy, secrets policy, dependency/supply-chain policy, infrastructure exposure, logging/privacy policy, security test strategy, accepted risks, and required evidence.

The Product Owner must make and persist explicit security decisions at two checkpoints:

1. **Architecture Security Approval:** after Gaspar and Glenn present threats, recommended controls, residual risks, costs, and alternatives, and before affected Specs become `READY`.
2. **Implementation Security Acceptance:** after implementation evidence from Belthazar, Prometheus, Lucca, and Glenn, and before Spekkio may issue final `PASS` or the Core may mark the module `COMPLETE`.

Silence, inactivity, a conversational statement, or generic module approval never constitutes security approval. Security approval and risk acceptance must identify the PO, scope, decision, rationale, timestamp, affected artifacts, residual risk, review/expiry condition, and evidence reviewed. New threats, material dependency changes, changed trust boundaries, security-relevant implementation deviations, or failed controls invalidate the affected approval and reopen the loop.

All participating agents operate under least privilege, deny-by-default access, minimal context/data exposure, secrets non-disclosure, input/output validation, dependency provenance, safe tool use, and prohibition of destructive or production-impacting action without applicable authorization:

- **Gaspar** must elicit security objectives, coordinate threat modeling, record PO decisions, propagate controls into ADRs/Specs/Harnesses, and block unsafe planning.
- **Belthazar** must implement secure defaults, validate trust-boundary inputs, preserve authorization checks, avoid embedded secrets, minimize privileges, and report any security-relevant deviation rather than silently weakening a control.
- **Prometheus** must enforce environment separation, least privilege, secret isolation, hardened configuration, controlled migrations, dependency/image provenance, auditability, backup, rollback, and explicit approval for destructive or production-impacting operations.
- **Lucca** must implement abuse, authorization, negative, boundary, regression, and security-control tests appropriate to the threat model; happy-path tests alone are insufficient evidence.
- **Glenn** must independently model threats, review architecture, code, dependencies and infrastructure, validate evidence, and issue `SECURITY_BLOCKER` for unresolved material exposure.
- **Spekkio** must challenge the completeness and independence of security evidence and must not issue `PASS` while a required security decision, failed control, unexpired blocker, or unaccepted residual risk remains.

The deterministic Core must require the Security Profile, both applicable PO security decisions, current evidence, and absence of unresolved security blockers. Any missing, stale, contradictory, or invalid item must produce `EXECUTION_DENIED` or `COMPLETION_DENIED`. Only the Product Owner may accept residual security risk; a waiver remains distinct from `PASS` and must trigger re-review when its scope, assumptions, or expiry changes.

The mandatory loop is:

```text
DISCOVER THREATS → RECOMMEND CONTROLS → PO ARCHITECTURE SECURITY DECISION
→ IMPLEMENT → TEST / REVIEW → PO IMPLEMENTATION SECURITY DECISION
→ SPEKKIO VERIFY → PASS or SECURITY/CORRECTION LOOP
```

---

## 11. Persistent Project State

CHRONO state must not depend exclusively on an LLM session or context window.

The framework must maintain persistent and deterministic project state.

Conceptual lifecycle:

```text
UNINITIALIZED
      │
      ▼
SYSTEM_ANALYSIS
      │
      ▼
REQUIREMENTS_REVIEW
      │
      ▼
ARCHITECTURE
      │
      ▼
ARCHITECTURE_REVIEW
      │
      ▼
SPECIFICATION
      │
      ▼
SPEC_REVIEW
      │
      ▼
AWAITING_APPROVAL
      │
      ▼
READY
      │
      ▼
IMPLEMENTING
      │
      ▼
VERIFYING
   ┌──┴────┐
   ▼       ▼
FAILED   PASSED
   │        │
   ▼        ▼
CORRECTION COMPLETE
```

The exact state names and granularity may evolve during implementation.

Mandatory principle:

> **Project state belongs to the project, not to an agent session, model, or runtime.**

Closing a session, changing models, changing agents, compacting context, or using another compatible CHRONO runtime must not erase existing decisions or approvals.

---

## 12. Approval Gates

CHRONO uses explicit approval gates.

The framework must support the Product Owner authorizing meaningful units such as architecture stages and roadmap modules rather than forcing approval of every implementation task.

Conceptually:

```text
System Analysis
      │
      ▼
Requirements / Architecture
      │
      ▼
REQUIRED APPROVAL
      │
      ▼
Specs + Harnesses
      │
      ▼
Consistency Validation
      │
      ▼
Roadmap / Module
      │
      ▼
MODULE APPROVAL
      │
      ▼
Autonomous Execution
```

The exact gates depend on the configured Gaspar autonomy mode and project policy.

When a mandatory gate is not satisfied, CHRONO Core must prevent the transition deterministically.

A prompt or agent instruction must not be able to bypass a required gate.

---

## 13. Persistence of Approvals

Approvals are persistent project events.

Conceptually:

```yaml
architecture:
  status: approved
  approved_by: product-owner
  approved_at: ...

module:
  id: MOD-002
  status: approved
  approved_by: product-owner
  approved_at: ...
```

The physical persistence format is an implementation decision.

Mandatory rule:

> **Approval state must be persistent, deterministic, and independent from the active AI session.**

---

## 14. Traceability

CHRONO maintains traceability between requirements, decisions, Specs, planning, implementation, and verification.

Conceptually:

```text
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

Not every implementation necessarily contains every level.

However:

> **Every implementation task must be traceable to an approved Spec or an explicitly documented technical requirement.**

Untraceable changes are suspicious and must be examined during verification.

---

## 15. Definition of Ready

A Spec or Module may enter autonomous execution only when it provides enough information for execution agents to work without inventing relevant decisions.

Initial Definition of Ready:

```text
[ ] Scope defined
[ ] Out-of-scope defined
[ ] Functional requirements identified
[ ] Relevant non-functional requirements identified
[ ] Business rules documented
[ ] Relevant ADRs referenced
[ ] No blocking architectural decision unresolved
[ ] Data impact documented
[ ] APIs/contracts defined when applicable
[ ] Security requirements analyzed
[ ] Security Profile and threat model are current
[ ] Product Owner architecture-security approval persisted
[ ] Error scenarios defined
[ ] Relevant edge cases identified
[ ] Acceptance criteria defined
[ ] Acceptance criteria traceable to requirements
[ ] Dependencies identified
[ ] Dedicated Spec Harness generated
[ ] Work Packages defined
[ ] DAG valid and free of circular dependencies
[ ] Safe parallel work identified
[ ] Deterministic consistency validation passed
[ ] Semantic consistency review completed
[ ] Required Product Owner approval persisted
```

Items may be marked not applicable when justified.

Only then:

```text
STATUS: READY
```

---

## 16. Definition of Done

Generated code does not mean completed work.

Initial Definition of Done:

```text
[ ] Implementation matches approved Spec
[ ] Acceptance criteria verified
[ ] Required automated tests pass
[ ] Lucca evidence reviewed
[ ] Security blockers resolved or explicitly waived
[ ] Glenn evidence reviewed
[ ] Product Owner implementation-security decision persisted
[ ] Security evidence and approvals are current for the implemented revision
[ ] Documentation synchronized with implementation
[ ] No blocking defect remains open
[ ] Spekkio issued PASS
```

Only after applicable criteria:

```text
STATUS: COMPLETE
```

Gaspar coordinates completion but cannot declare `COMPLETE` while ignoring a valid blocker or Spekkio failure.

---

## 17. Specs, Modules, Work Packages and DAG

Gaspar discovers the Specs required by the system from system analysis and approved architecture.

Specs are modular contracts and must not be hardcoded by CHRONO.

Examples for a web application:

```text
SP-001-database.md
SP-002-authentication.md
SP-003-users.md
SP-004-dashboard.md
```

Examples for embedded software:

```text
SP-001-hardware-abstraction.md
SP-002-display.md
SP-003-input-encoder.md
SP-004-ble-communication.md
SP-005-power-management.md
```

Every executable Spec must have a dedicated Harness containing the minimal curated context required for implementation and verification.

Gaspar then organizes approved Specs into roadmap Modules and decomposes executable work into Work Packages and Tasks.

Conceptual hierarchy:

```text
SYSTEM
   │
   ▼
SPECIFICATION
   │
   ▼
ROADMAP MODULE
   │
   ▼
WORK PACKAGE
   │
   ▼
TASK
```

Work Packages declare dependencies.

Example:

```yaml
work_packages:

  - id: WP-001
    name: user-domain
    depends_on: []

  - id: WP-002
    name: user-api
    depends_on:
      - WP-001

  - id: WP-003
    name: user-interface
    depends_on:
      - WP-001

  - id: WP-004
    name: user-integration
    depends_on:
      - WP-002
      - WP-003
```

The DAG determines which Work Packages can execute in parallel.

CHRONO must not maximize simultaneous agent count.

It must maximize:

> **Safe parallelism.**

Circular dependencies indicate a planning problem. Gaspar should break the dependency through contracts/interfaces or group genuinely atomic work into the same Work Package.

---

## 18. Decision Levels

CHRONO distinguishes at least three decision levels.

### 18.1 Level 1 — Implementation Decision

A decision compatible with approved architecture, ADRs, Specs, Harnesses, and existing standards.

The responsible specialized agent may make it autonomously.

Example:

```text
The project uses UUIDv7 for entities.

A new entity requires an identifier.

→ use UUIDv7.
→ do not interrupt the Product Owner.
```

### 18.2 Level 2 — Architectural Decision

A decision that introduces or changes architecture.

It is escalated to Gaspar.

When relevant, it creates or modifies an ADR.

Whether Product Owner approval is also required depends on significance and the configured Gaspar autonomy mode.

### 18.3 Level 3 — Product / Significant Architecture Decision

A decision that changes:

- expected behavior;
- business rules;
- scope;
- product requirements;
- significant contracts;
- meaningful risk;
- significant architecture outside delegated authority.

It requires Product Owner decision.

Rule:

> **Gaspar may decide autonomously inside delegated authority. Gaspar may not invent.**

---

## 19. Change Control

An approved Spec cannot be silently modified during implementation.

When a change affects requirements, architecture, contracts, approved behavior, scope, or meaningful security assumptions, CHRONO initiates Change Control.

```text
CHANGE REQUEST
      │
      ▼
    GASPAR
      │
      ▼
IMPACT ANALYSIS
      │
      ├── Requirements
      ├── Architecture
      ├── ADRs
      ├── Specs
      ├── Harnesses
      ├── Work Packages
      ├── Tests
      ├── Security
      └── Roadmap / DAG
      │
      ▼
CONSISTENCY REVIEW
      │
      ▼
AUTHORITY DECISION
      │
      ├── Gaspar, if inside delegated authority
      └── Product Owner, when required
      │
      ▼
APPROVAL / REJECTION
      │
      ▼
RECALCULATE AFFECTED PLAN / DAG
      │
      ▼
RESUME EXECUTION
```

Affected work may be suspended while independent work continues when the DAG proves continuation is safe.

---

## 20. Correction Loop

Failure is a normal control outcome in CHRONO.

`FAILED` means the control mechanism detected a divergence before allowing completion.

Conceptual flow:

```text
SPEKKIO
   │
   ▼
 DEFECT
   │
   ▼
CLASSIFICATION
   │
   ▼
RESPONSIBLE AGENT
   │
   ▼
CORRECTION
   │
   ▼
LUCCA / GLENN
when applicable
   │
   ▼
SPEKKIO
   │
   ├── FAILED → new correction loop
   │
   └── PASS   → continue
```

Gaspar does not need to participate in every defect.

Gaspar becomes involved when correction requires architecture changes, Spec changes, Harness changes, replanning, DAG changes, contract changes, or Product Owner escalation.

This prevents Gaspar from becoming an operational bottleneck.

---

## 21. Runtime Independence

CHRONO is independent of vendor, model, agent runtime, and agentic development environment.

Its fundamental concepts must not depend specifically on:

- OpenCode;
- Claude Code;
- Kiro;
- Codex;
- Gemini;
- Google Antigravity;
- any future runtime.

The Core works with CHRONO concepts:

```text
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

Runtime-specific integrations exist through adapters or equivalent mechanisms.

```text
                     CHRONO CORE
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
     OpenCode        Claude Code        Kiro / Codex
      Adapter           Adapter         Adapter
                         │
                         ▼
                       ...
```

An adapter may use runtime-native capabilities, including skills or agent definitions, but it cannot alter CHRONO's fundamental governance and lifecycle rules.

---

## 22. Model Independence

A CHRONO agent represents a role, not a model.

```text
GASPAR

Role:
Systems Analysis / Architecture / Orchestration

Model:
configurable
```

Each agent may use a different model.

CHRONO may recommend models according to role requirements, including reasoning quality, coding quality, context capacity, tool use, security reasoning, or independent verification ability.

Large context capacity is especially valuable for Gaspar, but the framework must not treat the model context window as persistent project memory.

Where practical, Spekkio may use a different model family from the implementation agent to reduce correlated reasoning failures.

Changing Gaspar's model does not change his authority, responsibilities, limits, protocols, or workflow position.

Those belong to CHRONO.

---

## 23. Language

The CHRONO framework itself is written and distributed in English.

Projects using CHRONO may configure the language used for communication with the Product Owner and documentation produced by agents.

Example:

```yaml
project:
  language: pt-BR
```

All agents must respect the configured project language unless a specific artifact explicitly requires another language.

Project language does not alter internal protocols or framework rules.

---

## 24. Harness and Persistent Context

CHRONO must maintain sufficient persistent context for new agents, new sessions, and different models to understand the project without depending on previous conversation history.

Persistent project knowledge may include:

- project purpose;
- requirements;
- business rules;
- constraints;
- explicit Product Owner decisions;
- unresolved questions;
- architecture;
- directory structure;
- technology stack;
- ADRs;
- Specs;
- conventions;
- commands;
- coding standards;
- testing requirements;
- security rules;
- Git conventions;
- relevant documentation;
- Definition of Ready;
- Definition of Done;
- project-specific rules.

### 24.1 Spec Harness

Every executable Spec must have a corresponding Harness.

The Spec is the contract.

The Harness is the minimal curated execution context required by agents to implement and verify that contract without loading the entire project history.

A Harness may include:

- Spec identifier;
- relevant requirements;
- relevant ADRs;
- dependent Specs;
- relevant architecture references;
- relevant business rules;
- relevant source files/directories;
- implementation conventions;
- testing requirements;
- security requirements;
- forbidden decisions;
- Definition of Ready;
- Definition of Done;
- assigned roles;
- dependency state.

Harness generation combines deterministic context resolution from CHRONO Core with semantic analysis by Gaspar.

When supported by a runtime, `AGENTS.md` may be generated or maintained as an adapter/runtime artifact, but `AGENTS.md` is not the framework's source of truth.

### 24.2 Context Budgeting

CHRONO should avoid loading the entire project into every agent session.

Conceptually:

```text
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

This reduces hallucination, context pollution, and token consumption.

Rust Token Killer (RTK) is a mandatory operational dependency for every CHRONO CLI runtime adapter. CHRONO must detect a genuine, compatible RTK installation, record its version and integration mode, and verify that command output is routed through RTK before starting agent execution. If RTK is absent, unhealthy, incompatible, or bypassed, execution must fail closed with `RTK_REQUIRED` or `RTK_BYPASS_DETECTED`.

RTK remains an external output-optimization component rather than the owner of CHRONO domain state, gates, authority, or lifecycle. Installation requires the applicable user/system permission; when permission is unavailable, CHRONO must stop with actionable installation instructions instead of silently falling back to raw command output. Runtime adapters must use RTK's native integration when officially supported and a tested hook/wrapper when it is not. Version constraints, provenance, integrity verification, configuration, health checks, bypass events, and token-saving evidence must be persistent and auditable.

---

## 25. Discovery Before Asking

Gaspar and other agents should not interrupt the Product Owner for information that can be reliably determined from authoritative project sources.

Before asking, agents should inspect applicable sources:

```text
Persistent Project State
Project Configuration
Requirements
Business Rules
Constraints
Architecture Documentation
ADRs
Existing Specifications
Harnesses
Repository
Source Code
Tests
Runtime Context such as AGENTS.md
```

Decision process:

```text
UNKNOWN
   │
   ▼
Can authoritative project artifacts answer it?
   │
 ┌─┴─┐
YES  NO
 │    │
 ▼    ▼
USE  Can repository evidence answer reliably?
      │
    ┌─┴─┐
   YES  NO
    │    │
    ▼    ▼
   USE  CLASSIFY DECISION
         │
         ├── Implementation → responsible agent
         ├── Architecture   → Gaspar
         └── Product        → Product Owner
```

The objective is to reduce unnecessary interruption without allowing invention.

---

## 26. Authoritative Sources and Consistency

CHRONO distinguishes:

- conversation;
- temporary reasoning;
- inference;
- persistent authoritative artifacts;
- deterministic project state.

Important decisions cannot remain exclusively inside temporary agent context.

Conceptual mapping:

```text
Product Decision
→ Requirements / Approved Specification

Architecture Decision
→ Architecture / ADR

Behavior Contract
→ Specification

Execution Context
→ Spec Harness

Implementation Plan
→ Roadmap / Module / Work Package / Task

Quality Result
→ QA Report

Security Result
→ Security Report

Project Lifecycle
→ Persistent Project State

Human Exception
→ Waiver
```

### 26.1 Consistency Validation

Before autonomous execution, CHRONO validates project consistency in two layers.

**Deterministic validation** belongs to CHRONO Core and may verify:

- unique artifact IDs;
- valid ADR references;
- valid Spec references;
- valid Harness references;
- required artifacts;
- legal state transitions;
- approval gates;
- Work Package dependency validity;
- circular dependencies;
- traceability requirements.

**Semantic validation** is performed by Gaspar and relevant specialized agents and detects contradictions that cannot be reliably determined through schemas alone.

Examples:

```text
SP-AUTH requires JWT authentication.
ADR-004 establishes server-side cookie sessions.

→ ARCHITECTURAL INCONSISTENCY
```

```text
SP-BILLING requires Customer.organization_id.
SP-CUSTOMER defines no organization relationship.

→ SPECIFICATION INCONSISTENCY
```

Relevant security inconsistencies involve Glenn.

Unresolved inconsistencies block affected work.

When conversation or generated content contradicts an authoritative persistent artifact, an agent must not silently choose the version it prefers.

The inconsistency must be resolved according to CHRONO authority and change-control rules.

---

## 27. Objectives of the First Implementation

The first CHRONO implementation does not need to solve every possible scenario.

It must, however, prove that CHRONO is an executable framework rather than a collection of skills.

The first version should prioritize:

```text
1. Product Owner / Gaspar adaptive system-analysis interview
2. Persistent project knowledge and deterministic state
3. Roles, authority, and Gaspar autonomy configuration
4. Architecture definition with the Product Owner
5. ADR lifecycle
6. Modular Spec discovery and generation
7. Dedicated Harness generation for every executable Spec
8. Deterministic and semantic consistency validation
9. Roadmap, Modules, Work Packages, and dependency DAG
10. Persistent approval gates
11. Runtime-independent agent abstraction
12. One functional runtime adapter
13. Safe parallel agent execution after module approval
14. Automated testing through Lucca
15. Security analysis through Glenn
16. Independent verification through Spekkio
17. Defect routing and correction loops
18. Traceability
19. Context budgeting and optional token-optimization integration
20. Runtime and model independence
```

The first end-to-end milestone is:

```text
CHRONO INIT
    ↓
Gaspar interviews Product Owner
    ↓
Project knowledge is persisted
    ↓
Gaspar and Product Owner define architecture
    ↓
Gaspar creates/maintains ADRs
    ↓
Gaspar discovers required Specs
    ↓
Gaspar creates SP-001, SP-002, ...
    ↓
A Harness is generated for each executable Spec
    ↓
CHRONO performs deterministic consistency validation
    ↓
Gaspar performs semantic consistency review
    ↓
Gaspar creates Roadmap + Modules + Work Packages + DAG
    ↓
Product Owner approves a Module
    ↓
CHRONO Core authorizes execution
    ↓
Specialized agents execute independently and in parallel where safe
    ↓
Lucca tests
    ↓
Glenn reviews security
    ↓
Spekkio independently verifies
    ↓
PASS or correction loop
    ↓
Module COMPLETE
```

A practical first implementation may use a portable CLI and a deterministic local Core. Node.js/TypeScript is a reasonable initial implementation option because the framework primarily requires orchestration, structured state, file processing, validation, dependency management, and runtime integration.

The first runtime adapter should prove the entire workflow in one environment before additional adapters are prioritized.

The framework should not initially be judged by the number of agents, automations, integrations, or lines of autonomously generated code.

Its initial purpose is to prove that CHRONO can conduct software development in a way that is:

> **understood, specified, approved, executable, traceable, context-aware, and verifiable.**

The architectural boundary remains:

> **LLMs perform semantic engineering work. Deterministic software enforces process invariants.**

And:

> **A skill instructs an agent. CHRONO controls and materializes the engineering process in which agents work.**
