/**
 * Relayer signers (Phase 4.A) — the ONLY keys PANIK holds.
 *
 * Read that sentence twice, because it is the whole custody story. A user's
 * delegation is an EIP-712 SIGNATURE (server/exitPermit.ts): PANIK never holds
 * anything that can move a user's funds, and the permit carries no recipient so
 * the executor always pays `permit.user`. What PANIK does hold is a relayer EOA
 * whose entire power is "pay the gas for a transaction the user already signed
 * the scope of". A stolen relayer key lets an attacker submit permits that were
 * going to be submitted anyway, and drain the relayer's OWN gas balance. It
 * cannot redirect a single unit of user value.
 *
 * That bound is why a local private key is acceptable on TESTNET and why it is
 * NOT the mainnet plan: a drained gas wallet is still an outage, and key
 * rotation without an HSM is a manual scramble. Mainnet uses KMS (see
 * KmsRelayerSigner) so the key material never exists in a process env.
 *
 * THE KEY IS NEVER LOGGED. Every log line and every event carries the signer's
 * ADDRESS and its pool label, never the secret. `RELAYER_PRIVATE_KEYS` is read
 * once at construction and the string is not retained anywhere but the viem
 * account it builds.
 *
 * WHY A POOL. One EOA is one nonce sequence, so one stuck transaction blocks
 * every later submission behind it. A pool of N EOAs gives N independent
 * sequences: a stuck tx on signer 0 stalls only signer 0's queue while the rest
 * keep working. Each signer manages its own nonce strictly sequentially (never
 * two in flight on the same nonce except a deliberate replacement) and is
 * leased exclusively for the duration of a submission.
 *
 * WHY THE SIGNER DOES NOT USE `executorRpcTransport`. Everything else on the
 * executor side reads through viem's `fallback()` over the endpoint ladder,
 * which is right for a read: any node that answers will do. It is WRONG for a
 * nonce.
 *
 * A pending nonce is not a fact about the chain, it is a fact about ONE NODE'S
 * MEMPOOL. Under a fallback transport the calls of a single submission are
 * routed independently, so a rate limit on the first rung at the wrong instant
 * sends `eth_getTransactionCount(pending)` to node B while
 * `eth_sendRawTransaction` goes to node A. Two outcomes, both bad:
 *
 *   - B has not seen the relayer's last transaction, so it returns a nonce that
 *     is already spent. The new transaction is a DUPLICATE, replaces nothing,
 *     and is dropped as underpriced or mines instead of the one it collided
 *     with.
 *   - B has seen a transaction A has not, so it returns a nonce one too high.
 *     Every later transaction from this EOA queues behind a GAP that nothing
 *     will ever fill, and the relayer stops protecting anyone until an operator
 *     notices.
 *
 * So a submission PINS one endpoint (`PinnedEndpointOperation`): the health
 * probe, the pending-nonce read, the balance read and the broadcast all go to
 * the same node, and the cached sequence is qualified by the endpoint it was
 * read from. Failover is explicit and only happens BEFORE a broadcast, and it
 * forces a re-read, because a nonce from the old node means nothing on the new
 * one. After a broadcast the operation refuses to move at all: a send that
 * timed out may still have reached the mempool, and re-reading the nonce
 * somewhere else is exactly how the duplicate above gets created.
 */

import { createPublicClient, createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
// The executor side's one endpoint ladder. Reads fail over across it; a
// submission pins ONE rung of it. See the header.
import { chainFor, executorRpcTransport, executorRpcUrls } from "./exitChain";

/** A transaction the relayer has already simulated and priced. */
export interface RelayerTxRequest {
  to: `0x${string}`;
  data: `0x${string}`;
  /** From the simulation. NEVER a hardcoded constant. */
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** The signer's own sequential nonce; a replacement reuses the stuck one. */
  nonce: number;
  /** Guards against a signer configured for a different chain. */
  chainId: number;
}

/**
 * A log-safe name for an endpoint: its position in the ladder and its HOST.
 *
 * NEVER the full URL. The Alchemy rung carries an API key in its path and this
 * string reaches events, logs and error messages — server/rpcHealth.ts holds
 * the same line for the same reason. The index keeps two rungs on one host
 * distinguishable, so the label is a usable cache key as well as a log line.
 */
export function endpointLabel(url: string, index: number): string {
  try {
    return `${index}:${new URL(url).host}`;
  } catch {
    return `${index}:unparsed`;
  }
}

/**
 * The calls one pinned endpoint has to serve.
 *
 * Narrow on purpose: viem's wallet-client-plus-public-actions type does not
 * check under this tsconfig once `chainFor` returns a `base | baseSepolia`
 * union (their block types differ), and these four methods are the entire
 * surface a submission needs. Narrowing also makes the pinning logic testable
 * against scripted endpoints rather than a live node.
 */
export interface PinnedEndpointClient {
  getChainId(): Promise<number>;
  getTransactionCount(args: unknown): Promise<number>;
  getBalance(args: unknown): Promise<bigint>;
  sendTransaction(args: unknown): Promise<`0x${string}`>;
}

/**
 * One submission's exclusive, single-endpoint view of the chain.
 *
 * Every method here talks to the SAME node for the operation's whole lifetime.
 * That is the invariant the nonce depends on; see the module header.
 */
export interface SignerOperation {
  /** The pinned endpoint's log-safe label. Changes only across a `failover`. */
  readonly endpoint: string;
  /** Pending-tag transaction count, read from the PINNED node. */
  pendingNonce(): Promise<number>;
  /** Native balance in wei, read from the PINNED node. */
  balance(): Promise<bigint>;
  /** Sign and broadcast through the PINNED node. */
  sendTransaction(tx: RelayerTxRequest): Promise<`0x${string}`>;
  /**
   * Move to the next healthy endpoint. False when the ladder is exhausted.
   * The caller MUST re-read the nonce afterwards. Throws once anything has
   * been broadcast, because moving then is unsafe at any price.
   */
  failover(): Promise<boolean>;
  /** Release the operation. Further calls throw. */
  end(): void;
}

/**
 * The pluggable boundary. Everything above this interface is chain-agnostic
 * orchestration; everything below is "how does this key sign". Two
 * implementations ship: a local key for testnet and a KMS adapter for mainnet.
 *
 * There is deliberately NO unpinned `sendTransaction` or `pendingNonce` here.
 * A caller that could reach one would reintroduce the split-endpoint nonce bug
 * the header describes, so the only way to broadcast is through an operation.
 */
export interface RelayerSigner {
  /** Stable label for logs and events. Never derived from the key material. */
  readonly label: string;
  /** The EOA that pays the gas. Public by definition. */
  readonly address: `0x${string}`;
  /** The chain this signer is configured for; the pool refuses a mismatch. */
  readonly chainId: number;
  /**
   * Pin an endpoint and open a submission scope. Health-checks candidates in
   * ladder order and resolves against the first that answers for the right
   * chain; rejects when none does.
   */
  beginOperation(): Promise<SignerOperation>;
  /**
   * Native balance in wei for REPORTING (server/relayerHealth.ts). Reads
   * through the failover ladder because a balance is not endpoint-relative and
   * a monitor should survive one node being down. The balance a submission
   * gates on comes from `SignerOperation.balance`, on its pinned node.
   */
  balance(): Promise<bigint>;
}

/**
 * A submission pinned to one endpoint, with explicit failover.
 *
 * `connect` is injected so the pinning rules are exercised directly in tests
 * against scripted endpoints — the failure this class prevents cannot be
 * reproduced against a live node on demand.
 */
export class PinnedEndpointOperation implements SignerOperation {
  private index = -1;
  private client: PinnedEndpointClient | null = null;
  private label = "";
  private broadcast = false;
  private ended = false;
  /** Why each rejected endpoint was rejected, for one honest error message. */
  private readonly rejected: string[] = [];

  private constructor(
    private readonly urls: readonly string[],
    private readonly chainId: number,
    private readonly signerLabel: string,
    private readonly address: `0x${string}`,
    private readonly connect: (url: string) => PinnedEndpointClient,
  ) {}

  static async open(
    urls: readonly string[],
    chainId: number,
    signerLabel: string,
    address: `0x${string}`,
    connect: (url: string) => PinnedEndpointClient,
  ): Promise<PinnedEndpointOperation> {
    const op = new PinnedEndpointOperation(urls, chainId, signerLabel, address, connect);
    if (!(await op.advance())) {
      throw new Error(
        `relayer signer ${signerLabel}: no healthy endpoint for chain ${chainId}` +
          (op.rejected.length > 0 ? ` (${op.rejected.join("; ")})` : ""),
      );
    }
    return op;
  }

  get endpoint(): string {
    return this.label;
  }

  /**
   * Take the next endpoint that answers `eth_chainId` with the RIGHT chain.
   *
   * One probe per operation, not per call: it costs a single round trip and it
   * catches the two conditions that make the rest of the submission worthless —
   * a node that is down, and a node answering for another network. The ladder
   * is public-first, and a public endpoint pointed at the wrong chain would
   * otherwise be discovered by a reverted transaction that still cost gas.
   */
  private async advance(): Promise<boolean> {
    for (let i = this.index + 1; i < this.urls.length; i += 1) {
      const url = this.urls[i]!;
      const label = endpointLabel(url, i);
      const client = this.connect(url);
      try {
        const chainId = await client.getChainId();
        if (chainId !== this.chainId) {
          this.rejected.push(`${label} answers for chain ${chainId}`);
          continue;
        }
      } catch (err) {
        this.rejected.push(`${label}: ${(err as Error).message.slice(0, 120)}`);
        continue;
      }
      this.index = i;
      this.label = label;
      this.client = client;
      return true;
    }
    this.index = this.urls.length;
    this.client = null;
    return false;
  }

  private active(): PinnedEndpointClient {
    if (this.ended) throw new Error(`relayer signer ${this.signerLabel}: operation already ended`);
    if (!this.client) throw new Error(`relayer signer ${this.signerLabel}: no pinned endpoint`);
    return this.client;
  }

  async failover(): Promise<boolean> {
    if (this.ended) throw new Error(`relayer signer ${this.signerLabel}: operation already ended`);
    if (this.broadcast) {
      // A send that threw may still have reached the mempool. Re-reading the
      // nonce on another node after that is precisely the duplicate this class
      // exists to prevent, so the failure propagates instead.
      throw new Error(
        `relayer signer ${this.signerLabel}: refusing to change endpoint after a broadcast`,
      );
    }
    return this.advance();
  }

  async pendingNonce(): Promise<number> {
    return this.active().getTransactionCount({ address: this.address, blockTag: "pending" });
  }

  async balance(): Promise<bigint> {
    return this.active().getBalance({ address: this.address });
  }

  async sendTransaction(tx: RelayerTxRequest): Promise<`0x${string}`> {
    if (tx.chainId !== this.chainId) {
      throw new Error(`signer ${this.signerLabel} is on chain ${this.chainId}, tx names ${tx.chainId}`);
    }
    const client = this.active();
    // Latched BEFORE the call, never after: the dangerous case is a send that
    // throws having already reached the mempool, and that path never gets to a
    // line after `await`.
    this.broadcast = true;
    return client.sendTransaction({
      to: tx.to,
      data: tx.data,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      nonce: tx.nonce,
      value: 0n,
    });
  }

  end(): void {
    this.ended = true;
    this.client = null;
  }
}

/** Normalize a hex private key; returns null rather than echoing the input. */
function normalizeKey(raw: string): `0x${string}` | null {
  const t = raw.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(t)) return t as `0x${string}`;
  if (/^[0-9a-fA-F]{64}$/.test(t)) return `0x${t}` as `0x${string}`;
  return null;
}

/**
 * Local-private-key signer. TESTNET ONLY — see the header for why that bound is
 * about operability, not about user funds.
 *
 * The key is consumed by `privateKeyToAccount` in the constructor and never
 * stored on the instance, so it cannot be reached from a log of `this`.
 *
 * It holds the endpoint LIST, not a fallback transport over it: one client per
 * rung, built on demand, so a submission can pin exactly one.
 */
export class LocalKeyRelayerSigner implements RelayerSigner {
  readonly label: string;
  readonly address: `0x${string}`;
  readonly chainId: number;
  private readonly endpoints: readonly string[];
  private readonly connect: (url: string) => PinnedEndpointClient;
  /** Failover-backed, for the pool-wide balance report only. */
  private readonly reportClient: { getBalance(args: unknown): Promise<bigint> };

  constructor(privateKey: string, rpcUrl: string | undefined, chainId: number, label: string) {
    const key = normalizeKey(privateKey);
    if (!key) throw new Error(`relayer signer ${label}: malformed private key`);
    const account = privateKeyToAccount(key);
    this.label = label;
    this.address = account.address.toLowerCase() as `0x${string}`;
    this.chainId = chainId;
    // `rpcUrl` pins one endpoint and pins it alone (the fork test's anvil node),
    // exactly as executorRpcTransport treats it. Otherwise: the shared ladder.
    this.endpoints = rpcUrl ? [rpcUrl] : executorRpcUrls(chainId);
    if (this.endpoints.length === 0) {
      throw new Error(`relayer signer ${label}: no RPC endpoint configured for chain ${chainId}`);
    }
    const chain = chainFor(chainId);
    // One retry, not two: a single blip should not churn endpoints, but a node
    // that is genuinely down must not hold the submission for seconds when the
    // next rung is one probe away. Retrying a send is safe — the same signed
    // payload has the same hash and the node dedupes it.
    this.connect = (url: string) =>
      createWalletClient({
        account,
        chain,
        transport: http(url, { retryCount: 1, retryDelay: 300, timeout: 15_000 }),
      }).extend(publicActions) as unknown as PinnedEndpointClient;
    this.reportClient = createPublicClient({
      chain,
      transport: executorRpcTransport(rpcUrl, chainId),
    }) as unknown as typeof this.reportClient;
  }

  async beginOperation(): Promise<SignerOperation> {
    return PinnedEndpointOperation.open(
      this.endpoints,
      this.chainId,
      this.label,
      this.address,
      this.connect,
    );
  }

  async balance(): Promise<bigint> {
    return this.reportClient.getBalance({ address: this.address });
  }
}

/**
 * AWS KMS signer — the MAINNET plan, deliberately left unimplemented.
 *
 * NOT IMPLEMENTED ON PURPOSE. Implementing it needs `@aws-sdk/client-kms`, and
 * CLAUDE.md forbids adding a runtime dependency as a side effect of another
 * phase. The interface is the deliverable: the pool, the nonce sequencing, the
 * endpoint pinning, the fee bumping and the whole relayer above it are written
 * against `RelayerSigner` and never touch key material, so dropping a KMS
 * implementation in later changes this file and nothing else.
 *
 * ENV VARS the implementation will read (documented now so ops can provision
 * them before the code lands):
 *   RELAYER_SIGNER_KIND=kms        selects this signer over the local key
 *   RELAYER_KMS_KEY_IDS            comma-separated KMS key ids/ARNs, one per
 *                                  pool EOA (ECC_SECG_P256K1, SIGN_VERIFY)
 *   AWS_REGION                     region holding those keys
 *   AWS_ROLE_ARN / AWS_WEB_IDENTITY_TOKEN_FILE
 *                                  IRSA-style credentials; no static AWS keys
 *
 * SHAPE the implementation must satisfy:
 *   1. `address` is derived ONCE at construction from the KMS public key
 *      (GetPublicKey -> DER SPKI -> uncompressed secp256k1 point -> keccak256
 *      of the trailing 64 bytes -> last 20 bytes). It is cached; a per-send
 *      derivation would add a network round trip to the hot path.
 *   2. `beginOperation` returns a `PinnedEndpointOperation` over the same
 *      ladder, so KMS inherits the single-endpoint nonce guarantee unchanged;
 *      only `connect` differs, because only the signing differs.
 *   3. The operation's `sendTransaction` serializes the EIP-1559 transaction
 *      with viem's `serializeTransaction`, keccak256s it, calls KMS `Sign` with
 *      MessageType=DIGEST and SigningAlgorithm=ECDSA_SHA_256, then:
 *        a. parses the DER (r, s),
 *        b. LOW-S NORMALIZES: if s > n/2, s = n - s. KMS returns either half
 *           and Ethereum rejects the high half (EIP-2). Skipping this produces
 *           intermittently invalid signatures, which is the classic KMS-signer
 *           bug and the reason this note exists.
 *        c. recovers the parity by trying yParity 0 and 1 and keeping the one
 *           that recovers to `this.address`,
 *        d. broadcasts the serialized signed tx via `eth_sendRawTransaction`.
 *   4. It NEVER exports or logs key material — KMS cannot export it, which is
 *      the point.
 */
export class KmsRelayerSigner implements RelayerSigner {
  readonly label: string;
  readonly address: `0x${string}`;
  readonly chainId: number;

  constructor(config: { keyId: string; chainId: number; label: string; address?: `0x${string}` }) {
    this.label = config.label;
    this.chainId = config.chainId;
    // Real implementations derive this from KMS GetPublicKey; the placeholder
    // exists only so the type is honest about what the field means.
    this.address = (config.address ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
  }

  private unimplemented(): never {
    throw new Error(
      "KmsRelayerSigner is not implemented (Phase 4.A ships the interface only). " +
        "Set RELAYER_SIGNER_KIND=local for testnet, or implement the KMS adapter " +
        "documented in server/relayerSigner.ts before arming mainnet.",
    );
  }

  async beginOperation(): Promise<SignerOperation> {
    this.unimplemented();
  }
  async balance(): Promise<bigint> {
    this.unimplemented();
  }
}

/** A signer leased from the pool, its pinned endpoint, and the nonce to use. */
export interface SignerLease {
  signer: RelayerSigner;
  /**
   * The pinned submission scope. BROADCAST THROUGH THIS, never through the
   * signer: `nonce` below was read from this operation's endpoint and is only
   * meaningful there.
   */
  operation: SignerOperation;
  nonce: number;
  /** Release the lease. `landed` advances the sequence; a failure rewinds it. */
  release(landed: boolean): void;
}

/** A cached sequence position, and the endpoint whose mempool it describes. */
interface NonceCursor {
  nonce: number;
  endpoint: string;
}

/**
 * Round-robin pool with per-EOA sequential nonce management.
 *
 * Each signer holds `next`, its own next unused nonce, seeded from the chain's
 * pending count on first use and thereafter advanced locally — polling the node
 * per submission would race its own mempool. A lease is exclusive: a signer
 * with a transaction in flight is never handed out again until it is released,
 * so two submissions can never claim the same nonce.
 *
 * THE CACHE IS ENDPOINT-QUALIFIED. A sequence seeded from node A is a statement
 * about A's mempool and means nothing on node B, which may not hold the
 * transactions that advanced it. So the cursor records which endpoint it came
 * from, and a lease pinned somewhere else discards it and re-reads. That is the
 * same rule as failover, applied to the cache instead of to a live call.
 *
 * `release(false)` rewinds the sequence, because a send that never reached the
 * mempool left its nonce unused and the NEXT transaction must reuse it or every
 * later one is stuck behind a permanent gap.
 */
export class RelayerSignerPool {
  private readonly signers: RelayerSigner[];
  private readonly next = new Map<string, NonceCursor>();
  private readonly busy = new Set<string>();
  private cursor = 0;

  constructor(signers: readonly RelayerSigner[]) {
    if (signers.length === 0) throw new Error("relayer signer pool is empty");
    this.signers = [...signers];
  }

  get size(): number {
    return this.signers.length;
  }

  get addresses(): `0x${string}`[] {
    return this.signers.map((s) => s.address);
  }

  /** Every signer, for balance reporting. Does not lease anything. */
  all(): readonly RelayerSigner[] {
    return this.signers;
  }

  /**
   * The nonce this submission must use, read from the endpoint it is PINNED to.
   *
   * A read failure is not fatal while nothing has been broadcast: step to the
   * next endpoint and read again there. The re-read is the whole point — the
   * value the dead node would have given is not transferable, and carrying it
   * across is the duplicate-nonce failure this module exists to prevent.
   */
  private async claimNonce(signer: RelayerSigner, operation: SignerOperation): Promise<number> {
    for (;;) {
      const cached = this.next.get(signer.address);
      if (cached && cached.endpoint === operation.endpoint) return cached.nonce;
      try {
        return await operation.pendingNonce();
      } catch (err) {
        if (!(await operation.failover())) throw err;
      }
    }
  }

  /**
   * Lease the next free signer, or null when all are in flight. Null is a
   * SKIP, never a wait: the relayer runs on a tick and a permit that misses
   * this tick is picked up on the next one.
   */
  async acquire(): Promise<SignerLease | null> {
    for (let i = 0; i < this.signers.length; i++) {
      const signer = this.signers[(this.cursor + i) % this.signers.length]!;
      if (this.busy.has(signer.address)) continue;

      this.cursor = (this.cursor + i + 1) % this.signers.length;
      this.busy.add(signer.address);

      let operation: SignerOperation;
      try {
        operation = await signer.beginOperation();
      } catch (err) {
        this.busy.delete(signer.address);
        throw err;
      }

      let claimed: number;
      try {
        claimed = await this.claimNonce(signer, operation);
      } catch (err) {
        operation.end();
        this.busy.delete(signer.address);
        throw err;
      }
      this.next.set(signer.address, { nonce: claimed, endpoint: operation.endpoint });

      let released = false;
      return {
        signer,
        operation,
        nonce: claimed,
        release: (landed: boolean) => {
          if (released) return;
          released = true;
          // Landed (or at least broadcast): the nonce is spent, move on.
          // Not landed: it never reached the mempool, so leave the sequence
          // where it was or every later tx queues behind a gap that never fills.
          // Stamped with the endpoint the operation FINISHED on, which is where
          // the broadcast went if one happened.
          this.next.set(signer.address, {
            nonce: landed ? claimed + 1 : claimed,
            endpoint: operation.endpoint,
          });
          operation.end();
          this.busy.delete(signer.address);
        },
      };
    }
    return null;
  }

  /** Drop the cached sequence so the next lease re-reads it from the chain. */
  resync(address: `0x${string}`): void {
    this.next.delete(address.toLowerCase() as `0x${string}`);
  }
}

/**
 * Minimum replacement fee for a stuck transaction.
 *
 * Geth-family nodes reject a replacement whose fees are not at least 10% above
 * the original, so a "bump" that rounds down is silently a no-op and the
 * transaction stays stuck forever. Integer math with an explicit round-UP
 * (`+ 99n) / 100n`) rather than a float multiply, for the same reason every
 * other money path in this repo is BigInt.
 */
export const REPLACEMENT_FEE_BUMP_PCT = 10n;

export function bumpFee(previous: bigint): bigint {
  return (previous * (100n + REPLACEMENT_FEE_BUMP_PCT) + 99n) / 100n;
}

/**
 * Build the pool from env.
 *
 * `RELAYER_PRIVATE_KEYS` is a comma-separated list; one entry is a pool of one,
 * which is the documented minimum. Returns null when nothing is configured, so
 * a worker with the relayer disabled boots normally instead of crashing — the
 * kill switch and the signer config are independent, and a dry run needs no key
 * at all.
 */
export function signerPoolFromEnv(
  rpcUrl: string | undefined,
  chainId: number,
): RelayerSignerPool | null {
  const kind = (process.env.RELAYER_SIGNER_KIND ?? "local").trim().toLowerCase();
  if (kind === "kms") {
    const ids = (process.env.RELAYER_KMS_KEY_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return null;
    return new RelayerSignerPool(
      ids.map((keyId, i) => new KmsRelayerSigner({ keyId, chainId, label: `kms-${i}` })),
    );
  }

  const raw = (process.env.RELAYER_PRIVATE_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) return null;
  return new RelayerSignerPool(
    raw.map((key, i) => new LocalKeyRelayerSigner(key, rpcUrl, chainId, `local-${i}`)),
  );
}
