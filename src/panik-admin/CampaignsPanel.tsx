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
 *
 * The create form is collapsed behind a button in the title band rather than
 * standing open above the list, which is the shape the product's own Wallets
 * panel uses: the form is the rarer act, and a permanently open one pushed the
 * codes themselves below the fold.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Ban, Check, ChevronDown, ChevronRight, Copy, Download, Plus, RefreshCw } from "lucide-react";

import { Button, Card, Chip, EmptyState, Skeleton, Stat } from "../panik-core/ui";
import { evaluateCampaign, formatRemaining, type CampaignStatus } from "../panik-try/lib/trialLogic";
import { Field, Panel, PANEL_BODY, ReloadButton } from "./ui/controls";
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

/**
 * A secondary button that is an anchor, for the one control on this console
 * that has to be a link: `download` on a data URL is what saves the QR, and a
 * `<button>` cannot carry it. Written out rather than passed through `Button`
 * because that primitive renders a `<button>`; `no-underline` because
 * index.css underlines every anchor in the product and this one is a control.
 */
const ANCHOR_BUTTON =
  "inline-flex h-12 cursor-pointer items-center justify-center gap-2 px-5 font-sans text-sm font-bold uppercase tracking-[0.02em] no-underline hard-edge shadow-hard-sm bg-surface-raised text-text-primary hover:bg-highlight";

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
    <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-start">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt={`QR code linking to the trial page for ${code}`}
          className="h-32 w-32 shrink-0 hard-edge bg-white p-1"
        />
      ) : (
        <Skeleton className="h-32 w-32 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <p className="label-type text-2xs text-text-muted">Print this link on the card</p>
        <p className="mt-1 break-all font-mono text-sm text-text-primary">{url}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={dataUrl || undefined}
            download={`${code}.png`}
            aria-disabled={dataUrl ? undefined : true}
            className={`${ANCHOR_BUTTON} ${dataUrl ? "" : "pointer-events-none opacity-40"}`}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download QR
          </a>
          <Button variant="secondary" onClick={copy}>
            {copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
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
  onCancel,
  onSignedOut,
}: {
  session: Session;
  onCreated: (c: Campaign) => void;
  onCancel: () => void;
  onSignedOut: () => void;
}) {
  const [label, setLabel] = useState("");
  const [trialDays, setTrialDays] = useState("3");
  const [maxRedemptions, setMaxRedemptions] = useState("20");
  const [claimWindowDays, setClaimWindowDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /**
   * Focus the first field the moment the form opens, so the operator who just
   * pressed "New voucher code" is typing rather than hunting. A wrapper ref
   * rather than a ref on `Field`: its prop type is `InputHTMLAttributes`, which
   * does not admit one.
   */
  const firstField = useRef<HTMLDivElement>(null);
  useEffect(() => {
    firstField.current?.querySelector("input")?.focus();
  }, []);

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
    <form onSubmit={submit} className="border-b-[3px] border-border-strong bg-surface-sunken p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div ref={firstField} className="sm:col-span-2">
          <Field
            label="Label"
            hint="Internal note, so you can tell two print runs apart."
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
          />
        </div>
        <Field
          label="Trial length in days"
          type="number"
          mono
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
          mono
          min="1"
          value={maxRedemptions}
          onChange={(e) => setMaxRedemptions(e.target.value)}
          hint="The batch stops accepting redemptions at this count."
          disabled={busy}
          required
        />
        <Field
          wrapClassName="sm:col-span-2"
          label="Claim window in days"
          type="number"
          mono
          min="1"
          value={claimWindowDays}
          onChange={(e) => setClaimWindowDays(e.target.value)}
          hint="Deadline for redeeming the card itself. Leave blank for no deadline."
          disabled={busy}
        />
      </div>
      {error && (
        <p role="alert" className="mt-4 font-sans text-xs text-text-secondary">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {/* No spinner: there is no motion in this system, and the word on a
            disabled button carries the same fact. */}
        <Button type="submit" disabled={busy}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {busy ? "Creating" : "Create"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
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
  const Caret = open ? ChevronDown : ChevronRight;

  return (
    <li className="border-t-[3px] border-border-strong first:border-t-0">
      <div className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="font-mono text-sm font-bold text-text-primary">
            {campaign.campaign_code}
          </span>
          {/* Inverted for the one live state, plain for the three finished
              ones. No hue either way: an exhausted batch is an inventory fact,
              not a risk band, and the five risk hues mean liquidation risk
              everywhere else in the product. */}
          <Chip className={status === "active" ? "bg-text-primary text-white" : ""}>
            {STATUS_LABEL[status]}
          </Chip>
          {campaign.label && (
            <span className="min-w-0 truncate font-sans text-xs text-text-secondary">
              {campaign.label}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={panelId}
            >
              <Caret className="h-3.5 w-3.5" aria-hidden="true" />
              {open ? "Hide" : "Details"}
            </Button>
            {campaign.is_active && (
              <Button variant="secondary" onClick={expire} disabled={busy}>
                <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                {busy ? "Switching off" : "Switch off"}
              </Button>
            )}
          </div>
        </div>

        {/* The four facts as one sentence rather than as a four-cell
            definition list: they are short, they are always all present, and
            the list spent a whole row of the card on four captions. */}
        <p className="font-sans text-xs text-text-secondary">
          Redeemed{" "}
          <span className="font-mono">
            {campaign.redemption_count} of {campaign.max_redemptions}
          </span>
          , trial <span className="font-mono">{trialLength(campaign.trial_duration_hours)}</span>,{" "}
          <span className="font-mono">{claimWindow}</span>, created{" "}
          <span className="font-mono">{new Date(campaign.created_at).toLocaleDateString()}</span>
        </p>
      </div>

      {open && (
        <div
          id={panelId}
          className="flex flex-col gap-5 border-t-[3px] border-border-strong bg-surface-sunken p-4"
        >
          <QrBlock code={campaign.campaign_code} />
          <RedemptionsPanel
            session={session}
            code={campaign.campaign_code}
            redemptionCount={campaign.redemption_count}
            onSignedOut={onSignedOut}
          />
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
  const [creating, setCreating] = useState(false);

  const createButtonRef = useRef<HTMLButtonElement>(null);
  // Skips the focus-return on the initial render and fires only on the true ->
  // false transition, whether that came from Cancel or a successful create:
  // either way the form is gone and its trigger is where focus belongs.
  const wasCreating = useRef(false);
  useEffect(() => {
    if (wasCreating.current && !creating) createButtonRef.current?.focus();
    wasCreating.current = creating;
  }, [creating]);

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

  function onCreated(next: Campaign) {
    upsert(next);
    // A successful create is also a close: there is nothing left in the form to
    // look at once the code it was for exists as a row below it.
    setCreating(false);
  }

  const live = campaigns.filter((c) => evaluateCampaign(c) === "active");
  const claimed = campaigns.reduce((sum, c) => sum + c.redemption_count, 0);
  const pending = loading && campaigns.length === 0;

  return (
    <>
      {/* Counts of what is loaded, nothing derived or predicted. */}
      <div className="grid gap-8 md:grid-cols-3">
        <Card tone="raised">
          <Stat label="Voucher codes" value={pending ? "..." : campaigns.length} sub="Created to date" />
        </Card>
        <Card tone="raised">
          <Stat
            label="Still redeemable"
            value={pending ? "..." : live.length}
            sub="Accepting redemptions now"
          />
        </Card>
        {/* Deliberately NOT "how many people we have". This is the per-code
            counter, which keeps counting a redemption after the trial itself is
            cleaned up 30 days past expiry, so it runs ahead of the Trials tab.
            Two names, because they are two quantities. */}
        <Card tone="raised">
          <Stat
            label="Redemptions to date"
            value={pending ? "..." : claimed}
            sub="Counted per code, expired trials included"
          />
        </Card>
      </div>

      <Panel
        title="Voucher codes"
        actions={
          <>
            <ReloadButton onClick={refresh} label="Reload voucher codes" />
            {!creating && (
              <Button ref={createButtonRef} onClick={() => setCreating(true)}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New voucher code
              </Button>
            )}
          </>
        }
      >
        {creating && (
          <CreateForm
            session={session}
            onCreated={onCreated}
            onCancel={() => setCreating(false)}
            onSignedOut={onSignedOut}
          />
        )}

        {error ? (
          <div className={PANEL_BODY}>
            <EmptyState
              tone="problem"
              title="Could not load the voucher codes"
              hint={error}
              action={
                <Button variant="secondary" onClick={refresh}>
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
                </Button>
              }
            />
          </div>
        ) : pending ? (
          <div className={`flex flex-col gap-3 ${PANEL_BODY}`}>
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-3/4" />
          </div>
        ) : campaigns.length === 0 ? (
          <div className={PANEL_BODY}>
            <EmptyState
              tone="clear"
              title="No voucher codes yet"
              hint="Create one from the button above and a printable QR appears with it."
            />
          </div>
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
      </Panel>
    </>
  );
}
