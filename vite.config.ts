import path from "node:path";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "web",
  build: { outDir: "dist", emptyOutDir: true },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@shared": path.resolve(import.meta.dirname, "shared") } },
  server: {
    fs: { allow: [path.resolve(import.meta.dirname)] },
    // `ws: true` proxies the live-terminal WebSocket upgrade (/api/sessions/:env/:pane/attach) through to
    // the backend in dev; the browser's Origin stays http://localhost:5173 (dev-allowlisted in config.ts).
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true, ws: true } },
  },
});
