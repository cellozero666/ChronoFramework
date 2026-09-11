/**
 * SQLite database wrapper and migration runner.
 * [CORE §5, P3.9]
 *
 * The database is the transactional event store. It does NOT replace documents as contracts [P3.9].
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_VERSION, MIGRATIONS } from "./schema.js";
import {
  AdapterRepository,
  ApprovalRepository,
  ArtifactRepository,
  BlockerRepository,
  DefectRepository,
  EvidenceRepository,
  EventLogRepository,
  GrantRepository,
  HarnessRepository,
  BrokerRepository,
  ProjectRepository,
  QaRepository,
  RtkRepository,
  RoutingProofRepository,
  RuntimeConfigRepository,
  SecurityProfileRepository,
  SequenceRepository,
  SessionAuthorizationRepository,
  SessionRepository,
  SetupRepository,
  SkillRepository,
  WaiverRepository,
} from "./repositories.js";

export interface DatabaseOptions {
  readonly path: string;
  readonly readonly?: boolean;
}

export interface MigrationResult {
  readonly version: number;
  readonly appliedAt: string;
}

export class ChronoDatabase {
  private readonly db: Database.Database;
  private readonly path: string;
  private readonly isReadonly: boolean;
  private closed = false;

  constructor(options: DatabaseOptions) {
    this.path = options.path;
    this.isReadonly = options.readonly ?? false;

    // Ensure parent directory exists
    if (!this.isReadonly) {
      mkdirSync(dirname(this.path), { recursive: true });
    }

    this.db = new Database(options.path, {
      readonly: this.isReadonly,
    });

    try {
      // Enable WAL mode for concurrent reads and crash safety
      this.db.pragma("journal_mode = WAL");
    } catch (e) {
      this.db.close();
      throw e;
    }
  }

  /**
   * Run pending schema migrations. [CORE §5.1]
   *
   * `targetVersion` caps the migration run. Production always migrates to
   * SCHEMA_VERSION; tests use the cap to build an older schema and then
   * prove the upgrade path.
   */
  migrate(targetVersion: number = SCHEMA_VERSION): MigrationResult[] {
    const results: MigrationResult[] = [];
    const currentVersion = this.getSchemaVersion();

    if (currentVersion >= targetVersion) {
      return results;
    }

    const applyMigration = (version: number): MigrationResult => {
      const migration = MIGRATIONS[version];
      if (migration === undefined) {
        throw new Error(`Migration ${version} not found`);
      }

      const tx = this.db.transaction(() => {
        this.db.exec(migration);
        const appliedAt = new Date().toISOString();
        const stmt = this.db.prepare(
          "INSERT INTO schema_version (version, applied_at, migration_sql) VALUES (?, ?, ?)"
        );
        stmt.run(version, appliedAt, migration);
        return appliedAt;
      });

      const appliedAt = tx();
      return { version, appliedAt };
    };

    // Ensure schema_version table exists for version 0 → 1
    if (currentVersion === 0) {
      this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, migration_sql TEXT NOT NULL)");
    }

    for (let v = currentVersion + 1; v <= targetVersion; v++) {
      results.push(applyMigration(v));
    }

    return results;
  }

  /** Get current schema version. */
  private getSchemaVersion(): number {
    try {
      const row = this.db
        .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
        .get() as { version: number } | undefined;
      return row?.version ?? 0;
    } catch {
      return 0;
    }
  }

  /** Get current schema version (read-only). */
  schemaVersion(): number {
    return this.getSchemaVersion();
  }

  /** Run a transaction. No raw SQL crosses this boundary. */
  transaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx();
  }

  /**
   * Typed repository accessors. The raw better-sqlite3 handle never
   * leaves this class: repositories are constructed internally and only
   * their typed methods are reachable [Remediation §2].
   */
  projects(): ProjectRepository {
    return new ProjectRepository(this.db);
  }

  artifacts(): ArtifactRepository {
    return new ArtifactRepository(this.db);
  }

  events(): EventLogRepository {
    return new EventLogRepository(this.db);
  }

  approvals(): ApprovalRepository {
    return new ApprovalRepository(this.db);
  }

  blockers(): BlockerRepository {
    return new BlockerRepository(this.db);
  }

  evidence(): EvidenceRepository {
    return new EvidenceRepository(this.db);
  }

  grants(): GrantRepository {
    return new GrantRepository(this.db);
  }

  adapters(): AdapterRepository {
    return new AdapterRepository(this.db);
  }

  sessions(): SessionRepository {
    return new SessionRepository(this.db);
  }

  sessionAuthorizations(): SessionAuthorizationRepository {
    return new SessionAuthorizationRepository(this.db);
  }

  sequences(): SequenceRepository {
    return new SequenceRepository(this.db);
  }

  waivers(): WaiverRepository {
    return new WaiverRepository(this.db);
  }

  defects(): DefectRepository {
    return new DefectRepository(this.db);
  }

  qaReports(): QaRepository {
    return new QaRepository(this.db);
  }

  harnesses(): HarnessRepository {
    return new HarnessRepository(this.db);
  }

  runtimeConfig(): RuntimeConfigRepository {
    return new RuntimeConfigRepository(this.db);
  }

  securityProfiles(): SecurityProfileRepository {
    return new SecurityProfileRepository(this.db);
  }

  rtkAttestations(): RtkRepository {
    return new RtkRepository(this.db);
  }

  routingProofs(): RoutingProofRepository {
    return new RoutingProofRepository(this.db);
  }

  skillAttestations(): SkillRepository {
    return new SkillRepository(this.db);
  }

  setup(): SetupRepository {
    return new SetupRepository(this.db);
  }

  brokerCredentials(): BrokerRepository {
    return new BrokerRepository(this.db);
  }

  /**
   * Close the database. Idempotent: CLI entry points close in `finally`
   * blocks and tests close in `afterEach`, so a second close from an
   * overlapping cleanup path must be a no-op rather than a native-layer
   * error during teardown.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }

  /** Get the database path. */
  getPath(): string {
    return this.path;
  }

  /** Check if this database is readonly. */
  isReadonlyDb(): boolean {
    return this.isReadonly;
  }

  /** Dump the entire database to a SQL string for audit/recovery. [SDD §4.4] */
  dump(): string {
    const lines: string[] = [];
    const tables = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_version'"
      )
      .all() as { name: string }[];

    for (const { name } of tables) {
      lines.push(`-- Table: ${name}`);
      const rows = this.db.prepare(`SELECT * FROM ${name}`).all();
      for (const row of rows) {
        const values = Object.values(row as Record<string, unknown>)
          .map((v) => (typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v ?? "NULL")))
          .join(", ");
        const cols = Object.keys(row as Record<string, unknown>).join(", ");
        lines.push(`INSERT INTO ${name} (${cols}) VALUES (${values});`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

export { SCHEMA_VERSION };
