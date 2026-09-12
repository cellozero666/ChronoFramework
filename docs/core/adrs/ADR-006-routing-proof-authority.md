# ADR-006: Routing-Proof Authority (Candidate → Authoritative Promotion)

**Status:** Accepted
**Date:** 2026-09-11
**Authority:** Gaspar (Level 2)
**Decides:** `[FIXES-SL-10.1 C2, C3, INV §8.4, INV §14.4]`
**Supersedes:** ADR-004 §2–§3 routing-proof semantics (attestation identity rules in ADR-004 §1, §4–§7 are unchanged)

## Context

Slice 9 §9.3 requires that only an approved adapter session may submit an
authoritative routing proof, but the safe setup order proves routing BEFORE
the PO's adapter-approval decision (evidence precedes approval: the approver
reviews evidence, not promises). Recording proofs only after approval would
force approval of unproven routing; recording authoritative proofs before
approval would let a self-asserted adapter label mint authority.

Separately, the previous proof flow executed an operator-supplied `rtk ...`
command (in practice `rtk gain`) and recorded success. `rtk gain` proves the
genuine binary and its dashboard, but no runtime command passes through the
hook path for it — so it cannot prove effective interception (Slice 9 §9.3:
a runtime command actually routed or rewritten).

## Decision

1. **Effective-routing proof (C2).** `chrono rtk prove` takes the RAW
   pre-routing command (never `rtk`-prefixed, never identity-only), maps it
   with `rtk rewrite` — the documented single source of truth the hooks use
   — executes the mapped command only if it resolves to the genuine,
   attested binary, and records exit status plus hashes of the pre-routing
   input, the routed command, and the capped output. Identity-only heads
   (`gain`, `--version`, `config`, `init`, `help`), rewrite refusals,
   mapping escapes, non-zero exits, and oversized outputs record nothing.
2. **Candidate by default (C3, option 1).** Every recorded proof is a
   non-authoritative `CANDIDATE` row. Candidates authorize nothing; dispatch
   denies with `RTK_ROUTING_FAILURE` naming the candidate and its adapter.
3. **Explicit promotion.** `chrono rtk promote --proof <id>` (PO session,
   `adapter.approve` capability) promotes one candidate to `AUTHORITATIVE`
   after the signed adapter approval. Promotion re-validates attestation
   currency and binding, binary identity, adapter approval, and the
   managed-asset manifest, then snapshots the adapter registration hash
   and the asset manifest hash. It executes a prior approval, never
   substitutes for one. Re-promotion is idempotent.
4. **Per-dispatch re-validation.** Dispatch consumes only the latest
   unexpired `AUTHORITATIVE` proof for the (adapter, runtime, project)
   scope and re-validates every binding: current attestation, approved
   adapter, unchanged registration, live binary bytes, unchanged managed
   assets. Binary replacement, re-registration, asset drift, revocation,
   expiry, or superseded attestation invalidates without mutating the row.
5. **No self-asserted authority.** Adapter labels on sessions are
   self-asserted at open and bear no weight in recording or promotion.
   Pre-registration recording is allowed (evidence precedes approval);
   authorization is decided at promotion and per dispatch, never at
   record time.

## Consequences

- **Positive:** Setup keeps the safe order (prove → approve → promote)
  without weakening Slice 9 §9.3; every intermediate state fails closed.
- **Positive:** Drift (binary, registration, managed assets) invalidates
  old proofs automatically at dispatch; no revocation ceremony needed.
- **Positive:** `rtk gain` keeps a precise, honest role: binary/dashboard
  verification for attestation, never routing evidence.
- **Negative:** One more PO step (`rtk promote`) per adapter; `chrono init`
  performs it automatically once hooks are installed.
- **Risk:** The `rtk rewrite` output contract is RTK-owned; if upstream
  changes the mapping format, prove fails closed until the flow is
  adapted — verified by the real-runtime matrix, never by parsing guesses.

## Alternatives Considered

- **C3 option 2 (approval before authoritative proof):** Rejected — it
  forces the PO to approve routing that was never demonstrated, inverting
  evidence and approval.
- **Auto-promotion on approval:** Rejected — approval and promotion bind
  different facts (registration vs. live routing); merging them would let
  approval silently mint routing authority.
- **Hash-equality re-verification of command text at dispatch:** Rejected
  as redundant — the proof row is append-only and Core-mediated; the
  live bindings (binary, registration, assets, attestation) are what an
  attacker can change, and those re-validate per dispatch.

## Security Impact

The candidate/promote split confines a compromised or careless prover to
evidence rows: without a PO-held approval capability plus installed
managed assets, no proof can become authoritative, and authoritative
proofs decay on any drift. Denial messages name the adapter and the
missing step so operators recover without weakening the gate.
