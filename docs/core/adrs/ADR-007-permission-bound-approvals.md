# ADR-007: Permission-Bound PO Approvals for In-Runtime Ceremonies

**Status:** Proposed (requires PO ratification at pilot acceptance)
**Date:** 2026-09-14
**Authority:** PO decision required (security ceremony equivalence)
**Decides:** OC-P11 integrated approval ceremony mechanics
**Amends:** ADR-003 §6 ("No automation bypass") for one explicit path

## Context

ADR-003 requires PO approvals to be human-interactive (TTY) and signed.
Inside an OpenCode TUI session there is no line terminal for the agent
runtime, so the classic ceremony cannot run there — this produced the
OC-P11 bootstrap deadlock (Gaspar could neither write drafts nor
collect approvals without leaving the runtime).

OpenCode 1.18.30 provides native, runtime-enforced human boundaries
verified against `@opencode-ai/plugin@1.18.30` / `@opencode-ai/sdk@1.18.30`
and the published docs:

- plugin-defined human confirmation flows via `context.ask()` and the
  `permission` config (`ask` shows once/always/reject in the TUI);
- `permission.asked` / `permission.replied` events and
  `tool.execute.after` observations that reach the plugin host through
  runtime-delivered events the model cannot fabricate;
- the built-in `question` tool, whose human answers return as tool
  results (model-visible, but model-unforgeable as runtime events).

## Decision

1. **Single-use tickets** (`approval_ticket`, migration v15): Gaspar/PO
   sessions request a ticket binding action, scope, exact current
   revision, rationale, and security implications (TTL 900 s). Tickets
   authorize nothing alone.
2. **Native display**: Gaspar asks the human through the native
   `question` tool carrying the exact canonical line
   `CHRONO approval <challenge> :: <action> <scope> @<revision> ::
   <rationale>`. Chat text alone never authorizes.
3. **Native confirmation tool** (`chrono_approval_confirm` in
   `.opencode/tools/chrono.ts`, registered in the generated plugin's
   `Hooks.tool` collection): Gaspar invokes it with the ticket id; it
   re-validates liveness, requires the native `ask()` human boundary
   (exact ticket scope in patterns/metadata, empty `always` so nothing
   broadens silently), refuses `--auto` mode, reads the OS-keychain PO
   key host-side, signs the canonical payload (byte-identical
   serializer, contract-tested), and records through
   `finalizeApprovalTicket`. Denial/cancellation changes nothing.
4. **Core verification** (`finalizeApprovalTicket`): Ed25519 under the
   registered PO key (same crypto!), single-use atomic ticket
   consumption, scope-revision currency (drift burns the ticket),
   expiry, and a recorded native observation
   (permission/question call id, decision time). No TTY is required on
   this path: human presence is proven by the ticket plus the recorded
   native observation instead of a terminal check.
5. **Classic path unchanged**: `recordApproval` keeps the TTY rule;
   `planning-approval` joins the canonical action set; signatures with
   `security_implications` verify alongside legacy ones (absent field
   serializes as absent).

## Why this preserves ADR-003 intent

- The model cannot confirm (only runtime-delivered answers act),
  forge (no key; signatures verified), replay (tickets burn), or
  auto-accept (host refuses `--auto`; observation recorded).
- Denial/cancellation changes no state; the conversation continues
  from Core status.
- No private key or session credential reaches model context (host
  memory and 0600 files only; signed bytes cross to the Core).
- Every finalize is audited with ticket, scope, revision, observation,
  and policy version.

## Addendum D1/D4 (key custody parity and retry semantics)

- Keychain reads normalize through one shared algorithm
  (lower/UPPERCASE hex, trim, CRLF) with Ed25519 validation and
  fingerprint binding, in CLI flows and in generated native tools
  (parity-locked copies). Failures are secret-safe denials; the
  ticket survives host-boundary failures and the same ticket is
  retryable, while consumed/stale/expired tickets require a fresh
  request. Every confirm denial names its layer and retryability.
- No test seam ships in production tool bytes; hermetic tests inject
  a fixture `security` on PATH.

## Residual risks (live-acceptance, pilot retry)

- **Prompt rendering fidelity**: the exact TUI rendering of the
  question/ask UI is unverified without a paid-model session; the
  retry must observe it.
- **Mid-session auto-approve toggling** (palette): launch-time `--auto`
  is refused deterministically, but a palette toggle afterwards has no
  verified in-process signal. Until the retry evidences otherwise,
  approval sessions must not enable auto-approve (documented in
  FIRST-RUN; setup/doctor surface the rule).
- **Platform keychain prompts**: first OS-keychain reads may raise an
  OS dialog (defense in depth, not a dependency).

## Alternatives Considered

- **Shell-out `chrono approve` from the plugin**: rejected — the child
  has piped stdio (no TTY) and inheriting the TUI terminal corrupts it.
- **Model-invoked finalize CLI**: rejected — the model could invoke it
  without any human answer; only host-observed answers may trigger
  signing (the CLI `approval-record` takes a pre-made signature and
  verifies it, so model invocation without a key denies).
- **TTY relaxation for agents**: rejected — would erase the human-only
  bar entirely.

## Security Impact

Extends the trust base from "live terminal" to "live terminal running
a pinned CHRONO plugin observing a native human confirmation". The
plugin is a managed, hash-pinned, drift-checked asset; the model
remains fully untrusted on this path. PO ratification is required
before this path may record production approvals.
