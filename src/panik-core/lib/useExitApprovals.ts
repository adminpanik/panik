/**
 * Sequential ERC-20 approval runner for the exit flow. Checks current
 * allowances and only prompts for the missing ones; every approval is
 * simulated before it is signed. Exact amounts + a 2% interest-accrual buffer
 * (mainnet-ready posture - never infinite approvals).
 */

import { useCallback } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import { EXIT_CHAIN_ID } from "./exit.generated";
import { asContractClient, EXIT_ERC20_ABI } from "./exit";

export interface ApprovalStep {
  token: `0x${string}`;
  spender: `0x${string}`;
  /** Exact amount needed; the runner approves amount + 2% buffer. */
  amount: bigint;
  label: string;
}

/** amount + 2% (interest can accrue between approval and execution). */
export function withAccrualBuffer(amount: bigint): bigint {
  return amount + (amount * 2n) / 100n;
}

export function useExitApprovals(owner: `0x${string}` | undefined) {
  const publicClient = usePublicClient({ chainId: EXIT_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();

  /**
   * Ensure every step's allowance covers its amount. Returns the number of
   * approval transactions that were actually sent. Throws on rejection.
   */
  const ensureApprovals = useCallback(
    async (steps: ApprovalStep[], onProgress?: (label: string) => void): Promise<number> => {
      if (!publicClient || !owner) throw new Error("wallet not connected");
      const client = asContractClient(publicClient);
      let sent = 0;
      for (const step of steps) {
        const allowance = (await client.readContract({
          address: step.token,
          abi: EXIT_ERC20_ABI,
          functionName: "allowance",
          args: [owner, step.spender],
        })) as bigint;
        if (allowance >= step.amount) continue;

        onProgress?.(step.label);
        const target = withAccrualBuffer(step.amount);
        const { request } = await client.simulateContract({
          account: owner,
          address: step.token,
          abi: EXIT_ERC20_ABI,
          functionName: "approve",
          args: [step.spender, target],
        });
        const hash = await writeContractAsync(request as never);
        await client.waitForTransactionReceipt({ hash });
        sent += 1;
      }
      return sent;
    },
    [publicClient, owner, writeContractAsync],
  );

  return { ensureApprovals };
}
