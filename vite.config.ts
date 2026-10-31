import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import babel from "@rolldown/plugin-babel";

export default defineConfig({
  plugins: [
    react(),
    babel({
      include: /[/\\]web[/\\].*\.[jt]sx?$/,
      presets: [reactCompilerPreset({ target: "19" })],
    }),
    tailwindcss(),
  ],
  root: "web",
  build: { outDir: "../dist/web", emptyOutDir: true },
  // Keep client modules such as /api.ts in Vite; only API routes go to Fastify.
  server: { port: 5173, proxy: { "/api/": "http://127.0.0.1:4310" } },
});
