import { defineConfig } from "vitest/config";

// Standalone from vite.config.ts on purpose: these are pure-logic unit tests, so
// we skip the app's html-rewrite / tailwind / react plugins entirely.
//
// The glob covers server/ and api/ as well as src/: the request middleware
// (rate limiter, client-IP resolution, admin auth) is the security boundary and
// a `server/*.test.ts` used to be silently skipped by a src-only glob.
export default defineConfig({
  test: {
    environment: "node",
    include: ["{src,server,api}/**/*.test.ts"],
  },
});
