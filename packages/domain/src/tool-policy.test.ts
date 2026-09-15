/**
 * OpenCode tool-classification policy tests (post-planning deadlock repair).
 *
 * The `task` delegation tool is explicitly classified (never
 * unclassified-denied, never broadly allowed): exactly one live
 * dispatch plus the exact worker role passes at the gate. Planning
 * and dispatch natives stay entry-only. Everything else is denied
 * by default.
 */
import { describe, it, expect } from "vitest";
import {
  DISPATCHABLE_WORKER_ROLES,
  OPENCODE_TOOL_POLICY,
  TOOL_POLICY_VERSION,
  classifyOpencodeTool,
  isDispatchableWorkerRole,
} from "./index.js";

describe("OpenCode tool policy (dispatch repair)", () => {
  it("is versioned at v7", () => {
    expect(TOOL_POLICY_VERSION).toBe("7");
  });

  it("classifies activation and reconcile as lifecycle tools", () => {
    expect(classifyOpencodeTool("chrono_module_activate")).toBe("lifecycle");
    expect(classifyOpencodeTool("chrono_review_reconcile")).toBe("lifecycle");
  });

  it("classifies the real delegation tool explicitly, never broadly", () => {
    expect(classifyOpencodeTool("task")).toBe("delegate");
    expect(OPENCODE_TOOL_POLICY["task"]).toBe("delegate");
  });

  it("keeps planning and dispatch natives entry-only", () => {
    for (const tool of [
      "chrono_artifact_status",
      "chrono_artifact_propose",
      "chrono_artifact_revise",
      "chrono_artifact_supersede",
      "chrono_approval_request",
      "chrono_approval_status",
      "chrono_dispatch",
      "chrono_dispatch_claim",
    ]) {
      expect(classifyOpencodeTool(tool)).toBe("planning");
    }
  });

  it("denies unknowns, blanks, and MCP tools by default", () => {
    expect(classifyOpencodeTool("")).toBe(undefined);
    expect(classifyOpencodeTool("   ")).toBe(undefined);
    expect(classifyOpencodeTool("mcp_something")).toBe(undefined);
    expect(classifyOpencodeTool("todoread")).toBe(undefined);
  });

  it("delegates only to WP execution roles", () => {
    expect([...DISPATCHABLE_WORKER_ROLES]).toEqual(["belthazar", "melchior", "prometheus", "lucca"]);
    for (const role of ["belthazar", "melchior", "prometheus", "lucca"]) {
      expect(isDispatchableWorkerRole(role)).toBe(true);
    }
    for (const role of ["gaspar", "PO", "spekkio", "glenn", "build", "plan", "general", "explore", "belthazar2", ""]) {
      expect(isDispatchableWorkerRole(role)).toBe(false);
    }
  });
});
