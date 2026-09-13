import { defineConfig, type Plugin } from "vite";

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
  build: {
    // WebView2 基于 Chromium
    target: "chrome105",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
