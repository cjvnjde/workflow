import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { reactX, tseslint } from "@workflow/eslint";
import globals from "globals";

export default defineConfig(
  globalIgnores([
    "dist/**",
    "node_modules/**",
    ".tanstack/**",
    "web/routeTree.gen.ts",
    "coverage/**",
    ".stryker-tmp/**",
    "reports/mutation/**",
    "reports/mutation-smoke/**",
    "test-results/**",
    "playwright-report/**",
    ".vitest/**",
    ".workflow/**",
    ".agents/**",
    ".codex/**",
    ".aws/**",
    "src/legacy/**",
    ".review/**",
  ]),
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports", disallowTypeAnnotations: false },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    files: ["web/**/*.{ts,tsx}"],
    extends: [
      reactHooks.configs.flat.recommended,
      reactX.configs.recommended,
      reactRefresh.configs.vite,
    ],
  },
  {
    files: ["web/routes/**/*.tsx"],
    rules: {
      "react-refresh/only-export-components": ["error", { allowExportNames: ["Route"] }],
    },
  },
  {
    files: ["web/**/*.{ts,tsx}", "src/{contracts,sdk,client}/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                ...["core", "infrastructure", "host", "http", "terminal", "cli"].flatMap(
                  (directory) => [
                    `./${directory}/**`,
                    `../${directory}/**`,
                    `../**/${directory}/**`,
                  ],
                ),
                "node:*",
                "bun",
                "fastify",
                "@temporalio/*",
                "@opentui/*",
                "@earendil-works/*",
              ],
              message: "Browser-safe code may use contracts, the SDK, and the HTTP client only.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                ...["http", "terminal", "cli", "host", "web"].flatMap((directory) => [
                  `./${directory}/**`,
                  `../${directory}/**`,
                  `../**/${directory}/**`,
                ]),
                "react",
                "react-dom",
                "@xyflow/*",
                "fastify",
                "@opentui/*",
              ],
              message:
                "Core owns application behavior; presentation and process adapters depend on core.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/infrastructure/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["core", "http", "terminal", "cli", "host", "web"].flatMap((directory) => [
                `./${directory}/**`,
                `../${directory}/**`,
                `../**/${directory}/**`,
              ]),
              message:
                "Infrastructure supplies operating-system services without depending on application or presentation modules.",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
