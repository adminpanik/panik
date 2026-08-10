/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The voucher manager: mint a batch of trial codes, watch each batch fill up,
 * print the QR, switch a batch off early, and open the roster of who redeemed
 * it. One campaign row = one printed code = one batch of trials.
 *
 * The code itself is generated server-side from a CSPRNG (campaignStore.ts);
 * there is no field for typing one, because a hand-picked voucher code is a
 * guessable voucher code.
 */

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { Ban, Check, ChevronDown, Copy, Download, Loader2, Plus, RefreshCw } from "lucide-react";

import { Button, Card, EmptyState, Skeleton, Stat } from "../panik-core/ui";
import { evaluateCampaign, formatRemaining, type CampaignStatus } from "../panik-try/lib/trialLogic";
import { Field, StatusPill } from "./ui/controls";
import { RedemptionsPanel } from "./RedemptionsPanel";
import {
  createCampaign,
  expireCampaign,
  isSignedOut,
  listCampaigns,
  type Campaign,
  type CreateInput,
} from "./lib/adminApi";
import type { Session } from "./lib/supabaseAuth";

/** Plain words for the four states. Never the enum, never colour alone. */
const STATUS_LABEL: Record<CampaignStatus, string> = {
  active: "Accepting redemptions",
  exhausted: "All trials claimed",
  expired: "Claim window closed",
  disabled: "Switched off",
};

function tryUrl(code: string): string {
  return `${window.location.origin}/try?code=${code}`;
}

/** Trial length as words. Hours below a day, whole days above. */
function trialLength(hours: number): string {
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

// ── QR block (generated client-side, printable) ─────────────────────────────
function QrBlock({ code }: { code: string }) {
  const [dataUrl, setDataUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const url = tryUrl(code);

  useEffect(() => {
    // Pure black on pure white, not the surface tokens: this image is printed
    // onto a card and scanned by a phone camera, so it wants the maximum
    // contrast a scanner is calibrated for, not the page's palette. (Passing a
    // `var(--...)` string here also just throws inside the encoder.)
    QRCode.toDataURL(url, { width: 320, margin: 2, color: { dark: "#000000", light: "#FFFFFF" } })
      .then(setDataUrl)
      .catch(() => setDataUrl(""));
  }, [url]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the URL is on screen and selectable */
    }
  }

  return (
    <div className="mt-4 flex flex-col items-start gap-4 rounded-md border border-border-subtle p-4 sm:flex-row sm:items-center">
      {dataUrl ? (
        <img src={dataUrl} alt={`QR code linking to the trial page for ${code}`} className="h-32 w-32 shrink-0 rounded-sm bg-white p-1" />
      ) : (
        <Skeleton className="h-32 w-32 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-sans text-text-secondary">Print this link on the card</p>
        <p className="mt-1 break-all text-sm font-sans text-text-primary">{url}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={dataUrl || undefined}
            download={`${code}.png`}
            aria-disabled={dataUrl ? undefined : true}
            className={`inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-3.5 py-2 text-xs font-sans font-bold text-text-secondary transition-all hover:bg-white/[0.04] hover:text-text-primary ${dataUrl ? "" : "pointer-events-none opacity-50"}`}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download QR
          </a>
          <Button variant="outline" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Create ──────────────────────────────────────────────────────────────────
function CreateForm({
  session,
  onCreated,
  onSignedOut,
}: {
  session: Session;
  onCreated: (c: Campaign) => void;
  onSignedOut: () => void;
}) {
  const [label, setLabel] = useState("");
  const [trialDays, setTrialDays] = useState("3");
  const [maxRedemptions, setMaxRedemptions] = useState("20");
  const [claimWindowDays, setClaimWindowDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const input: CreateInput = {
      label: label.trim() || undefined,
      trialDays: Number(trialDays),
      maxRedemptions: Number(maxRedemptions),
      claimWindowDays: claimWindowDays.trim() ? Number(claimWindowDays) : undefined,
    };
    // Ranges are checked by buildCreateInput() on the server, which is the same
    // validator the serverless mirror uses. Its message is what shows up here.
    const res = await createCampaign(session, input);
    setBusy(false);
    if (res.ok && res.data) {
      onCreated(res.data.campaign);
      setLabel("");
    } else if (isSignedOut(res.status)) {
      onSignedOut();
    } else {
      setError(res.error ?? "Could not create the campaign.");
    }
  }

  return (
    <Card tone="panel" className="mb-6">
      <form onSubmit={submit}>
        <h2 className="text-base font-sans font-bold text-text-primary">New voucher code</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            className="sm:col-span-2"
            label="Label"
            placeholder="ETHDenver booth cards"
            hint="Internal note, so you can tell two print runs apart."
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
          />
          <Field
            label="Trial length in days"
            type="number"
            min="1"
            value={trialDays}
            onChange={(e) => setTrialDays(e.target.value)}
            hint="Per person. The clock starts when they first open the app."
            disabled={busy}
            required
          />
          <Field
            label="How many people can redeem it"
            type="number"
            min="1"
            value={maxRedemptions}
            onChange={(e) => setMaxRedemptions(e.target.value)}
            hint="The batch stops accepting redemptions at this count."
            disabled={busy}
            required
          />
          <Field
            className="sm:col-span-2"
            label="Claim window in days"
            type="number"
            min="1"
            placeholder="No deadline"
            value={claimWindowDays}
            onChange={(e) => setClaimWindowDays(e.target.value)}
            hint="Deadline for redeeming the card itself. Leave blank for no deadline."
            disabled={busy}
          />
        </div>
        {error && (
          <p role="alert" className="mt-4 text-xs font-sans text-text-secondary">
            {error}
          </p>
        )}
        <Button type="submit" className="mt-5" disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
          {busy ? "Creating" : "Create voucher code"}
        </Button>
      </form>
    </Card>
  );
}

// ── One campaign ────────────────────────────────────────────────────────────
function CampaignRow({
  campaign,
  session,
  onChange,
  onSignedOut,
}: {
  campaign: Campaign;
  session: Session;
  onChange: (c: Campaign) => void;
  onSignedOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = evaluateCampaign(campaign);
  const claimWindow = campaign.claim_window_expires_at
    ? formatRemaining(new Date(campaign.claim_window_expires_at).getTime() - Date.now())
    : "no deadline";

  async function expire() {
    const ok = window.confirm(
      `Switch off ${campaign.campaign_code}? Trials already claimed keep working, but nobody new can redeem it.`,
    );
    if (!ok) return;
    setBusy(true);
    const res = await expireCampaign(session, campaign.id);
    setBusy(false);
    if (res.ok && res.data) onChange(res.data.campaign);
    else if (isSignedOut(res.status)) onSignedOut();
  }

  const panelId = `campaign-detail-${campaign.id}`;

  return (
    <li className="border-t border-border-subtle py-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-sans font-bold text-text-primary">{campaign.campaign_code}</span>
        <StatusPill tone={status === "active" ? "live" : "done"}>{STATUS_LABEL[status]}</StatusPill>
        {campaign.label && (
          <span className="min-w-0 truncate text-xs font-sans text-text-secondary">{campaign.label}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="quiet"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={panelId}
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
            {open ? "Hide" : "Details"}
          </Button>
          {campaign.is_active && (
            <Button variant="outline" onClick={expire} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Ban className="h-3.5 w-3.5" aria-hidden="true" />}
              Switch off
            </Button>
          )}
        </div>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 text-xs font-sans">
        <div>
          <dt className="text-text-muted">Redeemed</dt>
          <dd className="mt-0.5 text-sm text-text-primary">
            {campaign.redemption_count} of {campaign.max_redemptions}
          </dd>
        </div>
        <div>
          <dt className="text-text-muted">Trial length</dt>
          <dd className="mt-0.5 text-sm text-text-primary">{trialLength(campaign.trial_duration_hours)}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Claim window</dt>
          <dd className="mt-0.5 text-sm text-text-primary">{claimWindow}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Created</dt>
          <dd className="mt-0.5 text-sm text-text-primary">
            {new Date(campaign.created_at).toLocaleDateString()}
          </dd>
        </div>
      </dl>

      {open && (
        <div id={panelId}>
          <QrBlock code={campaign.campaign_code} />
          <RedemptionsPanel session={session} code={campaign.campaign_code} onSignedOut={onSignedOut} />
        </div>
      )}
    </li>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────────
export function CampaignsPanel({
  session,
  onSignedOut,
}: {
  session: Session;
  onSignedOut: () => void;
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await listCampaigns(session);
    setLoading(false);
    if (res.ok && res.data) {
      setCampaigns(res.data.campaigns);
      setError("");
    } else if (isSignedOut(res.status)) {
      onSignedOut();
    } else {
      setError(res.error ?? "Could not load campaigns.");
    }
  }, [session, onSignedOut]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function upsert(next: Campaign) {
    setCampaigns((prev) => {
      const i = prev.findIndex((c) => c.id === next.id);
      if (i === -1) return [next, ...prev];
      const copy = [...prev];
      copy[i] = next;
      return copy;
    });
  }

  const live = campaigns.filter((c) => evaluateCampaign(c) === "active");
  const claimed = campaigns.reduce((sum, c) => sum + c.redemption_count, 0);

  return (
    <>
      {/* Counts of what is loaded, nothing derived or predicted. */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card tone="raised">
          <Stat label="Voucher codes" value={loading && campaigns.length === 0 ? "..." : campaigns.length} />
        </Card>
        <Card tone="raised">
          <Stat
            label="Still redeemable"
            value={loading && campaigns.length === 0 ? "..." : live.length}
          />
        </Card>
        {/* Deliberately NOT "how many people we have". This is the per-code
            counter, which keeps counting a redemption after the trial itself is
            cleaned up 30 days past expiry, so it runs ahead of the roster above.
            Two names, because they are two quantities. */}
        <Card tone="raised" className="col-span-2 sm:col-span-1">
          <Stat
            label="Redemptions to date"
            value={loading && campaigns.length === 0 ? "..." : claimed}
            sub="Counted per code, expired trials included"
          />
        </Card>
      </div>

      <CreateForm session={session} onCreated={upsert} onSignedOut={onSignedOut} />

      <Card tone="panel">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-sans font-bold text-text-primary">Voucher codes</h2>
          <Button variant="quiet" onClick={refresh} aria-label="Reload voucher codes">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            Reload
          </Button>
        </div>

        {error ? (
          <EmptyState
            tone="problem"
            title="Could not load the voucher codes"
            hint={error}
            action={
              <Button variant="outline" onClick={refresh}>
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
              </Button>
            }
          />
        ) : loading && campaigns.length === 0 ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-3/4" />
          </div>
        ) : campaigns.length === 0 ? (
          <EmptyState
            tone="clear"
            title="No voucher codes yet"
            hint="Create one above and a printable QR appears with it."
          />
        ) : (
          <ul>
            {campaigns.map((c) => (
              <CampaignRow
                key={c.id}
                campaign={c}
                session={session}
                onChange={upsert}
                onSignedOut={onSignedOut}
              />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
