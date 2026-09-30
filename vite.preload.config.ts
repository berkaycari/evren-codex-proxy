import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    outDir: path.join(projectRoot, "dist/desktop/preload"),
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: path.join(projectRoot, "src/desktop/preload/index.ts"),
      formats: ["cjs"],
      fileName: () => "index.cjs",
    },
    rollupOptions: {
      external: ["electron"],
      output: { exports: "named" },
    },
  },
});
