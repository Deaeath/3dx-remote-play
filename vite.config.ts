import { defineConfig } from "vitest/config";

// The app's window. The phone page has its own config in phone/.
export default defineConfig({
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1430, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "chrome110" },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
