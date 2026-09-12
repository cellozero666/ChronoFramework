# CHRONO System Analysis Protocol

**Status:** Normative protocol

**Owner:** Gaspar
**Security participant:** Glenn

## 1. Purpose

This protocol governs CHRONO from initialization until authoritative knowledge is sufficient to begin architecture without inventing product requirements.

## 2. Inputs and outputs

Inputs are the Product Owner request, repository, existing CHRONO state, and existing documentation. Required outputs are persisted project purpose, actors, workflows, requirements, business rules, constraints, integrations, data domains, security concerns, infrastructure constraints, technical preferences, decisions, open questions, blockers, provenance, and a System Analysis completion record.

Conversation and model memory MUST NOT be authoritative storage.

## 3. Discovery order

Before asking or deciding, Gaspar MUST inspect, in order:

1. persistent CHRONO state and configuration;
2. authoritative project knowledge and Product Owner decisions;
3. ADRs and approved Specs;
4. repository documentation, source, tests, infrastructure, and history;
5. available runtime context;
6. the responsible authority.

Gaspar MUST NOT ask for information reliably available from a higher-precedence source. Conflicts MUST be persisted and resolved through the Authority & Decision Protocol.

## 4. Initialization

Gaspar MUST determine whether the project is greenfield, existing, or already CHRONO-managed. Existing repositories MUST be inspected before the Product Owner interview. Inspection MUST be read-only until authority for changes exists.

Initialization MUST run through the globally installed `chrono` launcher, pin and verify the project-local Core, and register both dispatch and blocking `chrono gate` hooks for OpenCode, Claude Code, and Kiro. A missing/incompatible local Core or unproven hook MUST block agent execution. The Product Owner's runtime/model selection MUST be recorded as configuration; no provider, model, or version may be supplied by a hardcoded default.

Initialization MUST detect the selected runtime and a genuine, compatible RTK installation from `https://github.com/rtk-ai/rtk`. `rtk gain` MUST succeed (binary identity) and an effective routing proof MUST be recorded per adapter (`chrono rtk prove`; CANDIDATE until `chrono rtk promote` after adapter approval). Missing, stale, incompatible, or bypassed RTK MUST create `BLOCKED_RTK`; no agent-driven CLI execution MAY begin. `[ADR-006, INV §8]`.

Initialization MUST also install or verify the mandatory Karpathy Guidelines skill from the CHRONO-pinned immutable revision of `https://github.com/multica-ai/andrej-karpathy-skills`. The adapter MUST prove provenance, source/generated hashes, license attribution, runtime discovery, agent permission, and activation. Missing, divergent, modified, untrusted, inactive, or bypassed skill state MUST create `BLOCKED_PROCESS_SKILL` and prevent Gaspar or specialist dispatch.

## 5. Adaptive analysis

The interview MUST be adaptive rather than a fixed questionnaire. Gaspar MUST investigate only material gaps concerning:

- problem, outcomes, users, actors, and workflows;
- functional and non-functional requirements;
- business rules and permissions;
- data ownership, classification, retention, and privacy;
- integrations, trust boundaries, and external dependencies;
- operational environments, deployment, recovery, and observability;
- scale, performance, availability, and compliance constraints;
- existing decisions, technical preferences, and prohibited choices;
- ambiguity, assumptions, risks, and unresolved questions.

Gaspar MAY make implementation-neutral recommendations but MUST distinguish evidence, inference, proposal, and authoritative decision. Gaspar MUST apply the mandatory skill's think-before-coding, simplicity, surgical-change, and goal-driven verification behaviors, subordinate to CHRONO authority and artifacts.

## 6. Mandatory security discovery

Gaspar and Glenn MUST create a versioned Security Profile containing assets, threat actors, trust boundaries, data classification, authentication, authorization, secrets, dependencies/supply chain, infrastructure exposure, logging/privacy, abuse cases, security test strategy, recommended controls, rejected alternatives, and residual risks.

Gaspar MUST present material security choices to the Product Owner with consequences, costs, alternatives, and a recommendation. Product Owner silence or generic approval MUST NOT be recorded as a security decision.

System Analysis MUST NOT complete while a `PRODUCT_BLOCKER`, `SECURITY_BLOCKER`, or unresolved material security choice prevents responsible architecture.

## 7. Knowledge persistence

Every persisted fact MUST identify its source/provenance, authority, status, and affected artifacts when known. Unknown information MUST remain explicitly unknown. Agents MUST NOT fill gaps with plausible defaults when those defaults change product behavior, risk, scope, or significant architecture.

Repository observations MUST be distinguishable from approved requirements. Inferences MUST identify their evidence and confidence and MUST NOT silently become decisions.

## 8. Completion gate

System Analysis is complete only when:

- purpose, primary actors, critical workflows, known rules, constraints, integrations, and existing PO decisions are persisted;
- the repository has been inspected when applicable;
- open questions are classified and routed;
- the Security Profile is current enough for architecture;
- no unresolved blocker prevents architecture;
- Gaspar records evidence that architecture can begin without inventing product requirements.

Completion authorizes architecture analysis only. It does not authorize implementation.

## 9. Invalid behavior

The following MUST fail validation: fixed-questionnaire completion without gap analysis; asking the PO for discoverable facts; unlabelled inference; conversational-only decisions; hidden assumptions; silent security defaults; RTK bypass; missing/bypassed mandatory process skill; and implementation before later gates.

## 10. Approved implementation boundary

Human-readable authoritative artifacts MUST be versioned Markdown/YAML; transactional operational state MUST use `.chrono/chrono.db` SQLite. State ownership follows the hierarchical model in the [Framework Definition](../reference/FRAMEWORK-DEFINITION.md). The Domain/Core specifications define schemas, transition tables, hashing algorithm, and freshness windows without changing that boundary.
