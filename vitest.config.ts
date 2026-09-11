import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    testEnvironment: "node",
  },
  resolve: {
    alias: {
      "@chrono/domain": resolve(__dirname, "packages/domain/src/index.ts"),
      "@chrono/persistence": resolve(__dirname, "packages/persistence/src/index.ts"),
      "@chrono/core": resolve(__dirname, "packages/core/src/index.ts"),
    },
  },
});
