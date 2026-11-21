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
    // 文件间复用同一个 worker 环境：147 个文件各自起一次 jsdom 是墙钟的大头
    // （实测 environment 汇总近 2000s）。复用后由 tests/setup.ts 在每个文件开头
    // 还原模块注册表、DOM/存储、全局监听与原型量测桩，等价于「换一间干净房间」。
    // 改动前后全量墙钟降到约四成；若新增的测试依赖文件级天然隔离（直接改
    // globalThis / 原型且不还原），必须把清理逻辑补进 setup.ts，而不是关掉这一项。
    isolate: false,
    // 走真实 bootstrap 的集成用例（jsdom 内 import ../src/main）本身就要 3-4s，
    // 机器负载高时会压过默认 5s → 偶发失败并拦住推送。给足余量，真挂死仍会失败。
    testTimeout: 20000,
    // 同上：bootstrap 的 beforeAll 要 import 整份 main，并发高时能压过默认 10s
    // （实测乱序跑时偶发 hook 超时）。真挂死仍会被有限超时拦下。
    hookTimeout: 30000,
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
    // 构建只覆盖、不清空（用户 2026-11-15：每次编译都把旧产物删进回收站，堆得太多）。
    // 默认的 emptyOutDir 会在 Node 里递归删 dist，本机安全删除把每个文件都搬进回收站
    // （一次四百多个）。关掉清空后，产物名不能带内容哈希 —— 否则新名字永远写不到旧路径上、
    // 旧文件只能靠删；改成固定名原地覆盖。模块增删改名时会留下个别无人引用的旧文件，
    // 不再被打包路径需要，也不影响运行。
    emptyOutDir: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
