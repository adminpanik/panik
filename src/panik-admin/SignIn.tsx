/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The only thing an unauthenticated visitor to /admin can see. Signing in mints
 * a Supabase session; every /api/admin/* call then carries it and the server
 * decides, per request, whether that session belongs to the admin. This form is
 * the door, not the lock.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "../panik-core/ui";
import { Field } from "./ui/controls";
import { isConfigured, signIn, type Session } from "./lib/supabaseAuth";

export function SignIn({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const configured = isConfigured();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const result = await signIn(email, password);
    setBusy(false);
    if (result.session) onSignedIn(result.session);
    else setError(result.error ?? "Sign-in failed.");
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-5 py-12">
      <form onSubmit={submit} className="rounded-md border border-border-subtle bg-surface-raised/50 p-6">
        <div className="mb-6 flex items-center gap-2.5">
          <img src="/panik-logo.png" alt="" width={28} height={28} className="rounded-sm object-contain" />
          <h1 className="text-lg font-sans font-bold text-text-primary">PANIK admin</h1>
        </div>

        <Field
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={!configured || busy}
          required
        />
        <Field
          className="mt-4"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={!configured || busy}
          required
        />

        {!configured && (
          <p className="mt-4 text-xs font-sans text-text-secondary">
            This deployment has no Supabase URL or publishable key, so sign-in cannot run here.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-4 text-xs font-sans text-text-secondary">
            {error}
          </p>
        )}

        <Button type="submit" className="mt-6 w-full justify-center" disabled={!configured || busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          {busy ? "Signing in" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
