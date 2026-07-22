import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Dev server proxies API + media to the Go backend (default :8788).
// Addressed as 127.0.0.1 rather than localhost so the proxy can't drift onto a
// different address family than the one the backend bound.
const backend = process.env.STUDIO_BACKEND || "http://127.0.0.1:8788";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5273,
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/media": { target: backend, changeOrigin: true },
      "/health": { target: backend, changeOrigin: true },
    },
  },
});
