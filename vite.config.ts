import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  root: "web",
  build: { outDir: "../dist/web", emptyOutDir: true },
  // Keep client modules such as /api.ts in Vite; only API routes go to Fastify.
  server: { port: 5173, proxy: { "/api/": "http://127.0.0.1:4310" } },
});
