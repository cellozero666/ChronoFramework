# ADR-005: Karpathy Guidelines Process-Skill Requirement

**Status:** Accepted
**Date:** 2026-09-10
**Authority:** Gaspar (Level 2)
**Decides:** `[P6.6, P1.41, REF §13, P8.6, DOM §3.28]`

## Context

All CHRONO agent runtimes MUST use the Karpathy Guidelines skill from `https://github.com/multica-ai/andrej-karpathy-skills`. This skill establishes mandatory process behaviors for agent reasoning, planning, and safety. The framework must:
1. Pin to an immutable reviewed commit — floating `main` is unacceptable for production.
2. Deterministically generate runtime-specific artifacts (Claude Code, OpenCode, Kiro) from `skills/karpathy-guidelines/SKILL.md` without LLM rewriting.
3. Preserve MIT license and attribution.
4. Verify skill discovery, permission, and activation in every runtime.
5. Fail closed if the skill is missing, divergent, untrusted, inactive, or bypassed.
6. Keep the skill's authority subordinate to PO → CHRONO protocols → approved artifacts → role rules.

## Decision

1. **Canonical upstream**: Only `https://github.com/multica-ai/andrej-karpathy-skills` is accepted. References to other repositories MUST NOT silently redirect `[P6.6, REF §1196]`.
2. **Pinned commit**: The upstream is pinned to an immutable reviewed commit hash. The attestation records `pinned_commit` and verifies it matches `git rev-parse HEAD` at attestation time `[P1.41, REF §1196]`.
3. **Deterministic generation**: Runtime artifacts for Claude Code, OpenCode, and Kiro MUST be deterministically generated from `skills/karpathy-guidelines/SKILL.md` (source hash verified). LLM rewriting of the skill is forbidden `[P6.6, REF §1190, P8.6]`.
4. **Generated hash verification**: The Core stores `generated_hashes` per runtime. At attestation, it recomputes hashes and compares. Divergence → `SKILL_PROVENANCE_FAILURE` `[DOM §3.28]`.
5. **License preservation**: MIT license and attribution MUST be preserved in all generated artifacts `[P6.6, REF §1196]`.
6. **Activation required**: The skill MUST be active (not merely discoverable) before analysis, planning, implementation, tests, security review, or verification. On-demand discovery alone is insufficient `[P6.6, REF §1198]`.
7. **Dispatch-time check**: Before agent dispatch, the Core MUST verify a current SkillAttestation with `status == current`. If missing, divergent, untrusted, inactive, or bypassed → `BLOCKED_PROCESS_SKILL` `[P6.6, P8.5]`.
8. **Subordination**: The skill MUST NOT override CHRONO authority, redefine contracts, accept risk, clear blockers, or simplify away mandatory controls `[FW §1224, P6.6, P7.4]`.

## Consequences

- **Positive:** Ensures consistent, reviewed process behaviors across all CHRONO runtimes.
- **Positive:** Immutable pinning prevents supply-chain drift through floating `main`.
- **Positive:** Deterministic generation prevents LLM drift from the canonical skill.
- **Negative:** Runtime changes to the skill require a new pinned commit and re-attestation. This is intentional.
- **Risk:** If the upstream repository is compromised, the pinned-commit check and source-hash verification detect divergence.

## Alternatives Considered

- **Floating `main` branch**: Rejected — vulnerable to upstream drift, malicious commits, or accidental breakage `[P1.41]`.
- **LLM-summarized skill**: Rejected — introduces non-determinism and potential behavioral drift `[REF §1190]`.
- **Runtime-specific skill versions**: Rejected — violates cross-runtime equivalence `[FW §22]`.

## Security Impact

The skill defines agent reasoning behaviors. Its immutability, deterministic generation, and activation verification ensure that the framework's process guarantees cannot be undermined by a modified or unactivated skill. The skill is subordinate to CHRONO protocols — it cannot override governance.
