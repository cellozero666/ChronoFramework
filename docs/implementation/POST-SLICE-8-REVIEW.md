# Post-Slice 8 Independent Review

**Status:** REVIEWED — implementation may continue; not MVP-complete and not release-ready  
**Reviewed baseline:** `2d1043c` (`main`, synchronized with `origin/main`)  
**Review date:** 2026-09-11  
**Authority:** This report records implementation evidence and gaps. It does not override normative protocols, accept risk, authorize publication, or make a Product Owner decision.

## Verified baseline

The committed baseline was exported with `git archive` into an isolated
directory and installed without inherited `node_modules` or build output.

- `npm ci`: passed on the review host with Node.js v24.20.0.
- `npm test`: 24 files, 205 tests passed, none failed.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- The four previously reported authority defects are corrected: privileged
  session bootstrap, exact actor/session identity, exact grant/session binding,
  and staged PO key rotation.
- The repository working tree was clean and `main` matched `origin/main` at
  review time.

The workspace's existing `node_modules` contained a `better-sqlite3` binary
built for a different Node ABI. That local dependency cache failed before
tests could exercise product code; the isolated install passed. Developers
switching Node major versions must reinstall or rebuild native dependencies.

## Confirmed implementation strengths

- The Domain/Core owns canonical roles, deny-by-default capabilities, state
  transitions, approvals, evidence, blockers, grants, and completion rules.
- Privileged Gaspar/PO sessions require a current PO-key signature and a
  single-use, atomically consumed authorization nonce.
- Execution grants bind exact project/module/WP/spec/Harness revisions,
  attestations, approvals, adapter where applicable, role, and session.
- Approval and waiver signatures bind canonical payloads; audit-critical rows
  and revision history have adversarial tamper tests.
- The pinned Karpathy Guidelines source is hash-verified and deterministically
  emitted for OpenCode, Claude Code, and Kiro.
- The OpenCode setup/plugin path and adapter-neutral dispatch foundation exist.

## Release-blocking gaps against the normative documents

### 1. RTK routing is observable but not enforced

Production `rtk verify` records `routingTestPassed: false`; dispatch validates
attestation currency but does not require an effective routing proof. The
Runtime Contract and Core Invariants require actual routing and fail-closed
denial when it is absent or bypassed. A production routing-proof submission
and verification path is required before dispatch enforcement can be enabled.

### 2. Three advertised gates are not implemented

`chrono gate architecture-approval`, `chrono gate spec-ready`, and
`chrono gate verification` return `CONFIG_ERROR`. Each must invoke a
deterministic Core decision and return stable human/JSON envelopes.

### 3. Runtime parity is incomplete

OpenCode has the first native pre-tool plugin, currently limited to `bash`.
Claude Code and Kiro do not yet have equivalent, live-proven adapters and
blocking hooks. Emitting skill files is not runtime conformance or activation
proof.

### 4. Initial PO trust enrollment needs closure

After enrollment, privileged authority is cryptographically protected. First
public-key registration still follows trust-on-first-interactive-use. The v1
contract requires a direct Core caller or agent to be unable to enroll itself
as PO merely because it owns a TTY. Slice 9 must define and implement a
single CLI-owned enrollment ceremony backed by external key possession,
explicit human confirmation, atomic persistence, and adversarial direct-Core
denial. If the platform cannot supply a stronger identity primitive, the PO
must explicitly decide and document the supported trust boundary; the agent
must not silently accept TOFU as proof of human identity.

### 5. Phase 6 and Phase 7 evidence does not exist yet

No evidence currently proves the complete lifecycle on both greenfield and
existing repositories across OpenCode, Claude Code, and Kiro. The mandatory
dry run, scoped drift invalidation, portable/redacted audit export, local
metrics, rigor profiles, policy-pack boundary, polyglot/non-web fixtures,
recovery, release provenance, SBOM, and cross-platform packaging gates also
remain.

## Documentation corrections made with this review

- Historical reports now distinguish their at-report-time uncommitted state
  from the current committed repository state.
- The root README describes unverified items as the v1 release contract rather
  than claiming the current commit already provides full cross-runtime
  conformance.
- The documentation index points to this review, Slice 9, and the implementer
  task queue.

## Decision

Continuation is authorized at the implementation level. Slice 9 is the next
blocking slice. MVP, final-v1, npm publication, GitHub Release creation, tag,
push, signing, and remote changes remain unauthorized until their documented
gates pass and the Product Owner explicitly authorizes the external action.
