/**
 * CHRONO Core — deterministic application layer.
 * [CORE §16] — All policy decisions live here, not in adapters or prompts.
 * [FW §648] — Fail-closed semantics.
 */

import {
  ChronoDatabase,
  type ProjectRepository,
  type ArtifactRepository,
  type EventLogRepository,
  type ApprovalRepository,
  type BlockerRepository,
  type DefectRepository,
  type EvidenceRepository,
  type SequenceRepository,
  type QaRepository,
  type HarnessRepository,
} from "@chrono/persistence";
import {
  validateTransition,
  isValidState,
  projectProjectState,
  canonicalize,
  computeRevisionHash,
  isRevisionHash,
  isStaleReference,
  parseArtifactId,
  assertBlockerType,
  assertRequiredFields,
  assertValidInitialState,
  buildApprovalPayload,
  buildWaiverPayload,
  parseActorIdentity,
  parseApprovalPublicKey,
  verifyApprovalSignature,
  APPROVAL_ACTIONS,
  AUTHORITY_POLICY_VERSION,
  DEFECT_ROUTING,
  RTK_UPSTREAM,
  SKILL_UPSTREAM,
  isCapable,
  mayEnactEvent,
  ChronoError,
  ErrorCode,
  Severity,
  type CoreOperation,
} from "@chrono/domain";
import type { ProjectState, EntityType, ApprovalPayload, WaiverPayload } from "@chrono/domain";

/**
 * Core configuration (PO-owned, external) [CORE §8, RUNTIME §8]
 */
export interface CoreConfig {
  readonly projectPath: string;
  readonly language?: string;
  readonly gasparAutonomy?: string;
  readonly runtime?: string | null;
  /**
   * Deterministic clock (ISO-8601 UTC producer). Test-only boundary:
   * production code always omits this and receives wall-clock time.
   * Fixtures may inject a fixed clock for reproducible assertions.
   * [Remediation §7 — test-only keys and controlled fixtures]
   */
  readonly clock?: () => string;
  /**
   * Dispatch-grant time-to-live in seconds (default 3600). Bounds how
   * long an authorized dispatch stays enactable [Remediation §3A].
   */
  readonly grantTtlSeconds?: number;
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
  private readonly sequences: SequenceRepository;
  private readonly qa: QaRepository;
  private readonly harnesses: HarnessRepository;
  private readonly defects: DefectRepository;
  private readonly config: CoreConfig;

  constructor(config: CoreConfig) {
    this.config = config;
    this.db = new ChronoDatabase({
      path: `${config.projectPath}/.chrono/chrono.db`,
    });
    try {
      this.db.migrate();
    } catch (e) {
      this.db.close();
      throw e;
    }
    this.projects = this.db.projects();
    this.artifacts = this.db.artifacts();
    this.events = this.db.events();
    this.approvals = this.db.approvals();
    this.blockers = this.db.blockers();
    this.evidence = this.db.evidence();
    this.sequences = this.db.sequences();
    this.qa = this.db.qaReports();
    this.harnesses = this.db.harnesses();
    this.defects = this.db.defects();
  }

  /** Current timestamp from the configured clock (wall-clock unless tests inject one). */
  private now(): string {
    return this.config.clock?.() ?? new Date().toISOString();
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
            code: ErrorCode.PROJECT_EXISTS,
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
      this.projects.create(projectId, language, gasparAutonomy, this.config.runtime ?? null);

      this.events.append({
        eventType: "ProjectInitialized",
        entityId: projectId,
        payload: { language, gasparAutonomy, runtime: this.config.runtime ?? null },
        actor: "PO",
        priorState: undefined,
        newState: "UNINITIALIZED",
        reasoning: "Project created via chrono init",
      });

      this.syncProjectState();
      const synced = this.projects.findById(projectId);

      return {
        ok: true,
        value: { projectId, state: synced.state as ProjectState },
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
      const { project, specs, modules, workPackages, activeBlockers, projected } =
        this.computeProjection();

      return {
        ok: true,
        value: {
          state: projected,
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
            projectedState: projected,
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

  /** Shared deterministic projection inputs [STATE §3.1]. */
  private computeProjection(): {
    project: {
      id: string;
      state: string;
      systemAnalysisComplete: boolean;
      architectureState: string | null;
      gasparAutonomy: string;
      runtime: string | null;
      createdAt: string;
      updatedAt: string;
    };
    specs: ReadonlyArray<{ id: string; revision: string; status: string }>;
    modules: ReadonlyArray<{ id: string; revision: string; status: string }>;
    workPackages: ReadonlyArray<{ id: string; revision: string; status: string }>;
    activeBlockers: ReadonlyArray<{ id: string; type: string; reason: string }>;
    projected: ProjectState;
  } {
    const project = this.projects.findById("default");
    const modules = this.artifacts.listByType("MOD");
    const workPackages = this.artifacts.listByType("WP");
    const specs = this.artifacts.listByType("SP");
    const activeBlockers = this.blockers.findActive();

    const projected = projectProjectState({
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

    return { project, specs, modules, workPackages, activeBlockers, projected };
  }

  /**
   * Persist the deterministic projection after every mutation so the
   * stored project state and the computed projection agree. Divergence
   * afterwards proves external tampering and fails validation.
   */
  private syncProjectState(): void {
    const { project, projected } = this.computeProjection();
    if (project.state !== projected) {
      this.projects.updateState(project.id, projected);
    }
  }

  /**
   * Run deterministic validation of all project reference integrity and consistency.
   * Implements the Consistency Validation Protocol checklist [P7 §3]:
   * identities, schema/required fields, references/revisions, approvals
   * binding, Spec/Harness cardinality, traceability/orphans, DAG, blocker/
   * defect/waiver/evidence status, Security Profile and both PO security
   * decisions, RTK/skill attestations, runtime configuration, and
   * persisted/projected-state agreement.
   *
   * Gate-relevant findings are errors, never informational warnings;
   * persisted/projected divergence is an error [Remediation §5].
   * [CORE §14, INV §13.1, P7.2]
   */
  validate(): CoreResult<{ valid: boolean; errors: string[]; warnings: string[] }> {
    try {
      const errors: string[] = [];
      const warnings: string[] = [];

      const project = this.projects.findById("default");
      const specs = this.artifacts.listByType("SP");
      const modules = this.artifacts.listByType("MOD");
      const workPackages = this.artifacts.listByType("WP");

      this.checkIdentities(errors);
      this.checkTraceability(errors);
      this.checkWorkPackageDag(errors);
      this.checkApprovals(errors);
      this.checkHarnessCardinality(errors, warnings, specs);
      this.checkBlockers(errors);
      this.checkDefects(errors);
      this.checkWaivers(errors);
      this.checkEvidence(errors, warnings);
      this.checkSecurity(errors, specs, modules);
      this.checkAttestations(errors, modules, workPackages);
      this.checkRuntime(errors, warnings, project, modules, workPackages);
      this.checkProjectionAgreement(errors);

      return {
        ok: true,
        value: { valid: errors.length === 0, errors, warnings },
      };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /** Unique, well-formed identities; legal states; revision format; history present [P7 §3]. */
  private checkIdentities(errors: string[]): void {
    const seen = new Set<string>();
    for (const artifact of this.artifacts.listAll()) {
      if (seen.has(artifact.id)) {
        errors.push(`Duplicate artifact ID: ${artifact.id}`);
      }
      seen.add(artifact.id);
      let family: string;
      try {
        family = parseArtifactId(artifact.id).family;
      } catch {
        errors.push(`Malformed artifact identity '${artifact.id}': expected <FAMILY>-<sequence>`);
        continue;
      }
      if (family !== artifact.type) {
        errors.push(`Identity family mismatch: '${artifact.id}' stored as ${artifact.type}`);
      }
      if (!isRevisionHash(artifact.revision)) {
        errors.push(`Artifact ${artifact.id} has invalid revision format`);
      }
      if (!isValidState(artifact.type as EntityType, artifact.status)) {
        errors.push(`Artifact ${artifact.id} has illegal state '${artifact.status}'`);
      }
      try {
        const history = this.artifacts.getHistory(artifact.id);
        if (history.length === 0) {
          errors.push(`Artifact ${artifact.id} has no recorded revision history`);
        }
        // Required content fields survive from registration [DOM §3.9/3.13/3.14].
        if (!artifact.deleted && (artifact.type === "SP" || artifact.type === "MOD" || artifact.type === "WP")) {
          try {
            assertRequiredFields(
              artifact.type as "SP" | "MOD" | "WP",
              JSON.parse(history[0]?.content ?? "null")
            );
          } catch (e) {
            errors.push(`Artifact ${artifact.id} fails schema: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch {
        errors.push(`Artifact ${artifact.id} has no recorded revision history`);
      }
    }
  }

  /** Complete traceability, no orphan work [P7 §3, INV §10.5]. */
  private checkTraceability(errors: string[]): void {
    for (const module of this.artifacts.listByType("MOD")) {
      const specs = this.registrationContent(module.id)["specs"];
      const list = Array.isArray(specs) ? specs : [];
      if (list.length === 0) {
        errors.push(`Orphan module '${module.id}': no Specs traceable`);
        continue;
      }
      for (const spec of list) {
        if (typeof spec !== "string") {
          errors.push(`Module '${module.id}' has a non-identifier Spec reference`);
          continue;
        }
        try {
          const target = this.artifacts.findById(spec);
          if (target.type !== "SP") {
            errors.push(`Module '${module.id}' references non-Spec '${spec}'`);
          }
        } catch {
          errors.push(`Module '${module.id}' references missing Spec '${spec}'`);
        }
      }
    }
    for (const wp of this.artifacts.listByType("WP")) {
      const content = this.registrationContent(wp.id);
      const moduleRef = content["module"];
      if (typeof moduleRef !== "string") {
        errors.push(`Orphan WorkPackage '${wp.id}': no owning Module`);
        continue;
      }
      try {
        const target = this.artifacts.findById(moduleRef);
        if (target.type !== "MOD") {
          errors.push(`WorkPackage '${wp.id}' owned by non-Module '${moduleRef}'`);
        }
      } catch {
        errors.push(`WorkPackage '${wp.id}' references missing Module '${moduleRef}'`);
      }
      const deps = content["dependsOn"];
      const list = Array.isArray(deps) ? deps : [];
      for (const dep of list) {
        if (typeof dep !== "string") {
          errors.push(`WorkPackage '${wp.id}' has a non-identifier dependency`);
          continue;
        }
        try {
          const target = this.artifacts.findById(dep);
          if (target.type !== "WP") {
            errors.push(`WorkPackage '${wp.id}' depends on non-WorkPackage '${dep}'`);
          }
        } catch {
          errors.push(`WorkPackage '${wp.id}' depends on missing '${dep}'`);
        }
      }
    }
    for (const spec of this.artifacts.listByType("SP")) {
      const content = this.registrationContent(spec.id);
      const deps = content["dependencies"];
      const list = Array.isArray(deps) ? deps : [];
      for (const dep of list) {
        if (typeof dep !== "string") {
          errors.push(`Spec '${spec.id}' has a non-identifier dependency`);
          continue;
        }
        try {
          const target = this.artifacts.findById(dep);
          if (target.type !== "SP") {
            errors.push(`Spec '${spec.id}' depends on non-Spec '${dep}'`);
          }
        } catch {
          errors.push(`Spec '${spec.id}' depends on missing '${dep}'`);
        }
      }
    }
    for (const defect of this.db.defects().listAll()) {
      for (const target of defect.affectedArtifacts) {
        try {
          this.artifacts.findById(target);
        } catch {
          errors.push(`Defect '${defect.id}' affects missing artifact '${target}'`);
        }
      }
      for (const ref of defect.evidenceRefs) {
        try {
          this.db.evidence().findById(ref);
        } catch {
          errors.push(`Defect '${defect.id}' references missing evidence '${ref}'`);
        }
      }
    }
  }

  /** Dependency existence and acyclicity over the full WP graph [P7 §3]. */
  private checkWorkPackageDag(errors: string[]): void {
    const edges = new Map<string, string[]>();
    for (const wp of this.artifacts.listByType("WP")) {
      const content = this.registrationContent(wp.id);
      const deps = content["dependsOn"];
      edges.set(wp.id, Array.isArray(deps) ? deps.filter((d): d is string => typeof d === "string") : []);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (node: string, path: string[]): boolean => {
      if (visiting.has(node)) {
        errors.push(`WorkPackage dependency cycle: ${[...path, node].join(" → ")}`);
        return true;
      }
      if (visited.has(node)) {
        return false;
      }
      visiting.add(node);
      for (const next of edges.get(node) ?? []) {
        if (edges.has(next) && visit(next, [...path, node])) {
          return true;
        }
      }
      visiting.delete(node);
      visited.add(node);
      return false;
    };
    for (const id of edges.keys()) {
      visit(id, []);
    }
  }

  /** Required approvals bound to current revisions [P7 §3, INV §5.4]. */
  private checkApprovals(errors: string[]): void {
    for (const approval of this.db.approvals().listAll()) {
      if (approval.revoked) {
        continue;
      }
      const current = this.currentRevisionOf(approval.scopeArtifactId);
      if (current === null) {
        errors.push(`Approval '${approval.id}' scopes unknown artifact '${approval.scopeArtifactId}'`);
        continue;
      }
      if (isStaleReference(approval.scopeRevision, current)) {
        errors.push(
          `Approval '${approval.id}' is stale: '${approval.scopeArtifactId}' moved to ${current}`
        );
      }
      if (approval.signature.trim().length === 0) {
        errors.push(`Approval '${approval.id}' carries no signature`);
      }
    }
  }

  /** One authoritative Harness per READY Spec revision [P7 §3, P3.4]. */
  private checkHarnessCardinality(
    errors: string[],
    warnings: string[],
    specs: ReadonlyArray<{ id: string; revision: string; status: string }>
  ): void {
    for (const spec of specs) {
      let harness: { stale: boolean } | null = null;
      try {
        harness = this.harnesses.findBySpecRevision(spec.revision);
      } catch {
        harness = null;
      }
      if (spec.status === "READY") {
        if (harness === null) {
          errors.push(`READY Spec '${spec.id}' has no Harness for revision ${spec.revision}`);
        } else if (harness.stale) {
          errors.push(`READY Spec '${spec.id}' has a stale Harness for revision ${spec.revision}`);
        }
      } else if (harness !== null && harness.stale) {
        warnings.push(`Harness for '${spec.id}@${spec.revision}' is stale`);
      }
    }
    for (const harness of this.harnesses.listAll()) {
      const owner = specs.find((s) => s.revision === harness.specRevision);
      if (owner === undefined) {
        const known = this.artifacts.listAll().some((a) => {
          try {
            return this.artifacts.getHistory(a.id).some((r) => r.revision === harness.specRevision);
          } catch {
            return false;
          }
        });
        if (!known) {
          errors.push(`Harness for unknown revision ${harness.specRevision} is dangling`);
        }
      }
    }
  }

  /** Every active blocker is a gate-relevant error, never a warning [Remediation §5]. */
  private checkBlockers(errors: string[]): void {
    for (const blocker of this.blockers.findActive()) {
      errors.push(
        `Active blocker '${blocker.id}' [${blocker.type}] targets ${blocker.targetIds.join(", ")} — ${blocker.reason}`
      );
    }
  }

  /** Open defects block; resolved defects are history [P7 §3]. */
  private checkDefects(errors: string[]): void {
    for (const defect of this.db.defects().listAll()) {
      if (defect.status !== "resolved") {
        errors.push(
          `Defect '${defect.id}' [${defect.classification}] is ${defect.status}: ${defect.blockingScope ?? defect.owner}`
        );
      }
    }
  }

  /** Expired/invalidated waivers block; active waivers must cover live revisions [P2.8]. */
  private checkWaivers(errors: string[]): void {
    for (const waiver of this.db.waivers().listAll()) {
      if (waiver.status === "expired" || waiver.status === "invalidated") {
        errors.push(`Waiver '${waiver.id}' is ${waiver.status}: the affected gate is blocked`);
        continue;
      }
      const current = this.currentRevisionOf(waiver.scopeArtifactId);
      if (current === null) {
        errors.push(`Waiver '${waiver.id}' scopes unknown artifact '${waiver.scopeArtifactId}'`);
      } else if (isStaleReference(waiver.scopeRevision, current)) {
        errors.push(
          `Waiver '${waiver.id}' is invalidated by material change: '${waiver.scopeArtifactId}' moved to ${current}`
        );
      }
    }
  }

  /** Evidence binding, format, and freshness [P7 §3, INV §11]. */
  private checkEvidence(errors: string[], warnings: string[]): void {
    for (const evidence of this.db.evidence().listAll()) {
      if (!isRevisionHash(evidence.targetRevision)) {
        errors.push(`Evidence '${evidence.id}' has malformed target revision`);
      }
      if (!isRevisionHash(evidence.integrityHash)) {
        errors.push(`Evidence '${evidence.id}' has malformed integrity hash`);
      }
      if (evidence.checkName.trim().length === 0) {
        errors.push(`Evidence '${evidence.id}' has no check name`);
        continue;
      }
      if (isRevisionHash(evidence.targetRevision) && !this.revisionKnown(evidence.targetRevision)) {
        warnings.push(`Evidence '${evidence.id}' targets unknown revision ${evidence.targetRevision}`);
      }
    }
  }

  private revisionKnown(revision: string): boolean {
    for (const artifact of this.artifacts.listAll()) {
      try {
        if (this.artifacts.getHistory(artifact.id).some((r) => r.revision === revision)) {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  /** Security Profile and both PO security decisions where applicable [P7 §3, INV §7.2]. */
  private checkSecurity(
    errors: string[],
    specs: ReadonlyArray<{ id: string; revision: string; status: string }>,
    modules: ReadonlyArray<{ id: string; revision: string; status: string }>
  ): void {
    const readySpecs = specs.filter((s) => s.status === "READY");
    const advancedModules = modules.filter((m) => m.status !== "DRAFT");
    const securityApplicable = readySpecs.length > 0 || advancedModules.length > 0;
    const profile = this.db.securityProfiles().latest();
    if (securityApplicable && profile === null) {
      errors.push("Missing SecurityProfile: security-applicable work exists without a versioned profile");
      return;
    }
    for (const spec of readySpecs) {
      if (!this.hasValidApproval(spec.id, spec.revision, "architecture-security")) {
        errors.push(
          `READY Spec '${spec.id}' lacks a current Architecture Security Approval`
        );
      }
    }
    for (const module of modules) {
      if (["VERIFYING", "PASSED", "COMPLETE"].includes(module.status)) {
        if (!this.hasValidApproval(module.id, module.revision, "implementation-security")) {
          errors.push(
            `Module '${module.id}' (${module.status}) lacks a current Implementation Security Acceptance`
          );
        }
      }
    }
  }

  /** RTK/skill attestations are required once execution-relevant state exists [P7 §3]. */
  private checkAttestations(
    errors: string[],
    modules: ReadonlyArray<{ status: string }>,
    workPackages: ReadonlyArray<{ status: string }>
  ): void {
    const executionRelevant =
      modules.some((m) => m.status !== "DRAFT" && m.status !== "AWAITING_APPROVAL") ||
      workPackages.some((w) => w.status !== "PLANNED");
    if (!executionRelevant) {
      return;
    }
    const nowMs = Date.parse(this.now());
    const rtk = this.db.rtkAttestations().latest();
    const rtkState = this.attestationState(rtk, nowMs);
    if (rtkState !== "current") {
      errors.push(`RTK attestation ${rtkState}: agent execution requires a current RTKAttestation`);
    }
    const skill = this.db.skillAttestations().latest();
    const skillState = this.attestationState(skill, nowMs);
    if (skillState !== "current") {
      errors.push(
        `Skill attestation ${skillState}: agent execution requires a current SkillAttestation`
      );
    }
  }

  private attestationState(
    attestation: { validUntil: string; status: string; bypassEvents: string[] } | null,
    nowMs: number
  ): string {
    if (attestation === null) {
      return "missing";
    }
    if (attestation.status === "invalid" || attestation.bypassEvents.length > 0) {
      return "invalid";
    }
    if (attestation.status === "stale") {
      return "stale";
    }
    const validUntil = Date.parse(attestation.validUntil);
    if (Number.isNaN(validUntil) || validUntil <= nowMs) {
      return "stale";
    }
    return "current";
  }

  /** Runtime configuration: absent runtime fails execution scope [RUNTIME §8.1]. */
  private checkRuntime(
    errors: string[],
    warnings: string[],
    project: { runtime: string | null },
    modules: ReadonlyArray<{ status: string }>,
    workPackages: ReadonlyArray<{ status: string }>
  ): void {
    const executionRelevant =
      modules.some((m) => m.status !== "DRAFT" && m.status !== "AWAITING_APPROVAL") ||
      workPackages.some((w) => w.status !== "PLANNED");
    if (project.runtime === null || project.runtime.trim().length === 0) {
      if (executionRelevant) {
        errors.push("Runtime not configured: execution requires a PO-selected runtime (CONFIG_ERROR)");
      } else {
        warnings.push("Runtime not configured: select a runtime before execution");
      }
    }
  }

  /** Persisted project state must equal the deterministic projection [Remediation §5]. */
  private checkProjectionAgreement(errors: string[]): void {
    const { project, projected } = this.computeProjection();
    if (project.state !== projected) {
      errors.push(
        `Project state divergence: persisted '${project.state}' but projection computes '${projected}'`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Slice 3: Artifact registration
  // ---------------------------------------------------------------------------

  /**
   * Register a Specification artifact.
   * Validates identity, entry state, required fields, schema, content,
   * and references before anything is persisted [Remediation §2].
   * [CORE §7.3, DOM §3.9]
   */
  registerSpec(specId: string, status: string, content: unknown, actor: string): CoreResult<string> {
    try {
      this.requireCapability("artifact.register", actor);
      this.assertIdentityForType(specId, "SP");
      assertValidInitialState("SP", status);
      assertRequiredFields("SP", content);
      this.assertContentIdMatches(specId, content);
      this.assertStringArray(content["dependencies"], "dependencies", specId, false);
      for (const dep of ((content["dependencies"] as string[] | undefined) ?? [])) {
        this.requireReference(dep, "SP", specId);
      }

      const canonical = canonicalize(content);
      const revision = computeRevisionHash(content);
      const contentHash = computeRevisionHash({ specId, content });

      this.artifacts.create(specId, "SP", revision, status, contentHash, canonical);

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

      this.syncProjectState();
      return { ok: true, value: revision };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Register a Module artifact.
   * [CORE §7.4, DOM §3.13]
   */
  registerModule(moduleId: string, status: string, content: unknown, actor: string): CoreResult<string> {
    try {
      this.requireCapability("artifact.register", actor);
      this.assertIdentityForType(moduleId, "MOD");
      assertValidInitialState("MOD", status);
      assertRequiredFields("MOD", content);
      this.assertContentIdMatches(moduleId, content);
      const specs = this.assertStringArray(content["specs"], "specs", moduleId, true);
      for (const spec of specs ?? []) {
        this.requireReference(spec, "SP", moduleId);
      }

      const canonical = canonicalize(content);
      const revision = computeRevisionHash(content);
      const contentHash = computeRevisionHash({ moduleId, content });

      this.artifacts.create(moduleId, "MOD", revision, status, contentHash, canonical);

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

      this.syncProjectState();
      return { ok: true, value: revision };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Register a WorkPackage artifact.
   * [CORE §7.4, DOM §3.14]
   */
  registerWorkPackage(wpId: string, status: string, content: unknown, actor: string): CoreResult<string> {
    try {
      this.requireCapability("artifact.register", actor);
      this.assertIdentityForType(wpId, "WP");
      assertValidInitialState("WP", status);
      assertRequiredFields("WP", content);
      this.assertContentIdMatches(wpId, content);
      const moduleRef = content["module"];
      if (typeof moduleRef !== "string") {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: `Invalid WP content: 'module' must reference an existing Module`,
          invariantRef: "INV §14.4",
          affectedTarget: wpId,
          suggestedAction: "Set 'module' to the owning Module identifier",
        });
      }
      this.requireReference(moduleRef, "MOD", wpId);
      const dependsOn = this.assertStringArray(content["dependsOn"], "dependsOn", wpId, false) ?? [];
      // Cycle check first: a self-dependency is a cycle even though the
      // node itself does not resolve yet [CORE §12.2].
      this.assertAcyclicWorkPackage(wpId, dependsOn);
      for (const dep of dependsOn) {
        this.requireReference(dep, "WP", wpId);
      }

      const canonical = canonicalize(content);
      const revision = computeRevisionHash(content);
      const contentHash = computeRevisionHash({ wpId, content });

      this.artifacts.create(wpId, "WP", revision, status, contentHash, canonical);

      this.events.append({
        eventType: "ArtifactCreated",
        entityId: wpId,
        payload: { type: "WP", revision, status },
        actor: "gaspar",
        priorState: undefined,
        newState: status,
        reasoning: "WorkPackage registered",
      });

      this.syncProjectState();
      return { ok: true, value: revision };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Record the authoritative Harness for an exact Spec revision.
   * One Harness per executable revision [P6.1]; role views derive from it.
   * Full context-resolution semantics arrive in Slice 7; this minimal
   * registrar exists so the READY gate can verify Harness existence and
   * freshness deterministically [P5.6, P7.5].
   */
  recordHarness(specRevision: string, contentHash: string, content: string, actor: string): CoreResult<string> {
    try {
      this.requireCapability("harness.record", actor);
      if (!isRevisionHash(specRevision)) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: `Invalid spec revision '${specRevision}': expected sha256:<64 lowercase hex>`,
          invariantRef: "INV §14.4",
          affectedTarget: specRevision,
          suggestedAction: "Bind the Harness to the exact Spec revision hash",
        });
      }
      if (!isRevisionHash(contentHash)) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: `Invalid Harness content hash: expected sha256:<64 lowercase hex>`,
          invariantRef: "INV §14.4",
          affectedTarget: specRevision,
          suggestedAction: "Hash the canonical Harness content",
        });
      }
      if (content.trim().length === 0) {
        throw new ChronoError({
          code: ErrorCode.MISSING_REQUIRED_ARTIFACT,
          severity: Severity.ERROR,
          message: `Empty Harness for revision ${specRevision}`,
          invariantRef: "INV §14.4",
          affectedTarget: specRevision,
          suggestedAction: "Provide the minimal curated execution context",
        });
      }
      // The revision must belong to a known Specification.
      const owner = this.artifacts.listByType("SP").find((s) => s.revision === specRevision);
      if (owner === undefined) {
        throw new ChronoError({
          code: ErrorCode.REFERENCE_UNRESOLVABLE,
          severity: Severity.ERROR,
          message: `Harness revision ${specRevision} matches no known Specification revision`,
          invariantRef: "INV §10.2",
          affectedTarget: specRevision,
          suggestedAction: "Register the Spec revision before its Harness",
        });
      }

      const harnessActor = this.requireCapability("harness.record", actor);
      const record = this.harnesses.create({
        specRevision,
        contentHash,
        content,
        generatedAt: this.now(),
      });

      this.events.append({
        eventType: "ArtifactCreated",
        entityId: owner.id,
        payload: { type: "HARNESS", specRevision, contentHash },
        actor: harnessActor,
        priorState: undefined,
        newState: "recorded",
        reasoning: "Authoritative Harness recorded for Spec revision",
      });

      this.syncProjectState();
      return { ok: true, value: record.specRevision };
    } catch (e) {
      return this.handleError(e);
    }
  }

  // ---------------------------------------------------------------------------
  // Architecture lifecycle (minimal gate prerequisite) [P4.8, STATE §2.5]
  //
  // Spec READY requires approved architecture, so the Core exposes the
  // proposal → review → approval lifecycle. Approval requires a valid
  // Architecture Security Approval for the exact revision; Gaspar's
  // semantic work and PO interaction live outside the Core (Slice 8).
  // ---------------------------------------------------------------------------

  /**
   * Propose architecture content (Gaspar-authored, PO-reviewed later).
   *
   * Proposing architecture evidences that system analysis is sufficient
   * to begin architecture without inventing requirements, so the
   * system-analysis completion flag is set here [P1.8: "Completion
   * authorizes architecture analysis only"].
   */
  proposeArchitecture(content: unknown, actor: string): CoreResult<string> {
    try {
      const verifiedActor = this.requireCapability("architecture.propose", actor);
      const canonical = canonicalize(content);
      const revision = computeRevisionHash(content);
      const parsed = JSON.parse(canonical) as { title?: unknown };
      if (typeof parsed.title !== "string" || parsed.title.trim().length === 0) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: "Architecture content must carry a title",
          invariantRef: "INV §14.4",
          affectedTarget: "ARCH",
          suggestedAction: "Describe the proposed architecture with a title",
        });
      }
      this.projects.setArchitecture("default", "ARCH", revision, "proposed");
      this.projects.markSystemAnalysisComplete("default");
      this.events.append({
        eventType: "ArtifactCreated",
        entityId: "ARCH",
        payload: { type: "ARCHITECTURE", revision },
        actor: verifiedActor,
        priorState: undefined,
        newState: "proposed",
        reasoning: "Architecture proposed",
      });
      this.syncProjectState();
      return { ok: true, value: revision };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /** Move proposed architecture to security/architecture review. */
  submitArchitectureForReview(actor: string): CoreResult<string> {
    try {
      this.requireCapability("architecture.enact", actor);
      const project = this.projects.findById("default");
      const fromState = project.architectureState ?? "proposed";
      validateTransition("ARCHITECTURE", fromState, "under_review", "ArchitectureReviewed");
      this.projects.setArchitecture("default", project.architectureId, project.architectureRevision, "under_review");
      this.events.append({
        eventType: "StateTransition",
        entityId: "ARCH",
        payload: { entityType: "ARCHITECTURE", eventType: "ArchitectureReviewed", fromState, toState: "under_review" },
        actor: this.requireActor(actor),
        priorState: fromState,
        newState: "under_review",
        reasoning: "Architecture submitted for review",
      });
      this.syncProjectState();
      return { ok: true, value: project.architectureRevision ?? "" };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Approve architecture. Requires a valid Architecture Security Approval
   * bound to the exact architecture revision [P4.4, STATE §2.5].
   */
  approveArchitecture(actor: string): CoreResult<string> {
    try {
      const verifiedActor = this.requireCapability("architecture.enact", actor);
      const project = this.projects.findById("default");
      const revision = project.architectureRevision;
      if (revision === null) {
        throw new ChronoError({
          code: ErrorCode.MISSING_REQUIRED_ARTIFACT,
          severity: Severity.ERROR,
          message: "No proposed architecture to approve",
          invariantRef: "INV §14.4",
          affectedTarget: "ARCH",
          suggestedAction: "Propose architecture before approving it",
        });
      }
      if (!this.hasValidApproval("ARCH", revision, "architecture-security")) {
        throw new ChronoError({
          code: ErrorCode.APPROVAL_REQUIRED,
          severity: Severity.BLOCKER,
          message: `Architecture approval requires a current Architecture Security Approval for revision ${revision}`,
          invariantRef: "INV §5.5",
          affectedTarget: "ARCH",
          suggestedAction: "Record a signed architecture-security approval for this exact revision",
        });
      }
      const fromState = project.architectureState ?? "under_review";
      validateTransition("ARCHITECTURE", fromState, "approved", "ArchitectureSecurityApproved");
      this.projects.setArchitecture("default", project.architectureId, revision, "approved");
      this.events.append({
        eventType: "StateTransition",
        entityId: "ARCH",
        payload: { entityType: "ARCHITECTURE", eventType: "ArchitectureSecurityApproved", fromState, toState: "approved" },
        actor: verifiedActor,
        priorState: fromState,
        newState: "approved",
        reasoning: "Architecture approved with security approval",
      });
      this.syncProjectState();
      return { ok: true, value: revision };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Mark a Harness stale after material change to its inputs [P6.7].
   * Execution against the stale revision denies until regeneration.
   */
  markHarnessStale(specRevision: string, actor: string): CoreResult<void> {
    try {
      const verifiedActor = this.requireCapability("harness.invalidate", actor);
      this.harnesses.findBySpecRevision(specRevision);
      this.harnesses.markStale(specRevision);
      this.events.append({
        eventType: "StateTransition",
        entityId: specRevision,
        payload: { entityType: "HARNESS", eventType: "HarnessStaled" },
        actor: verifiedActor,
        priorState: "current",
        newState: "stale",
        reasoning: "Harness inputs changed materially",
      });
      return { ok: true, value: undefined };
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
   * Execute a state transition after validating it against the legal
   * transition table AND evaluating every authoritative guard for the
   * event type. Approval, security, Harness, evidence, attestation,
   * dependency, blocker, and role requirements are evaluated by the Core
   * before anything is persisted [CORE §6.1, STATE §6, Remediation §2].
   *
   * Every failure is audited as a DENIED event [CORE §7.7, STATE §6.3].
   */
  transitionState(
    artifactId: string,
    eventType: string,
    guardContext?: Record<string, unknown>
  ): CoreResult<{ fromState: string; toState: string }> {
    let actor = "unknown";
    try {
      actor = this.requireActor(guardContext?.["actor"]);
      // Transition enactment is role-governed (BlockerRaised/Resolved are
      // linkage-governed instead) [Remediation §3A].
      const parsed = parseActorIdentity(actor);
      if (!mayEnactEvent(eventType, parsed.kind, parsed.kind === "agent" ? parsed.role : undefined)) {
        throw new ChronoError({
          code: ErrorCode.EXECUTION_DENIED,
          severity: Severity.BLOCKER,
          message: `Event '${eventType}' on '${artifactId}' is not permitted to '${actor}' (authority policy v${AUTHORITY_POLICY_VERSION})`,
          invariantRef: "INV §5.1",
          affectedTarget: artifactId,
          suggestedAction: "Escalate to the role that owns this transition",
        });
      }
      const artifact = this.artifacts.findById(artifactId);
      const fromState = artifact.status;

      // BlockerResolved re-enters the validated prior state recorded on
      // the resolved blocker — never an arbitrary target [STATE §2.2].
      const toState = eventType === "BlockerResolved"
        ? this.resolveReentryTarget(artifactId, guardContext)
        : this.deriveTargetState(artifact.type, eventType, fromState);

      // Legal-table check first (fail fast on unknown states/events).
      validateTransition(artifact.type as EntityType, fromState, toState, eventType, guardContext);

      // Authoritative per-event guards before persistence.
      this.evaluateTransitionGuards(
        artifact.type, artifactId, artifact.revision, fromState, toState, eventType, guardContext, actor
      );

      // Persist atomically: hash-chained history link, current-pointer
      // status move (the contract revision is unchanged: only material
      // content change produces a new revision [DOM §2.3]), blocker
      // bookkeeping, and the StateTransition audit event. The link commits
      // to the per-artifact transition sequence so repeated transitions
      // (e.g. correction loops) never collide.
      const seq = this.artifacts.getHistory(artifactId).length;
      const link = { previousRevision: artifact.revision, eventType, toState, seq };
      const linkRevision = computeRevisionHash(link);
      const linkContent = canonicalize(link);
      const linkHash = computeRevisionHash({ id: artifactId, revision: linkRevision, status: toState });
      this.db.transaction(() => {
        this.artifacts.appendTransitionRecord(artifactId, linkRevision, toState, linkHash, linkContent);
        if (eventType === "BlockerRaised") {
          // Link the state change to its blocker and record the validated
          // re-entry target [STATE §2.2].
          const blocker = this.activeBlockerOrThrow(guardContext, artifactId);
          this.db.blockers().setPriorState(blocker.id, fromState);
        }
        if (eventType === "ExecutionStarted" || eventType === "ExecutionAssigned") {
          // Single-use grant consumed atomically with the dispatch it opens.
          const grantId = guardContext?.["grantId"] as string;
          this.db.grants().consume(grantId);
        }
        this.events.append({
          eventType: "StateTransition",
          entityId: artifactId,
          payload: { entityType: artifact.type, eventType, fromState, toState },
          actor,
          priorState: fromState,
          newState: toState,
          reasoning: "Valid state transition",
        });
      });

      this.syncProjectState();
      return { ok: true, value: { fromState, toState } };
    } catch (e) {
      this.auditDenial(artifactId, eventType, e, actor);
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
  // Authoritative transition guards [CORE §6.1, STATE §6, Remediation §2]
  // ---------------------------------------------------------------------------

  /**
   * Actor identity is mandatory and must authenticate as a canonical agent
   * role, the PO, or a `<runtime>:<session>` adapter session [RUNTIME §2,
   * DOM §2.2, Remediation §3A]. `luca`, `agent`, case variants, unknown
   * roles, and the machine identity as a caller fail closed — never
   * normalized.
   */
  private requireActor(actor: unknown): string {
    const parsed = parseActorIdentity(actor);
    if (parsed.kind === "system") {
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: "The machine identity cannot invoke protected operations",
        invariantRef: "INV §14.4",
        suggestedAction: "Invoke with a canonical role, PO, or adapter session",
      });
    }
    return parsed.identity;
  }

  /**
   * Capability enforcement against the Core-owned matrix [Remediation §3A].
   * Deny-by-default: unlisted operations and unlisted identities deny with
   * an explicit authorization error. PO passes by supremacy wherever the
   * row lists PO; sessions pass only where the row lists "session".
   */
  private requireCapability(operation: CoreOperation, actor: unknown): string {
    const parsed = parseActorIdentity(actor);
    if (parsed.kind === "system") {
      throw new ChronoError({
        code: ErrorCode.EXECUTION_DENIED,
        severity: Severity.BLOCKER,
        message: `Operation '${operation}' denied to the machine identity`,
        invariantRef: "INV §5.1",
        suggestedAction: "Invoke with a canonical role, PO, or adapter session",
      });
    }
    const allowed = isCapable(
      operation,
      parsed.kind,
      parsed.kind === "agent" ? parsed.role : undefined
    );
    if (!allowed) {
      throw new ChronoError({
        code: ErrorCode.EXECUTION_DENIED,
        severity: Severity.BLOCKER,
        message: `Operation '${operation}' is not permitted to '${parsed.identity}' (authority policy v${AUTHORITY_POLICY_VERSION})`,
        invariantRef: "INV §5.1",
        affectedTarget: parsed.identity,
        suggestedAction: "Escalate to the role that owns this operation",
      });
    }
    return parsed.identity;
  }

  /**
   * BlockerRaised requires a live blocker record targeting the artifact.
   * The state change is linked to its blocker; invented transitions without
   * a recorded blocker are rejected [STATE §2.2, DOM §3.17].
   */
  private activeBlockerOrThrow(
    guardContext: Record<string, unknown> | undefined,
    artifactId: string
  ): { id: string } {
    const blockerId = guardContext?.["blockerId"];
    if (typeof blockerId !== "string" || blockerId.length === 0) {
      throw new ChronoError({
        code: ErrorCode.MISSING_REQUIRED_ARTIFACT,
        severity: Severity.ERROR,
        message: `BlockerRaised for '${artifactId}' requires guardContext.blockerId of an active blocker`,
        invariantRef: "INV §14.4",
        affectedTarget: artifactId,
        suggestedAction: "Raise the blocker first, then pass its id as guardContext.blockerId",
      });
    }
    let blocker: { resolved: boolean; targetIds: string[] };
    try {
      blocker = this.blockers.findById(blockerId);
    } catch {
      throw new ChronoError({
        code: ErrorCode.REFERENCE_UNRESOLVABLE,
        severity: Severity.ERROR,
        message: `Blocker '${blockerId}' does not exist`,
        invariantRef: "INV §10.2",
        affectedTarget: artifactId,
        suggestedAction: "Raise the blocker first, then retry the transition",
      });
    }
    if (blocker.resolved || !blocker.targetIds.includes(artifactId)) {
      throw new ChronoError({
        code: ErrorCode.EXECUTION_DENIED,
        severity: Severity.BLOCKER,
        message: `Blocker '${blockerId}' is not active against '${artifactId}'`,
        invariantRef: "INV §5.1",
        affectedTarget: artifactId,
        suggestedAction: "Raise an active blocker targeting this artifact first",
      });
    }
    return { id: blockerId };
  }

  /**
   * BlockerResolved re-enters the prior state recorded on the resolved
   * blocker. The blocker must already be resolved and must carry a
   * recorded prior state [STATE §2.2].
   */
  private resolveReentryTarget(
    artifactId: string,
    guardContext: Record<string, unknown> | undefined
  ): string {
    const blockerId = guardContext?.["blockerId"];
    if (typeof blockerId !== "string" || blockerId.length === 0) {
      throw new ChronoError({
        code: ErrorCode.MISSING_REQUIRED_ARTIFACT,
        severity: Severity.ERROR,
        message: `BlockerResolved for '${artifactId}' requires guardContext.blockerId`,
        invariantRef: "INV §14.4",
        affectedTarget: artifactId,
        suggestedAction: "Resolve the blocker, then pass its id as guardContext.blockerId",
      });
    }
    let blocker: { resolved: boolean; priorState: string | null };
    try {
      blocker = this.blockers.findById(blockerId);
    } catch {
      throw new ChronoError({
        code: ErrorCode.REFERENCE_UNRESOLVABLE,
        severity: Severity.ERROR,
        message: `Blocker '${blockerId}' does not exist`,
        invariantRef: "INV §10.2",
        affectedTarget: artifactId,
        suggestedAction: "Check the blocker id and try again",
      });
    }
    if (!blocker.resolved) {
      throw new ChronoError({
        code: ErrorCode.EXECUTION_DENIED,
        severity: Severity.BLOCKER,
        message: `Blocker '${blockerId}' is still active: re-entry denied`,
        invariantRef: "INV §5.1",
        affectedTarget: artifactId,
        suggestedAction: "Resolve the blocker before re-entering the prior state",
      });
    }
    if (blocker.priorState === null) {
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: `Blocker '${blockerId}' carries no recorded prior state: no state re-entry applies`,
        invariantRef: "INV §14.4",
        affectedTarget: artifactId,
        suggestedAction: "The blocker is resolved; no artifact transition is required",
      });
    }
    return blocker.priorState;
  }

  /**
   * Per-event deterministic guards evaluated before persistence.
   * Denials use the gate-appropriate code from the error taxonomy
   * [INV §14]; nothing is persisted on denial.
   */
  private evaluateTransitionGuards(
    entityType: string,
    artifactId: string,
    revision: string,
    _fromState: string,
    _toState: string,
    eventType: string,
    guardContext: Record<string, unknown> | undefined,
    actor: string
  ): void {
    switch (`${entityType}:${eventType}`) {
      case "SP:SpecSubmittedForReview":
        this.denyIfBlocked(artifactId);
        break;
      case "SP:SpecApprovedReady":
        this.guardSpecReady(artifactId, revision);
        break;
      case "MOD:ModulePlanned":
        this.guardModulePlanned(artifactId);
        break;
      case "MOD:ModuleApproved":
        this.requireValidApproval(artifactId, revision, "module-approval");
        break;
      case "MOD:ExecutionStarted":
        this.validateExecutionGrant(artifactId, null, guardContext, actor);
        break;
      case "MOD:ImplementationComplete":
        this.denyIfBlocked(artifactId);
        break;
      case "MOD:SpekkioPassed":
        this.requireQaVerdict(artifactId, revision, null, "PASS");
        break;
      case "MOD:DefinitionOfDoneSatisfied":
        this.propagateAuthorization(this.authorizeCompletion(artifactId, actor), artifactId);
        break;
      case "MOD:SpekkioFailed":
        this.requireQaVerdict(artifactId, revision, null, "FAILED");
        break;
      case "MOD:CorrectionComplete":
        this.denyIfBlocked(artifactId);
        this.requireValidApproval(artifactId, revision, "module-approval");
        break;
      case "WP:WorkPackageAuthorized":
        this.guardWorkPackageAuthorized(artifactId);
        break;
      case "WP:ExecutionAssigned":
        this.guardWorkPackageAssigned(artifactId, revision);
        this.validateExecutionGrant(this.workPackageModule(artifactId), artifactId, guardContext, actor);
        break;
      case "WP:ImplementationDone":
      case "WP:VerificationReady":
      case "WP:CorrectionComplete":
        this.denyIfBlocked(artifactId);
        break;
      case "WP:SpekkioPassed":
        this.requireQaVerdict(artifactId, revision, artifactId, "PASS");
        break;
      case "WP:SpekkioFailed":
        this.requireQaVerdict(artifactId, revision, artifactId, "FAILED");
        break;
      default:
        // BlockerRaised / BlockerResolved linkage is enforced by
        // activeBlockerOrThrow / resolveReentryTarget; all other listed
        // events carry no additional deterministic guard.
        break;
    }
    void guardContext;
  }

  /** Any active blocker targeting the artifact denies the transition. */
  private denyIfBlocked(artifactId: string): void {
    const active = this.blockers.findActive([artifactId]);
    if (active.length > 0) {
      const first = active[0]!;
      throw new ChronoError({
        code: ErrorCode.EXECUTION_DENIED,
        severity: Severity.BLOCKER,
        message: `Transition denied: active blocker '${first.id}' targets '${artifactId}'`,
        invariantRef: "INV §5.1",
        affectedTarget: artifactId,
        suggestedAction: `Resolve blocker '${first.id}' first`,
      });
    }
  }

  /** Spec READY prerequisites evaluable deterministically [P5.6, CORE §7.3]. */
  private guardSpecReady(specId: string, revision: string): void {
    const project = this.projects.findById("default");
    if (project.architectureState !== "approved") {
      throw new ChronoError({
        code: ErrorCode.APPROVAL_REQUIRED,
        severity: Severity.BLOCKER,
        message: `Spec '${specId}' cannot become READY: architecture is '${project.architectureState ?? "unset"}', not approved`,
        invariantRef: "INV §5.5",
        affectedTarget: specId,
        suggestedAction: "Approve the architecture before releasing Specs",
      });
    }
    this.requireValidApproval(specId, revision, "architecture-security");
    this.denyIfBlocked(specId);
    let harness: { stale: boolean };
    try {
      harness = this.harnesses.findBySpecRevision(revision);
    } catch {
      throw new ChronoError({
        code: ErrorCode.MISSING_REQUIRED_ARTIFACT,
        severity: Severity.ERROR,
        message: `Spec '${specId}' cannot become READY: no Harness recorded for revision ${revision}`,
        invariantRef: "INV §14.4",
        affectedTarget: specId,
        suggestedAction: "Record the authoritative Harness for this Spec revision first",
      });
    }
    if (harness.stale) {
      throw new ChronoError({
        code: ErrorCode.STALE_REVISION,
        severity: Severity.ERROR,
        message: `Spec '${specId}' cannot become READY: Harness for revision ${revision} is stale`,
        invariantRef: "INV §10.3",
        affectedTarget: specId,
        suggestedAction: "Regenerate the Harness after the material change",
      });
    }
    // Executable content contract: scope and acceptance criteria present
    // in the registration content (later revisions store hash links).
    const parsed = this.registrationContent(specId);
    if (!Array.isArray(parsed["inScope"]) || parsed["inScope"].length === 0) {
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: `Spec '${specId}' cannot become READY: inScope is empty or absent`,
        invariantRef: "INV §14.4",
        affectedTarget: specId,
        suggestedAction: "Define the Spec scope before requesting READY",
      });
    }
    if (!Array.isArray(parsed["acceptanceCriteria"]) || parsed["acceptanceCriteria"].length === 0) {
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: `Spec '${specId}' cannot become READY: acceptanceCriteria is empty or absent`,
        invariantRef: "INV §14.4",
        affectedTarget: specId,
        suggestedAction: "Define testable acceptance criteria before requesting READY",
      });
    }
  }

  /** Planning gate: every module Spec must be READY [STATE §2.2]. */
  private guardModulePlanned(moduleId: string): void {
    for (const specId of this.moduleSpecIds(moduleId)) {
      const spec = this.artifacts.findById(specId);
      if (spec.status !== "READY") {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: `Module '${moduleId}' cannot await approval: Spec '${specId}' is ${spec.status}, not READY`,
          invariantRef: "INV §14.4",
          affectedTarget: moduleId,
          suggestedAction: "Release every module Spec to READY before planning",
        });
      }
    }
    this.denyIfBlocked(moduleId);
  }

  /** Read Spec ids from module registration content. */
  private moduleSpecIds(moduleId: string): string[] {
    const parsed = this.registrationContent(moduleId);
    const specs = parsed["specs"];
    return Array.isArray(specs) ? specs.filter((s): s is string => typeof s === "string") : [];
  }

  /** Module approval must be valid for the exact current revision [INV §5.4]. */
  private requireValidApproval(artifactId: string, revision: string, action: string): void {
    if (!this.hasValidApproval(artifactId, revision, action)) {
      throw new ChronoError({
        code: ErrorCode.APPROVAL_REQUIRED,
        severity: Severity.BLOCKER,
        message: `Missing or stale '${action}' approval for '${artifactId}@${revision}'`,
        invariantRef: "INV §5.4",
        affectedTarget: artifactId,
        suggestedAction: `Record a signed '${action}' approval binding this exact revision`,
      });
    }
  }

  /** Propagate a CoreResult denial as a guard exception (no persistence). */

  /**
   * Validate the dispatch grant presented for an
   * ExecutionStarted/ExecutionAssigned transition. The grant must exist,
   * be unexpired and unconsumed, cover this exact module/work-package
   * revision scope, and match the caller: the assigned role, the bound
   * session, or the orchestrating gaspar/PO. Expired, tampered,
   * cross-scope-reused, and role/session-mismatched grants deny.
   * Consumption happens atomically with the transition itself.
   */
  private validateExecutionGrant(
    moduleId: string,
    workPackageId: string | null,
    guardContext: Record<string, unknown> | undefined,
    actor: string
  ): void {
    const grantId = guardContext?.["grantId"];
    if (typeof grantId !== "string" || grantId.length === 0) {
      throw new ChronoError({
        code: ErrorCode.MISSING_REQUIRED_ARTIFACT,
        severity: Severity.BLOCKER,
        message: `Dispatch requires an execution grant for '${workPackageId ?? moduleId}': authorize first`,
        invariantRef: "INV §5.1",
        affectedTarget: workPackageId ?? moduleId,
        suggestedAction: "Authorize execution to issue a single-use grant, then present its id",
      });
    }
    let grant: {
      moduleId: string;
      workPackageId: string | null;
      moduleRevision: string;
      role: string;
      session: string | null;
      expiresAt: string;
      consumed: boolean;
    };
    try {
      grant = this.db.grants().findById(grantId);
    } catch {
      throw new ChronoError({
        code: ErrorCode.REFERENCE_UNRESOLVABLE,
        severity: Severity.ERROR,
        message: `Dispatch grant '${grantId}' does not exist: forged grants deny`,
        invariantRef: "INV §10.2",
        affectedTarget: workPackageId ?? moduleId,
        suggestedAction: "Authorize execution to issue a genuine grant",
      });
    }
    if (grant.consumed) {
      throw new ChronoError({
        code: ErrorCode.EXECUTION_DENIED,
        severity: Severity.BLOCKER,
        message: `Dispatch grant '${grantId}' was already consumed: replay denied`,
        invariantRef: "INV §5.1",
        affectedTarget: workPackageId ?? moduleId,
        suggestedAction: "Authorize execution again for a fresh grant",
      });
    }
    if (Date.parse(grant.expiresAt) <= Date.parse(this.now())) {
      throw new ChronoError({
        code: ErrorCode.EXECUTION_DENIED,
        severity: Severity.BLOCKER,
        message: `Dispatch grant '${grantId}' expired at ${grant.expiresAt}`,
        invariantRef: "INV §5.1",
        affectedTarget: workPackageId ?? moduleId,
        suggestedAction: "Authorize execution again for a fresh grant",
      });
    }
    const currentModule = this.artifacts.findById(moduleId);
    if (
      grant.moduleId !== moduleId ||
      grant.workPackageId !== workPackageId ||
      grant.moduleRevision !== currentModule.revision
    ) {
      throw new ChronoError({
        code: ErrorCode.INCONSISTENT_REFERENCE,
        severity: Severity.ERROR,
        message: `Dispatch grant '${grantId}' does not cover '${workPackageId ?? moduleId}@${currentModule.revision}'`,
        invariantRef: "INV §10.2",
        affectedTarget: workPackageId ?? moduleId,
        suggestedAction: "Use the grant only for its authorized scope and revision",
      });
    }
    const caller = parseActorIdentity(actor);
    const roleMatches = caller.kind === "agent" && caller.role === grant.role;
    const sessionMatches =
      caller.kind === "session" && grant.session !== null && caller.identity === grant.session;
    const orchestrates =
      (caller.kind === "agent" && caller.role === "gaspar") || caller.kind === "po";
    if (!roleMatches && !sessionMatches && !orchestrates) {
      throw new ChronoError({
        code: ErrorCode.EXECUTION_DENIED,
        severity: Severity.BLOCKER,
        message: `Dispatch grant '${grantId}' is bound to role '${grant.role}'${grant.session === null ? "" : ` and session '${grant.session}'`}: '${actor}' may not enact it`,
        invariantRef: "INV §5.1",
        affectedTarget: workPackageId ?? moduleId,
        suggestedAction: "Enact the dispatch as the assigned role or session",
      });
    }
  }  private propagateAuthorization(
    result: CoreResult<boolean>,
    artifactId: string
  ): void {
    if (!result.ok) {
      const code = (result.error?.code ?? ErrorCode.EXECUTION_DENIED) as (typeof ErrorCode)[keyof typeof ErrorCode];
      throw new ChronoError({
        code,
        severity: Severity.BLOCKER,
        message: result.error?.message ?? `Authorization denied for '${artifactId}'`,
        invariantRef: result.error?.invariantRef ?? "INV §5.1",
        affectedTarget: artifactId,
        suggestedAction: result.error?.suggestedAction ?? "Satisfy the gate prerequisites first",
      });
    }
  }

  /** QA verdict of the required kind must be bound to the exact revision. */
  private requireQaVerdict(
    targetId: string,
    revision: string,
    workPackageId: string | null,
    verdict: "PASS" | "FAILED"
  ): void {
    const reports = workPackageId === null
      ? this.qa.listByModule(targetId)
      : this.qa.listByWorkPackage(workPackageId);
    const bound = workPackageId === null ? "moduleRevision" : "workPackageRevision";
    const relevant = reports.filter((r) => r.verdict === verdict && r[bound] === revision);
    if (relevant.length === 0) {
      throw new ChronoError({
        code: verdict === "PASS" ? ErrorCode.COMPLETION_DENIED : ErrorCode.MISSING_REQUIRED_ARTIFACT,
        severity: Severity.BLOCKER,
        message: `No ${verdict} QA verdict bound to '${targetId}@${revision}'`,
        invariantRef: "INV §11.3",
        affectedTarget: targetId,
        suggestedAction: "Record the Spekkio verification verdict for this exact revision first",
      });
    }
  }

  /** WP authorization: owning module approved/executing, deps satisfied, unblocked. */
  private guardWorkPackageAuthorized(wpId: string): void {
    const moduleId = this.workPackageModule(wpId);
    const module = this.artifacts.findById(moduleId);
    if (module.status !== "APPROVED" && module.status !== "EXECUTING") {
      throw new ChronoError({
        code: ErrorCode.EXECUTION_DENIED,
        severity: Severity.BLOCKER,
        message: `WorkPackage '${wpId}' cannot be authorized: owning Module '${moduleId}' is ${module.status}`,
        invariantRef: "INV §5.3",
        affectedTarget: wpId,
        suggestedAction: "Approve the owning Module before authorizing its Work Packages",
      });
    }
    for (const dep of this.readDependsOn(wpId)) {
      const depArtifact = this.artifacts.findById(dep);
      if (!["IMPLEMENTED", "VERIFYING", "COMPLETE"].includes(depArtifact.status)) {
        throw new ChronoError({
          code: ErrorCode.EXECUTION_DENIED,
          severity: Severity.BLOCKER,
          message: `WorkPackage '${wpId}' cannot be authorized: dependency '${dep}' is ${depArtifact.status}`,
          invariantRef: "INV §10.4",
          affectedTarget: wpId,
          suggestedAction: "Complete predecessor Work Packages before authorizing dependents",
        });
      }
    }
    this.denyIfBlocked(wpId);
  }

  /** WP dispatch: module approved/executing, module approval current, unblocked. */
  private guardWorkPackageAssigned(wpId: string, revision: string): void {
    const moduleId = this.workPackageModule(wpId);
    const module = this.artifacts.findById(moduleId);
    if (module.status !== "APPROVED" && module.status !== "EXECUTING") {
      throw new ChronoError({
        code: ErrorCode.EXECUTION_DENIED,
        severity: Severity.BLOCKER,
        message: `WorkPackage '${wpId}' cannot start: owning Module '${moduleId}' is ${module.status}`,
        invariantRef: "INV §5.3",
        affectedTarget: wpId,
        suggestedAction: "Approve the owning Module first",
      });
    }
    this.requireValidApproval(moduleId, module.revision, "module-approval");
    this.denyIfBlocked(wpId);
    void revision;
  }

  /** Read the owning module from WP registration content. */
  private workPackageModule(wpId: string): string {
    const parsed = this.registrationContent(wpId);
    if (typeof parsed["module"] !== "string") {
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: `WorkPackage '${wpId}' has no owning module`,
        invariantRef: "INV §14.4",
        affectedTarget: wpId,
        suggestedAction: "Register the Work Package with its owning Module",
      });
    }
    return parsed["module"] as string;
  }

  /**
   * Audit every transition failure as a DENIED event [CORE §7.7, STATE §6.3].
   * Audit writes never mask the original denial.
   */
  private auditDenial(artifactId: string, eventType: string, error: unknown, actor: string): void {
    try {
      const code = error instanceof ChronoError ? error.code : ErrorCode.VALIDATION_ERROR;
      const reason = error instanceof Error ? error.message : String(error);
      this.events.append({
        eventType: "DENIED",
        entityId: artifactId,
        payload: { eventType, code, reason },
        actor,
        priorState: undefined,
        newState: undefined,
        reasoning: `Denied ${eventType}: ${code}`,
      });
    } catch {
      // Audit failure must not mask or convert the original denial.
    }
  }

  // ---------------------------------------------------------------------------
  // Slice 3: Blockers
  // ---------------------------------------------------------------------------

  /**
   * Raise a blocker. Validates type, issuer identity, and target
   * references before persisting [DOM §3.17, INV §10.2, Remediation §2].
   * [CORE §7, DOM §3.17, INV §4]
   */
  raiseBlocker(type: string, issuer: string, targetIds: string[], reason: string, evidenceRefs: string[] = []): CoreResult<{ id: string }> {
    try {
      assertBlockerType(type);
      const verifiedIssuer = this.requireCapability("blocker.raise", issuer);
      if (type === "SECURITY_BLOCKER" && verifiedIssuer !== "glenn" && verifiedIssuer !== "PO") {
        throw new ChronoError({
          code: ErrorCode.EXECUTION_DENIED,
          severity: Severity.BLOCKER,
          message: `SECURITY_BLOCKER is Glenn's authority: issuance by '${verifiedIssuer}' denied`,
          invariantRef: "INV §5.1",
          suggestedAction: "Escalate security findings to Glenn",
        });
      }
      if (targetIds.length === 0) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: "A blocker must target at least one artifact",
          invariantRef: "INV §14.4",
          suggestedAction: "List the affected artifact identifiers",
        });
      }
      if (reason.trim().length === 0) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: "A blocker must carry a reason",
          invariantRef: "INV §14.4",
          suggestedAction: "Describe the condition preventing the gate",
        });
      }
      for (const target of targetIds) {
        if (target !== "default") {
          this.requireReference(target, this.artifactTypeOf(target), type);
        }
      }

      const blockerId = this.sequences.allocate("BLK");
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
        payload: { type, issuer: verifiedIssuer, targetIds, reason, evidenceRefs: evidenceRefs },
        actor: verifiedIssuer,
        priorState: undefined,
        newState: "active",
        reasoning: "Blocker raised — fail-closed until resolved",
      });

      this.syncProjectState();
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
      const verifiedResolver = this.requireCapability("blocker.resolve", resolvedBy);
      this.blockers.resolve(blockerId, verifiedResolver);

      this.events.append({
        eventType: "BlockerResolved",
        entityId: blockerId,
        payload: { resolvedBy: verifiedResolver },
        actor: verifiedResolver,
        priorState: "active",
        newState: "resolved",
        reasoning: "Blocker resolved — gates re-evaluated",
      });

      this.syncProjectState();
      return { ok: true, value: { id: blockerId } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  // ---------------------------------------------------------------------------
  // PO authority: keys, signed approvals, signed waivers
  // [ADR-003, CORE §8, P2.10, FW §13, Remediation §3]
  // ---------------------------------------------------------------------------

  /**
   * Human-authority entry points (key registration, approvals, waivers)
   * require a live interactive terminal. This is enforced in the Core —
   * not only in the CLI — so non-terminal direct callers (scripts,
   * adapters-as-libraries, redirected input) cannot mint authority even
   * when they reach these methods. Tests simulate a terminal via a
   * test-local TTY fake; production code paths never do.
   * [ADR-003, P2.10, Remediation §3]
   */
  private requireInteractiveAuthority(caller: string): void {
    if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
      return;
    }
    throw new ChronoError({
      code: ErrorCode.NOT_INTERACTIVE,
      severity: Severity.BLOCKER,
      message: `${caller} requires an interactive human terminal`,
      invariantRef: "INV §4.6",
      suggestedAction: "Run this command in a live terminal as the Product Owner; agents and scripts cannot approve",
    });
  }

  /**
   * Register the PO Ed25519 public key (SPKI PEM) for this project.
   *
   * First registration (trust on first interactive use) stores the key.
   * Any later registration is a rotation and requires a valid signature
   * from the CURRENT key over the canonical rotation payload — otherwise
   * an agent could substitute its own key [ADR-003, INV §4.2].
   */
  registerPoPublicKey(
    publicKeyPem: string,
    rotation?: {
      signature: string;
      authority: string;
      rationale: string;
      timestamp: string;
    }
  ): CoreResult<void> {
    try {
      this.requireInteractiveAuthority("PO key registration");
      parseApprovalPublicKey(publicKeyPem);
      const existing = this.db.runtimeConfig().get("po.public_key");
      if (existing === null) {
        if (rotation !== undefined) {
          throw new ChronoError({
            code: ErrorCode.VALIDATION_ERROR,
            severity: Severity.ERROR,
            message: "No PO key registered: rotation fields are unexpected",
            invariantRef: "INV §14.4",
            suggestedAction: "Register the initial PO public key without rotation fields",
          });
        }
        this.db.runtimeConfig().set("po.public_key", publicKeyPem);
        this.events.append({
          eventType: "ArtifactCreated",
          entityId: "PO-KEY",
          payload: { type: "PO_PUBLIC_KEY" },
          actor: "PO",
          priorState: undefined,
          newState: "registered",
          reasoning: "PO signing key registered",
        });
        return { ok: true, value: undefined };
      }

      if (rotation === undefined) {
        throw new ChronoError({
          code: ErrorCode.APPROVAL_REQUIRED,
          severity: Severity.BLOCKER,
          message: "A PO key is already registered: rotation requires the current key signature",
          invariantRef: "INV §4.6",
          affectedTarget: "PO-KEY",
          suggestedAction: "Sign the rotation payload with the current PO key",
        });
      }
      this.assertFreshTimestamp(rotation.timestamp, "PO-KEY");
      const payload = buildApprovalPayload({
        action: "key-rotation",
        scopeArtifactId: "PO-KEY",
        scopeRevision: computeRevisionHash(existing),
        authority: rotation.authority,
        rationale: rotation.rationale,
        timestamp: rotation.timestamp,
      });
      const key = parseApprovalPublicKey(existing);
      if (!verifyApprovalSignature(payload, rotation.signature, key)) {
        throw new ChronoError({
          code: ErrorCode.SIGNATURE_INVALID,
          severity: Severity.ERROR,
          message: "Key rotation signature invalid under the current PO key",
          invariantRef: "INV §4.3",
          affectedTarget: "PO-KEY",
          suggestedAction: "Sign the rotation payload with the current PO private key",
        });
      }
      this.db.runtimeConfig().set("po.public_key", publicKeyPem);
      this.events.append({
        eventType: "ArtifactCreated",
        entityId: "PO-KEY",
        payload: { type: "PO_PUBLIC_KEY_ROTATION" },
        actor: "PO",
        priorState: "registered",
        newState: "registered",
        reasoning: "PO signing key rotated",
      });
      return { ok: true, value: undefined };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Timestamps bound in signatures must be well-formed ISO-8601 and must
   * not lie in the future beyond a small clock-skew allowance. Past
   * timestamps remain valid: history is append-only, and replay of a
   * recorded payload collides on scope identity (DUPLICATE_IDENTITY).
   */
  private assertFreshTimestamp(timestamp: string, target: string): void {
    const time = Date.parse(timestamp);
    if (Number.isNaN(time)) {
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: `Invalid timestamp '${timestamp}': expected ISO-8601 UTC`,
        invariantRef: "INV §14.4",
        affectedTarget: target,
        suggestedAction: "Sign with the current UTC time",
      });
    }
    const skewAllowanceMs = 5 * 60 * 1000;
    if (time > Date.parse(this.now()) + skewAllowanceMs) {
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: `Timestamp '${timestamp}' lies in the future`,
        invariantRef: "INV §14.4",
        affectedTarget: target,
        suggestedAction: "Sign with the current UTC time",
      });
    }
  }

  /** Project-registered PO public key, or null when none is registered. */
  private poPublicKey(): string | null {
    return this.db.runtimeConfig().get("po.public_key");
  }

  /**
   * Record a signed PO approval. The identifier is Core-allocated; the
   * signature is verified cryptographically against the project-registered
   * PO key over the canonical ADR-003 payload. An arbitrary non-empty
   * signature is never valid [ADR-003, CORE §8, INV §4.3].
   *
   * Interactivity (TTY) and keychain custody are enforced by the
   * `chrono approve` command path; the Core verifies cryptography, scope
   * binding, and freshness so direct calls cannot forge authority.
   */
  recordApproval(data: {
    action: string;
    scopeArtifactId: string;
    scopeRevision: string;
    authority: string;
    rationale: string;
    timestamp: string;
    signature: string;
  }): CoreResult<{ id: string }> {
    try {
      this.requireInteractiveAuthority("PO approval");
      if (!(APPROVAL_ACTIONS as readonly string[]).includes(data.action)) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: `Unknown approval action '${data.action}': use chrono waive for waivers and risk acceptance`,
          invariantRef: "INV §14.4",
          affectedTarget: data.scopeArtifactId,
          suggestedAction: `Use one of: ${APPROVAL_ACTIONS.join(", ")}`,
        });
      }
      if (data.authority.trim().length === 0 || data.rationale.trim().length === 0) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: "Approval requires a signer authority and a rationale",
          invariantRef: "INV §14.4",
          affectedTarget: data.scopeArtifactId,
          suggestedAction: "Provide the PO identity and the decision rationale",
        });
      }
      this.assertFreshTimestamp(data.timestamp, data.scopeArtifactId);

      // Cryptographic verification first: a tampered field must fail as
      // SIGNATURE_INVALID before any scope reasoning [ADR-003].
      const unsigned = buildApprovalPayload({
        action: data.action,
        scopeArtifactId: data.scopeArtifactId,
        scopeRevision: data.scopeRevision,
        authority: data.authority,
        rationale: data.rationale,
        timestamp: data.timestamp,
      });
      this.verifySignatureOrThrow(unsigned, data.signature, data.scopeArtifactId);

      const scopeRevision = this.assertLiveScopeRevision(
        data.scopeArtifactId, data.scopeRevision, data.action
      );

      const id = this.sequences.allocate("APR");
      try {
        this.approvals.create({
          id,
          action: data.action,
          scopeArtifactId: data.scopeArtifactId,
          scopeRevision,
          authority: data.authority,
          signer: data.authority,
          signature: data.signature,
          rationale: data.rationale,
          timestamp: data.timestamp,
        });
      } catch (e) {
        throw this.mapConstraintToDuplicate(e, id);
      }

      this.events.append({
        eventType: "ApprovalGranted",
        entityId: id,
        payload: {
          action: data.action,
          scopeArtifactId: data.scopeArtifactId,
          scopeRevision,
          authority: data.authority,
          rationale: data.rationale,
          policyVersion: AUTHORITY_POLICY_VERSION,
        },
        actor: "PO",
        priorState: "granted",
        newState: "granted",
        reasoning: "PO approval recorded",
      });

      this.syncProjectState();
      return { ok: true, value: { id } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Record a signed PO waiver. Same cryptographic bar as approvals, plus
   * the waiver-specific fields [CORE §8.3, DOM §3.24]. The identifier is
   * Core-allocated.
   */
  recordWaiver(data: {
    scopeArtifactId: string;
    scopeRevision: string;
    authority: string;
    issue: string;
    rationale: string;
    evidenceRef: string | null;
    compensatingControls: string | null;
    followUpTaskId: string | null;
    expiryReviewCondition: string;
    timestamp: string;
    signature: string;
  }): CoreResult<{ id: string }> {
    try {
      this.requireInteractiveAuthority("PO waiver");
      for (const [field, value] of [
        ["authority", data.authority],
        ["issue", data.issue],
        ["rationale", data.rationale],
        ["expiryReviewCondition", data.expiryReviewCondition],
      ] as const) {
        if (value.trim().length === 0) {
          throw new ChronoError({
            code: ErrorCode.VALIDATION_ERROR,
            severity: Severity.ERROR,
            message: `Waiver requires a non-empty ${field}`,
            invariantRef: "INV §14.4",
            affectedTarget: data.scopeArtifactId,
            suggestedAction: `Provide the waiver ${field}`,
          });
        }
      }
      this.assertFreshTimestamp(data.timestamp, data.scopeArtifactId);

      // Cryptographic verification before scope reasoning [ADR-003].
      this.verifySignatureOrThrow(
        buildWaiverPayload({
          scopeArtifactId: data.scopeArtifactId,
          scopeRevision: data.scopeRevision,
          authority: data.authority,
          issue: data.issue,
          rationale: data.rationale,
          evidenceRef: data.evidenceRef,
          compensatingControls: data.compensatingControls,
          followUpTaskId: data.followUpTaskId,
          expiryReviewCondition: data.expiryReviewCondition,
          timestamp: data.timestamp,
        }),
        data.signature,
        data.scopeArtifactId
      );
      const scopeRevision = this.assertLiveScopeRevision(
        data.scopeArtifactId, data.scopeRevision, "waiver"
      );

      const id = this.sequences.allocate("WAIVER");
      this.db.waivers().create({
        id,
        issue: data.issue,
        scopeArtifactId: data.scopeArtifactId,
        scopeRevision,
        rationale: data.rationale,
        evidenceRef: data.evidenceRef,
        acceptingAuthority: data.authority,
        compensatingControls: data.compensatingControls,
        followUpTaskId: data.followUpTaskId,
        expiryReviewCondition: data.expiryReviewCondition,
        timestamp: data.timestamp,
        signature: data.signature,
      });

      this.events.append({
        eventType: "WaiverGranted",
        entityId: id,
        payload: {
          scopeArtifactId: data.scopeArtifactId,
          scopeRevision,
          authority: data.authority,
          issue: data.issue,
          policyVersion: AUTHORITY_POLICY_VERSION,
        },
        actor: "PO",
        priorState: undefined,
        newState: "active",
        reasoning: "PO waiver recorded",
      });

      this.syncProjectState();
      return { ok: true, value: { id } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Validate that a signature scope is live: well-formed revision bound to
   * the scope's exact current revision. Stale-at-birth bindings are
   * refused [DOM §3.16, INV §4.4].
   */
  private assertLiveScopeRevision(scopeId: string, scopeRevision: string, action: string): string {
    if (!isRevisionHash(scopeRevision)) {
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: `Invalid scope revision for '${action}': expected sha256:<64 lowercase hex>`,
        invariantRef: "INV §14.4",
        affectedTarget: scopeId,
        suggestedAction: "Bind the decision to the exact current revision hash",
      });
    }
    const current = this.currentRevisionOf(scopeId);
    if (current === null) {
      throw new ChronoError({
        code: ErrorCode.REFERENCE_UNRESOLVABLE,
        severity: Severity.ERROR,
        message: `Approval scope '${scopeId}' does not exist`,
        invariantRef: "INV §10.2",
        affectedTarget: scopeId,
        suggestedAction: "Scope the decision to an existing artifact or ARCH",
      });
    }
    if (isStaleReference(scopeRevision, current)) {
      throw new ChronoError({
        code: ErrorCode.STALE_REVISION,
        severity: Severity.ERROR,
        message: `Stale scope revision for '${action}': '${scopeId}' is at ${current}`,
        invariantRef: "INV §4.4",
        affectedTarget: scopeId,
        suggestedAction: "Re-issue the decision against the current revision",
      });
    }
    return scopeRevision;
  }

  /**
   * Cryptographic verification against the project-registered PO key.
   * No key → APPROVAL_REQUIRED; bad signature → SIGNATURE_INVALID.
   * There is no fallback path [ADR-003, INV §4.6].
   */
  private verifySignatureOrThrow(
    payload: ApprovalPayload | WaiverPayload,
    signature: string,
    scopeId: string
  ): void {
    const registered = this.poPublicKey();
    if (registered === null) {
      throw new ChronoError({
        code: ErrorCode.APPROVAL_REQUIRED,
        severity: Severity.BLOCKER,
        message: "No PO signing key registered for this project",
        invariantRef: "INV §4.6",
        affectedTarget: scopeId,
        suggestedAction: "Register the PO key with chrono keys register first",
      });
    }
    const key = parseApprovalPublicKey(registered);
    if (!verifyApprovalSignature(payload, signature, key)) {
      throw new ChronoError({
        code: ErrorCode.SIGNATURE_INVALID,
        severity: Severity.ERROR,
        message: `Invalid PO signature for scope '${scopeId}'`,
        invariantRef: "INV §4.3",
        affectedTarget: scopeId,
        suggestedAction: "Sign the exact canonical payload with the registered PO key",
      });
    }
  }

  /** Map SQLite uniqueness violations to DUPLICATE_IDENTITY. */
  private mapConstraintToDuplicate(error: unknown, id: string): ChronoError {
    const code = (error as { code?: string }).code;
    if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") {
      return new ChronoError({
        code: ErrorCode.DUPLICATE_IDENTITY,
        severity: Severity.ERROR,
        message: `Record ${id} already exists`,
        invariantRef: "INV §10.1",
        affectedTarget: id,
        suggestedAction: "The matching record already persists; resolve it instead of duplicating",
      });
    }
    if (error instanceof ChronoError) {
      return error;
    }
    return new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: error instanceof Error ? error.message : String(error),
      invariantRef: "INV §14.4",
      affectedTarget: id,
    });
  }

  /**
   * Check if a valid approval exists for the given scope.
   * The approval must be bound to the scope's exact current revision;
   * material change invalidates it. Every stored approval was
   * cryptographically verified at record time [DOM §3.16, INV §5.4].
   */
  hasValidApproval(artifactId: string, revision: string, action: string): boolean {
    const approval = this.approvals.findByScope(artifactId, revision, action);
    if (approval === null || approval.revoked) {
      return false;
    }

    const current = this.currentRevisionOf(artifactId);
    if (current === null || isStaleReference(approval.scopeRevision, current)) {
      return false;
    }

    return true;
  }

  /**
   * Current revision of an approval scope: artifact rows, the ARCH
   * architecture singleton (tracked on the project row), or null when
   * the scope is unknown.
   */
  private currentRevisionOf(scopeId: string): string | null {
    if (scopeId === "ARCH") {
      return this.projects.findById("default").architectureRevision;
    }
    try {
      return this.artifacts.findById(scopeId).revision;
    } catch {
      return null;
    }
  }

  /**
   * Secret-material patterns rejected from persisted payloads.
   * Conservative by design: name/value assignments with secret-like names,
   * bearer tokens, well-known token prefixes, and PEM private keys
   * [RUNTIME §10.3, INV §14.5].
   */
  private assertNoSecrets(checkName: string, diagnostics: string | null, source: string): void {
    const haystacks = [checkName, diagnostics ?? ""];
    const patterns: RegExp[] = [
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
      /\b(api[_-]?key|api[_-]?secret|client[_-]?secret|auth[_-]?token|access[_-]?token|secret[_-]?key|aws_secret_access_key)\s*[:=]\s*['"]?[A-Za-z0-9_\-+/=]{8,}['"]?/i,
      /\b(password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/i,
      /\bbearer\s+[A-Za-z0-9_\-.~+/=]{8,}/i,
      /\bgh[pousr]_[A-Za-z0-9]{8,}/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /\bxox[baprs]-[A-Za-z0-9-]+/,
    ];
    for (const haystack of haystacks) {
      for (const pattern of patterns) {
        if (pattern.test(haystack)) {
          throw new ChronoError({
            code: ErrorCode.SECRET_DETECTED,
            severity: Severity.ERROR,
            message: `Secret material detected in ${source} payload: refusing to persist`,
            invariantRef: "INV §14.5",
            suggestedAction: "Redact secrets before recording evidence",
          });
        }
      }
    }
  }

  /**
   * Record a versioned Security Profile [DOM §3.21, P1.6].
   * Versions are append-only and monotonic; currency against material
   * change is evaluated at the gates, not here.
   */
  recordSecurityProfile(content: unknown, actor: string): CoreResult<{ id: string; version: number }> {
    try {
      const profileActor = this.requireCapability("security.profile", actor);
      const canonical = canonicalize(content);
      const parsed = JSON.parse(canonical) as { title?: unknown };
      if (typeof parsed.title !== "string" || parsed.title.trim().length === 0) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: "Security Profile content must carry a title",
          invariantRef: "INV §14.4",
          suggestedAction: "Describe the profile scope with a title",
        });
      }
      const contentHash = computeRevisionHash(content);
      const latest = this.db.securityProfiles().latest();
      const version = (latest?.version ?? 0) + 1;
      const id = this.sequences.allocate("SEC");
      this.db.securityProfiles().create(id, version, contentHash);
      this.events.append({
        eventType: "ArtifactCreated",
        entityId: id,
        payload: { type: "SECURITY_PROFILE", version, contentHash },
        actor: profileActor,
        priorState: undefined,
        newState: "recorded",
        reasoning: "Security Profile version recorded",
      });
      this.syncProjectState();
      return { ok: true, value: { id, version } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Record a classified defect (Spekkio verdicts reference these).
   * Owner derives from the classification routing table [DOM §3.18].
   */
  recordDefect(
    data: {
      classification: string;
      severity: string;
      evidenceRefs: string[];
      affectedCriteria: string[];
      affectedArtifacts: string[];
      blockingScope: string | null;
      reproInfo: string | null;
    },
    actor: string
  ): CoreResult<{ id: string }> {
    try {
      const verifiedActor = this.requireCapability("defect.record", actor);
      const owner = (DEFECT_ROUTING as Record<string, string>)[data.classification];
      if (owner === undefined) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: `Unknown defect classification '${data.classification}'`,
          invariantRef: "INV §14.4",
          suggestedAction: `Use one of: ${Object.keys(DEFECT_ROUTING).join(", ")}`,
        });
      }
      if (data.severity.trim().length === 0) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: "Defect requires a severity",
          invariantRef: "INV §14.4",
          suggestedAction: "Classify the defect severity",
        });
      }
      for (const target of data.affectedArtifacts) {
        this.requireReference(target, this.artifactTypeOf(target), "defect");
      }
      for (const ref of data.evidenceRefs) {
        try {
          this.db.evidence().findById(ref);
        } catch {
          throw new ChronoError({
            code: ErrorCode.REFERENCE_UNRESOLVABLE,
            severity: Severity.ERROR,
            message: `Defect evidence '${ref}' does not exist`,
            invariantRef: "INV §10.2",
            suggestedAction: "Record the evidence before referencing it",
          });
        }
      }

      const id = this.sequences.allocate("DEF");
      this.defects.create({
        id,
        classification: data.classification,
        severity: data.severity,
        evidenceRefs: data.evidenceRefs,
        affectedCriteria: data.affectedCriteria,
        affectedArtifacts: data.affectedArtifacts,
        owner,
        blockingScope: data.blockingScope,
        reproInfo: data.reproInfo,
      });
      this.events.append({
        eventType: "DefectRaised",
        entityId: id,
        payload: { classification: data.classification, owner },
        actor: verifiedActor,
        priorState: undefined,
        newState: "open",
        reasoning: `Defect classified ${data.classification}, routed to ${owner}`,
      });
      this.syncProjectState();
      return { ok: true, value: { id } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /** Mark a defect resolved after correction and re-verification. */
  resolveDefect(id: string, actor: string): CoreResult<{ id: string }> {
    try {
      const parsed = parseActorIdentity(actor);
      const defect = this.defects.findById(id);
      const isOwner = parsed.kind === "agent" && parsed.role === defect.owner;
      if (!isOwner && parsed.kind !== "po") {
        throw new ChronoError({
          code: ErrorCode.EXECUTION_DENIED,
          severity: Severity.BLOCKER,
          message: `Defect '${id}' is owned by '${defect.owner}': resolution by '${parsed.identity}' denied`,
          invariantRef: "INV §5.1",
          affectedTarget: id,
          suggestedAction: "Route correction to the responsible owner",
        });
      }
      const verifiedActor = parsed.identity;
      this.defects.setStatus(id, "resolved", true);
      this.events.append({
        eventType: "DefectResolved",
        entityId: id,
        payload: {},
        actor: verifiedActor,
        priorState: "in_progress",
        newState: "resolved",
        reasoning: "Defect corrected and re-verified",
      });
      this.syncProjectState();
      return { ok: true, value: { id } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /** Expire a waiver whose review condition elapsed (guarded lifecycle step). */
  expireWaiver(id: string, actor: string): CoreResult<{ id: string }> {
    try {
      const verifiedActor = this.requireCapability("waiver.expire", actor);
      this.db.waivers().setStatus(id, "expired");
      this.events.append({
        eventType: "StateTransition",
        entityId: id,
        payload: { entityType: "WAIVER", eventType: "WaiverExpired", fromState: "active", toState: "expired" },
        actor: verifiedActor,
        priorState: "active",
        newState: "expired",
        reasoning: "Waiver review condition elapsed",
      });
      this.syncProjectState();
      return { ok: true, value: { id } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  // ---------------------------------------------------------------------------
  // Slice 3: Evidence
  // ---------------------------------------------------------------------------

  /**
   * Record evidence bound to an exact artifact revision. The identifier
   * is Core-allocated. Payloads are scanned for secret material before
   * persistence [RUNTIME §10.3, INV §14.5], and the integrity hash is
   * recomputed and verified [CORE §9.1].
   * [CORE §9, DOM §3.19, INV §11.1]
   */
  recordEvidence(data: {
    producer: string;
    tool: string | null;
    targetRevision: string;
    checkName: string;
    result: string;
    diagnostics: string | null;
    integrityHash: string;
  }): CoreResult<{ id: string }> {
    try {
      // Evidence producers authenticate: testing, security, and
      // implementation evidence must come from known identities.
      this.requireCapability("evidence.record", data.producer);
      this.assertNoSecrets(data.checkName, data.diagnostics, "evidence");
      if (!isRevisionHash(data.targetRevision)) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: "Evidence target revision must be sha256:<64 lowercase hex>",
          invariantRef: "INV §14.4",
          suggestedAction: "Bind evidence to the exact proven revision hash",
        });
      }
      const expectedIntegrity = computeRevisionHash({
        result: data.result,
        diagnostics: data.diagnostics,
        target_revision: data.targetRevision,
      });
      if (data.integrityHash !== expectedIntegrity) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: "Evidence integrity hash does not match its content",
          invariantRef: "INV §11.1",
          suggestedAction: "Compute integrity as sha256 over the canonical {result, diagnostics, target_revision}",
        });
      }
      const timestamp = this.now();
      const id = this.sequences.allocate("EVD");

      this.evidence.create({
        id,
        ...data,
        timestamp,
      });

      this.events.append({
        eventType: "EvidenceRecorded",
        entityId: id,
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

      this.syncProjectState();
      return { ok: true, value: { id } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  // ---------------------------------------------------------------------------
  // Slice 6: Gate evaluation
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Attestations: RTK and process-skill recording [CORE §10/§11]
  //
  // The Core validates attestation structure, provenance constants,
  // identity proofs, and TTLs. The actual command execution (rtk gain,
  // routing self-test, skill discovery/activation probes) happens in the
  // CLI verify path, which runs the real commands; the Core never shells
  // out. Until Slice 8 adapters exist, routing/activation proofs arrive
  // through that path — the gate below denies without them.
  // ---------------------------------------------------------------------------

  /**
   * Record an RTK attestation after real verification.
   * Provenance must be the canonical upstream; `rtk gain` must have
   * succeeded (identity proof); the validity window must be future.
   */
  recordRtkAttestation(input: {
    binaryPath: string;
    binaryIdentity: string;
    version: string;
    provenance: string;
    integrationMode: string | null;
    routingTestPassed: boolean;
    routingTestLog: string | null;
    gained: boolean;
    savingsEvidence: string | null;
    ttlSeconds: number;
  }): CoreResult<{ id: string }> {
    try {
      if (input.provenance !== RTK_UPSTREAM) {
        throw new ChronoError({
          code: ErrorCode.RTK_NAME_COLLISION,
          severity: Severity.BLOCKER,
          message: `RTK provenance '${input.provenance}' is not the canonical ${RTK_UPSTREAM}`,
          invariantRef: "INV §8.2",
          suggestedAction: "Install Rust Token Killer from the canonical upstream",
        });
      }
      if (!input.gained) {
        throw new ChronoError({
          code: ErrorCode.RTK_NAME_COLLISION,
          severity: Severity.BLOCKER,
          message: "rtk gain did not succeed: the binary is not proven Rust Token Killer",
          invariantRef: "INV §8.2",
          suggestedAction: "Run rtk gain against the genuine binary",
        });
      }
      if (input.binaryPath.trim().length === 0 || input.binaryIdentity.trim().length === 0) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: "RTK attestation requires binary path and identity",
          invariantRef: "INV §14.4",
          suggestedAction: "Resolve the rtk binary before attesting",
        });
      }
      if (!Number.isFinite(input.ttlSeconds) || input.ttlSeconds <= 0) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: "RTK attestation requires a positive TTL",
          invariantRef: "INV §14.4",
          suggestedAction: "Provide the attestation TTL in seconds",
        });
      }
      const id = this.sequences.allocate("RTK");
      const validUntil = new Date(Date.parse(this.now()) + input.ttlSeconds * 1000).toISOString();
      this.db.rtkAttestations().create({
        id,
        binaryPath: input.binaryPath,
        binaryIdentity: input.binaryIdentity,
        version: input.version,
        provenance: input.provenance,
        integrationMode: input.integrationMode,
        routingTestPassed: input.routingTestPassed,
        routingTestLog: input.routingTestLog,
        gained: input.gained,
        savingsEvidence: input.savingsEvidence,
        validUntil,
      });
      this.events.append({
        eventType: "RtKAttested",
        entityId: id,
        payload: { version: input.version, routingTestPassed: input.routingTestPassed },
        actor: "system",
        priorState: undefined,
        newState: "current",
        reasoning: "RTK attestation recorded",
      });
      return { ok: true, value: { id } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  /**
   * Record a Karpathy Guidelines skill attestation after real verification.
   * Upstream must be canonical, the commit a full SHA, the source hash a
   * revision hash, the license MIT, and activation proven.
   */
  recordSkillAttestation(input: {
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
    ttlSeconds: number;
  }): CoreResult<{ id: string }> {
    try {
      if (input.upstream !== SKILL_UPSTREAM) {
        throw new ChronoError({
          code: ErrorCode.SKILL_PROVENANCE_FAILURE,
          severity: Severity.BLOCKER,
          message: `Skill upstream '${input.upstream}' is not the canonical ${SKILL_UPSTREAM}`,
          invariantRef: "INV §9.2",
          suggestedAction: "Pin the canonical Karpathy Guidelines upstream",
        });
      }
      if (!/^[0-9a-f]{40}$/i.test(input.pinnedCommit)) {
        throw new ChronoError({
          code: ErrorCode.SKILL_PROVENANCE_FAILURE,
          severity: Severity.BLOCKER,
          message: "Skill attestation requires a full pinned commit SHA",
          invariantRef: "INV §9.3",
          suggestedAction: "Pin the immutable reviewed commit",
        });
      }
      if (!isRevisionHash(input.sourceHash)) {
        throw new ChronoError({
          code: ErrorCode.SKILL_PROVENANCE_FAILURE,
          severity: Severity.BLOCKER,
          message: "Skill attestation requires the canonical source revision hash",
          invariantRef: "INV §9.2",
          suggestedAction: "Hash the canonical SKILL.md source",
        });
      }
      if (input.licenseStatus !== "MIT") {
        throw new ChronoError({
          code: ErrorCode.SKILL_PROVENANCE_FAILURE,
          severity: Severity.BLOCKER,
          message: "Skill license/attribution is not preserved as MIT",
          invariantRef: "INV §9.5",
          suggestedAction: "Preserve the upstream MIT license and attribution",
        });
      }
      if (!input.activationTestPassed) {
        throw new ChronoError({
          code: ErrorCode.SKILL_ACTIVATION_FAILURE,
          severity: Severity.BLOCKER,
          message: "Skill activation smoke test did not pass",
          invariantRef: "INV §9.6",
          suggestedAction: "Activate the skill in the runtime and re-verify",
        });
      }
      if (!Number.isFinite(input.ttlSeconds) || input.ttlSeconds <= 0) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: "Skill attestation requires a positive TTL",
          invariantRef: "INV §14.4",
          suggestedAction: "Provide the attestation TTL in seconds",
        });
      }
      const id = this.sequences.allocate("SKILL");
      const validUntil = new Date(Date.parse(this.now()) + input.ttlSeconds * 1000).toISOString();
      this.db.skillAttestations().create({
        id,
        upstream: input.upstream,
        pinnedCommit: input.pinnedCommit,
        sourceHash: input.sourceHash,
        generatedHashes: input.generatedHashes,
        converterVersion: input.converterVersion,
        licenseStatus: input.licenseStatus,
        attribution: input.attribution,
        runtimeIdentity: input.runtimeIdentity,
        agentIdentity: input.agentIdentity,
        discoveryResult: input.discoveryResult,
        permissionResult: input.permissionResult,
        activationTestPassed: input.activationTestPassed,
        validUntil,
      });
      this.events.append({
        eventType: "SkillAttested",
        entityId: id,
        payload: { pinnedCommit: input.pinnedCommit },
        actor: "system",
        priorState: undefined,
        newState: "current",
        reasoning: "Skill attestation recorded",
      });
      return { ok: true, value: { id } };
    } catch (e) {
      return this.handleError(e);
    }
  }

  // ---------------------------------------------------------------------------
  // Slice 6: Gate evaluation
  // ---------------------------------------------------------------------------

  /**
   * Evaluate execution authorization for a module (optionally scoped to one
   * Work Package) and, on success, issue a single-use dispatch grant bound
   * to the exact revisions, one assigned role, and the requesting session.
   * Implements gate_execution [CORE §7.4, DOM §6.4].
   *
   * Every prerequisite is evaluated; the first failure denies with its
   * explicit gate code. Missing capabilities deny — success is never
   * returned after placeholder checks [Remediation §5]. Every denial is
   * audited [CORE §7.7]. The grant (not this boolean-shaped answer) is
   * what an ExecutionStarted/ExecutionAssigned transition consumes.
   */
  authorizeExecution(
    moduleId: string,
    options: { workPackageId?: string | undefined; actor: string; role: string }
  ): CoreResult<{ authorized: boolean; grantId: string }> {
    const actor = options.actor;
    try {
      this.requireCapability("execution.request", actor);
      const assignedRole = this.requireAssignedRole(options.role, moduleId);
      const moduleArtifact = this.artifacts.findById(moduleId);
      if (moduleArtifact.status !== "APPROVED" && moduleArtifact.status !== "EXECUTING") {
        throw new ChronoError({
          code: ErrorCode.EXECUTION_DENIED,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId} is in state ${moduleArtifact.status}, not APPROVED or EXECUTING`,
          invariantRef: "INV §5.3, DOM §6.4",
          affectedTarget: moduleId,
          suggestedAction: "Promote module to APPROVED first",
        });
      }

      const project = this.projects.findById("default");
      if (project.runtime === null || project.runtime.trim().length === 0) {
        throw new ChronoError({
          code: ErrorCode.CONFIG_ERROR,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId}: no PO-selected runtime configured`,
          invariantRef: "INV §14.4",
          affectedTarget: moduleId,
          suggestedAction: "Select a runtime in the project configuration first",
        });
      }

      this.requireCurrentRtk(moduleId);
      this.requireCurrentSkill(moduleId);

      const approval = this.approvals.findByScope(moduleId, moduleArtifact.revision, "module-approval");
      if (approval === null || approval.revoked) {
        throw new ChronoError({
          code: ErrorCode.APPROVAL_REQUIRED,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId} lacks required PO approval`,
          invariantRef: "INV §5.4, DOM §6.4",
          affectedTarget: moduleId,
          suggestedAction: "Record a signed module-approval binding this exact revision",
        });
      }
      if (isStaleReference(approval.scopeRevision, moduleArtifact.revision)) {
        throw new ChronoError({
          code: ErrorCode.APPROVAL_REQUIRED,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId} approval is stale after material change`,
          invariantRef: "INV §4.4",
          affectedTarget: moduleId,
          suggestedAction: "Re-approve the current revision",
        });
      }

      const archRev = project.architectureRevision;
      if (project.architectureState !== "approved" || archRev === null) {
        throw new ChronoError({
          code: ErrorCode.APPROVAL_REQUIRED,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId}: architecture is not approved`,
          invariantRef: "INV §5.5",
          affectedTarget: moduleId,
          suggestedAction: "Approve the architecture with its security approval first",
        });
      }
      if (!this.hasValidApproval("ARCH", archRev, "architecture-security")) {
        throw new ChronoError({
          code: ErrorCode.APPROVAL_REQUIRED,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId}: Architecture Security Approval is not current`,
          invariantRef: "INV §5.5",
          affectedTarget: moduleId,
          suggestedAction: "Record a current signed architecture-security approval",
        });
      }

      const specIds = this.moduleSpecIds(moduleId);
      for (const specId of specIds) {
        const spec = this.artifacts.findById(specId);
        if (spec.status !== "READY") {
          throw new ChronoError({
            code: ErrorCode.EXECUTION_DENIED,
            severity: Severity.BLOCKER,
            message: `Module ${moduleId}: Spec '${specId}' is ${spec.status}, not READY`,
            invariantRef: "INV §5.3, DOM §6.4",
            affectedTarget: specId,
            suggestedAction: "Release every module Spec to READY first",
          });
        }
        let harness: { stale: boolean };
        try {
          harness = this.harnesses.findBySpecRevision(spec.revision);
        } catch {
          throw new ChronoError({
            code: ErrorCode.MISSING_REQUIRED_ARTIFACT,
            severity: Severity.BLOCKER,
            message: `Module ${moduleId}: no Harness for Spec '${specId}@${spec.revision}'`,
            invariantRef: "INV §14.4",
            affectedTarget: specId,
            suggestedAction: "Record the authoritative Harness for this Spec revision",
          });
        }
        if (harness.stale) {
          throw new ChronoError({
            code: ErrorCode.STALE_REVISION,
            severity: Severity.BLOCKER,
            message: `Module ${moduleId}: Harness for Spec '${specId}@${spec.revision}' is stale`,
            invariantRef: "INV §10.3",
            affectedTarget: specId,
            suggestedAction: "Regenerate the Harness after the material change",
          });
        }
      }

      this.denyOnPostApprovalChange(moduleId, specIds, approval.timestamp);

      if (options.workPackageId !== undefined) {
        this.authorizeWorkPackageScope(moduleId, options.workPackageId);
      } else if (this.moduleWorkPackages(moduleId).length > 0) {
        throw new ChronoError({
          code: ErrorCode.EXECUTION_DENIED,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId} has Work Packages: execution requires an explicit work-package scope`,
          invariantRef: "INV §5.1",
          affectedTarget: moduleId,
          suggestedAction: "Authorize a specific Work Package of this Module",
        });
      }

      this.denyIfBlocked(moduleId);

      if (moduleArtifact.status === "EXECUTING" && this.evidence.hasCurrentEvidence(moduleArtifact.revision)) {
        if (!this.hasValidApproval(moduleId, moduleArtifact.revision, "implementation-security")) {
          throw new ChronoError({
            code: ErrorCode.APPROVAL_REQUIRED,
            severity: Severity.BLOCKER,
            message: `Module ${moduleId}: resuming execution with implementation evidence requires a current Implementation Security Acceptance`,
            invariantRef: "INV §7.2",
            affectedTarget: moduleId,
          suggestedAction: "Record the implementation-security decision for this revision",
          });
        }
      }

      // All prerequisites hold: issue the single-use dispatch grant bound
      // to exact revisions, one assigned role, and the requesting session.
      const parsedRequester = parseActorIdentity(actor);
      const grantId = this.sequences.allocate("GRANT");
      const ttlSeconds = this.config.grantTtlSeconds ?? 3600;
      const issuedAt = this.now();
      this.db.grants().create({
        id: grantId,
        moduleId,
        workPackageId: options.workPackageId ?? null,
        moduleRevision: moduleArtifact.revision,
        specRevisions: specIds.map((specId) => this.artifacts.findById(specId).revision),
        role: assignedRole,
        session: parsedRequester.kind === "session" ? parsedRequester.identity : null,
        requestedBy: actor,
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + ttlSeconds * 1000).toISOString(),
      });

      return { ok: true, value: { authorized: true, grantId } };
    } catch (e) {
      this.auditDenial(moduleId, "ExecutionAuthorization", e, actor);
      return this.handleError(e);
    }
  }

  /**
   * The assigned implementation role bound into a dispatch grant.
   * Only implementation-capable roles take assignments: orchestrators
   * (gaspar), verifiers (spekkio), reviewers (glenn), and the human PO
   * never execute dispatched work.
   */
  private requireAssignedRole(role: string, moduleId: string): string {
    if (!["belthazar", "melchior", "prometheus", "lucca"].includes(role)) {
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: `Invalid assignment role '${role}' for '${moduleId}': dispatched work assigns belthazar, melchior, prometheus, or lucca`,
        invariantRef: "INV §14.4",
        affectedTarget: moduleId,
        suggestedAction: "Assign dispatched work to an implementation-capable role",
      });
    }
    return role;
  }

  /** Current RTK attestation with proven routing, else BLOCKED_RTK. */
  private requireCurrentRtk(target: string): void {
    const attestation = this.db.rtkAttestations().latest();
    const state = this.attestationState(attestation, Date.parse(this.now()));
    if (state !== "current") {
      throw new ChronoError({
        code: ErrorCode.BLOCKED_RTK,
        severity: Severity.BLOCKER,
        message: `Module ${target}: RTK attestation ${state}`,
        invariantRef: "INV §8.5",
        affectedTarget: target,
        suggestedAction: "Verify a genuine RTK installation and record a current attestation",
      });
    }
  }

  /** Current skill attestation, else BLOCKED_PROCESS_SKILL. */
  private requireCurrentSkill(target: string): void {
    const attestation = this.db.skillAttestations().latest();
    const state = this.attestationState(attestation, Date.parse(this.now()));
    if (state !== "current") {
      throw new ChronoError({
        code: ErrorCode.BLOCKED_PROCESS_SKILL,
        severity: Severity.BLOCKER,
        message: `Module ${target}: skill attestation ${state}`,
        invariantRef: "INV §9.7",
        affectedTarget: target,
        suggestedAction: "Verify the pinned Karpathy Guidelines skill and record a current attestation",
      });
    }
  }

  /**
   * No material content change may follow the module approval: an
   * ArtifactRevised event on the module or its Specs after approval
   * invalidates execution. Status-only lifecycle transitions are audit
   * events, not material changes [DOM §2.3].
   */
  private denyOnPostApprovalChange(moduleId: string, specIds: string[], approvalTimestamp: string): void {
    const watched = new Set([moduleId, ...specIds]);
    for (const event of this.events.listAll()) {
      if (event.timestamp > approvalTimestamp && watched.has(event.entityId) && event.eventType === "ArtifactRevised") {
        throw new ChronoError({
          code: ErrorCode.APPROVAL_REQUIRED,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId}: '${event.entityId}' changed materially after approval at ${approvalTimestamp}`,
          invariantRef: "INV §4.4",
          affectedTarget: moduleId,
          suggestedAction: "Re-approve the module for the current revisions",
        });
      }
    }
  }

  /** Work Packages owned by a module (registration content links). */
  private moduleWorkPackages(moduleId: string): string[] {
    const owned: string[] = [];
    for (const wp of this.artifacts.listByType("WP")) {
      try {
        if (this.workPackageModule(wp.id) === moduleId) {
          owned.push(wp.id);
        }
      } catch {
        continue;
      }
    }
    return owned;
  }

  /** Authorize one Work Package scope: ownership, state, deps, blockers. */
  private authorizeWorkPackageScope(moduleId: string, wpId: string): void {
    let wp: { id: string; status: string };
    try {
      wp = this.artifacts.findById(wpId);
    } catch {
      throw new ChronoError({
        code: ErrorCode.REFERENCE_UNRESOLVABLE,
        severity: Severity.ERROR,
        message: `WorkPackage '${wpId}' does not exist`,
        invariantRef: "INV §10.2",
        affectedTarget: moduleId,
        suggestedAction: "Authorize an existing Work Package of this Module",
      });
    }
    if (wp.id !== wpId || this.workPackageModule(wpId) !== moduleId) {
      throw new ChronoError({
        code: ErrorCode.INCONSISTENT_REFERENCE,
        severity: Severity.ERROR,
        message: `WorkPackage '${wpId}' does not belong to Module '${moduleId}'`,
        invariantRef: "INV §10.2",
        affectedTarget: wpId,
        suggestedAction: "Scope execution to a Work Package of this Module",
      });
    }
    if (wp.status !== "AUTHORIZED" && wp.status !== "RUNNING") {
      throw new ChronoError({
        code: ErrorCode.EXECUTION_DENIED,
        severity: Severity.BLOCKER,
        message: `WorkPackage '${wpId}' is ${wp.status}, not AUTHORIZED or RUNNING`,
        invariantRef: "INV §5.3",
        affectedTarget: wpId,
        suggestedAction: "Authorize the Work Package before dispatching it",
      });
    }
    for (const dep of this.readDependsOn(wpId)) {
      const depArtifact = this.artifacts.findById(dep);
      if (!["IMPLEMENTED", "VERIFYING", "COMPLETE"].includes(depArtifact.status)) {
        throw new ChronoError({
          code: ErrorCode.EXECUTION_DENIED,
          severity: Severity.BLOCKER,
          message: `WorkPackage '${wpId}': dependency '${dep}' is ${depArtifact.status}`,
          invariantRef: "INV §10.4",
          affectedTarget: wpId,
          suggestedAction: "Satisfy predecessor Work Packages first",
        });
      }
    }
    const active = this.blockers.findActive([wpId]);
    if (active.length > 0) {
      const first = active[0]!;
      throw new ChronoError({
        code: ErrorCode.EXECUTION_DENIED,
        severity: Severity.BLOCKER,
        message: `WorkPackage '${wpId}' has active blocker '${first.id}'`,
        invariantRef: "INV §5.1",
        affectedTarget: wpId,
        suggestedAction: `Resolve blocker '${first.id}' first`,
      });
    }
  }

  /**
   * Evaluate completion authorization for a module.
   * Implements gate_completion [CORE §7.6, DOM §6.6]: Spekkio PASS bound
   * to the revision, current Lucca and Glenn evidence, current
   * Implementation Security Acceptance, no blocking defects, security
   * blockers resolved or validly waived, current attestations, intact
   * traceability, and a legal transition. Every denial is audited.
   */
  authorizeCompletion(moduleId: string, actor: string): CoreResult<boolean> {
    try {
      this.requireCapability("completion.request", actor);
      const moduleArtifact = this.artifacts.findById(moduleId);

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

      const activeBlockers = this.blockers.findActive([moduleId]);
      const securityBlockers = activeBlockers.filter((b) => b.type === "SECURITY_BLOCKER");
      const otherBlockers = activeBlockers.filter((b) => b.type !== "SECURITY_BLOCKER");
      if (otherBlockers.length > 0) {
        throw new ChronoError({
          code: ErrorCode.COMPLETION_DENIED,
          severity: Severity.BLOCKER,
          message: `Active blockers prevent completion: ${otherBlockers.map((b) => b.reason).join(", ")}`,
          invariantRef: "INV §5.6, DOM §6.6",
          affectedTarget: moduleId,
          suggestedAction: "Resolve all active blockers",
        });
      }
      for (const blocker of securityBlockers) {
        const waivers = this.db.waivers().findActiveForScope(moduleId, moduleArtifact.revision);
        if (waivers.length === 0) {
          throw new ChronoError({
            code: ErrorCode.SECURITY_BLOCKER,
            severity: Severity.BLOCKER,
            message: `Security blocker '${blocker.id}' is unresolved and not validly waived`,
            invariantRef: "INV §7.4",
            affectedTarget: moduleId,
            suggestedAction: "Resolve the security blocker or record a PO waiver for this revision",
          });
        }
      }

      const verdicts = this.qa.listByModule(moduleId).filter(
        (r) => r.verdict === "PASS" && r.moduleRevision === moduleArtifact.revision
      );
      if (verdicts.length === 0) {
        throw new ChronoError({
          code: ErrorCode.COMPLETION_DENIED,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId} has no Spekkio PASS bound to revision ${moduleArtifact.revision}`,
          invariantRef: "INV §5.6, DOM §6.6",
          affectedTarget: moduleId,
          suggestedAction: "Obtain an independent PASS verdict for this exact revision",
        });
      }

      const evidence = this.db.evidence().findByTargetRevision(moduleArtifact.revision);
      if (!evidence.some((e) => e.producer === "lucca" && e.result === "pass")) {
        throw new ChronoError({
          code: ErrorCode.EVIDENCE_MISSING,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId} lacks current Lucca test evidence for this revision`,
          invariantRef: "INV §11.3, DOM §6.6",
          affectedTarget: moduleId,
          suggestedAction: "Record Lucca evidence before completion",
        });
      }
      if (!evidence.some((e) => e.producer === "glenn")) {
        throw new ChronoError({
          code: ErrorCode.SECURITY_EVIDENCE_MISSING,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId} lacks current Glenn security evidence for this revision`,
          invariantRef: "INV §7.6, DOM §6.6",
          affectedTarget: moduleId,
          suggestedAction: "Record Glenn security evidence before completion",
        });
      }

      if (!this.hasValidApproval(moduleId, moduleArtifact.revision, "implementation-security")) {
        throw new ChronoError({
          code: ErrorCode.APPROVAL_REQUIRED,
          severity: Severity.BLOCKER,
          message: `Module ${moduleId} lacks a current Implementation Security Acceptance`,
          invariantRef: "INV §7.2",
          affectedTarget: moduleId,
          suggestedAction: "Record the implementation-security decision for this revision",
        });
      }

      for (const defect of this.db.defects().listAll()) {
        const blocking =
          defect.status !== "resolved" &&
          (defect.blockingScope === moduleId || defect.affectedArtifacts.includes(moduleId));
        if (blocking) {
          throw new ChronoError({
            code: ErrorCode.COMPLETION_DENIED,
            severity: Severity.BLOCKER,
            message: `Blocking defect '${defect.id}' [${defect.classification}] remains ${defect.status}`,
            invariantRef: "INV §5.6",
            affectedTarget: moduleId,
            suggestedAction: "Correct the defect and re-verify",
          });
        }
      }

      for (const specId of this.moduleSpecIds(moduleId)) {
        const spec = this.artifacts.findById(specId);
        if (spec.status !== "READY") {
          throw new ChronoError({
            code: ErrorCode.COMPLETION_DENIED,
            severity: Severity.BLOCKER,
            message: `Module ${moduleId}: Spec '${specId}' is ${spec.status}, traceability broken`,
            invariantRef: "INV §10.5",
            affectedTarget: moduleId,
            suggestedAction: "Restore the approved Spec chain before completion",
          });
        }
      }

      this.requireCurrentRtk(moduleId);
      this.requireCurrentSkill(moduleId);

      return { ok: true, value: true };
    } catch (e) {
      this.auditDenial(moduleId, "CompletionAuthorization", e, actor);
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
   * Only Spekkio records verdicts; the verdict binds to the module's exact
   * current revision; FAILED requires classified defects; WAIVED requires
   * active covering waivers. WAIVED is NEVER normalized to PASS [INV §3.4].
   */
  recordVerification(
    moduleId: string,
    verdict: "PASS" | "FAILED" | "WAIVED",
    reviewer: string,
    defectIds: string[] = [],
    waiverIds: string[] = [],
    evidenceIds: string[] = []
  ): CoreResult<{ qaId: string }> {
    try {
      // Verdicts are Spekkio's independent authority [FW §2.7, DOM §3.20].
      if (reviewer !== "spekkio") {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: `Verification reviewer must be spekkio, not '${reviewer}'`,
          invariantRef: "INV §14.4",
          affectedTarget: moduleId,
          suggestedAction: "Route verification verdicts through Spekkio",
        });
      }

      // The module must exist and be under verification.
      const module = this.requireReference(moduleId, "MOD", reviewer);
      const current = this.artifacts.findById(moduleId);
      if (current.status !== "VERIFYING") {
        throw new ChronoError({
          code: ErrorCode.INVALID_STATE,
          severity: Severity.ERROR,
          message: `Module '${moduleId}' is ${current.status}, not VERIFYING: no verdict applies`,
          invariantRef: "INV §3.1",
          affectedTarget: moduleId,
          suggestedAction: "Complete implementation before recording a verdict",
        });
      }

      // FAILED requires at least one existing classified defect [P9.4].
      if (verdict === "FAILED" && defectIds.length === 0) {
        throw new ChronoError({
          code: ErrorCode.MISSING_REQUIRED_ARTIFACT,
          severity: Severity.ERROR,
          message: `FAILED verdict for '${moduleId}' requires at least one classified defect`,
          invariantRef: "INV §14.4",
          affectedTarget: moduleId,
          suggestedAction: "Classify and record the defect before marking FAILED",
        });
      }
      for (const defectId of defectIds) {
        try {
          this.defects.findById(defectId);
        } catch {
          throw new ChronoError({
            code: ErrorCode.REFERENCE_UNRESOLVABLE,
            severity: Severity.ERROR,
            message: `Defect '${defectId}' referenced by verdict for '${moduleId}' does not exist`,
            invariantRef: "INV §10.2",
            affectedTarget: moduleId,
            suggestedAction: "Raise the defect before referencing it",
          });
        }
      }

      // PASS carries no defects and no waivers — they are distinct [INV §3.4].
      if (verdict === "PASS" && (defectIds.length > 0 || waiverIds.length > 0)) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: "PASS must not include defect or waiver references — WAIVED is never PASS",
          invariantRef: "INV §3.4, DOM §3.20",
          affectedTarget: moduleId,
          suggestedAction: "Use FAILED with defects, or WAIVED with an explicit waiver",
        });
      }

      // WAIVED requires active waivers covering this exact revision [P2.8].
      if (verdict === "WAIVED") {
        if (waiverIds.length === 0) {
          throw new ChronoError({
            code: ErrorCode.APPROVAL_REQUIRED,
            severity: Severity.BLOCKER,
            message: "WAIVED requires an explicit PO waiver reference",
            invariantRef: "INV §4.1, DOM §6.6",
            affectedTarget: moduleId,
            suggestedAction: "Record a waiver before marking verification as WAIVED",
          });
        }
        for (const waiverId of waiverIds) {
          let waiver: { status: string; scopeArtifactId: string; scopeRevision: string };
          try {
            waiver = this.db.waivers().findById(waiverId);
          } catch {
            throw new ChronoError({
              code: ErrorCode.REFERENCE_UNRESOLVABLE,
              severity: Severity.ERROR,
              message: `Waiver '${waiverId}' referenced by verdict for '${moduleId}' does not exist`,
              invariantRef: "INV §10.2",
              affectedTarget: moduleId,
              suggestedAction: "Record the PO waiver before referencing it",
            });
          }
          if (waiver.status !== "active") {
            throw new ChronoError({
              code: ErrorCode.APPROVAL_REQUIRED,
              severity: Severity.BLOCKER,
              message: `Waiver '${waiverId}' is ${waiver.status}: expired or invalidated waivers block the gate`,
              invariantRef: "INV §4.1",
              affectedTarget: moduleId,
              suggestedAction: "Obtain a current PO waiver",
            });
          }
          if (waiver.scopeArtifactId !== moduleId || waiver.scopeRevision !== module.revision) {
            throw new ChronoError({
              code: ErrorCode.INCONSISTENT_REFERENCE,
              severity: Severity.ERROR,
              message: `Waiver '${waiverId}' does not cover '${moduleId}@${module.revision}'`,
              invariantRef: "INV §10.2",
              affectedTarget: moduleId,
              suggestedAction: "Bind the waiver to this exact module revision",
            });
          }
        }
      }

      const qaId = this.sequences.allocate("QA");
      const now = this.now();

      for (const evidenceId of evidenceIds) {
        try {
          this.db.evidence().findById(evidenceId);
        } catch {
          throw new ChronoError({
            code: ErrorCode.REFERENCE_UNRESOLVABLE,
            severity: Severity.ERROR,
            message: `Evidence '${evidenceId}' reviewed by verdict for '${moduleId}' does not exist`,
            invariantRef: "INV §10.2",
            affectedTarget: moduleId,
            suggestedAction: "Record the evidence before referencing it in a verdict",
          });
        }
      }

      this.qa.create({
        id: qaId,
        moduleId,
        workPackageId: null,
        verdict,
        reviewedEvidence: evidenceIds,
        defectIds,
        waiverIds,
        reviewer,
        timestamp: now,
        moduleRevision: module.revision,
        workPackageRevision: null,
      });

      this.syncProjectState();
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
      const authz = this.authorizeCompletion(moduleId, actor);
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
  // Registration guards (identity, schema, references, DAG) [Remediation §2]
  // ---------------------------------------------------------------------------

  /** Family of a well-formed identifier (throws on malformed ids). */
  private artifactTypeOf(id: string): string {
    return parseArtifactId(id).family;
  }

  /**
   * Registration content of an artifact: the first history row.
   * Transitions store hash-chain links as later revisions, so lifecycle
   * content (specs, module, dependsOn, scope) always comes from the
   * registration row [DOM §2.3].
   */
  private registrationContent(id: string): Record<string, unknown> {
    const history = this.artifacts.getHistory(id);
    const first = history[0];
    if (first === undefined) {
      throw new ChronoError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        severity: Severity.ERROR,
        message: `Artifact ${id} has no recorded revisions`,
        invariantRef: "INV §10.2",
        affectedTarget: id,
        suggestedAction: "Register the artifact before reading its content",
      });
    }
    return JSON.parse(first.content) as Record<string, unknown>;
  }

  /**
   * Identity must be well-formed and its family must match the artifact
   * type being registered [CORE §3.1, INV §10.1].
   */
  private assertIdentityForType(id: string, type: string): void {    const parsed = parseArtifactId(id);
    if (parsed.family !== type) {
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: `Identifier family mismatch: '${id}' cannot be registered as ${type}`,
        invariantRef: "INV §10.1",
        affectedTarget: id,
        suggestedAction: `Use an identifier from the ${type} family`,
      });
    }
  }

  /** Embedded content id, when present, must equal the registered id. */
  private assertContentIdMatches(id: string, content: Record<string, unknown>): void {
    const embedded = content["id"];
    if (embedded !== undefined && embedded !== id) {
      throw new ChronoError({
        code: ErrorCode.INCONSISTENT_REFERENCE,
        severity: Severity.ERROR,
        message: `Content id '${String(embedded)}' contradicts registered id '${id}'`,
        invariantRef: "INV §10.2",
        affectedTarget: id,
        suggestedAction: "Align the embedded id with the registered identifier",
      });
    }
  }

  /**
   * Validate an optional/required string-array field.
   * Returns the array (possibly empty) or undefined when absent and optional.
   */
  private assertStringArray(
    value: unknown,
    field: string,
    source: string,
    required: boolean
  ): string[] | undefined {
    if (value === undefined) {
      if (required) {
        throw new ChronoError({
          code: ErrorCode.VALIDATION_ERROR,
          severity: Severity.ERROR,
          message: `Invalid content: missing required array field '${field}'`,
          invariantRef: "INV §14.4",
          affectedTarget: source,
          suggestedAction: `Provide '${field}' as an array of identifiers`,
        });
      }
      return undefined;
    }
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new ChronoError({
        code: ErrorCode.VALIDATION_ERROR,
        severity: Severity.ERROR,
        message: `Invalid content: field '${field}' must be an array of identifiers`,
        invariantRef: "INV §14.4",
        affectedTarget: source,
        suggestedAction: `Provide '${field}' as an array of identifiers`,
      });
    }
    return value;
  }

  /**
   * Resolve a reference and enforce the expected target type.
   * Unresolvable → REFERENCE_UNRESOLVABLE; wrong type → INCONSISTENT_REFERENCE.
   */
  private requireReference(
    targetId: string,
    expectedType: string,
    source: string
  ): { id: string; revision: string } {
    let target: { id: string; type: string; revision: string };
    try {
      target = this.artifacts.findById(targetId);
    } catch {
      throw new ChronoError({
        code: ErrorCode.REFERENCE_UNRESOLVABLE,
        severity: Severity.ERROR,
        message: `Unresolvable reference '${targetId}' from '${source}'`,
        invariantRef: "INV §10.2",
        affectedTarget: source,
        suggestedAction: "Register the referenced artifact before referencing it",
      });
    }
    if (target.type !== expectedType) {
      throw new ChronoError({
        code: ErrorCode.INCONSISTENT_REFERENCE,
        severity: Severity.ERROR,
        message: `Incompatible reference '${targetId}' from '${source}': expected ${expectedType}, found ${target.type}`,
        invariantRef: "INV §10.2",
        affectedTarget: source,
        suggestedAction: "Reference an artifact of the expected type",
      });
    }
    return { id: target.id, revision: target.revision };
  }

  /**
   * Reject a WorkPackage registration whose dependency edges would close
   * a cycle [CORE §12.2, INV §10.4].
   */
  private assertAcyclicWorkPackage(wpId: string, dependsOn: string[]): void {
    const edges = new Map<string, string[]>();
    for (const wp of this.artifacts.listByType("WP")) {
      edges.set(wp.id, this.readDependsOn(wp.id));
    }
    edges.set(wpId, dependsOn);

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (node: string): boolean => {
      if (visiting.has(node)) {
        return true;
      }
      if (visited.has(node)) {
        return false;
      }
      visiting.add(node);
      for (const next of edges.get(node) ?? []) {
        if (visit(next)) {
          return true;
        }
      }
      visiting.delete(node);
      visited.add(node);
      return false;
    };

    if (visit(wpId)) {
      throw new ChronoError({
        code: ErrorCode.DAG_CYCLE,
        severity: Severity.ERROR,
        message: `WorkPackage dependency cycle detected involving '${wpId}'`,
        invariantRef: "INV §10.4",
        affectedTarget: wpId,
        suggestedAction: "Break the cycle through an approved interface or merge atomic work",
      });
    }
  }

  /** Read declared dependsOn from registration content. */
  private readDependsOn(wpId: string): string[] {
    try {
      const parsed = this.registrationContent(wpId);
      const deps = parsed["dependsOn"];
      return Array.isArray(deps) ? deps.filter((d): d is string => typeof d === "string") : [];
    } catch {
      return [];
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
   * Current schema version (read-only, for tests and diagnostics).
   */
  getSchemaVersion(): number {
    return this.db.schemaVersion();
  }

  /**
   * Append-only event log in sequence order (read-only, for tests,
   * audit, and adapters). No writable handle is exposed.
   */
  listEvents(): ReadonlyArray<{
    readonly seq: number;
    readonly eventType: string;
    readonly entityId: string;
    readonly actor: string;
    readonly timestamp: string;
  }> {
    return this.events.listAll().map((e) => ({
      seq: e.seq,
      eventType: e.eventType,
      entityId: e.entityId,
      actor: e.actor,
      timestamp: e.timestamp,
    }));
  }

  /**
   * Current-pointer artifact read (throws ENTITY_NOT_FOUND when absent).
   */
  getArtifact(id: string): { id: string; type: string; revision: string; status: string } {
    const artifact = this.artifacts.findById(id);
    return { id: artifact.id, type: artifact.type, revision: artifact.revision, status: artifact.status };
  }

  /**
   * Immutable revision history of an artifact, oldest first.
   */
  artifactHistory(id: string): ReadonlyArray<{ revision: string; status: string }> {
    return this.db.artifacts().getHistory(id).map((r) => ({ revision: r.revision, status: r.status }));
  }

  /** Active blockers (read-only, for gates, validation, and tests). */
  listActiveBlockers(): ReadonlyArray<{ id: string; type: string; reason: string }> {
    return this.blockers.findActive().map((b) => ({ id: b.id, type: b.type, reason: b.reason }));
  }

  /** QA reports recorded for a module, oldest first. */
  listQaReports(moduleId: string): ReadonlyArray<{ id: string; verdict: string; reviewer: string }> {
    return this.qa.listByModule(moduleId).map((r) => ({ id: r.id, verdict: r.verdict, reviewer: r.reviewer }));
  }

  /**
   * Attestation currency snapshot for CLI status output (read-only).
   * State is one of current | stale | invalid | missing.
   */
  attestationCurrency(kind: "rtk" | "skill"): { state: string; id: string | null; validUntil: string | null } {
    const latest = kind === "rtk" ? this.db.rtkAttestations().latest() : this.db.skillAttestations().latest();
    if (latest === null) {
      return { state: "missing", id: null, validUntil: null };
    }
    return {
      state: this.attestationState(latest, Date.parse(this.now())),
      id: latest.id,
      validUntil: latest.validUntil,
    };
  }
}
