/**
 * Canonical managed-asset inventory for routing-proof drift binding
 * [FIXES-SL-10.1 C2/C3, INV §8.4] and OpenCode-first rollout scoping
 * [OPENCODE-PILOT-GATE.md]. Only genuinely shared enforcement assets
 * plus the current runtime's own hook/registration/definition files
 * belong to a proof scope: `chrono setup`/`chrono init --runtime <id>`
 * must not install or modify another runtime's integration assets, and
 * `chrono doctor` must not demand them.
 *
 * The entry-session script is the single shared mandatory asset (every
 * runtime redeems Gaspar entry through it). Everything else is
 * runtime-scoped. Unknown adapter ids keep the legacy full baseline
 * (never guessed into a runtime, never silently narrowed).
 *
 * Pure data only: no filesystem access here. The Core reads file bytes
 * at promotion/dispatch time; the CLI reuses this inventory for
 * setup/doctor reporting. `exact` entries hash content bytes; `marker`
 * entries hash presence of a marker string (user-owned files must
 * tolerate unrelated edits without false drift).
 */
import type { KnownRuntimeId } from "./capabilities.js";

export type ManagedAssetKind = "exact" | "marker";

export interface ManagedAssetSpec {
  readonly path: string;
  readonly kind: ManagedAssetKind;
  /** Required for `marker` entries: substring that must be present. */
  readonly marker?: string | undefined;
}

/** The single shared mandatory asset: every runtime's entry uses it. */
export const ENTRY_SESSION_SCRIPT_ASSET: ManagedAssetSpec = {
  path: ".chrono/hooks/chrono-entry-session.sh",
  kind: "exact",
};

/**
 * Runtime-scoped enforcement assets, installed and verified only for
 * the matching runtime. Each set is self-sufficient together with the
 * shared entry script.
 */
export const RUNTIME_MANAGED_ASSETS: Record<KnownRuntimeId, readonly ManagedAssetSpec[]> = {
  opencode: [{ path: ".opencode/plugins/chrono-gate.js", kind: "exact" }],
  "claude-code": [
    { path: ".chrono/hooks/chrono-claude-gate.js", kind: "exact" },
    { path: ".claude/settings.json", kind: "marker", marker: "chrono-claude-gate.js" },
    { path: ".claude/agents/gaspar.md", kind: "exact" },
  ],
  kiro: [
    { path: ".chrono/hooks/chrono-kiro-gate.js", kind: "exact" },
    { path: ".kiro/hooks/chrono-gate.json", kind: "exact" },
    // Adapter-scoped below (entry registration carries the adapter id).
  ],
};

/** Kiro adapter-scoped entry registration (path carries the adapter id). */
export function kiroEntryAsset(adapterId: string): ManagedAssetSpec {
  return { path: `.kiro/hooks/chrono-entry-${adapterId}.json`, kind: "exact" };
}

/** Claude adapter-scoped entry marker (path is shared, marker is not). */
export function claudeEntryAsset(adapterId: string): ManagedAssetSpec {
  return {
    path: ".claude/settings.json",
    kind: "marker",
    marker: `chrono-entry-session.sh ${adapterId}`,
  };
}

/**
 * Legacy full baseline for unknown adapter ids: every setup installs
 * these (never guessed into a runtime, never silently narrowed).
 */
export const LEGACY_MANAGED_ASSETS: readonly ManagedAssetSpec[] = [
  { path: ".opencode/plugins/chrono-gate.js", kind: "exact" },
  { path: ".chrono/hooks/chrono-claude-gate.js", kind: "exact" },
  { path: ".chrono/hooks/chrono-kiro-gate.js", kind: "exact" },
  ENTRY_SESSION_SCRIPT_ASSET,
  { path: ".kiro/hooks/chrono-gate.json", kind: "exact" },
  { path: ".claude/settings.json", kind: "marker", marker: "chrono-claude-gate.js" },
];

/** Full inventory for a proof scope: shared script plus adapter assets. */
export function managedAssetInventory(adapterId: string): readonly ManagedAssetSpec[] {
  if (adapterId === "opencode" || adapterId === "claude-code" || adapterId === "kiro") {
    const runtime = adapterId as KnownRuntimeId;
    const assets: ManagedAssetSpec[] = [ENTRY_SESSION_SCRIPT_ASSET, ...RUNTIME_MANAGED_ASSETS[runtime]];
    if (runtime === "claude-code") {
      assets.push(claudeEntryAsset(adapterId));
    }
    if (runtime === "kiro") {
      assets.push(kiroEntryAsset(adapterId));
    }
    return assets;
  }
  return LEGACY_MANAGED_ASSETS;
}
