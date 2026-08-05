import { defineConfig } from "vitest/config";

// Standalone from vite.config.ts on purpose: these are pure-logic unit tests, so
// we skip the app's html-rewrite / tailwind / react plugins entirely.
export default defineConfig({
  test: {
    environment: "node",
    // server/ is in here because walletAuth is an auth boundary: it decides
    // who may redirect a wallet's liquidation alerts.
    include: ["src/**/*.test.ts", "server/**/*.test.ts"],
  },
});
