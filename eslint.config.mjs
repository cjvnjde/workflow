import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import vue from "eslint-plugin-vue";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "dist/**",
    "node_modules/**",
    "coverage/**",
    ".stryker-tmp/**",
    "reports/mutation/**",
    "reports/mutation-smoke/**",
    "test-results/**",
    "playwright-report/**",
    ".workflow/**",
    ".agents/**",
    ".codex/**",
    ".aws/**",
    "src/legacy/**",
  ]),
  {
    files: ["**/*.{js,mjs,ts,tsx,vue}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      vue.configs["flat/recommended"],
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { parser: tseslint.parser, extraFileExtensions: [".vue"] },
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
      // Optional TypeScript props intentionally remain undefined unless the component supplies a default.
      "vue/require-default-prop": "off",
      "vue/multi-word-component-names": [
        "error",
        { ignores: ["App", "Icon", "Field", "Capabilities"] },
      ],
    },
  },
  {
    files: ["web/**/*.{ts,tsx,vue}", "src/{contracts,sdk,client}/**/*.ts"],
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
                "vue",
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
