# CHRONO Harness Protocol

**Status:** Normative protocol
**Owner:** Gaspar with deterministic Core support

## 1. Definition

The Spec is the contract. The Harness is the minimal curated execution context required to implement and verify that contract. Every executable Spec MUST have one authoritative Harness per executable revision.

Agent-specific context is a derived view of that Harness, not an independent Harness. Runtime files such as `AGENTS.md`, skills, custom-agent definitions, or hooks are adapter artifacts and MUST NOT replace authoritative Harness state.

## 2. Generation

Harness generation MUST combine:

1. deterministic reference and dependency resolution by the Core;
2. semantic relevance analysis by Gaspar and applicable specialists.

The Core MUST resolve references and reject missing, stale, circular, incompatible, or unauthorized inputs. Gaspar MUST explain non-obvious inclusion/exclusion decisions.

## 3. Required content

A Harness MUST contain or reference, where applicable:

- Spec identity and exact revision;
- relevant requirements, rules, constraints, decisions, ADRs, and architecture;
- dependent Specs and dependency state;
- relevant source paths and repository revision;
- interfaces, conventions, implementation constraints, and forbidden decisions;
- acceptance criteria and Definition of Ready/Done;
- testing, security, evidence, and reporting obligations;
- assigned role(s), authority limits, handoff/escalation paths;
- approved module/Work Package scope and execution authorization context;
- current Security Profile/control references;
- current RTKAttestation, SkillAttestation, and runtime capability references.

## 4. Context budgeting

The Context Resolver MUST include enough information to avoid invention while excluding unrelated project history. It SHOULD prefer stable references and concise authoritative excerpts. It MUST NOT remove constraints, negative cases, security obligations, authority limits, or acceptance criteria merely to save tokens.

Role views MAY emphasize implementation, UI/UX, infrastructure, testing, security, or verification information, but MUST derive from the same authoritative Harness revision and MUST preserve common contract invariants.

## 5. RTK requirement

All agent-driven CLI reading/searching/testing/building/version-control operations SHOULD be routed through a verified RTK integration when supported by RTK. The only accepted upstream is `https://github.com/rtk-ai/rtk`. RTKAttestation state (binary identity via `rtk gain`) and routing-proof state (`chrono rtk prove` records a CANDIDATE, `chrono rtk promote` authorizes it after signed adapter approval) are reported as advisory `RtkWarning`s and NEVER gate dispatch (PO decision ADR-009). `[ADR-006, ADR-009]`.

RTK reduces command output; it MUST NOT filter away required evidence irrecoverably. Full raw output MAY be retained outside LLM context when needed for audit/debugging, subject to secrets/privacy policy, while agents receive the curated output.

## 6. Mandatory process skill

Every role view MUST require the pinned Karpathy Guidelines skill from `https://github.com/multica-ai/andrej-karpathy-skills`. Claude Code, OpenCode, and Kiro artifacts MUST be generated deterministically from one canonical `SKILL.md`; LLM rewriting is forbidden. The skill MUST be active throughout analysis, planning, execution, testing, security, and verification and remain subordinate to PO/CHRONO/artifact/role authority. A current SkillAttestation is REQUIRED; file presence or on-demand discoverability alone is insufficient.

## 7. Freshness and invalidation

Changes to a referenced Spec, ADR, requirement, Security Profile, source revision, dependency, control, module approval, runtime capability, or mandatory process-skill revision MUST invalidate or mark the Harness stale when material. Execution with a stale Harness MUST be denied.

## 8. Validation

Before use, the Core MUST verify identity, revision binding, required sections, reference integrity, authorization, dependency state, security state, RTK health, and context budget policy. Gaspar MUST perform semantic sufficiency review.

## 9. Prohibited behavior

Agents MUST NOT create divergent role Harnesses, rely on conversation history as missing context, omit inconvenient controls, or silently fetch unrelated project context to expand authority.

## 10. Derived implementation details

Harness contracts MUST be versioned Markdown/YAML and their operational index/state MUST be transactional SQLite. Token budget algorithm, source snapshot method, and exact relevance scoring are defined in the Domain/Core specification. They MUST remain model-neutral and may not omit mandatory context or controls.
