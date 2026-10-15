import js from "@eslint/js"
import tseslint from "typescript-eslint"

const nodeGlobals = {
  console: "readonly",
  process: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  SharedArrayBuffer: "readonly",
  Atomics: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  fetch: "readonly",
  Response: "readonly",
  Request: "readonly",
  Headers: "readonly",
}

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["plugins/**/*.ts"],
    languageOptions: { globals: nodeGlobals },
  },
  {
    files: ["tests/**/*.{js,mjs}", "tests/**/*.cjs"],
    languageOptions: { globals: nodeGlobals },
    rules: {
      // Test helpers intentionally use dynamic typing and loose fixtures.
      "@typescript-eslint/no-explicit-any": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...nodeGlobals, require: "readonly", module: "writable", exports: "writable", __dirname: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // The pre-2.0 suites are preserved for reference only; they are not maintained
    // and are not part of `npm test`.
    ignores: ["dist/", "node_modules/", "tests/legacy/"],
  },
)
