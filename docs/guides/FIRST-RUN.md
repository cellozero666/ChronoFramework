# CHRONO First Run Guide

**Scope:** the proven happy path only — package installation,
`chrono init`, and normal runtime launch. Every command below is
covered by automated evidence; anything requiring paid models,
provider login, global mutation, or publication is marked open, never
implied.

## 1. Install

Published releases are installed free under Apache-2.0 once their
artifacts pass the repository's release gates:

```sh
npm install --global @chrono/cli
```

Equivalent bootstrap without a global install (no global state touched):

```sh
npx --prefix <fixture> chrono <command>
```

Package installation alone modifies nothing: no projects, no runtime
configuration, no user-global files. Those changes belong to the
explicit `chrono init` ceremony below.

> Status: npm publication and GitHub Releases are prepared but not
> published (publication requires explicit Product Owner
> authorization). Repository checkouts install via `npm ci` for
> development; release-shaped verification uses packed tarballs.

## 2. Configure a project with one command

```sh
cd <project>
chrono init
```

`init` runs four phases and prints each one:

1. **Detect (read-only, zero writes).** Project root, Git state,
   new-vs-existing classification, OS/arch/Node, installed runtimes,
   genuine RTK identity, pinned skill state, files to create or modify,
   backups, conflicts, and anything needing network or global
   permission.
2. **Plan.** One cohesive plan: selected runtimes and why, affected
   project-local and keychain paths, downloads if any, backup/rollback
   behavior, key enrollment and adapter-approval consequences, hooks
   and skills to install, conformance checks to run, cost notice (setup
   performs no model execution), and the exact boundary of later
   PO-only decisions.
3. **Consent.** Type the displayed challenge to accept the plan, or
   scope automation flags (`--yes`, `--yes-files`, `--yes-keychain`,
   `--yes-network`, `--yes-global`). Accepting project-local files
   never implies global, paid, publication, destructive, or production
   consent. Without consent the command stops with `CONSENT_REQUIRED`
   instead of hanging or guessing.
4. **Apply (resumable).** Twelve persisted steps from `DETECTED` to
   `READY`. Every step verifies before advancing; interruption resumes
   safely on re-run without duplicate identities, approvals, adapters,
   sessions, hooks, or audit events.

Variants that stay within the same guarantees:

```sh
chrono init --dry-run            # detect + plan, zero writes
chrono init --write-plan plan.json
chrono init --from-plan plan.json  # rejected on drift
chrono init --runtime opencode --runtime claude-code
chrono init --yes                  # automation with recorded scopes
```

## 3. Open a runtime normally

```sh
opencode            # or: claude | kiro
```

On session start the managed bootstrap resolves the project, redeems
Gaspar entry over a local channel, and injects the Core-computed entry
projection (state, pending decisions, next action). Gaspar introduces
itself and either begins product discovery or resumes the exact
persisted lifecycle state. No copied prompts, no manual agent
selection, no exported tokens, no repeated questions.

> Status: SessionStart assets ship for all three runtimes and pass
> hermetic enforcement tests. Final live acceptance (paid model
> execution, provider login) awaits explicit PO authorization and is
> reported as open, not passed. Kiro conformance additionally awaits a
> Kiro runtime on the verification host.

## 4. Re-run, repair, and diagnose

```sh
chrono init        # on a configured project: validate + resume, never DUPLICATE
chrono doctor      # read-only diagnostics, zero writes
chrono doctor --as gaspar --session-token <id/token>  # includes broker visibility
```

`doctor` reports project/Core compatibility, setup state, adapter
approval, RTK routing per adapter, skill activation, hook drift,
broker health, and Gaspar entry readiness with actionable reasons.

## 5. Removal

```sh
chrono uninstall --scope hooks        # generated assets, backup restoration
chrono uninstall --scope broker --as gaspar --session-token <t>
chrono uninstall --scope adapters --as PO --session-token <t>
chrono uninstall --scope project-data # interactive PO-only, typed challenge
```

Removal distinguishes assets, backups, revocations, and data.
Destructive removal of `.chrono` requires an interactive PO and a
typed challenge with a recoverability warning. Uninstalling the npm
package never deletes a project's `.chrono` data (there are no
install/uninstall lifecycle hooks — asserted by test).

## 6. Troubleshooting

| Symptom | Cause | Recovery |
|---|---|---|
| `RTK_NAME_COLLISION` | installed `rtk` is not Rust Token Killer | install from `https://github.com/rtk-ai/rtk`, verify `rtk gain` |
| `BLOCKED_RTK` | attestation missing/stale or routing unproven | `chrono rtk verify`, then `chrono rtk prove --adapter <id> -- <cmd>` |
| `BLOCKED_PROCESS_SKILL` | skill missing/divergent/inactive | `chrono skill verify` |
| `CONSENT_REQUIRED` | automation without a scope | add the named `--yes-*` flag or run interactively |
| `APPROVAL_REQUIRED` | PO-only step without terminal/key | run in a live terminal with the enrolled key |
| `chrono init already running` | concurrent init lock | wait, or remove `.chrono/init.lock` after verifying no init is active |
| `pins Core X, launcher is Y` | version mismatch | install the matching release; never force a different Core |
| `UPGRADE_REQUIRED` on reads | legacy database without a pin | run `chrono init` once to resume and pin |
| malformed `.claude/settings.json` | hand edit broke JSON | fix JSON or restore `.chrono-bak`, then re-run |
| hook drift in `doctor` | hand-edited managed asset | re-run setup/init to reconcile by ownership and hash |
| keychain failure | locked keychain / missing helper | unlock the login keychain (`security`) or install `libsecret-tools` |
| broker entry denied | revoked credential / stale routing | `chrono doctor` names the cause; re-prove routing or rotate the broker |

## 7. Security notes

- The PO signing key and the Gaspar-entry broker secret live in the OS
  keychain, never in the project, prompts, env, argv, logs, or evidence.
- Session bearer tokens travel process-locally (stdio pipes, 0600
  files); model-visible context receives only the safe entry projection.
- `approve`, `waive`, enrollment, rotation, and destruction stay
  interactive human-only operations with cryptographic binding to exact
  revisions; agents and adapters cannot impersonate them.
- No telemetry leaves the machine: metrics are local, and any
  transmission would require opt-in PO authorization.
- Model selection stays runtime/user configuration; CHRONO detects at
  most whether runtime-owned configuration exists, never names,
  chooses, or depends on a provider or model.
