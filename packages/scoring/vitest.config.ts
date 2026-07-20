import { defineConfig } from "vitest/config";

// Without a package-level config, vitest walks up to the repo root config,
// whose include ("src/**/*.test.ts") misses this package's tests/ directory.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
