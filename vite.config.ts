import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

// 诊断用：打印每个进入 dev server 的 HTTP 请求
function requestLogger(): Plugin {
  return {
    name: "litepad-request-logger",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        console.log(`[vite-req] ${new Date().toISOString()} ${req.method} ${req.url}`);
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [requestLogger()],
  // Tauri 使用 rust 后端，控制台输出需要保留
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // 锁定 IPv4：Node 17+ 对 localhost 只绑第一个解析结果（本机解析为 ::1），
    // 会导致 WebView2/IPv4 侧无法访问 dev server
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // 避免 src-tauri 下的变更触发前端热重载
      ignored: ["**/src-tauri/**"],
    },
  },
  // 让 Vite 能读取 Tauri 注入的平台变量
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  test: {
    // jsdom 与 WebView2(Chromium) 的环境差距统一在 tests/setup.ts 打桩；
    // 缺桩会让 CM6 的 mousedown 链路抛未捕获异常 → vitest 非 0 退出、pre-push 误拦推送。
    setupFiles: ["tests/setup.ts"],
    // 走真实 bootstrap 的集成用例（jsdom 内 import ../src/main）本身就要 3-4s，
    // 机器负载高时会压过默认 5s → 偶发失败并拦住推送。给足余量，真挂死仍会失败。
    testTimeout: 20000,
    // ⚠️ 排查用的临时取证用例一律落在 `.tmp/probe/`（见 pitfalls 那条规矩）。这些文件
    //    名字照旧是 `*.test.ts`，不排除就会被默认收集规则抓进来 ⇒ 全量里随手混两只
    //    永远红的文件，还会把真正的失败淹没掉（B254 那轮就栽在这：3 个红文件里
    //    有 2 个是 `.tmp/` 里的旧取证桩，看 diff 时差点当成回归）。
    exclude: ["**/node_modules/**", "**/dist/**", "**/.tmp/**"],
  },
  build: {
    // WebView2 基于 Chromium
    target: "chrome105",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
