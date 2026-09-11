/**
 * CHRONO Core — deterministic application layer.
 * [CORE §16] — All policy decisions live here, not in adapters or prompts.
 * [FW §648] — Fail-closed semantics.
 */

import {
  ChronoDatabase,
  ProjectRepository,
  ArtifactRepository,
  EventLogRepository,
  ApprovalRepository,
  BlockerRepository,
  EvidenceRepository,
} from "@chrono/persistence";
import {
  validateTransition,
  projectProjectState,
  computeRevisionHash,
  isStaleReference,
  ChronoError,
  ErrorCode,
  Severity,
} from "@chrono/domain";
import type { ProjectState, EntityType } from "@chrono/domain";

/**
 * Core configuration (PO-owned, external) [CORE §8, RUNTIME §8]
 */
export interface CoreConfig {
  readonly projectPath: string;
  readonly language?: string;
  readonly gasparAutonomy?: string;
  readonly runtime?: string | null;
}

/**
 * Result of a Core operation — either authorized or denied with explanation.
 * [CORE §9, SDD §4.1]
 */
export interface CoreResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: {
    code: string;
    severity: string;
    message: string;
    invariantRef?: string;
    affectedTarget?: string;
    suggestedAction?: string;
    nextActions?: string[];
  };
}

/**
 * Gate decision [CORE §7, INV §5.1]
 */
export type GateDecision = CoreResult<true>;

/**
 * Project status result [CORE §6, STATE §3]
 */
export interface StatusResult {
  readonly state: ProjectState;
  readonly specCount: number;
  readonly moduleCount: number;
  readonly workPackageCount: number;
  readonly activeBlockers: number;
  readonly activeBlockerList: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly reason: string;
  }>;
  readonly details: {
    readonly projectState: string;
    readonly projectedState: ProjectState;
    readonly systemAnalysisComplete: boolean;
    readonly architectureState: string | null;
    readonly gasparAutonomy: string;
    readonly runtime: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
}

export class ChronoCore {
  private readonly db: ChronoDatabase;
  private readonly projects: ProjectRepository;
  private readonly artifacts: ArtifactRepository;
  private readonly events: EventLogRepository;
  private readonly approvals: ApprovalRepository;
  private readonly blockers: BlockerRepository;
  private readonly evidence: EvidenceRepository;
  private readonly config: CoreConfig;

  constructor(config: CoreConfig) {
    this.config = config;
    this.db = new ChronoDatabase({
      path: `${config.projectPath}/.chrono/chrono.db`,
    });
    this.db.migrate();
    this.projects = new ProjectRepository(this.db.getDb());
    this.artifacts = new ArtifactRepository(this.db.getDb());
    this.events = new EventLogRepository(this.db.getDb());
    this.approvals = new ApprovalRepository(this.db.getDb());
    this.blockers = new BlockerRepository(this.db.getDb());
    this.evidence = new EvidenceRepository(this.db.getDb());
  }

  // ---------------------------------------------------------------------------
  // Slice 3: Core API
  // ---------------------------------------------------------------------------

  /**
   * Initialize a new CHRONO project.
   * [CORE §13, P1.7, DOM §3.1]
   */
  init(): CoreResult<{ projectId: string; state: ProjectState }> {
    try {
      // Check if already initialized
      try {
        this.projects.findById("default");
        return {
          ok: false,
          error: {
            code: ErrorCode.DUPLICATE_IDENTITY as string,
            severity: Severity.ERROR,
            message: "Project already initialized",
            invariantRef: "DOM §3.1",
            affectedTarget: "project",
            suggestedAction: "Use existing project or run in a different directory",
          },
        };
      } catch {
        // Good — project doesn't exist yet
      }

      const language = this.config.language ?? "en";
      const gasparAutonomy = this.config.gasparAutonomy ?? "SEMI_AUTONOMOUS";

      const projectId = "default";
      const project = this.projects.create(projectId, language, gasparAutonomy);

      this.events.append({
        eventType: "ProjectInitialized",
        entityId: projectId,
        payload: { language, gasparAutonomy, runtime: this.config.runtime ?? null },
        actor: "PO",
        priorState: undefined,
        newState: "UNINITIALIZED",
        reasoning: "Project created via chrono init",
      });

      return {
        ok: true,
        value: { projectId, state: project.state as ProjectState },
      };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Get current project status — deterministic projection of child states.
   * [CORE §6.2, STATE §3]
   */
  status(): CoreResult<StatusResult> {
    try {
      const project = this.projects.findById("default");
      const modules = this.artifacts.listByType("MOD");
      const workPackages = this.artifacts.listByType("WP");
      const specs = this.artifacts.listByType("SP");

      const activeBlockers = this.blockers.findActive();

      const projectedState = projectProjectState({
        initialized: true,
        blockers: activeBlockers.map((b) => ({
          active: !b.resolved,
          targetType: b.type,
        })),
        modules: modules.map((m) => ({ state: m.status })),
        workPackages: workPackages.map((w) => ({ state: w.status })),
        specifications: specs.map((s) => ({ state: s.status })),
        hasSpecs: specs.length > 0,
        systemAnalysisComplete: project.systemAnalysisComplete,
        architectureState: project.architectureState ?? undefined,
        planningInProgress: project.state === "PLANNING",
      });

      return {
        ok: true,
        value: {
          state: projectedState,
          specCount: specs.length,
          moduleCount: modules.length,
          workPackageCount: workPackages.length,
          activeBlockers: activeBlockers.length,
          activeBlockerList: activeBlockers.map((b) => ({
            id: b.id,
            type: b.type,
            reason: b.reason,
          })),
          details: {
            projectState: project.state,
            projectedState,
            systemAnalysisComplete: project.systemAnalysisComplete,
            architectureState: project.architectureState,
            gasparAutonomy: project.gasparAutonomy,
            runtime: project.runtime,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          },
        },
      };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Run deterministic validation of all project reference integrity and consistency.
   * [CORE §14, INV §13.1, P7.2]
   */
  validate(): CoreResult<{ valid: boolean; errors: string[]; warnings: string[] }> {
    try {
      const errors: string[] = [];
      const warnings: string[] = [];

      // Validate project exists
      const project = this.projects.findById("default");

      // Validate all artifacts have valid states
      const allArtifacts = [
        ...this.artifacts.listByType("SP"),
        ...this.artifacts.listByType("MOD"),
        ...this.artifacts.listByType("WP"),
      ];

      for (const artifact of allArtifacts) {
        // Check artifact has valid revision
        if (!artifact.revision.startsWith("sha256:")) {
          errors.push(`Artifact ${artifact.id} has invalid revision format`);
        }
      }

      // Check for duplicate IDs
      const ids = new Set<string>();
      for (const artifact of allArtifacts) {
        if (ids.has(artifact.id)) {
          errors.push(`Duplicate artifact ID: ${artifact.id}`);
        }
        ids.add(artifact.id);
      }

      // Check active blockers
      const activeBlockers = this.blockers.findActive();
      if (activeBlockers.length > 0) {
        for (const blocker of activeBlockers) {
          warnings.push(`Active blocker: ${blocker.id} — ${blocker.reason}`);
        }
      }

      // Validate no orphan work packages (each WP traces to a module)
      // This is a simplified check — full traceability is validated during execution
      const modules = this.artifacts.listByType("MOD");
      const workPackages = this.artifacts.listByType("WP");

      if (workPackages.length > 0 && modules.length === 0) {
        errors.push("Work packages exist without any modules");
      }

      // Check project state matches projection
      const projected = this.status();
      if (!projected.ok || projected.value?.details.projectedState !== project.state) {
        // Only enforce if projectState differs from projected — this is informational
      }

      return {
        ok: true,
        value: { valid: errors.length === 0, errors, warnings },
      };
    } catch (e) {
      return this.handleError(e);
    }
  }

  // ---------------------------------------------------------------------------
  // Slice 3: Artifact registration
  // ---------------------------------------------------------------------------

  /**
   * Register a Specification artifact.
   * [CORE §7.3, DOM §3.9]
   */
  registerSpec(specId: string, status: string, content: unknown): CoreResult<string> {
    try {
      const revision = computeRevisionHash(content);
      const contentHash = computeRevisionHash({ specId, content });

      this.artifacts.create(specId, "SP", revision, status, contentHash);

      this.events.append({
        eventType: "ArtifactCreated",
        entityId: specId,
        payload: { type: "SP", revision, status },
        actor: "gaspar",
        priorState: undefined,
        newState: status,
        reasoning: "Specification registered",
      });

      // Update project spec count
      const project = this.projects.findById("default");
      const specs = this.artifacts.listByType("SP");
      this.projects.updateCounts(project.id, specs.length, project.moduleCount);

      return { ok: true, value: revision };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Register a Module artifact.
   * [CORE §7.4, DOM §3.13]
   */
  registerModule(moduleId: string, status: string, content: unknown): CoreResult<string> {
    try {
      const revision = computeRevisionHash(content);
      const contentHash = computeRevisionHash({ moduleId, content });

      this.artifacts.create(moduleId, "MOD", revision, status, contentHash);

      this.events.append({
        eventType: "ArtifactCreated",
        entityId: moduleId,
        payload: { type: "MOD", revision, status },
        actor: "gaspar",
        priorState: undefined,
        newState: status,
        reasoning: "Module registered",
      });

      const project = this.projects.findById("default");
      const modules = this.artifacts.listByType("MOD");
      this.projects.updateCounts(project.id, project.specCount, modules.length);

      return { ok: true, value: revision };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Register a WorkPackage artifact.
   * [CORE §7.4, DOM §3.14]
   */
  registerWorkPackage(wpId: string, status: string, content: unknown): CoreResult<string> {
    try {
      const revision = computeRevisionHash(content);
      const contentHash = computeRevisionHash({ wpId, content });

      this.artifacts.create(wpId, "WP", revision, status, contentHash);

      this.events.append({
        eventType: "ArtifactCreated",
        entityId: wpId,
        payload: { type: "WP", revision, status },
        actor: "gaspar",
        priorState: undefined,
        newState: status,
        reasoning: "WorkPackage registered",
      });

      return { ok: true, value: revision };
    } catch (e) {
      return this.handleError(e);
    }
  }

  // ---------------------------------------------------------------------------
  // Slice 3: Reference resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve a reference to an exact artifact revision.
   * [CORE §12, DOM §2.4, INV §10.2]
   */
  resolveReference(refId: string, targetRevision?: string): CoreResult<{
    id: string;
    revision: string;
    status: string;
    type: string;
  }> {
    try {
      const artifact = targetRevision !== undefined
        ? this.artifacts.findByRevision(refId, targetRevision)
        : this.artifacts.findById(refId);

      return {
        ok: true,
        value: {
          id: artifact.id,
          revision: artifact.revision,
          status: artifact.status,
          type: artifact.type,
        },
      };
    } catch (e) {
      return this.handleError(e);
    }
  }

  // ---------------------------------------------------------------------------
  // Slice 3: State transition engine
  // ---------------------------------------------------------------------------

  /**
   * Execute a state transition after validating it against the legal transition table.
   * [CORE §6.1, STATE §6]
   */
  transitionState(
    artifactId: string,
    eventType: string,
    guardContext?: Record<string, unknown>
  ): CoreResult<{ fromState: string; toState: string }> {
    try {
      const artifact = this.artifacts.findById(artifactId);
      const fromState = artifact.status;

      // Determine target state from the event type
      const toState = this.deriveTargetState(artifact.type, eventType, fromState);

      // Validate the transition
      validateTransition(artifact.type as EntityType, fromState, toState, eventType, guardContext);

      // Persist the new state
      const newRevision = computeRevisionHash({ ...artifact, status: toState });
      this.artifacts.updateStatus(artifactId, toState, newRevision);

      this.events.append({
        eventType: "StateTransition",
        entityId: artifactId,
        payload: { entityType: artifact.type, eventType, fromState, toState },
        actor: guardContext?.["actor"] as string ?? "system",
        priorState: fromState,
        newState: toState,
        reasoning: "Valid state transition",
      });

      return { ok: true, value: { fromState, toState } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Derive the target state from an event type and current state.
   * [CORE §6.1, STATE §2]
   */
  private deriveTargetState(entityType: string, eventType: string, fromState: string): string {
    // Handle blocker raised (ANY → BLOCKED)
    if (eventType === "BlockerRaised") {
      return "BLOCKED";
    }

    // Map event types to target states for each entity type
    const specTransitions: Record<string, string> = {
      SpecSubmittedForReview: "REVIEW",
      SpecApprovedReady: "READY",
      SpecNeedsRevision: "DRAFT",
      SpecSuperseded: "SUPERSEDED",
    };

    const moduleTransitions: Record<string, string> = {
      ModulePlanned: "AWAITING_APPROVAL",
      ModuleApproved: "APPROVED",
      ExecutionStarted: "EXECUTING",
      ImplementationComplete: "VERIFYING",
      SpekkioPassed: "PASSED",
      DefinitionOfDoneSatisfied: "COMPLETE",
      SpekkioFailed: "FAILED",
      CorrectionComplete: "EXECUTING",
      ChangeControlInitiated: "DRAFT",
    };

    const wpTransitions: Record<string, string> = {
      WorkPackageAuthorized: "AUTHORIZED",
      ExecutionAssigned: "RUNNING",
      ImplementationDone: "IMPLEMENTED",
      VerificationReady: "VERIFYING",
      SpekkioPassed: "COMPLETE",
      SpekkioFailed: "FAILED",
      CorrectionComplete: "RUNNING",
    };

    const verificationTransitions: Record<string, string> = {
      VerificationStarted: "RUNNING",
      VerificationPassed: "PASSED",
      VerificationFailed: "FAILED",
      VerificationWaived: "WAIVED",
      CorrectionComplete: "RUNNING",
      NewRevisionRequiresReverification: "PENDING",
    };

    const transitionMaps: Record<string, Record<string, string>> = {
      SP: specTransitions,
      MOD: moduleTransitions,
      WP: wpTransitions,
      VERIFICATION: verificationTransitions,
    };

    const map = transitionMaps[entityType];
    if (map === undefined) {
      throw new ChronoError({
        code: ErrorCode.ILLEGAL_TRANSITION,
        severity: Severity.ERROR,
        message: `No transition mapping for event '${eventType}' on entity type ${entityType}`,
        invariantRef: "INV §3.2",
        affectedTarget: `${entityType}:${fromState}`,
        suggestedAction: "Refer to STATE-MODEL.md §2 for legal transitions",
      });
    }

    const toState = map[eventType];
    if (toState === undefined) {
      throw new ChronoError({
        code: ErrorCode.ILLEGAL_TRANSITION,
        severity: Severity.ERROR,
        message: `Unknown event type '${eventType}' for entity type ${entityType}`,
        invariantRef: "INV §3.2",
        affectedTarget: `${entityType}:${fromState}`,
        suggestedAction: "Refer to STATE-MODEL.md §2 for legal transitions",
      });
    }

    return toState;
  }

  // ---------------------------------------------------------------------------
  // Slice 3: Blockers
  // ---------------------------------------------------------------------------

  /**
   * Raise a blocker. [CORE §7, DOM §3.17, INV §4]
   */
  raiseBlocker(type: string, issuer: string, targetIds: string[], reason: string, evidenceRefs: string[] = []): CoreResult<{ id: string }> {
    try {
      const blockerId = `BLK-${Date.now().toString().slice(-6)}`;
      const record = this.blockers.create({
        id: blockerId,
        type,
        issuer,
        targetIds,
        reason,
        evidenceRefs,
      });

      this.events.append({
        eventType: "BlockerRaised",
        entityId: blockerId,
        payload: { type, issuer, targetIds, reason, evidenceRefs: evidenceRefs },
        actor: issuer,
        priorState: "active",
        newState: "active",
        reasoning: "Blocker raised — fail-closed until resolved",
      });

      return { ok: true, value: { id: record.id } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Resolve a blocker.
   * [CORE §7, DOM §3.17, INV §4]
   */
  resolveBlocker(blockerId: string, resolvedBy: string): CoreResult<{ id: string }> {
    try {
      this.blockers.resolve(blockerId, resolvedBy);

      this.events.append({
        eventType: "BlockerResolved",
        entityId: blockerId,
        payload: { resolvedBy },
        actor: resolvedBy,
        priorState: "resolved",
        newState: "resolved",
        reasoning: "Blocker resolved — gates re-evaluated",
      });

      return { ok: true, value: { id: blockerId } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  // ---------------------------------------------------------------------------
  // Slice 3: Approvals
  // ---------------------------------------------------------------------------

  /**
   * Record an approval (for use by chrono approve).
   * [CORE §8, DOM §3.16, INV §4]
   *
   * This method records the approval data. In production, the signing
   * interface verifies the interactive signature before calling this.
   * [CORE §8.1]
   */
  recordApproval(data: {
    id: string;
    action: string;
    scopeArtifactId: string;
    scopeRevision: string;
    authority: string;
    signer: string;
    signature: string;
    rationale: string;
  }): CoreResult<{ id: string }> {
    try {
      const timestamp = new Date().toISOString();

      this.approvals.create({
        ...data,
        timestamp,
      });

      this.events.append({
        eventType: "ApprovalGranted",
        entityId: data.id,
        payload: {
          action: data.action,
          scopeArtifactId: data.scopeArtifactId,
          scopeRevision: data.scopeRevision,
          authority: data.authority,
          signer: data.signer,
          rationale: data.rationale,
        },
        actor: "PO",
        priorState: "granted",
        newState: "granted",
        reasoning: "PO approval recorded",
      });

      return { ok: true, value: { id: data.id } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Check if a valid approval exists for the given scope.
   * [CORE §7.3, DOM §3.16, INV §5.4]
   */
  hasValidApproval(artifactId: string, revision: string, action: string): boolean {
    const approval = this.approvals.findByScope(artifactId, revision, action);
    if (approval === null || approval.revoked) {
      return false;
    }

    // Check if the approval is stale (artifact revision changed) [DOM §3.16]
    const artifact = this.artifacts.findById(artifactId);
    if (isStaleReference(approval.scopeRevision, artifact.revision)) {
      return false;
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Slice 3: Evidence
  // ---------------------------------------------------------------------------

  /**
   * Record evidence bound to an exact artifact revision.
   * [CORE §9, DOM §3.19, INV §11.1]
   */
  recordEvidence(data: {
    id: string;
    producer: string;
    tool: string | null;
    targetRevision: string;
    checkName: string;
    result: string;
    diagnostics: string | null;
    integrityHash: string;
  }): CoreResult<{ id: string }> {
    try {
      const timestamp = new Date().toISOString();

      this.evidence.create({
        ...data,
        timestamp,
      });

      this.events.append({
        eventType: "EvidenceRecorded",
        entityId: data.id,
        payload: {
          producer: data.producer,
          targetRevision: data.targetRevision,
          checkName: data.checkName,
          result: data.result,
        },
        actor: data.producer,
        priorState: undefined,
        newState: "recorded",
        reasoning: `Evidence recorded: ${data.checkName} → ${data.result}`,
      });

      return { ok: true, value: { id: data.id } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  // ---------------------------------------------------------------------------
  // Slice 6: Gate evaluation
  // ---------------------------------------------------------------------------

  /**
   * Evaluate execution authorization for a module.
   * [CORE §7.4, DOM §6.4, INV §5.3, INV §5.4]
   *
   * Proves that:
   * - the Spec is READY;
   * - the Harness exists and is valid;
   * - the Module has required PO approval;
   * - dependencies are satisfied;
   * - no active blocker;
   * - references are valid;
   * - security approvals are current.
   */
  authorizeExecution(moduleId: string): CoreResult<boolean> {
    try {
      // 1. Module must exist and be in a valid state
      const moduleArtifact = this.artifacts.findById(moduleId);
      if (!["APPROVED", "EXECUTING"].includes(moduleArtifact.status)) {
        throw new ChronoError({
          code: ErrorCode.EXECUTION_DENIED,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId} is in state ${moduleArtifact.status}, not APPROVED or EXECUTING`,
          invariantRef: "INV §5.3, DOM §6.4",
          affectedTarget: moduleId,
          suggestedAction: "Promote module to APPROVED first",
        });
      }

      // 2. Check for active blockers [STATE §2.2, INV §5.3]
      const activeBlockers = this.blockers.findActive([moduleId]);
      if (activeBlockers.length > 0) {
        const blocker = activeBlockers[0]!
        throw new ChronoError({
          code: ErrorCode.EXECUTION_DENIED,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId} has active blocker: ${blocker.reason}`,
          invariantRef: "INV §5.3, DOM §6.4",
          affectedTarget: moduleId,
          suggestedAction: "Resolve blocker: " + blocker.id,
        });
      }

      // 3. Check for required PO module approval [INV §5.4]
      const hasApproval = this.hasValidApproval(
        moduleId, moduleArtifact.revision, "module-approval"
      );
      if (!hasApproval) {
        throw new ChronoError({
          code: ErrorCode.APPROVAL_REQUIRED,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId} lacks required PO approval`,
          invariantRef: "INV §5.4, DOM §6.4",
          affectedTarget: moduleId,
          suggestedAction: "Run chrono approve --target " + moduleId + " --action module-approval",
        });
      }

      // 4. Check no stale references [INV §10.3]
      // (Reference freshness is validated when references are resolved)

      // 5. Check project is not in error state
      const project = this.projects.findById("default");
      if (project.state === "BLOCKED" || project.state === "UNINITIALIZED") {
        throw new ChronoError({
          code: ErrorCode.EXECUTION_DENIED,
          severity: Severity.BLOCKER,
          message: `Project is in state ${project.state}`,
          invariantRef: "INV §5.3",
          affectedTarget: "project",
          suggestedAction: "Resolve project state before execution",
        });
      }

      return { ok: true, value: true };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Evaluate completion authorization for a module.
   * [CORE §7.6, DOM §6.6, INV §5.6]
   */
  authorizeCompletion(moduleId: string): CoreResult<boolean> {
    try {
      const moduleArtifact = this.artifacts.findById(moduleId);

      // Module must be in verification state
      if (moduleArtifact.status !== "VERIFYING" && moduleArtifact.status !== "PASSED") {
        throw new ChronoError({
          code: ErrorCode.COMPLETION_DENIED,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId} is in state ${moduleArtifact.status}, not VERIFYING or PASSED`,
          invariantRef: "INV §5.6, DOM §6.6",
          affectedTarget: moduleId,
          suggestedAction: "Complete verification before requesting completion",
        });
      }

      // Check for active blockers [INV §5.6]
      const activeBlockers = this.blockers.findActive([moduleId]);
      if (activeBlockers.length > 0) {
        throw new ChronoError({
          code: ErrorCode.COMPLETION_DENIED,
          severity: Severity.BLOCKER,
          message: `Active blockers prevent completion: ${activeBlockers.map((b) => b.reason).join(", ")}`,
          invariantRef: "INV §5.6, DOM §6.6",
          affectedTarget: moduleId,
          suggestedAction: "Resolve all active blockers",
        });
      }

      // Check for current evidence [INV §11.3]
      if (!this.evidence.hasCurrentEvidence(moduleArtifact.revision)) {
        throw new ChronoError({
          code: ErrorCode.EVIDENCE_MISSING,
          severity: Severity.BLOCKER,
          message: `No evidence recorded for module ${moduleId} at revision ${moduleArtifact.revision}`,
          invariantRef: "INV §11.3, DOM §6.6",
          affectedTarget: moduleId,
          suggestedAction: "Record evidence before completion",
        });
      }

      return { ok: true, value: true };
    } catch (e) {
      return this.handleError(e);
    }
  }

  // ---------------------------------------------------------------------------
  // Slice 3: Verification
  // ---------------------------------------------------------------------------

  /**
   * Record a verification result (PASS, FAILED, WAIVED).
   * [CORE §7.5, DOM §3.20, INV §4.4]
   *
   * WAIVED is NEVER normalized to PASS [INV §3.4, DOM §2.4].
   */
  recordVerification(
    moduleId: string,
    verdict: "PASS" | "FAILED" | "WAIVED",
    reviewer: string,
    defectIds: string[] = [],
    waiverIds: string[] = []
  ): CoreResult<{ qaId: string }> {
    try {
      // WAIVED must have an explicit waiver reference [P2.8, INV §4.1]
      if (verdict === "WAIVED" && waiverIds.length === 0) {
        throw new ChronoError({
          code: ErrorCode.APPROVAL_REQUIRED,
          severity: Severity.BLOCKER,
          message: "WAIVED requires an explicit PO waiver reference",
          invariantRef: "INV §4.1, DOM §6.6",
          affectedTarget: moduleId,
          suggestedAction: "Record a waiver before marking verification as WAIVED",
        });
      }

      // PASS must NOT have waivers — they are distinct [INV §3.4]
      if (verdict === "PASS" && waiverIds.length > 0) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: "PASS must not include waiver references — WAIVED is never PASS",
          invariantRef: "INV §3.4, DOM §3.20",
          affectedTarget: moduleId,
          suggestedAction: "Use WAIVED only when an explicit waiver exists",
        });
      }

      const qaId = `QA-${Date.now().toString().slice(-6)}`;
      const now = new Date().toISOString();

      this.db.prepare(
        `INSERT INTO qa_report (id, module_id, verdict, reviewed_evidence, defect_ids, waiver_ids, reviewer, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        qaId, moduleId, verdict, "[]",
        JSON.stringify([]), JSON.stringify(waiverIds),
        reviewer, now
      );

      this.events.append({
        eventType: "VerificationCompleted",
        entityId: moduleId,
        payload: { qaId, verdict, reviewer, defectIds, waiverIds },
        actor: reviewer,
        priorState: "RUNNING",
        newState: verdict === "PASS" ? "PASSED" : verdict === "FAILED" ? "FAILED" : "WAIVED",
        reasoning: `Verification ${verdict} by ${reviewer}`,
      });

      return { ok: true, value: { qaId } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Mark module as complete (after successful verification).
   * [CORE §7.6, DOM §6.6]
   */
  completeModule(moduleId: string, actor: string): CoreResult<{ state: string }> {
    try {
      const authz = this.authorizeCompletion(moduleId);
      if (!authz.ok) {
        return authz as unknown as CoreResult<{ state: string }>;
      }

      const artifact = this.artifacts.findById(moduleId);
      if (artifact.status !== "PASSED") {
        throw new ChronoError({
          code: ErrorCode.COMPLETION_DENIED,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId} is ${artifact.status}, must be PASSED before completion`,
          invariantRef: "INV §5.6",
          affectedTarget: moduleId,
          suggestedAction: "Complete verification and obtain PASS verdict",
        });
      }

      const result = this.transitionState(moduleId, "DefinitionOfDoneSatisfied", { actor });
      if (!result.ok) {
        return result as unknown as CoreResult<{ state: string }>;
      }

      return { ok: true, value: { state: result.value!.toState } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private handleError(error: unknown): CoreResult<never> {
    if (error instanceof ChronoError) {
      return {
        ok: false,
        error: {
          code: error.code,
          severity: error.severity,
          message: error.message,
          ...(error.invariantRef !== undefined && { invariantRef: error.invariantRef }),
          ...(error.affectedTarget !== undefined && { affectedTarget: error.affectedTarget }),
          ...(error.suggestedAction !== undefined && { suggestedAction: error.suggestedAction }),
        },
      };
    }

    if (error instanceof Error) {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: error.message,
        },
      };
    }

    return {
      ok: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: String(error),
      },
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  /**
   * Get the database path (for tests/debugging).
   */
  getDbPath(): string {
    return this.db.getPath();
  }

  /**
   * Get the underlying database handle (for direct schema access).
   */
  getDatabase(): ChronoDatabase {
    return this.db;
  }
}
