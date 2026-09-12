/**
 * Canonical managed-asset inventory for routing-proof drift binding
 * [FIXES-SL-10.1 C2/C3, INV §8.4]. The exact files are enforcement
 * assets every `chrono setup` installs; runtime-scoped extras apply
 * only to active adapters carrying a known runtime id (setup and
 * doctor follow the same rule, so no flow is surprised).
 *
 * Pure data only: no filesystem access here. The Core reads file bytes
 * at promotion/dispatch time; the CLI reuses this inventory for
 * reporting. `exact` entries hash content bytes; `marker` entries hash
 * presence of a marker string (user-owned files must tolerate unrelated
 * edits without false drift).
 */
import type { KnownRuntimeId } from "./capabilities.js";

export type ManagedAssetKind = "exact" | "marker";

export interface ManagedAssetSpec {
  readonly path: string;
  readonly kind: ManagedAssetKind;
  /** Required for `marker` entries: substring that must be present. */
  readonly marker?: string | undefined;
}

/** Shared enforcement assets: every setup installs these. */
export const SHARED_MANAGED_ASSETS: readonly ManagedAssetSpec[] = [
  { path: ".opencode/plugins/chrono-gate.js", kind: "exact" },
  { path: ".chrono/hooks/chrono-claude-gate.js", kind: "exact" },
  { path: ".chrono/hooks/chrono-kiro-gate.js", kind: "exact" },
  { path: ".chrono/hooks/chrono-entry-session.sh", kind: "exact" },
  { path: ".kiro/hooks/chrono-gate.json", kind: "exact" },
  { path: ".claude/settings.json", kind: "marker", marker: "chrono-claude-gate.js" },
];

/** Runtime-scoped extras, installed only for the matching runtime. */
export function runtimeManagedAssets(adapterId: string): readonly ManagedAssetSpec[] {
  const runtime = adapterId as KnownRuntimeId;
  if (runtime === "claude-code") {
    return [
      { path: ".claude/agents/gaspar.md", kind: "exact" },
      {
        path: ".claude/settings.json",
        kind: "marker",
        marker: `chrono-entry-session.sh ${adapterId}`,
      },
    ];
  }
  if (runtime === "kiro") {
    return [{ path: `.kiro/hooks/chrono-entry-${adapterId}.json`, kind: "exact" }];
  }
  return [];
}

/** Full inventory for a proof scope: shared plus adapter extras. */
export function managedAssetInventory(adapterId: string): readonly ManagedAssetSpec[] {
  return [...SHARED_MANAGED_ASSETS, ...runtimeManagedAssets(adapterId)];
}
