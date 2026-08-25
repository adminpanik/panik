/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Set a new password on the signed-in admin account.
 *
 * The account's first password was generated elsewhere and handed over through
 * a chat transcript, which means it is burned: good for one sign-in, then
 * replaced by something only the operator has seen. That replacement happens
 * here, in the browser, with the operator's own session as the authorization.
 *
 * There is no "current password" field. Supabase's update-user call does not
 * verify one, and asking for a secret we then throw away is theatre that
 * teaches the operator their input matters when it does not. What DOES guard
 * the operation is holding a live session for the account, which is the same
 * bar a password reset should clear.
 */

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { Button, Card } from "../panik-core/ui";
import { Field } from "./ui/controls";
import {
  MIN_PASSWORD_LENGTH,
  requestReauthentication,
  updatePassword,
  type Session,
} from "./lib/supabaseAuth";

export function ChangePassword({
  session,
  onChanged,
  onDismiss,
  /** True when the account is still on the credential it was handed. */
  firstRun = false,
}: {
  session: Session;
  onChanged: (session: Session) => void;
  onDismiss?: () => void;
  firstRun?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [nonce, setNonce] = useState("");
  const [needsNonce, setNeedsNonce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length >= MIN_PASSWORD_LENGTH && confirm === password;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError("");
    const result = await updatePassword(session, password, needsNonce ? nonce.trim() : undefined);
    if (result.ok) {
      setBusy(false);
      setPassword("");
      setConfirm("");
      setNonce("");
      setNeedsNonce(false);
      setDone(true);
      onChanged(result.session);
      return;
    }
    if (result.reason === "reauthenticate" && !needsNonce) {
      // Ask for the code in the same breath as saying we need one, so the
      // operator is not told to wait for an email that was never requested.
      await requestReauthentication(session);
      setNeedsNonce(true);
    }
    setBusy(false);
    setError(result.message);
  }

  if (done) {
    return (
      <Card tone="panel" className="mx-auto max-w-md">
        <h1 className="flex items-center gap-2 text-lg font-sans font-bold text-text-primary">
          <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> Password changed
        </h1>
        <p className="mt-2 text-sm font-sans text-text-secondary">
          Use the new password next time you sign in. You are still signed in here, so nothing else
          needs doing.
        </p>
        {onDismiss && (
          <Button className="mt-5" onClick={onDismiss}>
            Continue to admin
          </Button>
        )}
      </Card>
    );
  }

  return (
    <Card tone="panel" className="mx-auto max-w-md">
      <form onSubmit={submit}>
        <h1 className="text-lg font-sans font-bold text-text-primary">
          {firstRun ? "Set your own password" : "Change password"}
        </h1>
        <p className="mt-2 text-sm font-sans text-text-secondary">
          {firstRun
            ? `This account is still on the password it was set up with, which was sent to you over chat. Replace it with something only you have seen. At least ${MIN_PASSWORD_LENGTH} characters.`
            : `At least ${MIN_PASSWORD_LENGTH} characters. The new password is sent straight to Supabase and is not stored anywhere in this page.`}
        </p>

        <Field
          className="mt-5"
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={tooShort ? `${MIN_PASSWORD_LENGTH - password.length} more characters needed.` : undefined}
          disabled={busy}
          required
        />
        <Field
          className="mt-4"
          label="New password again"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          hint={mismatch ? "The two do not match yet." : undefined}
          disabled={busy}
          required
        />
        {needsNonce && (
          <Field
            className="mt-4"
            label="Code from your email"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={nonce}
            onChange={(e) => setNonce(e.target.value)}
            hint="This project confirms a password change by email."
            disabled={busy}
            required
          />
        )}

        {error && (
          <p role="alert" className="mt-4 text-xs font-sans text-text-secondary">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy || !ready}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {busy ? "Saving" : "Save new password"}
          </Button>
          {onDismiss && (
            <Button type="button" variant="ghost" onClick={onDismiss}>
              {firstRun ? "Not now" : "Cancel"}
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
