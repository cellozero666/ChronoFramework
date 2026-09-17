# CHRONO SDD Innovation Standard

**Status:** Normative product standard

**Owner:** Product Owner

## 1. Purpose

CHRONO MUST remain a technology-agnostic control plane for agentic software engineering, not a prompt collection, code generator, or runtime-specific workflow. Its innovation is the enforceable conversion of Product Owner intent into persistent, versioned, approved, executable, traceable, and independently verified software delivery.

This standard defines the product outcomes that the final implementation MUST demonstrate. It does not authorize bypassing the authority, security, specification, evidence, or correction protocols.

## 2. Innovation thesis

CHRONO is differentiated only when all of the following are true together:

1. models perform semantic work while deterministic software owns lifecycle state, gates, authorization, integrity, and evidence;
2. project truth survives runtime, model, session, process, and context changes;
3. Specs and their Harnesses are executable contracts rather than optional prose;
4. human authority is cryptographically bound to exact artifact revisions;
5. runtime adapters cannot weaken policy and direct runtime use cannot bypass `chrono gate`;
6. security decisions occur before affected architecture/execution and again before completion;
7. independent verification and correction loops prevent an implementation agent from approving its own output;
8. the same domain lifecycle works across technologies and supported agent runtimes.

If an implementation merely coordinates prompts or agents without these properties, it MUST NOT be described as a conforming CHRONO implementation.

## 3. Technology-agnostic contract

The Core MUST NOT contain assumptions about web applications, a product programming language, framework, build tool, package manager, database, deployment platform, repository layout, or test runner. Such knowledge belongs to project artifacts, Harnesses, policy packs, capability discovery, and adapters.

Technology-specific behavior MUST enter through explicit ports or declarative capabilities. An unsupported capability MUST produce a structured, actionable denial or blocker; it MUST NOT trigger guessed commands or a silent fallback.

The final v1 conformance suite MUST include at least:

- one greenfield fixture and one existing-repository fixture;
- two product technology families with materially different build/test conventions;
- a non-web fixture;
- OpenCode, Claude Code, and Kiro adapter execution against the same runtime-neutral lifecycle assertions.

Passing only a TypeScript/web-shaped fixture is insufficient evidence of technology agnosticism.

## 4. Mandatory v1 product capabilities

### 4.1 Explainable gates

Every denial, blocker, invalid transition, stale artifact, failed verification, and approval requirement MUST provide machine-readable and human-readable output containing:

- stable reason code;
- rule/invariant reference;
- affected target and revision;
- missing, stale, invalid, or conflicting evidence;
- authority able to resolve it;
- safe next action;
- correlation/event identifier.

### 4.2 Deterministic dry run

CHRONO MUST provide a read-only planning operation, exposed through `chrono plan --dry-run` or an equivalent stable command. It MUST show proposed agents, Work Packages, dependencies, permissions, gates, artifact mutations, external effects, and expected evidence without dispatching agents, changing project state, requesting signatures, or executing product commands.

The same persisted input and Core/policy versions MUST produce an equivalent authorization plan. Nondeterministic semantic recommendations MUST be explicitly separated from deterministic decisions.

### 4.3 Drift detection and scoped invalidation

CHRONO MUST detect material changes to code, dependencies, infrastructure, Specs, Harnesses, Security Profiles, runtime integrations, skills, and attestations. It MUST calculate impact, invalidate only proven affected approvals/evidence, block dependent work, and permit independent branches to continue only with deterministic proof.

### 4.4 Portable audit export

CHRONO MUST provide a deterministic audit export containing artifact identities/hashes, decisions, signatures or verification metadata, state transitions, gates, evidence references, waivers, defects, tool/runtime versions, SBOM/provenance references, and the final verdict. Export MUST redact secrets, be integrity-verifiable, and remain understandable without conversation history or access to an LLM.

### 4.5 Operational metrics without surveillance

CHRONO MUST calculate local project metrics for first-pass verification, correction-loop count, blocker duration, approval latency, invalidations, gate-prevented violations, Spec/implementation drift, and module completion. Metrics MUST distinguish RTK output-token estimates from financial savings.

Telemetry transmission is opt-in, disabled by default, documented, minimizable, and subject to PO authorization and the Security Profile. Local operation MUST remain fully functional without telemetry.

### 4.6 Progressive experience

Human-facing output MUST lead with outcome, reason, risk, and next action. Advanced details such as hashes, DAG edges, signatures, evidence IDs, and raw diagnostics MUST remain available through structured/verbose output. Usability MUST NOT hide or weaken a gate.

### 4.7 Bounded loops

Correction, retry, discovery, and validation loops MUST have persisted progress, attempt budgets, escalation conditions, and terminal blocker states. Repetition without new evidence MUST escalate rather than consume unbounded time or tokens.

## 5. Rigor profiles

V1 SHOULD support declarative profiles such as `prototype`, `standard`, `regulated`, and `critical`. Profiles MAY increase evidence depth, review independence, retention, testing, and operational controls.

No profile may disable:

- PO-only decisions and signed approval integrity;
- mandatory architecture and implementation security decisions;
- Spec/Harness traceability;
- Karpathy Guidelines attestations;
- fail-closed authorization;
- independent final verification;
- distinction between `FAILED`, `PASSED`, and `WAIVED`.

(RTK posture is advisory-only for every profile per PO decision ADR-009; it is observed telemetry, not a gate.)

If complete profile support would compromise the final v1, the Core MUST deliver a stable policy interface and the `standard` profile first; other profiles become explicit post-v1 roadmap items.

## 6. Policy-pack extension boundary

CHRONO SHOULD expose a versioned, signed, declarative policy-pack contract for domains such as web security, mobile, infrastructure, privacy, finance, healthcare, games, data, and embedded systems. A policy pack may add controls, validators, evidence requirements, and Harness guidance. It MUST NOT add hidden executable code, grant authority, downgrade a finding, accept risk, or override Core invariants.

Bundled domain packs beyond the minimum conformance fixtures are post-v1 unless separately approved by the PO.

## 7. Innovation verification gate

Before final v1 completion, Gaspar MUST produce an Innovation Review mapping Sections 2–6 to implementation and evidence. Lucca MUST test the mandatory behavior, Glenn MUST review security/privacy implications, and Spekkio MUST independently issue one of:

- `INNOVATION_PASS` — all mandatory claims have current evidence;
- `INNOVATION_FAILED` — a claim is false or a mandatory behavior fails;
- `INNOVATION_BLOCKED` — required evidence or PO authority is absent.

Marketing language MUST NOT claim technology agnosticism, deterministic governance, non-bypassability, or auditability without corresponding conformance evidence. `COMPLETE` and release authorization MUST be denied while this gate is failed or blocked.

## 8. Required evidence

The final Innovation Review MUST reference:

- black-box adapter conformance results;
- polyglot and non-web fixture results;
- deterministic replay/dry-run tests;
- drift and scoped-invalidation tests;
- explainable-denial contract tests;
- audit-export integrity and redaction tests;
- bounded-loop and escalation tests;
- local metrics and telemetry-default tests;
- usability evidence for concise and verbose output;
- proof that optional profiles/policy extensions cannot weaken mandatory invariants.

## 9. Post-v1 evaluation

After v1 evidence exists, the PO SHOULD evaluate additional policy packs, more runtime adapters, richer engineering metrics, and visual interfaces. These are prioritized using measured adoption and failure data, not added merely to increase feature count.
