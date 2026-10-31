import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import babel from "@rolldown/plugin-babel";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { fileURLToPath } from "node:url";

const apiTarget = process.env.WORKFLOW_API_URL ?? "http://127.0.0.1:4310";

export default defineConfig({
  plugins: [
    tanstackStart({
      srcDirectory: ".",
      client: { entry: "./main.tsx" },
      spa: { enabled: true, prerender: { outputPath: "/index" } },
      router: { quoteStyle: "double", semicolons: true },
      vite: { installDevServerMiddleware: true },
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
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest, request) => {
            // Translate only same-origin dev requests; preserve foreign origins
            // so the backend's cross-origin mutation protection still rejects them.
            if (request.headers.origin === `http://${request.headers.host}`) {
              proxyRequest.setHeader("origin", new URL(apiTarget).origin);
            }
          });
        },
      },
    },
  },
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
});
