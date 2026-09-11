# ADR-004: RTK (Rust Token Killer) Requirement

**Status:** Accepted
**Date:** 2026-09-10
**Authority:** Gaspar (Level 2)
**Decides:** `[P6.5, P1.37, REF §13, P8.7, DOM §3.27]`

## Context

All agent-driven CLI execution in CHRONO must route through a genuine RTK (Rust Token Killer) binary from `https://github.com/rtk-ai/rtk`. RTK provides token-cost savings and enforces command routing. The framework must:
1. Prove the binary is genuinely Rust Token Killer (not a name collision).
2. Prove effective command routing (not just configuration-file presence).
3. Fail closed if RTK is missing, stale, incompatible, or bypassed.
4. Treat RTK as external to CHRONO domain ownership — it does not define CHRONO state or governance.

## Decision

1. **Canonical provenance**: Only the binary from `https://github.com/rtk-ai/rtk` is accepted. The attestation records `provenance = "https://github.com/rtk-ai/rtk"` `[DOM §3.27]`.
2. **`rtk gain` proof**: A successful `rtk gain` invocation is REQUIRED to prove the binary is genuinely Rust Token Killer. `rtk --version` alone is insufficient `[INV §8.2, REF §123]`.
3. **Routing self-test**: Each adapter MUST prove effective command routing through a routing self-test. Configuration-file presence (`rtk.yaml`) is NOT proof of operation `[P8.7, INV §8.4]`.
4. **Dispatch-time check**: Before any agent-driven CLI dispatch, the Core MUST verify that a current RTKAttestation exists with `status == current`. If missing, stale, invalid, or bypassed, dispatch is denied with `BLOCKED_RTK` `[P6.5, P8.5]`.
5. **Freshness/TTL**: RTKAttestation has a TTL from `chrono.yaml`. After TTL, it transitions to `stale`. Re-verification (`rtk gain` + routing test) is required `[STATE §4.1, INV §8.5]`.
6. **Bypass events**: Any detected bypass attempt transitions the attestation to `invalid` and is recorded in the event log `[INV §8.1]`.
7. **No domain ownership**: RTK does NOT own CHRONO state, governance, gates, or lifecycle. Token savings evidence from RTK is NOT conflated with billing savings validation `[REF §1192, P6.5]`.

## Consequences

- **Positive:** Ensures all agent execution is token-managed and routed through a verified binary.
- **Positive:** Name collisions (another package named `rtk`) are detected via `rtk gain`.
- **Positive:** Configuration-file tampering cannot bypass the requirement.
- **Negative:** New environments must install and verify RTK before any agent work can proceed.
- **Risk:** If the RTK upstream is compromised, the `rtk gain` self-test and routing verification serve as detection mechanisms.

## Alternatives Considered

- **Environment variable check**: Rejected — env vars can be spoofed or set by compromised code.
- **Version string match only**: Rejected — vulnerable to name collision attacks `[INV §8.2]`.
- **Allow raw fallback when RTK absent**: Rejected — violates fail-closed and `[REF §1192]`.

## Security Impact

RTK acts as a security boundary for token-cost control and command routing. The `rtk gain` identity proof ensures that only the genuine Rust Token Killer binary is trusted. Configuration-file presence is explicitly insufficient.
