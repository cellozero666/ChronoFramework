# Implementer Task Queue — Release-Candidate Readiness

**Status:** ACTIVE  
**Start point:** implemented Slices 9–10 baseline, pending corrective and real-runtime gates
**Target:** implementation complete and ready for the Product Owner's final real-runtime verification; not published or released.

## Operating rules

- Read and obey `AGENTS.md` and the complete normative chain before changes.
- Use the model selected outside CHRONO by the Product Owner. Never hardcode a
  provider, model, version, credential, or paid endpoint.
- Work in the current branch and repository. Do not create or switch branches.
- Preserve unrelated user changes. Keep commits logically reviewable if the PO
  has authorized commits; never push, tag, publish, release, or alter remotes.
- Do not stop after scaffolding, happy-path tests, or an MVP demonstration.
  Continue until every task below is complete or a genuine PO/external blocker
  is documented with exact evidence.
- Treat all runtime/model output as untrusted. Core decisions, signatures,
  persisted artifacts, and black-box evidence determine success.

## Task 1 — Execute and independently review Slice 9

**Current disposition:** IMPLEMENTED, NOT COMPLETE. Resolve the applicable
items in [`FIXES-SL-10.1.md`](FIXES-SL-10.1.md) and collect the missing
real-runtime evidence before independent closure.

Implement every section and exit criterion in [`SLICE-9.md`](SLICE-9.md).
Create a concise Slice 9 implementation report containing exact tests,
versions, fixtures, files, denials, and residuals. Perform a second review pass
against the normative documents before marking it complete.

## Task 2 — Execute and independently review Slice 10

**Current disposition:** IMPLEMENTED, NOT COMPLETE. Resolve the applicable
items in [`FIXES-SL-10.1.md`](FIXES-SL-10.1.md) and collect the missing
real-runtime evidence before independent closure.

Implement every requirement and exit criterion in [`SLICE-10.md`](SLICE-10.md).
Prove the public experience from packed installation through `chrono init` to
automatic Gaspar start or resume in every supported runtime. Preserve the
advanced subcommands as recovery/diagnostic interfaces, but do not require
ordinary users to execute them during a successful first-run journey.

## Task 3 — Phase 6 end-to-end MVP proof

Execute this task incrementally by runtime: Phase 6A OpenCode, Phase 6B Claude
Code, then Phase 6C Kiro. The current authorized preparation target is Phase
6A only, governed by [`OPENCODE-PILOT-GATE.md`](OPENCODE-PILOT-GATE.md).
Absence or failure of an unselected Claude/Kiro runtime must not block the
OpenCode-only project path. An OpenCode pass is an incremental milestone, not
completion of this all-runtime task or final-v1 conformance.

Build disposable fixtures for:

1. a small greenfield project;
2. an existing repository with pre-existing code and history.

For OpenCode, Claude Code, and Kiro, prove the complete lifecycle specified in
`IMPLEMENTATION-PLAN.md`: discovery, persisted analysis, architecture/ADRs,
Specs, one Harness per executable Spec, DAG planning, both PO security
decisions, module approval, dependency-ready dispatch, implementation, Lucca
test evidence, Glenn security evidence, Spekkio verdict, at least one forced
failure/correction loop, completion, restart, and model replacement without
state loss.

Run every required negative Phase 6 case. Persist machine-readable evidence
without secrets. Do not use fixture runtimes where real runtime behavior is a
release requirement. Record model identifiers only as external execution
metadata, never defaults or policy.

## Task 4 — Mandatory v1 product capabilities

Implement and test the SDD Innovation Standard requirements:

- explainable gate output with failed predicate, authority, evidence, and next
  action;
- deterministic `chrono plan --dry-run` with zero mutation or dispatch;
- material drift detection and dependency-aware scoped invalidation;
- portable, integrity-verifiable, secret-redacted audit export;
- privacy-preserving local metrics, including correction loops and RTK token
  estimates separated from financial claims;
- bounded-loop budgets and deterministic escalation;
- stable rigor-profile contract;
- signed declarative policy-pack boundary that cannot grant authority or weaken
  Core invariants;
- progressive output that does not compromise JSON mode or audit evidence.

Add polyglot and non-web fixtures to prove the Core is technology agnostic.

## Task 5 — Reliability, upgrade, and security hardening

- Test crash/restart recovery at every material lifecycle boundary.
- Prove transactional rollback for partial setup, enrollment, approval,
  routing-proof, dispatch, evidence, and completion failures.
- Test migration from every supported schema/release baseline with data,
  signatures, audit history, exact references, and role identities preserved.
- Add concurrency, replay, tamper, TOCTOU, symlink/path traversal, command
  injection, malicious repository content, oversized output, timeout,
  cancellation, secret leakage, and dependency compromise tests.
- Verify Windows, macOS, and Linux path/process/key-storage behavior through
  real or release-grade CI environments.
- Ensure error codes, exit codes, JSON envelopes, help text, and recovery
  instructions are stable and documented.

## Task 6 — Packaging and release-candidate preparation

- Ensure the global launcher delegates to the compatible project-pinned local
  Core and fails closed when it cannot.
- Pack and install every public package from tarballs in isolated fixtures;
  verify no tests, source-only imports, secrets, local paths, or workspace links
  leak into packages.
- Produce release scripts/configuration for checksums, signed provenance, SBOM,
  license/NOTICE and third-party attribution validation.
- Verify Apache-2.0 metadata and bundled MIT attribution for the Karpathy skill.
- Prepare, but do not publish, npm artifacts and GitHub Release assets for
  macOS, Linux, and Windows.
- Add installation, setup, upgrade, recovery, troubleshooting, security,
  adapter-authoring, and first-project documentation backed by tested commands.

## Task 7 — Final consistency and innovation gate

- Remove every stub, TODO-only path, simulated mandatory integration, skipped
  test, stale status, unsupported claim, and obsolete command example.
- Validate all Markdown links and generated assets.
- Make README claims match demonstrated behavior and prepared release artifacts.
- Produce Gaspar's Innovation Review, Lucca's capability evidence, Glenn's
  security/privacy review, and Spekkio's independent `INNOVATION_PASS`, all
  bound to current revisions and evidence.
- Run the complete matrix from clean checkouts on declared Node LTS versions,
  all three runtimes, supported operating systems, polyglot/non-web fixtures,
  packed packages, upgrades, recovery, security, and correction loops.

## Required final handoff

Stop before the first real publication or release action and provide:

- exact commit/working-tree state and complete file-change inventory;
- test and conformance matrix with commands, versions, counts, and outcomes;
- real-runtime evidence for OpenCode, Claude Code, and Kiro;
- security and innovation verdicts with evidence references;
- package manifests, tarballs, checksums, SBOM, provenance, licenses, and
  prepared release notes;
- every unresolved defect, residual risk, missing environment, or PO decision;
- one explicit recommendation: `READY_FOR_FINAL_VERIFICATION` or
  `BLOCKED`, never an ambiguous completion claim.

The implementer must not mark final v1 complete. The Product Owner performs or
authorizes the last real-function verification and separately authorizes any
push, tag, npm publication, or GitHub Release.
