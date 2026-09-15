/**
 * SQLite schema definitions matching docs/core/CORE-SPECIFICATION.md §5
 * Schema is versioned via a migrations table.
 * [CORE §5, P3.9, FW §671]
 */

export const SCHEMA_VERSION = 20;

export const MIGRATIONS: Record<number, string> = {
  1: `
    -- Project table (aggregate root) [DOM §3.1]
    CREATE TABLE project (
      id              TEXT PRIMARY KEY,
      language        TEXT NOT NULL DEFAULT 'en',
      gaspar_autonomy TEXT NOT NULL DEFAULT 'SEMI_AUTONOMOUS',
      runtime         TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      state           TEXT NOT NULL DEFAULT 'UNINITIALIZED',
      system_analysis_complete INTEGER NOT NULL DEFAULT 0,
      architecture_id TEXT,
      architecture_revision TEXT,
      architecture_state TEXT,
      spec_count        INTEGER NOT NULL DEFAULT 0,
      module_count      INTEGER NOT NULL DEFAULT 0
    );

    -- Artifact registry [DOM §2, CORE §5]
    CREATE TABLE artifact (
      id              TEXT PRIMARY KEY,
      type            TEXT NOT NULL,
      revision        TEXT NOT NULL,
      status          TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      deleted         INTEGER NOT NULL DEFAULT 0,
      content_hash    TEXT NOT NULL,
      UNIQUE(id, revision)
    );

    -- Reference resolution [DOM §2.4, CORE §12]
    CREATE TABLE artifact_ref (
      source_id        TEXT NOT NULL,
      target_id         TEXT NOT NULL,
      target_revision   TEXT NOT NULL,
      PRIMARY KEY (source_id, target_id, target_revision),
      FOREIGN KEY (source_id) REFERENCES artifact(id) ON DELETE CASCADE
    );

    -- Event log (append-only) [DOM §5.2, CORE §15]
    CREATE TABLE event_log (
      seq            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type     TEXT NOT NULL,
      entity_id      TEXT NOT NULL,
      payload        TEXT NOT NULL,
      actor          TEXT NOT NULL,
      timestamp      TEXT NOT NULL,
      prior_state    TEXT,
      new_state      TEXT,
      reasoning      TEXT
    );

    CREATE INDEX idx_event_entity ON event_log(entity_id);
    CREATE INDEX idx_event_type   ON event_log(event_type);
    CREATE INDEX idx_event_time   ON event_log(timestamp);

    -- Approvals [DOM §3.16, CORE §8, INV §4]
    CREATE TABLE approval (
      id                 TEXT PRIMARY KEY,
      action             TEXT NOT NULL,
      scope_artifact_id  TEXT NOT NULL,
      scope_revision     TEXT NOT NULL,
      authority          TEXT NOT NULL,
      signer             TEXT NOT NULL,
      signature          TEXT NOT NULL,
      rationale           TEXT NOT NULL,
      timestamp           TEXT NOT NULL,
      revoked             INTEGER NOT NULL DEFAULT 0,
      UNIQUE(scope_artifact_id, scope_revision, action)
    );

    -- Waivers [DOM §3.24, CORE §8]
    CREATE TABLE waiver (
      id                    TEXT PRIMARY KEY,
      issue                  TEXT NOT NULL,
      scope_artifact_id      TEXT NOT NULL,
      scope_revision         TEXT NOT NULL,
      rationale              TEXT NOT NULL,
      evidence_ref           TEXT,
      accepting_authority    TEXT NOT NULL,
      compensating_controls  TEXT,
      follow_up_task_id      TEXT,
      expiry_review_condition TEXT NOT NULL,
      timestamp              TEXT NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'active',
      signature              TEXT NOT NULL
    );

    -- Blockers [DOM §3.17, CORE §5]
    CREATE TABLE blocker (
      id              TEXT PRIMARY KEY,
      type            TEXT NOT NULL,
      issuer          TEXT NOT NULL,
      target_ids      TEXT NOT NULL, -- JSON array of artifact IDs
      reason          TEXT NOT NULL,
      evidence_refs   TEXT NOT NULL DEFAULT '[]', -- JSON array
      created_at      TEXT NOT NULL,
      resolved_at     TEXT,
      resolved_by     TEXT,
      resolved        INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX idx_blocker_resolved ON blocker(resolved);

    -- Defects [DOM §3.18, CORE §5]
    CREATE TABLE defect (
      id               TEXT PRIMARY KEY,
      classification   TEXT NOT NULL,
      severity         TEXT NOT NULL,
      evidence_refs    TEXT NOT NULL DEFAULT '[]',
      affected_criteria TEXT NOT NULL DEFAULT '[]',
      affected_artifacts TEXT NOT NULL DEFAULT '[]',
      owner            TEXT NOT NULL,
      blocking_scope   TEXT,
      repro_info       TEXT,
      created_at       TEXT NOT NULL,
      resolved_at      TEXT,
      status           TEXT NOT NULL DEFAULT 'open'
    );

    -- Evidence [DOM §3.19, CORE §9]
    CREATE TABLE evidence (
      id              TEXT PRIMARY KEY,
      producer        TEXT NOT NULL,
      tool            TEXT,
      timestamp       TEXT NOT NULL,
      target_revision TEXT NOT NULL,
      check_name      TEXT NOT NULL,
      result          TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'value')),
      diagnostics     TEXT,
      integrity_hash  TEXT NOT NULL
    );

    CREATE INDEX idx_evidence_target ON evidence(target_revision);

    -- QA Reports [DOM §3.20, CORE §5]
    CREATE TABLE qa_report (
      id              TEXT PRIMARY KEY,
      module_id       TEXT,
      work_package_id TEXT,
      verdict         TEXT NOT NULL CHECK (verdict IN ('PASS', 'FAILED', 'WAIVED')),
      reviewed_evidence TEXT NOT NULL DEFAULT '[]',
      defect_ids      TEXT NOT NULL DEFAULT '[]',
      waiver_ids      TEXT NOT NULL DEFAULT '[]',
      reviewer        TEXT NOT NULL,
      timestamp       TEXT NOT NULL
    );

    -- Security Profile [DOM §3.21, CORE §5]
    CREATE TABLE security_profile (
      id             TEXT PRIMARY KEY,
      version        INTEGER NOT NULL,
      content_hash   TEXT NOT NULL,
      approved_at    TEXT
    );

    -- Security Blockers [DOM §3.23, CORE §5]
    CREATE TABLE security_blocker (
      id              TEXT PRIMARY KEY,
      scope_artifact_id TEXT NOT NULL,
      scope_revision    TEXT NOT NULL,
      description       TEXT NOT NULL,
      issued_by         TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      resolved_at       TEXT,
      resolved          INTEGER NOT NULL DEFAULT 0
    );

    -- RTK Attestation [DOM §3.27, CORE §10]
    CREATE TABLE rtk_attestation (
      id                    TEXT PRIMARY KEY,
      binary_path            TEXT NOT NULL,
      binary_identity        TEXT NOT NULL,
      version                TEXT NOT NULL,
      provenance             TEXT NOT NULL,
      integration_mode       TEXT,
      routing_test_passed    INTEGER NOT NULL,
      routing_test_log       TEXT,
      gained                 INTEGER NOT NULL,
      savings_evidence       TEXT,
      bypass_events          TEXT NOT NULL DEFAULT '[]',
      valid_until            TEXT NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'current'
    );

    -- Skill Attestation [DOM §3.28, CORE §11]
    CREATE TABLE skill_attestation (
      id                    TEXT PRIMARY KEY,
      upstream               TEXT NOT NULL,
      pinned_commit          TEXT NOT NULL,
      source_hash            TEXT NOT NULL,
      generated_hashes       TEXT NOT NULL,
      converter_version      TEXT NOT NULL,
      license_status         TEXT NOT NULL,
      attribution            TEXT,
      runtime_identity       TEXT,
      agent_identity         TEXT,
      discovery_result       TEXT NOT NULL,
      permission_result      TEXT NOT NULL,
      activation_test_passed INTEGER NOT NULL,
      bypass_events          TEXT NOT NULL DEFAULT '[]',
      valid_until            TEXT NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'current'
    );

    -- Change Requests [DOM §3.25, CORE §5]
    CREATE TABLE change_request (
      id               TEXT PRIMARY KEY,
      subject           TEXT NOT NULL,
      proposed_change   TEXT NOT NULL,
      impact_analysis   TEXT NOT NULL,
      authority         TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'proposed',
      supersedes        TEXT NOT NULL DEFAULT '[]',
      affected          TEXT NOT NULL DEFAULT '[]',
      rationale         TEXT NOT NULL,
      provenance        TEXT NOT NULL,
      timestamp         TEXT NOT NULL
     );

    -- Harness cache [CORE §7]
    CREATE TABLE harness (
      spec_revision  TEXT PRIMARY KEY,
      content_hash   TEXT NOT NULL,
      generated_at   TEXT NOT NULL,
      stale          INTEGER NOT NULL DEFAULT 0,
      content        TEXT NOT NULL
    );

    -- Runtime config (PO-owned) [CORE §8, RUNTIME §8]
    CREATE TABLE runtime_config (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  2: `
    -- Collision-safe Core-assigned identifier sequences [CORE §3.1, Remediation §4]
    -- One monotonic counter per identity family; allocation is a single
    -- atomic UPSERT ... RETURNING statement (no wall-clock derivation).
    CREATE TABLE id_sequence (
      family TEXT PRIMARY KEY,
      next   INTEGER NOT NULL CHECK (next >= 1)
    );

    -- Immutable artifact revision history [DOM §2.3, P3.5, Remediation §4]
    -- Every revision ever persisted; resolving <ID>@<revision> reads here,
    -- so a new revision never overwrites the row an old reference needs.
    -- Rows are append-only (UPDATE/DELETE forbidden by trigger, migration 3).
    CREATE TABLE artifact_revision (
      id           TEXT NOT NULL,
      revision     TEXT NOT NULL,
      type         TEXT NOT NULL,
      status       TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content      TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      PRIMARY KEY (id, revision)
    );

    CREATE INDEX idx_revision_id ON artifact_revision(id);

    -- Re-entry target for BLOCKED artifacts [STATE §2.2, Remediation §4]
    -- Records the pre-BLOCKED status so BlockerResolved returns to the
    -- validated prior state instead of an arbitrary one.
    ALTER TABLE blocker ADD COLUMN prior_state TEXT;
  `,
  3: `
    -- Append-only and immutability triggers [DOM §5.2, P3.5, FW §13, Remediation §4]
    -- Critical events, approvals, waivers, evidence, attestations, revision
    -- history, and audit records are protected against UPDATE/DELETE through
    -- every SQL path, including raw connections. Corrections and revocations
    -- append new events/state instead of rewriting facts.

    -- event_log: pure append-only
    CREATE TRIGGER trg_event_log_no_update BEFORE UPDATE ON event_log
    BEGIN
      SELECT RAISE(ABORT, 'event_log is append-only: UPDATE forbidden');
    END;
    CREATE TRIGGER trg_event_log_no_delete BEFORE DELETE ON event_log
    BEGIN
      SELECT RAISE(ABORT, 'event_log is append-only: DELETE forbidden');
    END;

    -- artifact_revision: pure append-only revision history
    CREATE TRIGGER trg_artifact_revision_no_update BEFORE UPDATE ON artifact_revision
    BEGIN
      SELECT RAISE(ABORT, 'artifact_revision is append-only: UPDATE forbidden');
    END;
    CREATE TRIGGER trg_artifact_revision_no_delete BEFORE DELETE ON artifact_revision
    BEGIN
      SELECT RAISE(ABORT, 'artifact_revision is append-only: DELETE forbidden');
    END;

    -- evidence: immutable proof records
    CREATE TRIGGER trg_evidence_no_update BEFORE UPDATE ON evidence
    BEGIN
      SELECT RAISE(ABORT, 'evidence is immutable: UPDATE forbidden');
    END;
    CREATE TRIGGER trg_evidence_no_delete BEFORE DELETE ON evidence
    BEGIN
      SELECT RAISE(ABORT, 'evidence is immutable: DELETE forbidden');
    END;

    -- approval: immutable except the revocation flag 0 → 1, all other
    -- columns frozen [CORE §8.2: revocation appends state, keeps history]
    CREATE TRIGGER trg_approval_no_delete BEFORE DELETE ON approval
    BEGIN
      SELECT RAISE(ABORT, 'approval rows cannot be deleted: revoke instead');
    END;
    CREATE TRIGGER trg_approval_update_guard BEFORE UPDATE ON approval
    WHEN NOT (
      OLD.revoked = 0 AND NEW.revoked = 1
      AND OLD.id IS NEW.id
      AND OLD.action IS NEW.action
      AND OLD.scope_artifact_id IS NEW.scope_artifact_id
      AND OLD.scope_revision IS NEW.scope_revision
      AND OLD.authority IS NEW.authority
      AND OLD.signer IS NEW.signer
      AND OLD.signature IS NEW.signature
      AND OLD.rationale IS NEW.rationale
      AND OLD.timestamp IS NEW.timestamp
    )
    BEGIN
      SELECT RAISE(ABORT, 'approval rows are immutable except revocation (revoked 0 to 1)');
    END;

    -- waiver: immutable except status active → expired | invalidated [STATE §2.7]
    CREATE TRIGGER trg_waiver_no_delete BEFORE DELETE ON waiver
    BEGIN
      SELECT RAISE(ABORT, 'waiver rows cannot be deleted');
    END;
    CREATE TRIGGER trg_waiver_update_guard BEFORE UPDATE ON waiver
    WHEN NOT (
      OLD.status = 'active'
      AND (NEW.status = 'expired' OR NEW.status = 'invalidated')
      AND OLD.id IS NEW.id
      AND OLD.issue IS NEW.issue
      AND OLD.scope_artifact_id IS NEW.scope_artifact_id
      AND OLD.scope_revision IS NEW.scope_revision
      AND OLD.rationale IS NEW.rationale
      AND OLD.evidence_ref IS NEW.evidence_ref
      AND OLD.accepting_authority IS NEW.accepting_authority
      AND OLD.compensating_controls IS NEW.compensating_controls
      AND OLD.follow_up_task_id IS NEW.follow_up_task_id
      AND OLD.expiry_review_condition IS NEW.expiry_review_condition
      AND OLD.timestamp IS NEW.timestamp
      AND OLD.signature IS NEW.signature
    )
    BEGIN
      SELECT RAISE(ABORT, 'waiver rows are immutable except status active to expired|invalidated');
    END;

    -- attestations: status lifecycle only, all identity columns frozen
    CREATE TRIGGER trg_rtk_attestation_no_delete BEFORE DELETE ON rtk_attestation
    BEGIN
      SELECT RAISE(ABORT, 'rtk_attestation rows cannot be deleted');
    END;
    CREATE TRIGGER trg_rtk_attestation_update_guard BEFORE UPDATE ON rtk_attestation
    WHEN NOT (
      OLD.id IS NEW.id
      AND OLD.binary_path IS NEW.binary_path
      AND OLD.binary_identity IS NEW.binary_identity
      AND OLD.version IS NEW.version
      AND OLD.provenance IS NEW.provenance
      AND OLD.integration_mode IS NEW.integration_mode
      AND OLD.routing_test_passed IS NEW.routing_test_passed
      AND OLD.routing_test_log IS NEW.routing_test_log
      AND OLD.gained IS NEW.gained
      AND OLD.savings_evidence IS NEW.savings_evidence
      AND OLD.bypass_events IS NEW.bypass_events
      AND OLD.valid_until IS NEW.valid_until
      AND (
        (OLD.status = 'current' AND (NEW.status = 'stale' OR NEW.status = 'invalid'))
        OR (OLD.status = 'stale' AND NEW.status = 'invalid')
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'rtk_attestation identity columns are immutable: re-attest with a new row');
    END;
    CREATE TRIGGER trg_skill_attestation_no_delete BEFORE DELETE ON skill_attestation
    BEGIN
      SELECT RAISE(ABORT, 'skill_attestation rows cannot be deleted');
    END;
    CREATE TRIGGER trg_skill_attestation_update_guard BEFORE UPDATE ON skill_attestation
    WHEN NOT (
      OLD.id IS NEW.id
      AND OLD.upstream IS NEW.upstream
      AND OLD.pinned_commit IS NEW.pinned_commit
      AND OLD.source_hash IS NEW.source_hash
      AND OLD.generated_hashes IS NEW.generated_hashes
      AND OLD.converter_version IS NEW.converter_version
      AND OLD.license_status IS NEW.license_status
      AND OLD.attribution IS NEW.attribution
      AND OLD.runtime_identity IS NEW.runtime_identity
      AND OLD.agent_identity IS NEW.agent_identity
      AND OLD.discovery_result IS NEW.discovery_result
      AND OLD.permission_result IS NEW.permission_result
      AND OLD.activation_test_passed IS NEW.activation_test_passed
      AND OLD.bypass_events IS NEW.bypass_events
      AND OLD.valid_until IS NEW.valid_until
      AND (
        (OLD.status = 'current' AND (NEW.status = 'stale' OR NEW.status = 'invalid'))
        OR (OLD.status = 'stale' AND NEW.status = 'invalid')
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'skill_attestation identity columns are immutable: re-attest with a new row');
    END;
  `,
  4: `
    -- QA revision binding [DOM §3.20, P9.3, Remediation §6]
    -- A verdict proves a specific implementation revision; guards join the
    -- verdict to the module/work-package revision it assessed.
    ALTER TABLE qa_report ADD COLUMN module_revision TEXT;
    ALTER TABLE qa_report ADD COLUMN work_package_revision TEXT;
  `,
  5: `
    -- Canonical role rename luca → lucca [RUNTIME §2, Remediation §3A].
    -- Explicit audited migration (never a silent substitution): every
    -- stored producer/owner/reviewer value using the misspelled identity
    -- is rewritten, and the rewrite is recorded in schema_version.
    -- The evidence immutability triggers are dropped and recreated around
    -- the rewrite inside this same atomic migration; outside it, no path
    -- may UPDATE evidence rows.
    DROP TRIGGER IF EXISTS trg_evidence_no_update;
    DROP TRIGGER IF EXISTS trg_evidence_no_delete;
    UPDATE evidence SET producer = 'lucca' WHERE producer = 'luca';
    UPDATE defect SET owner = 'lucca' WHERE owner = 'luca';
    UPDATE qa_report SET reviewer = 'lucca' WHERE reviewer = 'luca';
    CREATE TRIGGER trg_evidence_no_update BEFORE UPDATE ON evidence
    BEGIN
      SELECT RAISE(ABORT, 'evidence is immutable: UPDATE forbidden');
    END;
    CREATE TRIGGER trg_evidence_no_delete BEFORE DELETE ON evidence
    BEGIN
      SELECT RAISE(ABORT, 'evidence is immutable: DELETE forbidden');
    END;
  `,
  6: `
    -- Dispatch grants: authorized dispatches bound to one session and one
    -- assigned role [DOM §2.2, Remediation §3A]. Single-use, expiring,
    -- scope-checked. Grants are consumed, never rewritten (consumed flag
    -- moves 0 → 1 only).
    CREATE TABLE execution_grant (
      id               TEXT PRIMARY KEY,
      module_id        TEXT NOT NULL,
      work_package_id  TEXT,
      module_revision  TEXT NOT NULL,
      spec_revisions   TEXT NOT NULL DEFAULT '[]',
      role             TEXT NOT NULL,
      session          TEXT,
      requested_by     TEXT NOT NULL,
      issued_at        TEXT NOT NULL,
      expires_at       TEXT NOT NULL,
      consumed         INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_grant_module ON execution_grant(module_id);
  `,
  7: `
    -- Authenticated adapter sessions [DOM §2.2, Remediation §3A].
    -- A session binds one adapter, runtime, project, role, and assignment
    -- scope to a non-forgeable token. Only the token SHA-256 persists;
    -- the token itself is returned once at issuance and never stored.
    CREATE TABLE agent_session (
      id              TEXT PRIMARY KEY,
      token_hash      TEXT NOT NULL UNIQUE,
      role            TEXT NOT NULL,
      adapter         TEXT NOT NULL,
      runtime         TEXT NOT NULL,
      project_id      TEXT NOT NULL,
      scope_module    TEXT,
      scope_wp        TEXT,
      parent_id       TEXT,
      issued_at       TEXT NOT NULL,
      expires_at      TEXT NOT NULL,
      revoked         INTEGER NOT NULL DEFAULT 0,
      last_seen       TEXT NOT NULL
    );
    CREATE INDEX idx_session_token ON agent_session(token_hash);

    -- Full grant binding [Remediation §2, review R2].
    -- A grant pins the project, module/WP revisions, every Spec revision,
    -- the Harness bindings, the assigned role, the executing session, the
    -- adapter/runtime, the policy version, both attestations, and both
    -- approvals. Revalidation compares all of them on every consumption.
    ALTER TABLE execution_grant ADD COLUMN project_id TEXT;
    ALTER TABLE execution_grant ADD COLUMN work_package_revision TEXT;
    ALTER TABLE execution_grant ADD COLUMN harness_bindings TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE execution_grant ADD COLUMN rtk_attestation_id TEXT;
    ALTER TABLE execution_grant ADD COLUMN skill_attestation_id TEXT;
    ALTER TABLE execution_grant ADD COLUMN module_approval_id TEXT;
    ALTER TABLE execution_grant ADD COLUMN arch_approval_id TEXT;
    ALTER TABLE execution_grant ADD COLUMN policy_version TEXT;

    -- Blocker issuer authority [Remediation §3A.6]: who raised it, in
    -- which role and session, so resolution can verify ownership.
    ALTER TABLE blocker ADD COLUMN issuer_role TEXT;
    ALTER TABLE blocker ADD COLUMN issuer_session TEXT;
  `,
  8: `
    -- One-time privileged-session authorizations [Remediation §3A].
    -- A PO-signed bootstrap nonce is consumed atomically with the session
    -- it authorizes. The PRIMARY KEY makes replay fail closed, even inside
    -- the five-minute signature freshness window.
    CREATE TABLE session_authorization (
      nonce      TEXT PRIMARY KEY,
      role       TEXT NOT NULL,
      authority  TEXT NOT NULL,
      used_at    TEXT NOT NULL
    );
  `,
  9: `
    -- Runtime adapter registry [RUNTIME §13, PL Phase 5].
    -- An adapter binds a PO-selected runtime identifier to its entrypoint
    -- and hook/proof specs. Registration is PO-only (Core-enforced);
    -- revocation is terminal. Dispatch is allowed only for active rows
    -- whose entrypoint is still executable.
    CREATE TABLE adapter (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      entrypoint         TEXT NOT NULL,
      gate_hook          TEXT,
      dispatch_proof     TEXT,
      rtk_routing        TEXT,
      skill_activation   TEXT,
      conformance_proof  TEXT NOT NULL DEFAULT '[]',
      status             TEXT NOT NULL DEFAULT 'active',
      registered_by      TEXT NOT NULL,
      registered_at      TEXT NOT NULL
    );
  `,
  10: `
    -- Grant adapter binding [FIXES-SL-1-7]: a dispatch grant optionally
    -- names the adapter it was issued for. Grants issued without an
    -- adapter (older flows) skip the adapter-liveness check; grants bound
    -- to a revoked adapter burn fail-closed at consumption.
    ALTER TABLE execution_grant ADD COLUMN adapter_id TEXT;
  `,
  11: `
    -- RTK routing proofs [SLICE-9 §9.3, P8.5, INV §8.4]: append-only
    -- evidence that a command executed effectively through the genuine RTK
    -- binary for one adapter/runtime/project scope. Dispatch requires a
    -- current proof; rows are never updated or deleted.
    CREATE TABLE routing_proof (
      id                 TEXT PRIMARY KEY,
      adapter_id         TEXT NOT NULL,
      runtime            TEXT NOT NULL,
      session_id         TEXT NOT NULL,
      project_id         TEXT NOT NULL,
      rtk_attestation_id TEXT NOT NULL,
      binary_path        TEXT NOT NULL,
      binary_hash        TEXT NOT NULL,
      version            TEXT NOT NULL,
      proof_command      TEXT NOT NULL,
      command_hash       TEXT NOT NULL,
      output_hash        TEXT NOT NULL,
      exit_status        INTEGER NOT NULL,
      gain_available     INTEGER NOT NULL DEFAULT 0,
      timestamp          TEXT NOT NULL,
      valid_until        TEXT NOT NULL
    );
    CREATE INDEX idx_routing_proof_scope ON routing_proof(adapter_id, runtime, project_id);
  `,
  12: `
    -- Setup state machine for chrono init orchestration [SLICE-10 §3.3]:
    -- one resumable row: the furthest step reached plus non-secret detail
    -- JSON (consent scopes, per-step verification notes). Advance is
    -- same-step (idempotent retry) or exactly-next-step; skip-ahead denied.
    CREATE TABLE setup_state (
      id         TEXT PRIMARY KEY CHECK (id = 'setup'),
      step       TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      detail     TEXT NOT NULL DEFAULT '{}'
    );
    -- Broker credentials for automatic Gaspar entry [SLICE-10 §5.2]:
    -- only the SHA-256 of the secret persists; the secret itself lives in
    -- the OS keychain and travels to the adapter over a local stdio pipe,
    -- never in prompts, env, argv, logs, or repository files. Revocation
    -- is terminal.
    CREATE TABLE broker_credential (
      id          TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      revoked     INTEGER NOT NULL DEFAULT 0
    );
  `,
  13: `
    -- Routing-proof authority [FIXES-SL-10.1 C3]: proofs are recorded as
    -- non-authoritative CANDIDATE and become AUTHORITATIVE only through
    -- explicit promotion after signed adapter approval. Promotion
    -- snapshots the adapter registration hash and the managed-asset
    -- manifest hash; dispatch re-validates both, so adapter
    -- re-registration or managed-asset drift invalidates old proofs.
    -- Pre-routing input is bound so the effective routed command is
    -- traceable to what the operator asked to route. Existing rows keep
    -- their evidence and become CANDIDATE (fail-closed default).
    ALTER TABLE routing_proof ADD COLUMN authority TEXT NOT NULL DEFAULT 'candidate';
    ALTER TABLE routing_proof ADD COLUMN adapter_hash TEXT;
    ALTER TABLE routing_proof ADD COLUMN pre_routing_command TEXT NOT NULL DEFAULT '';
    ALTER TABLE routing_proof ADD COLUMN asset_hash TEXT;
  `,
  14: `
    -- Routing-proof promotion guard [OC-P2]: the persistence layer permits
    -- exactly one mutation of a proof row — candidate → authoritative with
    -- non-null adapter and managed-asset hashes — and forbids every other
    -- UPDATE and every DELETE. Core-level validation stays primary; these
    -- triggers are the backstop against bypass via direct SQL, so an
    -- authoritative proof without a legal promotion can never exist, and
    -- authoritative rows can never be modified or removed afterward.
    CREATE TRIGGER routing_proof_permit_promotion_only
    BEFORE UPDATE ON routing_proof
    FOR EACH ROW
    WHEN NOT (
      OLD.authority = 'candidate' AND NEW.authority = 'authoritative'
      AND NEW.adapter_hash IS NOT NULL AND NEW.asset_hash IS NOT NULL
      AND NEW.id = OLD.id
      AND NEW.adapter_id = OLD.adapter_id
      AND NEW.runtime = OLD.runtime
      AND NEW.session_id = OLD.session_id
      AND NEW.project_id = OLD.project_id
      AND NEW.rtk_attestation_id = OLD.rtk_attestation_id
      AND NEW.binary_path = OLD.binary_path
      AND NEW.binary_hash = OLD.binary_hash
      AND NEW.version = OLD.version
      AND NEW.proof_command = OLD.proof_command
      AND NEW.pre_routing_command = OLD.pre_routing_command
      AND NEW.command_hash = OLD.command_hash
      AND NEW.output_hash = OLD.output_hash
      AND NEW.exit_status = OLD.exit_status
      AND NEW.gain_available = OLD.gain_available
      AND NEW.timestamp = OLD.timestamp
      AND NEW.valid_until = OLD.valid_until
    )
    BEGIN
      SELECT RAISE(ABORT, 'routing_proof: only candidate → authoritative promotion with non-null hashes is permitted');
    END;
    CREATE TRIGGER routing_proof_no_delete
    BEFORE DELETE ON routing_proof
    BEGIN
      SELECT RAISE(ABORT, 'routing_proof: proof rows are append-only and cannot be deleted');
    END;
  `,
  15: `
    -- Native approval tickets (OC-P11 integrated ceremony): single-use,
    -- short-lived, scope- and revision-bound authorizations created
    -- through approval-request and consumed by exactly one successful
    -- permission-bound finalize. Rows are never updated except the
    -- consumed 0 → 1 flip, and never deleted: replay collides or finds
    -- a consumed ticket, both fail-closed.
    CREATE TABLE approval_ticket (
      id                    TEXT PRIMARY KEY,
      action                TEXT NOT NULL,
      scope_artifact_id     TEXT NOT NULL,
      scope_revision        TEXT NOT NULL,
      authority             TEXT NOT NULL,
      rationale             TEXT NOT NULL,
      security_implications TEXT NOT NULL,
      requester_session     TEXT NOT NULL,
      created_at            TEXT NOT NULL,
      expires_at            TEXT NOT NULL,
      consumed              INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_ticket_scope ON approval_ticket(scope_artifact_id, scope_revision);
  `,
  16: `
    -- Exactly-once approval ceremonies: durable claim ledger binding
    -- canonical project, runtime session, question/request id, exactly
    -- one ticket, scope, action, and revision. The claim is inserted
    -- atomically inside the finalize transaction; redelivery of the
    -- same ceremony collides on the primary key instead of consuming
    -- the ticket or recording twice. Claims are never updated or
    -- deleted: replay collides, always fail-closed.
    CREATE TABLE ceremony_claim (
      ceremony_key TEXT PRIMARY KEY,
      ticket_id    TEXT NOT NULL,
      approval_id  TEXT,
      claimed_at   TEXT NOT NULL
    );
    CREATE INDEX idx_claim_ticket ON ceremony_claim(ticket_id);
    -- Repair for the dual-path fan-out (TICKET-0024 class): an approval
    -- id granted for SEVERAL tickets by ONE native observation is one
    -- human Approve fanned out over many tickets. Those rows are
    -- revoked append-only (row and history kept; affected artifacts
    -- return to stale/awaiting-signature). Genuinely separate
    -- ceremonies aliasing one row (distinct native observations) and
    -- classic approvals (no ticket marker) are untouched.
    UPDATE approval SET revoked = 1 WHERE id IN (
      SELECT entity_id FROM event_log
      WHERE event_type = 'ApprovalGranted'
      GROUP BY entity_id
      HAVING COUNT(DISTINCT json_extract(payload, '$.ticketId')) > 1
         AND COUNT(DISTINCT json_extract(payload, '$.nativeObservation.permissionCallId')) = 1
    );
    INSERT INTO event_log (event_type, entity_id, payload, actor, timestamp, prior_state, new_state, reasoning)
    SELECT 'ApprovalRevoked', id,
      json_object('reason', 'exactly-once repair: approval id granted for several tickets by one native observation (fan-out); re-request and re-confirm the current revision',
                  'repairMigration', 16),
      'PO', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'granted', 'revoked',
      'Fan-out repair: one human Approve must never authorize several tickets'
    FROM approval WHERE revoked = 1 AND id IN (
      SELECT entity_id FROM event_log
      WHERE event_type = 'ApprovalGranted'
      GROUP BY entity_id
      HAVING COUNT(DISTINCT json_extract(payload, '$.ticketId')) > 1
         AND COUNT(DISTINCT json_extract(payload, '$.nativeObservation.permissionCallId')) = 1
    ) AND NOT EXISTS (
      SELECT 1 FROM event_log revoked_yet
      WHERE revoked_yet.event_type = 'ApprovalRevoked' AND revoked_yet.entity_id = approval.id
    );
  `,
  17: `
    -- Exactly-once repair, part 2 (TICKET-0025 class): a new valid v2
    -- ceremony must never alias a non-authoritative historical
    -- approval. The old UNIQUE(scope_artifact_id, scope_revision,
    -- action) made revoke-then-create impossible, forcing aliasing of
    -- invalid rows (consumed ticket, stale artifact, no current
    -- authoritative approval). Rebuild the table without that
    -- constraint and enforce at most one ACTIVE row per triple with a
    -- partial unique index instead: superseded rows stay as history,
    -- every reader keeps its revoked = 0 filter, and the finalize
    -- transaction revokes-then-creates atomically.
    CREATE TABLE approval_new (
      id                 TEXT PRIMARY KEY,
      action             TEXT NOT NULL,
      scope_artifact_id  TEXT NOT NULL,
      scope_revision     TEXT NOT NULL,
      authority          TEXT NOT NULL,
      signer             TEXT NOT NULL,
      signature          TEXT NOT NULL,
      rationale           TEXT NOT NULL,
      timestamp           TEXT NOT NULL,
      revoked             INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO approval_new (id, action, scope_artifact_id, scope_revision, authority, signer, signature, rationale, timestamp, revoked)
      SELECT id, action, scope_artifact_id, scope_revision, authority, signer, signature, rationale, timestamp, revoked FROM approval;
    DROP TABLE approval;
    ALTER TABLE approval_new RENAME TO approval;
    -- Triggers are dropped with the old table: recreate verbatim
    -- (migration 3 definitions) so append-only semantics survive.
    CREATE TRIGGER trg_approval_no_delete BEFORE DELETE ON approval
    BEGIN
      SELECT RAISE(ABORT, 'approval rows cannot be deleted: revoke instead');
    END;
    CREATE TRIGGER trg_approval_update_guard BEFORE UPDATE ON approval
    WHEN NOT (
      OLD.revoked = 0 AND NEW.revoked = 1
      AND OLD.id IS NEW.id
      AND OLD.action IS NEW.action
      AND OLD.scope_artifact_id IS NEW.scope_artifact_id
      AND OLD.scope_revision IS NEW.scope_revision
      AND OLD.authority IS NEW.authority
      AND OLD.signer IS NEW.signer
      AND OLD.signature IS NEW.signature
      AND OLD.rationale IS NEW.rationale
      AND OLD.timestamp IS NEW.timestamp
    )
    BEGIN
      SELECT RAISE(ABORT, 'approval rows are immutable except revocation (revoked 0 to 1)');
    END;
    CREATE UNIQUE INDEX idx_approval_active_triple
      ON approval (scope_artifact_id, scope_revision, action) WHERE revoked = 0;
  `,
  18: `
    -- CORE_FIX vertical lifecycle: dispatch authority moves from the
    -- host JSONL ledger into Core-owned SQLite records. Intents,
    -- delegations, claims, bindings, status, expiry, and revocation
    -- are database-enforced (constraints, conditional writes,
    -- triggers) and revalidated by the Core on every use. The JSONL
    -- file is no longer written or read; it was never authoritative.
    CREATE TABLE dispatch (
      id                    TEXT PRIMARY KEY,
      kind                  TEXT NOT NULL,
      module_id             TEXT NOT NULL,
      work_package_id       TEXT,
      module_revision       TEXT NOT NULL,
      work_package_revision TEXT,
      spec_revisions        TEXT NOT NULL,
      role                  TEXT NOT NULL,
      requester_session     TEXT NOT NULL,
      adapter_id            TEXT,
      status                TEXT NOT NULL,
      worker_session        TEXT,
      grant_id              TEXT,
      parent_runtime_session TEXT,
      delegated_agent       TEXT,
      task_call_id          TEXT,
      child_runtime_session TEXT,
      correction_of         TEXT,
      attempt               INTEGER NOT NULL DEFAULT 1,
      policy_profile        TEXT NOT NULL,
      risk_triggers         TEXT NOT NULL,
      rationale             TEXT NOT NULL,
      expires_at            TEXT NOT NULL,
      created_at            TEXT NOT NULL,
      completed_at          TEXT
    );
    CREATE INDEX idx_dispatch_worker ON dispatch(worker_session);
    CREATE INDEX idx_dispatch_scope ON dispatch(module_id, work_package_id);
    CREATE INDEX idx_dispatch_status ON dispatch(status);
    -- Legal lifecycle: PENDING -> ENACTED -> ACTIVE -> COMPLETED, with
    -- REVOKED/EXPIRED exits from any live state. Terminal states are
    -- frozen. Scope, revisions, role, and requester are immutable once
    -- recorded; only the claim/completion bindings may be filled in.
    CREATE TRIGGER dispatch_status_guard BEFORE UPDATE ON dispatch
    WHEN NOT (
      (
        (OLD.status = 'PENDING' AND NEW.status IN ('PENDING', 'ENACTED', 'REVOKED', 'EXPIRED')) OR
        (OLD.status = 'ENACTED' AND NEW.status IN ('ACTIVE', 'REVOKED', 'EXPIRED')) OR
        (OLD.status = 'ACTIVE' AND NEW.status IN ('COMPLETED', 'REVOKED', 'EXPIRED'))
      )
      AND OLD.id IS NEW.id
      AND OLD.kind IS NEW.kind
      AND OLD.module_id IS NEW.module_id
      AND OLD.work_package_id IS NEW.work_package_id
      AND OLD.module_revision IS NEW.module_revision
      AND OLD.work_package_revision IS NEW.work_package_revision
      AND OLD.spec_revisions IS NEW.spec_revisions
      AND OLD.role IS NEW.role
      AND OLD.requester_session IS NEW.requester_session
      AND OLD.adapter_id IS NEW.adapter_id
      AND OLD.correction_of IS NEW.correction_of
      AND OLD.attempt IS NEW.attempt
      AND OLD.policy_profile IS NEW.policy_profile
      AND OLD.risk_triggers IS NEW.risk_triggers
      AND OLD.rationale IS NEW.rationale
      AND OLD.expires_at IS NEW.expires_at
      AND OLD.created_at IS NEW.created_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'dispatch rows mutate only through the legal claim lifecycle with frozen scope bindings');
    END;
    CREATE TRIGGER dispatch_no_delete BEFORE DELETE ON dispatch
    BEGIN
      SELECT RAISE(ABORT, 'dispatch rows cannot be deleted: revoke instead');
    END;
    -- Distinct review dispatch types (CF-5): security review and
    -- independent verification are first-class assignments, never
    -- interchangeable with implementation. One open assignment per
    -- (kind, scope, revision); completion binds reviewer, evidence
    -- or verdict, and independence from the implementer session.
    CREATE TABLE review_assignment (
      id                TEXT PRIMARY KEY,
      kind              TEXT NOT NULL,
      module_id         TEXT NOT NULL,
      work_package_id   TEXT,
      target_revision   TEXT NOT NULL,
      reviewer_role     TEXT NOT NULL,
      reviewer_session  TEXT,
      dispatch_id       TEXT,
      status            TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      completed_at      TEXT
    );
    CREATE UNIQUE INDEX idx_review_open
      ON review_assignment (kind, module_id, COALESCE(work_package_id, ''), target_revision)
      WHERE status = 'ASSIGNED';
    CREATE INDEX idx_review_scope ON review_assignment(module_id, work_package_id);
    CREATE TRIGGER review_status_guard BEFORE UPDATE ON review_assignment
    WHEN NOT (
      (
        (OLD.status = 'ASSIGNED' AND NEW.status IN ('SUBMITTED', 'SUPERSEDED'))
      )
      AND OLD.id IS NEW.id
      AND OLD.kind IS NEW.kind
      AND OLD.module_id IS NEW.module_id
      AND OLD.work_package_id IS NEW.work_package_id
      AND OLD.target_revision IS NEW.target_revision
      AND OLD.reviewer_role IS NEW.reviewer_role
      AND OLD.created_at IS NEW.created_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'review assignments mutate only ASSIGNED -> SUBMITTED/SUPERSEDED with frozen scope');
    END;
    CREATE TRIGGER review_no_delete BEFORE DELETE ON review_assignment
    BEGIN
      SELECT RAISE(ABORT, 'review assignments cannot be deleted');
    END;
    -- Bounded correction loops (CF-6): identity, owner, affected
    -- revision, attempt count, and terminal escalation. One open loop
    -- per defect; attempts advance only through re-verification.
    CREATE TABLE correction_loop (
      id                TEXT PRIMARY KEY,
      defect_id         TEXT NOT NULL,
      module_id         TEXT NOT NULL,
      work_package_id   TEXT,
      affected_revision TEXT NOT NULL,
      owner_role        TEXT NOT NULL,
      attempt           INTEGER NOT NULL,
      max_attempts      INTEGER NOT NULL,
      status            TEXT NOT NULL,
      dispatch_id       TEXT,
      created_at        TEXT NOT NULL,
      closed_at         TEXT
    );
    CREATE INDEX idx_correction_defect ON correction_loop(defect_id);
    CREATE INDEX idx_correction_scope ON correction_loop(module_id, work_package_id);
    CREATE TRIGGER correction_status_guard BEFORE UPDATE ON correction_loop
    WHEN NOT (
      (
        (OLD.status = 'OPEN' AND NEW.status IN ('CORRECTING', 'ESCALATED')) OR
        (OLD.status = 'CORRECTING' AND NEW.status IN ('REVERIFY', 'ESCALATED')) OR
        (OLD.status = 'REVERIFY' AND NEW.status IN ('CORRECTING', 'CLOSED', 'ESCALATED'))
      )
      AND OLD.id IS NEW.id
      AND OLD.defect_id IS NEW.defect_id
      AND OLD.module_id IS NEW.module_id
      AND OLD.work_package_id IS NEW.work_package_id
      AND OLD.affected_revision IS NEW.affected_revision
      AND OLD.owner_role IS NEW.owner_role
      AND OLD.max_attempts IS NEW.max_attempts
      AND OLD.created_at IS NEW.created_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'correction loops mutate only through the bounded OPEN -> CORRECTING -> REVERIFY -> CLOSED/ESCALATED lifecycle');
    END;
    CREATE TRIGGER correction_no_delete BEFORE DELETE ON correction_loop
    BEGIN
      SELECT RAISE(ABORT, 'correction loops cannot be deleted');
    END;
    -- Versioned project rigor policy (CF-11): exactly one row. Profile
    -- changes append PolicyUpdated audit events in the Core; lowering
    -- rigor additionally requires a valid PO signature (Core-enforced,
    -- never trigger-enforced since verification needs cryptography).
    CREATE TABLE project_policy (
      id          TEXT PRIMARY KEY CHECK(id = 'policy'),
      profile     TEXT NOT NULL,
      rationale   TEXT NOT NULL,
      updated_by  TEXT NOT NULL,
      signature   TEXT,
      updated_at  TEXT NOT NULL
    );
    -- Evidence invalidation for correction cycles (CF-6): evidence rows
    -- stay immutable except the stale flag 0 -> 1, mirroring the
    -- approval revocation pattern. Gates read current (stale = 0) rows
    -- only; history is preserved for audit.
    ALTER TABLE evidence ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;
    DROP TRIGGER IF EXISTS trg_evidence_no_update;
    CREATE TRIGGER trg_evidence_no_update BEFORE UPDATE ON evidence
    WHEN NOT (
      OLD.stale = 0 AND NEW.stale = 1
      AND OLD.id IS NEW.id
      AND OLD.producer IS NEW.producer
      AND OLD.tool IS NEW.tool
      AND OLD.timestamp IS NEW.timestamp
      AND OLD.target_revision IS NEW.target_revision
      AND OLD.check_name IS NEW.check_name
      AND OLD.result IS NEW.result
      AND OLD.diagnostics IS NEW.diagnostics
      AND OLD.integrity_hash IS NEW.integrity_hash
    )
    BEGIN
      SELECT RAISE(ABORT, 'evidence is immutable except invalidation (stale 0 to 1)');
    END;
  `,
  19: `
    -- Canonical recovery envelopes (CF-8): every structured registry
    -- row (SP/MOD/WP) carries a second copy of its exact canonical
    -- structured content under planning.envelope.<id>. Recovery never
    -- synthesizes semantics: it restores the envelope bytes verbatim
    -- only when the recomputed candidate proves byte-equivalence
    -- against them, and otherwise requires formal supersession.
    -- Backfill from current revision content for pre-envelope rows.
    INSERT OR REPLACE INTO runtime_config (key, value, updated_at)
    SELECT 'planning.envelope.' || a.id, r.content, datetime('now')
    FROM artifact a JOIN artifact_revision r ON r.id = a.id AND r.revision = a.revision
    WHERE a.type IN ('SP', 'MOD', 'WP') AND a.deleted = 0
      AND NOT EXISTS (SELECT 1 FROM runtime_config WHERE key = 'planning.envelope.' || a.id);
  `,
  20: `
    -- Review reconciliation (CF-12): premature assignments committed
    -- before reviewability gating (e.g. reviews assigned to scopes
    -- that could never enter verification) are preserved append-only
    -- as INVALID history instead of being deleted or completed. The
    -- no-delete trigger is unchanged; the status guard gains the
    -- terminal ASSIGNED -> INVALID move with frozen scope.
    DROP TRIGGER review_status_guard;
    CREATE TRIGGER review_status_guard BEFORE UPDATE ON review_assignment
    WHEN NOT (
      (
        (OLD.status = 'ASSIGNED' AND NEW.status IN ('SUBMITTED', 'SUPERSEDED', 'INVALID'))
      )
      AND OLD.id IS NEW.id
      AND OLD.kind IS NEW.kind
      AND OLD.module_id IS NEW.module_id
      AND OLD.work_package_id IS NEW.work_package_id
      AND OLD.target_revision IS NEW.target_revision
      AND OLD.reviewer_role IS NEW.reviewer_role
      AND OLD.created_at IS NEW.created_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'review assignments mutate only ASSIGNED -> SUBMITTED/SUPERSEDED/INVALID with frozen scope');
    END;
  `,
};
