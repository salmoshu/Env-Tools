import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// 开发服务器下放宽 CSP：HMR 需要 ws:// 连接，react-refresh 需要内联脚本；
// apply: "serve" 保证生产构建（dist/）不受影响，仍是原来的严格 CSP
const devCsp = () => ({
  name: "dev-csp",
  apply: "serve",
  transformIndexHtml(html) {
    return html.replace(
      "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
      "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://localhost:*",
    );
  },
});

export default defineConfig({
  plugins: [react(), devCsp()],
  base: "./",
  // 端口写死且严格占用：scripts/dev.mjs 要把确定地址传给 Electron。
  // 不用 vite 默认的 5173：其他 vite 项目（如 Nav-Tools）的 dev server 会撞车
  server: {
    port: 5273,
    strictPort: true,
    // 不看 Rust 构建产物：cargo 链接期间 exe 被锁，fs.watch 会 EBUSY 崩溃
    watch: { ignored: ["**/backend-rs/target/**"] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: { entryFileNames: "assets/app.js", assetFileNames: "assets/[name][extname]" },
    },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
