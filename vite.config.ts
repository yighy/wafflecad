import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the build works from any sub-path (e.g. GitHub Pages).
  base: "./",
  // OpenCascade and planegcs load their own .wasm files: no pre-bundling.
  optimizeDeps: { exclude: ["replicad-opencascadejs", "@salusoft89/planegcs"] },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
