# ADR-009: RTK Posture Is Advisory-Only (Warn, Never Deny)

**Status:** Accepted (Product Owner decision)
**Date:** 2026-09-17
**Scope:** RTK attestation and routing-proof enforcement across the Core
**Supersedes:** fail-closed RTK denial semantics in SLICE-9 §9.3, INV §8 (I-07.1, I-07.5), CORE §10.2, Runtime Contract §6.3/§11, and the RTK portions of Protocols 01/06/07/08/09 listed below. Skill attestation (I-08) is unaffected and still fails closed.

## Context

RTK (Rust Token Killer, canonical upstream `https://github.com/rtk-ai/rtk`) entered CHRONO as a mandatory operational dependency: a missing, stale, incompatible, or bypassed attestation — or a missing/unproven routing proof — produced `BLOCKED_RTK` / `RTK_ROUTING_FAILURE` and denied dispatch, entry, binding use, verification, and completion. In practice a stale attestation (an ordinary TTL event on `MOD-0002`) blocked all execution work, including correction loops whose evidence was otherwise complete.

## Decision

The Product Owner decides: **RTK attestation generates a warning, but NEVER blocks work.**

- Every former RTK denial point (dispatch request/authorization/claim, broker entry redemption, binding validation, verification, module and aggregate completion, grant revalidation, deterministic `validate`) proceeds and records an audited `RtkWarning` event (severity `WARNING`) plus, where the result shape allows, returns the warning messages (e.g. `requestDispatch` → `rtkWarnings`).
- `chrono doctor`, `validate` (warnings section), dispatch results, and the audit export remain the observability surfaces for RTK posture.
- The `rtk verify` / `rtk prove` / `rtk promote` commands themselves keep command-level failures (non-genuine binary, bad inputs): a command failing is not "blocking work".
- Adapter approval authority is unchanged and still enforced independently at grant enactment.

## Consequences

- Stale/missing/unproven RTK no longer stops Gaspar entry, correction dispatch/claim/completion, verification verdicts, or module completion.
- Token-optimization evidence (attestations, routing proofs, savings) remains recorded and stays available for cost/optimization review, but is no longer authority.
- Conformance suites were rewritten from denial assertions to warn-and-proceed assertions; the SDD Innovation Standard §5 non-weakable list drops RTK (skill attestation stays).
- Residual risk accepted by the PO: agents may execute unoptimized (higher token use) with no auditable proof of command routing; drift/bypass of the RTK integration is advisory-only.

## Alternatives considered

- Keep fail-closed and fix operations only (auto-refresh, longer TTL): rejected by the PO as insufficient — the tool must not be able to stop the framework.
- Remove RTK entirely: rejected — the installation, verification commands, and telemetry stay for optimization value.
