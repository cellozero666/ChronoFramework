/**
 * Native OpenCode agent activation (OC-P10).
 *
 * The provider-backed pilot proved that projection injection alone is
 * NOT Gaspar activation: OpenCode answered on its built-in `build`
 * primary while telemetry claimed success. Native selection requires
 * the official OpenCode 1.18.30 contracts (verified against the docs,
 * `@opencode-ai/sdk` v2 types, and the installed binary oracles
 * `opencode debug config` / `opencode debug agent <name>`):
 *
 * - a project-local primary agent definition at
 *   `.opencode/agents/gaspar.md` (markdown frontmatter: `description`
 *   is required, `mode: primary`, filename becomes the agent name; no
 *   `model` field so the agent uses the Product Owner's externally
 *   configured OpenCode model);
 * - the project configuration `default_agent` set to `gaspar`
 *   (`opencode.json` or `opencode.jsonc`; configs merge, project wins;
 *   unknown or subagent defaults fall back to `build` with a warning).
 *
 * This module owns deterministic generation plus a comment-preserving
 * structural merge for the user-owned configuration file:
 * - never writes a provider or model (reads detect them, never persist
 *   them as framework policy);
 * - preserves unrelated keys, comments, and formatting; only the
 *   top-level `default_agent` key is touched;
 * - permission-preserving backup (`<file>.chrono-bak`, written once)
 *   before the first change;
 * - managed sidecar (`.chrono/opencode-config.json`) recording
 *   ownership and the pre-merge value so drift is detected, repair is
 *   safe, and uninstall restores the prior default exactly.
 *
 * Malformed, ambiguous (both `opencode.json` and `opencode.jsonc`,
 * duplicate keys), or non-string `default_agent` values fail closed
 * with remediation instead of guessing.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SKILL_RELEASE } from "@chrono/domain";
import type { ChronoNativeTool } from "./opencode-planning-tools.js";

/** Project-local OpenCode agent directory (official contract). */
export const OPENCODE_AGENTS_DIR_RELATIVE = ".opencode/agents";

/** Canonical CHRONO role names (exact, normative). */
export const CHRONO_OPENCODE_ROLES = [
  "gaspar",
  "belthazar",
  "melchior",
  "prometheus",
  "lucca",
  "glenn",
  "spekkio",
] as const;

export type ChronoOpenCodeRole = (typeof CHRONO_OPENCODE_ROLES)[number];

/** Project-relative path of one role definition. */
export function openCodeAgentPath(role: string): string {
  return `${OPENCODE_AGENTS_DIR_RELATIVE}/${role}.md`;
}

/** Project-relative path of the Gaspar primary definition. */
export const GASPAR_AGENT_RELATIVE_PATH = openCodeAgentPath("gaspar");

/**
 * Exhaustive Gaspar route for one `chrono_next` action value (CF2-3).
 * `tool` is the native tool Gaspar itself calls (with `args`);
 * `tool: null` means Gaspar calls NO tool for this action — it is an
 * explicit human/await hold (`hold` names the ceremony or waiter) or
 * a step owned by another session (`hold` names that session's tool).
 * Unknown action values never appear here: `resolveGasparNextAction`
 * throws instead of degrading to prose or guessed commands.
 */
export interface GasparNextActionRoute {
  readonly tool: ChronoNativeTool | null;
  readonly args: readonly string[];
  readonly hold: string | null;
  readonly note: string;
}

/**
 * Action-to-native-tool mapping for EVERY value `nextAction` can
 * return (exactly the Core `NEXT_ACTIONS` universe — a test fails the
 * build on any missing or extra key). The mandatory backbone:
 * `activate-module -> chrono_module_activate`,
 * `authorize-wp -> chrono_wp_authorize`,
 * `request-dispatch -> chrono_dispatch` plus exactly one `task`
 * delegation to a kind-fitting role.
 */
export const GASPAR_NEXT_ACTION_MAP: Record<string, GasparNextActionRoute> = {
  "activate-module": {
    tool: "chrono_module_activate", args: ["module"],
    hold: null,
    note: "DRAFT/AWAITING_APPROVAL with both current approvals: activate to APPROVED (idempotent replay).",
  },
  "await-approval": {
    tool: null,
    args: [],
    hold: "PO/human ceremony holds the workflow: request the named approval with chrono_approval_request plus the native question tool, then stop — the PO decides in the UI; terminal steps are never delegated outward (no shell commands, token copies, variable exports, or manual dispatch context).",
    note: "Activation authority missing (absent, revoked, stale, or wrong-revision planning/module approval).",
  },
  "approve-security": {
    tool: "chrono_approval_request",
    args: ["action=implementation-security", "scope=module", "revision=current module revision from chrono_execution_status"],
    hold: "The PO answers VIA THE NATIVE question TOOL (explicit Approve names the challenge); on approval re-query chrono_next — it now advertises complete-module.",
    note: "Every package COMPLETE (or package-less work positioned) but the Module Implementation Security Acceptance missing: this ceremony — never more work — unblocks completion.",
  },
  "authorize-wp": {
    tool: "chrono_wp_authorize", args: ["wp"],
    hold: null,
    note: "PLANNED package with a valid owning module: authorize it for execution.",
  },
  "request-dispatch": {
    tool: "chrono_dispatch",
    args: ["module", "wp?", "kind (from the action)", "rationale"],
    hold: null,
    note: "Then delegate with the task tool to EXACTLY ONE kind-fitting role carrying the dispatch id (implementation/test: belthazar, melchior, prometheus, lucca; security-review: glenn; verification: spekkio; correction: the loop owner the Core binds). Never delegate twice for one intent.",
  },
  "claim-dispatch": {
    tool: null,
    args: [],
    hold: "Worker handoff: the delegated worker's FIRST action is chrono_dispatch_claim with the dispatch id. Gaspar awaits the claim or delegates afresh once the intent settles — never claims worker dispatches itself.",
    note: "PENDING intent owned by this session.",
  },
  "confirm-dispatch": {
    tool: null,
    args: [],
    hold: "Confine the worker credential host-side, then the requester or worker confirms via chrono_dispatch_confirm. Never copy tokens into model-visible text.",
    note: "ENACTED intent awaiting confinement confirmation.",
  },
  "await-claim": {
    tool: null,
    args: [],
    hold: "Another session owns this dispatch: await its claim, or delegate afresh once it settles. Never hijack, never guess dispatch ids.",
    note: "PENDING/ENACTED intent not claimable by this session.",
  },
  "execute-dispatch": {
    tool: null,
    args: [],
    hold: "The bound worker executes inside its binding while Gaspar coordinates and routes evidence (chrono_execution_status to observe). Gaspar never implements, edits, or writes product code itself.",
    note: "ACTIVE binding observed by a non-holder.",
  },
  "record-evidence": {
    tool: null,
    args: [],
    hold: "The binding holder records passing proof with chrono_evidence_record bound to the exact scope revision, then advances with chrono_scope_advance. Gaspar never records worker evidence.",
    note: "Own ACTIVE binding ready to evidence.",
  },
  "assign-review": {
    tool: "chrono_review_request", args: ["kind (from the action)", "module", "wp?"],
    hold: null,
    note: "Reviewable scope with no open assignment of the needed kind: security-review binds Glenn, verification binds Spekkio.",
  },
  "submit-review": {
    tool: null,
    args: [],
    hold: "The assigned reviewer submits with chrono_review_complete after binding proof (Glenn evidence or Spekkio verdict) to the exact revision. Gaspar never reviews, never impersonates reviewers.",
    note: "ASSIGNED review whose proof is ready in the reviewer session.",
  },
  "await-action": {
    tool: null,
    args: [],
    hold: "The named reviewer still owes proof: wait for their submission. Never submit for them, never reassign around them.",
    note: "ASSIGNED review with proof still missing.",
  },
  "request-correction": {
    tool: "chrono_dispatch",
    args: ["module", "wp?", "kind=correction", "rationale"],
    hold: null,
    note: "Open correction loop with no correction dispatch: dispatch kind correction (the Core binds the defect owner — never Gaspar's choice), then exactly one task delegation to that owner. With several loops open, pass the defect id the denial names.",
  },
  "correct-defect": {
    tool: null,
    args: [],
    hold: "The loop owner evidences the fix with chrono_evidence_record and closes the loop with chrono_correction_complete; re-verification follows. Gaspar never corrects directly.",
    note: "Open loop with a live correction dispatch.",
  },
  "request-completion": {
    tool: null,
    args: [],
    hold: "Package readiness pointer: if the Spekkio verdict is missing, route a verification dispatch (chrono_dispatch kind verification + one delegation to spekkio); the bound Spekkio session advances. Gaspar never advances scopes itself.",
    note: "Work Package with all completion blockers cleared.",
  },
  "complete-module": {
    tool: "chrono_module_complete", args: ["module"],
    hold: null,
    note: "Module-level gates clear (packages aggregate or package-less verdict chain plus the security acceptance): complete (idempotent). Execute IMMEDIATELY after observing — no approval, transition, or mutation between observation and execution.",
  },
  "advance-module": {
    tool: null,
    args: [],
    hold: "Module-level pointer, not a tool call: query chrono_next on the named Work Package and follow its action. Never treat this as completion.",
    note: "Incomplete packages remain, or aggregate gates deny with a named prerequisite.",
  },
  "authorize-work": {
    tool: null,
    args: [],
    hold: "No Work Packages exist yet: plan the first package through the governed planning tools (chrono_artifact_propose kind workpackage), never by hand-writing state.",
    note: "Package-less module with no executable scope.",
  },
  "blocked": {
    tool: null,
    args: [],
    hold: "Resolve the named blocker through its owning workflow (evidence, correction, waiver, or PO decision), then re-query chrono_next. Never bypass, never delete blockers.",
    note: "Active blocker gates the scope.",
  },
  "done": {
    tool: null,
    args: [],
    hold: "Terminal state: no further action. Report completion from Core state.",
    note: "Module COMPLETE.",
  },
  "submit-architecture": {
    tool: "chrono_architecture_submit", args: [],
    hold: null,
    note: "Proposed architecture not yet under review: submit it (planning runway, Core-ordered).",
  },
  "approve-architecture": {
    tool: "chrono_architecture_approve", args: [],
    hold: null,
    note: "Architecture under review with a current architecture-security approval: enact approval (no ceremony needed when the approval already stands).",
  },
  "request-approval": {
    tool: "chrono_approval_request",
    args: ["action (from the action kind)", "scope (from the target)", "revision (current)"],
    hold: "The PO answers VIA THE NATIVE question tool (one ticket per question; the Approve label names the challenge); then re-query chrono_next and verify the landing — never assume.",
    note: "A PO ceremony is the missing prerequisite (architecture-security or planning-approval for the exact revision).",
  },
  "submit-spec": {
    tool: "chrono_spec_submit", args: ["spec (from the target)"],
    hold: null,
    note: "DRAFT spec with a current planning-approval: submit it for review (planning runway, Core-ordered).",
  },
  "record-harness": {
    tool: "chrono_harness_record",
    args: ["revision (current)", "contentHash", "content"],
    hold: null,
    note: "REVIEW spec with no current Harness: record it (harnesses take no approval ceremony).",
  },
  "ready-spec": {
    tool: "chrono_spec_ready", args: ["spec (from the target)"],
    hold: null,
    note: "REVIEW spec passing readiness gates: release it to READY (planning runway, Core-ordered).",
  },
};

/**
 * Resolve one `chrono_next` action to Gaspar's route. Unknown values
 * fail LOUDLY (throw) instead of prose or guessed commands — a new
 * Core action without a map entry breaks here by design, forcing the
 * map (and this contract) to grow explicitly.
 */
export function resolveGasparNextAction(action: string): GasparNextActionRoute {
  const route = GASPAR_NEXT_ACTION_MAP[action];
  if (route === undefined) {
    throw new Error(
      `unknown next action '${action}': no Gaspar route exists — fail closed, do not guess a command; extend GASPAR_NEXT_ACTION_MAP first`
    );
  }
  return route;
}

/**
 * Ceremony verification + planning-runway prose, embedded verbatim
 * in the Gaspar contract (pilot repair): approvals are verified
 * landed, never assumed — and the pre-activation runway advances
 * through native tools in dependency order, never file edits.
 */
function gasparCeremonyVerification(): string {
  return [
    "## Approval verification (mandatory — never assume an approval landed)",
    "",
    "- After EVERY human Approve answer, verify the landing before doing anything else: `chrono_approval_status` for the ticket (must read live=false, consumed, with an approval id) and `chrono doctor` (its ceremony section reports WHERE each confirmation stands — finalized, refused with reason, or absent).",
    "- One ticket per question call, always: a question naming two or more tickets authorizes nothing (the Core refuses the whole ceremony without consuming). Put the ticket challenge (`approve-TICKET-xxxx`) in the Approve option label itself — answers echo option labels only, so a bare `Approve` label without the challenge never finalizes.",
    "- If the approval did not land, diagnose by the ceremony kind and repeat correctly instead of proceeding: `approval-multi-ticket` → split into one-ticket questions; `approval-answer-no-match` → the answer did not echo the challenge, re-ask with the challenge in the label; `approval-no-session` → reopen OpenCode so entry redeems; `approval-no-key` → the PO signing key is unavailable, stop for the PO; `approval-ticket-not-live` → ticket consumed, expired, or stale, re-request for the current revision; `approval-record-denied` → quote the Core code and fix the named cause.",
    "- A `chrono_next` hold (`await-approval`, `approve-security`) clears only when the Core reports the approval current — never when the UI merely showed an answer.",
    "",
    "## Planning runway (Core-ordered — no separate map here)",
    "",
    "- Pre-activation planning has no workflow of its own in this contract: query `chrono_next` on the module and follow exactly what it returns. The Core orders architecture submission/approval, spec submission, harness recording, and READY transitions deterministically (see the Next-action map rows above); this prose never overrides, reorders, or duplicates that order.",
    "- File edits never move lifecycle state (a file revision without a Core transition is prose, not progress). A spec whose content changed needs its approvals re-issued for the new revision: freeze content before approving, or the stale cycle repeats.",
    "- Only with every module spec READY does `chrono_module_activate` succeed; only then do `chrono_wp_authorize` and dispatch follow — because the Core says so through `chrono_next`, not because this file lists the order.",
  ].join("\n");
}

/** Prose rendering of the map, embedded verbatim in the Gaspar contract. */
function gasparNextActionTable(): string {
  const lines: string[] = [
    "## Next-action map (exhaustive — every `chrono_next` action routes here; anything else is a Core defect: stop and report it, never guess)",
    "",
  ];
  for (const [action, route] of Object.entries(GASPAR_NEXT_ACTION_MAP)) {
    const target = route.tool === null ? `HOLD: ${route.hold}` : `\`${route.tool}(${route.args.join(", ")})\`${route.hold === null ? "" : ` — then ${route.hold}`}`;
    lines.push(`- \`${action}\` → ${target} — ${route.note}`);
  }
  lines.push(
    "",
    "Rules: continue autonomously through every executable action above. Stop for the Product Owner ONLY on the HOLD rows naming a genuine PO decision or signed approval (await-approval, approve-security, authorize-work, blocked). NEVER ask the Product Owner to run CHRONO internal commands, copy tokens or grants, export variables, or manually create dispatch context. NEVER implement, evidence, review, verify, correct, advance, or complete anything yourself: those verbs belong to bound worker, reviewer, or owner sessions through their own tools.",
  );
  return lines.join("\n");
}

/** Managed sidecar recording config ownership (CHRONO-owned, JSON). */
export const OPENCODE_CONFIG_SIDECAR_RELATIVE = ".chrono/opencode-config.json";

/** Supported project configuration filenames, in selection order. */
export const OPENCODE_CONFIG_FILES = ["opencode.jsonc", "opencode.json"] as const;

const ROLE_DESCRIPTIONS: Record<ChronoOpenCodeRole, string> = {
  gaspar: "CHRONO systems analyst, software architect, and orchestrator. Starts or resumes the governed product workflow from persisted Core state.",
  belthazar: "CHRONO implementation engineer. Implements approved Specs and Harnesses without redefining requirements or architecture.",
  melchior: "CHRONO UI/UX engineer. Implements approved experience, flows, components, responsiveness, and accessibility.",
  prometheus: "CHRONO infrastructure and operations engineer. Owns environments, deployment, CI/CD, observability, backup, and rollback.",
  lucca: "CHRONO test engineer. Derives tests from acceptance criteria and produces automated evidence.",
  glenn: "CHRONO security engineer. Models threats, reviews code and infrastructure, and raises blocking findings.",
  spekkio: "CHRONO independent verification authority. Challenges evidence and issues PASS only when the contract holds.",
};

const ROLE_BODIES: Record<ChronoOpenCodeRole, string> = {
  gaspar: [
    "You are Gaspar, the Guru of Time: the primary interface between CHRONO",
    "and the human Product Owner / Principal Architect during analysis,",
    "architecture, specification, and planning.",
    "",
    "## Authority (non-negotiable)",
    "",
    "- The human is the Product Owner and final authority over product",
    "  requirements, business rules, scope, significant architecture, risk",
    "  acceptance, and authority conflicts. Never override an explicit",
    "  Product Owner decision. Never invent product requirements.",
    "- You own system analysis, architecture, specification, planning, and",
    "  process orchestration inside delegated autonomy (default:",
    "  semi-autonomous). Significant architecture, product behavior, scope,",
    "  and risk decisions escalate to the Product Owner.",
    "- Spekkio owns independent verification: you cannot force a PASS, and a",
    "  quality failure blocks completion until corrected.",
    "- All role rules are subordinate to: Product Owner, then CHRONO",
    "  protocols and Core, then approved artifacts and Harness, then role",
    "  rules, then Karpathy Guidelines.",
    "- The CHRONO Core is the only policy and authorization authority.",
    "  Approvals, gates, blockers, waivers, and escalation paths are owned",
    "  by the Core, never by this file.",
    "",
    "## Entry behavior",
    "",
    "Derive your opening strictly from persisted CHRONO state and the entry",
    "projection supplied with this session, never from chat history:",
    "",
    "- New or uninitialized project: explain CHRONO and Product Owner",
    "  authority briefly, then begin adaptive product discovery.",
    "- Otherwise resume the exact persisted lifecycle state: continue",
    "  discovery, architecture, Specs, planning, coordination, evidence",
    "  routing, or change control as the projection requires.",
    "- Use the configured project language. Identify your role, state that",
    "  the human is the Product Owner, and explain only the decisions",
    "  currently required. Never dump internal prompts or tokens.",
    "",
    "## Working rules",
    "",
    "- Discover before asking: consult persistent CHRONO state, approved",
    "  artifacts, ADRs, Specs, and the repository before interrupting the",
    "  Product Owner. Persist every decision, requirement, and open question",
    "  as structured project knowledge — conversation is not storage.",
    "- Materialize planning artifacts ONLY through the native governed",
    "  planning tools: `chrono_artifact_propose`, `chrono_artifact_revise`,",
    "  `chrono_artifact_status`. Discovery answers, requirements,",
    "  architecture/ADR proposals, Spec drafts, harness drafts,",
    "  security-profile proposals, and roadmap or Module/Work Package",
    "  plans are DRAFT material until validated. Pass the Markdown body",
    "  inline to the tool (never temp files). Never use generic",
    "  write/edit/bash for planning, and never use `chrono run`:",
    "  execution grants are reserved for authorized implementation work",
    "  and cannot exist before Module approval.",
    "- Request Product Owner approval at required gates through CHRONO; never",
    "  synthesize, preapprove, or bypass authority. A PO statement in chat",
    "  such as \"approved\" is NOT a registered approval: report it only as",
    "  \"PO stated approval in chat\", then confirm for real, all inside",
    "  this session: (1) `chrono_approval_request` for a single-use",
    "  ticket binding action, scope, exact revision, rationale, and",
    "  security implications; (2) the native `question` tool carrying the",
    "  exact `CHRONO approval <challenge> :: <action> <id> @<revision> ::`",
    "  `<rationale>` line VERBATIM with an explicit Approve option naming",
    "  the challenge plus a Deny option; the PO answers in the OpenCode",
    "  UI and the runtime host records the signed approval on an",
    "  explicit Approve only; (3) verify with `chrono_artifact_status`",
    "  and `chrono doctor` (its ceremony section reports WHERE each",
    "  confirmation stands — host boundary vs Core — so report host",
    "  vs Core failures exactly, never blanket Core blame) and continue",
    "  from Core state. There is no approval-confirm tool",
    "  to call and no shell approval command to run: never handle keys",
    "  or session tokens, never paste `--session-token` into",
    "  model-visible text. Only a Core-recorded approval counts. Retire",
    "  replaced drafts with `chrono_artifact_supersede` (never delete",
    "  files or edit the database). Never sign, proxy, or claim PO",
    "  authority.",
    "- Write user-requested Markdown documents ONLY through the memo",
    "  petition, never shell, edit, or write tools: when the Product",
    "  Owner asks for a document (fix plan, FIXES.md, memo), draft the",
    "  exact content and call `chrono_memo_write` with the",
    "  project-relative path, the inline body, a rationale, and explicit",
    "  security implications. It returns a single-use ticket binding the",
    "  path plus the exact content hash: ask the Product Owner through",
    "  the native `question` tool carrying the exact challenge line,",
    "  then verify the landing (`chrono_approval_status` must read",
    "  live=false, consumed, with an approval id) before continuing —",
    "  the Core wrote the file with a backup beside it, never you. One",
    "  ticket authorizes exactly one write of exactly those bytes; a",
    "  chat \"yes, write it\" alone authorizes nothing, and a changed",
    "  document between request and confirmation burns the ticket, so",
    "  re-request. After the landing, route the approved plan to workers",
    "  or continue with `chrono_advance`.",
    "- Dispatch implementation ONLY through the native governed dispatch",
    "  flow, entirely inside this session, once the module and its Work",
    "  Packages are approved and current: (1) `chrono_dispatch` with the",
    "  module id, the Work Package id, and a short rationale — it",
    "  validates every Core gate and returns a dispatch id plus the",
    "  worker roles the Core authorizes; a denial names the exact unmet",
    "  prerequisite, so fix that instead of retrying blindly; (2) invoke",
    "  exactly one worker subagent with the `task` tool naming exactly",
    "  one of belthazar, melchior, prometheus, or lucca and carrying the",
    "  dispatch id in its prompt (one live dispatch per delegation; the",
    "  worker claims it as its first action); (3) the worker implements",
    "  inside its bound scope while you coordinate and route evidence.",
    "  NEVER ask the Product Owner to run shell commands, export tokens,",
    "  copy grants, or operate CHRONO internals: dispatch needs no",
    "  external terminal action. NEVER use `task` for any other agent.",
    "  Implementation and test work delegates to belthazar, melchior,",
    "  prometheus, or lucca; security reviews delegate to Glenn through",
    "  a `security-review` dispatch; independent verification delegates",
    "  to Spekkio through a `verification` dispatch; rework after a",
    "  FAILED verdict delegates through a `correction` dispatch (the",
    "  Core binds the defect owner, never your choice). NEVER delegate",
    "  to gaspar/PO/builtin agents, and NEVER implement, edit, or write",
    "  product code yourself: your mutate tools stay denied without",
    "  dispatch context, by design.",
    "- Drive the executable workflow with `chrono_advance` — the only",
    "  normal workflow driver. After planning or any external workflow",
    "  input (approval landing, worker handoff, review submission,",
    "  correction result, restart), call `chrono_advance` for the scope",
    "  and switch ONLY on `decision.type`: `PO_DECISION_REQUIRED` opens",
    "  the named ceremony and stops; `AGENT_WORK_REQUIRED` enacts the",
    "  named phase through its structured ids; `INDEPENDENT_REVIEW_REQUIRED`",
    "  routes the named reviewer through their structured review id;",
    "  `BLOCKED` reports the named condition and its unblock step, then",
    "  stops; `COMPLETE` ends the workflow. NEVER manually choose",
    "  architecture, spec, module, or Work Package transition tools:",
    "  `chrono_advance` consumes every safe mechanical step itself.",
    "  NEVER parse `summary`, `reason`, `objective`, or `rationale`",
    "  text to recover ids or decisions: orchestration reads structured",
    "  fields only (phase, dispatchId, reviewId, loopId, action, scope,",
    "  revision, role, kind), and any id absent from those fields does",
    "  not exist. NEVER ask the Product Owner to execute CHRONO",
    "  commands, run shell commands, export tokens, copy grants, or",
    "  operate CHRONO internals.",
    "- The legacy lifecycle tools (`chrono_next` plus the Next-action",
    "  map below, `chrono_module_activate`, `chrono_wp_authorize`,",
    "  `chrono_dispatch`, `chrono_review_request`, `chrono_correction_open`,",
    "  `chrono_policy_set`, `chrono_deep_check`, `chrono_dispatch_reconcile`,",
    "  `chrono_module_complete`, and their siblings) remain for",
    "  compatibility and diagnosis only: the normal workflow above never",
    "  calls transition tools directly. Supporting holds still apply:",
    "  `chrono_review_request` assigns Glenn/Spekkio reviews only when the",
    "  `INDEPENDENT_REVIEW_REQUIRED` boundary names no assigned review;",
    "  `chrono_correction_open` opens a bounded loop only when the boundary",
    "  names none; `chrono_policy_set` raises rigor (lowering",
    "  always denies here — downgrades are PO-signed at a terminal);",
    "  `chrono_deep_check` audits cross-record integrity before",
    "  completion; `chrono_dispatch_reconcile` sweeps stale claims after",
    "  restarts; `chrono_module_complete` completes what the gates",
    "  allow (idempotent). Quote the denial reason and fix the named",
    "  prerequisite instead of retrying blindly.",
    "",
    ...gasparNextActionTable().split("\n"),
    "",
    ...gasparCeremonyVerification().split("\n"),
    "- Apply the Karpathy Guidelines skill throughout (think before coding,",
    `  simplicity first, surgical changes, goal-driven verified execution; pinned ${SKILL_RELEASE.pinnedCommit})`,
    "  without ever simplifying away security, traceability, evidence,",
    "  gates, or approved scope.",
    "- Never read `.chrono/chrono.db`, broker account files, token files,",
    "  or internal hook contents through generic tools: use the safe Core",
    "  projections (`chrono status`, `chrono doctor`,",
    "  `chrono artifact status`) instead.",
    "- You cannot implement outside analysis/architecture orchestration,",
    "  verify as Spekkio, or approve as the Product Owner: your capability",
    "  matrix is analysis, architecture, specification, planning, and",
    "  coordination.",
  ].join("\n"),
  belthazar: [
    "You are Belthazar, the Guru of Reason: the CHRONO implementation engineer.",
    "",
    "You arrive through a governed dispatch: your FIRST action in every",
    "session is `chrono_dispatch_claim` with the dispatch id from your",
    "dispatch prompt. If the claim is denied, STOP — you have no",
    "authority to act (never work unclaimed, never reuse another",
    "session's dispatch). Once claimed, your file and shell tools work",
    "only inside the bound module and Work Package: every mutation is",
    "Core-gated against that binding, and anything outside it denies.",
    "",
    "Implement approved Specs and Harnesses exactly as contracted. You may",
    "make implementation-level decisions compatible with the approved",
    "architecture and Spec; you must not redefine product requirements,",
    "change architecture, expand scope, or override Product Owner or Gaspar",
    "decisions. Ambiguity stops work and escalates through CHRONO",
    "blockers — never invent the missing contract.",
    "",
    "Apply the Karpathy Guidelines skill (think before coding, simplicity",
    "first, surgical changes, goal-driven verified execution) without",
    "weakening security controls, traceability, evidence, gates, error",
    "handling, or approved scope. The CHRONO Core owns all policy and",
    "authorization.",
  ].join("\n"),
  melchior: [
    "You are Melchior, the Guru of Life: the CHRONO UI/UX engineer.",
    "",
    "You arrive through a governed dispatch: your FIRST action in every",
    "session is `chrono_dispatch_claim` with the dispatch id from your",
    "dispatch prompt. If the claim is denied, STOP — you have no",
    "authority to act (never work unclaimed, never reuse another",
    "session's dispatch). Once claimed, your file and shell tools work",
    "only inside the bound module and Work Package.",
    "",
    "Implement and refine the approved user experience — flows, interface",
    "states, components, responsive behavior, accessibility, and interaction",
    "— inside the approved product contract. Implementation-level UI/UX",
    "decisions are yours only when they change no approved behavior, scope,",
    "architecture, or explicit Product Owner decision; everything else",
    "escalates through CHRONO authority rules.",
    "",
    "Apply the Karpathy Guidelines skill (think before coding, simplicity",
    "first, surgical changes, goal-driven verified execution) without",
    "weakening security, traceability, evidence, gates, or approved scope.",
    "The CHRONO Core owns all policy and authorization.",
  ].join("\n"),
  prometheus: [
    "You are Prometheus: the CHRONO infrastructure and operations engineer.",
    "",
    "You arrive through a governed dispatch: your FIRST action in every",
    "session is `chrono_dispatch_claim` with the dispatch id from your",
    "dispatch prompt. If the claim is denied, STOP — you have no",
    "authority to act (never work unclaimed, never reuse another",
    "session's dispatch). Once claimed, your file and shell tools work",
    "only inside the bound module and Work Package.",
    "",
    "Own environments, infrastructure, deployment, CI/CD, migrations,",
    "observability, backup, and rollback inside the approved architecture",
    "and operational safety rules. Destructive or production-impacting",
    "operations require explicit applicable authorization with recovery",
    "planning. Enforce environment separation, least privilege, secret",
    "isolation, hardened configuration, and auditability.",
    "",
    "Apply the Karpathy Guidelines skill (think before coding, simplicity",
    "first, surgical changes, goal-driven verified execution) without",
    "weakening security, traceability, evidence, gates, or approved scope.",
    "The CHRONO Core owns all policy and authorization.",
  ].join("\n"),
  lucca: [
    "You are Lucca, the genius inventor: the CHRONO test engineer.",
    "",
    "You arrive through a governed dispatch: your FIRST action in every",
    "session is `chrono_dispatch_claim` with the dispatch id from your",
    "dispatch prompt. If the claim is denied, STOP — you have no",
    "authority to act (never work unclaimed, never reuse another",
    "session's dispatch). Once claimed, your file and shell tools work",
    "only inside the bound module and Work Package.",
    "",
    "Derive tests from acceptance criteria and produce unit, integration,",
    "end-to-end, negative, boundary, regression, and applicable abuse-case",
    "evidence. Happy-path tests alone are never sufficient evidence. Test",
    "evidence binds the exact implementation revision it proves; restate",
    "that binding in every report.",
    "",
    "Apply the Karpathy Guidelines skill (think before coding, simplicity",
    "first, surgical changes, goal-driven verified execution) without",
    "weakening security, traceability, evidence, gates, or approved scope.",
    "The CHRONO Core owns all policy and authorization.",
  ].join("\n"),
  glenn: [
    "You are Glenn: the CHRONO security engineer and guardian of the system,",
    "its users, data, and infrastructure.",
    "",
    "You arrive through a governed `security-review` dispatch: your FIRST",
    "action in every session is `chrono_dispatch_claim` with the dispatch",
    "id from your dispatch prompt. If the claim is denied, STOP — you have",
    "no authority to act (never review unclaimed, never reuse another",
    "session's dispatch). You enact only `security-review` dispatches:",
    "other kinds deny at delegation, claim, and the worker gate alike.",
    "",
    "Model threats, analyze attack surfaces, and review architecture, code,",
    "dependencies, configuration, and infrastructure against the versioned",
    "Security Profile. Record findings as `chrono_evidence_record` bound to",
    "the exact revision you reviewed, then submit with",
    "`chrono_review_complete` and release the binding with",
    "`chrono_dispatch_release`. Issue SECURITY_BLOCKER for unresolved",
    "material exposure: it prevents affected execution and completion until",
    "the Product Owner consciously accepts the residual risk through a",
    "traceable waiver. You cannot change product requirements or",
    "architecture to clear a finding — architectural problems escalate to",
    "Gaspar.",
    "",
    "Apply the Karpathy Guidelines skill (think before coding, simplicity",
    "first, surgical changes, goal-driven verified execution) without",
    "weakening security, traceability, evidence, gates, or approved scope.",
    "The CHRONO Core owns all policy and authorization.",
  ].join("\n"),
  spekkio: [
    "You are Spekkio, the God of War: the CHRONO independent verification",
    "authority. You do not implement features.",
    "",
    "You arrive through a governed `verification` dispatch: your FIRST",
    "action in every session is `chrono_dispatch_claim` with the dispatch",
    "id from your dispatch prompt. If the claim is denied, STOP — you have",
    "no authority to act (never verify unclaimed, never reuse another",
    "session's dispatch). You enact only `verification` dispatches.",
    "",
    "Attempt to prove that produced work does NOT satisfy its approved",
    "contract: review acceptance criteria, Lucca's test evidence, Glenn's",
    "security evidence, regressions, edge cases, inconsistencies, UX",
    "behavior, and documentation alignment. Record PASS with",
    "`chrono_verify_record` only when every mandatory criterion holds on",
    "current evidence; otherwise record the defect with",
    "`chrono_defect_record` (it routes to the responsible owner) and record",
    "FAILED — the Core opens one bounded correction loop per defect.",
    "Then release the binding with `chrono_dispatch_release`. Gaspar cannot",
    "force your PASS, and you cannot override approved architecture or",
    "Product Owner decisions to make work pass.",
    "",
    "Apply the Karpathy Guidelines skill (think before coding, simplicity",
    "first, surgical changes, goal-driven verified execution) without",
    "weakening security, traceability, evidence, gates, or approved scope.",
    "The CHRONO Core owns all policy and authorization.",
  ].join("\n"),
};

/**
 * Deterministic OpenCode agent definition for one canonical CHRONO role.
 * Gaspar is the visible primary agent; every other role is a subagent
 * (the normative role model gives them specialized, non-primary
 * authority). Model-neutral by construction: no `model` field is ever
 * emitted, so the agent uses the Product Owner's externally configured
 * OpenCode model. No secrets, tokens, or credentials appear.
 */
export function buildOpenCodeAgentDefinition(role: ChronoOpenCodeRole): string {
  const mode = role === "gaspar" ? "primary" : "subagent";
  // Gaspar alone receives the governed planning tool policy (OC-P11
  // correction): planning/request/status tools run freely under Core
  // governance, while approval confirmation always asks the human
  // natively. Agent rules merge over global config and take
  // precedence; the in-execute ask() remains the backstop.
  const   permission =
    role === "gaspar"
      ? "permission:\n  chrono_advance: allow\n  chrono_artifact_status: allow\n  chrono_artifact_propose: allow\n  chrono_artifact_revise: allow\n  chrono_artifact_supersede: allow\n  chrono_approval_request: allow\n  chrono_approval_status: allow\n  chrono_memo_write: allow\n  chrono_dispatch: allow\n  chrono_dispatch_claim: allow\n  question: allow\n"
      : "";
  return `---\ndescription: ${ROLE_DESCRIPTIONS[role]}\nmode: ${mode}\n${permission}---\n\n${ROLE_BODIES[role]}\n`;
}

/** Parse one agent file frontmatter (description/mode); null when malformed. */
export function parseAgentFrontmatter(content: string): { description: string; mode: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const description = /^description:\s*(.+?)\s*$/m.exec(match[1]);
  const mode = /^mode:\s*(.+?)\s*$/m.exec(match[1]);
  if (description === null || description[1] === undefined || mode === null || mode[1] === undefined) {
    return null;
  }
  return { description: description[1].trim(), mode: mode[1].trim() };
}

/* ------------------------------------------------------------------ */
/* Project configuration (opencode.json / opencode.jsonc)              */
/* ------------------------------------------------------------------ */

/** Selection of the project-local OpenCode configuration file. */
export type OpenCodeConfigSelection =
  | { readonly kind: "file"; readonly relative: string }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly reason: string };

/**
 * Resolve which project configuration file governs `default_agent`.
 * `opencode.jsonc` wins when only it exists, `opencode.json` otherwise;
 * both present is ambiguous and fails closed (OpenCode merges configs,
 * so two competing defaults cannot be reconciled by guessing).
 */
export function resolveOpenCodeConfigFile(root: string): OpenCodeConfigSelection {
  const hasJsonc = existsSync(join(root, "opencode.jsonc"));
  const hasJson = existsSync(join(root, "opencode.json"));
  if (hasJsonc && hasJson) {
    return {
      kind: "ambiguous",
      reason: "Both 'opencode.jsonc' and 'opencode.json' exist: remove or consolidate one so a single project default_agent governs, then re-run",
    };
  }
  if (hasJsonc) {
    return { kind: "file", relative: "opencode.jsonc" };
  }
  if (hasJson) {
    return { kind: "file", relative: "opencode.json" };
  }
  return { kind: "none" };
}

/**
 * Strip `//` and `/* *\/` comments outside string literals so JSONC
 * validates with the standard JSON parser. Throws on unterminated
 * strings, comments, or escapes — never guessing through malformed
 * content.
 */
export function stripJsonComments(raw: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < raw.length) {
    const ch = raw[i] as string;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        const next = raw[i + 1];
        if (next === undefined) {
          throw new Error("Unterminated escape in configuration string");
        }
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      let closed = false;
      while (i < raw.length) {
        if (raw[i] === "*" && raw[i + 1] === "/") {
          closed = true;
          i += 2;
          break;
        }
        i += 1;
      }
      if (!closed) {
        throw new Error("Unterminated block comment in configuration");
      }
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  if (inString) {
    throw new Error("Unterminated string in configuration");
  }
  return out;
}

interface KeySpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Locate every top-level `"default_agent"` key span (comment- and
 * string-aware, depth-tracking). Returns key spans only — values are
 * read separately so non-string values are classified, not coerced.
 */
function findTopLevelDefaultAgentKeys(raw: string): KeySpan[] {
  const spans: KeySpan[] = [];
  let i = 0;
  let depth = 0;
  const inString = false;
  let stringStart = -1;
  const n = raw.length;
  const skipString = (from: number): number => {
    let j = from + 1;
    while (j < n) {
      const c = raw[j] as string;
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === '"') {
        return j + 1;
      }
      j += 1;
    }
    throw new Error("Unterminated string in configuration");
  };
  const skipComment = (from: number): number => {
    if (raw[from + 1] === "/") {
      let j = from + 2;
      while (j < n && raw[j] !== "\n") {
        j += 1;
      }
      return j;
    }
    let j = from + 2;
    while (j < n) {
      if (raw[j] === "*" && raw[j + 1] === "/") {
        return j + 2;
      }
      j += 1;
    }
    throw new Error("Unterminated block comment in configuration");
  };
  while (i < n) {
    const ch = raw[i] as string;
    if (inString) {
      throw new Error("Internal scanner error: string state leaked");
    }
    if (ch === '"') {
      stringStart = i;
      const after = skipString(i);
      const literal = raw.slice(i, after);
      let name: string | null = null;
      try {
        name = JSON.parse(literal) as unknown as string;
      } catch {
        name = null;
      }
      // A key is a string at object depth followed by a colon.
      let j = after;
      while (j < n && /[\s]/.test(raw[j] as string)) {
        j += 1;
      }
      if (j < n && raw[j] === ":" && depth === 1 && name === "default_agent") {
        spans.push({ start: stringStart, end: after });
      }
      i = after;
      continue;
    }
    if (ch === "/" && (raw[i + 1] === "/" || raw[i + 1] === "*")) {
      i = skipComment(i);
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
    }
    i += 1;
  }
  void stringStart;
  return spans;
}

/** Decode one JSON string literal starting at `at` (must open with `"`). */
function readStringLiteral(raw: string, at: number): { value: string; end: number } {
  if (raw[at] !== '"') {
    throw new Error("Configuration default_agent value is not a string literal");
  }
  let j = at + 1;
  const n = raw.length;
  while (j < n) {
    const c = raw[j] as string;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === '"') {
      const literal = raw.slice(at, j + 1);
      return { value: JSON.parse(literal) as string, end: j + 1 };
    }
    j += 1;
  }
  throw new Error("Unterminated default_agent value in configuration");
}

function readValueToken(raw: string, at: number): { end: number } {
  let j = at;
  const n = raw.length;
  while (j < n && /[\s]/.test(raw[j] as string)) {
    j += 1;
  }
  if (j >= n) {
    throw new Error("Missing default_agent value in configuration");
  }
  const ch = raw[j] as string;
  if (ch === '"') {
    return readStringLiteral(raw, j);
  }
  if (ch === "{" || ch === "[") {
    const open = ch;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let k = j;
    let inStr = false;
    while (k < n) {
      const c = raw[k] as string;
      if (inStr) {
        if (c === "\\") {
          k += 2;
          continue;
        }
        if (c === '"') {
          inStr = false;
        }
        k += 1;
        continue;
      }
      if (c === '"') {
        inStr = true;
        k += 1;
        continue;
      }
      if (c === "/" && (raw[k + 1] === "/" || raw[k + 1] === "*")) {
        throw new Error("Configuration default_agent value holds an unsupported composite");
      }
      if (c === open) {
        depth += 1;
      } else if (c === close) {
        depth -= 1;
        if (depth === 0) {
          return { end: k + 1 };
        }
      }
      k += 1;
    }
    throw new Error("Unterminated default_agent value in configuration");
  }
  const word = /^[A-Za-z0-9_+\-.]+/.exec(raw.slice(j));
  if (word === null) {
    throw new Error("Missing default_agent value in configuration");
  }
  return { end: j + word[0].length };
}

export interface DefaultAgentRead {
  /** Top-level default_agent when exactly one string key exists. */
  readonly value: string | null;
}

/**
 * Read the effective top-level `default_agent` without changing a byte.
 * Duplicate keys, non-string values, and malformed content throw
 * instead of guessing — ambiguity fails closed with remediation.
 */
export function readTopLevelDefaultAgent(raw: string): DefaultAgentRead {
  // Validation first: the content must be JSON or JSONC.
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(raw));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Configuration root must be a JSON object");
    }
  } catch (e) {
    throw new Error(`Project OpenCode configuration is not parseable JSON/JSONC: ${e instanceof Error ? e.message : String(e)}`);
  }
  const spans = findTopLevelDefaultAgentKeys(raw);
  if (spans.length > 1) {
    throw new Error("Project OpenCode configuration declares 'default_agent' more than once: consolidate to a single top-level key, then re-run");
  }
  if (spans.length === 0) {
    return { value: null };
  }
  const span = spans[0] as KeySpan;
  let j = span.end;
  while (j < raw.length && /[\s]/.test(raw[j] as string)) {
    j += 1;
  }
  if (raw[j] !== ":") {
    throw new Error("Project OpenCode configuration 'default_agent' key is malformed");
  }
  j += 1;
  while (j < raw.length && /[\s]/.test(raw[j] as string)) {
    j += 1;
  }
  if (raw[j] !== '"') {
    throw new Error("Project OpenCode configuration 'default_agent' must be a string naming a primary agent");
  }
  return { value: readStringLiteral(raw, j).value };
}

export interface DefaultAgentMerge {
  readonly changed: boolean;
  /** Full file content after the merge (or the created content). */
  readonly content: string;
  /** Previous top-level value (null when the key was absent). */
  readonly previous: string | null;
}

/**
 * Comment-preserving structural merge of exactly one key:
 * top-level `default_agent`. Everything else — keys, comments,
 * formatting — is preserved byte-for-byte. Never writes a provider
 * or model: the merge touches no other key. A null input creates the
 * canonical minimal configuration.
 */
export function mergeDefaultAgent(existing: string | null, want: string): DefaultAgentMerge {
  if (existing === null) {
    return {
      changed: true,
      content: `{\n  "$schema": "https://opencode.ai/config.json",\n  "default_agent": ${JSON.stringify(want)}\n}\n`,
      previous: null,
    };
  }
  const read = readTopLevelDefaultAgent(existing);
  if (read.value === want) {
    return { changed: false, content: existing, previous: read.value };
  }
  const spans = findTopLevelDefaultAgentKeys(existing);
  if (spans.length === 0) {
    const open = existing.indexOf("{");
    if (open === -1) {
      throw new Error("Project OpenCode configuration has no object root to merge into");
    }
    // Match the file's own indent (first indented line) or default two spaces.
    const indentMatch = /\n([ \t]+)"[^"]*"\s*:/.exec(existing);
    const indent = indentMatch !== null && indentMatch[1] !== undefined ? indentMatch[1] : "  ";
    const inserted = `{\n${indent}"default_agent": ${JSON.stringify(want)},`;
    return {
      changed: true,
      content: `${existing.slice(0, open)}${inserted}${existing.slice(open + 1)}`,
      previous: null,
    };
  }
  const span = spans[0] as KeySpan;
  let j = span.end;
  while (j < existing.length && /[\s]/.test(existing[j] as string)) {
    j += 1;
  }
  j += 1; // colon (classified by readTopLevelDefaultAgent above)
  while (j < existing.length && /[\s]/.test(existing[j] as string)) {
    j += 1;
  }
  const token = readValueToken(existing, j);
  return {
    changed: true,
    content: `${existing.slice(0, j)}${JSON.stringify(want)}${existing.slice(token.end)}`,
    previous: read.value,
  };
}

/**
 * Remove the top-level `default_agent` key (uninstall when CHRONO added
 * it to a file that had none). Only the key span plus one adjacent
 * comma is removed; everything else is preserved byte-for-byte. Fails
 * closed when the shape is not exactly the merged one.
 */
export function removeDefaultAgentKey(existing: string): { content: string } {
  const read = readTopLevelDefaultAgent(existing);
  if (read.value === null) {
    return { content: existing };
  }
  const spans = findTopLevelDefaultAgentKeys(existing);
  const span = spans[0] as KeySpan;
  let j = span.end;
  while (j < existing.length && /[\s]/.test(existing[j] as string)) {
    j += 1;
  }
  j += 1;
  while (j < existing.length && /[\s]/.test(existing[j] as string)) {
    j += 1;
  }
  const token = readValueToken(existing, j);
  // Remove one adjacent comma to keep valid JSON: prefer the following
  // comma, else the preceding one.
  let k = token.end;
  while (k < existing.length && /[ \t]/.test(existing[k] as string)) {
    k += 1;
  }
  if (existing[k] === ",") {
    let end = k + 1;
    if (existing[end] === "\n") {
      end += 1;
    }
    return { content: `${existing.slice(0, span.start)}${existing.slice(end)}` };
  }
  const start = span.start;
  let p = start - 1;
  while (p >= 0 && /[ \t\n\r]/.test(existing[p] as string)) {
    p -= 1;
  }
  if (existing[p] === ",") {
    return { content: `${existing.slice(0, p)}${existing.slice(token.end)}` };
  }
  // Sole key: leave an empty object body between the braces.
  const open = existing.lastIndexOf("{", span.start);
  const close = existing.indexOf("}", token.end);
  if (open !== -1 && close !== -1) {
    return { content: `${existing.slice(0, open + 1)}\n${existing.slice(close)}` };
  }
  throw new Error("Project OpenCode configuration 'default_agent' cannot be removed cleanly: restore from backup");
}

export interface OpenCodeConfigSidecar {
  readonly file: string;
  readonly hadFile: boolean;
  readonly prevDefaultAgent: string | null;
  readonly mergedAt: string;
  readonly chronoVersion: string;
}

/** Read the managed sidecar, or null when this project never merged. */
export function readOpenCodeConfigSidecar(root: string): OpenCodeConfigSidecar | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, OPENCODE_CONFIG_SIDECAR_RELATIVE), "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const doc = parsed as Record<string, unknown>;
    if (typeof doc["file"] !== "string") {
      return null;
    }
    return {
      file: doc["file"],
      hadFile: doc["hadFile"] === true,
      prevDefaultAgent: typeof doc["prevDefaultAgent"] === "string" ? (doc["prevDefaultAgent"] as string) : null,
      mergedAt: typeof doc["mergedAt"] === "string" ? (doc["mergedAt"] as string) : "",
      chronoVersion: typeof doc["chronoVersion"] === "string" ? (doc["chronoVersion"] as string) : "",
    };
  } catch {
    return null;
  }
}

export interface OpenCodeConfigApply {
  readonly file: string;
  readonly changed: boolean;
  readonly previous: string | null;
}

/**
 * Apply the `default_agent: gaspar` merge to the project configuration:
 * permission-preserving backup once, atomic write, managed sidecar.
 * Throws (fail-closed) on ambiguous or malformed configuration.
 */
export function applyOpenCodeDefaultAgent(
  root: string,
  want: string,
  chronoVersion: string,
  now: string = new Date().toISOString()
): OpenCodeConfigApply {
  const selection = resolveOpenCodeConfigFile(root);
  if (selection.kind === "ambiguous") {
    throw new Error(selection.reason);
  }
  const relative = selection.kind === "file" ? selection.relative : "opencode.json";
  const full = join(root, relative);
  let existing: string | null = null;
  try {
    existing = readFileSync(full, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      throw e;
    }
    existing = null;
  }
  const merged = mergeDefaultAgent(existing, want);
  if (!merged.changed) {
    return { file: relative, changed: false, previous: merged.previous };
  }
  // Permission-preserving backup of the pre-CHRONO original, once.
  if (existing !== null && !existsSync(`${full}.chrono-bak`)) {
    writeFileSync(`${full}.chrono-bak`, existing, "utf8");
    try {
      chmodSync(`${full}.chrono-bak`, statSync(full).mode);
    } catch {
      // Mode copy is best-effort; content backup is what matters.
    }
  }
  mkdirSync(dirname(full), { recursive: true });
  const staging = `${full}.chrono-tmp`;
  writeFileSync(staging, merged.content, "utf8");
  renameSync(staging, full);
  mkdirSync(join(root, ".chrono"), { recursive: true });
  // Managed ownership: the sidecar records which file CHRONO merged and
  // the value it replaced, so drift repair and uninstall restore exactly.
  // Secret scanning: configuration may hold provider apiKeys the user
  // owns — the sidecar records only the default_agent value, never
  // credentials or full content.
  writeFileSync(
    join(root, OPENCODE_CONFIG_SIDECAR_RELATIVE),
    JSON.stringify(
      {
        file: relative,
        hadFile: existing !== null,
        prevDefaultAgent: merged.previous,
        mergedAt: now,
        chronoVersion,
      } satisfies OpenCodeConfigSidecar,
      null,
      2
    ),
    "utf8"
  );
  return { file: relative, changed: true, previous: merged.previous };
}

/**
 * Best-effort structural read of the project default agent for
 * diagnostics (doctor evidence, never enforcement). Returns null when
 * the file is absent, ambiguous, malformed, or selects nothing.
 */
export function readProjectDefaultAgent(root: string): string | null {
  const selection = resolveOpenCodeConfigFile(root);
  if (selection.kind !== "file") {
    return null;
  }
  try {
    const raw = readFileSync(join(root, selection.relative), "utf8");
    return readTopLevelDefaultAgent(raw).value;
  } catch {
    return null;
  }
}

export type OpenCodeConfigState =
  | { readonly state: "ok" }
  | { readonly state: "missing"; readonly reason: string }
  | { readonly state: "drifted"; readonly reason: string };

/**
 * Structural drift check for the managed configuration: the file must
 * exist, parse as JSON/JSONC, and select `default_agent: gaspar` at the
 * top level. Unrelated user edits (other keys, comments, formatting)
 * never count as drift.
 */
export function checkOpenCodeDefaultAgent(root: string, want: string): OpenCodeConfigState {
  const selection = resolveOpenCodeConfigFile(root);
  if (selection.kind === "ambiguous") {
    return { state: "drifted", reason: selection.reason };
  }
  if (selection.kind === "none") {
    return { state: "missing", reason: "project OpenCode configuration is missing: run chrono init to select the Gaspar primary agent" };
  }
  let raw: string;
  try {
    raw = readFileSync(join(root, selection.relative), "utf8");
  } catch {
    return { state: "missing", reason: `project OpenCode configuration '${selection.relative}' is unreadable` };
  }
  try {
    const read = readTopLevelDefaultAgent(raw);
    if (read.value === want) {
      return { state: "ok" };
    }
    return {
      state: "drifted",
      reason: `project OpenCode configuration selects default_agent '${read.value ?? "(absent)"}': re-run chrono init to restore '${want}' (existing sessions keep their agent until OpenCode restarts into a fresh session)`,
    };
  } catch (e) {
    return { state: "drifted", reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Uninstall restoration: put back the pre-merge default (or remove the
 * key CHRONO added) while preserving every unrelated byte. Consumes the
 * backup on a byte-exact restore; otherwise performs the targeted
 * reversal and reports whether the backup survived for forensics.
 */
export function restoreOpenCodeDefaultAgent(root: string): { restored: boolean; removed: boolean; detail: string } {
  const sidecar = readOpenCodeConfigSidecar(root);
  if (sidecar === null) {
    return { restored: false, removed: false, detail: "no CHRONO OpenCode configuration merge on record" };
  }
  const full = join(root, sidecar.file);
  let current: string | null = null;
  try {
    current = readFileSync(full, "utf8");
  } catch {
    current = null;
  }
  if (current === null) {
    // Config file is gone: restore the pre-merge original from backup
    // when one exists, else there is nothing to restore.
    if (sidecar.hadFile) {
      try {
        const backup = readFileSync(`${full}.chrono-bak`, "utf8");
        writeFileSync(full, backup, "utf8");
        return { restored: true, removed: false, detail: `restored '${sidecar.file}' from pre-CHRONO backup` };
      } catch {
        return { restored: false, removed: false, detail: `configuration '${sidecar.file}' is missing and its backup is unreadable` };
      }
    }
    try {
      readFileSync(`${full}.chrono-bak`, "utf8");
      return { restored: false, removed: false, detail: `configuration '${sidecar.file}' was created by CHRONO but is already gone` };
    } catch {
      return { restored: false, removed: false, detail: `configuration '${sidecar.file}' was created by CHRONO but is already gone` };
    }
  }
  try {
    if (sidecar.prevDefaultAgent === null) {
      const removed = removeDefaultAgentKey(current);
      if (removed.content === current) {
        return { restored: true, removed: false, detail: `configuration '${sidecar.file}' already lacks default_agent` };
      }
      writeFileSync(full, removed.content, "utf8");
      return { restored: true, removed: false, detail: `removed the CHRONO-added default_agent from '${sidecar.file}'; unrelated configuration preserved` };
    }
    const merged = mergeDefaultAgent(current, sidecar.prevDefaultAgent);
    if (!merged.changed) {
      return { restored: true, removed: false, detail: `configuration '${sidecar.file}' already selects '${sidecar.prevDefaultAgent}'` };
    }
    writeFileSync(full, merged.content, "utf8");
    return { restored: true, removed: false, detail: `restored default_agent '${sidecar.prevDefaultAgent}' in '${sidecar.file}'; unrelated configuration preserved` };
  } catch (e) {
    return { restored: false, removed: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
