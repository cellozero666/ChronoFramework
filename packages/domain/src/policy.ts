/**
 * Proportional workflow policy (CORE_FIX CF-11): strict, non-negotiable
 * authority/security invariants plus PO-approved rigor profiles.
 *
 * Safety invariants are absolute. Process shape — how many reviews,
 * how much evidence, batching, fast paths — scales with a versioned
 * project policy profile plus deterministic, technology-agnostic risk
 * triggers. Agents may propose a classification but can never lower
 * applicable rigor: the Core always takes the maximum of project
 * policy, content risk, and any proposal. Lowering a previously
 * applicable security or verification requirement is an explicit
 * signed PO policy decision, never a prompt-side shortcut. The PO
 * may always raise rigor.
 *
 * No provider, model, runtime, language, or framework concepts appear
 * here [FW §22]: triggers match technology-agnostic risk patterns
 * (secrets, auth, regulated data, network exposure, schema change,
 * supply chain, infrastructure, destructive operations, crypto,
 * CHRONO's own guards), never product stacks.
 */

/** Rigor profiles, least to most strict. PO-approved per project. */
export const POLICY_PROFILES = ["lean", "standard", "critical"] as const;

export type PolicyProfile = (typeof POLICY_PROFILES)[number];

/** Strictness rank: higher always implies at least the lower profile's gates. */
export function profileRank(profile: PolicyProfile): number {
  return POLICY_PROFILES.indexOf(profile);
}

/** Maximum wins: agents may propose, never downgrade. */
export function maxProfile(...profiles: PolicyProfile[]): PolicyProfile {
  let best: PolicyProfile = "lean";
  for (const profile of profiles) {
    if (profileRank(profile) > profileRank(best)) {
      best = profile;
    }
  }
  return best;
}

/** True when `next` is strictly less rigorous than `current`. */
export function isProfileDowngrade(current: PolicyProfile, next: PolicyProfile): boolean {
  return profileRank(next) < profileRank(current);
}

/** One deterministic, technology-agnostic risk trigger. */
export interface RiskTrigger {
  readonly key: string;
  readonly detail: string;
}

interface TriggerRule {
  readonly key: string;
  readonly detail: string;
  readonly patterns: RegExp[];
}

/**
 * Conservative high-precision patterns. Each pattern targets an
 * unambiguous risk signal; ordinary prose (task lists, rendering,
 * planning notes) must not match. All matching escalates to the
 * `critical` requirement set for the affected scope — escalation is
 * binary and explainable, never a silent score.
 */
const TRIGGER_RULES: TriggerRule[] = [
  {
    key: "secrets",
    detail: "secret material handling (keys, tokens, credentials)",
    patterns: [/\bsecret\b/i, /\bpassword\b/i, /\bcredential(s)?\b/i, /\bapi[_-]?key\b/i, /\bprivate[_-]?key\b/i, /\baccess[_-]?token\b/i],
  },
  {
    key: "auth",
    detail: "authentication or authorization logic",
    patterns: [/\bauthentication\b/i, /\bauthorization\b/i, /\boauth\b/i, /\bsso\b/i, /\bmfa\b/i, /\brbac\b/i, /\blogin\b/i, /\bsign-in\b/i, /\bauth\b/i],
  },
  {
    key: "regulated-data",
    detail: "personal, financial, health, or otherwise regulated data",
    patterns: [/\bemail\b/i, /\bssn\b/i, /\bsocial security\b/i, /\bpersonal data\b/i, /\bphi\b/i, /\bhipaa\b/i, /\bfinancial\b/i, /\bpayment\b/i, /\bcredit.?card\b/i, /\bgdpr\b/i, /\bregulated\b/i, /\bprivacy\b/i, /\bpii\b/i],
  },
  {
    key: "network",
    detail: "network exposure (listeners, sockets, HTTP surface)",
    patterns: [/\bhttps?\b/i, /\bsocket\b/i, /\bwebsocket\b/i, /\blisten\s*\(/i, /\bexpose[sd]?\b/i, /\bingress\b/i, /\bfirewall\b/i],
  },
  {
    key: "database-schema",
    detail: "database or schema change",
    patterns: [/\bdatabase\b/i, /\bsql\b/i, /\bschema\b/i, /\bmigration\b/i],
  },
  {
    key: "supply-chain",
    detail: "dependency or supply-chain change",
    patterns: [/package\.json/i, /package-lock/i, /yarn\.lock/i, /pnpm-lock/i, /Cargo\.toml/i, /Cargo\.lock/i, /go\.mod/i, /go\.sum/i, /requirements\.txt/i, /Gemfile/i, /pom\.xml/i, /build\.gradle/i, /\.lock\b/i, /node_modules/i, /\bsupply.?chain\b/i, /\bdependenc(y|ies)\b/i],
  },
  {
    key: "infrastructure",
    detail: "infrastructure, deployment, or operations change",
    patterns: [/\bdocker\b/i, /\bkubernetes\b/i, /\bk8s\b/i, /\bterraform\b/i, /\bansible\b/i, /\bdeploy\b/i, /\bci\/cd\b/i, /\bpipeline\b/i, /github actions/i, /gitlab ci/i, /\bproduction\b/i, /\bprod\b/i, /\bpublish\b/i, /\brollout\b/i, /\bnginx\b/i, /\bsystemd\b/i],
  },
  {
    key: "destructive",
    detail: "destructive or hard-to-reverse operation",
    patterns: [/\brm\s+-rf\b/i, /\bdelete\b/i, /\bdestroy\b/i, /\bdrop\s+(table|database)\b/i, /\bformat\b/i, /\bwipe\b/i, /\btruncate\b/i],
  },
  {
    key: "cryptography",
    detail: "cryptographic mechanism change",
    patterns: [/\bcrypt/i, /\bencrypt\b/i, /\bdecrypt\b/i, /\bhmac\b/i, /\baes\b/i, /\brsa\b/i, /\btls\b/i, /\bssl\b/i, /\bx\.509\b/i, /\bcertificate\b/i, /\bsign(ature|ing|ed)?\b/i],
  },
  {
    key: "chrono-guards",
    detail: "change touching CHRONO's own guards, policy, or audit store",
    patterns: [/chrono\.db/i, /\.chrono\//i, /\bhooks?\b/i, /gate execution/i, /\bpolicy\b/i, /\battestation\b/i],
  },
];

/**
 * Classify content risk deterministically. Returns every matched
 * trigger plus the minimum required profile (`critical` when any
 * trigger matches, else `lean`). Pure function: identical content
 * always yields identical classification, so neither Gaspar nor a
 * worker can suppress an escalation.
 */
export function classifyContentRisk(texts: ReadonlyArray<string>): { triggers: RiskTrigger[]; requiredProfile: PolicyProfile } {
  const triggers: RiskTrigger[] = [];
  const seen = new Set<string>();
  for (const rule of TRIGGER_RULES) {
    for (const text of texts) {
      if (typeof text !== "string") {
        continue;
      }
      let matched = false;
      for (const pattern of rule.patterns) {
        // Fresh regex state per test: patterns are global-flag-free
        // literals, so `test` is deterministic here.
        if (pattern.test(text)) {
          matched = true;
          break;
        }
      }
      if (matched && !seen.has(rule.key)) {
        seen.add(rule.key);
        triggers.push({ key: rule.key, detail: rule.detail });
      }
    }
  }
  return { triggers, requiredProfile: triggers.length > 0 ? "critical" : "lean" };
}

/** Native dispatch kinds. Each kind restricts its worker roles. */
export const DISPATCH_KINDS = [
  "implementation",
  "test",
  "security-review",
  "verification",
  "correction",
] as const;

export type DispatchKind = (typeof DISPATCH_KINDS)[number];

/**
 * Roles each dispatch kind may bind. Review and verification kinds
 * are NOT interchangeable with implementation: Gaspar coordinates
 * but cannot produce their evidence or verdicts, workers cannot
 * select their own reviewer or verifier, Spekkio cannot mutate
 * product code, and Glenn cannot waive findings (enforced at the
 * review/evidence/transition gates, not just here).
 */
export const DISPATCH_KIND_ROLES: Record<DispatchKind, readonly string[]> = {
  implementation: ["belthazar", "melchior", "prometheus"],
  test: ["lucca"],
  "security-review": ["glenn"],
  verification: ["spekkio"],
  // Correction owner is resolved from the defect at request time;
  // the kind accepts any worker role and Core binds the exact owner.
  correction: ["belthazar", "melchior", "prometheus", "lucca", "glenn"],
};

/** True when `role` may enact `kind`. Unknown kinds never match. */
export function isRoleForDispatchKind(kind: string, role: string): boolean {
  const roles = (DISPATCH_KIND_ROLES as Record<string, readonly string[]>)[kind];
  if (roles === undefined) {
    return false;
  }
  return roles.includes(role);
}

/**
 * Every role that may arrive through a governed dispatch of any kind:
 * implementation and test workers plus reviewers (glenn, spekkio).
 * Orchestration (gaspar), human (PO), builtins, and unknown names are
 * never enactment roles. Kind fit is checked per live dispatch; this
 * set only admits candidates to that check.
 */
export const ENACTMENT_ROLES = ["belthazar", "melchior", "prometheus", "lucca", "glenn", "spekkio"] as const;

export type EnactmentRole = (typeof ENACTMENT_ROLES)[number];

/** True for any role that may enact some dispatch kind. */
export function isEnactmentRole(role: string): role is EnactmentRole {
  return (ENACTMENT_ROLES as readonly string[]).includes(role);
}

/** Bounded correction attempts per effective profile. */
export const CORRECTION_MAX_ATTEMPTS: Record<PolicyProfile, number> = {
  lean: 2,
  standard: 3,
  critical: 5,
};

/**
 * Batch cap for same-kind ready Work Packages returned together by
 * next-action (CF-6). Critical never batches: each package is
 * dispatched and evidenced explicitly. Raising a batch cap is a
 * policy change, not a caller option.
 */
export const BATCH_CAP: Record<PolicyProfile, number> = {
  lean: 5,
  standard: 3,
  critical: 0,
};

/**
 * Canonical PO policy-decision payload. Lowering rigor (moving to a
 * less strict profile than currently in force) is valid only with a
 * signature over these bytes with the enrolled PO key; raising or
 * reaffirming needs no signature. Replay is denied by monotonicity:
 * the signature timestamp must be newer than the stored policy, so
 * an old downgrade signature cannot re-apply after rigor was raised.
 */
export interface PolicyPayload {
  readonly action: "policy-set";
  readonly profile: string;
  readonly rationale: string;
  readonly timestamp: string;
}

/** Build the canonical policy payload from its fields. */
export function buildPolicyPayload(fields: {
  profile: string;
  rationale: string;
  timestamp: string;
}): PolicyPayload {
  return {
    action: "policy-set",
    profile: fields.profile,
    rationale: fields.rationale,
    timestamp: fields.timestamp,
  };
}
