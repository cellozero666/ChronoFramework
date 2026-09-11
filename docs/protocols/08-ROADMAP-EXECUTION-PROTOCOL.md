# CHRONO Roadmap and Execution Protocol

**Status:** Normative protocol

**Planning owner:** Gaspar
**Execution authority:** CHRONO Core

## 1. Entry gate

Roadmap generation MAY begin only when sufficient Architecture, ADRs, Specs, Harnesses, and consistency results exist. Execution MAY begin only for a validated and PO-approved Module.

## 2. Planning model

Gaspar MUST organize ready Specs into meaningful Modules, decompose them into assignable Work Packages and Tasks, identify dependencies, define inputs/outputs/evidence, assign roles, and build a DAG.

Modules are the primary PO execution-approval unit. Work Packages MUST be coherent, bounded, traceable, independently verifiable where practical, and explicit about shared files/resources. Planning MUST optimize safe parallelism, not maximum concurrency.

## 3. DAG rules

Every dependency MUST reference an existing target and declare why it exists. The Core MUST reject cycles, missing nodes, inconsistent states, and execution before predecessors satisfy their required completion state.

Gaspar SHOULD break avoidable coupling through approved interfaces/contracts. Work that is genuinely atomic MAY remain together.

## 4. Module presentation and approval

Before approval, Gaspar MUST present scope, Specs, Work Packages, dependencies, parallelism, risks, security status, validation results, evidence obligations, and meaningful unresolved warnings.

PO Module Approval MUST bind to the exact module and artifact revisions. It MUST NOT substitute for Architecture Security Approval, Implementation Security Acceptance, or risk Waiver.

## 5. Execution authorization

For every dispatch, the Core MUST verify:

- target, Spec, Module, Work Package, and assigned role exist;
- the Spec is `READY` and its Harness is current;
- architecture and security approvals are current;
- module approval covers the target revision;
- dependencies are satisfied and no blocker applies;
- runtime capabilities and least-privilege permissions are valid;
- a genuine RTK installation from `https://github.com/rtk-ai/rtk` is healthy and routing commands;
- the pinned Karpathy Guidelines skill from `https://github.com/multica-ai/andrej-karpathy-skills` is trusted, equivalent, discoverable, permitted, and activation-tested for the assigned agent;
- no relevant artifact changed after validation/approval.

Failure MUST return structured `EXECUTION_DENIED` reasons. The adapter MUST obey the result and MUST NOT duplicate or reinterpret policy.

## 6. Runtime boundary

The runtime-neutral contract MUST support conceptual operations equivalent to `start(role, context)`, `send(message)`, `handoff(...)`, `result()`, and `stop()`. OpenCode, Claude Code, Kiro, Codex, and Gemini adapters translate these operations using native mechanisms.

Adapters MAY define agent files, skills, hooks, permissions, and subprocess behavior. They MUST NOT define lifecycle authority, mark approvals, clear blockers, accept risk, or declare completion independently.

OpenCode, Claude Code, and Kiro are required v1 adapters. Each MUST support bidirectional enforcement: `chrono run` obtains Core authorization before dispatch, and a native blocking pre-tool hook calls `chrono gate` before protected actions even when the runtime was started directly. Absence or failure of either path MUST deny agent execution. Runtime/model selection comes only from PO-owned configuration; no provider, model, or version may be hardcoded.

## 7. Mandatory RTK execution

OpenCode MUST use RTK's official OpenCode integration. Claude Code MUST use the official `PreToolUse` integration. Kiro MUST use a tested blocking `PreToolUse` interceptor or equivalent wrapper until official native support is verified. Configuration-file presence is insufficient; each runtime MUST pass a routing smoke test after restart.

RTK absence, name collision, incompatibility, stale attestation, failed routing, or bypass MUST produce `BLOCKED_RTK` and prevent all agent dispatch. Installation requires applicable permission and MUST use the canonical upstream defined above.

## 7.1 Mandatory process-skill execution

All adapters MUST install artifacts deterministically derived from the pinned canonical `skills/karpathy-guidelines/SKILL.md`: `.claude/skills/karpathy-guidelines/`, `.opencode/skills/karpathy-guidelines/`, and `.kiro/skills/karpathy-guidelines/`. Kiro agents MUST include the appropriate `skill://` resource; OpenCode agents MUST have skill permission; Claude agents MUST discover the pinned skill. Adapter instructions MUST require activation before work, because passive discovery is insufficient.

Every agent MUST apply think-before-coding, simplicity-first, surgical-change, and goal-driven verification behavior. The skill is subordinate to PO decisions, CHRONO protocols/Core, approved artifacts/Harness, and role rules. Missing, untrusted, modified, divergent, inactive, or bypassed skill state MUST produce `BLOCKED_PROCESS_SKILL` and deny dispatch.

## 8. Execution behavior

Agents MUST receive only authorized Harness-derived context. They MUST record material decisions, outputs, evidence, blockers, and handoffs. A discovered ambiguity or contract change MUST stop affected work and invoke classification/change control. Mandatory process-skill activation and revision MUST be recorded in the execution result.

Destructive or production-impacting operations MUST require explicit applicable authorization and recovery planning. Agents MUST use least privilege and MUST NOT expose secrets in context or reports.

## 9. Parallel execution

The Core MAY authorize parallel Work Packages only when dependencies, shared-resource conflicts, security constraints, and evidence requirements permit. A blocker affects only proven dependent scope; unrelated continuation requires deterministic proof.

## 10. Completion of execution

Code generation or agent success is not completion. Outputs MUST enter test, security, and independent verification under the Verification & Correction Protocol.

## 11. Derived implementation details

The Domain/Core specification MUST define scheduler behavior, bounded concurrency, SQLite locking/transaction strategy, process transport, retry limits, and the exact runtime API before implementation. These details MUST preserve fail-closed bidirectional enforcement and the approved state model.
