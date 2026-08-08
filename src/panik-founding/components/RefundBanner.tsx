/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import {
  useAccount,
  useReadContract,
  useSwitchChain,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import {
  ESCROW_ABI,
  getEscrowAddress,
  getEscrowChainId,
  getTargetChain,
  DEPOSIT_DISPLAY,
} from "../lib/contracts";

/**
 * Conditional refund banner. Only shows when the escrow's global refund
 * deadline has passed without release and the connected wallet is owed a
 * refund. Lets the user claim their refund directly from the contract.
 */
export function RefundBanner() {
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const { switchChain } = useSwitchChain();

  let escrowAddress: `0x${string}` | null = null;
  try {
    escrowAddress = getEscrowAddress();
  } catch {
    // not deployed — hooks still run below, the render guard handles it
  }

  const chainId = getEscrowChainId();
  const targetChain = getTargetChain();

  // Check if the connected wallet is refundable
  const { data: isRefundable, isError: isRefundableError } = useReadContract(
    escrowAddress && address
      ? {
          address: escrowAddress,
          abi: ESCROW_ABI,
          functionName: "isRefundable",
          args: [address],
          chainId,
        }
      : undefined
  );

  // Read deadline for display
  const { data: deadline } = useReadContract(
    escrowAddress
      ? {
          address: escrowAddress,
          abi: ESCROW_ABI,
          functionName: "refundDeadline",
          chainId,
        }
      : undefined
  );

  // Write: claim refund
  const {
    writeContract: writeClaim,
    data: claimTxHash,
    isPending: isClaiming,
    error: claimError,
  } = useWriteContract();

  // Wait for claim tx. A reverted tx still produces a receipt, so the
  // on-chain status decides whether the claim actually went through.
  const { data: claimReceipt } = useWaitForTransactionReceipt({
    hash: claimTxHash,
  });
  const claimConfirmed = claimReceipt?.status === "success";
  const claimReverted = claimReceipt?.status === "reverted";

  // TanStack Query keeps the last successful `data` while `status` flips to
  // "error", so isError and a usable isRefundable routinely co-exist on a
  // background refetch failure (refocus + rate-limited public RPC). Only treat
  // it as an error when there is genuinely nothing to go on — otherwise the
  // error card would replace a working claim button.
  const readFailed = isRefundableError && isRefundable === undefined;

  // Contract not deployed / address invalid — nothing to claim against.
  if (!escrowAddress) return null;
  // Don't render if not connected, or the read says the wallet isn't refundable.
  // A FAILED read leaves `isRefundable` undefined; hiding the banner there
  // would silently block withdrawals, so surface an error card instead.
  if (!isConnected) return null;
  if (!isRefundable && !readFailed) return null;

  const handleClaim = () => {
    if (!escrowAddress) return;
    writeClaim({
      address: escrowAddress,
      abi: ESCROW_ABI,
      functionName: "claimRefund",
      chainId,
    });
  };

  const basescanHost =
    chainId === 8453 ? "https://basescan.org" : "https://sepolia.basescan.org";
  const basescanTxUrl = `${basescanHost}/tx/${claimTxHash}`;
  const basescanAddressUrl = `${basescanHost}/address/${escrowAddress}#writeContract`;

  const deadlineDate = deadline
    ? new Date(Number(deadline) * 1000).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  // Already claimed
  if (claimConfirmed) {
    return (
      <div className="rounded-md p-6 bg-risk-low/[0.08] border border-risk-low/20">
        <div className="flex items-start gap-3">
          <span className="text-2xl">✅</span>
          <div>
            <h4 className="font-sans font-semibold text-risk-low text-sm mb-1">
              Refund claimed
            </h4>
            <p className="text-xs text-text-muted mb-2">
              Your {DEPOSIT_DISPLAY} USDC has been returned to your wallet.
            </p>
            {claimTxHash && (
              <a
                href={basescanTxUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-risk-low/70 hover:text-risk-low font-mono underline underline-offset-2 transition-colors"
                id="refund-tx-link"
              >
                View transaction ↗
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Refund status could not be read AND no cached answer exists — never hide
  // the refund path on a failed read, or depositors past the deadline see
  // nothing at all. `readFailed` implies isRefundable === undefined, so this
  // can never pre-empt the claim button below.
  if (readFailed) {
    return (
      <div className="rounded-md p-6 bg-risk-critical/[0.06] border border-risk-critical/20">
        <div className="flex items-start gap-3">
          <span className="text-2xl">⚠️</span>
          <div>
            <h4 className="font-sans font-semibold text-risk-critical text-sm mb-1">
              Can't reach the escrow contract
            </h4>
            <p className="text-xs text-text-muted">
              Refunds still exist on-chain and remain claimable after the global
              escrow deadline{deadlineDate ? ` (${deadlineDate})` : ""}. This app
              just can't read your refund status right now. Retry shortly, or call{" "}
              <code className="text-panik-orange/60">claimRefund()</code> directly on{" "}
              <a
                href={basescanAddressUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-panik-orange hover:text-panik-orange underline underline-offset-2 transition-colors"
              >
                Basescan ↗
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Wrong network — the claim would never reach the escrow chain.
  if (walletChainId !== undefined && walletChainId !== chainId) {
    return (
      <div className="rounded-md p-6 bg-risk-elevated/[0.06] border border-risk-elevated/20">
        <div className="flex items-start gap-3">
          <span className="text-2xl">⛓️</span>
          <div className="flex-1">
            <h4 className="font-sans font-semibold text-risk-elevated text-sm mb-1">
              Refund available
            </h4>
            <p className="text-xs text-text-muted mb-1">
              Switch to <strong className="text-text-secondary">{targetChain.name}</strong>{" "}
              to claim your {DEPOSIT_DISPLAY} USDC back.
            </p>
            <button
              onClick={() => switchChain({ chainId })}
              className="mt-3 w-full py-3 px-5 rounded-md font-semibold text-sm bg-panik-orange text-surface-base active:scale-[0.98] transition-all shadow-lg shadow-risk-elevated/20"
              id="refund-switch-chain-btn"
            >
              Switch to {targetChain.name}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md p-6 bg-risk-elevated/[0.06] border border-risk-elevated/20">
      <div className="flex items-start gap-3">
        <span className="text-2xl">⏰</span>
        <div className="flex-1">
          <h4 className="font-sans font-semibold text-risk-elevated text-sm mb-1">
            Refund available
          </h4>
          <p className="text-xs text-text-muted mb-1">
            The global escrow deadline passed{deadlineDate ? ` on ${deadlineDate}` : ""} without release.
            You can claim your {DEPOSIT_DISPLAY} USDC back.
          </p>

          {(claimError || claimReverted) && (
            <p className="text-xs text-risk-critical mt-2 mb-2">
              {claimError?.message.includes("User rejected")
                ? "Transaction rejected."
                : claimReverted
                  ? "Claim reverted on-chain. Please try again."
                  : "Claim failed. Please try again."}
            </p>
          )}

          <button
            onClick={handleClaim}
            disabled={isClaiming}
            className="mt-3 w-full py-3 px-5 rounded-md font-semibold text-sm bg-panik-orange text-surface-base active:scale-[0.98] transition-all shadow-lg shadow-risk-elevated/20 disabled:opacity-50 disabled:cursor-not-allowed"
            id="claim-refund-btn"
          >
            {isClaiming ? (
              <span className="flex items-center justify-center gap-2">
                <span className="inline-block w-4 h-4 border-[1.5px] border-border-subtle border-t-panik-orange rounded-full animate-spin" />
                Claiming…
              </span>
            ) : (
              `Claim ${DEPOSIT_DISPLAY} USDC Refund`
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
