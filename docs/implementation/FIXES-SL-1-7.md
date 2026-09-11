# Audit Report — Slices 1–7: Bugs, Security Flaws, and Doc Inconsistencies

**Status:** CLEARED 2026-09-11 — every item below fixed and re-verified
(workspace: lint/typecheck/build clean, 23 files / 195 tests pass; clean
checkouts on Node v22.21.1 and v24.20.0 green; packed install + global CLI
verified). Slice 8 may proceed.
**Verification basis:** full suite green at audit time (22 files / 185 tests),
line-by-line review of all Slice 6/7 code paths, cross-check against
`RUNTIME-CONTRACT.md`, `IMPLEMENTATION-PLAN.md`, `SLICE-6.md`, `SLICE-7.md`.

## 🔴 HIGH — Skill artifact integrity is not re-checked at dispatch — FIXED

Skill files are emitted into agent-reachable project directories
(`.claude/skills/`, `.opencode/skills/`, `.kiro/skills/`), but
`requireCurrentSkill` at dispatch time only checks attestation currency
(`validUntil` in the future) — it never re-hashes the on-disk files. An
agent that rewrites or weakens these files after verification is **not
detected** at dispatch, in direct tension with the "modified/divergent →
deny" requirement (`P8.6`, `INV §9`). This is the only finding that weakens
a core guarantee.
**Fix applied:** new `requireIntactSkillArtifacts` runs inside
`requireCurrentSkill` (dispatch + completion gates) and inside `validate()`:
the vendor file must hash to the stored `sourceHash` and every runtime file
to its stored generated hash; missing files deny (`BLOCKED_PROCESS_SKILL`),
mismatches deny (`SKILL_PROVENANCE_FAILURE`). Additionally,
`recordSkillAttestation` now enforces the PO-approved pin triple
(`pinnedCommit`/`sourceHash`/`converterVersion` vs `SKILL_RELEASE`), so a
compromised orchestrator session cannot attest a forged release. Covered by
a tamper/missing dispatch test in `authorization.test.ts`; fixtures now
emit matching files.
**Status: FIXED + verified** (dispatch tamper/missing denials tested;
full suite green).

## 🟡 MEDIUM — Two `RUNTIME §13` contract deviations — FIXED

1. The contract specifies adapter registration via a **YAML file in
   `.chrono/adapters/`**; Slice 6 implemented API/SQLite-only registration
   (`packages/core/src/chrono-core.ts:1957`).
2. The contract requires **PO approval** for new adapters; Slice 6 requires
   a PO *session* instead of a signature bound to the adapter.
**Fix applied (contract-compliant direction):** `chrono adapter register
--file` intakes strict-subset §13 YAML through a parser that owns no policy
(Core re-validates everything); registration creates a `pending` row; a
signed `adapter-registration` approval binding the exact registration hash
(`currentRevisionOf` extended to adapter scopes, new `adapter.approve`
matrix row, authority policy v3) activates it via `chrono adapter
activate`; revocation stays terminal. `RUNTIME-CONTRACT.md` §13 documents
the lifecycle. Covered by `adapter-registry.test.ts` (pending → approval →
active, confused-scope/unknown-approval/non-PO denials) and
`adapter-cli.test.ts` (file intake + e2e).
**Status: FIXED + verified** (full suite green).

## 🟡 MEDIUM — Bearer token passed into the child environment — FIXED

`runDispatch` injects the executor's `CHRONO_SESSION_TOKEN` (id + bearer
token) into the spawned process environment
(`packages/cli/src/index.ts:1431`), which is a non-deterministic agentive
runtime — tension with `RUNTIME §10.3` (secrets out of model context).
Works by design (the session binds adapter + runtime as the holder), but
**Fix applied (redesign):** the token no longer crosses into the child
environment at all — only `CHRONO_GRANT_ID/MODULE/ADAPTER` are injected,
and the adapter authenticates its hooks with the token it already holds
from session issuance. Asserted by test (token key absent from spawn env).
**Status: FIXED + verified** (full suite green).

## 🟢 LOW / Hardening — ALL FIXED

1. **Provider/model tripwire bypassable with whitespace:**
   `assertNoProviderModelBinding` misses `model = gpt`, `provider : x`,
   and the markers `api-key`, `secret`, `token=`. **Fix:** whitespace-
   tolerant regexes plus `api[_-]?key`, `secret\s*[:=]`, `token\s*[:=]`,
   `password` markers. Covered by extended tripwire cases.
2. **Dispatch TOCTOU:** the entrypoint is verified executable in
   `getAdapterForDispatch` but spawned later; a binary swapped in between
   runs under an authorized grant. **Fix:** executability re-checked
   immediately before spawn plus the binary's SHA-256 bound into the
   evidence diagnostics for the audit trail (remaining inherent window
   documented in code).
3. **Empty `conformanceProof` accepted:** a registration with zero proof
   commands carries no proof. **Fix:** at least one non-empty proof
   command required.
4. **Error-code fidelity:** `getAdapterForDispatch` throws
   `ENTITY_NOT_FOUND` / `CONFIG_ERROR` / `EXECUTION_DENIED`, but the CLI
   flattens everything to `ADAPTER_REJECTED`
   (`packages/cli/src/index.ts:1396`). **Fix:** the original `e.code`
   propagates (`ADAPTER_REJECTED` only as fallback).
5. **Double revocation** appends duplicate audit events (state itself is
   idempotent). **Fix:** audited no-op — second call returns ok with no
   new event (single `AdapterRevoked` event asserted in test). Same for
   re-activation.
6. **In-flight grants survive adapter revocation** (the grant binding does
   not include the adapter). Tolerable given short TTL, but **Fix:**
   grants now optionally bind `adapter_id` (migration 10, nullable for
   backward compatibility); bound grants burn fail-closed at consumption
   when the adapter is no longer approved. `chrono run` always binds.
   Covered by a revoke-after-issuance burn test.
7. **Fetch URL hardcodes org/repo** in `runSkillVerify` instead of deriving
   from `SKILL_UPSTREAM`. **Fix:** `skillRawSourceUrl()` derived from the
   constant, unit-tested.
8. **`permissionResult: "granted"` is asserted, not proven** (fs
   write/read proves filesystem permission only). **Fix:** limit documented
   in code at the call site; live-agent permission stays adapter duty.
9. **Doc nits:** `SLICE-7.md` says "refuses silently divergent" while the
   refusal is explicit; the WP path of `chrono run` is implemented but has
   no dedicated end-to-end test (only the module path does). **Fix:**
   wording corrected; WP AUTHORIZED→IMPLEMENTED dispatch test added.

**Status: ALL FIXED + verified** (workspace + both LTS clean checkouts
green, packed install verified).

## Next step (unblocked)

Per the plan, next is **Slice 8: live conformance of the first runtime
(OpenCode)** — native `gate` hooks, RTK routing proof, real skill
activation — preceded by **`chrono setup`**. Slice 8 still requires PO
decisions *before* coding: authorization to install/modify global runtime
configuration plus a live runtime environment. Without those, the Phase 6
MVP cannot proceed. This document's gate is CLEARED; the remaining PO
decisions above gate Slice 8, not this fix round.
