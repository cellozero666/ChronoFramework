# ADR-008: User-Approved Gaspar Document Writes

**Status:** Accepted
**Date:** 2026-09-17
**Authority:** Product Owner (co-architect delegation to Gaspar)
**Decides:** How Gaspar writes user-requested Markdown documents
**Amends:** Nothing (extends ADR-007 with a new approval action)

## Context

Gaspar acts as co-architect: the Product Owner asks for documents —
fix plans, bug lists (`FIXES.md`), memos — and Gaspar drafts them.
The pre-tool gate denies generic `write`/`edit`/`bash` to Gaspar by
design (no dispatch context, never), and the planning path
(`artifact propose`) addresses only Core-derived canonical locations
under `.chrono/`, never a user-named path. There was therefore no
legal way for Gaspar to produce `docs/FIXES.md`, and no approval
ceremony that could authorize it: chat text ("yes, write it") is
model-forgeable and binds nothing.

## Decision

1. **Petition, not permission.** Gaspar requests a single-use
   `document-write` ticket binding the canonical document path plus
   the exact proposed content hash. The body is stored Core-side at
   request time, so approval cannot drift onto different bytes.
2. **Same ceremony, new action.** The human confirms through the
   native `question` tool carrying the exact ticket challenge
   (ADR-007, unchanged); the host signs with the OS-keychain PO key;
   the Core verifies signature, single-use, ceremony key, and base
   currency, then performs the write itself — backup plus atomic
   replace. Agents never write files on this path, not even Gaspar.
3. **Content-hash binding, base-currency check.** The ticket binds
   proposed bytes; finalize additionally requires the live document
   to still match the base captured at request (absent stays
   absent). Any movement burns the ticket. Re-requesting identical
   bytes for an unchanged document is a deterministic no-op, never
   a second ticket.
4. **Markdown only, project-contained, governed roots excluded.**
   Paths must end `.md`, resolve inside the project (symlink escape
   denies), and avoid `.chrono/` (Core-governed drafts keep their
   revision/approval binding through propose/revise), `.git/`, and
   `node_modules/`. Bodies are secret-scanned and size-bounded
   (1 byte–64 KiB, planning bounds).
5. **Backup and replace.** A replaced document keeps one
   permission-preserving `.chrono-bak` beside it; creates write
   directly. Every write appends a `DocumentWritten` audit event
   (path, content/base hashes, backup path). Transaction failure
   after the write compensates (restore-or-remove, guarded against
   third-party interleaving); concurrent duplicate delivery is a
   no-op returning the winner.
6. **One human Approve authorizes at most one write** of exactly the
   approved bytes (ADR-007 exactly-once invariant, unchanged).

## Consequences

- Gaspar can fulfill "write FIXES.md with bugs A, B, C" end to end:
  petition → human Approve → Core write → approval landing →
  workers dispatched against the approved plan.
- The pre-tool gate is untouched: generic mutation still requires
  dispatch context, and workers stay denied the petition tool.
- `.chrono/` drafts remain exclusively planning-governed; a memo
  petition there denies with remediation instead of forking
  revision/approval lifecycles.

## Alternatives Considered

- **Grant Gaspar `write` with a dispatch:** dispatches authorize
  implementation work on approved modules; a memo is not module
  work, and the grant would open product-code mutation. Rejected
  as overbroad.
- **Static path allowlist without per-act confirmation:** lets a
  rogue Gaspar overwrite at will with no human in the loop.
  Rejected.
- **Chat-text approval:** forgeable, unsigned, unbound. Rejected
  (ADR-007 lineage).

## Security Impact

New authority surface is minimal and human-gated per act: path
allowlist enforced at request AND redeem, content bound by hash at
both ends, secrets refused unpersisted, single-use tickets with TTL,
Ed25519 PO signatures, atomic exactly-once finalize, audited
backup/replace. No key or credential reaches the model on this
path, same as all ADR-007 ceremonies.
