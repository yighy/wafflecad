import { readFileSync, statSync } from "node:fs";
import { defineConfig } from "vite";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
// The geometry kernel's real size: its download is shown as a share of it (the server sends it
// compressed, so the size it announces is smaller than what arrives).
const kernelBytes = statSync(new URL("./node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)).size;

export default defineConfig({
  // Relative base so the build works from any sub-path (e.g. GitHub Pages).
  base: "./",
  // The version shown in the menu, and the name of the offline cache (a new version replaces it).
  define: { __APP_VERSION__: JSON.stringify(version), __KERNEL_BYTES__: String(kernelBytes) },
  // OpenCascade and planegcs load their own .wasm files: no pre-bundling.
  optimizeDeps: { exclude: ["replicad-opencascadejs", "@salusoft89/planegcs"] },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
