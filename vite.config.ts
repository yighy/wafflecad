import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  // Relative base so the build works from any sub-path (e.g. GitHub Pages).
  base: "./",
  // The version shown in the menu, and the name of the offline cache (a new version replaces it).
  define: { __APP_VERSION__: JSON.stringify(version) },
  // OpenCascade and planegcs load their own .wasm files: no pre-bundling.
  optimizeDeps: { exclude: ["replicad-opencascadejs", "@salusoft89/planegcs"] },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
