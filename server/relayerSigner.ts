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
 */

import { createWalletClient, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
// The executor side's one endpoint ladder. A broadcast wedged behind a single
// rate-limited node is an unsubmitted permit, so the signer fails over too.
import { executorRpcTransport } from "./exitChain";

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
 * The pluggable boundary. Everything above this interface is chain-agnostic
 * orchestration; everything below is "how does this key sign". Two
 * implementations ship: a local key for testnet and a KMS adapter for mainnet.
 */
export interface RelayerSigner {
  /** Stable label for logs and events. Never derived from the key material. */
  readonly label: string;
  /** The EOA that pays the gas. Public by definition. */
  readonly address: `0x${string}`;
  /** The chain this signer is configured for; the pool refuses a mismatch. */
  readonly chainId: number;
  /** Sign and broadcast. Resolves to the transaction hash. */
  sendTransaction(tx: RelayerTxRequest): Promise<`0x${string}`>;
  /** Pending-tag transaction count — the next nonce this EOA should use. */
  pendingNonce(): Promise<number>;
  /** Native balance in wei, for the low-gas guard and the 4.B balance event. */
  balance(): Promise<bigint>;
}

function chainFor(chainId: number) {
  return chainId === base.id ? base : baseSepolia;
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
 */
export class LocalKeyRelayerSigner implements RelayerSigner {
  readonly label: string;
  readonly address: `0x${string}`;
  readonly chainId: number;
  private readonly client: {
    sendTransaction(args: unknown): Promise<`0x${string}`>;
    getTransactionCount(args: unknown): Promise<number>;
    getBalance(args: unknown): Promise<bigint>;
  };

  constructor(
    privateKey: string,
    rpcUrl: string | readonly string[] | undefined,
    chainId: number,
    label: string,
  ) {
    const key = normalizeKey(privateKey);
    if (!key) throw new Error(`relayer signer ${label}: malformed private key`);
    const account = privateKeyToAccount(key);
    this.label = label;
    this.address = account.address.toLowerCase() as `0x${string}`;
    this.chainId = chainId;
    this.client = createWalletClient({
      account,
      chain: chainFor(chainId),
      transport: executorRpcTransport(rpcUrl, chainId),
    }).extend(publicActions) as unknown as typeof this.client;
  }

  async sendTransaction(tx: RelayerTxRequest): Promise<`0x${string}`> {
    if (tx.chainId !== this.chainId) {
      throw new Error(`signer ${this.label} is on chain ${this.chainId}, tx names ${tx.chainId}`);
    }
    return this.client.sendTransaction({
      to: tx.to,
      data: tx.data,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      nonce: tx.nonce,
      value: 0n,
    });
  }

  async pendingNonce(): Promise<number> {
    return this.client.getTransactionCount({ address: this.address, blockTag: "pending" });
  }

  async balance(): Promise<bigint> {
    return this.client.getBalance({ address: this.address });
  }
}

/**
 * AWS KMS signer — the MAINNET plan, deliberately left unimplemented.
 *
 * NOT IMPLEMENTED ON PURPOSE. Implementing it needs `@aws-sdk/client-kms`, and
 * CLAUDE.md forbids adding a runtime dependency as a side effect of another
 * phase. The interface is the deliverable: the pool, the nonce sequencing, the
 * fee bumping and the whole relayer above it are written against
 * `RelayerSigner` and never touch key material, so dropping a KMS
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
 *   2. `sendTransaction` serializes the EIP-1559 transaction with viem's
 *      `serializeTransaction`, keccak256s it, calls KMS `Sign` with
 *      MessageType=DIGEST and SigningAlgorithm=ECDSA_SHA_256, then:
 *        a. parses the DER (r, s),
 *        b. LOW-S NORMALIZES: if s > n/2, s = n - s. KMS returns either half
 *           and Ethereum rejects the high half (EIP-2). Skipping this produces
 *           intermittently invalid signatures, which is the classic KMS-signer
 *           bug and the reason this note exists.
 *        c. recovers the parity by trying yParity 0 and 1 and keeping the one
 *           that recovers to `this.address`,
 *        d. broadcasts the serialized signed tx via `eth_sendRawTransaction`.
 *   3. It NEVER exports or logs key material — KMS cannot export it, which is
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

  async sendTransaction(_tx: RelayerTxRequest): Promise<`0x${string}`> {
    this.unimplemented();
  }
  async pendingNonce(): Promise<number> {
    this.unimplemented();
  }
  async balance(): Promise<bigint> {
    this.unimplemented();
  }
}

/** A signer leased from the pool, plus the nonce it must use. */
export interface SignerLease {
  signer: RelayerSigner;
  nonce: number;
  /** Release the lease. `landed` advances the sequence; a failure rewinds it. */
  release(landed: boolean): void;
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
 * `release(false)` rewinds the sequence, because a send that never reached the
 * mempool left its nonce unused and the NEXT transaction must reuse it or every
 * later one is stuck behind a permanent gap.
 */
export class RelayerSignerPool {
  private readonly signers: RelayerSigner[];
  private readonly next = new Map<string, number>();
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

      let nonce = this.next.get(signer.address);
      if (nonce === undefined) {
        try {
          nonce = await signer.pendingNonce();
        } catch (err) {
          this.busy.delete(signer.address);
          throw err;
        }
      }
      const claimed = nonce;
      this.next.set(signer.address, claimed);

      let released = false;
      return {
        signer,
        nonce: claimed,
        release: (landed: boolean) => {
          if (released) return;
          released = true;
          // Landed (or at least broadcast): the nonce is spent, move on.
          // Not landed: it never reached the mempool, so leave the sequence
          // where it was or every later tx queues behind a gap that never fills.
          this.next.set(signer.address, landed ? claimed + 1 : claimed);
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
  rpcUrl: string | readonly string[] | undefined,
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
