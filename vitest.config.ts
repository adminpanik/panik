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
    // server/ is in here because it holds the auth boundaries: walletAuth
    // decides who may redirect a wallet's liquidation alerts, and adminAuth
    // gates the console. api/ carries the same middleware on the Vercel side.
    // dev/ is in here too: the dev:mock fixtures assert scoring invariants
    // (band vs total, the degraded-price contract) that would otherwise drift
    // unnoticed into a demo dashboard everyone trusts.
    include: ["{src,server,api,dev}/**/*.test.ts"],
  },
});
