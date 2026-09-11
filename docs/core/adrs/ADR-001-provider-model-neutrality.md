# ADR-001: Provider and Model Neutrality

**Status:** Accepted
**Date:** 2026-09-10
**Authority:** Gaspar (Level 2)
**Decides:** `[FW §22, P1.25, REF §1224, PL.8]`

## Context

CHRONO must remain agnostic to which AI provider, model name, or model version is used for agent execution. The framework's authority, state model, gates, evidence requirements, and behavior must not depend on a specific provider or model.

A prior version of this framework's design risked embedding model-specific defaults in configuration, adapters, or tests, which would violate the neutrality principle and create a hidden coupling that could alter governance behavior when the model changes.

## Decision

1. **No hardcoded provider/model/version** in any CHRONO source, defaults, templates, generated agent definitions, tests, or adapters `[INV §11.2]`.
2. **External PO-owned configuration**: Model selection is external PO-owned configuration in `chrono.yaml`. If not configured, the Core returns `CONFIG_ERROR` — it MUST NOT select one `[FW §22, DOM §4.4]`.
3. **Domain stores only presence**: The domain model stores only that a model is "PO-selected, model name omitted from policy." The Core does not persist the model name `[DOM §4.4]`.
4. **Behavior independence**: Changing the model MUST NOT change authority, state, gates, evidence requirements, or behavior `[FW §22]`.
5. **Evidence records** record the runtime identifier but do NOT branch on it for policy decisions `[RUNTIME §9.1]`.

## Consequences

- **Positive:** The framework remains provider-agnostic. Swapping providers or models requires only re-attestation of RTK and Skill conformance, not changes to governance logic.
- **Positive:** Prevents accidental lock-in or behavioral coupling to a specific model's capabilities.
- **Negative:** No default model means new projects must explicitly configure one; this is intentional (fail-closed on ambiguity).
- **Risk mitigation:** Any code that attempts to import or reference a model identifier at compile time in core library code is rejected in review.

## Alternatives Considered

- **Default to a specific model:** Rejected — violates `[FW §22]` and creates lock-in.
- **Allow adapters to specify model:** Rejected — adapters execute; they do not configure policy.
- **Store model name in domain state:** Rejected — violates `[DOM §4.4]` and `[FW §22]`.

## Security Impact

None — this decision reduces the attack surface by eliminating model-specific behavior branches.
