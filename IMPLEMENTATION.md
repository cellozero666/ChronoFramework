# CHRONO — Implementation Plan

**Status:** Execution roadmap  
**Primary generator/target:** OpenCode CLI with Laguna S 2.1  
**Rule:** Complete and review each phase before starting the next. Do not implement the Core from the conceptual documents alone.

## Goal

Deliver one minimal end-to-end CHRONO workflow in OpenCode while preserving the architectural boundary:

```text
Formal Protocols → Domain Model → Core Specification → Deterministic Core
                 → CLI → OpenCode Adapter → Specialized Agents → MVP
```

The Core owns state, validation, gates and execution authorization. Agents perform semantic work. The CLI and runtime adapters are interfaces to the Core, not the Core itself.

## Phase 1 — Formalize the protocols

Create and cross-review the nine normative documents required by `CHRONO.md` under `/DOCS`:

1. System Analysis
2. Authority and Decision
3. Artifact Model
4. Architecture and ADR
5. Specification
6. Harness
7. Consistency Validation
8. Roadmap and Execution
9. Verification and Correction

**Gate:** all documents use the same terminology, authority boundaries and lifecycle; ambiguities are recorded instead of guessed.

Laguna S 2.1 must generate these artifacts first and submit a cross-document consistency report. It must not scaffold implementation packages during this phase.

## Phase 2 — Derive the domain

From the approved protocols, define:

- domain entities and ownership;
- artifact identity and reference rules;
- entity-level state machines and legal transitions;
- events, approvals, blockers, defects, waivers and evidence;
- gate conditions and traceability rules;
- invariants and error taxonomy.

Resolve explicitly which entity owns states such as `READY`, `FAILED` and `COMPLETE`. Treat the state machine in `INIT.md` as conceptual until this derivation is approved.

**Deliverables:** `/DOCS/DOMAIN-MODEL.md`, `/DOCS/STATE-MODEL.md`, `/DOCS/CORE-INVARIANTS.md`.

**Gate:** every Core concept is traceable to a protocol rule; no runtime-specific concept appears in the domain.

## Phase 3 — Specify the Core and runtime contract

Write implementation-ready specifications for:

- persistence and migrations;
- artifact registry and reference resolution;
- state-transition engine;
- deterministic validation and gate engine;
- context resolver and one Harness per executable Spec;
- Roadmap/Module/Work Package DAG;
- execution authorization;
- evidence, defect, waiver and correction records;
- runtime-neutral `AgentRuntime` contract.

Select the simplest local persistence format that supports atomic updates, recovery and schema evolution. Define ports/interfaces before choosing CLI or OpenCode details.

**Deliverables:** `/DOCS/CORE-SPECIFICATION.md`, `/DOCS/RUNTIME-CONTRACT.md`, machine-readable schemas and architecture ADRs.

**Gate:** acceptance tests can be written from the specification without inventing behavior.

## Phase 4 — Implement the deterministic Core and CLI

Use a small TypeScript workspace with separate packages for domain/application Core, persistence, CLI and adapters. Implement the smallest useful API first:

```text
init · status · validate · approve · authorizeExecution · recordEvidence
block · resolve · verify · complete
```

Then expose it through a thin `chrono` CLI. Add unit tests for domain rules and integration tests for persistence, invalid transitions, references, approvals and cyclic dependencies.

**Gate:** direct API and CLI produce the same decisions; mandatory gates cannot be bypassed by malformed state or agent instructions.

### Mandatory security guardrails

Implement security as Core-enforced state, not prompt-only guidance:

- versioned Security Profile and threat model;
- separate, persisted PO decisions for architecture security and implementation security;
- stale-approval invalidation after material threat, dependency, trust-boundary, infrastructure, or control changes;
- `SECURITY_BLOCKER`, residual-risk acceptance, scope, rationale, evidence, author, timestamp, and review/expiry tracking;
- fail-closed `EXECUTION_DENIED` and `COMPLETION_DENIED` results;
- least-privilege runtime/tool permissions, secret redaction, untrusted-input boundaries, artifact provenance, and audit events;
- explicit confirmation for destructive or production-impacting operations.

Only the PO may accept residual risk. Generic approval is insufficient, and `WAIVED` must never be normalized to `PASS`.

### Mandatory RTK guardrail

RTK is required for all agent-driven CLI execution. Implement a runtime-neutral `TokenOptimizer` capability with RTK as the mandatory v1 provider. Before dispatch, the Core must validate an auditable health result containing binary identity, compatible version, integration mode, routing self-test, timestamp, and adapter identity. Missing, stale, incompatible, unhealthy, or bypassed RTK must return `EXECUTION_DENIED`.

Installation is a setup prerequisite, not an implicit privilege: detect first, request applicable permission when installation is needed, verify provenance/integrity, pin a compatible range, and never fall back silently. Persist `rtk gain`/session evidence for observability, but do not confuse estimated token savings with billing savings.

**Canonical and only accepted upstream repository:** [https://github.com/rtk-ai/rtk](https://github.com/rtk-ai/rtk). The installer must reject the unrelated Rust Type Kit package with the same `rtk` name. `rtk --version` alone is insufficient: `rtk gain` must succeed and display the Token Killer savings dashboard.

#### Required bootstrap algorithm

The CHRONO installer must execute this logic after obtaining permission to install software and modify the user's global OpenCode/Claude configuration:

```sh
set -eu

RTK_REPOSITORY="https://github.com/rtk-ai/rtk"

if command -v rtk >/dev/null 2>&1; then
  rtk --version
  if ! rtk gain >/dev/null 2>&1; then
    echo "RTK_NAME_COLLISION: installed rtk is not Rust Token Killer" >&2
    exit 1
  fi
else
  if command -v git >/dev/null 2>&1 && command -v cargo >/dev/null 2>&1; then
    cargo install --git "$RTK_REPOSITORY"
  elif command -v brew >/dev/null 2>&1; then
    brew install rtk
  else
    echo "RTK_INSTALL_BLOCKED: install Git+Cargo or Homebrew, then retry" >&2
    exit 1
  fi
fi

rtk --version
rtk gain
rtk init -g --opencode
rtk init -g --auto-patch
rtk init --show
rtk git status
```

The Cargo path is preferred because it installs directly from the canonical repository. Homebrew is the approved fallback documented upstream. The installer must not use `cargo install rtk`, because the upstream documentation warns about a package-name collision. It must not automatically uninstall or overwrite an unknown `rtk`; it must stop and report the collision.

`rtk init -g --opencode` installs the official OpenCode TypeScript plugin. `rtk init -g --auto-patch` installs and registers the official Claude Code `PreToolUse` hook non-interactively, while RTK creates backups of affected Claude configuration. The process must display the intended global changes before requesting permission, run both commands only after approval, and require the affected runtimes to be restarted.

#### Mandatory post-install verification

Configuration-file presence is not proof of operation. Before enabling CHRONO agents, the bootstrap must persist evidence that:

- `rtk gain` succeeds, proving the binary is Rust Token Killer;
- `rtk init --show` reports the integration as installed;
- a fresh OpenCode session routes a supported shell command through RTK;
- a fresh Claude Code session triggers the RTK `PreToolUse` rewrite;
- `rtk git status` succeeds inside the target project;
- the installed version satisfies CHRONO's pinned compatibility policy.

Any failed check must set setup state to `BLOCKED_RTK` and prevent all agent dispatch. The raw-output fallback is forbidden.

## Phase 5 — Implement the OpenCode adapter

Map CHRONO roles to OpenCode-native agents and mechanisms without duplicating Core policy. The adapter must:

- start Gaspar for repository inspection and adaptive discovery;
- persist decisions and generated artifacts through Core operations;
- request authorization before dispatching execution work;
- build role-specific context views from the single Harness attached to a Spec;
- dispatch only dependency-ready Work Packages;
- collect Lucca and Glenn evidence;
- submit results to Spekkio and persist verdicts/defects;
- resume safely after process or context interruption;
- force Gaspar to obtain the PO architecture-security decision before readiness and the PO implementation-security decision before completion;
- force Belthazar, Prometheus, Lucca, Glenn, and Spekkio to execute their mandatory security duties and escalate any attempted weakening of approved controls;
- configure RTK through its official OpenCode plugin integration, verify command rewriting with a smoke test, and block dispatch when interception fails.

Agent definitions are versioned adapter assets. They must not become authoritative project state.

**Gate:** the adapter obeys `AUTHORIZED`/`DENIED` from the Core and cannot independently mark work ready, approved, passed or complete.

## Phase 6 — Prove the MVP end to end

Use a small greenfield fixture and one existing-repository fixture to prove:

```text
init → analysis → persisted knowledge → architecture/ADRs → discovered Specs
→ Harnesses → validation → Roadmap/DAG → PO module approval → execution
→ tests/security evidence → independent verification → correction or COMPLETE
```

Required negative tests:

- execution without approval is denied;
- missing/invalid references are rejected;
- cyclic dependencies are rejected;
- unresolved blockers prevent affected work;
- an agent cannot override a PO decision;
- a waiver remains distinct from `PASS`;
- Spekkio failure prevents completion;
- restart/model change does not lose state;
- generic module approval cannot substitute for either security decision;
- missing, expired, stale, or contradictory security evidence fails closed;
- material dependency/control changes reopen security review;
- prompts/adapters cannot clear security blockers or accept risk;
- secrets are not written to prompts, logs, reports, fixtures, or persisted artifacts;
- destructive/production actions require explicit applicable authorization.
- missing, unhealthy, incompatible, stale, or bypassed RTK denies agent execution;
- adapter tests prove actual RTK command routing and record savings evidence.

**MVP exit:** one module reaches `COMPLETE` with full traceability and persisted evidence using OpenCode CLI.

## Phase 7 — Harden and prove adapter portability

After the OpenCode MVP, add recovery, atomicity, migrations, audit history, adversarial/compliance tests, RTK adoption/savings measurement, and user documentation. Extract a black-box adapter compliance suite, then implement:

1. **Claude Code adapter:** map roles/instructions/hooks to Claude Code and configure RTK through its officially supported `PreToolUse` integration.
2. **Kiro adapter:** map roles to project custom agents, least-privilege permissions, resources, and hooks. Since RTK does not currently document native Kiro support, implement a blocking `PreToolUse` shell interceptor or equivalent wrapper and prove effective RTK routing with the same compliance suite.

Each adapter must pass identical lifecycle, security, RTK, restart, authorization, evidence, and correction-loop tests. Adapter-specific hooks translate runtime behavior; they never own CHRONO policy. Codex and Gemini remain later adapters.

Do not build a dashboard, remote orchestrator, database server, custom LLM provider, distributed scheduler or plugin marketplace before evidence shows it is necessary.

## Execution rules for the implementation agent

- Read `INIT.md`, `CHRONO-FRAMEWORK-ARCHITECTURE.md`, `CHRONO.md` and this file before acting.
- Work phase by phase and stop at each gate for review; never jump directly to TypeScript.
- Use Laguna S 2.1 as the generating model in OpenCode, but treat model output as untrusted until deterministic validation and independent review pass.
- Preserve user changes and record unresolved architectural choices rather than silently deciding outside delegated authority.
- Keep framework protocols, deterministic Core, agent definitions and runtime adapters separate.
- Prefer a thin vertical slice over broad scaffolding with placeholder behavior.
- For every phase, report files changed, tests/evidence, open decisions and the next gate.

## Definition of implementation success

CHRONO is minimally implemented when it can persist project truth, deterministically authorize or deny work, provide curated Spec context to OpenCode agents, execute only approved dependency-ready work, retain test/security evidence, enforce independent verification and survive a new session without relying on conversation memory.

No MVP is complete unless the PO has made both required security decisions from recorded evidence, the Core has proven that missing/stale security state, unresolved blockers, and unauthorized risk acceptance fail closed, and OpenCode agent execution demonstrably uses RTK without bypass.
