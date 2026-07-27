import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";
import unusedImports from "eslint-plugin-unused-imports";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist", "web/dist", "node_modules", "scripts", "**/*.config.js", "**/*.config.ts", ".claude/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "import-x": importX, "unused-imports": unusedImports },
    rules: {
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "import-x/order": ["error", {
        "newlines-between": "always",
        alphabetize: { order: "asc", caseInsensitive: true },
        groups: [["builtin", "external"], ["internal", "parent", "sibling", "index"]],
      }],
      "import-x/no-duplicates": "error",
      "import-x/no-default-export": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: "error",
    },
  },
  { files: ["server/**", "shared/**", "mcp/**", "config.ts", "environments.ts"], languageOptions: { globals: globals.node } },
  { files: ["server/index.ts"], rules: { "no-console": "off" } },
  {
    // mcp/digest.ts value-imports this file with a RELATIVE path (mcp/ launches via tsx from an
    // arbitrary cwd, which cannot resolve the `@shared` alias — only vitest/tsc know about it). That
    // is safe today only because this file's sole `@shared` import is `import type` — erased before
    // runtime. If a VALUE import of `@shared/*` ever lands here, the MCP server dies at startup with
    // ERR_MODULE_NOT_FOUND while `tsc`, eslint, and the whole vitest suite stay green (vitest declares
    // its own `@shared` alias; nothing here boots the MCP entry point under tsx). Do not delete this
    // rule as noise — it is the only thing that would catch that regression before a user hits it.
    files: ["server/session-binding.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        patterns: [{
          group: ["@shared/*"],
          allowTypeImports: true,
          message: "server/session-binding.ts is value-imported by mcp/ via a relative path — a " +
            "value import of @shared/* here would crash the MCP server under tsx. Use `import type`, " +
            "or a relative import if a value is genuinely needed.",
        }],
      }],
    },
  },
  {
    files: ["web/**"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ["test/**", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/consistent-type-assertions": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/require-await": "off",
      "no-console": "off",
    },
  },
  prettier,
);
