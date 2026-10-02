// @ts-check
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * The rule family this project most needed is `react-hooks`: five
 * `// eslint-disable-next-line react-hooks/exhaustive-deps` comments were sitting in the code with
 * no ESLint in the project at all, so nothing they suppressed had ever run.
 *
 * Type-aware linting is deliberately off: `tsc -b` already type-checks everything (including
 * `tests/` and `scripts/`), and the type-aware rules would double the run for little extra.
 */
export default tseslint.config(
  { ignores: ["dist", ".cache", ".claude", "src-tauri/target", "src/data", "src/qmk/keycodes.generated.ts", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // `tsc --noUnusedLocals` already reports these, with the same message and better placement.
      "@typescript-eslint/no-unused-vars": "off",
      // The empty catch is a deliberate idiom here ("private window or tests: just forget it"),
      // and every one of them carries a comment saying so.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Node-side code: scripts and the test bundles.
    files: ["scripts/**/*.ts", "tests/**/*.ts", "*.js", "*.ts"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
  },
);
