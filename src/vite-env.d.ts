/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /**
   * The one address the admin console signs in with. Client-side only as a
   * courtesy message; the enforcing copy is ADMIN_ALLOWED_EMAIL on the server
   * (server/adminIdentity.ts). Keep the two in step.
   */
  readonly VITE_ADMIN_EMAIL?: string;
  /**
   * Optional Base RPC endpoints for the in-browser exit flow. PUBLIC BY DESIGN
   * - these are compiled into the client bundle. Never a URL carrying a secret
   * key. See `panik-core/lib/exit.ts`.
   */
  readonly VITE_BASE_RPC_URL?: string;
  readonly VITE_BASE_SEPOLIA_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
