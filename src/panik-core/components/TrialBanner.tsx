/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Trial-awareness pill for the core app. When /app is opened with a per-user
 * link (/app?trial=PANIK-XXXXXX), this validates the token via /api/try/access
 * - which STARTS the per-user clock on the first open - and shows the remaining
 * time (or an expired/invalid state with a path back to /try).
 *
 * Non-blocking by design: the demo app stays usable; this only surfaces trial
 * status. (Hard-locking /app for non-trial visitors is a deliberate follow-up.)
 */

import { useEffect, useState } from "react";
import { Clock, AlertCircle, X } from "lucide-react";
import { formatRemaining, parseCode } from "../../panik-try/lib/trialLogic";
import { LAYER } from "../ui";

type State =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "active"; expiresAt: string | null }
  | { kind: "expired" }
  | { kind: "invalid" };

function tokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  // Reuse the same query parser; the param here is `trial`, not `code`.
  const raw = new URLSearchParams(window.location.search).get("trial");
  return parseCode(raw ? `code=${raw}` : "");
}

export function TrialBanner() {
  const [state, setState] = useState<State>({ kind: "none" });
  const [dismissed, setDismissed] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    const token = tokenFromUrl();
    if (!token) return;
    setState({ kind: "loading" });
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/try/access", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const body = (await res.json().catch(() => ({}))) as { outcome?: string; expiresAt?: string | null };
        if (cancelled) return;
        if (body.outcome === "active") setState({ kind: "active", expiresAt: body.expiresAt ?? null });
        else if (body.outcome === "expired") setState({ kind: "expired" });
        else setState({ kind: "invalid" });
      } catch {
        if (!cancelled) setState({ kind: "invalid" });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Re-render every 30s so the countdown stays fresh; flip to expired when the
  // clock runs out while the tab is open.
  useEffect(() => {
    if (state.kind !== "active") return;
    const id = setInterval(() => {
      if (state.expiresAt && new Date(state.expiresAt).getTime() - Date.now() <= 0) {
        setState({ kind: "expired" });
      } else {
        tick((n) => n + 1);
      }
    }, 30_000);
    return () => clearInterval(id);
  }, [state]);

  if (dismissed || state.kind === "none" || state.kind === "loading") return null;

  if (state.kind === "active") {
    const remainingMs = state.expiresAt ? new Date(state.expiresAt).getTime() - Date.now() : 0;
    return (
      <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 ${LAYER.banner} panik-glass rounded-full pl-4 pr-3 py-2 flex items-center gap-2.5 shadow-lg`}>
        <Clock className="w-4 h-4 text-text-primary" />
        <span className="text-xs text-text-secondary">
          Trial active
          {state.expiresAt && <span className="text-text-primary font-sans tabular-nums"> · {formatRemaining(remainingMs)} left</span>}
        </span>
        <button onClick={() => setDismissed(true)} className="text-text-muted hover:text-text-secondary transition-colors" aria-label="Dismiss">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  // expired | invalid
  return (
    <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 ${LAYER.banner} panik-glass rounded-full pl-4 pr-3 py-2 flex items-center gap-2.5 shadow-lg`}>
      <AlertCircle className="w-4 h-4 text-risk-critical" />
      <span className="text-xs text-text-secondary">
        {state.kind === "expired" ? "Your trial has expired." : "Trial link isn't valid."}
      </span>
      <a href="/try" className="text-xs font-medium text-text-primary hover:text-text-primary transition-colors">Get access</a>
      <button onClick={() => setDismissed(true)} className="text-text-muted hover:text-text-secondary transition-colors" aria-label="Dismiss">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
