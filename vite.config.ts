import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import babel from "@rolldown/plugin-babel";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [
    tanstackStart({
      srcDirectory: ".",
      client: { entry: "./main.tsx" },
      spa: { enabled: true, prerender: { outputPath: "/index" } },
      router: { quoteStyle: "double", semicolons: true },
    }),
    react(),
    babel({
      include: /[/\\]web[/\\].*\.[jt]sx?$/,
      presets: [reactCompilerPreset({ target: "19" })],
    }),
    tailwindcss(),
  ],
  root: "web",
  resolve: { alias: { "@": fileURLToPath(new URL("./web", import.meta.url)) } },
  build: { outDir: fileURLToPath(new URL("./dist", import.meta.url)), emptyOutDir: true },
  environments: {
    client: {
      build: { outDir: fileURLToPath(new URL("./dist/web", import.meta.url)), emptyOutDir: true },
    },
    ssr: {
      build: {
        outDir: fileURLToPath(new URL("./.tanstack/start-server", import.meta.url)),
        emptyOutDir: true,
      },
    },
  },
  // Keep client modules such as /api.ts in Vite; only API routes go to Fastify.
  server: { port: 5173, proxy: { "/api/": "http://127.0.0.1:4310" } },
});
