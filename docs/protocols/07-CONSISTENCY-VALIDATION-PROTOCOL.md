# CHRONO Consistency Validation Protocol

**Status:** Normative protocol

## 1. Purpose

CHRONO MUST validate authoritative artifacts before readiness, execution, verification, and completion. Validation has deterministic and semantic layers; neither substitutes for the other.

## 2. Severity

- `ERROR`: invalid data or rule violation that fails the evaluated operation.
- `WARNING`: credible concern requiring recorded disposition but not automatically blocking.
- `BLOCKER`: unresolved condition that prevents the named target/gate.

Security policy MAY elevate findings. Severity changes MUST be authorized, reasoned, and persisted; agents MUST NOT downgrade findings to pass a gate.

## 3. Deterministic validation

The Core MUST validate, where applicable:

- unique and well-formed identities;
- schema and required fields;
- valid, compatible, non-stale references/revisions;
- artifact ownership and authority;
- legal state transitions;
- required approvals and revision binding;
- Spec/Harness one-to-one executable revision mapping;
- complete traceability and absence of orphan work;
- Work Package dependency existence and acyclic DAG;
- blocker, defect, waiver, and evidence status/freshness;
- Security Profile and both applicable PO security decisions;
- RTK binary/integration attestation, routing health, and bypass absence;
- pinned Karpathy Guidelines source provenance/hash, generated artifact equivalence, license attribution, runtime discovery/permission, SkillAttestation freshness, activation, and bypass absence.

Invalid deterministic state MUST fail closed. Prompts and adapters MUST NOT suppress Core findings.

## 4. Semantic validation

Gaspar MUST compare meaning across requirements, rules, constraints, decisions, architecture, ADRs, Specs, Harnesses, Roadmap, and implementation plans. Glenn MUST participate in security contradictions. Applicable specialists SHOULD review domain-specific conflicts.

Semantic validation MUST detect incompatible behavior, missing concepts, contradictory contracts, unsafe assumptions, hidden scope/architecture changes, insufficient acceptance criteria, and Harness omissions that schemas cannot prove.

Findings MUST cite affected artifacts and evidence and MUST be persisted. An agent's confidence MUST NOT substitute for resolution.

## 5. Gate effects

- Spec `READY` requires applicable deterministic and semantic validation success.
- Module readiness/approval requires valid Specs, Harnesses, Security Profile, dependencies, and architecture-security decision.
- Execution Authorization requires valid module approval, satisfied dependencies, no blocker, current Harness, current RTKAttestation, and current SkillAttestation.
- Verification requires current test/security evidence and implementation-security decision.
- Completion requires Spekkio `PASS`, or separately recorded failures/waivers according to policy without representing them as pass.

## 6. Validation loop

```text
VALIDATE → FINDING → CLASSIFY → ROUTE → CORRECT/DECIDE
→ INVALIDATE AFFECTED ARTIFACTS → REVALIDATE
```

Only affected branches MAY continue, and only when the validated DAG and impact analysis prove independence.

## 7. Reproducibility and evidence

Deterministic validation results MUST be reproducible from persisted inputs and tool versions. Reports MUST include validator version, target/revision, timestamp, findings, evidence, and gate result. Semantic reports MUST identify reviewer role/model and artifact revisions.

## 8. RTK integrity

RTK output compression MUST NOT convert a failing command into success or hide the availability of full evidence. Validation MUST preserve exit status and enough diagnostic information to reproduce failure. Suspected truncation or bypass MUST block the affected operation and permit controlled retrieval of full output outside model context.

## 9. Derived implementation details

The Core specification MUST define numeric severity mapping, warning disposition, freshness periods, schema language, and report serialization before coding. Reports are versioned artifacts indexed transactionally in SQLite, and validators MUST be independent of the PO-selected model.
