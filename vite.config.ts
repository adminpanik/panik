import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {mockApi} from './dev/mockApi';

export default defineConfig(({mode}) => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      // `npm run dev:mock` (vite --mode mock) only — returns [] otherwise, and
      // the plugin itself is apply:'serve', so it cannot reach a build. Must be
      // registered here rather than after the proxy config: configureServer
      // hooks run before Vite installs its own middlewares, which is how the
      // fixture handler gets ahead of the /api -> :8787 proxy below.
      ...mockApi(mode),
      {
        name: 'html-rewrite',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = req.url ? req.url.split('?')[0] : '';
            if (url === '/founding' || url === '/early-access') {
              req.url = '/founding.html' + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
            } else if (url === '/app') {
              req.url = '/app.html' + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
            } else if (url === '/try') {
              req.url = '/try.html' + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
            } else if (url === '/admin' || url === '/admin-neithan') {
              req.url = '/admin.html' + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
            }
            next();
          });
        }
      }
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR can be disabled via the DISABLE_HMR env var.
      // Do not modify — file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // Local scoring API (npm run dev:api) — keys stay server-side; the
      // browser only sees score JSON. 127.0.0.1 (not localhost): Node 17+
      // resolves localhost to ::1 first on Windows → ECONNREFUSED.
      //
      // PANIK_API_PORT is the SAME variable the API server reads for its own
      // port (scripts/api-server.ts), so a second stack — a mainnet one and a
      // PANIK_SCORING_CHAIN=testnet one, say — comes up on one variable
      // instead of an edit to this file that someone then commits.
      // PANIK_API_TARGET overrides the whole URL when the second API is not on
      // this host at all.
      proxy: {
        '/api':
          process.env.PANIK_API_TARGET ??
          `http://127.0.0.1:${process.env.PANIK_API_PORT ?? 8787}`,
      },
    },
    build: {
      rollupOptions: {
        input: {
          // "panik landing page" — the public marketing site
          landing: path.resolve(__dirname, 'index.html'),
          // "panik core" — the isolated product app (separate bundle / surface)
          app: path.resolve(__dirname, 'app.html'),
          // "founding user" — hidden escrow page (direct URL only, not linked from nav)
          founding: path.resolve(__dirname, 'founding.html'),
          // "try" - 2-in-1 business card + trial-code redemption (direct URL / QR)
          try: path.resolve(__dirname, 'try.html'),
          // "admin" - hidden, secret-gated campaign console (direct URL only)
          admin: path.resolve(__dirname, 'admin.html'),
        },
        // No manualChunks: the previous hand-rolled split matched any path
        // containing "react" (e.g. @tanstack/react-query) into vendor-react,
        // while vendor depended on it back → a CIRCULAR chunk (vendor ->
        // vendor-react -> vendor). At runtime React was undefined when the
        // vendor chunk ran createContext → uncaught TypeError → BLANK page on
        // every entry. Vite's automatic chunking splits these multi-entry
        // bundles correctly without the cycle.
      },
    },
  };
});
