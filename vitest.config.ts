import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * Hermetic default battery (CORE_FIX CF-10): the default run never
 * touches the developer's npm cache, OS keychain, or pilot project.
 * Host integrations live in `*.host.test.ts`, excluded by default and
 * run only under `npm run test:host` (CHRONO_HOST_TESTS=1), reported
 * separately. The clean gate (`test:clean`) observes the default run:
 * zero failures, zero skips, zero unhandled errors.
 *
 * Workspace imports resolve to sources (not packed dist), so Core,
 * domain, and persistence edits take effect without a rebuild; the
 * packed binary under test is built explicitly (`npm run build`).
 */
const hostOnly = process.env["CHRONO_HOST_TESTS"] === "1";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    exclude: hostOnly
      ? ["**/node_modules/**", "**/dist/**"]
      : ["**/*.host.test.ts", "**/node_modules/**", "**/dist/**"],
    testEnvironment: "node",
  },
  resolve: {
    alias: {
      "@chrono/domain": resolve(rootDir, "packages/domain/src/index.ts"),
      "@chrono/persistence": resolve(rootDir, "packages/persistence/src/index.ts"),
      "@chrono/core": resolve(rootDir, "packages/core/src/index.ts"),
    },
  },
});
