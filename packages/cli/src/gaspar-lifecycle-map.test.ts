/**
 * Gaspar next-action map (CORE_FIX_2 CF2-3 §6.6): the generated Gaspar
 * contract must route EVERY value `nextAction` can return to its
 * native tool or explicit human/await hold. Missing mappings fail
 * this test (and therefore the build); unknown action values fail
 * loudly at runtime instead of degrading to prose or guessed
 * commands.
 */
import { describe, it, expect } from "vitest";
import { NEXT_ACTIONS } from "@chrono/core";
import { buildPlanningToolsFile, CHRONO_NATIVE_TOOLS } from "./opencode-planning-tools.js";
import {
  GASPAR_NEXT_ACTION_MAP,
  buildOpenCodeAgentDefinition,
  resolveGasparNextAction,
} from "./opencode-agent.js";

describe("Gaspar next-action map (CF2-3)", () => {
  it("covers exactly the Core NEXT_ACTIONS universe — no missing, no extra keys", () => {
    expect(Object.keys(GASPAR_NEXT_ACTION_MAP).sort()).toEqual([...NEXT_ACTIONS].sort());
  });

  it("routes every executable action to a real native tool with named args", () => {
    const tools = new Set<string>(CHRONO_NATIVE_TOOLS);
    for (const action of NEXT_ACTIONS) {
      const route = GASPAR_NEXT_ACTION_MAP[action as string]!;
      expect(route, `missing route for '${action}'`).toBeTruthy();
      if (route.tool !== null) {
        expect(tools.has(route.tool), `'${action}' routes to unknown tool '${route.tool}'`).toBe(true);
        // Zero-arg tools (singleton scopes like ARCH) carry an
        // explicit empty list, never an absent one.
        expect(Array.isArray(route.args), `'${action}' names no args list`).toBe(true);
      } else {
        expect(route.hold, `'${action}' is a hold without hold text`).toBeTruthy();
      }
      expect(route.note.length, `'${action}' carries no note`).toBeGreaterThan(0);
    }
  });

  it("encodes the mandatory backbone sequence exactly", () => {
    expect(resolveGasparNextAction("activate-module").tool).toBe("chrono_module_activate");
    expect(resolveGasparNextAction("authorize-wp").tool).toBe("chrono_wp_authorize");
    const dispatch = resolveGasparNextAction("request-dispatch");
    expect(dispatch.tool).toBe("chrono_dispatch");
    expect(dispatch.note).toMatch(/exactly one/i);
    expect(dispatch.note).toMatch(/task/);
    const correction = resolveGasparNextAction("request-correction");
    expect(correction.tool).toBe("chrono_dispatch");
    expect(correction.note).toMatch(/exactly one/i);
    expect(resolveGasparNextAction("complete-module").tool).toBe("chrono_module_complete");
    expect(resolveGasparNextAction("assign-review").tool).toBe("chrono_review_request");
  });

  it("routes the planning runway to its native tools", () => {
    expect(resolveGasparNextAction("submit-architecture").tool).toBe("chrono_architecture_submit");
    expect(resolveGasparNextAction("approve-architecture").tool).toBe("chrono_architecture_approve");
    expect(resolveGasparNextAction("submit-spec").tool).toBe("chrono_spec_submit");
    expect(resolveGasparNextAction("record-harness").tool).toBe("chrono_harness_record");
    expect(resolveGasparNextAction("ready-spec").tool).toBe("chrono_spec_ready");
    const approval = resolveGasparNextAction("request-approval");
    expect(approval.tool).toBe("chrono_approval_request");
    expect(approval.hold).toMatch(/question/);
  });

  it("holds (never tools) for PO ceremony, awaits, foreign sessions, and the terminal", () => {
    for (const action of ["await-approval", "await-claim", "await-action", "blocked", "done", "advance-module", "authorize-work"] as const) {
      expect(resolveGasparNextAction(action).tool, `'${action}' must be a hold`).toBe(null);
    }
    // The security ceremony is Gaspar-initiated (ticket) but
    // PO-completed (native question): tool plus hold.
    const security = resolveGasparNextAction("approve-security");
    expect(security.tool).toBe("chrono_approval_request");
    expect(security.hold).toMatch(/question/);
  });

  it("fails loudly on unknown action values instead of guessing", () => {
    expect(() => resolveGasparNextAction("teleport-module")).toThrow(/unknown next action 'teleport-module'/);
    expect(() => resolveGasparNextAction("")).toThrow(/unknown next action/);
  });

  it("ships the planning-runway native tools (pilot repair: pre-activation has a native path)", () => {
    for (const tool of [
      "chrono_architecture_submit",
      "chrono_architecture_approve",
      "chrono_spec_submit",
      "chrono_spec_ready",
      "chrono_spec_needs_revision",
      "chrono_harness_record",
    ] as const) {
      expect(CHRONO_NATIVE_TOOLS as readonly string[], `missing native tool '${tool}'`).toContain(tool);
      const suffix = tool.replace(/^chrono_/, "");
      expect(buildPlanningToolsFile(), `generated tools omit '${suffix}'`).toContain(`export const ${suffix} = tool(`);
    }
  });

  it("embeds ceremony verification and the planning runway in the generated Gaspar contract", () => {
    const gaspar = buildOpenCodeAgentDefinition("gaspar");
    // Verification loop: never assume an approval landed.
    expect(gaspar).toContain("never assume an approval landed");
    expect(gaspar).toContain("chrono_approval_status");
    expect(gaspar).toContain("approval-multi-ticket");
    expect(gaspar).toContain("approval-answer-no-match");
    // One ticket per question: answers echo option labels only.
    expect(gaspar).toContain("One ticket per question");
    expect(gaspar).toContain("answers echo option labels only");
    // Planning runway order with the new native tools.
    for (const tool of ["chrono_architecture_submit", "chrono_architecture_approve", "chrono_spec_submit", "chrono_spec_ready", "chrono_harness_record"] as const) {
      expect(gaspar, `contract never routes to '${tool}'`).toContain(tool);
    }
    expect(gaspar).toContain("freeze content before approving");
  });

  it("embeds the exhaustive table in the generated Gaspar contract", () => {
    const gaspar = buildOpenCodeAgentDefinition("gaspar");
    for (const action of NEXT_ACTIONS) {
      expect(gaspar, `contract never mentions '${action}'`).toContain(`\`${action}\``);
    }
    for (const tool of ["chrono_module_activate", "chrono_wp_authorize", "chrono_dispatch", "chrono_module_complete", "chrono_review_request", "chrono_approval_request"] as const) {
      expect(gaspar, `contract never routes to '${tool}'`).toContain(tool);
    }
    // Autonomy boundary: executable actions proceed, PO ceremony stops.
    expect(gaspar).toContain("continue autonomously");
    expect(gaspar).toContain("NEVER ask the Product Owner to run CHRONO internal commands");
    // Stale precedence prose is gone: activation and authorization lead.
    expect(gaspar).not.toContain("open correction loops first, then stale dispatches");
  });
});
