import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_TARGET = "http://127.0.0.1:4747";
const PROXIED_PATHS = ["/mcp", "/api", "/events"];

// One proxy entry towards the API-only studio: the bearer token is added here, Host and Origin pass through untouched.
function proxyEntry() {
  return {
    target: API_TARGET,
    changeOrigin: false,
    headers: { Authorization: `Bearer ${process.env.NIGHTQUEUE_STUDIO_TOKEN ?? ""}` },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1024 },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(PROXIED_PATHS.map((path) => [path, proxyEntry()])),
  },
});
