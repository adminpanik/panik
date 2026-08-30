/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The only thing an unauthenticated visitor to /admin can see. Signing in mints
 * a Supabase session; every /api/admin/* call then carries it and the server
 * decides, per request, whether that session belongs to the admin. This form is
 * the door, not the lock.
 *
 * It wears the console's own header rather than a wordmark inside the card, so
 * signing in and using the console are visibly the same surface. The card is
 * `Card tone="raised"`: the same white plate, 3px black edge and 6px offset
 * shadow every other box in the product is drawn with.
 */

import { useState } from "react";
import { Button, Card } from "../panik-core/ui";
import { AdminHeader, Field } from "./ui/controls";
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
    <>
      <AdminHeader />
      <main className="mx-auto w-full max-w-sm p-4 py-12 sm:p-8 sm:py-16">
        <Card tone="raised">
          <form onSubmit={submit}>
            <h1 className="label-type text-xs text-text-primary">Sign in</h1>

            <div className="mt-5 flex flex-col gap-4">
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
                label="Password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={!configured || busy}
                required
              />
            </div>

            {!configured && (
              <p className="mt-4 font-sans text-xs text-text-secondary">
                This deployment has no Supabase URL or publishable key, so sign-in cannot run here.
              </p>
            )}
            {error && (
              <p role="alert" className="mt-4 font-sans text-xs text-text-secondary">
                {error}
              </p>
            )}

            {/* No spinner. There is no motion in this system, and a disabled
                button reading "Signing in" already says the same thing. */}
            <Button type="submit" className="mt-6 w-full" disabled={!configured || busy}>
              {busy ? "Signing in" : "Sign in"}
            </Button>
          </form>
        </Card>
      </main>
    </>
  );
}
