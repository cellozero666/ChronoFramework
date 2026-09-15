/**
 * Proportional workflow policy tests (CORE_FIX CF-11).
 *
 * Risk triggers are deterministic and technology-agnostic; agents
 * may propose but never downgrade (maximum wins); dispatch kinds
 * restrict worker roles without interchange.
 */
import { describe, it, expect } from "vitest";
import {
  CORRECTION_MAX_ATTEMPTS,
  classifyContentRisk,
  isProfileDowngrade,
  isRoleForDispatchKind,
  maxProfile,
} from "./policy.js";

describe("classifyContentRisk", () => {
  it("finds nothing in ordinary planning prose", () => {
    const texts = [
      "Render the task list with titles and done states.",
      "Module plan for the tasks contract.",
      "First work package: list rendering and sorting.",
    ];
    expect(classifyContentRisk(texts)).toEqual({ triggers: [], requiredProfile: "lean" });
  });

  it("escalates on every documented trigger class", () => {
    const cases: Array<[string, string]> = [
      ["store the api_key beside the password", "secrets"],
      ["add authentication with login and oauth", "auth"],
      ["collect the user email for receipts", "regulated-data"],
      ["listen on a socket and expose https", "network"],
      ["add a database migration for the schema", "database-schema"],
      ["bump dependencies in package-lock", "supply-chain"],
      ["deploy with docker to production", "infrastructure"],
      ["rm -rf the build output", "destructive"],
      ["verify the TLS certificate chain", "cryptography"],
      ["rewrite the chrono.db hooks policy", "chrono-guards"],
    ];
    for (const [text, key] of cases) {
      const result = classifyContentRisk([text]);
      expect(result.requiredProfile).toBe("critical");
      expect(result.triggers.map((t) => t.key)).toContain(key);
    }
  });

  it("is deterministic and deduplicates triggers", () => {
    const first = classifyContentRisk(["password and PASSWORD and password"]);
    const second = classifyContentRisk(["password and PASSWORD and password"]);
    expect(first).toEqual(second);
    expect(first.triggers.filter((t) => t.key === "secrets")).toHaveLength(1);
  });

  it("ignores non-string inputs", () => {
    expect(classifyContentRisk([null, 42, "plain prose"] as unknown as string[])).toEqual({
      triggers: [],
      requiredProfile: "lean",
    });
  });
});

describe("profile ordering", () => {
  it("maximum wins so proposals never downgrade", () => {
    expect(maxProfile("lean", "standard")).toBe("standard");
    expect(maxProfile("critical", "lean", "standard")).toBe("critical");
    expect(maxProfile("lean")).toBe("lean");
  });

  it("detects downgrades exactly", () => {
    expect(isProfileDowngrade("standard", "lean")).toBe(true);
    expect(isProfileDowngrade("critical", "standard")).toBe(true);
    expect(isProfileDowngrade("lean", "lean")).toBe(false);
    expect(isProfileDowngrade("lean", "critical")).toBe(false);
    expect(isProfileDowngrade("standard", "standard")).toBe(false);
  });

  it("bounds correction attempts per profile", () => {
    expect(CORRECTION_MAX_ATTEMPTS.lean).toBeLessThan(CORRECTION_MAX_ATTEMPTS.standard);
    expect(CORRECTION_MAX_ATTEMPTS.standard).toBeLessThan(CORRECTION_MAX_ATTEMPTS.critical);
  });
});

describe("dispatch kind roles", () => {
  it("binds implementation roles without interchange", () => {
    expect(isRoleForDispatchKind("implementation", "belthazar")).toBe(true);
    expect(isRoleForDispatchKind("implementation", "lucca")).toBe(false);
    expect(isRoleForDispatchKind("implementation", "spekkio")).toBe(false);
    expect(isRoleForDispatchKind("test", "lucca")).toBe(true);
    expect(isRoleForDispatchKind("test", "belthazar")).toBe(false);
  });

  it("keeps review kinds independent", () => {
    expect(isRoleForDispatchKind("security-review", "glenn")).toBe(true);
    expect(isRoleForDispatchKind("security-review", "belthazar")).toBe(false);
    expect(isRoleForDispatchKind("verification", "spekkio")).toBe(true);
    expect(isRoleForDispatchKind("verification", "glenn")).toBe(false);
    expect(isRoleForDispatchKind("correction", "belthazar")).toBe(true);
    expect(isRoleForDispatchKind("correction", "spekkio")).toBe(false);
    expect(isRoleForDispatchKind("unknown-kind", "belthazar")).toBe(false);
  });
});
