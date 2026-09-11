/**
 * Release-version single-source test [Remediation §6].
 * Root package.json version is authoritative; all workspace packages
 * and CHRONO_VERSION must agree exactly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CHRONO_VERSION } from "./version.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

function readVersion(rel: string): string {
  const pkg = JSON.parse(readFileSync(join(root, rel), "utf8")) as { version: string };
  return pkg.version;
}

describe("Release version single source", () => {
  it("all package versions derive from the root version", () => {
    const rootVersion = readVersion("package.json");
    expect(CHRONO_VERSION).toBe(rootVersion);
    for (const pkg of ["packages/domain", "packages/persistence", "packages/core", "packages/cli"]) {
      expect(readVersion(join(pkg, "package.json"))).toBe(rootVersion);
    }
  });
});
