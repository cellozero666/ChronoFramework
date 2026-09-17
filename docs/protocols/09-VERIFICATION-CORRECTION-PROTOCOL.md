# CHRONO Verification and Correction Protocol

**Status:** Normative protocol
**Independent authority:** Spekkio

## 1. Purpose

Implementation output MUST be independently verified against approved contracts before completion. Failure is a controlled outcome that starts a correction loop.

## 2. Evidence roles

- **Lucca** MUST produce behavioral, contract, negative, boundary, regression, and applicable abuse-case test evidence.
- **Glenn** MUST produce independent security evidence covering the Security Profile, code, dependencies, configuration, infrastructure, and residual risks.
- **Belthazar, Melchior, and Prometheus** MUST provide implementation/UX/operational evidence required by their Harnesses.
- **Spekkio** MUST assess the approved artifacts, implementation revision, Lucca evidence, Glenn evidence, unresolved findings, and traceability without implementing fixes.

Evidence MUST identify producer, tool/model, timestamp, target revision, command/check, result, retained diagnostics, and integrity/provenance where applicable.

## 3. Implementation security decision

After current evidence exists, Gaspar and Glenn MUST present controls, failed checks, deviations, residual risks, and recommendations to the Product Owner. The Product Owner MUST persist an explicit Implementation Security Acceptance or rejection bound to the implemented revision.

Spekkio MUST NOT issue final `PASS`, and the Core MUST NOT authorize `COMPLETE`, when this decision is missing/stale, required evidence is absent, a security control fails, or a `SECURITY_BLOCKER` remains unresolved. Only the PO may accept residual risk through a traceable Waiver; `WAIVED` is never `PASS`.

## 4. Verdicts

- `PASS`: all mandatory applicable criteria and gates are satisfied.
- `FAILED`: one or more mandatory criteria are unsatisfied.
- `WAIVED`: a known issue/risk remains and the PO explicitly accepts it; it does not alter the failed fact.

Gaspar MUST NOT force `PASS`. Spekkio MUST NOT change approved architecture or requirements to obtain `PASS`.

## 5. Defect classification and routing

- `IMPLEMENTATION_DEFECT` → Belthazar
- `UX_DEFECT` → Melchior
- `INFRASTRUCTURE_DEFECT` → Prometheus
- `TEST_DEFECT` → Lucca
- `SECURITY_DEFECT` → Glenn
- `ARCHITECTURE_DEFECT` → Gaspar
- `SPECIFICATION_DEFECT` → Gaspar
- `PRODUCT_AMBIGUITY` → Product Owner

Each Defect MUST identify severity, evidence, affected criteria/artifacts, owner, blocking scope, and reproduction information.

## 6. Correction loop

```text
SPEKKIO FAILED → DEFECT → CLASSIFY → RESPONSIBLE AUTHORITY
→ CORRECT/DECIDE → UPDATE AFFECTED ARTIFACTS
→ LUCCA/GLENN RE-EVIDENCE WHEN APPLICABLE
→ PO SECURITY RE-DECISION WHEN INVALIDATED
→ SPEKKIO REVERIFY
```

Gaspar participates when correction changes architecture, Spec, Harness, plan, DAG, contract, security assumptions, or requires PO authority. Ordinary defects MUST NOT make Gaspar an unnecessary bottleneck.

## 7. Invalidation and regression

Corrections MUST trigger impact analysis. Affected approvals, Harnesses, evidence, security decisions, and verdicts MUST be invalidated when their bound revision or assumptions change. Required regression scope MUST be documented and executed.

## 8. RTK and evidence completeness

CLI verification SHOULD use a current RTKAttestation; its absence records an advisory `RtkWarning` and never blocks verification (ADR-009). RTK-compressed results MUST preserve exit status and actionable failures. When compression is insufficient, full output MAY be retained outside LLM context under secrets/privacy controls and referenced by evidence.

Verification and correction agents MUST use a current SkillAttestation for the pinned Karpathy Guidelines source at `https://github.com/multica-ai/andrej-karpathy-skills`. Spekkio MUST verify that changes were assumption-aware, minimally sufficient, surgically scoped, and driven by explicit success criteria, while treating CHRONO contracts and mandatory controls as higher authority. Skill absence, divergence, inactivity, or bypass MUST block the verdict.

## 9. Definition of Done

A Module may become `COMPLETE` only when implementation matches approved Specs, criteria are verified, required tests pass, Lucca and Glenn evidence is current, blockers are resolved or validly waived, documentation is synchronized, no blocking defect remains, the PO implementation-security decision is current, SkillAttestation is current (RTK posture is advisory-only per ADR-009), Spekkio issued `PASS`, traceability is intact, and the state transition is legal. Final v1 release additionally requires Spekkio's current `INNOVATION_PASS` and the complete evidence set defined by the [SDD Innovation Standard](../product/SDD-INNOVATION-STANDARD.md).

## 10. Completion record

The Core MUST persist the completion decision, target/revision, evidence set, approvals, verdict, remaining waivers, timestamp, and authority. Completion MUST be reproducible without conversation history.

## 11. Derived implementation details

Evidence payloads remain immutable files or versioned artifacts referenced by SQLite evidence indexes; approval/waiver/risk events require PO signatures under the Authority protocol. The Core specification MUST define content hashing, retention, severity matrix, finite retry limits, and release/merge coupling before coding. No retry may bypass a blocker or PO gate.
