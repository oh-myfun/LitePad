// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/**",
      "generated-images/**",
      ".tmp/**",
      "test-data/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // 项目约定：未使用参数以 _ 前缀豁免（CM6 扩展/回调签名强制占位常见）
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // TS 已保证类型安全，允许非空断言（CodeMirror DOM 集成代码大量使用）
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // Node 侧脚本（构建/测试基建）：CommonJS require 合法，未用变量多为平台兼容桩。
    // 必须同时覆盖 .mjs —— 漏掉时 cdp_diag.mjs 会落到 recommended 分支，
    // 因缺 node 全局而报 console/process no-undef（B35 配置缺口）。
    files: ["scripts/**/*.cjs", "scripts/**/*.mjs", "*.config.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
