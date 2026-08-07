/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { useAccount, useReadContract } from "wagmi";
import {
  ESCROW_ABI,
  getEscrowAddress,
  getEscrowChainId,
  DEPOSIT_DISPLAY,
} from "../lib/contracts";

/**
 * Displays live on-chain escrow stats: depositor count, contract balance info,
 * and the connected wallet's status.
 */
export function EscrowStats() {
  const { address, isConnected } = useAccount();

  // Check if contract is configured
  let escrowAddress: `0x${string}` | null = null;
  try {
    escrowAddress = getEscrowAddress();
  } catch {
    // Contract not deployed yet — show placeholder
  }

  const chainId = getEscrowChainId();

  // Read depositor count
  const { data: depositorCount } = useReadContract(
    escrowAddress
      ? {
          address: escrowAddress,
          abi: ESCROW_ABI,
          functionName: "depositorCount",
          chainId,
        }
      : undefined
  );

  // Read connected user's deposit info
  const { data: depositInfo } = useReadContract(
    escrowAddress && address
      ? {
          address: escrowAddress,
          abi: ESCROW_ABI,
          functionName: "getDepositInfo",
          args: [address],
          chainId,
        }
      : undefined
  );

  // Read global refund deadline
  const { data: refundDeadline } = useReadContract(
    escrowAddress
      ? {
          address: escrowAddress,
          abi: ESCROW_ABI,
          functionName: "refundDeadline",
          chainId,
        }
      : undefined
  );

  const count =
    depositorCount !== undefined ? Number(depositorCount) : null;
  const hasPaid = depositInfo ? depositInfo[0] > 0n : false;
  const isShipped = depositInfo ? depositInfo[1] : false;
  const isRefunded = depositInfo ? depositInfo[2] : false;

  const deadlineTimestamp = refundDeadline ? Number(refundDeadline) : null;
  const deadlineDate = deadlineTimestamp ? new Date(deadlineTimestamp * 1000) : null;
  
  // Calculate remaining days
  const daysRemaining = deadlineDate
    ? Math.max(0, Math.ceil((deadlineDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;

  // Basescan link
  const basescanUrl =
    chainId === 8453
      ? `https://basescan.org/address/${escrowAddress}`
      : `https://sepolia.basescan.org/address/${escrowAddress}`;

  return (
    <div className="panik-glass rounded-md p-6">
      <h3 className="font-sans font-semibold text-sm text-text-secondary mb-4 uppercase tracking-wider">
        Escrow Status
      </h3>

      <div className="grid grid-cols-2 gap-4 mb-4">
        {/* Founding users count */}
        <div className="bg-white/[0.03] rounded-md p-4 text-center">
          <div className="font-sans text-2xl font-bold text-panik-orange mb-1 tabular-nums">
            {count !== null ? count : "…"}
          </div>
          <div className="text-2xs text-text-muted uppercase tracking-wide">
            Founding Users
          </div>
        </div>

        {/* Deposit amount */}
        <div className="bg-white/[0.03] rounded-md p-4 text-center">
          <div className="font-sans text-2xl font-bold text-text-secondary mb-1 tabular-nums">
            {DEPOSIT_DISPLAY}
            <span className="text-sm text-text-muted ml-1">USDC</span>
          </div>
          <div className="text-2xs text-text-muted uppercase tracking-wide">
            Per Deposit
          </div>
        </div>
      </div>

      {/* Global deadline countdown */}
      {deadlineDate && (
        <div className="mb-4 text-xs flex justify-between items-center bg-white/[0.02] border border-border-subtle rounded-md p-3">
          <span className="text-text-muted">Launch Target:</span>
          <span className="font-mono text-text-secondary">
            {isShipped ? (
              <span className="text-risk-low font-semibold">Shipped!</span>
            ) : daysRemaining !== null && daysRemaining > 0 ? (
              <span className="tabular-nums">{daysRemaining} days left</span>
            ) : (
              <span className="text-risk-critical font-semibold">Refund period active</span>
            )}
          </span>
        </div>
      )}

      {/* Contract address */}
      {escrowAddress && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-text-muted">Contract:</span>
          <a
            href={basescanUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-panik-orange/70 hover:text-panik-orange transition-colors truncate"
            id="escrow-contract-link"
          >
            {escrowAddress.slice(0, 6)}…{escrowAddress.slice(-4)}
          </a>
          <span className="text-white/20">·</span>
          <span className="text-text-muted font-mono">
            {chainId === 8453 ? "Base" : "Base Sepolia"}
          </span>
        </div>
      )}

      {!escrowAddress && (
        <div className="text-xs text-text-muted font-mono text-center py-2">
          Contract not deployed yet
        </div>
      )}

      {/* Connected user's status */}
      {isConnected && hasPaid && (
        <div className="mt-4 pt-4 border-t border-border-subtle">
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`inline-block w-2 h-2 rounded-full ${isRefunded ? "bg-white/30" : isShipped ? "bg-risk-low" : "bg-panik-orange"}`}
            />
            <span className="text-text-muted">
              {isRefunded
                ? "Refunded"
                : isShipped
                  ? "PANIK is Shipped! Founding user active"
                  : "Deposit held in escrow"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
