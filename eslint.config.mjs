// ESLint 9 flat configuration [Remediation §1].
// Replaces the invalid eslint.config.json (legacy eslintrc format, never loaded by ESLint 9).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Historical intent of the previous config: allow explicit any where the
      // SQLite row-mapping boundary requires it; unused vars remain errors.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
