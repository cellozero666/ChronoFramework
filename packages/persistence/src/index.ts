/**
 * CHRONO Framework — Persistence package
 * Hybrid storage: SQLite for transactional operational state [P3.9, FW §671]
 */

export { SCHEMA_VERSION, MIGRATIONS } from "./schema.js";
export {
  ChronoDatabase,
  type DatabaseOptions,
  type MigrationResult,
} from "./database.js";

export {
  ArtifactRepository,
  ApprovalRepository,
  BlockerRepository,
  DefectRepository,
  EvidenceRepository,
  EventLogRepository,
  GrantRepository,
  HarnessRepository,
  ProjectRepository,
  QaRepository,
  RtkRepository,
  RuntimeConfigRepository,
  SecurityProfileRepository,
  SequenceRepository,
  SkillRepository,
  WaiverRepository,
  type ArtifactRecord,
  type ArtifactRevisionRecord,
  type ApprovalRecord,
  type AttestationRecord,
  type BlockerRecord,
  type DefectRecord,
  type EvidenceRecord,
  type EventRecord,
  type GrantRecord,
  type HarnessRecord,
  type ProjectRecord,
  type QaReportRecord,
  type SecurityProfileRecord,
  type WaiverRecord,
  type Database,
} from "./repositories.js";
