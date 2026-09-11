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
  EvidenceRepository,
  EventLogRepository,
  ProjectRepository,
  type ArtifactRecord,
  type ApprovalRecord,
  type BlockerRecord,
  type EvidenceRecord,
  type EventRecord,
  type ProjectRecord,
  type Database,
} from "./repositories.js";
