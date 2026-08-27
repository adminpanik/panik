/**
 * DelegationManager - grant, disclose and revoke a standing exit permission
 * (Phase 2.C). The USER signs one scoped ExitPermit in their wallet; PANIK may
 * then run that one exit on their behalf WHEN a trigger is met, and only ever
 * back to their own wallet. The relayer that USES the permit is Phase 4 - this
 * screen only grants, displays and revokes.
 *
 * Trust surface rules that shaped this file:
 *   - "standing permission" in every word the user reads. Never "session key"
 *     or "delegation key": the point of the product is legibility.
 *   - The permit type + domain come from server/exitPermit.ts (the single
 *     source of truth the backend verifies against); the message + defaults
 *     come from lib/exitPermitCompose.ts. Nothing about the struct is retyped.
 *   - Grant/revoke are ORDINARY UI, not risk states, so this screen paints
 *     nothing from the risk ramp. Load failures are told apart from good news
 *     by icon + words + shape (SC 1.4.1), never by hue.
 *   - Revocation is the USER's own on-chain action. The UI never shows a
 *     permission as revoked before the receipt confirms success (viem does not
 *     throw on revert); the active list is the backend's chain-reconciled query,
 *     not a hopeful local flag.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, RefreshCw, ShieldCheck, Wallet } from "lucide-react";
import {
  useAccount,
  useConnect,
  usePublicClient,
  useSignTypedData,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { injected } from "wagmi/connectors";
import { EXIT_PERMIT_TYPES, exitDomain, type ExitPermit } from "../../../server/exitPermit";
import {
  EXECUTOR_ABI,
  EXECUTOR_ADDRESS,
  EXIT_CHAIN_ID,
} from "../lib/exit.generated";
import { asContractClient, EXIT_ENV, getExitChain } from "../lib/exit";
import { exitsExecutableOn, useChainMode } from "../lib/chainMode";
import { PROTOCOL_ID } from "../lib/exitLegs";
import type { LiveProtocol } from "../lib/live";
import { liquidationOutlook, PROTOCOL_LABEL } from "../lib/utils";
import {
  clampSlippageBps,
  composeExitPermit,
  defaultProtocolsMask,
  defaultTriggerHf,
  grantActionMeta,
  GRANT_ACTIONS,
  nonceFromBytes,
  nonceInvalidation,
  permitToRequestBody,
  revocationConfirmed,
  wadToHf,
  type GrantAction,
} from "../lib/exitPermitCompose";
import type { RiskProfile } from "../../../packages/scoring/src/types";
import { Button, Card, Chip, EmptyState, Field, Notice, Skeleton } from "../ui";

/**
 * One term of a permission, in a ledger line: what it is on the left, the
 * figure on the right in mono. The trigger, the slippage ceiling and the expiry
 * used to run together in a single 12px dot-separated sentence set in Archivo,
 * which is three readings a user checks before signing rendered as prose.
 *
 * `title` carries the hover the health-factor row needs (`liquidationOutlook`
 * keeps the exact ratio there), and is absent everywhere else.
 */
function LedgerRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3" title={title}>
      <span className="min-w-0 font-sans text-xs text-text-secondary">{label}</span>
      <span className="shrink-0 font-mono text-xs font-bold tabular-nums text-text-primary">
        {value}
      </span>
    </div>
  );
}

/**
 * One block of a segmented choice. Cobalt when selected, which is the same job
 * the accent does on the active tab: it is nowhere on the risk ramp, so the
 * chosen option can be the loudest thing in its row without making a claim
 * about the position.
 *
 * `mono` for a choice that is a figure ("30 days"), Archivo for one that is a
 * name ("Full exit"), which is this system's one rule for a numeral.
 */
function SegmentedOption({
  label,
  selected,
  onSelect,
  mono = false,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`h-12 cursor-pointer px-4 hard-edge text-sm font-bold uppercase tracking-[0.02em] ${
        mono ? "font-mono" : "font-sans"
      } ${
        selected
          ? "bg-brand text-white shadow-hard-sm"
          : "bg-surface-raised text-text-primary hover:bg-highlight"
      }`}
    >
      {label}
    </button>
  );
}

const BPS = 10_000;

/** Expiry choices, in days. A user-set control, not a fact the code asserts. */
const EXPIRY_CHOICES = [30, 60, 90] as const;
const DEFAULT_EXPIRY_DAYS = 30;
// Pre-filled slippage tolerance. The on-chain ceiling is the hard cap a user may
// raise to, not a sane default: Base swaps clear well under 1% via aggregation, so
// a click-through grant should not tolerate a 10% haircut. The user can tighten or
// widen up to the ceiling; a fresh grant starts here (clamped if the ceiling is lower).
const DEFAULT_SLIPPAGE_BPS = 100;
const DAY_SECONDS = 86_400;

/** One live delegation as the 2.B GET returns it (bigints as strings). */
interface DelegationView {
  id: string;
  createdAt: number;
  permit: {
    user: string;
    kind: number;
    maxRepayFractionBps: number;
    triggerHealthFactorWad: string;
    maxSlippageBps: number;
    protocolsMask: number;
    epoch: string;
    nonce: string;
    deadline: string;
  };
}

const dateFmt = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function formatDeadline(unixSec: number): string {
  return dateFmt.format(new Date(unixSec * 1000));
}

/** Bps -> a percent string, one decimal dropped when it is a zero. */
function bpsToPct(bps: number): string {
  const pct = (bps / BPS) * 100;
  return `${pct.toFixed(2).replace(/\.?0+$/, "")}%`;
}

/** protocolsMask -> the readable protocol names it covers. */
function maskToLabels(mask: number): string[] {
  return (Object.keys(PROTOCOL_ID) as LiveProtocol[])
    .filter((p) => (mask & (1 << PROTOCOL_ID[p])) !== 0)
    .map((p) => PROTOCOL_LABEL[p]);
}

/** A random 256-bit unordered nonce from the platform CSPRNG. */
function randomNonce(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return nonceFromBytes(bytes);
}

/**
 * The neutral testnet marker. No risk hue: the environment is not a risk band.
 * Follows the Settings switch rather than the build, so it says which chain the
 * reader chose to be on instead of which chain the bundle was cut for.
 */
function TestnetBadge() {
  const mode = useChainMode();
  if (mode !== "testnet") return null;
  // `ui/Chip`, not a hand-typed rectangle: a neutral marker beside a heading is
  // exactly what that primitive is, and this one had drifted to its own padding
  // and its own weight.
  return <Chip>Testnet</Chip>;
}

interface Props {
  /** Sets the default trigger from the engine's risk-profile target. */
  riskProfile: RiskProfile;
  /**
   * Collateral the trigger is expressed against, for the price-drop consequence.
   * A standing permission spans the user's protocols, so this defaults to a
   * generic noun rather than asserting one asset.
   */
  collateralSymbol?: string;
}

export function DelegationManager({ riskProfile, collateralSymbol }: Props) {
  const { address, isConnected, chainId } = useAccount();
  const { connect } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: EXIT_CHAIN_ID });
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();

  const chainMode = useChainMode();
  const onChain = isConnected && chainId === EXIT_CHAIN_ID;
  const symbol = collateralSymbol ?? "your collateral";

  // Grant-form state. Defaults trace to the engine (trigger) and the chain
  // (slippage ceiling); the user narrows from there.
  const [action, setAction] = useState<GrantAction>("full_exit");
  const [triggerHf, setTriggerHf] = useState<number>(() => defaultTriggerHf(riskProfile));
  const [slippageBps, setSlippageBps] = useState<number | null>(null); // null until ceiling read
  const [ceilingBps, setCeilingBps] = useState<number | null>(null);
  const [expiryDays, setExpiryDays] = useState<number>(DEFAULT_EXPIRY_DAYS);

  const [delegations, setDelegations] = useState<DelegationView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [grantOk, setGrantOk] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Keep the default trigger in step with the profile until the user edits it.
  const [triggerTouched, setTriggerTouched] = useState(false);
  useEffect(() => {
    if (!triggerTouched) setTriggerHf(defaultTriggerHf(riskProfile));
  }, [riskProfile, triggerTouched]);

  const refresh = useCallback(async () => {
    if (!address || !onChain) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(
        `/api/exit/delegations?wallet=${encodeURIComponent(address.toLowerCase())}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { delegations?: DelegationView[] };
      setDelegations(Array.isArray(body.delegations) ? body.delegations : []);
    } catch (err) {
      setLoadError((err as Error).message.slice(0, 200));
      setDelegations(null);
    } finally {
      setLoading(false);
    }
  }, [address, onChain]);

  // Read the executor's immutable slippage ceiling once we are on-chain. The
  // ceiling is the hard cap; a fresh grant defaults to DEFAULT_SLIPPAGE_BPS
  // (clamped to the ceiling), not to the ceiling itself.
  const readCeiling = useCallback(async () => {
    if (!publicClient || !onChain) return;
    try {
      const raw = (await asContractClient(publicClient).readContract({
        address: EXECUTOR_ADDRESS,
        abi: EXECUTOR_ABI,
        functionName: "maxPermitSlippageBps",
      })) as number | bigint;
      const ceiling = Number(raw);
      setCeilingBps(ceiling);
      setSlippageBps((prev) =>
        prev === null
          ? clampSlippageBps(DEFAULT_SLIPPAGE_BPS, ceiling)
          : clampSlippageBps(prev, ceiling),
      );
    } catch {
      /* leave slippage disabled until the ceiling is known - never guess it */
    }
  }, [publicClient, onChain]);

  useEffect(() => {
    if (onChain) {
      void refresh();
      void readCeiling();
    } else {
      setDelegations(null);
    }
  }, [onChain, refresh, readCeiling]);

  const outlook = useMemo(() => liquidationOutlook(triggerHf, symbol), [triggerHf, symbol]);
  const protocolLabels = useMemo(() => maskToLabels(defaultProtocolsMask(EXIT_ENV)), []);
  const deadlineSec = useMemo(
    () => Math.floor(Date.now() / 1000) + expiryDays * DAY_SECONDS,
    [expiryDays],
  );
  const actionMeta = grantActionMeta(action);

  const grant = useCallback(async () => {
    if (!address || !publicClient || slippageBps === null) return;
    setGranting(true);
    setGrantError(null);
    setGrantOk(false);
    try {
      const client = asContractClient(publicClient);
      // Epoch MUST match revocationEpoch(user) or the backend (and the contract)
      // reject the permit as orphaned. Read it fresh at sign time.
      const epoch = (await client.readContract({
        address: EXECUTOR_ADDRESS,
        abi: EXECUTOR_ABI,
        functionName: "revocationEpoch",
        args: [address],
      })) as bigint;

      const permit: ExitPermit = composeExitPermit({
        user: address as `0x${string}`,
        action,
        triggerHf,
        maxSlippageBps: slippageBps,
        protocolsMask: defaultProtocolsMask(EXIT_ENV),
        deadline: deadlineSec,
        epoch,
        nonce: randomNonce(),
      });

      const signature = (await signTypedDataAsync({
        domain: exitDomain(),
        types: EXIT_PERMIT_TYPES,
        primaryType: "ExitPermit",
        message: permit,
      } as never)) as `0x${string}`;

      const res = await fetch("/api/exit/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(permitToRequestBody(permit, signature)),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setGrantOk(true);
      await refresh();
    } catch (err) {
      setGrantError((err as Error).message.split("\n")[0]?.slice(0, 200) ?? "grant failed");
    } finally {
      setGranting(false);
    }
  }, [
    address,
    publicClient,
    slippageBps,
    action,
    triggerHf,
    deadlineSec,
    signTypedDataAsync,
    refresh,
  ]);

  /**
   * Revoke one permission (invalidateUnorderedNonces) or all of them
   * (revokeAll). The write is the USER's own msg.sender action; we gate the UI
   * on a SUCCESS receipt, then tell the backend to reconcile with the tx hash.
   */
  const revoke = useCallback(
    async (target: DelegationView | "all") => {
      if (!address || !publicClient) return;
      const id = target === "all" ? "all" : target.id;
      setRevokingId(id);
      setActionError(null);
      try {
        const client = asContractClient(publicClient);
        const call =
          target === "all"
            ? { functionName: "revokeAll" as const, args: [] as const }
            : (() => {
                const { wordPos, mask } = nonceInvalidation(BigInt(target.permit.nonce));
                return {
                  functionName: "invalidateUnorderedNonces" as const,
                  args: [wordPos, mask] as const,
                };
              })();

        const { request } = await client.simulateContract({
          account: address,
          address: EXECUTOR_ADDRESS,
          abi: EXECUTOR_ABI,
          ...call,
        });
        const hash = await writeContractAsync(request as never);
        const receipt = await client.waitForTransactionReceipt({ hash });
        // viem resolves on revert too; only a success receipt may flip the UI.
        if (!revocationConfirmed(receipt)) {
          throw new Error("Revocation reverted on-chain");
        }

        // Tell the backend to reconcile against the chain and record the tx.
        await fetch("/api/exit/delegations/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet: address.toLowerCase(), txHash: hash }),
        }).catch(() => {
          /* the chain is the source of truth; refresh re-reads it either way */
        });
        await refresh();
      } catch (err) {
        setActionError((err as Error).message.split("\n")[0]?.slice(0, 200) ?? "revoke failed");
      } finally {
        setRevokingId(null);
      }
    },
    [address, publicClient, writeContractAsync, refresh],
  );

  // ── Gated shells ─────────────────────────────────────────────────────────

  const header = (
    <div className="flex items-center gap-2 border-b border-border-subtle pb-2.5">
      <ShieldCheck className="w-4 h-4 text-text-primary" />
      <h3 className="text-sm font-sans font-semibold text-text-primary">Standing exit permission</h3>
      <TestnetBadge />
    </div>
  );

  /**
   * The introduction is gone. It described the feature in three clauses above a
   * card whose heading already names it and whose disclosure below lists,
   * exactly, what the permission allows. What a reader decides here is whether
   * to grant it, and the terms are the list, not the paragraph over it.
   */

  // The permission authorizes ONE thing: an exit. On a chain where no exit can
  // be executed it authorizes nothing, so the card states that instead of
  // walking a user through a signature whose only possible use is on the other
  // chain. It is the same honesty gate the exit modal applies, one step earlier.
  if (!exitsExecutableOn(chainMode)) {
    return (
      <Card tone="raised" className="space-y-3">
        {header}
        <p className="text-xs text-text-secondary leading-relaxed font-sans">
          There is nothing to grant here yet.
        </p>
      </Card>
    );
  }

  if (!isConnected) {
    return (
      <Card tone="raised" className="space-y-3">
        {header}
        <Button onClick={() => connect({ connector: injected() })} className="mt-1">
          <Wallet className="w-3.5 h-3.5" aria-hidden="true" /> Connect wallet
        </Button>
      </Card>
    );
  }

  if (!onChain) {
    return (
      <Card tone="raised" className="space-y-3">
        {header}
        <Button onClick={() => void switchChainAsync({ chainId: EXIT_CHAIN_ID })} className="mt-1">
          Switch to {getExitChain().name}
        </Button>
      </Card>
    );
  }

  const slippageInvalid = ceilingBps === null || slippageBps === null;

  return (
    <Card tone="raised" className="space-y-5">
      {header}

      {/* ── Active permissions ─────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-sans font-bold text-text-primary">Active permissions</h4>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="Refresh active permissions"
            className="inline-flex items-center gap-1.5 label-type text-2xs text-text-secondary hover:text-text-primary disabled:opacity-40 cursor-pointer"
          >
            {/* No spin: this look has no motion, and the word carries the state. */}
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            {loading ? "Reading" : "Refresh"}
          </button>
        </div>

        {loadError ? (
          // A failed load is NOT good news and must not read like "you're fine".
          // `EmptyState tone="problem"` is that distinction as a primitive: the
          // hatch, the glyph and the words, rather than a dashed edge this file
          // drew for itself.
          <EmptyState
            tone="problem"
            title="We could not load your permissions"
            hint="Nothing on-chain has changed. Try Refresh."
          />
        ) : delegations === null ? (
          <div aria-busy="true" className="space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : delegations.length === 0 ? (
          <EmptyState
            tone="clear"
            title="No standing permission"
            hint="PANIK can act for you only after you grant one below."
          />
        ) : (
          <div className="space-y-3">
            {delegations.map((d) => {
              const hf = wadToHf(BigInt(d.permit.triggerHealthFactorWad));
              const meta = GRANT_ACTIONS.find((a) => a.kind === d.permit.kind);
              const rowOutlook = liquidationOutlook(hf, symbol);
              return (
                <Card key={d.id} tone="set-back" className="space-y-3">
                  <p className="text-sm font-sans font-bold text-text-primary">
                    PANIK may {meta?.allows ?? "act on this position"}
                  </p>
                  {/* The three terms as figures rather than as a dot-separated
                      run of prose. They are the numbers a reader checks before
                      deciding whether to keep the permission, and they were set
                      in Archivo inside one 12px line. */}
                  <div className="space-y-2">
                    <LedgerRow
                      label="Fires at health factor"
                      value={hf.toFixed(2)}
                      title={rowOutlook.hover}
                    />
                    <LedgerRow
                      label="Most slippage allowed"
                      value={bpsToPct(d.permit.maxSlippageBps)}
                    />
                    <LedgerRow label="Expires" value={formatDeadline(Number(d.permit.deadline))} />
                  </div>
                  <p className="text-xs font-sans leading-relaxed text-text-secondary">
                    Covers {maskToLabels(d.permit.protocolsMask).join(", ") || "no protocol"}. Pays
                    only to your wallet.
                  </p>
                  <Button
                    variant="secondary"
                    onClick={() => void revoke(d)}
                    disabled={revokingId !== null}
                  >
                    {revokingId === d.id ? "Revoking" : "Revoke"}
                  </Button>
                </Card>
              );
            })}
            {delegations.length > 1 ? (
              <Button
                variant="ghost"
                onClick={() => void revoke("all")}
                disabled={revokingId !== null}
              >
                {revokingId === "all" ? "Revoking all" : "Revoke all"}
              </Button>
            ) : null}
          </div>
        )}

        {actionError ? (
          <Notice text={`Revoke did not complete: ${actionError}. Nothing changed on-chain.`} />
        ) : null}
      </div>

      {/* ── Grant a new permission ─────────────────────────────────────── */}
      <div className="space-y-4 border-t border-border-subtle pt-4">
        <h4 className="text-xs font-sans font-bold text-text-primary">Grant a standing permission</h4>

        {/* Action */}
        <fieldset className="space-y-2">
          <legend className="label-type text-2xs text-text-muted">What PANIK may do</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Exit action">
            {GRANT_ACTIONS.map((a) => (
              <SegmentedOption
                key={a.id}
                label={a.label}
                selected={a.id === action}
                onSelect={() => setAction(a.id)}
              />
            ))}
          </div>
        </fieldset>

        {/* Trigger + slippage. Both are figures the user types, so both are
            `Field` in mono: the label sits inside the box until there is a
            value, and there is never a second placeholder string. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            mono
            label="Act at health factor"
            type="number"
            inputMode="decimal"
            step={0.05}
            min={1.05}
            value={triggerHf}
            onChange={(e) => {
              setTriggerTouched(true);
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) setTriggerHf(v);
            }}
          />
          <Field
            mono
            label={`Max slippage${ceilingBps !== null ? ` (limit ${bpsToPct(ceilingBps)})` : ""}`}
            type="number"
            inputMode="decimal"
            step={0.05}
            min={0}
            max={ceilingBps !== null ? (ceilingBps / BPS) * 100 : undefined}
            disabled={ceilingBps === null}
            value={slippageBps !== null ? Number(((slippageBps / BPS) * 100).toFixed(2)) : ""}
            onChange={(e) => {
              if (ceilingBps === null) return;
              const pct = Number(e.target.value);
              if (!Number.isFinite(pct) || pct < 0) return;
              setSlippageBps(clampSlippageBps(Math.round((pct / 100) * BPS), ceilingBps));
            }}
          />
        </div>

        {/* Three choices, so three blocks rather than a dropdown. The native
            `<select>` this replaces was the only control in the card that did
            not carry the product's hard edge, and `ui/Listbox` is built for a
            long list behind a custom trigger, not for three words. */}
        <fieldset className="space-y-2">
          <legend className="label-type text-2xs text-text-muted">Expires in</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Expires in">
            {EXPIRY_CHOICES.map((d) => (
              <SegmentedOption
                key={d}
                label={`${d} days`}
                mono
                selected={d === expiryDays}
                onSelect={() => setExpiryDays(d)}
              />
            ))}
          </div>
        </fieldset>

        {/* ── Scope disclosure: the trust surface, consequence-led ─────────
            Five paragraphs became the terms plus their figures. What went: the
            second and third sentences of "where your money goes" (the contract
            enforcing it was already the claim), and the block-time promise on
            revoking ("takes effect in about 2 seconds"), which is a fact about
            Base that this component does not measure. */}
        <Card tone="set-back" className="space-y-3">
          <p className="text-sm font-sans leading-relaxed text-text-primary">
            PANIK may {actionMeta.allows}. You are left with {actionMeta.leaves}.
          </p>
          <div className="space-y-2">
            <LedgerRow
              label="Fires at health factor"
              value={triggerHf.toFixed(2)}
              title={outlook.hover}
            />
            <LedgerRow
              label="Most slippage allowed"
              value={slippageBps !== null ? bpsToPct(slippageBps) : "Not read"}
            />
            <LedgerRow label="Expires" value={formatDeadline(deadlineSec)} />
          </div>
          <p className="text-xs font-sans leading-relaxed text-text-secondary" title={outlook.hover}>
            A further {outlook.strip} fall in {symbol} would put you at liquidation. Covers{" "}
            {protocolLabels.join(", ") || "no protocol"}. Pays only ever back to your own wallet,
            which the executor contract enforces on-chain. Revocable at any time, by your own
            transaction.
          </p>
        </Card>

        {grantError ? (
          <Notice
            text={`Could not grant the permission: ${grantError}. Nothing was stored or signed.`}
          />
        ) : null}

        {grantOk ? (
          <p className="flex items-center gap-2 text-xs font-sans text-text-secondary">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-text-primary" aria-hidden="true" />
            Standing permission granted. It is listed above and revocable any time.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void grant()} disabled={granting || slippageInvalid}>
            <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
            {granting ? "Sign in wallet" : "Grant standing permission"}
          </Button>
          {/* Two facts, not four clauses: what it costs and what it does not
              do. A signature is the one control on this screen where a reader
              genuinely cannot tell either from the button. */}
          <p className="text-2xs font-sans text-text-muted">No gas. Signing moves no funds.</p>
        </div>
      </div>
    </Card>
  );
}
