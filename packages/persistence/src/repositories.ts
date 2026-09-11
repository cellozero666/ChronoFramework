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
 * Artifact record from the database.
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

  create(projectId: string, language: string, gasparAutonomy: string): ProjectRecord {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO project (id, language, gaspar_autonomy, runtime, created_at, updated_at, state,
         system_analysis_complete, architecture_id, architecture_revision, architecture_state,
         spec_count, module_count)
       VALUES (?, ?, ?, NULL, ?, ?, 'UNINITIALIZED', 0, NULL, NULL, NULL, 0, 0)`
    ).run(projectId, language, gasparAutonomy, now, now);

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
    contentHash: string
  ): ArtifactRecord {
    const now = new Date().toISOString();
    try {
      this.db.prepare(
        `INSERT INTO artifact (id, type, revision, status, created_at, updated_at, deleted, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
      ).run(id, type, revision, status, now, now, contentHash);
    } catch (e) {
      if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
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

  findByRevision(id: string, revision: string): ArtifactRecord {
    const row = this.db
      .prepare("SELECT * FROM artifact WHERE id = ? AND revision = ? AND deleted = 0")
      .get(id, revision) as ArtifactRow | undefined;

    if (row === undefined) {
      throw new ChronoError({
        code: ErrorCode.STALE_REVISION,
        severity: Severity.ERROR,
        message: `Artifact ${id}@${revision} not found or stale`,
        invariantRef: "INV §10.3",
        affectedTarget: `${id}@${revision}`,
        suggestedAction: "Resolve to the current revision of this artifact",
      });
    }

    return this.mapArtifactRow(row);
  }

  /** Resolve a reference to an exact revision [CORE §12, DOM §2.4] */
  resolveReference(refId: string, targetRevision?: string): ArtifactRecord {
    if (targetRevision !== undefined) {
      return this.findByRevision(refId, targetRevision);
    }
    return this.findById(refId);
  }

  updateStatus(id: string, status: string, newRevision: string): ArtifactRecord {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE artifact SET status = ?, revision = ?, updated_at = ? WHERE id = ? AND deleted = 0`
    ).run(status, newRevision, now, id);

    return this.findById(id);
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
  }): BlockerRecord {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO blocker (id, type, issuer, target_ids, reason, evidence_refs,
         created_at, resolved_at, resolved_by, resolved)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)`
    ).run(
      blocker.id, blocker.type, blocker.issuer,
      JSON.stringify(blocker.targetIds), blocker.reason,
      JSON.stringify(blocker.evidenceRefs), now
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

  resolve(id: string, resolvedBy: string): BlockerRecord {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE blocker SET resolved = 1, resolved_at = ?, resolved_by = ? WHERE id = ?`
    ).run(now, resolvedBy, id);

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

export { type Database };
