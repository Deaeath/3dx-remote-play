import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

// The phone page. Plain and small: it has to load fast on mobile data.
export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    target: "safari15",
    sourcemap: false,
  },
});
