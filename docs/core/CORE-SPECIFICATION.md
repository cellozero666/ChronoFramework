# CHRONO Framework — Core Specification

**Status:** Normative — Phase 3 deliverable
**Source authority:** `docs/protocols/03-ARTIFACT-MODEL.md`, `docs/protocols/07-CONSISTENCY-VALIDATION-PROTOCOL.md`, `docs/protocols/08-ROADMAP-EXECUTION-PROTOCOL.md`, `docs/protocols/09-VERIFICATION-CORRECTION-PROTOCOL.md`, `docs/domain/DOMAIN-MODEL.md`, `docs/domain/STATE-MODEL.md`, `docs/domain/CORE-INVARIANTS.md`
**Scope:** This document specifies the deterministic behavior of the CHRONO Core: identity syntax, revision-hash algorithm, state-machine validation, gate algorithms, SQLite schema, event store, approval/waiver security model, evidence lifecycle, and conformance requirements. It contains no provider- or model-specific default.

---

## 1. Introduction

The Core is the deterministic, stateful authority for CHRONO governance, lifecycle, and gate enforcement. It does NOT select runtimes, providers, models, or adapters. It does NOT execute implementation work. It validates, projects state, enforces gates, records events append-only, and authenticates human authority events.

Citation format: `[FW §X]` = Framework Definition, `[P1 §X]` = Protocol 1, `[REF §X]` = Reference Architecture, `[PL Phase X]` = Implementation Plan, `[DOM §X]` = DOMAIN-MODEL.md §X, `[STATE §X]` = STATE-MODEL.md §X, `[INV §X]` = CORE-INVARIANTS.md §X.

---

## 2. Project Repository Layout

```text
<project>/
├── .chrono/
│   ├── chrono.db              # SQLite: events, operational state, approvals, attestations
│   └── schema.sql             # SQLite schema (managed, idempotent)
├── docs/
│   ├── product/...            # Human-reviewed contracts
│   ├── protocols/...          # Normative protocols
│   ├── architecture/...
│   ├── domain/...             # Phase 2 deliverables
│   └── core/...               # Phase 3 deliverables
├── src/...                    # Implementation (versioned by Git, not part of Core)
├── skills/...                 # Karpathy Guidelines skill tree [P6.6]
├── rtk.yaml                   # RTK configuration (NOT proof of operation) [P8.7]
└── chrono.yaml                # PO-owned external config (runtime, TTLs, keys)
```

The Core owns `.chrono/chrono.db` and `.chrono/schema.sql`. Documents in `docs/` are the authoritative human-readable contracts.

---

## 3. Identity Syntax

### 3.1 Identifier families

Identifiers use the families defined in `[DOM §2.1]` with concrete syntax:

```text
REQ-<seq>        e.g., REQ-001
BR-<seq>         e.g., BR-003
CON-<seq>        e.g., CON-001
DEC-<seq>        e.g., DEC-002
ADR-<seq>        e.g., ADR-001
SP-<seq>         e.g., SP-001
AC-<seq>         e.g., AC-001
MOD-<seq>        e.g., MOD-001
WP-<seq>         e.g., WP-001
TASK-<seq>       e.g., TASK-001
APR-<seq>        e.g., APR-001
BLK-<seq>        e.g., BLK-001
DEF-<seq>        e.g., DEF-001
EVD-<seq>        e.g., EVD-001
QA-<seq>         e.g., QA-001
SEC-<seq>        e.g., SEC-001
WAIVER-<seq>     e.g., WAIVER-001
CR-<seq>         e.g., CR-001
OPEN-<seq>       e.g., OPEN-001
RTK-<seq>        e.g., RTK-001
SKILL-<seq>      e.g., SKILL-001
RTE-<seq>        e.g., RTE-001 (operational: routing-proof evidence rows)
SES-<seq>        e.g., SES-001 (operational: authenticated adapter sessions)
BRK-<seq>        e.g., BRK-001 (operational: broker credentials for Gaspar entry)
GRANT-<seq>      e.g., GRANT-001 (operational: dispatch grants)
```

`<seq>` is a zero-padded 4-digit decimal sequence, assigned by the Core on creation.

### 3.2 Composite identity

When revision binding is required, the model uses `<ID>@<revision>` — e.g., `SP-001@abc123…`. The Core resolves this to the exact artifact revision.

---

## 4. Revision Hash Algorithm

### 4.1 Canonical serialization

The authoritative artifact (Markdown front-matter + body, or YAML structure) is canonicalized as follows:

1. Parse the artifact into a structured representation (front-matter key-value map + canonical body).
2. Serialize to a canonical JSON document with keys sorted lexicographically and UTF-8 encoded.
3. Compute `sha256` over the canonical JSON bytes.

### 4.2 Content hash format

```text
revision = "sha256:" + hex(sha256(canonical_json))
```

Example: `sha256:a1b2c3d4e5f6…` (64 hex characters after `sha256:`).

### 4.3 Hash binding rules

- Approvals, evidence, waiver, and attestation events bind to an exact revision hash `[DOM §2.3]`.
- A material change to artifact content produces a different revision hash.
- The Core MUST detect stale revision references and deny execution/verification `[P7.3, DOM §2.3]`.

---

## 5. SQLite Schema

### 5.1 Schema overview

All operational state is stored in `.chrono/chrono.db`. The schema is defined in `.chrono/schema.sql` and managed idempotently by the Core.

#### Table: `project`

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PRIMARY KEY |
| `language` | TEXT | NOT NULL, default `en` |
| `gaspar_autonomy` | TEXT | NOT NULL, CHECK value in {SUPERVISED, SEMI_AUTONOMOUS, AUTONOMOUS} |
| `runtime` | TEXT | NOT NULL (PO-configured; no default) |
| `created_at` | TEXT | ISO-8601 UTC |
| `updated_at` | TEXT | ISO-8601 UTC |
| `state` | TEXT | Project state (projected) |

#### Table: `artifact`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `type` | TEXT | NOT NULL (REQ, BR, CON, DEC, ADR, SP, AC, MOD, WP, TASK, BLK, DEF, EVD, QA, SEC, WAIVER, CR, OPEN, RTK, SKILL) |
| `revision` | TEXT | NOT NULL |
| `status` | TEXT | Entity-specific state |
| `created_at` | TEXT | ISO-8601 UTC |
| `updated_at` | TEXT | ISO-8601 UTC |
| `deleted` | BOOLEAN | default FALSE |

#### Table: `artifact_ref`

| Column | Type | Constraints |
|---|---|---|
| `source_id` | TEXT | REFERENCES artifact(id) |
| `target_id` | TEXT | REFERENCES artifact(id) |
| `target_revision` | TEXT | NOT NULL |

#### Table: `spec_harness`

| Column | Type | Constraints |
|---|---|---|
| `spec_revision` | TEXT | PRIMARY KEY REFERENCES artifact(revision) |
| `content_hash` | TEXT | computed hash of harness content |
| `generated_at` | TEXT | ISO-8601 UTC |
| `stale` | BOOLEAN | default FALSE |

#### Table: `event_log`

| Column | Type | Constraints |
|---|---|---|
| `seq` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `event_type` | TEXT | NOT NULL |
| `entity_id` | TEXT | NOT NULL |
| `payload` | JSONB | NOT NULL |
| `actor` | TEXT | NOT NULL |
| `timestamp` | TEXT | ISO-8601 UTC |
| `prior_state` | TEXT | nullable |
| `new_state` | TEXT | nullable |
| `reasoning` | TEXT | nullable |

#### Table: `approval`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `action` | TEXT | NOT NULL (module-approval, waiver, risk-acceptance, architecture-security, implementation-security) |
| `scope_artifact_id` | TEXT | NOT NULL |
| `scope_revision` | TEXT | NOT NULL |
| `authority` | TEXT | NOT NULL |
| `signer` | TEXT | NOT NULL |
| `signature` | TEXT | NOT NULL |
| `rationale` | TEXT | NOT NULL |
| `timestamp` | TEXT | ISO-8601 UTC |

#### Table: `waiver`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `issue` | TEXT | NOT NULL |
| `scope_artifact_id` | TEXT | NOT NULL |
| `scope_revision` | TEXT | NOT NULL |
| `rationale` | TEXT | NOT NULL |
| `evidence_ref` | TEXT | nullable |
| `accepting_authority` | TEXT | NOT NULL |
| `compensating_controls` | TEXT | nullable |
| `follow_up_task_id` | TEXT | nullable |
| `expiry_review_condition` | TEXT | NOT NULL |
| `timestamp` | TEXT | ISO-8601 UTC |
| `status` | TEXT | CHECK in {active, expired, invalidated} |

#### Table: `blocker`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `type` | TEXT | NOT NULL |
| `issuer` | TEXT | NOT NULL |
| `target_ids` | TEXT[] | NOT NULL |
| `reason` | TEXT | NOT NULL |
| `evidence_refs` | TEXT[] | default [] |
| `created_at` | TEXT | ISO-8601 UTC |
| `resolved_at` | TEXT | nullable |
| `resolved_by` | TEXT | nullable |
| `resolved` | BOOLEAN | default FALSE |

#### Table: `defect`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `classification` | TEXT | NOT NULL |
| `severity` | TEXT | NOT NULL |
| `evidence_refs` | TEXT[] | default [] |
| `affected_criteria` | TEXT[] | default [] |
| `affected_artifacts` | TEXT[] | default [] |
| `owner` | TEXT | NOT NULL |
| `blocking_scope` | TEXT | nullable |
| `repro_info` | TEXT | nullable |
| `created_at` | TEXT | ISO-8601 UTC |
| `resolved_at` | TEXT | nullable |
| `status` | TEXT | CHECK in {open, in_progress, resolved, reopened} |

#### Table: `evidence`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `producer` | TEXT | NOT NULL |
| `tool` | TEXT | nullable |
| `timestamp` | TEXT | ISO-8601 UTC |
| `target_revision` | TEXT | NOT NULL |
| `check_name` | TEXT | NOT NULL |
| `result` | TEXT | CHECK in {pass, fail, value} |
| `diagnostics` | TEXT | nullable |
| `integrity_hash` | TEXT | NOT NULL |

#### Table: `qa_report`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `module_id` | TEXT | nullable |
| `work_package_id` | TEXT | nullable |
| `verdict` | TEXT | CHECK in {PASS, FAILED, WAIVED} |
| `reviewed_evidence` | TEXT[] | default [] |
| `defect_ids` | TEXT[] | default [] |
| `waiver_ids` | TEXT[] | default [] |
| `reviewer` | TEXT | NOT NULL |
| `timestamp` | TEXT | ISO-8601 UTC |

#### Table: `security_profile`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `version` | INTEGER | NOT NULL |
| `content_hash` | TEXT | NOT NULL (hash of canonical security profile content) |
| `approved_at` | TEXT | nullable |

#### Table: `security_blocker`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `scope_artifact_id` | TEXT | NOT NULL |
| `scope_revision` | TEXT | NOT NULL |
| `description` | TEXT | NOT NULL |
| `issued_by` | TEXT | NOT NULL (Glenn identity) |
| `created_at` | TEXT | ISO-8601 UTC |
| `resolved_at` | TEXT | nullable |
| `resolved` | BOOLEAN | default FALSE |

#### Table: `rtk_attestation`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `binary_path` | TEXT | NOT NULL |
| `binary_identity` | TEXT | NOT NULL |
| `version` | TEXT | NOT NULL |
| `provenance` | TEXT | NOT NULL |
| `integration_mode` | TEXT | nullable |
| `routing_test_passed` | BOOLEAN | NOT NULL |
| `routing_test_log` | TEXT | nullable |
| `gained` | BOOLEAN | NOT NULL |
| `bypass_events` | TEXT[] | default [] |
| `savings_evidence` | JSONB | nullable |
| `valid_until` | TEXT | ISO-8601 UTC (TTL) |
| `status` | TEXT | CHECK in {current, stale, invalid} |

#### Table: `skill_attestation`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `upstream` | TEXT | NOT NULL |
| `pinned_commit` | TEXT | NOT NULL |
| `source_hash` | TEXT | NOT NULL |
| `generated_hashes` | JSONB | NOT NULL |
| `converter_version` | TEXT | NOT NULL |
| `license_status` | TEXT | NOT NULL |
| `runtime_identity` | TEXT | nullable |
| `agent_identity` | TEXT | nullable |
| `discovery_result` | TEXT | NOT NULL |
| `permission_result` | TEXT | NOT NULL |
| `activation_smoke_test_passed` | BOOLEAN | NOT NULL |
| `valid_until` | TEXT | ISO-8601 UTC (TTL) |
| `status` | TEXT | CHECK in {current, stale, invalid} |
| `bypass_events` | TEXT[] | default [] |

#### Table: `change_request`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `subject` | TEXT | NOT NULL |
| `proposed_change` | TEXT | NOT NULL |
| `impact_analysis` | JSONB | NOT NULL |
| `authority` | TEXT | NOT NULL |
| `status` | TEXT | CHECK in {proposed, approved, rejected, implemented} |
| `supersedes` | TEXT[] | default [] |
| `affected` | TEXT[] | default [] |
| `rationale` | TEXT | NOT NULL |
| `provenance` | TEXT | NOT NULL |
| `timestamp` | TEXT | ISO-8601 UTC |

---

## 6. State Machine Validation

### 6.1 Transition validation algorithm

For every state change request:

```
FUNCTION validate_transition(entity_id, from_state, to_state, event_type, guard_context):
    IF to_state NOT IN legal_state_set(entity.type):
        RAISE INVALID_STATE
    IF (from_state, to_state, event_type) NOT IN legal_transitions(entity.type):
        RAISE ILLEGAL_TRANSITION
    FOR each gate_condition in gates[event_type]:
        IF NOT gate_condition(guard_context):
            RAISE <appropriate_blocker>  # fail-closed
    RETURN TRUE
```

Reference: `[STATE §6]` Enforcement rules, `[INV §3]`.

### 6.2 Project state projection algorithm

```
FUNCTION project_project_state():
    # Step 1: BLOCKED check
    IF EXISTS active blocker with target IN (project ∪ all children):
        IF blocker prevents current gate:
            RETURN BLOCKED

    # Step 2: EXECUTING
    IF ANY module IN (APPROVED, EXECUTING) OR ANY wp IN (RUNNING):
        RETURN EXECUTING

    # Step 3: VERIFYING
    IF ANY module IN (VERIFYING, PASSED, FAILED) OR ANY wp IN (VERIFYING, FAILED):
        RETURN VERIFYING

    # Step 4: PLANNING
    IF ANY module IN (AWAITING_APPROVAL) OR (ANY module IN DRAFT AND ANY spec READY):
        RETURN PLANNING

    # Step 5: SPECIFYING
    IF ANY spec IN (DRAFT, REVIEW) OR harness/validation in progress:
        RETURN SPECIFYING

    # Step 6: ARCHITECTING
    IF system_analysis_complete AND architecture IN (proposed, under_review) AND no spec exists:
        RETURN ARCHITECTING

    # Step 7: ANALYZING
    IF system_analysis in_progress:
        RETURN ANALYZING

    # Step 8: COMPLETE
    IF ALL modules COMPLETE AND no active blocker:
        RETURN COMPLETE

    # Step 9
    RETURN UNINITIALIZED
```

Reference: `[STATE §3]`, `[INV §3.3]`.

---

## 7. Gate Algorithms

### 7.1 System Analysis completion gate `[P1.7-8]`

```
FUNCTION gate_system_analysis():
    ASSERT project.purpose IS persisted
    ASSERT primary_actors ARE persisted
    ASSERT critical_workflows ARE persisted
    ASSERT business_rules ARE persisted
    ASSERT constraints ARE persisted
    ASSERT integrations ARE persisted OR none_required
    ASSERT existing_PO_decisions ARE recorded
    IF repository_exists:
        ASSERT repository_inspected IS TRUE
    ASSERT open_questions ARE classified_and_routed
    ASSERT security_profile IS current_enough_for_architecture
    IF EXISTS blocker type=PRODUCT_BLOCKER targeting project:
        RAISE PRODUCT_BLOCKER
    ASSERT evidence_record_exists(command="chrono init --system-analysis")
    RETURN AUTHORIZED
```

### 7.2 Architecture approval gate `[P4.8]`

```
FUNCTION gate_architecture_approval():
    ASSERT all applicable decisions resolved (no proposed DEC blocking)
    ASSERT all ADRs resolved (no conflicting accepted ADRs)
    ASSERT security_profile IS current
    ASSERT threat_model_performed IS TRUE
    ASSERT architecture_security_approval EXISTS AND current
    ASSERT references_resolve_without_stale_conflicts
    ASSERT semantic_review_passed IS TRUE
    ASSERT no_active SECURITY_BLOCKER targeting architecture
    ASSERT evidence_record_exists(command="chrono architecture approve")
    RETURN AUTHORIZED
```

### 7.3 Specification READY gate `[P5.6]`

```
FUNCTION gate_spec_ready(spec_id):
    ASSERT spec.scope IS clear
    ASSERT spec.acceptance_criteria ARE traceable
    ASSERT applicable_architecture IS approved
    ASSERT applicable_ADRs ARE accepted OR none_required
    ASSERT security_profile IS current
    ASSERT architecture_security_approval EXISTS AND current
    ASSERT security ACCEPTance criteria ARE traceable (when security=true)
    ASSERT spec.contracts ARE sufficient
    ASSERT spec.data_impact IS declared
    ASSERT spec.errors_and_edge_cases ARE documented
    ASSERT spec.dependencies ARE resolvable
    IF execution_requested:
        ASSERT planning_artifacts_exist
        ASSERT module_approval EXISTS AND binds_to(spec_revision)
    ASSERT harness EXISTS AND validates
    ASSERT deterministic_validation_passes
    ASSERT semantic_validation_passes
    ASSERT no_active blocker targeting spec
    RETURN AUTHORIZED
```

### 7.4 Execution authorization gate `[P8.5]`

```
FUNCTION gate_execution(module_id, wp_id, spec_revision):
    ASSERT module EXISTS AND state IN (APPROVED, EXECUTING)
    ASSERT work_package EXISTS AND state IN (AUTHORIZED, RUNNING)
    ASSERT spec IS ready AND revision = spec_revision
    ASSERT harness IS current (not stale)
    ASSERT architecture_security_approval IS current
    ASSERT implementation_security_acceptance EXISTS AND current (when relevant)
    ASSERT module_approval EXISTS AND binds_to(module_revision, artifact_revisions)
    ASSERT dependencies_satisfied
    ASSERT runtime_capabilities_valid
    ASSERT least_privilege_permissions_verified
    ASSERT rtk_attestation EXISTS AND status == current
    ASSERT authoritative routing proof EXISTS for the (adapter, runtime, project) scope AND all bindings re-validate [§10.2]
    ASSERT skill_attestation EXISTS AND status == current
    ASSERT no_active blocker targeting module OR work_package
    ASSERT no_relevant_artifact_changed_after_approval
    RETURN AUTHORIZED
```

#### 7.4.1 Native in-runtime dispatch (no PO terminal action)

After approvals are current, Gaspar initiates dispatch without
leaving the runtime: `request_dispatch` validates §7.4 gates
without an executor and returns the revision snapshot;
`claim_dispatch` (worker subagent session, delegated from the
Gaspar/PO parent) re-validates everything with the worker as
executor and issues the single-use grant bound to session, role,
module, WP, and revisions. One human Approve authorizes at most
one dispatch; one dispatch binds at most one worker session; the
worker acts only inside its bound scope. Shell, exported tokens,
and PO-operated commands are never part of this flow.

### 7.5 Verification gate `[P9.3]`

```
FUNCTION gate_verification(module_id, wp_id):
    ASSERT current_test_evidence EXISTS AND binds_to(revision)
    ASSERT current_security_evidence EXISTS AND binds_to(revision)
    ASSERT implementation_security_decision IS current
    ASSERT no_missing OR stale OR contradictory_security_evidence
    ASSERT rtk_attestation current
    ASSERT skill_attestation current
    ASSERT no_active blocker targeting module OR work_package
    ASSERT no_blocked_rtk OR blocked_process_skill
    RETURN AUTHORIZED
```

### 7.6 Completion gate `[P9.3]`

```
FUNCTION gate_completion(module_id):
    ASSERT implementation_matches_approved_specs
    ASSERT acceptance_criteria_verified
    ASSERT required_automated_tests_pass
    ASSERT lucca_evidence_current
    ASSERT security_blockers_resolved OR validly_waived
    ASSERT glenn_evidence_current
    ASSERT implementation_security_acceptance IS current
    ASSERT security_evidence_and_approvals_current_for_revision
    ASSERT documentation_synchronized
    ASSERT no_blocking_defect
    ASSERT spekkio_verdict == PASS
    ASSERT rtk_attestation current
    ASSERT skill_attestation current
    ASSERT traceability_chain_complete
    ASSERT legal_state_transition_to_complete
    RETURN AUTHORIZED
```

### 7.7 Gate failure handling

When any gate fails:
1. The Core returns the appropriate error code from the taxonomy `[INV §14]`.
2. No state is mutated.
3. A `DENIED` event is appended to the event log.
4. The operation is audited with actor identity and reason.

---

## 8. Approval and Waiver Security Model

### 8.1 Interactive approval flow

```
FUNCTION chrono_approve(action, scope_artifact_id, scope_revision, rationale):
    # Step 1: Verify human interaction
    IF NOT terminal_interactive_session():
        RAISE APPROVAL_REQUIRED

    # Step 2: Resolve signing key
    key = resolve_signing_key_from_os_keychain()
    IF key IS NULL:
        RAISE APPROVAL_REQUIRED

    # Step 3: Verify signer identity
    signer = prompt_and_verify_signer_identity(key)
    IF signer IS NULL:
        RAISE APPROVAL_REQUIRED

    # Step 4: Construct approval payload
    payload = {
        "action": action,
        "scope_artifact_id": scope_artifact_id,
        "scope_revision": scope_revision,
        "authority": signer,
        "rationale": rationale,
        "timestamp": now_iso8601_utc()
    }

    # Step 5: Sign payload
    signature = sign_canonical_json(payload, key)

    # Step 6: Append to database (immutable)
    INSERT INTO approval (...) VALUES (...)
    INSERT INTO event_log (event_type="ApprovalGranted", ...) VALUES ...

    RETURN approval_id
```

Reference: `[DOM §3.16]`, `[INV §4]`, `[FW §13]` `[P2.10]`.

### 8.2 Approval revocation

Approvals are append-only and never deleted. Revocation is modeled as a new event:
- A `RevocationRequested` event triggers a new interactive approval flow.
- The original approval remains in the event log with `revoked = TRUE`.

### 8.3 Waiver flow

Same interactive + signed flow as approval, but:
- Action is `waiver`.
- Scope binds to artifact revision.
- Must record: issue, rationale, evidence, compensating controls, follow-up, expiry/review condition `[DOM §3.24, INV §4.1]`.

---

## 9. Evidence Lifecycle

### 9.1 Evidence recording

```
FUNCTION record_evidence(producer, tool, target_revision, check_name, result, diagnostics):
    integrity_hash = sha256(canonicalize(result + diagnostics + target_revision))
    evidence_id = allocate_id("EVD")
    INSERT INTO evidence (...) VALUES (...)
    INSERT INTO event_log (event_type="EvidenceRecorded", ...)
    RETURN evidence_id
```

### 9.2 Evidence binding

- Evidence binds to `target_revision` — the exact artifact revision it proves `[P9.2, INV §11.1]`.
- The Core MUST verify the revision hash matches at consumption time `[INV §11.1]`.

### 9.3 Evidence freshness

- Non-ephemeral evidence: remains valid until the target artifact is materially revised `[INV §11.1]`.
- Ephemeral evidence (e.g., lint, smoke test): has a TTL from `chrono.yaml` `[P9.2]`. Stale ephemeral evidence → verification fails `[INV §11.3]`.

---

## 10. RTK Attestation

### 10.1 Attestation recording

Attestation proves binary identity only — never routing:

```
FUNCTION verify_and_record_rtk():
    # Must be the genuine Rust Token Killer binary
    binary = resolve_rtk_binary_from_config()
    IF NOT binary_from("https://github.com/rtk-ai/rtk"):
        RAISE RTK_NAME_COLLISION

    # rtk gain must succeed: dashboard verification, proving the
    # binary is genuinely Rust Token Killer (NOT proof that any
    # runtime command was routed)
    gain_result = execute_rtk_gain(binary)
    IF gain_result != 0:
        RAISE RTK_NAME_COLLISION

    # Check TTL
    IF rtk_recorded_at < now - ttl_from_config:
        status = stale
    ELSE:
        status = current

    INSERT INTO rtk_attestation (
        binary_path, binary_identity, version, provenance="https://github.com/rtk-ai/rtk",
        integration_mode, routing_test_passed=FALSE, gained=TRUE, ...,
        valid_until=now + ttl, status
    )
    INSERT INTO event_log (event_type="RtKAttested", ...)
```

Reference: `[DOM §3.27]`, `[INV §8]`, `[P6.5]`, `[REF §13]`, `[ADR-006]`.

### 10.2 Dispatch-time RTK check

Before any agent-driven CLI dispatch:

```
FUNCTION check_rtk_before_dispatch(target, adapter_id, session):
    rtk = SELECT latest FROM rtk_attestation WHERE status == current
    IF rtk IS NULL:
        RAISE BLOCKED_RTK
    IF rtk.bypass_events IS NOT EMPTY:
        rtk.status = invalid
        RAISE BLOCKED_RTK
    proof = SELECT latest_authoritative FROM routing_proof
            WHERE adapter_id AND runtime == session.runtime AND project_id
    IF proof IS NULL:
        # A non-authoritative candidate names the missing step;
        # no proof at all means routing is unproven.
        RAISE RTK_ROUTING_FAILURE
    IF proof.expired OR proof.rtk_attestation_id != rtk.id:
        RAISE RTK_ROUTING_FAILURE
    IF NOT adapter_active(proof.adapter_id):
        RAISE RTK_ROUTING_FAILURE
    IF proof.adapter_hash != current_registration_hash(proof.adapter_id):
        RAISE RTK_ROUTING_FAILURE
    IF sha256(proof.binary_path) != proof.binary_hash:
        RAISE RTK_ROUTING_FAILURE
    IF proof.asset_hash != current_managed_asset_manifest(proof.adapter_id):
        RAISE RTK_ROUTING_FAILURE
    RETURN (rtk, proof)
```

Configuration-file presence alone is NOT proof `[P8.7, INV §8.4]`.
Attestation currency alone NEVER authorizes dispatch `[INV §8.5, ADR-006]`.

### 10.3 Routing proofs (candidate → authoritative)

Effective routing is proven per adapter through `chrono rtk prove`
`[FIXES-SL-10.1 C2, ADR-006]`:

```
FUNCTION prove_routing(adapter_id, raw_command):
    REJECT IF raw_command is empty, already rtk-prefixed, or identity-only
        (gain, --version, config, init, help: binary/dashboard surface only)
    binary = resolve_genuine_rtk()  # --version + gain, else BLOCKED_RTK
    mapped = execute(binary, ["rewrite", ...raw_command])
    REJECT IF rewrite refuses, the mapping escapes the genuine binary,
        execution fails, or output exceeds the provability cap
    INSERT INTO routing_proof (..., authority='candidate', ...)  # authorizes nothing
    INSERT INTO event_log (event_type="RoutingProofRecorded", ...)

FUNCTION promote_routing_proof(proof_id):  # PO session, adapter.approve
    proof = SELECT FROM routing_proof WHERE id
    RETURN proof IF already authoritative (idempotent)
    REJECT unless adapter approved (promotion executes approval, never substitutes)
    REJECT unless proof binds the current attestation and the live binary
    manifest = read_managed_asset_inventory(proof.adapter_id)
    REJECT IF any managed asset missing
    UPDATE routing_proof SET authority='authoritative',
        adapter_hash=current_registration_hash, asset_hash=manifest.hash
    INSERT INTO event_log (event_type="ProofPromoted", ...)
```

Reference: `[INV §8.4, INV §8.7, INV §14.4]`.

---

## 11. Skill Attestation

### 11.1 Attestation recording

```
FUNCTION verify_and_record_skill():
    # Must be from canonical upstream
    IF upstream != "https://github.com/multica-ai/andrej-karpathy-skills":
        RAISE SKILL_PROVENANCE_FAILURE

    # Pinned commit must match
    current_commit = git_rev_parse("HEAD")
    IF current_commit != pinned_commit:
        RAISE SKILL_PROVENANCE_FAILURE

    # Deterministic generation verification
    generated_hashes = compute_runtime_artifact_hashes("skills/karpathy-guidelines/SKILL.md")
    stored_hashes = SELECT generated_hashes FROM skill_attestation
    IF generated_hashes != stored_hashes:
        RAISE SKILL_PROVENANCE_FAILURE

    # License check
    IF license_preserved != "MIT":
        RAISE SKILL_PROVENANCE_FAILURE

    # Discovery check
    IF NOT skill_discoverable_in_all_runtimes:
        RAISE SKILL_ACTIVATION_FAILURE

    # Activation smoke test
    IF NOT activation_smoke_test_passes():
        RAISE SKILL_ACTIVATION_FAILURE

    INSERT INTO skill_attestation (...)
    INSERT INTO event_log (event_type="SkillAttested", ...)
```

Reference: `[DOM §3.28]`, `[INV §9]`, `[P6.6]`, `[REF §13]`, `[P8.6]`.

### 11.2 Dispatch-time skill check

```
FUNCTION check_skill_before_dispatch():
    skill = SELECT latest FROM skill_attestation WHERE status == current
    IF skill IS NULL:
        RAISE BLOCKED_PROCESS_SKILL
    IF skill.bypass_events IS NOT EMPTY:
        skill.status = invalid
        RAISE BLOCKED_PROCESS_SKILL
    RETURN skill
```

Runtime artifacts MUST be deterministically generated from `skills/karpathy-guidelines/SKILL.md` `[P6.6, REF §13]`.

---

## 12. Reference Integrity

### 12.1 Reference resolution

```
FUNCTION resolve_reference(ref_id, optional_revision):
    artifact = SELECT * FROM artifact WHERE id = ref_id AND deleted = FALSE
    IF artifact IS NULL:
        RAISE ENTITY_NOT_FOUND
    IF optional_revision IS NOT NULL:
        IF artifact.revision != optional_revision:
            RAISE STALE_REVISION
    RETURN artifact
```

Reference: `[DOM §2.4, §2.6]`, `[INV §10]`.

### 12.2 DAG acyclicity

Before adding a dependency edge WP→WP:
```
FUNCTION check_dag_acyclic(new_edge_source, new_edge_target):
    IF dfs_cycle_detected(new_edge_source, new_edge_target):
        RAISE DAG_CYCLE
    RETURN TRUE
```

Reference: `[DOM §3.14]`, `[INV §10.4]`, `[P8.3]`, `[REF §27]`.

---

## 13. Project Initialization

### 13.1 `chrono init --system-analysis`

```
FUNCTION chrono_init():
    IF project_already_initialized:
        RAISE PROJECT_EXISTS

    # Verify terminal is interactive
    IF NOT terminal_interactive_session():
        RAISE NOT_INTERACTIVE

    project_id = generate_uuid()
    INSERT INTO project (id, language="en", gaspar_autonomy="SEMI_AUTONOMOUS",
                         runtime=NULL, created_at=now, updated_at=now, state=UNINITIALIZED)
    INSERT INTO event_log (event_type="ProjectInitialized", entity_id=project_id, ...)

    # Record system analysis
    gate_system_analysis()
    UPDATE project SET state = ANALYZING
```

Reference: `[P1.7]`, `[INV §1.1]`.

---

## 14. Conformance Requirements

### 14.1 Deterministic validation

The Core MUST produce identical validation results from the same persisted inputs `[INV §12.3]`. No validation result depends on an LLM session, model, or non-deterministic timestamp beyond what is persisted.

### 14.2 Session independence

Closing an LLM session, changing models, or changing agents MUST NOT erase decisions, approvals, waivers, evidence, or attestations `[INV §12.1]`. All operational state is in SQLite.

### 14.3 Provider/model neutrality in code

No CHRONO source file, default, template, test, or adapter MAY hardcode a provider, model name, or model version `[INV §11.2]`. If a runtime is not configured by the PO, the Core MUST return `CONFIG_ERROR` — it MUST NOT select one `[FW §22, P1.25]`.

### 14.4 Fail-closed

Whenever any mandatory state cannot be confirmed, the Core MUST deny the operation `[INV §15]` `[FW §592]`.

### 14.5 No conversational authority

No decision stored in model context, conversation history, or transient reasoning MAY be treated as authoritative `[INV §13.2]`. All authoritative decisions MUST be persisted as artifacts in SQLite or documents.

---

## 15. Event Schema

Every event in `event_log` has:

| Field | Type | Required |
|---|---|---|
| `event_type` | enum | yes |
| `entity_id` | string | yes |
| `payload` | JSON object | yes |
| `actor` | string (agent identity or "PO") | yes |
| `timestamp` | ISO-8601 UTC | yes |
| `prior_state` | string | no |
| `new_state` | string | no |
| `reasoning` | string | no |

Event types:
- `ArtifactCreated`, `ArtifactRevised`, `StateTransition`
- `ApprovalGranted`, `WaiverGranted`
- `BlockerRaised`, `BlockerResolved`
- `DefectRaised`, `DefectResolved`
- `EvidenceRecorded`, `RtKAttested`, `SkillAttested`
- `RoutingProofRecorded`, `ProofPromoted`
- `ModuleCompleted`, `ProjectInitialized`
- `DENIED` (gate failure audit)

Reference: `[DOM §5]`, `[FW §13]`.

---

## 16. Core API Surface

The Core exposes deterministic functions. Adapters MAY call them but MUST NOT reinterpret results:

| Function | Returns | Description |
|---|---|---|
| `validate_transition(e, f, t, ev, ctx)` | `AUTHORIZED` or error | State machine + gate validation |
| `project_project_state()` | state string | Compute Project state from children |
| `gate_architecture_approval()` | `AUTHORIZED` or error | Architecture gate |
| `gate_spec_ready(spec_id)` | `AUTHORIZED` or error | Spec READY gate |
| `gate_execution(module_id, wp_id, spec_rev)` | `AUTHORIZED` or error | Execution dispatch gate |
| `gate_completion(module_id)` | `AUTHORIZED` or error | Completion gate |
| `resolve_reference(ref, rev?)` | artifact or error | Reference resolution |
| `chrono_approve(action, scope, rev, rationale)` | approval_id or `APPROVAL_REQUIRED` | Interactive PO approval |
| `verify_and_record_rtk()` | `current` attestation or `BLOCKED_RTK` | RTK verification |
| `verify_and_record_skill()` | `current` attestation or `BLOCKED_PROCESS_SKILL` | Skill verification |
| `propose_planning_artifact(kind, id?, title, body, refs?)` | `{id, revision, path, approvalCommand}` or error | Governed planning draft (Gaspar/PO) |
| `revise_planning_artifact(id, title, body)` | `{id, revision, path, approvalCommand, healed, recovered}` or error | New planning revision; stales approvals; rematerializes a lost file (`healed`) or a lost structured registry row for Specs (`recovered`, audited) |
| `request_dispatch(module, wp?, kind?, rationale, proposed_profile?, defect?)` | `{dispatchId, kind, revisions, dispatchableRoles, effectiveProfile, riskTriggers}` or exact gate error | Native dispatch phase 1: every dispatch gate validated without an executor; Core-owned intent row (kind, revisions, requester, policy, expiry); read-only except audit (Gaspar/PO). Correction with several open loops names its defect; the owner derives from that loop |
| `record_task_delegation(agent, parent_session)` | `{dispatchId, agent, resume}` or `TASK_DENIED` | Binds exactly one native `task` delegation to one live dispatch of a fitting kind; idempotent for the same parent/agent (Gaspar-side session) |
| `claim_dispatch(dispatch_id, child_session)` | `{dispatchId, grantId, session, role, revisions}` or exact gate error | Native dispatch phase 2: delegated worker session minted from the Gaspar/PO parent, full gates re-validated, single-use grant issued and consumed with the enactment transition atomically; review kinds and second bindings bind without re-enacting |
| `confirm_claim(dispatch_id)` | `{dispatchId, status}` | Confirms host-side credential confinement: `ENACTED → ACTIVE` (requester or worker session; idempotent) |
| `release_dispatch(dispatch_id)` | `{dispatchId, status}` | Releases an evidenced binding to `COMPLETED` and retires its worker session (bound worker with proof, or Gaspar/PO oversight) |
| `revoke_dispatch(dispatch_id, reason?)` | `{dispatchId, status}` | Compensating revocation for failed/abandoned claims; revokes the worker session (Gaspar/PO) |
| `reconcile_stale_claims()` | `{expired[], revoked[]}` | Crash-safety sweep: expire stale intents, revoke stale enactments (Gaspar/PO) |
| `authorize_dispatched_tool()` | binding projection or exact gate error | Per-tool authorization against the committed `ACTIVE` binding with fresh revisions — mints no grant |
| `advance_scope(module, wp?, event)` | `{scope, fromState, toState}` or exact gate error | One legal forward step for the bound scope (kind-gated; terminal `SpekkioPassed` enforces profile-proportional readiness) |
| `next_action(module?, wp?)` | `{action, target, summary, reason, policyRule, alsoReady?, escalation?}` | Deterministic highest-precedence next action from Core records only. The planning runway resolves first, in dependency order: architecture submission/approval, spec submission, Harness recording, spec READY — each naming its exact target (`architecture`/`spec` scopes) — then activation, authorization, loops, dispatches, reviews, readiness, completion, batching. Missing PO ceremonies surface as explicit `request-approval` actions naming their approval action and scope; no result requires an unreported intermediate mutation |
| `execution_status(module?, wp?)` | own binding, scope states, revision currency | Worker execution projection without secrets; workers confined to their scope |
| `evidence_status(revision)` | current rows by id plus stale count | Evidence projection for one revision: no diagnostics, stale rows excluded |
| `deep_integrity_check()` | `{blockers, warnings, findings[]}` | Cross-record consistency: versions, dispatch backlog, stale citations, loop bounds, orphan sessions, dangling index, scope reachability, full validation fold (Gaspar/PO) |
| `assign_review(kind, module, wp?)` | `{reviewId, kind, reviewerRole}` | Assign a Glenn security review or Spekkio verification at the current revision (Gaspar/PO; at most one open per kind/scope/revision) |
| `complete_review(review_id)` | `{reviewId, status}` | Submit the assigned review from the reviewer session with bound evidence/verdict and independence (Glenn/Spekkio) |
| `open_correction_loop(defect_id)` | `{loopId, owner, attempt, maxAttempts, escalated}` | Open one bounded correction loop per defect with profile attempt bounds and terminal escalation |
| `complete_correction_loop(loop_id)` | `{loopId, status, invalidatedEvidence}` | Complete with owner fix evidence; invalidates pre-correction proof; requires re-verification (owner) |
| `set_policy_profile(profile, rationale, signature?, timestamp?)` | `{profile, downgraded}` | Calibrate `lean`/`standard`/`critical` (Gaspar/PO; lowering needs a fresh PO signature; default `standard`) |
| `complete_module(module_id)` | `{state}` | Terminal completion: package-less modules through their verdict chain, WP modules by aggregate (`AllPackagesComplete`); idempotent |
| `planning_status()` | proposed/awaiting/approved/rejected/stale list | Safe status projection, no secrets |
| `request_document_write(path, body, rationale, implications?)` | `{ticketId?, challenge?, expiresAt?, alreadyCurrent, scopeId, contentHash, baseRevision?}` or error | User-approved document petition (Gaspar/PO): validates path (project-contained `.md`, outside `.chrono/`, `.git/`, `node_modules/`), secret-scans and bounds the body, stores it Core-side, issues a `document-write` ticket binding path plus exact content hash; already-current bytes return no ticket |
| `finalize_document_write` | via `finalizeApprovalTicket` | Same permission-bound finalize; on `document-write` tickets the Core additionally verifies base currency, writes the approved bytes (backup + atomic replace) inside the finalize transaction with compensation, and appends `DocumentWritten` audit |

Reference: `[DOM §6]`, `[FW §13]`, `[REF §24]`.

---

## 17. Planning-Artifact Authoring (OC-P11)

The bootstrap deadlock (no Module/WP dispatch before Specs exist, no
Specs without file writes) is closed by a Core-governed planning path
distinct from implementation execution.

### 17.1 Permitted kinds and destinations

Kinds: `discovery`, `requirement`, `architecture`, `adr`, `spec`,
`harness-draft`, `security-profile`, `roadmap`, `module`,
`workpackage`. Destinations derive deterministically from (kind, id)
under `.chrono/context`, `.chrono/architecture`,
`.chrono/architecture/adr`, `.chrono/specs`, `.chrono/harness`,
`.chrono/security`, `.chrono/roadmap`. There is no caller-supplied
path. Product-code paths, `.chrono/chrono.db`, broker accounts, token
files, and internal hooks are unreachable through this path.

### 17.2 Capability and validation

`planning.propose`, `planning.revise`, `planning.status` admit Gaspar
and the PO only (authority policy v9; tool policy v6). Validation
covers kind, exact identifier, lifecycle entry state
(DRAFT/PLANNED/proposed), resolvable references, schema, secrets, and
size (1 byte to 64 KiB). `module` plans require at least one Spec
reference; `workpackage` plans require their owning Module reference.

### 17.3 Atomicity and revision binding

Files materialize first (tmp + rename), so a filesystem failure denies
with nothing persisted; SQLite registry/event changes commit second,
removing the created file when the transaction fails. `revise` keeps
a backup and restores the last good draft on registry failure — no
half-materialized draft reads as ready. The file revision IS the
registry revision: SP/MOD/WP drafts
create DRAFT/PLANNED rows, `ARCH` moves the project architecture row,
security proposals append profile versions, and all other kinds track
revisions in runtime config. `revise` appends history and moves the
current pointer, so `planning-approval` rows bound to older revisions
go stale deterministically. The `planning-approval` action joins the
canonical approval set alongside `module-approval`,
`architecture-security`, `implementation-security`, and
`adapter-registration`.