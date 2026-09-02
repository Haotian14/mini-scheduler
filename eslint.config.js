import js from "@eslint/js";
import globals from "globals";
import pluginVue from "eslint-plugin-vue";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * Flat config for the whole workspace: Node services in plain JavaScript, the
 * dashboard in TypeScript + Vue. Formatting rules are left to Prettier.
 */
export default [
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo"] },

  js.configs.recommended,

  {
    name: "node-services",
    files: ["mini-scheduler/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-console": "off",
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
    },
  },

  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["mini-scheduler-ui/**/*.ts", "mini-scheduler-ui/**/*.vue"],
  })),

  ...pluginVue.configs["flat/recommended"].map((config) => ({
    ...config,
    files: ["mini-scheduler-ui/**/*.vue"],
  })),

  {
    name: "dashboard",
    files: ["mini-scheduler-ui/**/*.{ts,vue}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: { parser: tseslint.parser },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "vue/multi-word-component-names": "off",
    },
  },

  prettier,
];
