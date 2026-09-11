/**
 * SQLite repository implementations.
 * [CORE §5, CORE §12, CORE §8]
 *
 * These implement the repository interfaces the Core uses for persistence.
 * They do NOT contain domain logic — only CRUD and query operations.
 */

import type { Database } from "better-sqlite3";
import { ChronoError, ErrorCode, Severity } from "@chrono/domain";

/**
 * Project record from the database.
 */
export interface ProjectRecord {
  id: string;
  language: string;
  gasparAutonomy: string;
  runtime: string | null;
  createdAt: string;
  updatedAt: string;
  state: string;
  systemAnalysisComplete: boolean;
  architectureId: string | null;
  architectureRevision: string | null;
  architectureState: string | null;
  specCount: number;
  moduleCount: number;
}

/**
 * Artifact record from the database (current revision pointer).
 */
export interface ArtifactRecord {
  id: string;
  type: string;
  revision: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  contentHash: string;
}

/**
 * Immutable artifact revision history row [DOM §2.3, P3.5].
 * Every revision ever persisted; resolving `<ID>@<revision>` reads here.
 */
export interface ArtifactRevisionRecord {
  id: string;
  revision: string;
  type: string;
  status: string;
  contentHash: string;
  content: string;
  createdAt: string;
}

/**
 * Approval record.
 */
export interface ApprovalRecord {
  id: string;
  action: string;
  scopeArtifactId: string;
  scopeRevision: string;
  authority: string;
  signer: string;
  signature: string;
  rationale: string;
  timestamp: string;
  revoked: boolean;
}

/**
 * Blocker record.
 */
export interface BlockerRecord {
  id: string;
  type: string;
  issuer: string;
  targetIds: string[];
  reason: string;
  evidenceRefs: string[];
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolved: boolean;
  priorState: string | null;
}

/**
 * Waiver record [DOM §3.24, CORE §8.3].
 */
export interface WaiverRecord {
  id: string;
  issue: string;
  scopeArtifactId: string;
  scopeRevision: string;
  rationale: string;
  evidenceRef: string | null;
  acceptingAuthority: string;
  compensatingControls: string | null;
  followUpTaskId: string | null;
  expiryReviewCondition: string;
  timestamp: string;
  status: string;
  signature: string;
}

/**
 * Defect record [DOM §3.18, FW §8].
 */
export interface DefectRecord {
  id: string;
  classification: string;
  severity: string;
  evidenceRefs: string[];
  affectedCriteria: string[];
  affectedArtifacts: string[];
  owner: string;
  blockingScope: string | null;
  reproInfo: string | null;
  createdAt: string;
  resolvedAt: string | null;
  status: string;
}

/**
 * QA report record [DOM §3.20].
 */
export interface QaReportRecord {
  id: string;
  moduleId: string | null;
  workPackageId: string | null;
  verdict: string;
  reviewedEvidence: string[];
  defectIds: string[];
  waiverIds: string[];
  reviewer: string;
  timestamp: string;
  moduleRevision: string | null;
  workPackageRevision: string | null;
}

/**
 * Evidence record.
 */
export interface EvidenceRecord {
  id: string;
  producer: string;
  tool: string | null;
  timestamp: string;
  targetRevision: string;
  checkName: string;
  result: string;
  diagnostics: string | null;
  integrityHash: string;
}

/**
 * Event log record.
 */
export interface EventRecord {
  seq: number;
  eventType: string;
  entityId: string;
  payload: string;
  actor: string;
  timestamp: string;
  priorState: string | null;
  newState: string | null;
  reasoning: string | null;
}

/**
 * SQLite row types — typed for indexed column access under
 * `noPropertyAccessFromIndexSignature`.
 */
interface ProjectRow {
  id: unknown;
  language: unknown;
  gaspar_autonomy: unknown;
  runtime: unknown;
  created_at: unknown;
  updated_at: unknown;
  state: unknown;
  system_analysis_complete: unknown;
  architecture_id: unknown;
  architecture_revision: unknown;
  architecture_state: unknown;
  spec_count: unknown;
  module_count: unknown;
}

interface ArtifactRow {
  id: unknown;
  type: unknown;
  revision: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
  deleted: unknown;
  content_hash: unknown;
}

interface ArtifactRevisionRow {
  id: unknown;
  revision: unknown;
  type: unknown;
  status: unknown;
  content_hash: unknown;
  content: unknown;
  created_at: unknown;
}

interface EventRow {
  seq: unknown;
  event_type: unknown;
  entity_id: unknown;
  payload: unknown;
  actor: unknown;
  timestamp: unknown;
  prior_state: unknown;
  new_state: unknown;
  reasoning: unknown;
}

interface ApprovalRow {
  id: unknown;
  action: unknown;
  scope_artifact_id: unknown;
  scope_revision: unknown;
  authority: unknown;
  signer: unknown;
  signature: unknown;
  rationale: unknown;
  timestamp: unknown;
  revoked: unknown;
}

interface BlockerRow {
  id: unknown;
  type: unknown;
  issuer: unknown;
  target_ids: unknown;
  reason: unknown;
  evidence_refs: unknown;
  created_at: unknown;
  resolved_at: unknown;
  resolved_by: unknown;
  resolved: unknown;
  prior_state: unknown;
}

interface WaiverRow {
  id: unknown;
  issue: unknown;
  scope_artifact_id: unknown;
  scope_revision: unknown;
  rationale: unknown;
  evidence_ref: unknown;
  accepting_authority: unknown;
  compensating_controls: unknown;
  follow_up_task_id: unknown;
  expiry_review_condition: unknown;
  timestamp: unknown;
  status: unknown;
  signature: unknown;
}

interface DefectRow {
  id: unknown;
  classification: unknown;
  severity: unknown;
  evidence_refs: unknown;
  affected_criteria: unknown;
  affected_artifacts: unknown;
  owner: unknown;
  blocking_scope: unknown;
  repro_info: unknown;
  created_at: unknown;
  resolved_at: unknown;
  status: unknown;
}

interface QaReportRow {
  id: unknown;
  module_id: unknown;
  work_package_id: unknown;
  verdict: unknown;
  reviewed_evidence: unknown;
  defect_ids: unknown;
  waiver_ids: unknown;
  reviewer: unknown;
  timestamp: unknown;
  module_revision: unknown;
  work_package_revision: unknown;
}

interface HarnessRow {
  spec_revision: unknown;
  content_hash: unknown;
  generated_at: unknown;
  stale: unknown;
  content: unknown;
}

/**
 * Repository for the authoritative Spec Harness index [P6.1, CORE §7].
 * One row per executable Spec revision; role views derive from it.
 * Rows are immutable except the material-change stale flag.
 */
export interface HarnessRecord {
  specRevision: string;
  contentHash: string;
  generatedAt: string;
  stale: boolean;
  content: string;
}

export class HarnessRepository {
  constructor(private readonly db: Database) {}

  create(harness: {
    specRevision: string;
    contentHash: string;
    content: string;
    generatedAt: string;
  }): HarnessRecord {
    try {
      this.db.prepare(
        `INSERT INTO harness (spec_revision, content_hash, generated_at, stale, content)
         VALUES (?, ?, ?, 0, ?)`
      ).run(harness.specRevision, harness.contentHash, harness.generatedAt, harness.content);
    } catch (e) {
      if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        throw new ChronoError({
          code: ErrorCode.DUPLICATE_IDENTITY,
          severity: Severity.ERROR,
          message: `Harness for revision ${harness.specRevision} already exists`,
          invariantRef: "INV §10.1",
          affectedTarget: harness.specRevision,
          suggestedAction: "Mark the existing Harness stale when its inputs change materially",
        });
      }
      throw e;
    }

    return this.findBySpecRevision(harness.specRevision);
  }

  findBySpecRevision(specRevision: string): HarnessRecord {
    const row = this.db
      .prepare("SELECT * FROM harness WHERE spec_revision = ?")
      .get(specRevision) as HarnessRow | undefined;

    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `No Harness recorded for revision ${specRevision}`,
        invariantRef: "INV §14.4",
        affectedTarget: specRevision,
        suggestedAction: "Generate the authoritative Harness for this Spec revision first",
      });
    }

    return {
      specRevision: row.spec_revision as string,
      contentHash: row.content_hash as string,
      generatedAt: row.generated_at as string,
      stale: Boolean(row.stale),
      content: row.content as string,
    };
  }

  markStale(specRevision: string): void {
    this.db.prepare("UPDATE harness SET stale = 1 WHERE spec_revision = ?").run(specRevision);
  }

  /** Every recorded Harness (for cardinality audits). */
  listAll(): HarnessRecord[] {
    const rows = this.db.prepare("SELECT * FROM harness").all() as HarnessRow[];

    return rows.map((r) => ({
      specRevision: r.spec_revision as string,
      contentHash: r.content_hash as string,
      generatedAt: r.generated_at as string,
      stale: Boolean(r.stale),
      content: r.content as string,
    }));
  }
}

interface EvidenceRow {
  id: unknown;
  producer: unknown;
  tool: unknown;
  timestamp: unknown;
  target_revision: unknown;
  check_name: unknown;
  result: unknown;
  diagnostics: unknown;
  integrity_hash: unknown;
}

/**
 * Repository for project-level state.
 */
export class ProjectRepository {
  constructor(private readonly db: Database) {}

  create(
    projectId: string,
    language: string,
    gasparAutonomy: string,
    runtime: string | null
  ): ProjectRecord {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO project (id, language, gaspar_autonomy, runtime, created_at, updated_at, state,
         system_analysis_complete, architecture_id, architecture_revision, architecture_state,
         spec_count, module_count)
       VALUES (?, ?, ?, ?, ?, ?, 'UNINITIALIZED', 0, NULL, NULL, NULL, 0, 0)`
    ).run(projectId, language, gasparAutonomy, runtime, now, now);

    return this.findById(projectId);
  }

  findById(projectId: string): ProjectRecord {
    const row = this.db
      .prepare("SELECT * FROM project WHERE id = ?")
      .get(projectId) as ProjectRow | undefined;

    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `Project ${projectId} not found`,
        invariantRef: "DOM §3.1",
        affectedTarget: projectId,
        suggestedAction: "Run chrono init to create a project first",
      });
    }

    return this.mapProjectRow(row);
  }

  updateState(projectId: string, state: string): ProjectRecord {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE project SET state = ?, updated_at = ? WHERE id = ?`
    ).run(state, now, projectId);

    return this.findById(projectId);
  }

  updateCounts(projectId: string, specCount: number, moduleCount: number): void {
    this.db.prepare(
      `UPDATE project SET spec_count = ?, module_count = ?, updated_at = ? WHERE id = ?`
    ).run(specCount, moduleCount, new Date().toISOString(), projectId);
  }

  markSystemAnalysisComplete(projectId: string): ProjectRecord {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE project SET system_analysis_complete = 1, state = 'ANALYZING', updated_at = ? WHERE id = ?`
    ).run(now, projectId);

    return this.findById(projectId);
  }

  setArchitecture(projectId: string, archId: string | null, revision: string | null, state: string | null): void {
    this.db.prepare(
      `UPDATE project SET architecture_id = ?, architecture_revision = ?, architecture_state = ?, updated_at = ? WHERE id = ?`
    ).run(archId, revision, state, new Date().toISOString(), projectId);
  }

  private mapProjectRow(row: ProjectRow): ProjectRecord {
    return {
      id: row.id as string,
      language: row.language as string,
      gasparAutonomy: row.gaspar_autonomy as string,
      runtime: row.runtime as string | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      state: row.state as string,
      systemAnalysisComplete: Boolean(row.system_analysis_complete),
      architectureId: row.architecture_id as string | null,
      architectureRevision: row.architecture_revision as string | null,
      architectureState: row.architecture_state as string | null,
      specCount: row.spec_count as number,
      moduleCount: row.module_count as number,
    };
  }
}

/**
 * Repository for artifacts.
 */
export class ArtifactRepository {
  constructor(private readonly db: Database) {}

  create(
    id: string,
    type: string,
    revision: string,
    status: string,
    contentHash: string,
    content: string
  ): ArtifactRecord {
    const now = new Date().toISOString();
    try {
      const tx = this.db.transaction(() => {
        this.db.prepare(
          `INSERT INTO artifact (id, type, revision, status, created_at, updated_at, deleted, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
        ).run(id, type, revision, status, now, now, contentHash);
        this.db.prepare(
          `INSERT INTO artifact_revision (id, revision, type, status, content_hash, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(id, revision, type, status, contentHash, content, now);
      });
      tx();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new ChronoError({
          code: ErrorCode.DUPLICATE_IDENTITY,
          severity: Severity.ERROR,
          message: `Artifact ${id} already exists`,
          invariantRef: "INV §10.1",
          affectedTarget: id,
          suggestedAction: "Use a different identifier or reference the existing artifact",
        });
      }
      throw e;
    }

    return this.findById(id);
  }

  findById(id: string): ArtifactRecord {
    const row = this.db
      .prepare("SELECT * FROM artifact WHERE id = ? AND deleted = 0")
      .get(id) as ArtifactRow | undefined;

    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `Artifact ${id} not found`,
        invariantRef: "INV §10.2",
        affectedTarget: id,
        suggestedAction: "Check the artifact ID and try again",
      });
    }

    return this.mapArtifactRow(row);
  }

  /**
   * Resolve an exact historical revision from immutable history.
   * Unknown id → ENTITY_NOT_FOUND; known id with unknown revision →
   * STALE_REVISION [CORE §12, DOM §2.4, INV §10.2/10.3].
   */
  findByRevision(id: string, revision: string): ArtifactRevisionRecord {
    const row = this.db
      .prepare("SELECT * FROM artifact_revision WHERE id = ? AND revision = ?")
      .get(id, revision) as ArtifactRevisionRow | undefined;

    if (row === undefined) {
      const known = this.db
        .prepare("SELECT 1 AS one FROM artifact_revision WHERE id = ? LIMIT 1")
        .get(id) as { one: number } | undefined;
      if (known === undefined) {
        throw new ChronoError({
          code: ErrorCode.ENTITY_NOT_FOUND,
          severity: Severity.ERROR,
          message: `Artifact ${id} not found`,
          invariantRef: "INV §10.2",
          affectedTarget: id,
          suggestedAction: "Check the artifact ID and try again",
        });
      }
      throw new ChronoError({
        code: ErrorCode.STALE_REVISION,
        severity: Severity.ERROR,
        message: `Artifact ${id}@${revision} is not a recorded revision`,
        invariantRef: "INV §10.3",
        affectedTarget: `${id}@${revision}`,
        suggestedAction: "Resolve to the current revision of this artifact",
      });
    }

    return this.mapArtifactRevisionRow(row);
  }

  /** Resolve a reference to an exact revision [CORE §12, DOM §2.4] */
  resolveReference(refId: string, targetRevision?: string): ArtifactRecord | ArtifactRevisionRecord {
    if (targetRevision !== undefined) {
      return this.findByRevision(refId, targetRevision);
    }
    return this.findById(refId);
  }

  /**
   * Record a status-transition link in immutable history WITHOUT advancing
   * the artifact's contract revision. Only a material content change
   * produces a new revision [DOM §2.3]; status transitions are audit
   * events that must not invalidate revision-bound approvals, Harnesses,
   * or evidence.
   */
  appendTransitionRecord(
    id: string,
    linkRevision: string,
    newStatus: string,
    contentHash: string,
    content: string
  ): void {
    const now = new Date().toISOString();
    const current = this.findById(id);
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO artifact_revision (id, revision, type, status, content_hash, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, linkRevision, current.type, newStatus, contentHash, content, now);
      this.db.prepare(
        `UPDATE artifact SET status = ?, updated_at = ? WHERE id = ? AND deleted = 0`
      ).run(newStatus, now, id);
    });
    tx();
  }

  /** List every recorded revision of an artifact, oldest first. */
  getHistory(id: string): ArtifactRevisionRecord[] {
    // Insertion order (rowid), never wall-clock: operations within the
    // same millisecond must not reorder history.
    const rows = this.db
      .prepare("SELECT * FROM artifact_revision WHERE id = ? ORDER BY rowid")
      .all(id) as ArtifactRevisionRow[];

    if (rows.length === 0) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `Artifact ${id} not found`,
        invariantRef: "INV §10.2",
        affectedTarget: id,
        suggestedAction: "Check the artifact ID and try again",
      });
    }

    return rows.map((r) => this.mapArtifactRevisionRow(r));
  }

  /** Read the canonical content stored for an exact revision. */
  getContent(id: string, revision: string): string {
    return this.findByRevision(id, revision).content;
  }

  /** Mark deleted (tombstone) — preserves references [DOM §2.4] */
  softDelete(id: string): void {
    this.db.prepare("UPDATE artifact SET deleted = 1 WHERE id = ?").run(id);
  }

  listByType(type: string): ArtifactRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM artifact WHERE type = ? AND deleted = 0")
      .all(type) as ArtifactRow[];

    return rows.map((r) => this.mapArtifactRow(r));
  }

  /** Every artifact row including tombstones (for identity audits). */
  listAll(): ArtifactRecord[] {
    const rows = this.db.prepare("SELECT * FROM artifact").all() as ArtifactRow[];

    return rows.map((r) => this.mapArtifactRow(r));
  }

  private mapArtifactRevisionRow(row: ArtifactRevisionRow): ArtifactRevisionRecord {
    return {
      id: row.id as string,
      revision: row.revision as string,
      type: row.type as string,
      status: row.status as string,
      contentHash: row.content_hash as string,
      content: row.content as string,
      createdAt: row.created_at as string,
    };
  }

  private mapArtifactRow(row: ArtifactRow): ArtifactRecord {
    return {
      id: row.id as string,
      type: row.type as string,
      revision: row.revision as string,
      status: row.status as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      deleted: Boolean(row.deleted),
      contentHash: row.content_hash as string,
    };
  }
}

/**
 * Collision-safe identifier sequences [CORE §3.1, Remediation §4].
 *
 * One monotonic counter per identity family. Allocation is a single atomic
 * UPSERT ... RETURNING statement, so concurrent writers on the same file
 * never receive the same sequence. Identifiers are formatted as
 * `<FAMILY>-<zero-padded seq>` (e.g. BLK-0001).
 */
export class SequenceRepository {
  constructor(private readonly db: Database) {}

  /** Atomically allocate the next sequence for a family. */
  next(family: string): number {
    const row = this.db
      .prepare(
        `INSERT INTO id_sequence (family, next) VALUES (?, 1)
         ON CONFLICT (family) DO UPDATE SET next = next + 1
         RETURNING next`
      )
      .get(family) as { next: number } | undefined;

    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: `Identifier sequence allocation failed for family ${family}`,
        invariantRef: "INV §10.1",
        affectedTarget: family,
        suggestedAction: "Verify the id_sequence table exists (migration 2)",
      });
    }

    return row.next;
  }

  /** Allocate a formatted Core identifier such as BLK-0007. */
  allocate(family: string): string {
    const seq = this.next(family);
    return `${family}-${String(seq).padStart(4, "0")}`;
  }
}

/**
 * Repository for the append-only event log [CORE §15, DOM §5.2]
 */
export class EventLogRepository {
  constructor(private readonly db: Database) {}

  append(event: {
    eventType: string;
    entityId: string;
    payload: unknown;
    actor: string;
    priorState?: string | undefined;
    newState?: string | undefined;
    reasoning?: string | undefined;
  }): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `INSERT INTO event_log (event_type, entity_id, payload, actor, timestamp, prior_state, new_state, reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.eventType,
      event.entityId,
      JSON.stringify(event.payload),
      event.actor,
      now,
      event.priorState ?? null,
      event.newState ?? null,
      event.reasoning ?? null
    );

    return result.lastInsertRowid as number;
  }

  listByEntity(entityId: string): EventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM event_log WHERE entity_id = ? ORDER BY seq")
      .all(entityId) as EventRow[];

    return rows.map(this.mapEventRow);
  }

  listAll(): EventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM event_log ORDER BY seq")
      .all() as EventRow[];

    return rows.map(this.mapEventRow);
  }

  private mapEventRow(row: EventRow): EventRecord {
    return {
      seq: row.seq as number,
      eventType: row.event_type as string,
      entityId: row.entity_id as string,
      payload: row.payload as string,
      actor: row.actor as string,
      timestamp: row.timestamp as string,
      priorState: row.prior_state as string | null,
      newState: row.new_state as string | null,
      reasoning: row.reasoning as string | null,
    };
  }
}

/**
 * Repository for approvals [CORE §8, DOM §3.16, INV §4]
 */
export class ApprovalRepository {
  constructor(private readonly db: Database) {}

  create(approval: {
    id: string;
    action: string;
    scopeArtifactId: string;
    scopeRevision: string;
    authority: string;
    signer: string;
    signature: string;
    rationale: string;
    timestamp: string;
  }): void {
    this.db.prepare(
      `INSERT INTO approval (id, action, scope_artifact_id, scope_revision, authority, signer,
         signature, rationale, timestamp, revoked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      approval.id, approval.action, approval.scopeArtifactId, approval.scopeRevision,
      approval.authority, approval.signer, approval.signature, approval.rationale,
      approval.timestamp
    );
  }

  /** Find a non-revoked approval bound to an exact artifact revision [DOM §3.16] */
  findByScope(artifactId: string, revision: string, action: string): ApprovalRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM approval
         WHERE scope_artifact_id = ? AND scope_revision = ? AND action = ? AND revoked = 0`
      )
      .get(artifactId, revision, action) as ApprovalRow | undefined;

    return row === undefined ? null : this.mapApprovalRow(row);
  }

  /** Check if any approval exists for an artifact revision (any action) */
  existsForRevision(artifactId: string, revision: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM approval WHERE scope_artifact_id = ? AND scope_revision = ? AND revoked = 0 LIMIT 1`
      )
      .get(artifactId, revision) as { "1": number } | undefined;

    return row !== undefined;
  }

  /** Every approval row including revoked ones (for binding audits). */
  listAll(): ApprovalRecord[] {
    const rows = this.db.prepare("SELECT * FROM approval").all() as ApprovalRow[];

    return rows.map((r) => this.mapApprovalRow(r));
  }

  /** Revoke an approval (append-only — mark revoked, don't delete) */
  revoke(id: string): void {
    this.db.prepare("UPDATE approval SET revoked = 1 WHERE id = ?").run(id);
  }

  private mapApprovalRow(row: ApprovalRow): ApprovalRecord {
    return {
      id: row.id as string,
      action: row.action as string,
      scopeArtifactId: row.scope_artifact_id as string,
      scopeRevision: row.scope_revision as string,
      authority: row.authority as string,
      signer: row.signer as string,
      signature: row.signature as string,
      rationale: row.rationale as string,
      timestamp: row.timestamp as string,
      revoked: Boolean(row.revoked),
    };
  }
}

/**
 * Repository for blockers [CORE §5, DOM §3.17, INV §4]
 */
export class BlockerRepository {
  constructor(private readonly db: Database) {}

  create(blocker: {
    id: string;
    type: string;
    issuer: string;
    targetIds: string[];
    reason: string;
    evidenceRefs: string[];
    priorState?: string | null;
  }): BlockerRecord {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO blocker (id, type, issuer, target_ids, reason, evidence_refs,
         created_at, resolved_at, resolved_by, resolved, prior_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?)`
    ).run(
      blocker.id, blocker.type, blocker.issuer,
      JSON.stringify(blocker.targetIds), blocker.reason,
      JSON.stringify(blocker.evidenceRefs), now,
      blocker.priorState ?? null
    );

    return this.findById(blocker.id);
  }

  findById(id: string): BlockerRecord {
    const row = this.db
      .prepare("SELECT * FROM blocker WHERE id = ?")
      .get(id) as BlockerRow | undefined;

    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `Blocker ${id} not found`,
        invariantRef: "DOM §3.17",
        affectedTarget: id,
      });
    }

    return this.mapBlockerRow(row);
  }

  /** List all active blockers, optionally filtered by target [P7.3] */
  findActive(targetIds?: string[]): BlockerRecord[] {
    let query: string;
    let params: unknown[];

    if (targetIds !== undefined && targetIds.length > 0) {
      // Use JSON_CONTAINS for target_ids array matching
      query = `
        SELECT * FROM blocker WHERE resolved = 0 AND (
          ${targetIds.map(() => `target_ids LIKE '%"' || ? || '"%'`).join(" OR ")}
        )
      `;
      params = targetIds;
    } else {
      query = "SELECT * FROM blocker WHERE resolved = 0";
      params = [];
    }

    const rows = this.db.prepare(query).all(...params) as BlockerRow[];
    return rows.map((r) => this.mapBlockerRow(r));
  }

  /** Count active blockers — used for projection [STATE §2] */
  hasActiveBlockers(targetIds?: string[]): boolean {
    return this.findActive(targetIds).length > 0;
  }

  /** Every blocker row including resolved ones (for audits). */
  listAll(): BlockerRecord[] {
    const rows = this.db.prepare("SELECT * FROM blocker").all() as BlockerRow[];

    return rows.map((r) => this.mapBlockerRow(r));
  }

  resolve(id: string, resolvedBy: string): BlockerRecord {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE blocker SET resolved = 1, resolved_at = ?, resolved_by = ? WHERE id = ?`
    ).run(now, resolvedBy, id);

    return this.findById(id);
  }

  /** Record the pre-BLOCKED status for validated re-entry [STATE §2.2]. */
  setPriorState(id: string, priorState: string): BlockerRecord {
    this.db.prepare("UPDATE blocker SET prior_state = ? WHERE id = ?").run(priorState, id);
    return this.findById(id);
  }

  private mapBlockerRow(row: BlockerRow): BlockerRecord {
    return {
      id: row.id as string,
      type: row.type as string,
      issuer: row.issuer as string,
      targetIds: JSON.parse(row.target_ids as string),
      reason: row.reason as string,
      evidenceRefs: JSON.parse(row.evidence_refs as string),
      createdAt: row.created_at as string,
      resolvedAt: row.resolved_at as string | null,
      resolvedBy: row.resolved_by as string | null,
      resolved: Boolean(row.resolved),
      priorState: row.prior_state as string | null,
    };
  }
}

/**
 * Repository for evidence [CORE §9, DOM §3.19, INV §11]
 */
export class EvidenceRepository {
  constructor(private readonly db: Database) {}

  create(evidence: {
    id: string;
    producer: string;
    tool: string | null;
    timestamp: string;
    targetRevision: string;
    checkName: string;
    result: string;
    diagnostics: string | null;
    integrityHash: string;
  }): void {
    this.db.prepare(
      `INSERT INTO evidence (id, producer, tool, timestamp, target_revision, check_name,
         result, diagnostics, integrity_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      evidence.id, evidence.producer, evidence.tool, evidence.timestamp,
      evidence.targetRevision, evidence.checkName, evidence.result,
      evidence.diagnostics, evidence.integrityHash
    );
  }

  /** Find evidence for a specific target revision [P9.2, INV §11.1] */
  findByTargetRevision(revision: string): EvidenceRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM evidence WHERE target_revision = ? ORDER BY timestamp DESC")
      .all(revision) as EvidenceRow[];

    return rows.map((r) => this.mapEvidenceRow(r));
  }

  /** Check if current evidence exists for a revision [P9.3] */
  hasCurrentEvidence(revision: string): boolean {
    return this.findByTargetRevision(revision).length > 0;
  }

  findById(id: string): EvidenceRecord {
    const row = this.db
      .prepare("SELECT * FROM evidence WHERE id = ?")
      .get(id) as EvidenceRow | undefined;

    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `Evidence ${id} not found`,
        invariantRef: "DOM §3.19",
        affectedTarget: id,
      });
    }

    return this.mapEvidenceRow(row);
  }

  listAll(): EvidenceRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM evidence ORDER BY timestamp")
      .all() as EvidenceRow[];

    return rows.map((r) => this.mapEvidenceRow(r));
  }

  private mapEvidenceRow(row: EvidenceRow): EvidenceRecord {
    return {
      id: row.id as string,
      producer: row.producer as string,
      tool: row.tool as string | null,
      timestamp: row.timestamp as string,
      targetRevision: row.target_revision as string,
      checkName: row.check_name as string,
      result: row.result as string,
      diagnostics: row.diagnostics as string | null,
      integrityHash: row.integrity_hash as string,
    };
  }
}

/**
 * Repository for waivers [CORE §8.3, DOM §3.24, INV §4].
 * Rows are immutable except the status lifecycle active → expired |
 * invalidated (enforced by trigger); expiry is a guarded state change,
 * never a rewrite.
 */
export class WaiverRepository {
  constructor(private readonly db: Database) {}

  create(waiver: {
    id: string;
    issue: string;
    scopeArtifactId: string;
    scopeRevision: string;
    rationale: string;
    evidenceRef: string | null;
    acceptingAuthority: string;
    compensatingControls: string | null;
    followUpTaskId: string | null;
    expiryReviewCondition: string;
    timestamp: string;
    signature: string;
  }): WaiverRecord {
    this.db.prepare(
      `INSERT INTO waiver (id, issue, scope_artifact_id, scope_revision, rationale,
         evidence_ref, accepting_authority, compensating_controls, follow_up_task_id,
         expiry_review_condition, timestamp, status, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    ).run(
      waiver.id, waiver.issue, waiver.scopeArtifactId, waiver.scopeRevision,
      waiver.rationale, waiver.evidenceRef, waiver.acceptingAuthority,
      waiver.compensatingControls, waiver.followUpTaskId,
      waiver.expiryReviewCondition, waiver.timestamp, waiver.signature
    );

    return this.findById(waiver.id);
  }

  findById(id: string): WaiverRecord {
    const row = this.db
      .prepare("SELECT * FROM waiver WHERE id = ?")
      .get(id) as WaiverRow | undefined;

    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `Waiver ${id} not found`,
        invariantRef: "DOM §3.24",
        affectedTarget: id,
      });
    }

    return this.mapWaiverRow(row);
  }

  /** Active waivers covering an artifact revision (any scope match). */
  findActiveForScope(artifactId: string, revision: string): WaiverRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM waiver
         WHERE scope_artifact_id = ? AND scope_revision = ? AND status = 'active'`
      )
      .all(artifactId, revision) as WaiverRow[];

    return rows.map((r) => this.mapWaiverRow(r));
  }

  /** Every waiver row (for gate audits). */
  listAll(): WaiverRecord[] {
    const rows = this.db.prepare("SELECT * FROM waiver").all() as WaiverRow[];

    return rows.map((r) => this.mapWaiverRow(r));
  }

  /** Guarded lifecycle step active → expired | invalidated (trigger-checked). */
  setStatus(id: string, status: "expired" | "invalidated"): WaiverRecord {
    this.db.prepare("UPDATE waiver SET status = ? WHERE id = ?").run(status, id);
    return this.findById(id);
  }

  private mapWaiverRow(row: WaiverRow): WaiverRecord {
    return {
      id: row.id as string,
      issue: row.issue as string,
      scopeArtifactId: row.scope_artifact_id as string,
      scopeRevision: row.scope_revision as string,
      rationale: row.rationale as string,
      evidenceRef: row.evidence_ref as string | null,
      acceptingAuthority: row.accepting_authority as string,
      compensatingControls: row.compensating_controls as string | null,
      followUpTaskId: row.follow_up_task_id as string | null,
      expiryReviewCondition: row.expiry_review_condition as string,
      timestamp: row.timestamp as string,
      status: row.status as string,
      signature: row.signature as string,
    };
  }
}

/**
 * Repository for defects [DOM §3.18, FW §8, P9.5].
 */
export class DefectRepository {
  constructor(private readonly db: Database) {}

  create(defect: {
    id: string;
    classification: string;
    severity: string;
    evidenceRefs: string[];
    affectedCriteria: string[];
    affectedArtifacts: string[];
    owner: string;
    blockingScope: string | null;
    reproInfo: string | null;
  }): DefectRecord {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO defect (id, classification, severity, evidence_refs, affected_criteria,
         affected_artifacts, owner, blocking_scope, repro_info, created_at, resolved_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'open')`
    ).run(
      defect.id, defect.classification, defect.severity,
      JSON.stringify(defect.evidenceRefs), JSON.stringify(defect.affectedCriteria),
      JSON.stringify(defect.affectedArtifacts), defect.owner,
      defect.blockingScope, defect.reproInfo, now
    );

    return this.findById(defect.id);
  }

  findById(id: string): DefectRecord {
    const row = this.db
      .prepare("SELECT * FROM defect WHERE id = ?")
      .get(id) as DefectRow | undefined;

    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `Defect ${id} not found`,
        invariantRef: "DOM §3.18",
        affectedTarget: id,
      });
    }

    return this.mapDefectRow(row);
  }

  listByStatus(status: string): DefectRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM defect WHERE status = ? ORDER BY created_at")
      .all(status) as DefectRow[];

    return rows.map((r) => this.mapDefectRow(r));
  }

  /** Every defect row (for gate audits). */
  listAll(): DefectRecord[] {
    const rows = this.db.prepare("SELECT * FROM defect ORDER BY created_at").all() as DefectRow[];

    return rows.map((r) => this.mapDefectRow(r));
  }

  setStatus(id: string, status: string, resolved: boolean): DefectRecord {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE defect SET status = ?, resolved_at = ? WHERE id = ?`
    ).run(status, resolved ? now : null, id);

    return this.findById(id);
  }

  private mapDefectRow(row: DefectRow): DefectRecord {
    return {
      id: row.id as string,
      classification: row.classification as string,
      severity: row.severity as string,
      evidenceRefs: JSON.parse(row.evidence_refs as string),
      affectedCriteria: JSON.parse(row.affected_criteria as string),
      affectedArtifacts: JSON.parse(row.affected_artifacts as string),
      owner: row.owner as string,
      blockingScope: row.blocking_scope as string | null,
      reproInfo: row.repro_info as string | null,
      createdAt: row.created_at as string,
      resolvedAt: row.resolved_at as string | null,
      status: row.status as string,
    };
  }
}

/**
 * Repository for QA reports [DOM §3.20].
 * Reports are immutable once recorded; a new verification writes a new row.
 */
export class QaRepository {
  constructor(private readonly db: Database) {}

  create(report: {
    id: string;
    moduleId: string | null;
    workPackageId: string | null;
    verdict: string;
    reviewedEvidence: string[];
    defectIds: string[];
    waiverIds: string[];
    reviewer: string;
    timestamp: string;
    moduleRevision: string | null;
    workPackageRevision: string | null;
  }): QaReportRecord {
    this.db.prepare(
      `INSERT INTO qa_report (id, module_id, work_package_id, verdict, reviewed_evidence,
         defect_ids, waiver_ids, reviewer, timestamp, module_revision, work_package_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      report.id, report.moduleId, report.workPackageId, report.verdict,
      JSON.stringify(report.reviewedEvidence), JSON.stringify(report.defectIds),
      JSON.stringify(report.waiverIds), report.reviewer, report.timestamp,
      report.moduleRevision, report.workPackageRevision
    );

    return this.findById(report.id);
  }

  findById(id: string): QaReportRecord {
    const row = this.db
      .prepare("SELECT * FROM qa_report WHERE id = ?")
      .get(id) as QaReportRow | undefined;

    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `QA report ${id} not found`,
        invariantRef: "DOM §3.20",
        affectedTarget: id,
      });
    }

    return this.mapQaReportRow(row);
  }

  listByModule(moduleId: string): QaReportRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM qa_report WHERE module_id = ? ORDER BY timestamp")
      .all(moduleId) as QaReportRow[];

    return rows.map((r) => this.mapQaReportRow(r));
  }

  listByWorkPackage(workPackageId: string): QaReportRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM qa_report WHERE work_package_id = ? ORDER BY timestamp")
      .all(workPackageId) as QaReportRow[];

    return rows.map((r) => this.mapQaReportRow(r));
  }

  private mapQaReportRow(row: QaReportRow): QaReportRecord {
    return {
      id: row.id as string,
      moduleId: row.module_id as string | null,
      workPackageId: row.work_package_id as string | null,
      verdict: row.verdict as string,
      reviewedEvidence: JSON.parse(row.reviewed_evidence as string),
      defectIds: JSON.parse(row.defect_ids as string),
      waiverIds: JSON.parse(row.waiver_ids as string),
      reviewer: row.reviewer as string,
      timestamp: row.timestamp as string,
      moduleRevision: row.module_revision as string | null,
      workPackageRevision: row.work_package_revision as string | null,
    };
  }
}

/** Dispatch grant record [DOM §2.2, Remediation §3A]. */
export interface GrantRecord {
  id: string;
  moduleId: string;
  workPackageId: string | null;
  moduleRevision: string;
  specRevisions: string[];
  role: string;
  session: string | null;
  requestedBy: string;
  issuedAt: string;
  expiresAt: string;
  consumed: boolean;
}

interface GrantRow {
  id: unknown;
  module_id: unknown;
  work_package_id: unknown;
  module_revision: unknown;
  spec_revisions: unknown;
  role: unknown;
  session: unknown;
  requested_by: unknown;
  issued_at: unknown;
  expires_at: unknown;
  consumed: unknown;
}

/**
 * Repository for execution dispatch grants. Grants are single-use and
 * expiring: consume() moves 0 → 1, never back; no other mutation exists.
 */
export class GrantRepository {
  constructor(private readonly db: Database) {}

  create(grant: {
    id: string;
    moduleId: string;
    workPackageId: string | null;
    moduleRevision: string;
    specRevisions: string[];
    role: string;
    session: string | null;
    requestedBy: string;
    issuedAt: string;
    expiresAt: string;
  }): GrantRecord {
    this.db.prepare(
      `INSERT INTO execution_grant (id, module_id, work_package_id, module_revision,
         spec_revisions, role, session, requested_by, issued_at, expires_at, consumed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      grant.id, grant.moduleId, grant.workPackageId, grant.moduleRevision,
      JSON.stringify(grant.specRevisions), grant.role, grant.session,
      grant.requestedBy, grant.issuedAt, grant.expiresAt
    );

    return this.findById(grant.id);
  }

  findById(id: string): GrantRecord {
    const row = this.db
      .prepare("SELECT * FROM execution_grant WHERE id = ?")
      .get(id) as GrantRow | undefined;

    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `Dispatch grant ${id} not found`,
        invariantRef: "INV §10.2",
        affectedTarget: id,
        suggestedAction: "Authorize execution to issue a grant first",
      });
    }

    return this.mapGrantRow(row);
  }

  /** Consume a grant (single-use). Second consumption fails closed. */
  consume(id: string): GrantRecord {
    const current = this.findById(id);
    if (current.consumed) {
      throw new ChronoError({
        code: ErrorCode.EXECUTION_DENIED,
        severity: Severity.BLOCKER,
        message: `Dispatch grant ${id} was already consumed: replay denied`,
        invariantRef: "INV §5.1",
        affectedTarget: id,
        suggestedAction: "Authorize execution again for a fresh grant",
      });
    }
    this.db.prepare("UPDATE execution_grant SET consumed = 1 WHERE id = ?").run(id);
    return this.findById(id);
  }

  private mapGrantRow(row: GrantRow): GrantRecord {
    return {
      id: row.id as string,
      moduleId: row.module_id as string,
      workPackageId: row.work_package_id as string | null,
      moduleRevision: row.module_revision as string,
      specRevisions: JSON.parse(row.spec_revisions as string),
      role: row.role as string,
      session: row.session as string | null,
      requestedBy: row.requested_by as string,
      issuedAt: row.issued_at as string,
      expiresAt: row.expires_at as string,
      consumed: Boolean(row.consumed),
    };
  }
}

/**
 * Repository for PO-owned runtime configuration [CORE §8, RUNTIME §8].
 * Stores opaque configuration (runtime selection, PO public key) —
 * never secrets [INV §14.5].
 */
export class RuntimeConfigRepository {
  constructor(private readonly db: Database) {}

  get(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM runtime_config WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO runtime_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, value, now);
  }
}

/** Security profile version record [DOM §3.21, CORE §5]. */
export interface SecurityProfileRecord {
  id: string;
  version: number;
  contentHash: string;
  approvedAt: string | null;
}

/**
 * Repository for versioned Security Profiles [DOM §3.21].
 * Versions are append-only; currency is derived from content hash and
 * material-change invalidation evaluated by the Core.
 */
export class SecurityProfileRepository {
  constructor(private readonly db: Database) {}

  create(id: string, version: number, contentHash: string): SecurityProfileRecord {
    this.db.prepare(
      "INSERT INTO security_profile (id, version, content_hash, approved_at) VALUES (?, ?, ?, NULL)"
    ).run(id, version, contentHash);
    return this.findById(id);
  }

  findById(id: string): SecurityProfileRecord {
    const row = this.db
      .prepare("SELECT * FROM security_profile WHERE id = ?")
      .get(id) as { id: string; version: number; content_hash: string; approved_at: string | null } | undefined;

    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `SecurityProfile ${id} not found`,
        invariantRef: "DOM §3.21",
        affectedTarget: id,
      });
    }

    return { id: row.id, version: row.version, contentHash: row.content_hash, approvedAt: row.approved_at };
  }

  latest(): SecurityProfileRecord | null {
    const row = this.db
      .prepare("SELECT * FROM security_profile ORDER BY version DESC LIMIT 1")
      .get() as { id: string; version: number; content_hash: string; approved_at: string | null } | undefined;

    return row === undefined
      ? null
      : { id: row.id, version: row.version, contentHash: row.content_hash, approvedAt: row.approved_at };
  }

  listAll(): SecurityProfileRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM security_profile ORDER BY version")
      .all() as { id: string; version: number; content_hash: string; approved_at: string | null }[];

    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      contentHash: row.content_hash,
      approvedAt: row.approved_at,
    }));
  }
}

/** Attestation status snapshot [STATE §2.9]. */
export interface AttestationRecord {
  id: string;
  validUntil: string;
  status: string;
  bypassEvents: string[];
}

/**
 * Repository for RTK attestations [DOM §3.27, CORE §10].
 * New verification writes a new row; status lifecycle runs through the
 * guarded transitions (trigger-checked).
 */
export class RtkRepository {
  constructor(private readonly db: Database) {}

  create(attestation: {
    id: string;
    binaryPath: string;
    binaryIdentity: string;
    version: string;
    provenance: string;
    integrationMode: string | null;
    routingTestPassed: boolean;
    routingTestLog: string | null;
    gained: boolean;
    savingsEvidence: string | null;
    validUntil: string;
  }): void {
    this.db.prepare(
      `INSERT INTO rtk_attestation (id, binary_path, binary_identity, version, provenance,
         integration_mode, routing_test_passed, routing_test_log, gained, savings_evidence,
         bypass_events, valid_until, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 'current')`
    ).run(
      attestation.id, attestation.binaryPath, attestation.binaryIdentity, attestation.version,
      attestation.provenance, attestation.integrationMode, attestation.routingTestPassed ? 1 : 0,
      attestation.routingTestLog, attestation.gained ? 1 : 0, attestation.savingsEvidence,
      attestation.validUntil
    );
  }

  latest(): AttestationRecord | null {
    const row = this.db
      .prepare("SELECT * FROM rtk_attestation ORDER BY valid_until DESC, rowid DESC LIMIT 1")
      .get() as { id: string; valid_until: string; status: string; bypass_events: string } | undefined;

    return row === undefined
      ? null
      : { id: row.id, validUntil: row.valid_until, status: row.status, bypassEvents: JSON.parse(row.bypass_events) };
  }
}

/**
 * Repository for Karpathy Guidelines skill attestations [DOM §3.28, CORE §11].
 */
export class SkillRepository {
  constructor(private readonly db: Database) {}

  create(attestation: {
    id: string;
    upstream: string;
    pinnedCommit: string;
    sourceHash: string;
    generatedHashes: string;
    converterVersion: string;
    licenseStatus: string;
    attribution: string | null;
    runtimeIdentity: string | null;
    agentIdentity: string | null;
    discoveryResult: string;
    permissionResult: string;
    activationTestPassed: boolean;
    validUntil: string;
  }): void {
    this.db.prepare(
      `INSERT INTO skill_attestation (id, upstream, pinned_commit, source_hash, generated_hashes,
         converter_version, license_status, attribution, runtime_identity, agent_identity,
         discovery_result, permission_result, activation_test_passed, bypass_events,
         valid_until, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 'current')`
    ).run(
      attestation.id, attestation.upstream, attestation.pinnedCommit, attestation.sourceHash,
      attestation.generatedHashes, attestation.converterVersion, attestation.licenseStatus,
      attestation.attribution, attestation.runtimeIdentity, attestation.agentIdentity,
      attestation.discoveryResult, attestation.permissionResult,
      attestation.activationTestPassed ? 1 : 0, attestation.validUntil
    );
  }

  latest(): AttestationRecord | null {
    const row = this.db
      .prepare("SELECT * FROM skill_attestation ORDER BY valid_until DESC, rowid DESC LIMIT 1")
      .get() as { id: string; valid_until: string; status: string; bypass_events: string } | undefined;

    return row === undefined
      ? null
      : { id: row.id, validUntil: row.valid_until, status: row.status, bypassEvents: JSON.parse(row.bypass_events) };
  }
}

export { type Database };
