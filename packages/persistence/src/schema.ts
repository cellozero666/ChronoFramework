/**
 * SQLite schema definitions matching docs/core/CORE-SPECIFICATION.md §5
 * Schema is versioned via a migrations table.
 * [CORE §5, P3.9, FW §671]
 */

export const SCHEMA_VERSION = 1;

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
};
