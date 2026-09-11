# CHRONO Authority and Decision Protocol

**Status:** Normative protocol

## 1. Purpose

This protocol defines authority, delegated autonomy, decisions, approvals, conflicts, risk acceptance, and waivers.

## 2. Authority domains

- **Product Owner / Principal Architect:** final product, business-rule, scope, significant architecture, conscious risk-acceptance, and authority-conflict authority.
- **Gaspar:** delegated system-analysis, architecture, specification, planning, and process authority.
- **Belthazar:** implementation authority inside approved contracts.
- **Melchior:** UI/UX implementation authority inside approved contracts.
- **Prometheus:** infrastructure and operations authority inside approved contracts and safety policy.
- **Lucca:** test design, automation, and behavioral-evidence authority.
- **Glenn:** security-analysis and security-blocking authority.
- **Spekkio:** independent quality-verdict authority.

No agent MAY override an explicit Product Owner decision.

Runtime behavior policy MUST follow this precedence: Product Owner; CHRONO protocols/Core; approved artifacts and Harness; agent role rules; Karpathy Guidelines skill. The skill MUST NOT create authority, accept risk, clear blockers, redefine contracts, or weaken required controls.

## 3. Decision levels

### Level 1 — Implementation

The responsible specialist MAY decide when the choice is compatible with approved requirements, architecture, ADRs, Specs, Harnesses, security controls, and conventions. The decision MUST be persisted when it affects future work.

### Level 2 — Architecture

Gaspar owns architectural decisions within delegated autonomy. Relevant decisions MUST create or update an ADR. Significant effects, material security tradeoffs, or decisions outside delegation MUST be escalated to the Product Owner.

### Level 3 — Product or significant architecture

Changes to product behavior, business rules, scope, significant contracts, significant architecture, or conscious risk acceptance REQUIRE an explicit Product Owner decision.

## 4. Gaspar autonomy

CHRONO supports `SUPERVISED`, `SEMI_AUTONOMOUS`, and `AUTONOMOUS`; `SEMI_AUTONOMOUS` is the default. The selected mode and delegated boundaries MUST be persisted.

No mode permits Gaspar to invent requirements, silently change business rules, exceed approved scope, override explicit PO decisions, or accept risk for the PO.

## 5. Decision record

An authoritative Decision MUST record identity, subject, value, level, authority, status, rationale, provenance, timestamp, affected artifacts, supersession, and required review/expiry when applicable. A decision MUST NOT exist only in conversation.

Conflicting active decisions MUST block affected readiness or execution until resolved according to precedence and change control.

## 6. Mandatory security decisions

Two separate PO decisions are REQUIRED for affected work:

1. **Architecture Security Approval:** after Gaspar and Glenn present the threat model, controls, alternatives, costs, and residual risks; required before affected Specs or Modules become `READY`.
2. **Implementation Security Acceptance:** after current implementation, infrastructure, dependency, test, and security evidence exists; required before Spekkio may issue final `PASS` and before `COMPLETE`.

Generic architecture/module approval, silence, inactivity, or an agent assertion MUST NOT substitute for either decision. Each decision MUST identify scope, revision, evidence reviewed, selected controls, rejected alternatives, residual risks, rationale, PO identity, timestamp, and review/expiry conditions.

Material change to threats, trust boundaries, dependencies, infrastructure exposure, controls, or implementation assumptions MUST invalidate affected security decisions and reopen analysis or correction.

## 7. Blockers, conflicts, and escalation

Agents MUST stop affected work and create a classified blocker when required authority or information is absent. Unaffected work MAY continue only when the validated DAG proves independence.

Gaspar cannot override a Spekkio failure. Spekkio cannot override architecture to make work pass. Glenn's unresolved material `SECURITY_BLOCKER` prevents affected execution or completion. Authority conflicts escalate to the Product Owner.

## 8. Risk acceptance and waivers

Only the Product Owner MAY accept residual security or product risk. A Waiver MUST record issue, scope, rationale, evidence, accepting authority, timestamp, compensating controls, follow-up, and expiry/review condition.

`WAIVED` MUST remain distinct from `PASS`. A waiver MUST NOT erase a defect, failed control, or evidence. Expired or invalidated waivers MUST block the affected gate.

## 9. Deterministic enforcement

The Core MUST persist approvals and decisions, validate authority and freshness, detect conflicts, and fail closed. Prompts, runtime adapters, agents, or direct file edits MUST NOT bypass required authority.

## 10. Approval authenticity

PO approval, waiver, and risk acceptance MUST be issued only through an interactive human terminal using `chrono approve`, `chrono waive`, or the corresponding risk command. A signing key outside the project and agent context, preferably in the operating-system keychain, MUST sign the exact action, scope, artifact identity, revision/hash, signer, and timestamp. Events are append-only in SQLite and material changes invalidate affected signatures. Missing interactivity, verified identity, key access, or signature validity MUST produce `APPROVAL_REQUIRED`. Agents and adapters MUST be unable to impersonate or automate PO authority.
