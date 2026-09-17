# Slice 9 — Runtime Enforcement Closure

**Status:** IMPLEMENTED — NOT COMPLETE; corrective work and real-runtime acceptance remain
**Supersession note (2026-09-17, PO decision ADR-009):** §9.3 and exit criterion 3 (dispatch requires a current, valid, effective RTK routing proof) are superseded. RTK posture is advisory-only: dispatch proceeds with an audited `RtkWarning` whether routing is proven or not. The `prove`/`promote` mechanics, candidate/promote authority (ADR-006), and routing telemetry remain. All other exit criteria stand.
**Scope:** Close the remaining Phase 5 enforcement gaps before Phase 6 MVP proof.  
**Prerequisites:** Slices 1–8 and their corrective reviews are committed. The current factual baseline is this specification together with `SLICE-9-REPORT.md`, `FIXES-SL-10.md`, and `FIXES-SL-10.1.md`.
**Non-authorization:** This slice does not authorize package installation outside the project, global runtime mutation, paid model execution, publication, push, tags, releases, or security-risk acceptance.

## Objective

Make every supported runtime subject to the same Core-owned authorization,
RTK, process-skill, security, and evidence rules. Configuration presence,
fixture binaries, and test-only flags are not conformance evidence.

## 9.1 Close the PO enrollment trust boundary

Implement a single, documented initial PO enrollment ceremony. It must:

- be initiated through the global/local `chrono` CLI boundary, not an
  unrestricted public Core mutation;
- require a live interactive terminal, explicit human confirmation, and
  possession of the external private key stored outside the project;
- bind project identity, public-key fingerprint, timestamp, nonce, action, and
  rationale into the enrollment record;
- persist the public key and audit event atomically and never expose private
  key material to agents, logs, environment variables, project files, prompts,
  or child runtimes;
- deny redirected input, direct-Core enrollment without the ceremony,
  duplicate enrollment, replay, malformed confirmation, and partial failure;
- preserve the signed rotation and staged-key recovery behavior already
  implemented.

If the supported operating systems cannot provide a stronger human identity
primitive, stop and request one precise PO trust-boundary decision. Do not
weaken the existing contract or silently declare TTY possession sufficient.

## 9.2 Implement every declared CLI gate

Replace the `CONFIG_ERROR` placeholders for:

- `architecture-approval`;
- `spec-ready`;
- `verification`.

Each command must delegate to a named Core decision, validate exact scope,
revision, session, role, approval/security state, and return stable JSON and
human-readable `AUTHORIZED`/`DENIED` results. Adapters must consume these
commands rather than duplicate policy.

## 9.3 Make RTK routing proof mandatory

Add a runtime-neutral, Core-validated routing proof that binds:

- genuine RTK binary identity and compatible version;
- canonical upstream/provenance metadata;
- runtime, adapter, session, project, proof command, timestamp, and bounded
  validity;
- pre-command input, routed/re-written command evidence, preserved exit status,
  and redacted/full-evidence references;
- `rtk gain` availability and token-saving metrics kept distinct from billing
  claims.

Only an approved adapter session may submit a proof. The Core must validate the
proof and persist it append-only. Dispatch must deny when routing is missing,
false, expired, stale, belongs to another runtime/adapter/project, is modified,
or the adapter is revoked. No raw-output fallback is permitted.

## 9.4 Complete OpenCode enforcement

- Map and gate every OpenCode tool or operation capable of filesystem,
  process, network, package, Git, credential, deployment, destructive, or
  production-impacting effects; do not gate only `bash`.
- Treat unknown mutable tools as denied until classified.
- Prove `chrono run` dispatch and direct `opencode run` usage both reach the
  native gate.
- Prove real RTK routing and active Karpathy Guidelines use by every CHRONO
  role, with no model/provider hardcoding.
- Preserve session tokens outside model-visible child environments.

## 9.5 Implement equivalent Claude Code and Kiro adapters

For each runtime, provide versioned adapter assets, setup description, native
pre-tool enforcement, role definitions, skill activation, RTK routing,
capability discovery, restart-safe session binding, evidence collection, and
fail-closed conformance. Runtime-specific hooks translate Core decisions but
must not own lifecycle policy.

The same black-box conformance suite must run against OpenCode, Claude Code,
and Kiro. A missing runtime may be reported as an environment blocker, but its
mandatory v1 conformance may not be skipped, mocked, or marked passed.

## Required adversarial tests

- Direct Core and redirected-input attempts cannot establish initial PO trust.
- Every gate denies missing/stale/wrong-scope/wrong-role inputs and preserves a
  single parseable JSON envelope.
- A test-only `routingTestPassed: true` cannot enter production authority.
- Forged, replayed, stale, cross-adapter, cross-runtime, cross-project, and
  revoked-adapter routing proofs deny dispatch.
- Replacing RTK or adapter binaries after proof invalidates authorization.
- Unknown mutable tools and direct-runtime bypass attempts fail closed.
- Modifying or removing any emitted mandatory skill invalidates dispatch.
- No session token, signing key, secret, or unredacted sensitive output reaches
  prompts, child environments, logs, fixtures, or audit exports.
- All seven roles have positive duty tests and negative cross-role tests on all
  three runtimes.

## Verification loop

Run until no finding remains:

1. focused unit and integration tests after each vertical change;
2. full tests, lint, typecheck, build, and `git diff --check`;
3. clean installs on every declared Node.js LTS version;
4. packed tarball/global CLI fixture with no workspace links or source imports;
5. black-box adapter conformance with real installed runtime binaries;
6. security review of enrollment, tokens, hooks, command routing, redaction,
   subprocess boundaries, TOCTOU, replay, revocation, and failure atomicity;
7. documentation and generated-asset drift check.

## Exit criteria

Slice 9 is complete only when:

1. initial PO enrollment meets §9.1 or a narrowly scoped PO decision is
   recorded without falsely claiming stronger identity assurance;
2. all declared gates execute real Core decisions with adversarial coverage;
3. dispatch requires a current, valid, effective RTK routing proof;
4. OpenCode, Claude Code, and Kiro each pass the same native-hook, direct-use,
   RTK, skill, authority, security, restart, and failure conformance suite;
5. no runtime/provider/model is hardcoded and no adapter can weaken Core policy;
6. clean LTS, packed-install, global CLI, upgrade, and restart checks pass;
7. the report lists exact evidence and honest residuals, with no stubs, skips,
   simulated mandatory integrations, or future-work placeholders in Slice 9
   scope.

Slice 10 was implemented before this slice received an independent `COMPLETE`
disposition. That implementation may remain, but it does not waive this gate.
Resolve the code and contract findings in
[`FIXES-SL-10.1.md`](FIXES-SL-10.1.md), obtain the missing real-runtime
evidence, and then perform a fresh independent disposition of both slices
before closing the all-runtime Phase 6 gate. The bounded OpenCode-only Phase 6A
pilot is separately governed by `OPENCODE-PILOT-GATE.md`. Stop only at a
genuinely required PO decision or external-action authorization.
