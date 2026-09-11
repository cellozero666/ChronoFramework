# CHRONO Framework — Core Invariants

**Status:** Normative — Phase 2 deliverable
**Source authority:** All nine normative protocols, `docs/reference/FRAMEWORK-DEFINITION.md`, `docs/implementation/IMPLEMENTATION-PLAN.md`
**Scope:** This document enumerates the absolute invariants the deterministic CHRONO Core MUST enforce, the error taxonomy used to report violations, and the fail-closed semantics that apply when any invariant cannot be confirmed true. These invariants are the boundary that no LLM, agent, prompt, adapter, or file edit may cross.

---

## 1. Invariant Categories

| Category | Invariants |
|---|---|
| [I-01] Authority | Product Owner supremacy, delegation boundaries, no silent overrides |
| [I-02] State | Legal transitions, projection correctness, no hidden children |
| [I-03] Approval | Interactive, signed, revision-bound, append-only |
| [I-04] Gate | Fail-closed authorization, no bypass by prompt/adapter/agent |
| [I-05] Traceability | Implementation → Task → WorkPackage → AcceptanceCriterion → Requirement → Specification → ADR |
| [I-06] Security | Security Profile, two PO decisions, fail-closed, risk acceptance scope |
| [I-07] RTK | Mandatory, genuine, routing-verified, fail-closed |
| [I-08] Process Skill | Mandatory, pinned, deterministic, activation-tested, fail-closed |
| [I-09] Reference Integrity | Unique IDs, resolvable references, no stale revisions for execution |
| [I-10] Evidence | Binds to revision, append-only, current for verification |
| [I-11] Model/Provider Neutrality | No hardcoded provider/model/version in domain or code |
| [I-12] Persistence | State independent of AI session, model, or runtime |
| [I-13] Communication | Structured events, no conversational-only decisions |
| [I-14] Secrets | No secrets in prompts, logs, reports, fixtures, or persisted artifacts |

---

## 2. Authority Invariants [I-01]

### 2.1 Product Owner supremacy
The Product Owner is the final authority over product requirements, business rules, scope, significant architecture, conscious risk acceptance, and authority conflicts. No agent or adapter MAY override an explicit Product Owner decision.
- `[FW.§298-313, P2.1]`

### 2.2 Gaspar autonomy boundaries
Gaspar may act autonomously ONLY within delegated authority. No autonomy mode permits Gaspar to:
- invent product requirements
- silently change business rules
- exceed approved scope
- override explicit PO decisions
- accept risk for the PO
- choose a provider, model name, or model version
- invent decisions that fall outside delegated authority
- `[P2.2-2.4, FW.§284-291, P1.4, P1.25]`

### 2.3 No model/provider selection in domain
No agent, prompt, adapter, or runtime configuration MAY select a provider, model name, or model version. Model selection is external PO-owned configuration. A missing required model selection is a configuration error, NOT permission for the framework to choose.
- `[FW.§1097, P1.4, P1.25, REF.§1224, PL.8]`

### 2.3.1 Provider/model neutrality in code
No framework source, defaults, templates, generated agent definitions, tests, or adapters MAY hardcode a provider, model name, or model version.
- `[FW.§1097, P1.25, REF.§1224, PL.8]`

---

## 3. State Invariants [I-02]

### 3.1 Legal state sets
Every entity MUST have a state from its approved legal set. No other state values are permitted.
- `[FW.§594-598, P3.9]`

### 3.2 Legal transitions only
Every state transition MUST be one of the legal transitions defined in `STATE-MODEL.md`. The Core MUST reject illegal transitions.
- `[FW.§596, P7.5]`

### 3.3 Project projection correctness
The Project state MUST NOT hide a blocked, failed, running, or awaiting-approval child. The projection precedence defined in `STATE-MODEL.md` §3 is mandatory.
- `[FW.§596, P3.9]`

### 3.4 WAIVED is never PASSED
`WAIVED` and `PASSED` are distinct; a waiver never converts a failure into a pass. Verification status MUST NOT conflate them.
- `[FW.§379, P2.6, P3.9, P9.3]`

### 3.5 No silent state mutation
No prompt, agent instruction, or direct file edit MAY mutate operational state in SQLite without Core validation.
- `[P7.5, FW.§648]`

---

## 4. Approval Invariants [I-03]

### 4.1 Human-interactive approval
PO approval, waiver, and risk acceptance MUST be issued ONLY through interactive human-only commands. They are NEVER automated, prompted, or invoked by agents/adapters as the PO.
- `[P2.10, FW.§1196, REF.§1196]`

### 4.2 Signing key isolation
The PO signing key MUST remain outside the project and agent-accessible context, preferably in the OS keychain. The Core MUST NOT read the key from the project directory or context.
- `[FW.§1196, REF.§1196, P2.10]`

### 4.3 Signature binding
Every signature MUST bind: the exact action, scope, artifact identity, exact revision/hash, signer identity, and timestamp.
- `[FW.§1196, P2.10]`

### 4.4 Material change invalidates approval
A material change to the bound artifact creates a new revision hash, which invalidates the approval. Re-approval is required.
- `[FW.§1196, P2.10, P3.5]`

### 4.5 Append-only approvals
Approval events are append-only in SQLite. They are never deleted or modified.
- `[FW.§671, P3.5]`

### 4.6 Approval_required on any failure
If interactivity, verified identity, key access, or signature validity cannot be confirmed, the Core MUST return `APPROVAL_REQUIRED`.
- `[P2.10, FW.§1196]`

---

## 5. Gate Invariants [I-04]

### 5.1 Fail-closed authorization
Any gate that cannot be confirmed satisfied MUST deny the operation. "Unknown" is "denied", never "allowed."
- `[P7.5, P8.5, P1.37, P1.41, FW.§592, REF.§1192]`

### 5.2 No prompt/adapter bypass
No prompt, runtime adapter, agent, or direct file edit MAY bypass a required Core gate. The adapter MUST obey `AUTHORIZED`/`DENIED` and MUST NOT duplicate or reinterpret policy.
- `[FW.§648-649, P7.5, P8.5]`

### 5.3 Execution authorization (bidirectional)
A runtime adapter MUST support BOTH:
1. `chrono run` obtains Core authorization before dispatch.
2. Native pre-tool hooks call `chrono gate` before protected actions, so a directly-started runtime session cannot bypass CHRONO.
- `[FW.§1077, P1.35, REF.§1214, P8.6]`

### 5.3.1 Both paths must be proven
If either dispatch authorization or in-runtime hook enforcement cannot be proven, agent execution MUST be denied.
- `[FW.§1077, REF.§1214]`

### 5.4 Required approvals bound to revision
A Module may enter execution only when its PO approval binds to the exact current module and artifact revisions.
- `[P8.4, P8.5, FW.§661, FW.§1017]`

### 5.5 Security approval prerequisite for READY
A Spec MUST NOT become `READY` without a current Security Profile and Architecture Security Approval.
- `[P5.5, P4.4, P6.5, P9.3]`

### 5.6 Security acceptance prerequisite for COMPLETE
A Module may enter `COMPLETE` only when Implementation Security Acceptance is current for the implemented revision.
- `[P9.3, P2.6, FW.§560, REF.§1267]`

---

## 6. Traceability Invariants [I-05]

### 6.1 Implementation traceability chain
Every implementation task MUST be traceable to an approved Specification or an explicitly documented technical requirement. Untraceable changes are suspicious and MUST be examined during verification.
- `[FW.§691-715, P3.4, P5.8]`

### 6.2 Evidence binds to revision
Evidence MUST bind to the implementation/artifact revision it proves.
- `[P3.4, P9.2]`

### 6.3 COMPLETE requires traceability
COMPLETE requires traceability from implementation through work, acceptance criteria, Specifications, and authoritative knowledge where applicable.
- `[P3.4, P9.3]`

### 6.4 Deletion preserves traceability
Deletion MUST NOT silently break traceability. Deletion is tombstone/supersession.
- `[P3.3]`

---

## 7. Security Invariants [I-06]

### 7.1 Security Profile mandatory
A versioned Security Profile containing threat model, trust boundaries, data classification, authn/authz, secrets, dependencies, infrastructure, logging/privacy, abuse cases, test strategy, controls, and residual risks MUST exist for affected scope.
- `[P1.5, P4.2, P6.5, REF.§1258]`

### 7.2 Two mandatory PO security decisions
1. Architecture Security Approval (before affected Specs become READY)
2. Implementation Security Acceptance (before COMPLETE/Spekkio final PASS)
- `[P2.6, P4.4, P5.5, P9.3, FW.§557-560, REF.§1262]`

### 7.3 Generic approval never substitutes
Silence, inactivity, conversational statements, or generic module approval MUST NOT be recorded as either security decision.
- `[P2.6, P1.5, FW.§557, REF.§1262]`

### 7.4 Security blockers fail closed
Glenn's unresolved material `SECURITY_BLOCKER` MUST prevent affected execution or completion.
- `[FW.§161, P2.7, P5.5, P9.3]`

### 7.5 Material security change invalidates
Material changes to threats, trust boundaries, dependencies, controls, infrastructure, or implementation assumptions invalidate affected security decisions and reopen analysis/correction.
- `[P2.6, REF.§1267, P4.7]`

### 7.6 Spekkio challenges security evidence
Spekkio MUST NOT issue PASS while a required security decision, failed control, unexpired blocker, or unaccepted residual risk remains.
- `[P9.3, FW.§571, REF.§1271]`

### 7.7 Least privilege everywhere
All agents operate under least privilege, deny-by-default access, minimal context/data exposure, secret non-disclosure, input/output validation, dependency provenance, and safe tool use.
- `[FW.§564-571, P2.6, P9.3, REF.§1269]`

### 7.8 Risk acceptance scope
Only the Product Owner MAY accept residual security or product risk. A Waiver MUST record scope, rationale, evidence, compensating controls, follow-up, and expiry/review condition.
- `[P2.8, FW.§511, REF.§1269]`

### 7.9 Secrets protection
Secrets MUST NOT be written to prompts, logs, reports, fixtures, or persisted artifacts.
- `[P4.14, P8.8]`

---

## 8. RTK Invariants [I-07]

### 8.1 Mandatory RTK
RTK is required for all agent-driven CLI execution. Its absence MUST fail closed.
- `[P6.5, P1.37, REF.§1188, P8.7]`

### 8.2 Genuine RTK only
Only the binary from `https://github.com/rtk-ai/rtk` (Rust Token Killer) is accepted. `rtk --version` alone is insufficient; `rtk gain` MUST succeed to prove identity.
- `[P1.37, REF.§123]`

### 8.3 No silent fallback
CHRONO MUST NOT silently fall back to raw/unfiltered command output when RTK is absent, incompatible, or bypassed. It MUST stop with actionable instructions.
- `[REF.§1192, P1.37, REF.§1220]`

### 8.4 Routing verification required
Configuration-file presence is NOT proof of operation. Each adapter MUST prove effective command routing through a routing self-test.
- `[P6.5, REF.§1189, P8.7]`

### 8.5 RTK attestation freshness
A current RTKAttestation is required before dispatch. Stale or invalid attestation → `BLOCKED_RTK` → dispatch denied.
- `[P6.5, P6.7, P7.3, P8.5, P8.7]`

### 8.6 RTK outside domain ownership
RTK does NOT own CHRONO state, governance, gates, or lifecycle. Token savings evidence MUST NOT be conflated with billing savings validation.
- `[REF.§1192, P6.5, REF.§1220]`

---

## 9. Process-Skill Invariants [I-08]

### 9.1 Mandatory skill
The Karpathy Guidelines skill is mandatory for all CHRONO agent runtimes. Its absence MUST fail closed.
- `[P6.6, P1.41, REF.§1196]`

### 9.2 Canonical upstream
The only accepted upstream is `https://github.com/multica-ai/andrej-karpathy-skills`. References to other repositories MUST NOT silently redirect.
- `[P6.6, P1.41, REF.§1196]`

### 9.3 Pinned immutable commit
The canonical source is pinned to an immutable reviewed commit. Floating `main` is NOT acceptable for production.
- `[P1.37, REF.§1196, P8.6]`

### 9.4 Deterministic generation
Runtime artifacts for Claude Code, OpenCode, and Kiro MUST be deterministically derived from `skills/karpathy-guidelines/SKILL.md` without LLM rewriting.
- `[P6.6, REF.§1190, P8.6]`

### 9.5 License preservation
MIT license and attribution MUST be preserved.
- `[P6.6, REF.§1196, P8.6]`

### 9.6 Activation required
The skill MUST be active (not merely discoverable) before analysis, planning, implementation, tests, security review, or verification. On-demand discovery alone is insufficient.
- `[P6.6, REF.§1198, P8.6]`

### 9.7 Skill attestation freshness
A current SkillAttestation is required before dispatch. Missing, modified, untrusted, divergent, inactive, or bypassed state → `BLOCKED_PROCESS_SKILL` → dispatch denied.
- `[P6.6, P6.7, P7.3, P8.5, P8.6, P9.8]`

### 9.8 Skill subordination
The skill's authority is subordinate to: Product Owner → CHRONO protocols/Core → approved artifacts/Harness → role rules. The skill MUST NOT override CHRONO authority, redefine contracts, accept risk, clear blockers, or simplify away mandatory controls.
- `[FW.§1224, P6.6, P7.4, REF.§1268, P8.6]`

---

## 10. Reference Integrity Invariants [I-09]

### 10.1 Unique identities
Artifact identities MUST be unique within the project scope.
- `[P3.2, P5.7, P7.2]`

### 10.2 Resolvable references
Every reference MUST resolve to an existing compatible artifact revision.
- `[P3.3, P5.7, P7.2]`

### 10.3 No stale revisions for execution
References used for execution/verification MUST bind to current revisions. Stale revisions are invalid for execution.
- `[P3.3, P8.5, P9.3]`

### 10.4 Acyclic DAG
The Work Package dependency graph MUST be acyclic.
- `[P8.3, REF.§1259, P7.2]`

### 10.5 Complete traceability
There MUST be no orphan work — every Work Package and Task traces to an approved Spec or documented technical requirement.
- `[P3.3, P7.2, FW.§715]`

---

## 11. Evidence Invariants [I-10]

### 11.1 Evidence binds to revision
Evidence MUST bind to the implementation/artifact revision it proves.
- `[P3.4, P9.2]`

### 11.2 Evidence append-only
Evidence records are immutable files or versioned artifacts referenced by SQLite indices.
- `[P3.5, P9.2]`

### 11.3 Evidence completeness for verification
Verification requires current test and security evidence. Missing evidence → verification fails.
- `[P9.3, P9.5, FW.§560]`

### 11.4 RTK preserves evidence
RTK output compression MUST NOT convert failing commands into success or hide available full evidence. Exit status MUST be preserved.
- `[P7.4, REF.§1662]`

---

## 12. Persistence Invariants [I-12]

### 12.1 Session independence
Project state MUST NOT depend on an LLM session, context window, model, or runtime. Closing a session, changing models, or changing agents MUST NOT erase decisions or approvals.
- `[FW.§606-607, P1.4, P3.9]`

### 12.2 Hybrid ownership
Markdown/YAML owns human-readable contracts; SQLite owns transactional operational state. SQLite MUST NOT replace documents as contracts.
- `[P3.9, FW.§671, REF.§1192]`

### 12.3 Deterministic reproducibility
Deterministic validation results MUST be reproducible from persisted inputs and tool versions.
- `[P7.6, P9.2]`

---

## 13. Communication Invariants [I-13]

### 13.1 Structured communication
Important decisions MUST use structured artifacts/events (HANDOFF, BLOCKED, RESOLVED, DEFECT, SECURITY_BLOCKER, ESCALATION, QA_REPORT, APPROVAL, WAIIVER, CHANGE_REQUEST).
- `[FW.§410-421, P2.5]`

### 13.2 No conversational authority
Conversation, model memory, and temporary reasoning MUST NOT be authoritative storage. Decisions MUST be persisted as artifacts.
- `[P1.6, P2.5, FW.§453-455, REF.§1271]`

---

## 14. Error Taxonomy

The Core uses this taxonomy to classify and report invariant violations. Errors are structured and persistent.

### 14.1 Authorization failures
| Code | Meaning | Invariant |
|---|---|---|
| `EXECUTION_DENIED` | One or more execution preconditions failed | I-04.1, I-04.6 |
| `COMPLETION_DENIED` | One or more completion preconditions failed | I-04.1, I-05.3 |
| `APPROVAL_REQUIRED` | Missing, invalid, or non-interactive approval | I-04.1, I-03.6 |
| `SECURITY_BLOCKER` | Material security condition prevents progress | I-07.4 |
| `BLOCKED_RTK` | RTK missing, stale, incompatible, unhealthy, or bypassed | I-08.5 |
| `BLOCKED_PROCESS_SKILL` | Skill missing, divergent, untrusted, inactive, or bypassed | I-09.7 |
| `PRODUCT_BLOCKER` | Product ambiguity prevents architecture | I-01.2 |

### 14.2 State violations
| Code | Meaning | Invariant |
|---|---|---|
| `INVALID_STATE` | Illegal state transition attempted | I-02.2 |
| `ILLEGAL_TRANSITION` | Transition violates legal transition table | I-02.2 |
| `STALE_REVISION` | Reference to non-current artifact revision | I-09.3 |
| `HIDDEN_CHILD_STATE` | Project projection would hide blocking child | I-02.3 |

### 14.3 Reference integrity failures
| Code | Meaning | Invariant |
|---|---|---|
| `ENTITY_NOT_FOUND` | Referenced artifact does not exist | I-09.2 |
| `DUPLICATE_IDENTITY` | Artifact identity already exists | I-09.1 |
| `REFERENCE_UNRESOLVABLE` | Reference target not found | I-09.2 |
| `DAG_CYCLE` | Dependency graph contains a cycle | I-09.4 |
| `ORPHAN_DETECTED` | Work not traceable to approved Spec | I-09.5 |

### 14.4 Validation failures
| Code | Meaning | Invariant |
|---|---|---|
| `VALIDATION_ERROR` | Schema, required field, or constraint violation | I-09.1 |
| `MISSING_REQUIRED_ARTIFACT` | Required artifact (Spec, Harness, SecurityProfile, etc.) absent | I-04.6, I-05.1 |
| `INCONSISTENT_REFERENCE` | Reference resolves but is incompatible | I-09.2, I-09.3 |

### 14.5 Security failures
| Code | Meaning | Invariant |
|---|---|---|
| `SECURITY_BLOCKER` | Material security condition | I-07.4 |
| `SECURITY_EVIDENCE_MISSING` | Required security evidence absent | I-07.6, I-11.3 |
| `SECURITY_APPROVAL_STALE` | Architecture Security Approval or Implementation Security Acceptance is stale/invalid | I-05.6, I-06.2 |
| `SECRET_DETECTED` | Secret material found in output to be persisted | I-07.9 |

### 14.6 RTK/skill failures
| Code | Meaning | Invariant |
|---|---|---|
| `BLOCKED_RTK` | RTK attestation missing/stale/invalid/bypassed | I-08.5 |
| `RTK_ROUTING_FAILURE` | Command not routed through RTK | I-08.4 |
| `RTK_NAME_COLLISION` | Installed `rtk` is not Rust Token Killer | I-08.2 |
| `BLOCKED_PROCESS_SKILL` | Skill attestation missing/stale/invalid/bypassed | I-09.7 |
| `SKILL_PROVENANCE_FAILURE` | Upstream divergence, hash mismatch, or license issue | I-09.2, I-09.3 |
| `SKILL_ACTIVATION_FAILURE` | Skill not active in runtime | I-09.6 |

### 14.7 Evidence/audit failures
| Code | Meaning | Invariant |
|---|---|---|
| `EVIDENCE_STALE` | Evidence binds to non-current revision | I-06.3, I-11.1 |
| `EVIDENCE_MISSING` | Required evidence not provided | I-06.3, I-11.3 |
| `SIGNATURE_INVALID` | Approval/waiver signature failed verification | I-04.3, I-04.6 |

### 14.8 Severity model
| Severity | Blocking behavior |
|---|---|
| `ERROR` | Fails the evaluated operation immediately |
| `WARNING` | Credible concern requiring recorded disposition; MAY be non-blocking with justification |
| `BLOCKER` | Prevents the named target/gate; fail-closed |
| `[P7.3]` |

Security policy MAY elevate findings. Agents MUST NOT downgrade findings to pass a gate.
- `[P7.4]`

---

## 15. Invariants Cannot Be Weakened

### 15.1 No override by authority conflict
A conflict between Gaspar's architecture/process authority and Spekkio's quality authority is escalated to the Product Owner. Neither may override the other.
- `[FW.§340-351, P2.7]`

### 15.2 No override by implementation agent
Belthazar, Melchior, Prometheus, Lucca, and Glenn MUST NOT redefine architecture, weaken security controls, or override PO decisions. Security deviations MUST be reported, not silently applied.
- `[P2.7, FW.§565-571, P9.3, REF.§1269]`

### 15.3 No override by adapter
An adapter MUST obey `AUTHORIZED`/`DENIED` from the Core and MUST NOT mark work ready, approved, passed, or complete independently.
- `[P8.5, FW.§51]`

### 15.4 No override by prompt
A prompt MUST NOT be able to bypass a required gate, approve work, waive a blocker, clear a security blocker, or accept risk.
- `[FW.§648-649, P7.5, P4.9, REF.§1259]`

---

## 16. Fail-Closed Summary

The deterministic Core applies fail-closed semantics whenever any mandatory state cannot be confirmed:

| Cannot confirm | Result |
|---|---|
| Local Core absent, incompatible, or unverifiable | Fail closed; global launcher does NOT substitute its own Core |
| RTK attestation missing, stale, incompatible, unhealthy, or bypassed | `BLOCKED_RTK`; dispatch denied |
| Skill attestation missing, divergent, untrusted, inactive, or bypassed | `BLOCKED_PROCESS_SKILL`; dispatch denied |
| PO approval missing, non-interactive, or signature invalid | `APPROVAL_REQUIRED` |
| Security Profile or PO security decision missing/stale/contradictory | `EXECUTION_DENIED` / `COMPLETION_DENIED` |
| References unresolvable or stale for execution | `EXECUTION_DENIED` |
| DAG cycle or orphan work | `EXECUTION_DENIED` |
| Spekkio FAILS or blocker unresolved | `COMPLETION_DENIED` |
| Evidence stale or missing for verification | Verification fails |
| Illegal state transition attempted | Rejected; no mutation |

- `[FW.§1175, P1.35, P1.37, P1.41, P2.10, P6.5, P6.6, P6.7, P7.5, P8.5, P8.7, P9.3]`

---

## 17. Invariant-to-Protocol Traceability Matrix

| Invariant ID | Primary protocol(s) |
|---|---|
| I-01 | FW.294-361, P2.1-2.4, P1.4, P1.25 |
| I-02 | FW.591-607, P3.8-3.9, P7.5 |
| I-03 | FW.652-677, P2.10 |
| I-04 | FW.611-650, P7.5, P8.5 |
| I-05 | FW.681-716, P3.4 |
| I-06 | FW.497-573, P1.5, P2.6, P4.4, P5.5, P9.3 |
| I-07 | P1.37, P6.5, P8.7, REF.1188-1220 |
| I-08 | P1.41, P6.6, P8.6, REF.1196-1198 |
| I-09 | P3.2-3.5, P5.7, P7.2, P8.3 |
| I-10 | P3.4, P9.2-9.5 |
| I-11 | P1.25, FW.1097, REF.1224 |
| I-12 | FW.585-607, P3.9 |
| I-13 | FW.402-456, P2.5 |

Where `FW` = `docs/reference/FRAMEWORK-DEFINITION.md`, `P` = `docs/protocols/0X-*.md`, `REF` = `docs/architecture/REFERENCE-ARCHITECTURE.md`.
