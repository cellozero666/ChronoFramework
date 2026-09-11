# Slice 5 Remediation Gate

**Status:** COMPLETE
**Reopened:** 2026-09-11 — independent review rejected the prior COMPLETE claim (10 blocking findings: syntactic-only identity/sessions, incomplete grant binding, grantless execution cycle, TTY insufficiency, destructive key generation, matrix divergence, migration audit gaps).
**Completed:** 2026-09-11 — all exit criteria re-evidenced from clean checkouts on both declared Node.js LTS versions (see evidence table below); PO authorized completion and start of Slice 6.
**Scope:** domain, persistence, Core, CLI, packaging, and tests created through Slice 5
**Rule:** Do not start or claim completion of Slice 6 until every exit criterion below passes from a clean checkout.

## Purpose

Correct the first implementation so it enforces the existing CHRONO contracts
instead of merely representing them in types, comments, or prompts. This gate
does not authorize new product policy. When a normative requirement is truly
ambiguous, record the conflict and request a Product Owner decision.

## Required corrections

### 1. Reproducible toolchain and package installation

- Replace the unsupported/manual workspace-link arrangement with an npm
  workspace configuration that installs with `npm ci` from a clean checkout.
- Remove any dependency on manually created `node_modules/@chrono/*` symlinks.
- Declare runtime dependencies in the packages that consume them and ensure
  published packages can run outside the monorepo.
- Define and test the supported Node.js LTS range. Native dependencies must
  install or rebuild correctly for every declared version.
- Replace the invalid ESLint configuration with an ESLint 9 flat configuration.
- Do not allow `passWithNoTests` to conceal an absent mandatory test suite.

### 2. Close Core bypasses

- Validate identity, entity type, initial state, required fields, schema, and
  content before any artifact is persisted.
- Do not allow callers to create a Spec as `READY`, a Module as `APPROVED` or
  `COMPLETE`, a Work Package as `AUTHORIZED`, or any equivalent gated state.
- Make transition guards authoritative. Approval, security, Harness, evidence,
  attestation, dependency, blocker, and role requirements must be evaluated by
  the Core before persistence.
- Keep adapters and the CLI thin; moving policy out of the Core is forbidden.
- Remove or strictly isolate unrestricted writable database handles from the
  public production API.

### 3. Approval, waiver, and authority integrity

- An arbitrary non-empty signature must never be considered valid.
- Implement the canonical signed payload and cryptographic verification from
  ADR-003 and the Core Specification.
- Human authority commands must require verified identity, external key access,
  and an interactive terminal. Missing prerequisites return
  `APPROVAL_REQUIRED` without persisting an approval.
- Agents, adapters, redirected input, tests, and direct Core calls must be
  unable to impersonate the PO.
- Preserve separate architecture-security, module, implementation-security,
  waiver, and residual-risk decisions. Generic approval cannot substitute.

### 3A. Agent identity and role authority

- Use the canonical machine identifiers `gaspar`, `belthazar`, `melchior`,
  `prometheus`, `lucca`, `glenn`, and `spekkio`. Reject `luca`, `agent`, unknown
  roles, and case variants rather than silently normalizing them.
- Model `AgentRole`, `ActorIdentity`, `HumanIdentity`, `AdapterIdentity`,
  `RuntimeIdentity`, `SessionIdentity`, `ModelIdentity`, and `ToolIdentity` as
  distinct concepts. A union with unrestricted `string` MUST NOT erase the
  closed agent-role set.
- Implement one deny-by-default, Core-owned authority/capability matrix derived
  from the Authority Protocol and Framework Definition. Persist its policy
  version with authorization evidence.
- Bind an authorized dispatch to an authenticated adapter session and exactly
  one assigned CHRONO role. Validate actor, role, assignment, scope, revision,
  operation, and session freshness on every protected Core command.
- Enforce role ownership for analysis/architecture, implementation, UX,
  infrastructure, testing evidence, security evidence/blockers, and independent
  verification. Spekkio independence and PO-only authority cannot be delegated.
- Do not postpone this policy to Phase 5. Phase 4 implements and tests the
  runtime-neutral mechanism; Phase 5 only maps it to real OpenCode, Claude Code,
  and Kiro definitions and hooks.

### 4. Revision history, references, and audit immutability

- Preserve every artifact revision; a new revision must not overwrite the row
  required to resolve an older `<ID>@<revision>` reference.
- Enforce valid source and target references and detect stale revisions.
- Protect critical events, approvals, waivers, evidence, attestations, and audit
  records against update/delete, including through raw SQL paths.
- Corrections and revocations must append new events/state rather than rewrite
  historical facts.
- Fix event semantics, including `BlockerResolved` transitioning from `active`
  to `resolved`, and use collision-safe Core-assigned identifiers matching the
  documented format.

### 5. Deterministic validation and authorization

- `validate` must implement the deterministic checks listed in the Consistency
  Validation Protocol; it must not label a project valid after skipping an
  applicable check.
- Verify the complete `sha256:<64 lowercase hex>` value against canonical
  content. Reject unsupported/non-canonical input rather than hashing it
  ambiguously.
- Treat gate-relevant active blockers as blockers, not informational warnings.
- Report persisted/projected-state divergence as an error.
- Validate complete traceability, Spec/Harness cardinality, dependency
  existence and acyclicity, approval freshness, evidence/waiver/attestation
  freshness, and security decisions where applicable.
- Until all execution prerequisites are implemented, `authorizeExecution`
  must deny with an explicit missing-capability/gate result. It must never
  return success after comments or placeholder checks for Spec readiness,
  Harness, dependencies, references, security, RTK, or process skill.

### 6. Known correctness defects

- Persist the `runtime` selected during initialization and validate it according
  to the Runtime Contract.
- Persist the supplied verification `defectIds`; validate referenced defects,
  evidence, waivers, module state, reviewer authority, and exact revision.
- Use `Lucca`/the approved canonical role identifier consistently.
- Reconcile the Decision state set and transition table without inventing a new
  lifecycle.
- Ensure Core-construction and unexpected CLI failures produce structured,
  explainable, non-zero failures and close partially opened resources.
- Keep CLI/package versions derived from one authoritative release value.

## Mandatory adversarial tests

Tests must prove rejection, not only successful paths:

- invalid initial states and unknown entity states;
- forged, malformed, stale, non-interactive, wrong-authority, and wrong-scope
  approvals;
- direct transition attempts that omit each required guard;
- unknown roles, `luca`, generic `agent`, role spoofing, cross-role operations,
  session replay, adapter/agent identity confusion, and PO impersonation;
- update/delete attempts against append-only records;
- resolution of current and historical exact revisions;
- missing/orphan/stale references and cyclic dependencies;
- blockers scoped to project, module, Spec, Harness, and dependency branches;
- missing/stale Harness, security decisions, RTKAttestation, and
  SkillAttestation;
- PASS/WAIVED separation and completion without current evidence;
- timestamp/identifier collision and concurrent persistence behavior;
- malformed canonical content, invalid hashes, and unsupported values;
- CLI errors before Core initialization and JSON output on every failure path;
- restart/reopen behavior using separate processes;
- fresh install, package build, packed-package install, and global `chrono`
  invocation without manual links.

Tests may use test-only signing keys and deterministic clocks, but production
validation must remain real and the fixtures must not create a bypass available
to runtime code.

## Exit criteria

This remediation is complete only when all of the following are evidenced:

1. A clean checkout succeeds with `npm ci`, lint, typecheck, build, and the full
   test suite on every declared Node.js LTS version.
2. Packed packages install in an isolated fixture and the global `chrono`
   executable performs `init`, `status`, and `validate` across process restarts.
3. Every adversarial test above passes, with no skipped or todo test and no
   manually created workspace link.
4. No public API can persist a gated state or valid approval while bypassing the
   same Core decision required by the CLI.
5. Every protected operation denies unknown, unassigned, wrong-role,
   stale-session, and impersonated actors; all seven canonical roles have
   positive and negative authority tests.
6. Audit/revision tamper attempts fail, and historical exact revisions remain
   resolvable.
7. Documentation, schemas, migrations, package metadata, and observed runtime
   behavior agree.
8. The implementation report lists commands, exact results, files changed,
   unresolved PO decisions, and any remaining blocker. Do not report “complete”
   while a required capability is a stub, comment, mock-only proof, or future
   slice placeholder.

## Completion evidence (2026-09-11)

Clean checkouts were built by copying the working tree (excluding
`node_modules`, `dist`, `.git`) to `/tmp/chrono-clean` (Node 22) and
`/tmp/chrono-clean24` (Node 24); no manual workspace links were created
(`node_modules/@chrono/*` are npm-managed symlinks only).

| # | Criterion | Evidence |
|---|-----------|----------|
| 1 | Clean checkout: `npm ci`, lint, typecheck, build, full suite on every declared LTS | Node v22.21.1: `npm ci` clean, `eslint .` clean, `tsc --noEmit` clean, `tsc -b packages/cli` clean, 18 files / 163 tests pass. Node v24.20.0: same sequence clean, 18 files / 163 tests pass; `better-sqlite3` native binding loads. |
| 2 | Packed install + global `chrono` init/status/validate across restarts | `npm pack` produced 4 tarballs (dist only, 0 test files). Isolated fixture installed all four tarballs; `chrono init --runtime test-runtime` → `status` → `validate` → VALID, each in a separate process. |
| 3 | Adversarial tests pass, no skips/todos/manual links | 163/163 pass; repo-wide grep finds no `.skip`/`.todo`/`it.only`/TODO stubs (only comments quoting the rule). |
| 4 | No public API bypasses Core decisions | Sessions are mandatory (`CallerAuth`), grants bind exact role+session, transitions revalidate every binding; `database.ts` exposes typed repositories only. |
| 5 | Deny unknown/unassigned/wrong-role/stale/impersonated; 7 roles ± tests | `authority-matrix.test.ts` (10), `transition-guards.test.ts` (8), `authorization.test.ts` (17) cover all seven roles positively and negatively, plus TTY-only privileged mint denial and signed-bootstrap replay denial. |
| 6 | Tamper attempts fail; history resolvable | `audit-immutability.test.ts` (5, incl. raw-SQL UPDATE/DELETE), `revision-history.test.ts` (3), `migration.test.ts` (v1→v8, idempotent, luca→lucca audit). |
| 7 | Docs/schemas/migrations/behavior agree | `SCHEMA_VERSION = 8` at gate time (Slice 6 later advanced it to 9 with migration-tested upgrades); CLI help/options match Core behavior (`--requester-token`, `--rotate`, `--rationale`); package metadata SPDX `Apache-2.0`, single-source version. |
| 8 | Report | `docs/implementation/SLICE-6.md` (§5-evidence scope) records commands, results, files, PO decisions, and blockers. |

**Accepted residual (fail-closed, not a bypass):** `chrono skill verify`
refuses to record until pinned release metadata lands (Slice 8); the
Core `recordSkillAttestation` path itself is fully implemented and
tested, and dispatch denies without a current attestation.

After this gate is independently reviewed and marked `COMPLETE`, continue with
the remaining implementation plan. Do not publish, push, or create a release
without explicit Product Owner authorization.
