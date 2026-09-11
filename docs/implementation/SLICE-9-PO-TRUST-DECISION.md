# Slice 9 — PO Trust-Boundary Decision (exit criterion 1)

**Date:** 2026-09-11
**Decided by:** Product Owner (interactive decision during implementation)
**Scope:** Initial PO signing-key enrollment ceremony (`chrono enroll` / `Core.enrollPo`)

## Decision

The Product Owner accepts terminal-possession + key-possession + typed
confirmation as the v1 initial-trust boundary, documented as such, with no
stronger human-identity claim.

## What the ceremony proves

1. Live interactive terminal (`isInteractiveTerminal`).
2. Human-typed challenge read from `/dev/tty` (Windows: `CON`), never from
   stdin — piped, redirected, or captured input cannot satisfy confirmation
   (`readConfirmationFromTty`, `runEnroll`).
3. Possession of the enrolled private key — the enrollment payload
   (`po-enroll` / project / fingerprint / timestamp / nonce / rationale /
   confirmation) is signed with it and verified under the enrolled public
   key (`Core.enrollPo`, `SIGNATURE_INVALID` otherwise).
4. OS-keychain custody with atomic persistence; duplicate enrollment,
   replay, stale proof, malformed confirmation, and partial failure are
   denied without persisting state.
5. Direct-Core first registration without the ceremony is denied
   (`registerPoPublicKey` returns `APPROVAL_REQUIRED` when no key is
   enrolled); rotation still requires a signature from the current key.

## Explicit non-claim

The ceremony does not prove the human at the terminal is the legitimate
Product Owner beyond terminal possession. macOS, Linux, and Windows offer
no stronger portable identity primitive to the CLI. This TOFU-with-ceremony
boundary is accepted for v1 and must be described exactly this way in user
documentation. A stronger primitive (signed SSO, hardware key, manual
fingerprint ceremony) is a post-v1 option, not a v1 gate.

## Authority

This record documents the decision; it does not substitute for the
implementation evidence (adversarial enrollment tests in
`packages/core/src/approval-security.test.ts` and `packages/cli/src/authority-cli.test.ts`).
