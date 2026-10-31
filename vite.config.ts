import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [vue(), react(), tailwindcss()],
  root: "web",
  build: { outDir: "../dist/web", emptyOutDir: true },
  // Keep client modules such as /api.ts in Vite; only API routes go to Fastify.
  server: { port: 5173, proxy: { "/api/": "http://127.0.0.1:4310" } },
});
