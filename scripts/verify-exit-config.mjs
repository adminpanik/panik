/**
 * PANIK — exit config drift check.
 *
 * src/panik-core/lib/exit.generated.ts is a generated snapshot of the exit
 * executor deployment (addresses + ABIs). Nothing else re-checks it against
 * the live chain, so a redeploy of the executor (or a hand-edit of the
 * generated file) can silently go stale. This script reads the generated
 * constants and verifies each address and getter against Base Sepolia.
 *
 * Usage:  node scripts/verify-exit-config.mjs
 * RPC:    https://sepolia.base.org by default; override with EXIT_VERIFY_RPC_URL.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — drift detected (an address, getter, or decimals mismatch)
 *   2 — could not verify (RPC unreachable) — not the same as drift
 */
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import {
  EXIT_CHAIN_ID,
  EXECUTOR_ADDRESS,
  LOCK_CHECKER_ADDRESS,
  EXIT_ADAPTERS,
  EXIT_USDC_ADDRESS,
  EXIT_DATA_PROVIDER_ADDRESS,
  EXECUTOR_ABI,
} from "../src/panik-core/lib/exit.generated.ts";

const RPC_URL = process.env.EXIT_VERIFY_RPC_URL ?? "https://sepolia.base.org";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL),
});

const results = [];
let networkError = false;

function addr(a) {
  return typeof a === "string" ? a.toLowerCase() : a;
}

async function run(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (err) {
    const message = err?.shortMessage ?? err?.message ?? String(err);
    const isNetwork =
      /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|HTTP request failed|timed? ?out/i.test(
        message,
      );
    if (isNetwork) networkError = true;
    results.push({ name, ok: false, network: isNetwork, detail: message });
  }
}

// ── 0. Connectivity + chain id canary ────────────────────────────────────
// Fail fast and distinctly if the RPC itself is unreachable, rather than
// letting every subsequent check report a confusing individual timeout.
try {
  const liveChainId = await client.getChainId();
  results.push({
    name: "RPC reachable",
    ok: liveChainId === EXIT_CHAIN_ID,
    detail:
      liveChainId === EXIT_CHAIN_ID
        ? `chain id ${liveChainId}`
        : `chain id mismatch: RPC reports ${liveChainId}, generated file says ${EXIT_CHAIN_ID}`,
  });
} catch (err) {
  const message = err?.shortMessage ?? err?.message ?? String(err);
  console.error("Could not verify exit config: RPC unreachable.");
  console.error(`  RPC: ${RPC_URL}`);
  console.error(`  Error: ${message}`);
  console.error("This is a network problem, not confirmed drift.");
  process.exit(2);
}

// ── 1. Bytecode exists at every address ──────────────────────────────────
const codeTargets = [
  ["Executor bytecode", EXECUTOR_ADDRESS],
  ["LockChecker bytecode", LOCK_CHECKER_ADDRESS],
  ["Aave adapter bytecode", EXIT_ADAPTERS.aave],
  ["Moonwell adapter bytecode", EXIT_ADAPTERS.moonwell],
  ["Compound adapter bytecode", EXIT_ADAPTERS.compound],
  ["Morpho adapter bytecode", EXIT_ADAPTERS.morpho],
  ["USDC bytecode", EXIT_USDC_ADDRESS],
  ["Data provider bytecode", EXIT_DATA_PROVIDER_ADDRESS],
];

for (const [name, address] of codeTargets) {
  await run(name, async () => {
    const code = await client.getCode({ address });
    if (!code || code === "0x") {
      throw new Error(`no bytecode at ${address} (contract not deployed here, or address is stale)`);
    }
    return `${address} (${code.length} bytes hex)`;
  });
}

// ── 2. Executor getters match the generated addresses ────────────────────
const getterChecks = [
  ["usdc()", "usdc", EXIT_USDC_ADDRESS],
  ["lockChecker()", "lockChecker", LOCK_CHECKER_ADDRESS],
  ["dataProvider()", "dataProvider", EXIT_DATA_PROVIDER_ADDRESS],
  ["aaveAdapter()", "aaveAdapter", EXIT_ADAPTERS.aave],
  ["moonwellAdapter()", "moonwellAdapter", EXIT_ADAPTERS.moonwell],
  ["compoundAdapter()", "compoundAdapter", EXIT_ADAPTERS.compound],
  ["morphoAdapter()", "morphoAdapter", EXIT_ADAPTERS.morpho],
];

for (const [name, fn, expected] of getterChecks) {
  await run(`executor.${name}`, async () => {
    const live = await client.readContract({
      address: EXECUTOR_ADDRESS,
      abi: EXECUTOR_ABI,
      functionName: fn,
    });
    if (addr(live) !== addr(expected)) {
      throw new Error(`generated=${expected} live=${live} — regenerate with npm run sync:exit-config`);
    }
    return `${live} matches generated`;
  });
}

// ── 3. USDC decimals() === 6 ──────────────────────────────────────────────
const ERC20_DECIMALS_ABI = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
];

await run("usdc.decimals()", async () => {
  const decimals = await client.readContract({
    address: EXIT_USDC_ADDRESS,
    abi: ERC20_DECIMALS_ABI,
    functionName: "decimals",
  });
  if (decimals !== 6) {
    throw new Error(`expected 6, got ${decimals}`);
  }
  return "6";
});

// ── Report ─────────────────────────────────────────────────────────────
console.log("\nPANIK exit config drift check\n" + "─".repeat(72));
for (const r of results) {
  const mark = r.ok ? "PASS" : r.network ? "ERR " : "FAIL";
  console.log(`${mark}  ${r.name.padEnd(32)} ${r.detail}`);
}
console.log("─".repeat(72));

const failed = results.filter((r) => !r.ok);

if (networkError) {
  console.error(`Could not verify: ${failed.filter((r) => r.network).length} check(s) hit a network error.`);
  console.error("This is a network problem, not confirmed drift.");
  process.exit(2);
}

if (failed.length > 0) {
  console.error(`${failed.length} check(s) FAILED — exit.generated.ts has drifted from the live chain.`);
  console.error("Regenerate with: EXIT_CONFIG_SOURCE=<path> npm run sync:exit-config");
  process.exit(1);
}

console.log("exit.generated.ts matches the live chain.");
process.exit(0);
