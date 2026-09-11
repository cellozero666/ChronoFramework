# CHRONO — Implementation Plan

**Status:** Execution roadmap  
**Primary generator:** the implementation model selected by the Product Owner at execution time
**Required targets:** global `chrono` CLI plus OpenCode, Claude Code, and Kiro adapters
**Rule:** Complete and review each phase before starting the next. Do not implement the Core from the conceptual documents alone.

**Current checkpoint (2026-09-11):** Slices 1–8 are committed and their
corrective reviews are cleared. Phase 5 is not complete: RTK routing proof,
all protected CLI gates, complete OpenCode tool coverage, and equivalent
Claude Code/Kiro adapters remain. Continue with [`SLICE-9.md`](SLICE-9.md),
then [`SLICE-10.md`](SLICE-10.md), and then the remaining ordered
[`IMPLEMENTER-TASKS.md`](IMPLEMENTER-TASKS.md). Neither
the Phase 6 MVP gate nor final v1 has been claimed.

No provider, model name, or model version may be hardcoded in source, templates, adapters, tests, generated agent files, or defaults. Model selection is external configuration owned by the Product Owner. Changing the selected model MUST NOT change authority, state, gates, evidence requirements, or behavior.

## Goal

Deliver a final v1 CHRONO workflow across OpenCode, Claude Code, and Kiro while preserving the architectural boundary:

```text
Formal Protocols → Domain Model → Core Specification → Deterministic Core
                 → global CLI/local Core → Runtime Adapters → Specialized Agents → final v1
```

The Core owns state, validation, gates and execution authorization. Agents perform semantic work. The CLI and runtime adapters are interfaces to the Core, not the Core itself.

## Phase 1 — Formalize the protocols — COMPLETE

Consume and cross-review the nine normative documents indexed in [`../protocols/`](../protocols/README.md):

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

The PO-selected implementation model must consume these artifacts and submit a cross-document consistency report. It must not scaffold implementation packages until this gate is satisfied.

## Phase 2 — Derive the domain

From the approved protocols, define:

- domain entities and ownership;
- artifact identity and reference rules;
- entity-level state machines and legal transitions;
- events, approvals, blockers, defects, waivers and evidence;
- gate conditions and traceability rules;
- invariants and error taxonomy.

Encode the already approved hierarchical state model exactly: Project, Specification, Module, WorkPackage, and Verification have separate legal state sets, and Project state is a computed projection that cannot hide blocking aggregate state.

**Deliverables:** `docs/domain/DOMAIN-MODEL.md`, `docs/domain/STATE-MODEL.md`, and `docs/domain/CORE-INVARIANTS.md`.

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

Specify the approved hybrid persistence: versioned Markdown/YAML are human-readable authoritative artifacts; `.chrono/chrono.db` (SQLite) stores operational events, locks, transitions, approvals, attestations, evidence indexes, and migrations transactionally. SQLite MUST NOT replace documents as contracts.

**Deliverables:** `docs/core/CORE-SPECIFICATION.md`, `docs/core/RUNTIME-CONTRACT.md`, machine-readable schemas, and architecture ADRs.

**Gate:** acceptance tests can be written from the specification without inventing behavior.

## Phase 4 — Implement the deterministic Core and CLI

Use a TypeScript/Node.js LTS monorepo with separate packages for domain/application Core, persistence, CLI and adapters. Implement the smallest useful API first:

```text
init · status · validate · approve · authorizeExecution · recordEvidence
block · resolve · verify · complete
```

Expose it through the mandatory global `chrono` CLI. The global launcher discovers the project, reads its pinned local CHRONO version, and delegates to that local Core; missing or incompatible local Core MUST fail closed and MUST NOT be silently replaced by the global version. Add unit tests for domain rules and integration tests for persistence, invalid transitions, references, approvals and cyclic dependencies.

Before Phase 4 can pass, implement the runtime-neutral agent identity and
authority model in the Domain/Core. It MUST contain the canonical roles
`gaspar`, `belthazar`, `melchior`, `prometheus`, `lucca`, `glenn`, and `spekkio`;
separate role from human, adapter, runtime, model, session, and tool identity;
bind dispatches to authenticated sessions; and enforce a deny-by-default
role/capability matrix for transitions, decisions, blockers, evidence,
verification, and completion. A free-form actor string or prompt assertion is
never authorization. Phase 5 supplies runtime-specific agent definitions and
hooks, but MUST consume this Core policy rather than create it.

### Approved state model

```text
Project:       UNINITIALIZED | ANALYZING | ARCHITECTING | SPECIFYING | PLANNING | EXECUTING | VERIFYING | COMPLETE | BLOCKED
Specification: DRAFT | REVIEW | READY | SUPERSEDED
Module:        DRAFT | AWAITING_APPROVAL | APPROVED | EXECUTING | VERIFYING | PASSED | FAILED | COMPLETE | BLOCKED
WorkPackage:   PLANNED | AUTHORIZED | RUNNING | BLOCKED | IMPLEMENTED | VERIFYING | FAILED | COMPLETE
Verification:  PENDING | RUNNING | FAILED | PASSED | WAIVED
```

### Approval integrity

`chrono approve`, `chrono waive`, and risk acceptance are interactive human-only operations. The PO signing key MUST remain outside the project and agent-accessible context, preferably in the operating-system keychain. Each signature binds the exact action, scope, artifact identity, revision/hash, signer, and timestamp; a material revision invalidates it. The Core records the signed event append-only in SQLite and returns `APPROVAL_REQUIRED` if interactivity, identity, key access, or signature validation is absent. Runtime adapters and agents MUST be technically unable to invoke these operations as the PO.

**Gate:** direct API and CLI produce the same decisions; mandatory gates cannot be bypassed by malformed state or agent instructions.

### Slice 5 corrective gate

The initial Core/persistence/CLI implementation MUST satisfy
[`SLICE-5-REMEDIATION.md`](SLICE-5-REMEDIATION.md) before work proceeds to later
execution-gate or adapter slices. A green build or a previously reported test
count does not satisfy this gate. Fresh installation, lint, tests, adversarial
Core tests, immutable revision/audit behavior, and fail-closed authorization
must all pass from a clean checkout without manually created workspace links.

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

### Mandatory Karpathy Guidelines process skill

Every CHRONO agent must use the Karpathy Guidelines skill during the complete work process. The canonical and only accepted upstream is [https://github.com/multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills). The installer must fetch a CHRONO-pinned immutable commit, verify its expected hash, preserve its MIT license/attribution, and treat `skills/karpathy-guidelines/SKILL.md` as the single semantic source.

Do not install from a floating `main` branch in production setup. Do not follow upstream README commands that reference a different repository without an explicit reviewed CHRONO source migration. The pinned repository/revision and expected source hash must live in CHRONO release metadata.

Implement a deterministic converter that validates Agent Skills frontmatter and emits equivalent artifacts without LLM rewriting:

```text
vendor/karpathy-guidelines/<pinned-revision>/SKILL.md
        ├── Claude Code → .claude/skills/karpathy-guidelines/SKILL.md
        ├── OpenCode    → .opencode/skills/karpathy-guidelines/SKILL.md
        └── Kiro        → .kiro/skills/karpathy-guidelines/SKILL.md
```

Claude MAY additionally use the upstream plugin packaging, but its effective skill body must match the pinned canonical source. OpenCode agents must be granted access to the `karpathy-guidelines` skill. Kiro custom agents must include its `skill://` resource. For all runtimes, adapter instructions must require activation before analysis, planning, implementation, tests, security review, and verification; on-demand discovery alone is not sufficient for this mandatory policy.

The enforced precedence is:

```text
Product Owner → CHRONO protocols/Core → approved artifacts/Harness
→ agent role rules → Karpathy Guidelines
```

The converter must preserve these four behaviors: think before coding, simplicity first, surgical changes, and goal-driven verified execution. “Simplicity” must never remove approved behavior, security controls, traceability, evidence, gates, required error handling, or correction loops.

Before dispatch, the Core must require a current `SkillAttestation` containing upstream URL, pinned commit, source hash, generated artifact hashes, converter version, license/attribution status, runtime/agent identity, discovery result, permission result, activation smoke test, and timestamp. Missing, modified, untrusted, divergent, inactive, or bypassed state must set `BLOCKED_PROCESS_SKILL` and return `EXECUTION_DENIED`. Installation and global configuration changes require applicable user permission; no silent fallback is allowed.

## Phase 5 — Implement mandatory runtime integrations

Implement OpenCode, Claude Code, and Kiro adapters without duplicating Core policy. Every adapter MUST enforce both directions:

1. `chrono run` asks the Core for authorization and then dispatches the selected runtime/model.
2. Native pre-tool hooks call `chrono gate` before protected actions, so a directly opened runtime session cannot bypass CHRONO, RTK, the mandatory process skill, permissions, approvals, or security gates.

Each adapter must:

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
- configure and prove the required RTK routing for its runtime;
- install its deterministic Karpathy Guidelines artifact, require activation, and persist a passing SkillAttestation;
- register itself through `chrono setup`/`chrono init`, record its capabilities, and fail closed if dispatch or in-runtime hook enforcement is unavailable.

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
- destructive/production actions require explicit applicable authorization;
- missing, unhealthy, incompatible, stale, or bypassed RTK denies agent execution;
- adapter tests prove actual RTK command routing and record savings evidence;
- floating, redirected, modified, unlicensed, divergent, undiscoverable, unauthorized, inactive, or bypassed Karpathy Guidelines artifacts deny execution;
- generated Claude/OpenCode/Kiro skill bodies are semantically identical to the pinned canonical source;
- the skill cannot override CHRONO authority or simplify away mandatory controls.

**MVP exit:** one module reaches `COMPLETE` with full traceability and persisted evidence, and the same conformance suite passes for OpenCode, Claude Code, and Kiro.

## Phase 7 — Harden and prove adapter portability

Add recovery, atomicity, migrations, audit history, adversarial/compliance tests, RTK adoption/savings measurement, signed releases, checksums, SBOM, provenance, license/NOTICE validation, and user documentation. Publish the free Apache-2.0 framework through npm and GitHub Releases for macOS, Linux, and Windows. Package metadata MUST use `Apache-2.0`; source and binary distributions MUST include `LICENSE`, `NOTICE`, applicable third-party licenses, and attribution. The release MUST require no paid service or server dependency.

Implement and verify the mandatory v1 capabilities from the [SDD Innovation Standard](../product/SDD-INNOVATION-STANDARD.md): explainable gates, deterministic dry run, drift/scoped invalidation, portable audit export, privacy-preserving local metrics, progressive output, bounded loops, and technology-agnostic conformance. Provide a stable rigor-profile and policy-pack boundary without expanding bundled post-v1 scope.

Each adapter must pass identical lifecycle, security, RTK, restart, authorization, evidence, and correction-loop tests. Adapter-specific hooks translate runtime behavior; they never own CHRONO policy. Codex and Gemini remain later adapters.

**Final innovation gate:** Gaspar's Innovation Review, Lucca's mandatory capability tests, Glenn's security/privacy review, and Spekkio's independent `INNOVATION_PASS` MUST all reference current evidence. Polyglot, non-web, deterministic replay, drift, audit-redaction, bounded-loop, and cross-runtime tests are release blocking.

Do not build a dashboard, remote orchestrator, database server, custom LLM provider, distributed scheduler or plugin marketplace before evidence shows it is necessary.

## Execution rules for the implementation agent

- Follow the repository order of authority in [`../../AGENTS.md`](../../AGENTS.md), starting with the framework definition, normative protocols, reference architecture, and this plan. The historical protocol-authoring brief is non-normative.
- Work phase by phase and stop at each gate for review; never jump directly to TypeScript.
- After every required PO decision is recorded, continue through Phase 7; the MVP gate is not permission to stop before final v1.
- Use the model selected by the Product Owner through runtime/project configuration; treat every model output as untrusted until deterministic validation and independent review pass.
- Never infer unresolved product or security policy. Stop at the applicable PO gate, persist the decision, then continue with the selected model.
- Preserve user changes and record unresolved architectural choices rather than silently deciding outside delegated authority.
- Keep framework protocols, deterministic Core, agent definitions and runtime adapters separate.
- Prefer a thin vertical slice over broad scaffolding with placeholder behavior.
- Final v1 MUST contain no stubs, TODO-only paths, simulated integrations, skipped mandatory checks, or documentation claims unsupported by passing evidence.
- For every phase, report files changed, tests/evidence, open decisions and the next gate.

## Definition of implementation success

CHRONO reaches final v1 when the global launcher and pinned local Core install cleanly, the complete lifecycle works through OpenCode, Claude Code, and Kiro, all conformance/security/innovation/upgrade/recovery/license tests pass, signed cross-platform packages include the required Apache-2.0 and third-party notices, and fresh polyglot/non-web fixtures complete without relying on conversation memory. The PO-selected model generates the implementation but owns no policy decision.

No MVP is complete unless the PO has made both required security decisions from recorded evidence, the Core has proven that missing/stale security state, unresolved blockers, and unauthorized risk acceptance fail closed, OpenCode/Claude Code/Kiro agent execution demonstrably uses RTK without bypass, and every CHRONO agent demonstrably activates the pinned Karpathy Guidelines skill. MVP completion is only the gate into hardening; final v1 requires every Phase 7 exit condition above.
