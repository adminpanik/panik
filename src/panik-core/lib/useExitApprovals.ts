/**
 * The one ERC-20 approval runner for the exit flow: read the current
 * allowances, grant the missing ones, and take them all back again.
 *
 * Every approval is exact-amount plus a 2% interest-accrual buffer
 * (`withAccrualBuffer` in `./exitLegs`), never infinite, and every write is
 * simulated before it is signed and checked against its receipt afterwards.
 * viem resolves on a reverted transaction, so `status === "success"` is the
 * only proof anything executed. That applies to a revocation just as hard: a
 * failed revoke that reports success is worse than no revoke button.
 *
 * Grant and revoke live together on purpose. They are the same allowance seen
 * from two sides, and the pair that drifts apart is the pair where one of them
 * targets a spender the other does not.
 */

import { useCallback } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import { EXIT_CHAIN_ID } from "./exit.generated";
import { asContractClient, EXIT_ERC20_ABI } from "./exit";
// The buffer moved to `exitLegs` when the wallet cap needed to INVERT it (how
// much can a balance fund once the buffer is taken out). One definition, in the
// module that owns the BigInt money math, rather than a second 2% living here.
import { withAccrualBuffer, type ApprovalStep } from "./exitLegs";
import type { RevokeOutcome } from "./preauth";

export type { ApprovalStep };

export function useExitApprovals(owner: `0x${string}` | undefined) {
  const publicClient = usePublicClient({ chainId: EXIT_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();

  /**
   * Current allowance per step, in the same order. The number the user is shown
   * before and after any change comes from here and from nowhere else, so the
   * screen can never claim a state the chain did not report.
   */
  const readAllowances = useCallback(
    async (steps: readonly ApprovalStep[]): Promise<bigint[]> => {
      if (!publicClient || !owner) throw new Error("wallet not connected");
      const client = asContractClient(publicClient);
      return Promise.all(
        steps.map(
          (step) =>
            client.readContract({
              address: step.token,
              abi: EXIT_ERC20_ABI,
              functionName: "allowance",
              args: [owner, step.spender],
            }) as Promise<bigint>,
        ),
      );
    },
    [publicClient, owner],
  );

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
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error(`${step.label} reverted on-chain`);
        }
        sent += 1;
      }
      return sent;
    },
    [publicClient, owner, writeContractAsync],
  );

  /**
   * Set every listed allowance to zero, and report each one honestly.
   *
   * It does NOT throw on the first failure, and that is the whole design. A
   * revoke-all that stops halfway and reports an error leaves the user with no
   * idea which half went through; this attempts all of them and returns one
   * outcome per step, so the summary can name the ones still standing
   * (`revokeSummary` in `./preauth`). A user rejection in the wallet is an
   * outcome like any other here for the same reason.
   *
   * A step already at zero is reported as done without asking for a signature:
   * a wallet with positions on one protocol and not another should not be made
   * to sign an approval of zero over a token it never approved.
   */
  const revokeApprovals = useCallback(
    async (
      steps: readonly (ApprovalStep & { id: string })[],
      onProgress?: (label: string) => void,
    ): Promise<RevokeOutcome[]> => {
      if (!publicClient || !owner) throw new Error("wallet not connected");
      const client = asContractClient(publicClient);
      const outcomes: RevokeOutcome[] = [];
      for (const step of steps) {
        try {
          const allowance = (await client.readContract({
            address: step.token,
            abi: EXIT_ERC20_ABI,
            functionName: "allowance",
            args: [owner, step.spender],
          })) as bigint;
          if (allowance === 0n) {
            outcomes.push({ id: step.id, label: step.label, ok: true });
            continue;
          }

          onProgress?.(step.label);
          const { request } = await client.simulateContract({
            account: owner,
            address: step.token,
            abi: EXIT_ERC20_ABI,
            functionName: "approve",
            args: [step.spender, 0n],
          });
          const hash = await writeContractAsync(request as never);
          const receipt = await client.waitForTransactionReceipt({ hash });
          // viem resolves on a reverted tx. Only a success receipt may be
          // reported as a revocation.
          outcomes.push(
            receipt.status === "success"
              ? { id: step.id, label: step.label, ok: true }
              : { id: step.id, label: step.label, ok: false, error: "reverted on-chain" },
          );
        } catch (err) {
          outcomes.push({
            id: step.id,
            label: step.label,
            ok: false,
            error: (err as Error).message.split("\n")[0]?.slice(0, 120) ?? "failed",
          });
        }
      }
      return outcomes;
    },
    [publicClient, owner, writeContractAsync],
  );

  return { readAllowances, ensureApprovals, revokeApprovals };
}
