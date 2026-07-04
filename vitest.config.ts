import { defineConfig } from "vitest/config";

// Standalone from vite.config.ts on purpose: these are pure-logic unit tests, so
// we skip the app's html-rewrite / tailwind / react plugins entirely.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
