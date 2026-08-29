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
import { AlertTriangle, CheckCircle2, KeyRound, ShieldOff, Wallet } from "lucide-react";
import { useAccount, useConnect, usePublicClient, useSwitchChain } from "wagmi";
import { injected } from "wagmi/connectors";
import { EXECUTOR_ADDRESS, EXIT_CHAIN_ID } from "../lib/exit.generated";
import { asContractClient, EXIT_ERC20_ABI, EXIT_NETWORK_LABEL, getExitChain, isExitExecutable } from "../lib/exit";
import { exitsExecutableOn, useChainMode } from "../lib/chainMode";
import { classifyExitError } from "../lib/exitRpc";
import { readUserReserves } from "../lib/exitPosition";
import { resolveATokens } from "../lib/exitReserves";
import {
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
import { Button, Card, EmptyState, Notice, Skeleton } from "../ui";
import {
  SettingsCard,
  SettingsCardBlock,
  SettingsCardTitle,
  SettingsRow,
} from "./SettingsCard";

/**
 * One approval figure, in a ledger line. The four-branch sentence this replaces
 * ("Approved for X, which covers the Y an exit would need") set its amounts in
 * Archivo inside prose, which is the one thing this system's type rule forbids:
 * a figure is a reading and reads in mono, and two amounts buried mid-sentence
 * cannot be compared at a glance, which is the entire question the row answers.
 */
function LedgerRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <span className="font-sans text-xs text-text-secondary">{label}</span>
      <span className="ml-auto font-mono text-xs font-bold tabular-nums text-text-primary">
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
          ? "Nothing to sign."
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
      {/* The count is the fact and the button is the offer. The sentence over
          them ("This exit left N token approvals on your wallet. You can hand
          them back now, or leave them in place so a future exit is one
          signature") described both branches of a control the reader is looking
          at. */}
      <LedgerRow label="Approvals still live" value={String(live.length)} />
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
          `Nothing on ${EXIT_NETWORK_LABEL} can be approved right now.`,
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

  // The Settings tab's shared title row, so this card's heading sits on the
  // same 3px rule at the same size as the five beside it. Only the shape moved;
  // what the card does below it is unchanged.
  const header = <SettingsCardTitle icon={KeyRound} title="Exit approvals" />;

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
    // Nothing can be approved on this chain, so nothing is: the ledger row
    // states the count the reader came for, in the column every other value on
    // the tab is read down. The sentence it replaces said the same thing in
    // seven words and in a different place on the card from its neighbours.
    return (
      <SettingsCard>
        {header}
        <SettingsRow label="Granted" value="None" />
      </SettingsCard>
    );
  }

  if (!isConnected) {
    return (
      <SettingsCard>
        {header}
        <SettingsCardBlock>
          <Button onClick={() => connect({ connector: injected() })}>
            <Wallet className="h-3.5 w-3.5" /> Connect wallet
          </Button>
        </SettingsCardBlock>
      </SettingsCard>
    );
  }

  if (!onChain) {
    return (
      <SettingsCard>
        {header}
        <SettingsCardBlock>
          <Button onClick={() => void switchChainAsync({ chainId: EXIT_CHAIN_ID })}>
            Switch to {getExitChain().name}
          </Button>
        </SettingsCardBlock>
      </SettingsCard>
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
    <SettingsCard>
      {header}
      <SettingsCardBlock>
        <div className="space-y-4">

      {/* No "What you have approved on Aave V3" sub-heading and no Refresh
          link: the card's own heading names the subject, and both buttons
          re-read the list when they finish. A failed read still needs a way
          back, so Retry rides on the empty state that reports it - one control
          on the one branch that needs it, rather than a link on every branch.

          Every `hint` is gone too. The titles are the statements; the
          sentences under them said "this is a problem on our side, not with
          your wallet" and "open one and this card fills in", which is the
          hatch and the heading in another twenty words. */}
      {loadError ? (
        <EmptyState
          tone="problem"
          title="Could not read your approvals"
          action={
            <Button variant="secondary" onClick={() => void refresh()} disabled={loading}>
              Retry
            </Button>
          }
        />
      ) : loaded === null ? (
        <div aria-busy="true" className="space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : incomplete ? (
        <EmptyState
          tone="problem"
          title={`Could not read this wallet's ${loaded.unreadable.join(" and ")}`}
          action={
            <Button variant="secondary" onClick={() => void refresh()} disabled={loading}>
              Retry
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState tone="clear" title="No approvals granted, and none needed" />
      ) : (
        <>
          {/* The claim, and it is a measurement rather than a promise: it moves
              the moment interest takes a debt past the buffer it was approved
              with. Neutral throughout, because a signature count is not a risk
              band, and two rows rather than a figure with a sentence under it
              breaking the figure down. */}
          <Card tone="set-back" className="space-y-2">
            <LedgerRow
              label="Signatures a full exit costs now"
              value={String(coverage.signaturesAtPanic)}
            />
            {missingCount > 0 ? (
              <LedgerRow label="Approvals still owed" value={String(missingCount)} />
            ) : null}
          </Card>

          <ul className="divide-y divide-border-subtle">
            {rows.map((r) => {
              const covered = r.current >= r.amount;
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
                    {/* Two figures, one above the other, because the comparison
                        the reader is making is a vertical one. The three state
                        sentences under them are gone ("Not approved.", "An exit
                        does not need this one any more.", "Short of what an
                        exit would need."): the icon carries covered against not
                        covered, and the rows carry by how much. So is
                        `spec.permits`, which explained what an ERC-20 approval
                        lets the executor do, once per row.

                        "None" rather than a bare 0 for an ungranted token: the
                        allowance is genuinely zero, and the word says so
                        without a numeral that could be misread as an amount. */}
                    <LedgerRow
                      label={`Approved, ${r.symbol}`}
                      value={
                        r.current > 0n ? formatTokenAmount(r.current, r.decimals) : "None"
                      }
                    />
                    {r.amount > 0n ? (
                      <LedgerRow
                        label={`An exit needs, ${r.symbol}`}
                        value={formatTokenAmount(withAccrualBuffer(r.amount), r.decimals)}
                      />
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

        </>
      )}
        </div>
      </SettingsCardBlock>
    </SettingsCard>
  );
}
