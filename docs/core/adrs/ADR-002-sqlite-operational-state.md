# ADR-002: SQLite for Transactional Operational State

**Status:** Accepted
**Date:** 2026-09-10
**Authority:** Gaspar (Level 2)
**Decides:** `[P3.9, FW §671, REF §24]`

## Context

CHRONO requires transactional storage for operational state: events, state transitions, approvals, waivers, evidence indexes, attestations, and blockers. This data must be:
- Independent of any LLM session, model, or runtime `[FW §585-607]`
- Append-only for approvals, waivers, evidence, and attestation events `[FW §13]`
- Reproducible and deterministic `[P7.6]`
- Local (no network dependency for core operations)

## Decision

1. **Use SQLite** as the single transactional store for all operational state, located at `.chrono/chrono.db` `[P3.9]`.
2. **Hybrid ownership**: Markdown/YAML files remain the authoritative human-readable contracts; SQLite is the transactional event store — NOT a replacement for documents `[P3.9, FW §671]`.
3. **Append-only for critical events**: ApprovalGranted, WaiverGranted, EvidenceRecorded, RtKAttested, SkillAttested, and all event-log entries are append-only. No UPDATE or DELETE on these rows `[FW §13, P3.5]`.
4. **Schema management**: The schema is defined in `.chrono/schema.sql` and applied idempotently by the Core on startup.
5. **Session independence**: All operational state mutations go through the Core, never through direct file edits or prompt-driven changes `[FW §648, P7.5]`.

## Consequences

- **Positive:** Deterministic, local, zero-configuration, ACID-compliant storage.
- **Positive:** Events are auditable and append-only, satisfying traceability requirements.
- **Positive:** Session-independent — closing an LLM session does not erase state.
- **Negative:** SQLite file is binary; requires tooling to inspect. Mitigated by event log tables with human-readable payloads.
- **Risk mitigation:** Schema is version-controlled and checked for drift on Core startup.

## Alternatives Considered

- **PostgreSQL server**: Rejected — adds network dependency and setup overhead for what is fundamentally a local project governance tool.
- **JSON/YAML files for operational state**: Rejected — lacks transactional semantics; concurrent agent writes risk corruption.
- **Embedded key-value store**: Rejected — SQLite provides relational querying needed for joins (references, dependencies, blockers).

## Security Impact

SQLite file stores no secrets. Any secret detected in an evidence payload is rejected before persistence `[INV §14.5, DOM §3.19]`.
