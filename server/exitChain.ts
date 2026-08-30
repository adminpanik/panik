/**
 * On-chain reads for the delegation lifecycle (Phase 2.B).
 *
 * Revocation is the USER's own on-chain action: invalidateUnorderedNonces and
 * revokeAll are msg.sender-based, so a user sends them from their own wallet and
 * the backend never holds a key that could. What the backend MUST do is read the
 * resulting state and never report a permit live that the chain would reject.
 * "Never state a fact the code does not know" (CLAUDE.md) applied to coverage:
 *
 *   - revocationEpoch(user)  — a permit whose signed `epoch` != this is orphaned
 *                              (revokeAll moved the epoch to a block number).
 *   - isNonceUsed(user,n)    — a permit whose nonce bit is set has been spent,
 *                              by execution OR by invalidateUnorderedNonces.
 *   - maxPermitSlippageBps() — the executor's immutable slippage ceiling; a
 *                              permit over it is one the contract would reject.
 *
 * Reads bind the EXECUTOR's chain (Base Sepolia 84532 today, from
 * EXIT_CHAIN_ID) — the same chain the EIP-712 domain pins, and deliberately NOT
 * the mainnet chain scores are read on. See server/exitPermit.ts for the full
 * chain-id note.
 *
 * The ABI here is a minimal v2 fragment, NOT the generated exit.generated.ts
 * ABI: that file is regenerated from the deployed contract and is still v1 (no
 * delegated views), and it is marked DO NOT EDIT. These three views land with
 * the executor-v2 deploy this PR is stacked on.
 *
 * This module also owns HOW the executor side reaches a node
 * (`executorRpcUrls` / `executorRpcTransport`), because the relayer, its
 * signers, the coverage sweep and this reader must all be on the same
 * endpoints. That resolution used to be copied into server/relayerChain.ts, and
 * two copies of one ladder is how a relayer and a reader end up disagreeing
 * about what the chain says. Reads fail over across that ladder; a SUBMISSION
 * pins one rung of it, for the reason spelled out on `executorRpcTransport`.
 */

import { createPublicClient, fallback, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { EXECUTOR_ADDRESS, EXIT_CHAIN_ID } from "../src/panik-core/lib/exit.generated";
// The vetted keyless nodes and the override rules, shared with the app's exit
// flow. Three nodes per chain, each checked for Multicall3, so the executor
// side and the UI can never disagree about which public node is acceptable.
import { exitRpcUrls } from "../src/panik-core/lib/exitRpc";
import { ERC1271_ABI, type SignerCodeReader } from "./exit7702";

/**
 * Narrow view of a viem public client — just the two reads this module makes.
 * Annotating the field as viem's full `PublicClient` fails under this tsconfig
 * because chainFor() returns a base|baseSepolia union whose getBlock types
 * differ (Base has an extra deposit tx variant); the app hits the same wall and
 * resolves it with a narrow interface (see ContractClient in exit.ts).
 */
interface ReadClient {
  readContract(args: unknown): Promise<unknown>;
  getCode(args: { address: `0x${string}` }): Promise<`0x${string}` | undefined>;
  getTransactionReceipt(args: {
    hash: `0x${string}`;
  }): Promise<{ from: string; to: string | null; status: "success" | "reverted" }>;
}

/** The three delegated views this phase reads. */
export const EXECUTOR_V2_VIEWS_ABI = [
  {
    type: "function",
    name: "revocationEpoch",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "isNonceUsed",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "maxPermitSlippageBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
] as const;

/** A confirmed transaction, reduced to what revocation verification needs. */
export interface TxReceiptInfo {
  from: `0x${string}`;
  to: `0x${string}` | null;
  success: boolean;
}

/**
 * The chain state a stored permit is checked against. Injectable so the store
 * orchestration and tests never touch a real RPC.
 */
export interface ExitChainReader extends SignerCodeReader {
  /** revocationEpoch(user). A permit is orphaned when its epoch != this. */
  revocationEpoch(user: `0x${string}`): Promise<bigint>;
  /** isNonceUsed(user, nonce). True once the nonce bit is spent. */
  isNonceUsed(user: `0x${string}`, nonce: bigint): Promise<boolean>;
  /** The executor's immutable maxPermitSlippageBps ceiling. */
  maxPermitSlippageBps(): Promise<number>;
  /** Receipt for `txHash`, or null if not found/not yet mined. */
  receiptFor(txHash: `0x${string}`): Promise<TxReceiptInfo | null>;
}

/** Base Sepolia by default; mainnet only once EXIT_CHAIN_ID flips to 8453. */
export function chainFor(chainId: number) {
  return chainId === base.id ? base : baseSepolia;
}

const isMainnet = (chainId: number): boolean => chainId === base.id;

/**
 * The executor's RPC endpoints, in the order a transport tries them: the
 * operator's override, then the vetted public nodes, then Alchemy.
 *
 * Alchemy is LAST because a key is a quota — it is worth having as the backstop,
 * not worth spending on every read a public node would have served. The override
 * and public tiers (and their validation, and the dedupe) come from
 * `exitRpcUrls`, which is the same list the UI's exit flow fails over across.
 */
export function executorRpcUrls(
  chainId: number = EXIT_CHAIN_ID,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const urls = exitRpcUrls(chainId, env.EXIT_EXECUTOR_RPC_URL);

  // Read only THIS chain's key: a mainnet key on a Sepolia chain id would be an
  // endpoint answering for the wrong network, which is worse than no key.
  const mainnet = isMainnet(chainId);
  const key = (
    (mainnet ? env.ALCHEMY_API_KEY_BASE_MAINNET : env.ALCHEMY_API_KEY_BASE_SEPOLIA) ?? ""
  ).trim();
  if (key) {
    urls.push(`https://base-${mainnet ? "mainnet" : "sepolia"}.g.alchemy.com/v2/${key}`);
  }

  return [...new Set(urls)];
}

/**
 * The transport every executor-side client is built on — reads, delegation
 * checks, and the relayer's own signer.
 *
 * No `rank`: endpoint order is decided in `executorRpcUrls`, and a transport
 * that reorders itself would make "which node answered for this" unanswerable.
 *
 * Retries sit at the TAIL, not on every rung. The first endpoint is a public
 * node, and retrying a rate-limited public node twice with backoff before even
 * trying the next one spends ~1.8s to ask the same busy node the same question;
 * rotating immediately is what the list is for. The LAST endpoint retries
 * because there is nobody behind it.
 *
 * `rpcUrl` pins one endpoint explicitly (the fork test's anvil node), and pins
 * it alone — a fork run must never silently drift onto a public node.
 *
 * NOT FOR SIGNING. A fallback routes each call independently, which is right
 * for a read and wrong for a nonce: `eth_getTransactionCount(pending)` and
 * `eth_sendRawTransaction` landing on two nodes with different mempool views
 * hands out a duplicate or a gapped nonce. The relayer's signer therefore
 * consumes `executorRpcUrls` directly and pins ONE rung per submission — see
 * the header of server/relayerSigner.ts.
 */
export function executorRpcTransport(rpcUrl?: string, chainId: number = EXIT_CHAIN_ID) {
  const urls = rpcUrl ? [rpcUrl] : executorRpcUrls(chainId);
  return fallback(
    urls.map((url, i) =>
      i === urls.length - 1
        ? http(url, { retryCount: 2, retryDelay: 300, timeout: 15_000 })
        : http(url, { retryCount: 0, timeout: 15_000 }),
    ),
    { retryCount: 0 },
  );
}

/** viem-backed reader against the deployed executor. */
export class ViemExitChainReader implements ExitChainReader {
  private readonly client: ReadClient;
  private readonly executor: `0x${string}`;
  /** maxPermitSlippageBps is immutable on-chain, so cache the first read forever. */
  private slippageCeiling: number | null = null;

  constructor(
    rpcUrl?: string,
    executor: `0x${string}` = EXECUTOR_ADDRESS,
    chainId: number = EXIT_CHAIN_ID,
  ) {
    this.executor = executor;
    this.client = createPublicClient({
      chain: chainFor(chainId),
      transport: executorRpcTransport(rpcUrl, chainId),
    }) as unknown as ReadClient;
  }

  static fromEnv(): ViemExitChainReader {
    return new ViemExitChainReader();
  }

  async revocationEpoch(user: `0x${string}`): Promise<bigint> {
    return (await this.client.readContract({
      address: this.executor,
      abi: EXECUTOR_V2_VIEWS_ABI,
      functionName: "revocationEpoch",
      args: [user],
    })) as bigint;
  }

  async isNonceUsed(user: `0x${string}`, nonce: bigint): Promise<boolean> {
    return (await this.client.readContract({
      address: this.executor,
      abi: EXECUTOR_V2_VIEWS_ABI,
      functionName: "isNonceUsed",
      args: [user, nonce],
    })) as boolean;
  }

  async maxPermitSlippageBps(): Promise<number> {
    if (this.slippageCeiling !== null) return this.slippageCeiling;
    const raw = (await this.client.readContract({
      address: this.executor,
      abi: EXECUTOR_V2_VIEWS_ABI,
      functionName: "maxPermitSlippageBps",
    })) as number | bigint;
    this.slippageCeiling = Number(raw);
    return this.slippageCeiling;
  }

  /**
   * eth_getCode. Non-empty means the executor will take its ERC-1271 branch
   * for this signer (EIP-7702 delegate or a smart account) — see
   * server/exit7702.ts. viem returns undefined for an empty account; that is
   * normalized to "0x" so callers have one spelling to test.
   */
  async codeAt(address: `0x${string}`): Promise<`0x${string}`> {
    const code = await this.client.getCode({ address });
    return code ?? "0x";
  }

  /**
   * ERC-1271 isValidSignature. Resolves null when the account has no such
   * function or the call reverts — the common case for a 7702 delegate, and a
   * REJECTION rather than an error, because "the account did not say yes" is
   * exactly the fact the caller needs.
   */
  async isValidSignature(
    account: `0x${string}`,
    digest: `0x${string}`,
    signature: `0x${string}`,
  ): Promise<`0x${string}` | null> {
    try {
      return (await this.client.readContract({
        address: account,
        abi: ERC1271_ABI,
        functionName: "isValidSignature",
        args: [digest, signature],
      })) as `0x${string}`;
    } catch {
      return null;
    }
  }

  async receiptFor(txHash: `0x${string}`): Promise<TxReceiptInfo | null> {
    try {
      const r = await this.client.getTransactionReceipt({ hash: txHash });
      return {
        from: r.from.toLowerCase() as `0x${string}`,
        to: r.to ? (r.to.toLowerCase() as `0x${string}`) : null,
        success: r.status === "success",
      };
    } catch {
      return null; // not found / not yet mined — treated as unverifiable
    }
  }
}
