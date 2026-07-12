import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies API + media to the Go backend (default :8787).
const backend = process.env.STUDIO_BACKEND || "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/media": { target: backend, changeOrigin: true },
      "/health": { target: backend, changeOrigin: true },
    },
  },
});
