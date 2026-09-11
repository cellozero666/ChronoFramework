# Slice 10 — One-Command Bootstrap and Automatic Gaspar Entry

**Status:** QUEUED — starts only after Slice 9 is independently marked `COMPLETE`  
**Scope:** Convert the secured Core, setup operations, and runtime adapters into the final first-run and resume experience.  
**Primary user journey:** install CHRONO → run `chrono init` once → open a selected AI CLI normally → Gaspar starts or resumes the governed workflow.  
**Non-authorization:** This slice does not authorize publication, remote changes, paid model use, destructive project changes, silent global configuration changes, or acceptance of residual security risk.

## 1. Product outcome

For the ordinary supported path, the Product Owner must need only:

```sh
npm install --global @chrono/cli
cd <project>
chrono init
opencode
```

Equivalent normal-launch behavior is required for Claude Code and Kiro. The PO
must not have to copy a prompt, select Gaspar manually, export a session token,
run internal setup commands, understand adapter registration, or reconstruct
state from a prior conversation.

`chrono init` is the public setup orchestrator. Existing granular commands
(`keys`, `session`, `adapter`, `rtk`, `skill`, `setup`, `gate`, and `run`) remain
available for automation, diagnosis, repair, and expert use, but a successful
default journey must compose them safely without asking the PO to execute them.

## 2. Installation and launcher contract

The release package must expose a global `chrono` executable through npm. The
same supported bootstrap must work through the documented `npx` form and from
GitHub Release installation where applicable.

The global launcher must:

- locate the project root without depending on the current subdirectory;
- detect an existing `.chrono` project and its pinned compatible local Core;
- delegate execution to the project-pinned Core when present;
- use the global implementation only for new-project bootstrap and explicit
  repair according to the Runtime Contract;
- fail closed on missing, incompatible, corrupt, or untrusted local versions;
- never silently upgrade, downgrade, replace, or bypass the pinned Core;
- work on supported macOS, Linux, and Windows environments;
- provide stable human output and one parseable JSON document in `--json` mode.

Package installation alone must not modify projects, runtime configuration, or
user-global files. Those changes belong to the explicit `chrono init` ceremony.

## 3. `chrono init` orchestration contract

### 3.1 Detection phase — read-only

Before requesting permission or writing state, `chrono init` must inspect and
present:

- project root, Git state, existing CHRONO state, and new versus existing
  repository classification;
- operating system, architecture, Node.js version, package installation mode,
  and key-storage capability;
- installed OpenCode, Claude Code, and Kiro runtimes and their relevant
  integration capabilities;
- the PO-selected runtime set and externally configured model availability,
  without selecting or persisting a model name as framework policy;
- genuine RTK identity, compatible version, current integration state, and
  routing-test readiness;
- the pinned Karpathy Guidelines source, cached/vendor state, runtime artifacts,
  license, hashes, and activation-test readiness;
- existing runtime configuration and files that would be created or modified;
- conflicts, backups required, unavailable capabilities, and actions that need
  external/network/global permission.

Detection must have no project, keychain, runtime, Git, network, or global
configuration side effects. Network access required for later verification
must be disclosed separately.

### 3.2 Plan and consent phase

The CLI must render one cohesive plan showing:

- selected runtimes and why each was detected or requested;
- project-local and user-global paths affected;
- downloads or installations, if any;
- backup and rollback behavior;
- key enrollment and authority consequences;
- native hooks, agent definitions, skills, and RTK integration to be installed;
- conformance checks and any real runtime invocation to be performed;
- whether an external provider may incur cost;
- permissions that will be granted to runtime adapters;
- the exact boundary between automatic setup and later PO-only decisions.

The PO must explicitly confirm applicable project, keychain, network, and
global-runtime changes. Consent must be scoped and recorded; accepting project-
local files must not imply permission for global configuration, paid execution,
publication, destructive commands, or production access.

If all prerequisites are already installed, `chrono init` must reuse and verify
them rather than reinstalling them. Unknown binaries or conflicting
configurations must stop with an explainable remediation path.

### 3.3 Apply phase — resumable and fail-safe

After consent, `chrono init` must execute an explicit, persisted setup state
machine equivalent to:

```text
DETECTED
→ CONSENTED
→ PROJECT_INITIALIZED
→ PO_ENROLLED
→ RUNTIMES_SELECTED
→ RTK_VERIFIED_AND_ROUTED
→ SKILL_VERIFIED_AND_EMITTED
→ ADAPTERS_REGISTERED_AND_APPROVED
→ NATIVE_HOOKS_INSTALLED
→ RUNTIME_CONFORMANCE_PASSED
→ GASPAR_ENTRY_PREPARED
→ READY
```

Every step must be idempotent, observable, independently verifiable, and either
atomic or compensatable. Persist only non-secret progress. A crash, cancellation,
terminal closure, or failed external command must leave a deterministic resume
point. Re-running `chrono init` must resume or repair safely rather than create
duplicate identities, approvals, adapters, sessions, hooks, or audit events.

The apply phase must:

1. initialize or validate the project identity and persistence;
2. perform the Slice 9 PO enrollment ceremony when no authority is enrolled;
3. record project language, rigor/autonomy choices, and selected runtime IDs;
4. verify or, only with permission, install/configure genuine RTK from the
   canonical upstream and prove effective routing per runtime;
5. fetch or reuse the pinned process skill, verify provenance/license/hash,
   emit byte-deterministic runtime artifacts, and prove activation;
6. generate/register, obtain signed approval for, and activate the selected
   runtime adapters without forging PO authority;
7. install native fail-closed hooks and role definitions without overwriting
   unrelated user configuration;
8. run the identical black-box conformance suite for each selected runtime;
9. create the secure runtime-side mechanism needed to obtain a bounded Gaspar
   session without exposing bearer tokens to the model;
10. persist a readiness projection and next action.

PO signatures and confirmations may be orchestrated by `chrono init`, but they
must remain real interactive PO actions. Convenience must never synthesize,
preapprove, or bypass authority.

## 4. Configuration ownership and merge behavior

Generated assets must be deterministic and clearly marked as CHRONO-managed.
The installer must preserve unrelated runtime configuration and use structural
merge logic where a runtime supports it. Before changing an existing file it
must:

- validate type/schema and reject ambiguous or malformed content;
- calculate and display the proposed semantic change;
- create a permission-preserving backup when rollback cannot otherwise be
  guaranteed;
- write atomically and verify the final bytes/semantics;
- record path, prior hash, resulting hash, generator version, runtime, and
  consent reference without storing secret content.

Hand-edited CHRONO-managed assets are drift, not input to overwrite silently.
Unrelated user-owned configuration must never be deleted. Re-initialization and
upgrades must reconcile by ownership and hash, not replace entire directories.

## 5. Secure automatic Gaspar activation

### 5.1 Runtime entry handshake

Opening a configured runtime normally inside a CHRONO project must trigger a
native, deterministic bootstrap before the first agent response:

```text
runtime opens project
→ adapter locates project-pinned Core
→ Core validates setup readiness and adapter/RTK/skill currency
→ adapter authenticates through a local non-model-visible channel
→ Core issues or renews a bounded Gaspar session
→ Core returns the permitted Gaspar context projection and next workflow action
→ runtime activates the canonical Gaspar definition and mandatory skill
→ Gaspar introduces itself and interviews the PO, or resumes the persisted state
```

The adapter must prove that the runtime actually selected Gaspar and activated
the pinned skill. A prompt file, agent label, environment variable, or claimed
self-identification is not sufficient evidence.

### 5.2 Session broker boundary

Automatic activation must not place signing keys or session bearer tokens in
prompts, agent-readable environment variables, generated instructions, command
arguments visible to the model, logs, or repository files. Use the strongest
portable local IPC/credential mechanism available under the approved
architecture, with:

- OS-user-restricted access;
- runtime/adapter/project/process binding;
- narrow Gaspar role and operation scope;
- short TTL and safe renewal;
- revocation and runtime-close handling;
- replay prevention and audit metadata;
- fail-closed behavior when the broker or project-pinned Core is unavailable.

A worker cannot request Gaspar authority. A runtime adapter may obtain Gaspar
authority only through the enrolled and approved bootstrap path defined by the
Core. The model itself never receives or controls the credential.

### 5.3 State-aware entry behavior

Gaspar must derive its opening behavior from persisted Core state, not chat
history:

| Project condition | Required opening behavior |
|---|---|
| New or `UNINITIALIZED` | Explain CHRONO/PO authority briefly and begin adaptive product discovery. |
| `ANALYZING` | Resume unanswered discovery topics without repeating accepted answers. |
| `ARCHITECTING` | Summarize current constraints/decisions and continue architecture work or request the exact PO decision. |
| `SPECIFYING` | Resume the affected Specs/Harnesses and expose missing acceptance or security information. |
| `PLANNING` | Present dependency-ready work, blockers, and approvals needed; do not execute prematurely. |
| `EXECUTING` | Resume coordination from persisted grants/work packages; never assume a prior conversational handoff. |
| `VERIFYING` | Route current evidence to Lucca, Glenn, and Spekkio under their authority rules. |
| `BLOCKED` | Explain the blocking predicate, responsible authority, evidence, and safe next action. |
| `COMPLETE` | Present the verified state and wait for an explicit change request; do not restart discovery. |

Gaspar's first message must use the configured project language, identify its
role, state that the human is the Product Owner, and explain only the decisions
currently required. It must not dump internal prompts, tokens, or an inflexible
questionnaire. Discovery is adaptive but its persisted outputs remain governed
by the System Analysis and Authority protocols.

## 6. Multiple runtimes and model neutrality

- `chrono init` must support one or more selected runtimes without making an
  unavailable unselected runtime block that project's setup.
- A v1 release may claim support for a runtime only after that runtime passes
  the mandatory conformance matrix; release qualification still requires all
  mandatory v1 runtimes.
- Opening different configured runtimes must project the same authoritative
  state and must not create competing Gaspar identities or duplicate decisions.
- Concurrent runtime sessions require explicit locking/conflict behavior and
  deterministic reconciliation through the Core.
- Model selection remains runtime/user configuration. CHRONO may detect whether
  a selection exists but must not choose, recommend silently, embed, or depend
  on a particular provider/model/version.
- Changing a model must not alter role, authority, readiness, state, evidence,
  or resume behavior.

## 7. Re-run, repair, doctor, and removal behavior

`chrono init` on an existing CHRONO project must default to validation and
resume. It must not report `DUPLICATE_IDENTITY` as the normal user experience.
It must explain drift and offer only scoped repairs requiring appropriate
consent.

Provide a read-only diagnostic operation (`chrono doctor`, or a documented
equivalent) that reports project/Core compatibility, setup state, runtime
hooks, adapter approval, RTK routing, skill activation, broker health, and
Gaspar entry readiness without mutating state.

Repair must reuse the same ownership, signature, and conformance rules as first
setup. Removal/uninstall behavior must distinguish:

- removal of project-local generated integration assets;
- restoration of backed-up runtime configuration;
- revocation of sessions/adapters;
- retention or explicit deletion of project artifacts/audit history;
- package uninstallation.

Destructive removal of authoritative CHRONO state requires explicit PO action
and a recoverability warning. Package uninstall must never silently delete a
project's `.chrono` data.

## 8. Non-interactive and automation behavior

Interactive `chrono init` is the primary UX. Automation may use `--json`, a
reviewed plan file, or granular commands, but it must not bypass human-only
authority or consent.

- Read-only detection and planning may run non-interactively.
- Any missing human decision must return a stable structured result describing
  the exact action required; it must not hang or guess.
- Secret values must be accepted only through protected channels, never plain
  command-line flags or plan files.
- A plan generated for one project/revision/environment must be rejected when
  replayed against materially different inputs.
- CI mode may validate and test existing setup but cannot create PO authority
  or accept risk.

## 9. Required tests and evidence

### 9.1 Hermetic tests

- detection performs zero writes and produces a deterministic plan;
- consent scopes cannot be confused or broadened;
- each setup step is idempotent and resumes after injected failure;
- partial writes roll back or retain a documented safe recovery point;
- existing runtime configuration is merged without losing unrelated content;
- malformed configuration, symlink/path traversal, ownership drift, and
  concurrent initialization fail safely;
- initialization never leaks keys, tokens, credentials, or unredacted output;
- re-running init on `READY` is a successful health/resume path;
- new versus existing repositories produce appropriate discovery behavior;
- every persisted project state maps to the required Gaspar opening behavior;
- model replacement preserves the same Core projection and authority.

### 9.2 Packed-install tests

From release-shaped tarballs with no workspace links or source imports:

- global `chrono` and documented `npx` bootstrap locate the correct Core;
- `chrono init` completes a new-project setup using already installed
  prerequisites;
- interruption at every setup state resumes correctly;
- nested-directory invocation finds the same project;
- upgrade and incompatible-local-Core paths fail or recover as specified;
- package removal leaves authoritative project data intact.

### 9.3 Real-runtime acceptance tests

For OpenCode, Claude Code, and Kiro separately:

1. initialize a clean project using only `chrono init` after package install;
2. close the terminal/process to prove no conversational state dependency;
3. launch the runtime by its normal command with no manual agent selection,
   copied prompt, token export, or extra CHRONO command;
4. observe a native bootstrap before the first model response;
5. prove the active identity is Gaspar, the pinned skill is active, RTK routing
   is effective, and pre-tool enforcement denies an unauthorized mutation;
6. answer part of the PO interview, restart the runtime, and prove Gaspar resumes
   without repeating accepted answers;
7. change the externally selected model and prove state/authority equivalence;
8. corrupt or remove each critical integration component in turn and prove the
   runtime fails closed with actionable recovery;
9. scan project files, environment capture, logs, prompts, and evidence for
   credential leakage.

Paid model execution, provider login, or global configuration mutation still
requires explicit applicable PO authorization. If unavailable, complete all
other work and report the exact final acceptance cases awaiting authorization;
do not replace them with mocks or claim they passed.

## 10. Documentation and UX deliverables

- concise installation instructions for npm, `npx`, and GitHub Releases;
- a first-run guide whose happy path contains only package installation,
  `chrono init`, and normal runtime launch;
- exact consent, readiness, blocked, resume, repair, and already-initialized
  messages in human and JSON forms;
- troubleshooting for RTK collision, missing runtime, invalid keychain,
  incompatible Core, hook drift, skill drift, interrupted setup, and broker
  failure;
- security documentation explaining local credentials, files changed, backup,
  revocation, uninstall, telemetry, and model neutrality;
- screenshots or transcripts only when generated from verified behavior, never
  as substitutes for automated evidence.

## 11. Exit criteria

Slice 10 is complete only when all of the following are true:

1. A release-shaped installation exposes `chrono` globally and delegates to a
   compatible project-pinned Core.
2. A PO can configure an eligible project using `chrono init` as the only
   CHRONO command in the normal happy path.
3. Setup is consented, idempotent, resumable, rollback-safe, secret-safe, and
   truthful about every project/global/external effect.
4. Opening OpenCode, Claude Code, or Kiro normally in a configured project
   automatically activates or resumes Gaspar before the first agent response.
5. Automatic Gaspar sessions use a non-model-visible authenticated channel and
   cannot be minted, stolen, replayed, broadened, or used by workers.
6. Gaspar starts the PO interview only for a new analysis and otherwise resumes
   the exact persisted lifecycle state without relying on conversation memory.
7. All runtime hooks, RTK routing, skill activation, gates, role authority, and
   failure paths remain as strict as Slice 9; convenience introduces no bypass.
8. Re-run, repair, upgrade, concurrent-open, model-change, and removal behavior
   pass the required tests.
9. The packed-install and real-runtime acceptance matrices pass for all three
   mandatory runtimes, except only those final external executions explicitly
   awaiting PO authorization and reported as such.
10. Documentation describes the proven happy path accurately, with no manual
    hidden prerequisite or unsupported release claim.

After independent review marks Slice 10 `COMPLETE`, continue with Phase 6 and
the remaining release-candidate tasks in `IMPLEMENTER-TASKS.md`. Do not publish,
tag, push, or declare final v1 solely because the one-command journey passes.
