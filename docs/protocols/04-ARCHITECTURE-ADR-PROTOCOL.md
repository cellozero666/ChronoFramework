# CHRONO Architecture and ADR Protocol

**Status:** Normative protocol

**Owner:** Gaspar
**Security participant:** Glenn

## 1. Entry gate

Architecture MAY begin only after System Analysis completion. Existing architecture MUST be discovered before proposals are made. Unresolved product or security blockers MUST prevent affected architecture approval.

## 2. Architecture process

Gaspar MUST derive architecture from authoritative requirements, rules, constraints, decisions, repository evidence, and the Security Profile. Gaspar MUST distinguish current architecture, proposed architecture, and approved architecture. The mandatory Karpathy Guidelines skill requires explicit assumptions/tradeoffs, minimal sufficient architecture, surgical scope, and verifiable success criteria, but MUST NOT override CHRONO requirements or controls.

Architecture MUST address applicable system boundaries, components, data, integrations, interfaces, runtime/deployment, security, observability, testing, recovery, and operational ownership. It MUST remain domain-appropriate and MUST NOT assume a web application.

## 3. Product Owner participation

Gaspar MUST explain significant choices using context, alternatives, consequences, risks, cost/complexity, reversibility, and a recommendation. Decisions outside delegated autonomy MUST be obtained explicitly from the Product Owner and persisted.

## 4. Security architecture gate

Gaspar and Glenn MUST update the Security Profile and perform threat modeling before architecture approval. Trust boundaries, sensitive assets, authentication, authorization, data protection, secrets, dependency provenance, infrastructure exposure, abuse cases, detection, response, backup, and recovery MUST be addressed where applicable.

The Product Owner MUST issue an explicit Architecture Security Approval after reviewing controls and residual risks. Without it, affected Specs and Modules MUST NOT become `READY`. Generic architecture approval MUST NOT substitute for this decision.

## 5. ADR creation

An ADR is REQUIRED for a decision that establishes or materially changes system structure, technology, data/integration contracts, security posture, deployment, cross-cutting quality, or an important constraint/tradeoff.

Each ADR MUST contain identity, title, status, context, decision, alternatives, consequences, affected artifacts, authority, approval, security impact, supersession links, and provenance. ADRs MUST use a lifecycle that preserves rejected, accepted, superseded, and deprecated decisions.

## 6. Consistency and precedence

Active ADRs MUST NOT conflict with explicit PO decisions or one another. Specs consume approved architecture and MUST NOT introduce undocumented architectural decisions. A discovered conflict MUST create a blocker and invoke impact analysis.

## 7. Change control

Material architecture changes MUST create or supersede an ADR, identify affected requirements/Specs/Harnesses/Modules/WPs/tests/security evidence, invalidate stale approvals, rebuild affected context, and re-run validation. Unaffected DAG branches MAY continue only when deterministic validation proves independence.

## 8. Exit gate

Architecture is ready for Spec discovery only when applicable decisions and ADRs are resolved, security architecture is reviewed, the Architecture Security Approval is current, deterministic references validate, semantic review passes, and no blocking inconsistency remains.

## 9. Prohibited behavior

Agents MUST NOT hide architecture inside code, Specs, prompts, or runtime configuration; silently choose a material technology; weaken approved controls; or use autonomy to bypass PO authority.

## 10. Implementation constraints

V1 MUST use a TypeScript monorepo on supported Node.js LTS releases, a mandatory global `chrono` launcher delegating to a pinned local Core, hybrid Markdown/YAML plus SQLite persistence, required OpenCode/Claude Code/Kiro adapters, and Apache License 2.0 (`Apache-2.0`) distribution with preserved third-party attribution. Exact package decomposition and ADR serialization are specified later. Approval authenticity and state ownership are normative in the Authority and Artifact protocols and MUST NOT be redefined by implementation.
