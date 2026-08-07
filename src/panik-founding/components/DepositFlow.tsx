/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { injected } from "wagmi/connectors";
import {
  ESCROW_ABI,
  ERC20_ABI,
  getEscrowAddress,
  getEscrowChainId,
  getTargetChain,
  getUsdcAddress,
  DEPOSIT_AMOUNT,
  DEPOSIT_DISPLAY,
} from "../lib/contracts";

type FlowStep =
  | "connect"
  | "wrong-chain"
  | "check-balance"
  | "approve"
  | "deposit"
  | "pending"
  | "success"
  | "already-paid"
  | "error"
  | "no-contract"
  | "shipped-ended"
  | "deadline-passed";

export function DepositFlow() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  const [step, setStep] = useState<FlowStep>("connect");
  const [errorMsg, setErrorMsg] = useState("");
  /**
   * Wallet-level failures (user rejection) never produce a receipt, so nothing
   * in the step effect's dependency list remembers them. Held here so a
   * background refetch of the balance/allowance reads cannot silently erase
   * the message — as sticky as the revert-derived errors, cleared by Retry.
   */
  const [walletErrorMsg, setWalletErrorMsg] = useState<string | null>(null);

  // Contract config
  let escrowAddress: `0x${string}` | null = null;
  try {
    escrowAddress = getEscrowAddress();
  } catch {
    // not deployed
  }

  const targetChainId = getEscrowChainId();
  const targetChain = getTargetChain();
  let usdcAddress: `0x${string}` | null = null;
  try {
    usdcAddress = getUsdcAddress();
  } catch {
    // no USDC for this chain
  }

  // Read: has user already deposited?
  const { data: hasPaid } = useReadContract(
    escrowAddress && address
      ? {
          address: escrowAddress,
          abi: ESCROW_ABI,
          functionName: "hasPaid",
          args: [address],
          chainId: targetChainId,
        }
      : undefined
  );

  // Read: global refund deadline
  const { data: refundDeadline } = useReadContract(
    escrowAddress
      ? {
          address: escrowAddress,
          abi: ESCROW_ABI,
          functionName: "refundDeadline",
          chainId: targetChainId,
        }
      : undefined
  );

  // Read: global shipped state
  const { data: shipped } = useReadContract(
    escrowAddress
      ? {
          address: escrowAddress,
          abi: ESCROW_ABI,
          functionName: "shipped",
          chainId: targetChainId,
        }
      : undefined
  );

  const hasDeadlinePassed = refundDeadline
    ? BigInt(Math.floor(Date.now() / 1000)) >= refundDeadline
    : false;

  // The contract has ONE global refund deadline, not a per-depositor window.
  const refundDeadlineDate = refundDeadline
    ? new Date(Number(refundDeadline) * 1000).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  // Read: USDC balance
  const { data: usdcBalance } = useReadContract(
    usdcAddress && address
      ? {
          address: usdcAddress,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
          chainId: targetChainId,
        }
      : undefined
  );

  // Read: USDC allowance
  const { data: usdcAllowance } = useReadContract(
    usdcAddress && address && escrowAddress
      ? {
          address: usdcAddress,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [address, escrowAddress],
          chainId: targetChainId,
        }
      : undefined
  );

  // Write: approve USDC
  const {
    writeContract: writeApprove,
    data: approveTxHash,
    isPending: isApproving,
    error: approveError,
    reset: resetApprove,
  } = useWriteContract();

  // Write: deposit
  const {
    writeContract: writeDeposit,
    data: depositTxHash,
    isPending: isDepositing,
    error: depositError,
    reset: resetDeposit,
  } = useWriteContract();

  // Wait for approve tx. `isSuccess` only means the receipt was fetched — a
  // reverted tx still resolves, so the on-chain status has to be checked.
  const { data: approveReceipt } = useWaitForTransactionReceipt({
    hash: approveTxHash,
  });
  const approveConfirmed = approveReceipt?.status === "success";
  const approveReverted = approveReceipt?.status === "reverted";

  // Wait for deposit tx
  const { data: depositReceipt } = useWaitForTransactionReceipt({
    hash: depositTxHash,
  });
  const depositConfirmed = depositReceipt?.status === "success";
  const depositReverted = depositReceipt?.status === "reverted";

  // Determine flow step based on state
  useEffect(() => {
    if (!escrowAddress) {
      setStep("no-contract");
      return;
    }
    if (shipped) {
      setStep("shipped-ended");
      return;
    }
    if (hasDeadlinePassed) {
      setStep("deadline-passed");
      return;
    }
    if (!isConnected) {
      setStep("connect");
      return;
    }
    if (hasPaid) {
      setStep("already-paid");
      return;
    }
    // A confirmed deposit outranks the network check: switching networks after
    // a successful deposit must not replace the receipt with "wrong network".
    if (depositConfirmed) {
      setStep("success");
      return;
    }
    // `chain` is undefined when the wallet sits on a chain missing from the
    // wagmi config, so guard on `chainId` (which is always reported) instead.
    if (chainId !== undefined && chainId !== targetChainId) {
      setStep("wrong-chain");
      return;
    }
    if (walletErrorMsg) {
      setErrorMsg(walletErrorMsg);
      setStep("error");
      return;
    }
    if (depositReverted) {
      setErrorMsg("Deposit transaction reverted on-chain. Please try again.");
      setStep("error");
      return;
    }
    if (depositTxHash || isDepositing) {
      setStep("pending");
      return;
    }
    if (approveReverted) {
      setErrorMsg("Approval transaction reverted on-chain. Please try again.");
      setStep("error");
      return;
    }
    if (approveConfirmed || (usdcAllowance !== undefined && usdcAllowance >= DEPOSIT_AMOUNT)) {
      setStep("deposit");
      return;
    }
    if (approveTxHash || isApproving) {
      setStep("pending");
      return;
    }
    if (usdcBalance !== undefined && usdcBalance < DEPOSIT_AMOUNT) {
      setStep("check-balance");
      return;
    }
    setStep("approve");
  }, [
    escrowAddress,
    isConnected,
    hasPaid,
    chainId,
    targetChainId,
    usdcBalance,
    usdcAllowance,
    approveTxHash,
    approveConfirmed,
    approveReverted,
    isApproving,
    depositTxHash,
    depositConfirmed,
    depositReverted,
    isDepositing,
    shipped,
    hasDeadlinePassed,
    walletErrorMsg,
  ]);

  // Latch wallet errors. The step effect above owns the transition to "error"
  // so a refetch cannot re-derive its way past a rejection.
  useEffect(() => {
    if (approveError) {
      setWalletErrorMsg(
        approveError.message.includes("User rejected")
          ? "Transaction rejected by wallet."
          : "Approval failed. Please try again."
      );
    }
    if (depositError) {
      setWalletErrorMsg(
        depositError.message.includes("User rejected")
          ? "Transaction rejected by wallet."
          : "Deposit failed. Please try again."
      );
    }
  }, [approveError, depositError]);

  const handleConnect = () => {
    connect({ connector: injected() });
  };

  const handleSwitchChain = () => {
    switchChain({ chainId: targetChainId });
  };

  const handleApprove = () => {
    if (!usdcAddress || !escrowAddress) return;
    writeApprove({
      address: usdcAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [escrowAddress, DEPOSIT_AMOUNT],
      chainId: targetChainId,
    });
  };

  const handleDeposit = () => {
    if (!escrowAddress) return;
    writeDeposit({
      address: escrowAddress,
      abi: ESCROW_ABI,
      functionName: "deposit",
      chainId: targetChainId,
    });
  };

  const handleRetry = () => {
    setErrorMsg("");
    // Clear the failed tx hashes AND the latched wallet error so the step
    // effect doesn't re-enter "error".
    setWalletErrorMsg(null);
    resetApprove();
    resetDeposit();
    setStep("approve");
  };

  const basescanTxUrl = (hash: string) =>
    targetChainId === 8453
      ? `https://basescan.org/tx/${hash}`
      : `https://sepolia.basescan.org/tx/${hash}`;

  return (
    <div className="panik-glass rounded-md p-6">
      <h3 className="font-display font-semibold text-sm text-text-secondary mb-5 uppercase tracking-wider">
        Deposit
      </h3>

      {/* ─── No contract ─── */}
      {step === "no-contract" && (
        <div className="text-center py-8">
          <div className="text-2xl mb-3">🔧</div>
          <p className="text-sm text-text-muted mb-1">
            Contract not deployed yet.
          </p>
          <p className="text-xs text-text-muted">
            Set <code className="text-panik-orange/60">VITE_ESCROW_CONTRACT_ADDRESS</code> in your <code className="text-panik-orange/60">.env</code> file.
          </p>
        </div>
      )}

      {/* ─── Shipped Ended ─── */}
      {step === "shipped-ended" && (
        <div className="text-center py-8">
          <div className="text-2xl mb-3">🚀</div>
          <h4 className="font-display font-semibold text-text-primary mb-2">
            PANIK has launched!
          </h4>
          <p className="text-sm text-text-muted">
            The escrow program has ended because the product is officially live on Base mainnet. Thank you to all our backers!
          </p>
        </div>
      )}

      {/* ─── Deadline Passed ─── */}
      {step === "deadline-passed" && (
        <div className="text-center py-8">
          <div className="text-2xl mb-3">⏳</div>
          <h4 className="font-display font-semibold text-text-primary mb-2">
            Deposits Closed
          </h4>
          <p className="text-sm text-text-muted">
            The global 90-day escrow deadline has been reached. Deposits are closed. If you were a depositor, you can claim your refund below.
          </p>
        </div>
      )}

      {/* ─── Connect wallet ─── */}
      {step === "connect" && (
        <div className="text-center py-4">
          <p className="text-sm text-text-muted mb-5">
            Connect your wallet to deposit {DEPOSIT_DISPLAY} USDC and become a founding user.
          </p>
          <button
            onClick={handleConnect}
            disabled={isConnecting}
            className="w-full py-3.5 px-6 rounded-md font-semibold text-sm bg-panik-orange text-surface-base active:scale-[0.98] transition-all duration-200 shadow-lg shadow-panik-orange/20 hover:shadow-panik-orange/30 disabled:opacity-50 disabled:cursor-not-allowed"
            id="connect-wallet-btn"
          >
            {isConnecting ? (
              <span className="flex items-center justify-center gap-2">
                <Spinner /> Connecting…
              </span>
            ) : (
              "Connect Wallet"
            )}
          </button>
        </div>
      )}

      {/* ─── Wrong chain ─── */}
      {step === "wrong-chain" && (
        <div className="text-center py-4">
          <div className="text-2xl mb-3">⛓️</div>
          <p className="text-sm text-text-muted mb-1">Wrong network detected.</p>
          <p className="text-xs text-text-muted mb-5">
            Please switch to <strong className="text-text-secondary">{targetChain.name}</strong> to continue.
          </p>
          <button
            onClick={handleSwitchChain}
            className="w-full py-3 px-6 rounded-md font-semibold text-sm bg-panik-orange text-surface-base active:scale-[0.98] transition-all shadow-lg shadow-panik-orange/20"
            id="switch-chain-btn"
          >
            Switch to {targetChain.name}
          </button>
          <WalletInfo address={address} onDisconnect={disconnect} />
        </div>
      )}

      {/* ─── Insufficient balance ─── */}
      {step === "check-balance" && (
        <div className="text-center py-4">
          <div className="text-2xl mb-3">💸</div>
          <p className="text-sm text-text-muted mb-1">Insufficient USDC balance.</p>
          <p className="text-xs text-text-muted mb-4">
            You need at least {DEPOSIT_DISPLAY} USDC on {targetChain.name}.
          </p>
          <div className="bg-white/[0.03] rounded-md p-4 mb-4">
            <p className="text-xs text-text-muted mb-2">Need USDC on Base?</p>
            <div className="flex gap-2 justify-center">
              <a
                href="https://bridge.base.org"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-panik-orange hover:text-panik-orange underline underline-offset-2 transition-colors"
              >
                Bridge from Ethereum
              </a>
              <span className="text-white/20">·</span>
              <a
                href="https://www.coinbase.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-panik-orange hover:text-panik-orange underline underline-offset-2 transition-colors"
              >
                Buy on Coinbase
              </a>
            </div>
          </div>
          <p className="text-xs text-white/20 font-mono tabular-nums">
            Balance: {usdcBalance !== undefined ? (Number(usdcBalance) / 1e6).toFixed(2) : "…"} USDC
          </p>
          <WalletInfo address={address} onDisconnect={disconnect} />
        </div>
      )}

      {/* ─── Approve ─── */}
      {step === "approve" && (
        <div className="py-4">
          <div className="bg-white/[0.03] rounded-md p-4 mb-5">
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-text-muted">Deposit amount</span>
              <span className="font-mono text-text-secondary tabular-nums">
                {DEPOSIT_DISPLAY} USDC
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-muted">Network</span>
              <span className="font-mono text-text-muted">{targetChain.name}</span>
            </div>
          </div>
          <p className="text-xs text-text-muted mb-4 text-center">
            Step 1 of 2: Approve USDC spending, then deposit.
          </p>
          <button
            onClick={handleApprove}
            disabled={isApproving}
            className="w-full py-3.5 px-6 rounded-md font-semibold text-sm bg-panik-orange text-surface-base active:scale-[0.98] transition-all shadow-lg shadow-panik-orange/20 disabled:opacity-50 disabled:cursor-not-allowed"
            id="approve-usdc-btn"
          >
            {isApproving ? (
              <span className="flex items-center justify-center gap-2">
                <Spinner /> Approving…
              </span>
            ) : (
              `Approve ${DEPOSIT_DISPLAY} USDC`
            )}
          </button>
          <WalletInfo address={address} onDisconnect={disconnect} />
        </div>
      )}

      {/* ─── Deposit (after approval) ─── */}
      {step === "deposit" && (
        <div className="py-4">
          <div className="flex items-center gap-2 mb-5 justify-center">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-risk-low/20 text-risk-low text-xs">
              ✓
            </span>
            <span className="text-xs text-risk-low/80">USDC approved</span>
          </div>
          <p className="text-xs text-text-muted mb-4 text-center">
            Step 2 of 2: Confirm the deposit transaction.
          </p>
          <button
            onClick={handleDeposit}
            disabled={isDepositing}
            className="w-full py-3.5 px-6 rounded-md font-semibold text-sm bg-panik-orange text-surface-base active:scale-[0.98] transition-all shadow-lg shadow-panik-orange/20 disabled:opacity-50 disabled:cursor-not-allowed"
            id="deposit-btn"
          >
            {isDepositing ? (
              <span className="flex items-center justify-center gap-2">
                <Spinner /> Confirming…
              </span>
            ) : (
              `Deposit ${DEPOSIT_DISPLAY} USDC`
            )}
          </button>
          <WalletInfo address={address} onDisconnect={disconnect} />
        </div>
      )}

      {/* ─── Pending ─── */}
      {step === "pending" && (
        <div className="text-center py-8">
          <div className="mb-4">
            <Spinner size="lg" />
          </div>
          <p className="text-sm text-text-muted mb-2">
            Transaction pending…
          </p>
          <p className="text-xs text-text-muted">
            Waiting for on-chain confirmation.
          </p>
          {(approveTxHash || depositTxHash) && (
            <a
              href={basescanTxUrl((depositTxHash || approveTxHash)!)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-3 text-xs text-panik-orange/70 hover:text-panik-orange font-mono underline underline-offset-2 transition-colors"
            >
              View on Basescan ↗
            </a>
          )}
        </div>
      )}

      {/* ─── Success ─── */}
      {step === "success" && (
        <div className="text-center py-6">
          <div className="text-4xl mb-3">🎉</div>
          <h4 className="font-display font-bold text-lg text-text-primary mb-2">
            You're a founding user!
          </h4>
          <p className="text-sm text-text-muted mb-4">
            Your {DEPOSIT_DISPLAY} USDC is held in escrow. The escrow has a single
            global deadline{refundDeadlineDate ? ` of ${refundDeadlineDate}` : ""}.
            If we haven't shipped by then, come back to claim your refund.
          </p>
          {depositTxHash && (
            <a
              href={basescanTxUrl(depositTxHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-panik-orange hover:text-panik-orange font-mono underline underline-offset-2 transition-colors"
              id="success-tx-link"
            >
              View transaction ↗
            </a>
          )}
        </div>
      )}

      {/* ─── Already paid ─── */}
      {step === "already-paid" && (
        <div className="text-center py-6">
          <div className="text-2xl mb-3">✅</div>
          <h4 className="font-display font-semibold text-text-primary mb-2">
            Already deposited
          </h4>
          <p className="text-sm text-text-muted">
            This wallet has already deposited {DEPOSIT_DISPLAY} USDC.
            You're a founding user!
          </p>
          <WalletInfo address={address} onDisconnect={disconnect} />
        </div>
      )}

      {/* ─── Error ─── */}
      {step === "error" && (
        <div className="text-center py-6">
          <div className="text-2xl mb-3">⚠️</div>
          <p className="text-sm text-risk-critical mb-4">{errorMsg}</p>
          <button
            onClick={handleRetry}
            className="px-6 py-2.5 rounded-md text-sm font-semibold border border-panik-orange/30 text-panik-orange hover:bg-panik-orange/10 transition-all"
            id="retry-btn"
          >
            Try Again
          </button>
          <WalletInfo address={address} onDisconnect={disconnect} />
        </div>
      )}
    </div>
  );
}

/** Small spinning indicator */
function Spinner({ size = "sm" }: { size?: "sm" | "lg" }) {
  const cls =
    size === "lg"
      ? "w-8 h-8 border-2"
      : "w-4 h-4 border-[1.5px]";
  return (
    <span
      className={`inline-block ${cls} border-panik-orange/30 border-t-panik-orange rounded-full animate-spin`}
    />
  );
}

/** Shows the connected wallet address with a disconnect button */
function WalletInfo({
  address,
  onDisconnect,
}: {
  address?: `0x${string}`;
  onDisconnect: () => void;
}) {
  if (!address) return null;
  return (
    <div className="mt-4 pt-3 border-t border-border-subtle flex items-center justify-center gap-3 text-xs">
      <span className="text-text-muted font-mono">
        {address.slice(0, 6)}…{address.slice(-4)}
      </span>
      <button
        onClick={onDisconnect}
        className="text-text-muted hover:text-risk-critical transition-colors"
        id="disconnect-btn"
      >
        Disconnect
      </button>
    </div>
  );
}
