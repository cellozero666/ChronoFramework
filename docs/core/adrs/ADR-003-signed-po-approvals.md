# ADR-003: Human-Interactive Signed PO Approvals

**Status:** Accepted
**Date:** 2026-09-10
**Authority:** Gaspar (Level 2)
**Decides:** `[P2.10, FW §13, FW §1196, REF §1196]`

## Context

CHRONO's authority model relies on the Product Owner holding ultimate authority over product decisions, risk acceptance, and security decisions. This authority MUST be exercised through explicit, human-interactive, cryptographically signed events so that:
1. No agent, prompt, or adapter can impersonate the PO.
2. Approvals are bound to exact artifact revisions (material change invalidates them).
3. Approval state is persistent and independent of any AI session.
4. Every signature captures action, scope, artifact identity, revision/hash, signer, and timestamp.

## Decision

1. **Interactive-only issuance**: PO approval, waiver, and risk acceptance commands (`chrono approve`, `chrono waive`) MUST verify an interactive terminal session. `stdin` and `stdout` MUST both be TTYs. Non-interactive invocation returns `APPROVAL_REQUIRED` `[FW §1196, P2.10]`.
2. **Signing key isolation**: The signing key MUST be sourced from the OS keychain (or equivalent secure key store). The Core MUST NOT read the key from the project directory, environment variables in the project context, or prompt-injected context `[FW §1196, P2.10, REF §1196]`.
3. **Signature binding**: Every signature is computed over the canonical JSON of:
   ```json
   {
     "action": "<action_type>",
     "scope_artifact_id": "<id>",
     "scope_revision": "sha256:...",
     "authority": "<signer_identity>",
     "rationale": "<text>",
     "timestamp": "<ISO-8601 UTC>"
   }
   ```
   This satisfies `[FW §13]`: every signature binds action, scope, artifact identity, exact revision/hash, signer, and timestamp.
4. **Append-only persistence**: All approval events are written to SQLite `event_log` and `approval` table. No UPDATE or DELETE on approval rows `[FW §13, P3.5]`.
5. **Material-change invalidation**: When an artifact's revision hash changes, all approvals bound to the previous revision are automatically considered stale/invalid. The Core MUST detect this and return `APPROVAL_REQUIRED` `[FW §1196, P2.10, P3.5]`.
6. **No automation bypass**: Agents and adapters MUST NOT call approval endpoints on behalf of the PO. There is no API token, no `--batch` mode, no `--yes` flag that bypasses interactivity `[P2.10, FW §13]`.

## Consequences

- **Positive:** Unforgeable, auditable authority. The Product Owner's decisions cannot be simulated or bypassed.
- **Positive:** Approvals are tied to artifact revisions, ensuring that a material change to a spec or module automatically invalidates prior approval.
- **Negative:** The PO must be physically present at an interactive terminal for approvals and waivers. This is intentional.
- **Negative:** If the signing key is lost, approvals cannot be reproduced; the PO must re-attest. This is acceptable for security.

## Alternatives Considered

- **API token-based approval**: Rejected — tokens can be exfiltrated, shared, or automated by agents.
- **Git commit signature as proof of approval**: Rejected — commits are not bound to artifact revision hashes and can be scripted without interaction.
- **OAuth-style delegated approval**: Rejected — delegates authority to an intermediary, violating PO supremacy `[FW §5]`.

## Security Impact

This is the primary security boundary for human authority in the framework. The signing key NEVER enters the project directory or agent-accessible context. Even a compromised agent cannot approve work.
