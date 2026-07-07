/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * /admin - hidden, secret-gated console for campaign trial cards ("Neithan").
 * Create a campaign (duration + max users), watch live status, download the QR
 * for printing, and expire a code early. All calls carry the X-Admin-Key header;
 * the secret never leaves sessionStorage. See server/adminCampaigns.ts.
 */

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { Loader2, Plus, RefreshCw, Ban, Download, Copy, Check, QrCode, Lock, Users, Mail } from "lucide-react";
import {
  clearStoredKey,
  createCampaign,
  expireCampaign,
  getStoredKey,
  listCampaigns,
  listGrants,
  setStoredKey,
  type Campaign,
  type CreateInput,
  type TrialGrant,
} from "./lib/adminApi";
import { evaluateCampaign, formatRemaining, type CampaignStatus } from "../panik-try/lib/trialLogic";

const STATUS_BADGE: Record<CampaignStatus, string> = {
  active: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
  exhausted: "bg-amber-500/10 text-amber-400 border-amber-500/25",
  expired: "bg-red-500/10 text-red-400 border-red-500/25",
  disabled: "bg-white/10 text-white/40 border-white/20",
};

function tryUrl(code: string): string {
  return `${window.location.origin}/try?code=${code}`;
}

// ── Key gate ────────────────────────────────────────────────────────────────
function KeyGate({ onUnlock }: { onUnlock: (key: string) => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!key.trim()) return;
    setBusy(true);
    setError("");
    const res = await listCampaigns(key.trim());
    setBusy(false);
    if (res.ok) {
      setStoredKey(key.trim());
      onUnlock(key.trim());
    } else if (res.status === 401) {
      setError("That key was rejected.");
    } else if (res.status === 503) {
      setError("Admin is not configured on the server (ADMIN_ACCESS_KEY).");
    } else {
      setError(res.error ?? "Could not reach the server.");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="panik-glass rounded-2xl p-7 w-full max-w-sm">
        <div className="flex items-center gap-2 mb-5">
          <Lock className="w-4 h-4 text-orange-400" />
          <h1 className="font-display text-lg font-bold text-white">PANIK admin</h1>
        </div>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Admin access key"
          className="w-full rounded-lg border border-white/12 bg-black/30 px-3 py-2.5 mb-3 font-mono text-sm text-white placeholder:text-white/25 outline-none focus:border-orange-500/40 transition-colors"
        />
        {error && <p className="text-xs text-red-400/90 mb-3">{error}</p>}
        <button
          onClick={submit}
          disabled={busy}
          className="flex items-center justify-center gap-2 w-full rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 px-5 py-3 font-semibold text-white shadow-lg shadow-orange-500/20 hover:shadow-orange-500/40 transition-all disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Unlock"}
        </button>
      </div>
    </div>
  );
}

// ── QR block (generated client-side, printable) ─────────────────────────────
function QrBlock({ code }: { code: string }) {
  const [dataUrl, setDataUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const url = tryUrl(code);

  useEffect(() => {
    QRCode.toDataURL(url, { width: 320, margin: 2, color: { dark: "#0A0A0B", light: "#FFFFFF" } })
      .then(setDataUrl)
      .catch(() => setDataUrl(""));
  }, [url]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-4 flex flex-col sm:flex-row items-center gap-4">
      {dataUrl ? (
        <img src={dataUrl} alt={`QR for ${code}`} className="w-32 h-32 rounded-lg bg-white p-1 shrink-0" />
      ) : (
        <div className="w-32 h-32 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
          <Loader2 className="w-5 h-5 animate-spin text-white/30" />
        </div>
      )}
      <div className="flex-1 min-w-0 w-full">
        <p className="text-[11px] font-mono uppercase tracking-widest text-white/30 mb-1">Print URL</p>
        <p className="font-mono text-xs text-white/70 break-all mb-3">{url}</p>
        <div className="flex flex-wrap gap-2">
          <a
            href={dataUrl || "#"}
            download={`${code}.png`}
            className={`flex items-center gap-1.5 rounded-lg border border-white/12 px-3 py-1.5 text-xs text-white/80 hover:bg-white/[0.06] transition-colors ${dataUrl ? "" : "pointer-events-none opacity-50"}`}
          >
            <Download className="w-3.5 h-3.5" /> QR PNG
          </a>
          <button
            onClick={copy}
            className="flex items-center gap-1.5 rounded-lg border border-white/12 px-3 py-1.5 text-xs text-white/80 hover:bg-white/[0.06] transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-orange-400" /> : <Copy className="w-3.5 h-3.5" />} URL
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Create form ─────────────────────────────────────────────────────────────
function CreateForm({ apiKey, onCreated }: { apiKey: string; onCreated: (c: Campaign) => void }) {
  const [label, setLabel] = useState("");
  const [trialDays, setTrialDays] = useState("3");
  const [maxRedemptions, setMaxRedemptions] = useState("20");
  const [claimWindowDays, setClaimWindowDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    const input: CreateInput = {
      label: label.trim() || undefined,
      trialDays: Number(trialDays),
      maxRedemptions: Number(maxRedemptions),
      claimWindowDays: claimWindowDays.trim() ? Number(claimWindowDays) : undefined,
    };
    const res = await createCampaign(apiKey, input);
    setBusy(false);
    if (res.ok && res.data) {
      onCreated(res.data.campaign);
      setLabel("");
    } else {
      setError(res.error ?? "Create failed.");
    }
  }

  const field = "w-full rounded-lg border border-white/12 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/25 outline-none focus:border-orange-500/40 transition-colors";

  return (
    <div className="panik-glass rounded-2xl p-6 mb-8">
      <h2 className="font-display text-base font-semibold text-white/90 mb-4 flex items-center gap-2">
        <Plus className="w-4 h-4 text-orange-400" /> New campaign
      </h2>
      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <div className="sm:col-span-2">
          <label className="block text-xs text-white/40 mb-1">Label (internal note)</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. ETHDenver booth cards" className={field} />
        </div>
        <div>
          <label className="block text-xs text-white/40 mb-1">Trial duration (days per user)</label>
          <input value={trialDays} onChange={(e) => setTrialDays(e.target.value)} type="number" min="1" className={field} />
        </div>
        <div>
          <label className="block text-xs text-white/40 mb-1">Max redemptions (users)</label>
          <input value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value)} type="number" min="1" className={field} />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs text-white/40 mb-1">Claim window (days, optional - deadline to redeem the card)</label>
          <input value={claimWindowDays} onChange={(e) => setClaimWindowDays(e.target.value)} type="number" min="1" placeholder="Leave blank for no deadline" className={field} />
        </div>
      </div>
      {error && <p className="text-xs text-red-400/90 mb-3">{error}</p>}
      <button
        onClick={submit}
        disabled={busy}
        className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 px-5 py-2.5 font-semibold text-white shadow-lg shadow-orange-500/20 hover:shadow-orange-500/40 transition-all disabled:opacity-60"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create campaign"}
      </button>
    </div>
  );
}

// ── Campaign row ────────────────────────────────────────────────────────────
function CampaignRow({ c, apiKey, onChange }: { c: Campaign; apiKey: string; onChange: (c: Campaign) => void }) {
  const [showQr, setShowQr] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = evaluateCampaign(c);
  const claimRemaining = c.claim_window_expires_at
    ? formatRemaining(new Date(c.claim_window_expires_at).getTime() - Date.now())
    : "no deadline";

  async function expire() {
    if (!confirm(`Expire ${c.campaign_code} now? Existing trials keep working; no new redemptions.`)) return;
    setBusy(true);
    const res = await expireCampaign(apiKey, c.id);
    setBusy(false);
    if (res.ok && res.data) onChange(res.data.campaign);
  }

  return (
    <div className="panik-glass rounded-xl p-4 mb-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-sm text-white/90">{c.campaign_code}</span>
        <span className={`text-[11px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full border ${STATUS_BADGE[status]}`}>
          {status}
        </span>
        {c.label && <span className="text-xs text-white/40 truncate">{c.label}</span>}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setShowQr((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs text-white/80 hover:bg-white/[0.06] transition-colors"
          >
            <QrCode className="w-3.5 h-3.5" /> QR
          </button>
          {c.is_active && (
            <button
              onClick={expire}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-red-500/25 text-red-400/90 px-2.5 py-1.5 text-xs hover:bg-red-500/10 transition-colors disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />} Expire
            </button>
          )}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-6 gap-y-1 text-xs text-white/45">
        <span>Used <span className="text-white/80 font-mono">{c.redemption_count}/{c.max_redemptions}</span></span>
        <span>Trial <span className="text-white/80 font-mono">{c.trial_duration_hours}h</span></span>
        <span>Claim window <span className="text-white/80 font-mono">{claimRemaining}</span></span>
        <span>Created <span className="text-white/80 font-mono">{new Date(c.created_at).toLocaleDateString()}</span></span>
      </div>
      {showQr && <QrBlock code={c.campaign_code} />}
    </div>
  );
}

// ── Redeemed users (the "how many + who" roster) ────────────────────────────
// One grant row = one real user. The header count IS the user count; the list
// is the captured email contact list, copyable for import into a mailer.
function RedeemedUsers({ apiKey }: { apiKey: string }) {
  const [grants, setGrants] = useState<TrialGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await listGrants(apiKey);
    setLoading(false);
    if (res.ok && res.data) {
      setGrants(res.data.grants);
      setError("");
    } else {
      setError(res.error ?? "Could not load users.");
    }
  }, [apiKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const emails = grants.map((g) => g.email).filter((e): e is string => Boolean(e));

  async function copyEmails() {
    if (emails.length === 0) return;
    try {
      await navigator.clipboard.writeText(emails.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }

  return (
    <div className="panik-glass rounded-2xl p-6 mb-8">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <h2 className="font-display text-base font-semibold text-white/90 flex items-center gap-2">
          <Users className="w-4 h-4 text-orange-400" /> Redeemed users
        </h2>
        <span className="font-mono text-sm text-orange-300/90 rounded-full border border-orange-500/25 bg-orange-500/[0.06] px-2.5 py-0.5">
          {grants.length}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={copyEmails}
            disabled={emails.length === 0}
            className="flex items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs text-white/80 hover:bg-white/[0.06] transition-colors disabled:opacity-40"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-orange-400" /> : <Copy className="w-3.5 h-3.5" />}
            Copy {emails.length} email{emails.length === 1 ? "" : "s"}
          </button>
          <button
            onClick={refresh}
            className="flex items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs text-white/70 hover:bg-white/[0.06] transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400/90 mb-3">{error}</p>}
      {loading && grants.length === 0 ? (
        <div className="flex items-center gap-2 text-white/40 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : grants.length === 0 ? (
        <p className="text-sm text-white/40">No redemptions yet. Emails show up here the moment someone scans a card and starts a trial.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] font-mono uppercase tracking-widest text-white/30">
                <th className="pb-2 pr-4 font-normal">Email</th>
                <th className="pb-2 pr-4 font-normal">Code</th>
                <th className="pb-2 pr-4 font-normal">Opened</th>
                <th className="pb-2 font-normal">Redeemed</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g, i) => (
                <tr key={`${g.email ?? "?"}-${g.created_at}-${i}`} className="border-t border-white/5">
                  <td className="py-2 pr-4">
                    <span className="flex items-center gap-1.5 text-white/85">
                      <Mail className="w-3.5 h-3.5 text-white/25 shrink-0" />
                      {g.email ?? <span className="text-white/30 italic">no email</span>}
                    </span>
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-white/55">{g.campaign_code ?? "-"}</td>
                  <td className="py-2 pr-4 text-xs text-white/45">
                    {g.first_opened_at ? new Date(g.first_opened_at).toLocaleDateString() : <span className="text-white/25">not yet</span>}
                  </td>
                  <td className="py-2 text-xs text-white/45">{new Date(g.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Dashboard ───────────────────────────────────────────────────────────────
function Dashboard({ apiKey, onLock }: { apiKey: string; onLock: () => void }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await listCampaigns(apiKey);
    setLoading(false);
    if (res.ok && res.data) {
      setCampaigns(res.data.campaigns);
      setError("");
    } else if (res.status === 401) {
      onLock();
    } else {
      setError(res.error ?? "Could not load campaigns.");
    }
  }, [apiKey, onLock]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function upsert(c: Campaign) {
    setCampaigns((prev) => {
      const i = prev.findIndex((x) => x.id === c.id);
      if (i === -1) return [c, ...prev];
      const next = [...prev];
      next[i] = c;
      return next;
    });
  }

  return (
    <main className="relative z-10 max-w-3xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-2.5">
          <img src="/panik-logo.png" alt="PANIK" width={32} height={32} className="rounded-lg object-contain" />
          <span className="font-display font-semibold text-lg text-white/90">Admin</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refresh} className="flex items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs text-white/70 hover:bg-white/[0.06] transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
          <button onClick={onLock} className="rounded-lg border border-white/12 px-2.5 py-1.5 text-xs text-white/50 hover:bg-white/[0.06] transition-colors">
            Lock
          </button>
        </div>
      </div>

      <CreateForm apiKey={apiKey} onCreated={upsert} />

      <RedeemedUsers apiKey={apiKey} />

      <h2 className="font-display text-base font-semibold text-white/90 mb-4">Campaigns</h2>
      {error && <p className="text-sm text-red-400/90 mb-4">{error}</p>}
      {loading && campaigns.length === 0 ? (
        <div className="flex items-center gap-2 text-white/40 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : campaigns.length === 0 ? (
        <p className="text-sm text-white/40">No campaigns yet. Create one above.</p>
      ) : (
        // key on an intrinsic wrapper: this repo ships no @types/react, so
        // JSX.IntrinsicAttributes (which carries `key`) is absent for custom
        // components; intrinsic elements type as any, so keys ride on them.
        campaigns.map((c) => (
          <div key={c.id}>
            <CampaignRow c={c} apiKey={apiKey} onChange={upsert} />
          </div>
        ))
      )}
    </main>
  );
}

export default function App() {
  const [apiKey, setApiKey] = useState<string>(() => getStoredKey());

  function lock() {
    clearStoredKey();
    setApiKey("");
  }

  return (
    <div className="relative min-h-screen bg-[#0A0A0B] text-[#F0F4FF] overflow-x-clip">
      <div className="fixed inset-0 panik-dot-bg pointer-events-none z-0 opacity-40" />
      {apiKey ? <Dashboard apiKey={apiKey} onLock={lock} /> : <KeyGate onUnlock={setApiKey} />}
    </div>
  );
}
