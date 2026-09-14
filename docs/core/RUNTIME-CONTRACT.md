# CHRONO Framework — Runtime Contract

**Status:** Normative — Phase 3 deliverable
**Source authority:** `docs/reference/FRAMEWORK-DEFINITION.md`, `docs/protocols/01-SYSTEM-ANALYSIS-PROTOCOL.md`, `docs/protocols/02-AUTHORITY-DECISION-PROTOCOL.md`, `docs/protocols/08-ROADMAP-EXECUTION-PROTOCOL.md`, `docs/architecture/REFERENCE-ARCHITECTURE.md`, `docs/core/CORE-SPECIFICATION.md`
**Scope:** This document defines the contract between the deterministic Core and all runtime adapters (Claude Code, OpenCode, Kiro, and future runtimes). It specifies the command protocol, event schema, dispatch authorization flow, in-runtime hook interface, and conformance requirements. It contains no runtime-specific defaults or hardcodes.

---

## 1. Introduction

The Runtime Contract is the boundary across which all agent-driven CLI execution MUST pass. The Core is the authority; adapters are executors that MUST obey `AUTHORIZED`/`DENIED` and MUST NOT duplicate, reinterpret, or weaken Core policy.

Citation format: `[FW §X]` = Framework Definition, `[P1 §X]` = Protocol 1, `[REF §X]` = Reference Architecture, `[PL Phase X]` = Implementation Plan, `[CORE §X]` = CORE-SPECIFICATION.md §X.

---

## 2. Actor Identity

Every interaction with the Core identifies the actor:

| Actor | Identity string | Role |
|---|---|---|
| Product Owner | `PO` | Highest authority |
| Gaspar | `gaspar` | Autonomous agent |
| Belthazar | `belthazar` | Implementation agent |
| Melchior | `melchior` | UX agent |
| Prometheus | `prometheus` | Infra agent |
| Lucca | `lucca` | Testing agent |
| Glenn | `glenn` | Security agent |
| Spekkio | `spekkio` | Quality verifier |
| Adapter | `<runtime>:<session_id>` | e.g., `claude-code:abc-123` |

Identity is verified by the Core via the CLI environment, not by the agent prompt. No agent MAY claim to be the PO.

The identity strings in this table are the canonical, case-sensitive machine
identifiers. Human-facing output uses the display names in the first column.
`luca` is not an alias for `lucca` and MUST be rejected. A generic `agent`
identity is not a CHRONO role and MUST NOT satisfy a role or authority check.
Adapter/session identity is distinct from agent role: an authenticated runtime
session may act only under the single role assigned by an authorized dispatch.

Reference: `[FW §194-255]`, `[DOM §2.2]`.

---

## 3. Command Protocol

### 3.1 Core CLI commands

| Command | Actor | Effect |
|---|---|---|
| `chrono init` | PO | Initialize project + system analysis |
| `chrono gate` | Adapter | Evaluate a gate; returns `AUTHORIZED` or error |
| `chrono approve` | PO | Record interactive signed approval |
| `chrono waive` | PO | Record interactive signed waiver |
| `chrono run` | Adapter | Authorized dispatch through a registered adapter (authorize → enact → spawn → evidence → advance) |
| `chrono setup` | Adapter | Verify an adapter end to end, install project-local hook assets (fail-closed) |
| `chrono adapter` | PO | Register/list/activate/revoke runtime adapters (approval-gated) |
| `chrono rtk status` | Any | Check RTK attestation |
| `chrono rtk verify` | Any | Re-verify and re-record RTK attestation |
| `chrono skill status` | Any | Check skill attestation |
| `chrono skill verify` | Any | Re-verify and re-record skill attestation |
| `chrono artifact propose` | Gaspar/PO session | Propose and materialize a planning draft (DRAFT, untrusted) |
| `chrono artifact revise` | Gaspar/PO session | Revise a planning draft (stales prior approvals) |
| `chrono artifact status` | Gaspar/PO session | Safe planning status projection (no secrets) |

### 3.2 `chrono gate` interface

```
chrono gate <gate_name> [options]

Gate names:
  architecture-approval
  spec-ready --spec <spec_id>
  execution --module <mod_id> --wp <wp_id> --spec-revision <hash>
  verification --module <mod_id>
  completion --module <mod_id>

Output: JSON to stdout
  { "result": "AUTHORIZED" | "DENIED", "code": "<error_code>", "reason": "<details>" }
Exit code: 0 if AUTHORIZED, 1 if DENIED, 2 if error
```

Reference: `[CORE §16]`, `[FW §1055-1077]`.

---

## 4. Dispatch Authorization Flow

### 4.1 Pre-dispatch (chronocode/CLI layer)

```
FUNCTION dispatch_approved_command(adapter, command, args):
    # 1. Check RTK
    rtk_result = chrono gate rtk  # internal check
    IF rtk_result != AUTHORIZED:
        PRINT rtk_result.reason
        RAISE BLOCKED_RTK

    # 2. Check skill
    skill_result = chrono gate skill  # internal check
    IF skill_result != AUTHORIZED:
        PRINT skill_result.reason
        RAISE BLOCKED_PROCESS_SKILL

    # 3. Check execution authorization
    exec_result = chrono gate execution \
        --module <module_id> \
        --wp <wp_id> \
        --spec-revision <current_revision>
    IF exec_result != AUTHORIZED:
        PRINT exec_result.reason
        RAISE EXECUTION_DENIED

    # 4. Dispatch through RTK
    result = rtk exec adapter command args
    RETURN result
```

Reference: `[FW §1077]`, `[P8.5]`, `[REF §1214]`, `[INV §5.3]`.

### 4.2 Post-dispatch evidence recording

After command execution:
```
FUNCTION record_post_execution_evidence(adapter, command, result, diagnostics):
    chrono evidence record \
        --producer <adapter> \
        --target-revision <revision> \
        --check <command> \
        --result <pass|fail|value> \
        --diagnostics "<json>"
```

---

## 5. In-Runtime Hook Protocol

### 5.1 Bidirectional enforcement

The Core requires BOTH of these enforcement paths:
1. **Pre-dispatch**: `chrono gate execution` before the adapter dispatches a tool.
2. **Native pre-tool hooks**: The runtime adapter installs hooks that call `chrono gate` before each protected action, so a directly-started runtime session cannot bypass CHRONO.

If either path cannot be enforced for a given runtime, agent execution for that runtime MUST be denied. `[FW §1077]`, `[REF §1214]`, `[INV §5.3.1]`.

### 5.2 Hook interface

Each supported runtime adapter MUST implement:

```
hook_before_tool(tool_name, tool_args):
    # Call Core for authorization
    authorized = chrono_gate_pre_tool(tool_name, tool_args)
    IF authorized != AUTHORIZED:
        BLOCK_TOOL_EXECUTION(reason=authorized.reason)
    RETURN authorized

hook_before_command(command, args):
    # Same pattern for shell commands / agent invocations
    authorized = chrono_gate_pre_command(command, args)
    IF authorized != AUTHORIZED:
        BLOCK_COMMAND(reason=authorized.reason)
    RETURN authorized
```

### 5.3 Hook registration verification

At startup, the adapter MUST prove hooks are registered:
```
FUNCTION verify_hooks_registered():
    # Probe the runtime's hook system
    probe_result = runtime_probe_hook_system()
    IF probe_result != hooks_active:
        RAISE EXECUTION_DENIED(reason="Hooks not enforced")
    RETURN TRUE
```

This is proven by effective routing evidence (`chrono rtk prove` + `chrono rtk promote`, `[CORE §10.3]`), not by configuration-file presence.

---

## 6. Adapter Conformance Requirements

### 6.1 Authorization obedience

Adapters MUST:
- Obtain Core authorization before dispatch.
- Call `chrono gate` from within in-runtime hooks before protected actions.
- Obey `AUTHORIZED`/`DENIED` — never duplicate, reinterpret, or weaken policy `[FW §51, P8.5]`.
- Report every tool/command execution as evidence.

Adapters MUST NOT:
- Bypass Core gates via direct tool invocation.
- Override `DENIED` results.
- Hardcode a provider, model name, or model version `[INV §11.2, FW §22]`.

### 6.2 No silent fallback

If RTK is absent, incompatible, or bypassed, the adapter MUST stop and provide actionable instructions. It MUST NOT fall back to raw/unfiltered command output `[REF §1192]`, `[INV §8.3]`.

### 6.3 RTK routing requirement

Every command that the agent dispatches MUST be covered by a current
AUTHORITATIVE routing proof for the (adapter, runtime, project) scope
`[CORE §10.2, INV §8.7, ADR-006]`:

```
chrono rtk prove --adapter <id> -- <raw command>   # records a CANDIDATE (authorizes nothing)
chrono rtk promote --proof <id>                    # PO-only, after signed adapter approval
```

`prove` maps the raw pre-routing command through `rtk rewrite` (the
documented source of truth for hook interception), executes the mapped
command only through the genuine attested binary, and binds the
pre-routing input, routed command, output hash, and TTL as evidence.
Identity-only commands (`rtk gain`, `rtk --version`) prove binary and
dashboard identity for attestation — never routing. `promote`
re-validates attestation, binary, approval, and managed-asset bindings
and snapshots the registration and asset hashes; dispatch re-validates
all of them per use, so drift invalidates without further ceremony.

Configuration-file presence (`rtk.yaml`) is NOT proof of routing `[P8.7]`.

### 6.4 Planning-vs-implementation tool distinction (OC-P11 correction)

Adapters MUST distinguish four tool classes inside CHRONO projects:

- **Governed planning mutation** — the NATIVE tools
  (`chrono_artifact_status/propose/revise/supersede`,
  `chrono_approval_request/status` in
  `.opencode/tools/chrono.ts`; there is deliberately NO
  approval-confirm tool): real model-callable tools with stable
  schemas, host-held sessions, stdin bodies, and Core validation of
  every call. Human confirmation travels only through the native
  `question` tool, which the Gaspar agent policy MUST explicitly
  allow (`question: allow` — OpenCode denies tools by default), and
  the ticket request refuses (`--require-question`, always passed
  by the native tool) unless that surface is available. Planning-
  governed, not generic shell mutation and not implementation
  dispatch; the pre-tool gate requires proven entry, nothing more.
  Bash compatibility (`chrono artifact ...`,
  `chrono approval-request/ticket`, read-only
  `chrono doctor/status/validate`) uses the real two-argument
  `(input, output)` contract but is NOT a substitute for native tools.
  Chained, piped, or substituted commands stay on the dispatch path.
- **Implementation mutation** — generic write/edit/bash and every other
  mutable tool: requires Module dispatch context and a live execution
  gate verdict, as before.
- **Read-only operations** — pass without dispatch scope, except reads
  referencing internal/security state.
- **Forbidden internal/security-state access** — reads of
  `.chrono/chrono.db`, broker account files, token files, and internal
  hooks deny with a safe-projection pointer (`chrono doctor`,
  `chrono artifact status`). Gaspar MUST use Core projections instead.

---

## 7. Event and Communication Protocol

### 7.1 Structured events

Critical events MUST be persisted as structured records, not conversational output:

| Event type | Source | Persistence |
|---|---|---|
| `APPROVAL` | PO (`chrono approve`) | SQLite `approval` table + event_log |
| `WAIVER` | PO (`chrono waive`) | SQLite `waiver` table + event_log |
| `HANDOFF` | Gaspar | Document in `docs/` |
| `BLOCKED` | Agent/Core | SQLite `blocker` table + event_log |
| `RESOLVED` | Responsible authority | SQLite `blocker` table (resolved) |
| `DEFECT` | Spekkio | SQLite `defect` table + event_log |
| `SECURITY_BLOCKER` | Glenn | SQLite `security_blocker` table |
| `ESCALATION` | Agent | Document in `docs/` |
| `QA_REPORT` | Spekkio | SQLite `qa_report` table |
| `CHANGE_REQUEST` | Agent | SQLite `change_request` table |

Reference: `[FW §410-421]`, `[INV §13.1]`, `[DOM §5.1]`.

### 7.2 Communication rules

- Decisions MUST be persisted as artifacts — not conversation or model memory `[INV §13.2]`.
- No agent MAY clear a blocker, approve work, waive a blocker, or accept risk via conversation `[INV §15.4]`.
- All authority conflicts MUST be escalated to the Product Owner `[FW §340-351]`, `[INV §15.1]`.

---

## 8. Runtime Configuration

### 8.1 PO-owned external config (`chrono.yaml`)

The PO configures (externally — outside code):

```yaml
project:
  language: en
  gasparAutonomy: SEMI_AUTONOMOUS

runtime:
  type: <PO-selected identifier>      # no default
  dispatchProven: true
  gateHookProven: true

rtk:
  binaryPath: <path>                  # resolved from PATH or explicit
  ttl: 1h
  provenance: https://github.com/rtk-ai/rtk

skill:
  upstream: https://github.com/multica-ai/andrej-karpathy-skills
  pinnedCommit: <sha>
  ttl: 24h
  license: MIT
```

The Core MUST NOT infer, default, or hardcode any runtime, provider, model, or upstream. If `runtime.type` is absent, the Core returns `CONFIG_ERROR`. `[FW §22]`, `[INV §4.2]` `[1.4.3]`.

### 8.2 Model selection

Model selection is external PO-owned configuration per `[FW §22]`. The Core stores whether a model is configured but NEVER its name. The domain model stores only `"PO-selected, model name omitted from policy"` `[DOM §4.4]`.

---

## 9. Cross-Runtime and Polyglot Requirements

### 9.1 Polyglot evidence

The Core MUST accept evidence from any runtime. Evidence format:
```json
{
  "producer": "<adapter_identity>",
  "tool": "<tool_name>",
  "timestamp": "ISO-8601 UTC",
  "target_revision": "sha256:...",
  "check_name": "test:unit",
  "result": "pass",
  "diagnostics": "...",
  "integrity_hash": "sha256:...",
  "runtime": "<runtime_identifier>"
}
```

The `runtime` field records which runtime produced the evidence, but the Core does NOT branch on it for policy decisions. `[FW §22]`, `[INV §11.1]`.

### 9.2 Non-web evidence

Evidence from non-web toolchains (Rust, Python, C, compiled tests, shell, etc.) MUST be accepted with the same binding rules. `[PL Phase 2]`, `[INV §11.1]`.

### 9.3 Cross-runtime equivalence

RTKAttestation and SkillAttestation apply identically across all supported runtimes. There is no per-runtime bypass. `[P6.5]`, `[P6.6]`, `[INV §8]`, `[INV §9]`.

---

## 10. Security Boundary

### 10.1 Signer key isolation

The PO signing key MUST be stored outside the project directory (OS keychain recommended). The Core MUST NOT read signing keys from the project tree or environment. `[FW §1196]`, `[P2.10]`, `[INV §4.2]`.

### 10.2 Terminal interaction requirement

PO approval/waiver commands MUST verify interactive terminal session:
```
FUNCTION terminal_interactive_session():
    IF stdin IS_TERMINAL AND stdout IS_TERMINAL:
        RETURN TRUE
    RAISE APPROVAL_REQUIRED(reason="Not interactive terminal")
```

No API, script, or automated call MAY bypass this. `[P2.10]`, `[FW §1196]`.

### 10.3 Secret handling

Secrets MUST NOT be passed through:
- Model prompts
- Adapter configuration files
- Environment variables injected into model context
- Persisted evidence or audit records

The Core MUST scan evidence for secret patterns and raise `SECRET_DETECTED` if found `[INV §7.9]` `[P4.14, P8.8]`.

---

## 11. Conformance Verification

Each runtime adapter MUST demonstrate:

1. **Dispatch authorization**: `chrono gate execution` is called before dispatch and is enforced. `[FW §1077]`.
2. **In-runtime hook**: Native pre-tool hooks call `chrono gate` before protected actions, proven by effective routing evidence (`[CORE §10.3]`). `[REF §1214]`.
3. **RTK routing**: Every dispatched command is covered by a current AUTHORITATIVE routing proof (recorded with `chrono rtk prove`, promoted with `chrono rtk promote` after signed adapter approval). `rtk gain` proves binary/dashboard identity for attestation only — never routing. `[CORE §10, INV §8, ADR-006]`.
4. **Skill activation**: Karpathy Guidelines skill is active (not just discoverable) in the runtime. `[P6.6]`.
5. **No hardcoded model**: No provider/model/version string in adapter source or defaults. `[INV §11.2]`.

If any conformance point cannot be proven, the runtime adapter is non-conformant and the Core MUST deny dispatch for that runtime. `[INV §15.1]`.

---

## 12. Error Reporting

All gate and dispatch errors MUST use the taxonomy from `[CORE §14]` / `[INV §14]`:
- Structured JSON error to stderr.
- Exit code 1 for DENIED, 2 for system error.
- Event logged to SQLite for audit.

Error codes: `AUTH`, `INVALID_STATE`, `SECURITY_BLOCKER`, `APPROVAL_REQUIRED`, `BLOCKED_RTK`, `BLOCKED_PROCESS_SKILL`, `EXECUTION_DENIED`, `COMPLETION_DENIED`, `STALE_REVISION`, `DAG_CYCLE`, `SECRET_DETECTED`, `CONFIG_ERROR`, etc.

No conversational-only error is acceptable for authority-relevant failures.

---

## 13. Adapter Registration Interface

Each adapter registers with the Core via a registration file in `.chrono/adapters/`:

```yaml
id: <runtime_identifier>
name: <human-readable name>
entrypoint: <adapter_executable_path>
gate_hook: <hook_spec>
dispatch_proof: <routing_test_command>
rtk_routing: <rtk_routing_spec>
skill_activation: <activation_test_command>
conformance_proof: <list of proof commands>
```

The Core verifies each registration before allowing dispatch. New adapters require PO approval `[FW §5, DOM §4.1]`.

Lifecycle: intake (`chrono adapter register --file`) creates a `pending`
row; a signed `adapter-registration` PO approval binding the exact
registration hash activates it (`chrono adapter activate`); revocation is
terminal. Only `active` adapters dispatch, and dispatch grants bound to a
revoked adapter burn fail-closed.

---

## 14. Summary: What the Core Enforces vs. What Adapters Execute

| Core enforces (deterministic) | Adapter executes (non-deterministic) |
|---|---|
| State transitions (legal only) | Implementation code from Specs |
| Gate conditions (fail-closed) | Tool calls and commands |
| Approval/waiver authenticity (signed, interactive) | Agent reasoning and planning |
| Reference integrity (resolvable, current revisions) | Code editing, testing, refactoring |
| Evidence binding (to revision) | Model selection (PO-configured, NOT by adapter) |
| RTK/Skill attestation freshness | Output generation |
| No hidden child states in Project projection | UI rendering, file formatting |
| No hardcoded provider/model/version | Session management |

The adapter MUST NEVER cross the Core-enforced boundary. `[FW §648]`, `[INV §15.3]`.
