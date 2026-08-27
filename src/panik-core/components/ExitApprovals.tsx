/**
 * ExitApprovals - grant the token permissions an exit needs while nothing is
 * urgent, and take them all back in one click (P2 items 6.1 and 6.2).
 *
 * ## Why this is not the standing permission card
 *
 * Two revocations exist in this product and a user who confuses them loses
 * something they meant to keep:
 *
 * - `DelegationManager` revokes SIGNED EXIT PERMITS. It bumps
 *   `revocationEpoch` on the executor, which invalidates the standing
 *   permission that lets PANIK act for you while you are asleep.
 * - This card revokes APPROVALS: the ERC-20 allowances (and, at mainnet
 *   cutover, the boolean operator grants) that let the executor move your
 *   tokens at all.
 *
 * They are named differently in every word on screen, and neither button ever
 * says the bare word "revoke" without saying what of.
 *
 * ## What it grants
 *
 * The exit's own amounts, from the exit's own leg builder: exact debt and exact
 * deposit balance, plus the accrual buffer `useExitApprovals` applies. Never an
 * infinite approval. The sizing, the buffer and the runner are all shared with
 * `ExitFlow` rather than reimplemented, so a pre-authorized approval is exactly
 * the approval the exit would have asked for.
 *
 * ## What it may claim
 *
 * "One signature" is recomputed from allowances read off the chain
 * (`preauthCoverage`), never asserted. Debt accrues past a buffer on its own,
 * so the promise is a measurement and the card states the count it measured.
 *
 * Grant and revoke are ORDINARY actions, not risk states, so nothing here is
 * painted from the risk ramp. Failure is told apart from good news by icon,
 * words and shape (SC 1.4.1).
 */

import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, KeyRound, RefreshCw, ShieldOff, Wallet } from "lucide-react";
import { useAccount, useConnect, usePublicClient, useSwitchChain } from "wagmi";
import { injected } from "wagmi/connectors";
import { EXECUTOR_ADDRESS, EXIT_CHAIN_ID } from "../lib/exit.generated";
import { asContractClient, EXIT_ERC20_ABI, EXIT_NETWORK_LABEL, getExitChain, isExitExecutable } from "../lib/exit";
import { exitsExecutableOn, useChainMode } from "../lib/chainMode";
import { classifyExitError } from "../lib/exitRpc";
import { readUserReserves } from "../lib/exitPosition";
import { resolveATokens } from "../lib/exitReserves";
import {
  ACCRUAL_BUFFER_PCT,
  approvalStepsFor,
  buildExitLegs,
  formatTokenAmount,
  withAccrualBuffer,
  type ApprovalStep,
} from "../lib/exitLegs";
import {
  preauthCoverage,
  PROTOCOL_GRANTS,
  revokeSummary,
  type GrantSpec,
  type GrantState,
  type RevokeOutcome,
} from "../lib/preauth";
import { useExitApprovals } from "../lib/useExitApprovals";
import { PROTOCOL_LABEL } from "../lib/utils";
import { Button, Card, EmptyState, Notice, Skeleton } from "../ui";

/**
 * One approval figure, in a ledger line. The four-branch sentence this replaces
 * ("Approved for X, which covers the Y an exit would need") set its amounts in
 * Archivo inside prose, which is the one thing this system's type rule forbids:
 * a figure is a reading and reads in mono, and two amounts buried mid-sentence
 * cannot be compared at a glance, which is the entire question the row answers.
 */
function LedgerRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 font-sans text-xs text-text-secondary">{label}</span>
      <span className="shrink-0 font-mono text-xs font-bold tabular-nums text-text-primary">
        {value}
      </span>
    </div>
  );
}

/**
 * The only protocol an approval can be exercised on today.
 *
 * `EXECUTABLE_PROTOCOLS` in `lib/exit` is `testnet: ["aave_v3"]`, and the other
 * three need a market address (the Comet instance, the Morpho singleton) that
 * this repo's deploy config does not carry. Their grant patterns are described
 * and unit-tested in `lib/preauth`; nothing here pretends they can be granted.
 */
const PROTOCOL = "aave_v3" as const;

/** An approval plus the allowance the chain currently reports for it. */
interface LiveApproval extends ApprovalStep {
  /** Stable identity for React and for `RevokeOutcome`. The token address. */
  id: string;
  /** Allowance right now, in the token's own units. */
  current: bigint;
}

/** One approval, as the Settings card shows it. */
interface ApprovalRow extends LiveApproval {
  decimals: number;
  spec: GrantSpec;
}

interface Loaded {
  rows: ApprovalRow[];
  /** Symbols the market would not answer for. Non-empty blocks every claim. */
  unreadable: string[];
}

/**
 * Grant and revoke, over one list of approvals.
 *
 * `rows` is what the caller has already read. The receipt inside `ExitFlow`
 * passes the approvals that exit just used; the Settings card passes everything
 * this wallet has granted. Neither re-derives an amount.
 */
function useApprovalActions(rows: readonly LiveApproval[], onDone: () => void | Promise<void>) {
  const { address } = useAccount();
  const { ensureApprovals, revokeApprovals } = useExitApprovals(address);
  const [busy, setBusy] = useState<"granting" | "revoking" | null>(null);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const grant = useCallback(async () => {
    setBusy("granting");
    setResult(null);
    setFailure(null);
    try {
      const missing = rows.filter((r) => r.current < r.amount);
      const sent = await ensureApprovals(missing, (label) => setStatus(label));
      setResult(
        sent === 0
          ? "Every approval was already in place, so nothing was signed."
          : `${sent} approval${sent === 1 ? "" : "s"} granted.`,
      );
      await onDone();
    } catch (err) {
      const f = classifyExitError(err, EXIT_NETWORK_LABEL);
      console.error("[approvals] grant failed:", f.detail, err);
      setFailure(`${f.message} Nothing was approved.`);
    } finally {
      setBusy(null);
      setStatus("");
    }
  }, [rows, ensureApprovals, onDone]);

  const revoke = useCallback(async () => {
    setBusy("revoking");
    setResult(null);
    setFailure(null);
    try {
      // Only what is actually granted. A wallet with a position on one asset
      // and not another should not be asked to sign an approval of zero over a
      // token it never approved.
      const granted = rows.filter((r) => r.current > 0n);
      // The summary names its failures by SYMBOL, not by the runner's progress
      // line: "aWETH is still granted" is a fact a user can act on, "Approve
      // aWETH collateral transfer is still granted" is a log line.
      const outcomes: RevokeOutcome[] = await revokeApprovals(
        granted.map((r) => ({ ...r, label: r.symbol })),
        () => setStatus("Confirm in your wallet..."),
      );
      // Never "all approvals revoked" unless every receipt came back a success.
      // `revokeSummary` names the ones that did not.
      setResult(revokeSummary(outcomes));
      await onDone();
    } catch (err) {
      const f = classifyExitError(err, EXIT_NETWORK_LABEL);
      console.error("[approvals] revoke failed:", f.detail, err);
      setFailure(`${f.message} Your approvals are unchanged.`);
    } finally {
      setBusy(null);
      setStatus("");
    }
  }, [rows, revokeApprovals, onDone]);

  return { busy, status, result, failure, grant, revoke };
}

/**
 * The receipt's way back out: hand back the permissions the exit just used.
 *
 * The same runner as the Settings card, over the approvals that exit ran with,
 * which is why it needs no chain read of its own. It is a `quiet` control under
 * a success screen: the exit worked, and this is tidying up after it.
 */
export function RevokeExitApprovals({ approvals }: { approvals: readonly ApprovalStep[] }) {
  const { address } = useAccount();
  const { readAllowances } = useExitApprovals(address);
  const [rows, setRows] = useState<LiveApproval[] | null>(null);

  const load = useCallback(async () => {
    try {
      const current = await readAllowances(approvals);
      setRows(
        approvals.map((a, i) => ({
          ...a,
          id: a.token.toLowerCase(),
          current: current[i] ?? 0n,
        })),
      );
    } catch {
      // A read we could not make is not an approval we can promise to revoke.
      setRows([]);
    }
  }, [approvals, readAllowances]);

  useEffect(() => {
    void load();
  }, [load]);

  const { busy, status, result, failure, revoke } = useApprovalActions(rows ?? [], load);
  const live = (rows ?? []).filter((r) => r.current > 0n);

  if (rows === null || (live.length === 0 && result === null)) return null;

  return (
    <div className="space-y-3 border-t border-border-subtle pt-4 text-left">
      {/* Two clauses gone: "you can hand them back now, or leave them in place
          so a future exit is one signature" described both branches of a button
          the reader is looking at. The count is the fact; the control is the
          offer. */}
      <p className="text-xs font-sans leading-relaxed text-text-secondary">
        This exit left {live.length} token approval{live.length === 1 ? "" : "s"} on your wallet.
      </p>
      {result ? <p className="text-xs font-sans text-text-secondary">{result}</p> : null}
      {failure ? <Notice text={failure} /> : null}
      {live.length > 0 ? (
        <Button variant="secondary" onClick={() => void revoke()} disabled={busy !== null}>
          <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />
          {busy === "revoking" ? status || "Revoking" : "Revoke these approvals"}
        </Button>
      ) : null}
    </div>
  );
}

/** The Settings card. */
export function ExitApprovals() {
  const { address, isConnected, chainId } = useAccount();
  const { connect } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: EXIT_CHAIN_ID });
  const { readAllowances } = useExitApprovals(address);

  const chainMode = useChainMode();
  const onChain = isConnected && chainId === EXIT_CHAIN_ID;

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!publicClient || !address || !onChain) return;
    setLoading(true);
    setLoadError(null);
    try {
      const client = asContractClient(publicClient);
      const { reserves, unreadable, noCoverage } = await readUserReserves(client, address);
      if (noCoverage) {
        setLoaded({ rows: [], unreadable: [] });
        setLoadError(
          `No asset on ${EXIT_NETWORK_LABEL} is both listed by Aave V3 and enabled for exits right now, so there is nothing to approve.`,
        );
        return;
      }

      // What a FULL exit would need: the whole debt and the whole deposit. It is
      // the largest of the three plans, so an approval sized here also covers a
      // partial reduce. Same builder, same units, same buffer as the exit modal.
      const { views } = buildExitLegs(reserves, { protocol: PROTOCOL, kind: "full" });

      // aTokens for EVERY reserve, not just the ones with a deposit today: an
      // approval granted before a position was closed is still live, and a
      // revoke-all that could not see it would leave it standing.
      const aTokens = await resolveATokens(
        client,
        reserves.map((r) => ({ reserve: r.reserve, withdraw: 1n })),
      );
      const { steps } = approvalStepsFor(views, EXECUTOR_ADDRESS, aTokens);
      const requiredByToken = new Map(steps.map((s) => [s.token.toLowerCase(), s.amount]));

      // Every token this wallet could have approved, whether or not it holds a
      // position in it now.
      const candidates: { token: `0x${string}`; symbol: string; spec: GrantSpec }[] = [];
      for (const r of reserves) {
        candidates.push({ token: r.reserve, symbol: r.symbol, spec: PROTOCOL_GRANTS[PROTOCOL][0] });
        const aToken = aTokens.get(r.reserve.toLowerCase());
        if (aToken) {
          candidates.push({
            token: aToken,
            symbol: `a${r.symbol}`,
            spec: PROTOCOL_GRANTS[PROTOCOL][1],
          });
        }
      }

      const asSteps: ApprovalStep[] = candidates.map((c) => ({
        token: c.token,
        spender: EXECUTOR_ADDRESS,
        amount: requiredByToken.get(c.token.toLowerCase()) ?? 0n,
        symbol: c.symbol,
        label: `Approve ${c.symbol}`,
      }));
      // Decimals come from each token, never assumed from its underlying: this
      // number scales an amount the user is about to sign for.
      const [allowances, decimals] = await Promise.all([
        readAllowances(asSteps),
        Promise.all(
          candidates.map(
            (c) =>
              client.readContract({
                address: c.token,
                abi: EXIT_ERC20_ABI,
                functionName: "decimals",
              }) as Promise<number | bigint>,
          ),
        ),
      ]);

      const rows: ApprovalRow[] = candidates
        .map((c, i) => ({
          ...asSteps[i],
          id: c.token.toLowerCase(),
          // uint8 token metadata, not a wei amount.
          decimals: Number(decimals[i]),
          spec: c.spec,
          current: allowances[i] ?? 0n,
        }))
        // Nothing needed and nothing granted is not an approval, it is a token
        // this wallet has never touched. Listing every reserve as "not
        // approved" would bury the two rows that matter.
        .filter((r) => r.amount > 0n || r.current > 0n);

      setLoaded({ rows, unreadable });
    } catch (err) {
      const f = classifyExitError(err, EXIT_NETWORK_LABEL);
      console.error("[approvals] load failed:", f.detail, err);
      setLoadError(f.message);
      setLoaded(null);
    } finally {
      setLoading(false);
    }
  }, [publicClient, address, onChain, readAllowances]);

  useEffect(() => {
    if (onChain) void refresh();
    else setLoaded(null);
  }, [onChain, refresh]);

  const { busy, status, result, failure, grant, revoke } = useApprovalActions(
    loaded?.rows ?? [],
    refresh,
  );

  const header = (
    <div className="flex items-center gap-2 border-b border-border-subtle pb-2.5">
      <KeyRound className="h-4 w-4 text-text-primary" />
      <h3 className="text-sm font-sans font-semibold text-text-primary">Exit approvals</h3>
    </div>
  );

  /**
   * The 60-word introduction is gone.
   *
   * It explained what an ERC-20 approval is, why granting one early is
   * convenient, and how this card differs from the standing-permission card
   * below it. Three paragraphs' worth of teaching above a list whose rows
   * already say "Approve USDC" and whose heading already says "Exit approvals",
   * on a settings screen where every card had one. What a reader acts on here
   * is the row list and the one button; what each card grants is named by each
   * card's own revoke control.
   */

  if (!exitsExecutableOn(chainMode) || !isExitExecutable(PROTOCOL)) {
    return (
      <Card tone="raised" className="space-y-3">
        {header}
        <p className="text-xs font-sans leading-relaxed text-text-secondary">
          There is nothing to pre-approve here yet.
        </p>
      </Card>
    );
  }

  if (!isConnected) {
    return (
      <Card tone="raised" className="space-y-3">
        {header}
        <Button onClick={() => connect({ connector: injected() })} className="mt-1">
          <Wallet className="h-3.5 w-3.5" /> Connect wallet
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

  const rows = loaded?.rows ?? [];
  const states: GrantState[] = rows.map((r) => ({
    id: r.id,
    spec: r.spec,
    required: r.amount,
    current: r.current,
  }));
  const coverage = preauthCoverage(states);
  // ONE count, from `preauthCoverage`, used by the sentence and by the button.
  // A local second filter here agreed with it today and was free to stop
  // agreeing, on the two elements a user reads together. A row that is granted
  // but no longer needed (a closed position) requires nothing, so it is covered
  // and never counted toward a signature.
  const missingCount = coverage.missing.length;
  const grantedCount = rows.filter((r) => r.current > 0n).length;
  // Nothing may be claimed about a position we could only partly read.
  const incomplete = (loaded?.unreadable.length ?? 0) > 0;

  return (
    <Card tone="raised" className="space-y-4">
      {header}

      <div className="flex items-center justify-between">
        <h4 className="text-xs font-sans font-bold text-text-primary">
          What you have approved on {PROTOCOL_LABEL[PROTOCOL]}
        </h4>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading || busy !== null}
          aria-label="Refresh your approvals"
          className="inline-flex cursor-pointer items-center gap-1.5 label-type text-2xs text-text-secondary hover:text-text-primary disabled:opacity-40"
        >
          {/* No spin. This look has no motion, and the disabled state plus the
              word below already say the read is in flight. */}
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {loading ? "Reading" : "Refresh"}
        </button>
      </div>

      {loadError ? (
        <EmptyState
          tone="problem"
          title="We could not read your approvals"
          hint={`${loadError} Nothing on-chain has changed. Try Refresh.`}
        />
      ) : loaded === null ? (
        <div aria-busy="true" className="space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : incomplete ? (
        <EmptyState
          tone="problem"
          title="We could not read all of this position"
          hint={`The market would not answer for this wallet's ${loaded.unreadable.join(" and ")} on ${EXIT_NETWORK_LABEL}, so we cannot say what a complete exit would need and nothing is offered here. This is a problem on our side, not with your wallet.`}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          tone="clear"
          title="No approvals granted, and none needed"
          hint={`This wallet holds no Aave V3 position on ${EXIT_NETWORK_LABEL}, so there is nothing for an exit to move. Open one and this card fills in.`}
        />
      ) : (
        <>
          {/* The claim, and it is a measurement rather than a promise: it moves
              the moment interest takes a debt past the buffer it was approved
              with. Neutral throughout - a signature count is not a risk band -
              and the count is a FIGURE now rather than a numeral inside a
              sentence, because it is the one number this card exists to
              report. */}
          <Card tone="set-back" className="space-y-2">
            <LedgerRow
              label="Signatures a full exit costs right now"
              value={String(coverage.signaturesAtPanic)}
            />
            {missingCount > 0 ? (
              <p className="text-xs font-sans leading-relaxed text-text-secondary">
                {missingCount} approval{missingCount === 1 ? "" : "s"} still owed, plus the exit
                itself.
              </p>
            ) : null}
          </Card>

          <ul className="divide-y divide-border-subtle">
            {rows.map((r) => {
              const covered = r.current >= r.amount;
              const stale = r.amount === 0n && r.current > 0n;
              return (
                <li key={r.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  {/* Icon AND words, never hue: "granted" and "not granted" are
                      ordinary states, and this card spends none of the screen's
                      risk-colour budget. */}
                  {covered ? (
                    <CheckCircle2
                      className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary"
                      aria-hidden="true"
                    />
                  ) : (
                    <AlertTriangle
                      className="mt-0.5 h-4 w-4 shrink-0 text-text-muted"
                      aria-hidden="true"
                    />
                  )}
                  <div className="min-w-0 flex-1 space-y-2">
                    <p className="text-sm font-sans font-bold text-text-primary">
                      {r.spec.subject}: {r.symbol}
                    </p>
                    <p className="text-xs font-sans leading-relaxed text-text-secondary">
                      {r.spec.permits}
                    </p>
                    {/* Never a bare "0": a row with no allowance says so in
                        words, and the figure appears only when there is one to
                        state. The two amounts sit one above the other so the
                        comparison the reader is making is a vertical one. */}
                    {r.current > 0n ? (
                      <LedgerRow
                        label={`Approved, ${r.symbol}`}
                        value={formatTokenAmount(r.current, r.decimals)}
                      />
                    ) : (
                      <p className="text-xs font-sans text-text-secondary">Not approved.</p>
                    )}
                    {r.amount > 0n ? (
                      <LedgerRow
                        label={`An exit needs, ${r.symbol}`}
                        value={formatTokenAmount(withAccrualBuffer(r.amount), r.decimals)}
                      />
                    ) : null}
                    {stale ? (
                      <p className="text-xs font-sans text-text-secondary">
                        An exit does not need this one any more.
                      </p>
                    ) : null}
                    {!covered && r.current > 0n ? (
                      <p className="text-xs font-sans text-text-secondary">
                        Short of what an exit would need.
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>

          {result ? <p className="text-xs font-sans text-text-secondary">{result}</p> : null}
          {failure ? <Notice text={failure} /> : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void grant()}
              disabled={busy !== null || missingCount === 0}
              title={missingCount === 0 ? "Every approval an exit needs is already granted" : undefined}
            >
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
              {busy === "granting"
                ? status || "Sign in wallet"
                : missingCount === 0
                  ? "All approvals granted"
                  : `Approve ${missingCount} token movement${missingCount === 1 ? "" : "s"}`}
            </Button>
            {grantedCount > 0 ? (
              <Button variant="secondary" onClick={() => void revoke()} disabled={busy !== null}>
                <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />
                {busy === "revoking"
                  ? status || "Revoking"
                  : `Revoke all ${grantedCount} token approval${grantedCount === 1 ? "" : "s"}`}
              </Button>
            ) : null}
          </div>

          {/* The money-path facts, and DESIGN_SYSTEM's copy test keeps them: the
              buffer figure is the engine constant, not a literal, so it cannot
              drift from the amount actually approved. The last sentence is gone
              ("borrow more, or let interest run past that buffer, and the exit
              will ask you to top the approval up") - it described what the exit
              modal will do when it gets there, on a card whose rows already
              show, per token, what is approved against what is needed. */}
          <p className="text-2xs font-sans leading-relaxed text-text-muted">
            Each approval covers the exact amount an exit needs plus{" "}
            <span className="font-mono font-bold">{ACCRUAL_BUFFER_PCT.toString()}%</span> for
            interest, never unlimited. Every transaction is simulated before you sign it.
          </p>
        </>
      )}
    </Card>
  );
}
