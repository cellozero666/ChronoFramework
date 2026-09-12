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
  issuerRole: string | null;
  issuerSession: string | null;
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
  issuer_role: unknown;
  issuer_session: unknown;
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

  /** Owning artifact id for a recorded revision, or null when unknown. */
  findArtifactIdByRevision(revision: string): string | null {
    const row = this.db
      .prepare("SELECT id FROM artifact_revision WHERE revision = ? LIMIT 1")
      .get(revision) as { id: string } | undefined;
    return row?.id ?? null;
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

  /** Find any approval row by id (for grant binding revalidation). */
  findById(id: string): ApprovalRecord {
    const row = this.db
      .prepare("SELECT * FROM approval WHERE id = ?")
      .get(id) as ApprovalRow | undefined;

    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `Approval ${id} not found`,
        invariantRef: "DOM §3.16",
        affectedTarget: id,
      });
    }

    return this.mapApprovalRow(row);
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
    issuerRole?: string | null;
    issuerSession?: string | null;
    targetIds: string[];
    reason: string;
    evidenceRefs: string[];
    priorState?: string | null;
  }): BlockerRecord {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO blocker (id, type, issuer, issuer_role, issuer_session, target_ids, reason, evidence_refs,
         created_at, resolved_at, resolved_by, resolved, prior_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?)`
    ).run(
      blocker.id, blocker.type, blocker.issuer,
      blocker.issuerRole ?? null, blocker.issuerSession ?? null,
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
      issuerRole: row.issuer_role as string | null,
      issuerSession: row.issuer_session as string | null,
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
  projectId: string | null;
  moduleId: string;
  workPackageId: string | null;
  moduleRevision: string;
  workPackageRevision: string | null;
  specRevisions: Record<string, string>;
  harnessBindings: Array<{ specId: string; specRevision: string; contentHash: string }>;
  role: string;
  session: string | null;
  requestedBy: string;
  adapterId: string | null;
  rtkAttestationId: string | null;
  skillAttestationId: string | null;
  moduleApprovalId: string | null;
  archApprovalId: string | null;
  policyVersion: string | null;
  issuedAt: string;
  expiresAt: string;
  consumed: boolean;
}

interface GrantRow {
  id: unknown;
  project_id: unknown;
  module_id: unknown;
  work_package_id: unknown;
  module_revision: unknown;
  work_package_revision: unknown;
  spec_revisions: unknown;
  harness_bindings: unknown;
  role: unknown;
  session: unknown;
  requested_by: unknown;
  adapter_id: unknown;
  rtk_attestation_id: unknown;
  skill_attestation_id: unknown;
  module_approval_id: unknown;
  arch_approval_id: unknown;
  policy_version: unknown;
  issued_at: unknown;
  expires_at: unknown;
  consumed: unknown;
}

/**
 * Repository for execution dispatch grants. Grants are single-use and
 * expiring: consumption is one conditional UPDATE (`WHERE consumed = 0`)
 * and succeeds only when exactly one row flips, so concurrent connections
 * cannot double-consume.
 */
export class GrantRepository {
  constructor(private readonly db: Database) {}

  create(grant: {
    id: string;
    projectId: string;
    moduleId: string;
    workPackageId: string | null;
    moduleRevision: string;
    workPackageRevision: string | null;
    specRevisions: Record<string, string>;
    harnessBindings: Array<{ specId: string; specRevision: string; contentHash: string }>;
    role: string;
    session: string | null;
    requestedBy: string;
    adapterId: string | null;
    rtkAttestationId: string | null;
    skillAttestationId: string | null;
    moduleApprovalId: string | null;
    archApprovalId: string | null;
    policyVersion: string;
    issuedAt: string;
    expiresAt: string;
  }): GrantRecord {
    this.db.prepare(
      `INSERT INTO execution_grant (id, project_id, module_id, work_package_id, module_revision,
         work_package_revision, spec_revisions, harness_bindings, role, session, requested_by,
         adapter_id, rtk_attestation_id, skill_attestation_id, module_approval_id, arch_approval_id,
         policy_version, issued_at, expires_at, consumed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      grant.id, grant.projectId, grant.moduleId, grant.workPackageId, grant.moduleRevision,
      grant.workPackageRevision, JSON.stringify(grant.specRevisions), JSON.stringify(grant.harnessBindings),
      grant.role, grant.session, grant.requestedBy, grant.adapterId, grant.rtkAttestationId, grant.skillAttestationId,
      grant.moduleApprovalId, grant.archApprovalId, grant.policyVersion, grant.issuedAt, grant.expiresAt
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

  /**
   * Consume a grant atomically: exactly one row must flip from
   * unconsumed, otherwise the grant is missing, already consumed, or
   * raced — all fail closed.
   */
  consume(id: string): GrantRecord {
    const info = this.db
      .prepare("UPDATE execution_grant SET consumed = 1 WHERE id = ? AND consumed = 0")
      .run(id);
    if (info.changes !== 1) {
      const row = this.db
        .prepare("SELECT consumed FROM execution_grant WHERE id = ?")
        .get(id) as { consumed: number } | undefined;
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
      throw new ChronoError({
        code: ErrorCode.EXECUTION_DENIED,
        severity: Severity.BLOCKER,
        message: `Dispatch grant ${id} was already consumed: replay denied`,
        invariantRef: "INV §5.1",
        affectedTarget: id,
        suggestedAction: "Authorize execution again for a fresh grant",
      });
    }
    return this.findById(id);
  }

  private mapGrantRow(row: GrantRow): GrantRecord {
    const parseMap = (value: unknown): Record<string, string> => {
      if (typeof value !== "string") {
        return {};
      }
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {};
      }
      const out: Record<string, string> = {};
      for (const [key, entry] of Object.entries(parsed)) {
        if (typeof entry === "string") {
          out[key] = entry;
        }
      }
      return out;
    };
    const parseBindings = (value: unknown): Array<{ specId: string; specRevision: string; contentHash: string }> => {
      if (typeof value !== "string") {
        return [];
      }
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(
        (entry): entry is { specId: string; specRevision: string; contentHash: string } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as Record<string, unknown>)["specId"] === "string" &&
          typeof (entry as Record<string, unknown>)["specRevision"] === "string" &&
          typeof (entry as Record<string, unknown>)["contentHash"] === "string"
      );
    };
    return {
      id: row.id as string,
      projectId: row.project_id as string | null,
      moduleId: row.module_id as string,
      workPackageId: row.work_package_id as string | null,
      moduleRevision: row.module_revision as string,
      workPackageRevision: row.work_package_revision as string | null,
      specRevisions: parseMap(row.spec_revisions),
      harnessBindings: parseBindings(row.harness_bindings),
      role: row.role as string,
      session: row.session as string | null,
      requestedBy: row.requested_by as string,
      adapterId: row.adapter_id as string | null,
      rtkAttestationId: row.rtk_attestation_id as string | null,
      skillAttestationId: row.skill_attestation_id as string | null,
      moduleApprovalId: row.module_approval_id as string | null,
      archApprovalId: row.arch_approval_id as string | null,
      policyVersion: row.policy_version as string | null,
      issuedAt: row.issued_at as string,
      expiresAt: row.expires_at as string,
      consumed: Boolean(row.consumed),
    };
  }
}

/** One-time privileged-session authorization [Remediation §3A]. */
export interface SessionAuthorizationRecord {
  nonce: string;
  role: string;
  authority: string;
  usedAt: string;
}

/**
 * Repository for consumed privileged-session bootstrap nonces. Insert is
 * the replay defense: a reused authorization nonce collides on the primary
 * key and denies before any session is issued.
 */
export class SessionAuthorizationRepository {
  constructor(private readonly db: Database) {}

  consume(authorization: {
    nonce: string;
    role: string;
    authority: string;
    usedAt: string;
  }): SessionAuthorizationRecord {
    try {
      this.db.prepare(
        `INSERT INTO session_authorization (nonce, role, authority, used_at)
         VALUES (?, ?, ?, ?)`
      ).run(authorization.nonce, authorization.role, authorization.authority, authorization.usedAt);
    } catch {
      throw new ChronoError({
        code: ErrorCode.DUPLICATE_IDENTITY,
        severity: Severity.BLOCKER,
        message: "Privileged-session authorization was already used: replay denied",
        invariantRef: "INV §10.1",
        affectedTarget: authorization.nonce,
        suggestedAction: "Request a fresh signed privileged-session authorization",
      });
    }
    return { ...authorization };
  }
}

/** Runtime adapter registration record [RUNTIME §13, PL Phase 5]. */
export interface AdapterRecord {
  id: string;
  name: string;
  entrypoint: string;
  gateHook: string | null;
  dispatchProof: string | null;
  rtkRouting: string | null;
  skillActivation: string | null;
  conformanceProof: string[];
  status: string;
  registeredBy: string;
  registeredAt: string;
}

interface AdapterRow {
  id: unknown;
  name: unknown;
  entrypoint: unknown;
  gate_hook: unknown;
  dispatch_proof: unknown;
  rtk_routing: unknown;
  skill_activation: unknown;
  conformance_proof: unknown;
  status: unknown;
  registered_by: unknown;
  registered_at: unknown;
}

/**
 * Repository for runtime adapter registrations. Ids are unique;
 * revocation is terminal (`active` → `revoked`, no un-revoke path).
 */
export class AdapterRepository {
  constructor(private readonly db: Database) {}

  create(adapter: {
    id: string;
    name: string;
    entrypoint: string;
    gateHook: string | null;
    dispatchProof: string | null;
    rtkRouting: string | null;
    skillActivation: string | null;
    conformanceProof: string[];
    registeredBy: string;
    registeredAt: string;
  }): AdapterRecord {
    try {
      this.db.prepare(
        `INSERT INTO adapter (id, name, entrypoint, gate_hook, dispatch_proof,
           rtk_routing, skill_activation, conformance_proof, status,
           registered_by, registered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      ).run(
        adapter.id, adapter.name, adapter.entrypoint, adapter.gateHook,
        adapter.dispatchProof, adapter.rtkRouting, adapter.skillActivation,
        JSON.stringify(adapter.conformanceProof), adapter.registeredBy,
        adapter.registeredAt
      );
    } catch {
      throw new ChronoError({
        code: ErrorCode.DUPLICATE_IDENTITY,
        severity: Severity.ERROR,
        message: `Adapter '${adapter.id}' is already registered: revoke it first to replace it`,
        invariantRef: "INV §10.1",
        affectedTarget: adapter.id,
        suggestedAction: "Revoke the existing registration before registering a new one",
      });
    }
    return this.findById(adapter.id);
  }

  findById(id: string): AdapterRecord {
    const row = this.db
      .prepare("SELECT * FROM adapter WHERE id = ?")
      .get(id) as AdapterRow | undefined;
    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `Adapter '${id}' is not registered: unregistered runtimes cannot dispatch`,
        invariantRef: "INV §10.2",
        affectedTarget: id,
        suggestedAction: "Register the adapter before dispatching through it",
      });
    }
    return this.mapAdapterRow(row);
  }

  listAll(): AdapterRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM adapter ORDER BY id")
      .all() as AdapterRow[];
    return rows.map((row) => this.mapAdapterRow(row));
  }

  revoke(id: string): AdapterRecord {
    this.findById(id);
    this.db.prepare("UPDATE adapter SET status = 'revoked' WHERE id = ?").run(id);
    return this.findById(id);
  }

  /**
   * Activate a pending registration after its signed PO approval.
   * Only `pending` rows activate: already-active or revoked rows deny
   * explicitly instead of rewriting terminal state.
   */
  activate(id: string): AdapterRecord {
    const current = this.findById(id);
    if (current.status !== "pending") {
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: `Adapter '${id}' is ${current.status}, not pending: only pending registrations activate`,
        invariantRef: "INV §14.4",
        affectedTarget: id,
        suggestedAction: "Register the adapter first, then approve it",
      });
    }
    this.db.prepare("UPDATE adapter SET status = 'active' WHERE id = ?").run(id);
    return this.findById(id);
  }

  private mapAdapterRow(row: AdapterRow): AdapterRecord {
    let conformanceProof: unknown;
    try {
      conformanceProof = JSON.parse(row.conformance_proof as string);
    } catch {
      conformanceProof = [];
    }
    return {
      id: row.id as string,
      name: row.name as string,
      entrypoint: row.entrypoint as string,
      gateHook: row.gate_hook as string | null,
      dispatchProof: row.dispatch_proof as string | null,
      rtkRouting: row.rtk_routing as string | null,
      skillActivation: row.skill_activation as string | null,
      conformanceProof: Array.isArray(conformanceProof)
        ? (conformanceProof as string[])
        : [],
      status: row.status as string,
      registeredBy: row.registered_by as string,
      registeredAt: row.registered_at as string,
    };
  }
}

/** Authenticated adapter session record [DOM §2.2, Remediation §3A]. */
export interface AgentSessionRecord {
  id: string;
  tokenHash: string;
  role: string;
  adapter: string;
  runtime: string;
  projectId: string;
  scopeModule: string | null;
  scopeWp: string | null;
  parentId: string | null;
  issuedAt: string;
  expiresAt: string;
  revoked: boolean;
  lastSeen: string;
}

interface AgentSessionRow {
  id: unknown;
  token_hash: unknown;
  role: unknown;
  adapter: unknown;
  runtime: unknown;
  project_id: unknown;
  scope_module: unknown;
  scope_wp: unknown;
  parent_id: unknown;
  issued_at: unknown;
  expires_at: unknown;
  revoked: unknown;
  last_seen: unknown;
}

/**
 * Repository for authenticated adapter sessions. Only the SHA-256 of the
 * bearer token persists; tokens are returned once at issuance and never
 * stored. Revocation is terminal (no un-revoke path).
 */
export class SessionRepository {
  constructor(private readonly db: Database) {}

  create(session: {
    id: string;
    tokenHash: string;
    role: string;
    adapter: string;
    runtime: string;
    projectId: string;
    scopeModule: string | null;
    scopeWp: string | null;
    parentId: string | null;
    issuedAt: string;
    expiresAt: string;
  }): AgentSessionRecord {
    this.db.prepare(
      `INSERT INTO agent_session (id, token_hash, role, adapter, runtime, project_id,
         scope_module, scope_wp, parent_id, issued_at, expires_at, revoked, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(
      session.id, session.tokenHash, session.role, session.adapter, session.runtime,
      session.projectId, session.scopeModule, session.scopeWp, session.parentId,
      session.issuedAt, session.expiresAt, session.issuedAt
    );

    return this.findById(session.id);
  }

  findById(id: string): AgentSessionRecord {
    const row = this.db
      .prepare("SELECT * FROM agent_session WHERE id = ?")
      .get(id) as AgentSessionRow | undefined;

    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `Session ${id} not found`,
        invariantRef: "INV §10.2",
        affectedTarget: id,
        suggestedAction: "Open an authenticated session first",
      });
    }

    return this.mapSessionRow(row);
  }

  findByTokenHash(tokenHash: string): AgentSessionRecord {
    const row = this.db
      .prepare("SELECT * FROM agent_session WHERE token_hash = ?")
      .get(tokenHash) as AgentSessionRow | undefined;

    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.REFERENCE_UNRESOLVABLE,
        severity: Severity.ERROR,
        message: "Session token unknown: forged tokens deny",
        invariantRef: "INV §10.2",
        suggestedAction: "Open an authenticated session first",
      });
    }

    return this.mapSessionRow(row);
  }

  touch(id: string, at: string): void {
    this.db.prepare("UPDATE agent_session SET last_seen = ? WHERE id = ?").run(at, id);
  }

  revoke(id: string): AgentSessionRecord {
    this.db.prepare("UPDATE agent_session SET revoked = 1 WHERE id = ?").run(id);
    return this.findById(id);
  }

  /**
   * Revoke every live session bound to an adapter. Used as a cascade when
   * the adapter itself is revoked: a revoked adapter's sessions must not
   * survive to submit proofs, record evidence, or delegate new sessions.
   * Returns the number of sessions revoked (0 when none were live).
   */
  revokeByAdapter(adapter: string): number {
    const result = this.db
      .prepare("UPDATE agent_session SET revoked = 1 WHERE adapter = ? AND revoked = 0")
      .run(adapter);
    return Number(result.changes);
  }

  private mapSessionRow(row: AgentSessionRow): AgentSessionRecord {
    return {
      id: row.id as string,
      tokenHash: row.token_hash as string,
      role: row.role as string,
      adapter: row.adapter as string,
      runtime: row.runtime as string,
      projectId: row.project_id as string,
      scopeModule: row.scope_module as string | null,
      scopeWp: row.scope_wp as string | null,
      parentId: row.parent_id as string | null,
      issuedAt: row.issued_at as string,
      expiresAt: row.expires_at as string,
      revoked: Boolean(row.revoked),
      lastSeen: row.last_seen as string,
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
export interface RtkAttestationDetail {
  id: string;
  version: string;
  provenance: string;
  routingTestPassed: boolean;
  binaryPath: string;
}

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

  /**
   * Latest attestation with its provenance binding, for setup reporting
   * and routing-proof binding (read-only).
   */
  latestFull(): RtkAttestationDetail | null {
    const row = this.db
      .prepare("SELECT * FROM rtk_attestation ORDER BY valid_until DESC, rowid DESC LIMIT 1")
      .get() as {
        id: string;
        version: string;
        provenance: string;
        routing_test_passed: number;
        binary_path: string;
      } | undefined;

    return row === undefined
      ? null
      : {
        id: row.id,
        version: row.version,
        provenance: row.provenance,
        routingTestPassed: row.routing_test_passed === 1,
        binaryPath: row.binary_path,
      };
  }
}

/**
 * Repository for Karpathy Guidelines skill attestations [DOM §3.28, CORE §11].
 */
export interface SkillAttestationDetail {
  id: string;
  upstream: string;
  pinnedCommit: string;
  sourceHash: string;
  generatedHashes: string;
  converterVersion: string;
}

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

  /**
   * Latest attestation with its provenance binding, for divergence checks
   * at re-verification time [CORE §11.1]: a stored row that no longer
   * matches the pinned release must never be recorded over silently.
   */
  latestFull(): SkillAttestationDetail | null {
    const row = this.db
      .prepare("SELECT * FROM skill_attestation ORDER BY valid_until DESC, rowid DESC LIMIT 1")
      .get() as {
        id: string;
        upstream: string;
        pinned_commit: string;
        source_hash: string;
        generated_hashes: string;
        converter_version: string;
      } | undefined;

    return row === undefined
      ? null
      : {
        id: row.id,
        upstream: row.upstream,
        pinnedCommit: row.pinned_commit,
        sourceHash: row.source_hash,
        generatedHashes: row.generated_hashes,
        converterVersion: row.converter_version,
      };
  }
}

/** RTK routing proof record [SLICE-9 §9.3, P8.5, INV §8.4]. */
export type RoutingProofAuthority = "candidate" | "authoritative";

export interface RoutingProofRecord {
  id: string;
  adapterId: string;
  runtime: string;
  sessionId: string;
  projectId: string;
  rtkAttestationId: string;
  binaryPath: string;
  binaryHash: string;
  version: string;
  proofCommand: string;
  preRoutingCommand: string;
  commandHash: string;
  outputHash: string;
  exitStatus: number;
  gainAvailable: boolean;
  timestamp: string;
  validUntil: string;
  authority: RoutingProofAuthority;
  adapterHash: string | null;
  assetHash: string | null;
}

interface RoutingProofRow {
  id: unknown;
  adapter_id: unknown;
  runtime: unknown;
  session_id: unknown;
  project_id: unknown;
  rtk_attestation_id: unknown;
  binary_path: unknown;
  binary_hash: unknown;
  version: unknown;
  proof_command: unknown;
  pre_routing_command: unknown;
  command_hash: unknown;
  output_hash: unknown;
  exit_status: unknown;
  gain_available: unknown;
  timestamp: unknown;
  valid_until: unknown;
  authority: unknown;
  adapter_hash: unknown;
  asset_hash: unknown;
}

/**
 * Repository for RTK routing proofs. Rows are append-only with one
 * narrowly guarded exception: a `candidate` proof may transition to
 * `authoritative` through explicit promotion (Core-owned, audited).
 * Nothing else about a proof row may change after recording, and rows
 * are never deleted. Consumers re-validate liveness (adapter, binary,
 * attestation, registration hash, asset manifest) at every use.
 */
export class RoutingProofRepository {
  constructor(private readonly db: Database) {}

  create(proof: {
    id: string;
    adapterId: string;
    runtime: string;
    sessionId: string;
    projectId: string;
    rtkAttestationId: string;
    binaryPath: string;
    binaryHash: string;
    version: string;
    proofCommand: string;
    preRoutingCommand: string;
    commandHash: string;
    outputHash: string;
    exitStatus: number;
    gainAvailable: boolean;
    timestamp: string;
    validUntil: string;
  }): RoutingProofRecord {
    this.db.prepare(
      `INSERT INTO routing_proof (id, adapter_id, runtime, session_id, project_id,
         rtk_attestation_id, binary_path, binary_hash, version, proof_command,
         pre_routing_command, command_hash, output_hash, exit_status, gain_available,
         timestamp, valid_until, authority, adapter_hash, asset_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', NULL, NULL)`
    ).run(
      proof.id, proof.adapterId, proof.runtime, proof.sessionId, proof.projectId,
      proof.rtkAttestationId, proof.binaryPath, proof.binaryHash, proof.version,
      proof.proofCommand, proof.preRoutingCommand, proof.commandHash, proof.outputHash, proof.exitStatus,
      proof.gainAvailable ? 1 : 0, proof.timestamp, proof.validUntil
    );
    return this.findById(proof.id);
  }

  /**
   * Promote a candidate proof to authoritative. The single permitted
   * mutation of a proof row: candidate → authoritative only, with the
   * adapter registration hash and asset manifest hash snapshotted at
   * promotion time. Anything else throws without touching the row.
   *
   * Returns whether this call applied the transition. A concurrent
   * promotion that lands first resolves deterministically: the loser
   * observes the authoritative row and reports `applied: false` so the
   * caller emits no duplicate audit event [OC-P2]. Callers MUST persist
   * the audit event in the same database transaction as this update.
   */
  promote(id: string, adapterHash: string, assetHash: string): { record: RoutingProofRecord; applied: boolean } {
    const current = this.findById(id);
    if (current.authority === "authoritative") {
      return { record: current, applied: false };
    }
    if (current.authority !== "candidate") {
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: `Routing proof '${id}' has unknown authority '${current.authority}': cannot promote`,
        invariantRef: "INV §14.4",
        affectedTarget: id,
        suggestedAction: "Re-record the proof with chrono rtk prove",
      });
    }
    const updated = this.db
      .prepare("UPDATE routing_proof SET authority = 'authoritative', adapter_hash = ?, asset_hash = ? WHERE id = ? AND authority = 'candidate'")
      .run(adapterHash, assetHash, id);
    if (updated.changes === 0) {
      const raced = this.findById(id);
      if (raced.authority === "authoritative") {
        return { record: raced, applied: false };
      }
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: `Routing proof '${id}' changed during promotion: refusing to mint authority on a moving row`,
        invariantRef: "INV §14.4",
        affectedTarget: id,
        suggestedAction: "Re-read the proof and promote the current candidate",
      });
    }
    return { record: this.findById(id), applied: true };
  }

  findById(id: string): RoutingProofRecord {
    const row = this.db
      .prepare("SELECT * FROM routing_proof WHERE id = ?")
      .get(id) as RoutingProofRow | undefined;
    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `Routing proof ${id} not found`,
        invariantRef: "INV §10.2",
        affectedTarget: id,
        suggestedAction: "Record a routing proof with chrono rtk prove first",
      });
    }
    return this.mapRow(row);
  }
  /** Latest proof for one adapter/runtime/project scope (may be expired). */
  latestFor(adapterId: string, runtime: string, projectId: string): RoutingProofRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM routing_proof
         WHERE adapter_id = ? AND runtime = ? AND project_id = ?
         ORDER BY valid_until DESC, rowid DESC LIMIT 1`
      )
      .get(adapterId, runtime, projectId) as RoutingProofRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  /** Latest AUTHORITATIVE proof for one adapter/runtime/project scope (may be expired). */
  latestAuthoritative(adapterId: string, runtime: string, projectId: string): RoutingProofRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM routing_proof
         WHERE adapter_id = ? AND runtime = ? AND project_id = ? AND authority = 'authoritative'
         ORDER BY valid_until DESC, rowid DESC LIMIT 1`
      )
      .get(adapterId, runtime, projectId) as RoutingProofRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  /** Latest proof per runtime for one adapter (may be expired). */
  scopesFor(adapterId: string, projectId: string): RoutingProofRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM routing_proof AS outer_proof
         WHERE adapter_id = ? AND project_id = ?
           AND valid_until = (
             SELECT MAX(valid_until) FROM routing_proof
             WHERE adapter_id = outer_proof.adapter_id
               AND runtime = outer_proof.runtime
               AND project_id = outer_proof.project_id
           )
         ORDER BY runtime`
      )
      .all(adapterId, projectId) as RoutingProofRow[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: RoutingProofRow): RoutingProofRecord {
    return {
      id: row.id as string,
      adapterId: row.adapter_id as string,
      runtime: row.runtime as string,
      sessionId: row.session_id as string,
      projectId: row.project_id as string,
      rtkAttestationId: row.rtk_attestation_id as string,
      binaryPath: row.binary_path as string,
      binaryHash: row.binary_hash as string,
      version: row.version as string,
      proofCommand: row.proof_command as string,
      preRoutingCommand: (row.pre_routing_command as string | null) ?? "",
      commandHash: row.command_hash as string,
      outputHash: row.output_hash as string,
      exitStatus: row.exit_status as number,
      gainAvailable: Boolean(row.gain_available),
      timestamp: row.timestamp as string,
      validUntil: row.valid_until as string,
      authority: row.authority === "authoritative" ? "authoritative" : "candidate",
      adapterHash: (row.adapter_hash as string | null) ?? null,
      assetHash: (row.asset_hash as string | null) ?? null,
    };
  }
}

export interface SetupStateRecord {
  readonly step: string;
  readonly updatedAt: string;
  readonly detail: string;
}

/**
 * Resumable setup state for chrono init orchestration [SLICE-10 §3.3].
 * Single row (`id = 'setup'`): the furthest step reached plus non-secret
 * detail JSON. Secrets (keys, tokens, broker secrets) must never enter
 * the detail payload.
 */
export class SetupRepository {
  constructor(private readonly db: Database) {}

  get(): SetupStateRecord | null {
    const row = this.db
      .prepare("SELECT step, updated_at, detail FROM setup_state WHERE id = 'setup'")
      .get() as { step: string; updated_at: string; detail: string } | undefined;
    if (row === undefined) {
      return null;
    }
    return { step: row.step, updatedAt: row.updated_at, detail: row.detail };
  }

  set(step: string, updatedAt: string, detail: string): SetupStateRecord {
    this.db
      .prepare(
        `INSERT INTO setup_state (id, step, updated_at, detail) VALUES ('setup', ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET step = excluded.step, updated_at = excluded.updated_at, detail = excluded.detail`
      )
      .run(step, updatedAt, detail);
    const current = this.get();
    if (current === null) {
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: "Setup state write did not persist",
        invariantRef: "INV §14.4",
        suggestedAction: "Verify the project database is writable",
      });
    }
    return current;
  }
}

export interface BrokerCredentialRecord {
  readonly id: string;
  readonly secretHash: string;
  readonly createdAt: string;
  readonly revoked: boolean;
}

interface BrokerCredentialRow {
  readonly id: string;
  readonly secret_hash: string;
  readonly created_at: string;
  readonly revoked: unknown;
}

/**
 * Broker credentials for automatic Gaspar entry [SLICE-10 §5.2].
 * Only the SHA-256 of each secret persists; verification uses a
 * timing-safe comparison. Revocation is terminal.
 */
export class BrokerRepository {
  constructor(private readonly db: Database) {}

  create(credential: { id: string; secretHash: string; createdAt: string }): BrokerCredentialRecord {
    try {
      this.db
        .prepare("INSERT INTO broker_credential (id, secret_hash, created_at, revoked) VALUES (?, ?, ?, 0)")
        .run(credential.id, credential.secretHash, credential.createdAt);
    } catch {
      throw new ChronoError({
        code: ErrorCode.DUPLICATE_IDENTITY,
        severity: Severity.ERROR,
        message: `Broker credential '${credential.id}' already exists: revoke it first to replace it`,
        invariantRef: "INV §10.1",
        affectedTarget: credential.id,
        suggestedAction: "Revoke the existing broker credential before issuing a new one",
      });
    }
    return this.findById(credential.id);
  }

  findById(id: string): BrokerCredentialRecord {
    const row = this.db
      .prepare("SELECT * FROM broker_credential WHERE id = ?")
      .get(id) as BrokerCredentialRow | undefined;
    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `Broker credential '${id}' not found`,
        invariantRef: "INV §10.2",
        affectedTarget: id,
        suggestedAction: "Issue a broker credential during setup first",
      });
    }
    return {
      id: row.id,
      secretHash: row.secret_hash,
      createdAt: row.created_at,
      revoked: Boolean(row.revoked),
    };
  }

  listAll(): BrokerCredentialRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM broker_credential ORDER BY id")
      .all() as BrokerCredentialRow[];
    return rows.map((row) => ({
      id: row.id,
      secretHash: row.secret_hash,
      createdAt: row.created_at,
      revoked: Boolean(row.revoked),
    }));
  }

  revoke(id: string): BrokerCredentialRecord {
    this.findById(id);
    this.db.prepare("UPDATE broker_credential SET revoked = 1 WHERE id = ?").run(id);
    return this.findById(id);
  }
}

export { type Database };
