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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
