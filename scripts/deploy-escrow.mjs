/**
 * Deploy PanikEscrow to Base Sepolia. **Testnet only** — this script refuses to
 * run against any other chain. For Base Mainnet use the Foundry script:
 *
 *   cd contracts
 *   forge script script/Deploy.s.sol:DeployPanikEscrow --rpc-url base --broadcast --verify -vvvv
 *
 * Usage:
 *   node --env-file=.env scripts/deploy-escrow.mjs
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY    — private key of the deployer wallet (with Base Sepolia ETH for gas)
 *   ESCROW_OWNER_ADDRESS    — owner of the contract (can call ship())
 *   ESCROW_TREASURY_ADDRESS — where released funds go
 *
 * Requires Foundry on PATH: https://getfoundry.sh
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

// ── Chain guard ──────────────────────────────────────────────────────
// The USDC address below and every explorer link in this file are Base
// Sepolia. `usdc` is immutable on the escrow, so deploying this to mainnet
// would permanently hardwire a mainnet escrow to a testnet token. Assert the
// chain rather than trusting whoever edits the import above.
const CHAIN = baseSepolia;
const BASE_SEPOLIA_CHAIN_ID = 84532;

if (CHAIN.id !== BASE_SEPOLIA_CHAIN_ID) {
  throw new Error(
    `deploy-escrow.mjs is Base Sepolia only (chain id ${BASE_SEPOLIA_CHAIN_ID}), got ${CHAIN.id}. ` +
      'For Base Mainnet use: cd contracts && forge script script/Deploy.s.sol:DeployPanikEscrow --rpc-url base --broadcast --verify'
  );
}

// ── Base Sepolia USDC (Circle-issued test USDC) ──────────────────────
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

// ── Read env ─────────────────────────────────────────────────────────
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const OWNER = process.env.ESCROW_OWNER_ADDRESS;
const TREASURY = process.env.ESCROW_TREASURY_ADDRESS;

if (!PRIVATE_KEY) { console.error('❌ Set DEPLOYER_PRIVATE_KEY in .env'); process.exit(1); }
if (!OWNER) { console.error('❌ Set ESCROW_OWNER_ADDRESS in .env'); process.exit(1); }
if (!TREASURY) { console.error('❌ Set ESCROW_TREASURY_ADDRESS in .env'); process.exit(1); }

// ── Build with Foundry ───────────────────────────────────────────────
// One source of truth for the compiler: contracts/foundry.toml. Hand-rolling a
// solc standard-json here produced byte-identical *executable* code but a
// different metadata hash (different evmVersion, source unit names and
// remappings), so a contract deployed from here could not be verified against
// the Foundry build — and any construct the two configs optimise differently
// would silently ship untested bytecode. Shell out instead.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS_DIR = path.join(REPO_ROOT, 'contracts');
const ARTIFACT = path.join(CONTRACTS_DIR, 'out', 'PanikEscrow.sol', 'PanikEscrow.json');

console.log('🔨 Building PanikEscrow.sol with Foundry...');

try {
  execFileSync('forge', ['build', '--root', CONTRACTS_DIR], { stdio: 'inherit' });
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error('❌ `forge` not found on PATH. Install Foundry: https://getfoundry.sh');
  } else {
    console.error('❌ `forge build` failed — fix the compile error before deploying.');
  }
  process.exit(1);
}

if (!fs.existsSync(ARTIFACT)) {
  console.error(`❌ Build artifact missing: ${ARTIFACT}`);
  process.exit(1);
}

const artifact = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
const abi = artifact.abi;
const bytecode = artifact.bytecode.object;

if (!abi || !bytecode || bytecode === '0x') {
  console.error('❌ Build artifact has no ABI/bytecode — is the contract abstract?');
  process.exit(1);
}

console.log('✅ Built from contracts/out/PanikEscrow.sol/PanikEscrow.json');
console.log(`   ABI entries: ${abi.length}`);
console.log(`   Bytecode: ${bytecode.length} chars`);

// ── Deploy ───────────────────────────────────────────────────────────
console.log('\n🚀 Deploying to Base Sepolia...');
console.log(`   Owner:    ${OWNER}`);
console.log(`   Treasury: ${TREASURY}`);
console.log(`   USDC:     ${BASE_SEPOLIA_USDC}`);

const account = privateKeyToAccount(PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`);
console.log(`   Deployer: ${account.address}`);

const publicClient = createPublicClient({
  chain: CHAIN,
  transport: http(),
});

const walletClient = createWalletClient({
  account,
  chain: CHAIN,
  transport: http(),
});

// The RPC gets the same treatment as the config: confirm what we are actually
// talking to before a key signs anything.
const liveChainId = await publicClient.getChainId();
if (liveChainId !== BASE_SEPOLIA_CHAIN_ID) {
  console.error(
    `❌ RPC reports chain id ${liveChainId}, expected ${BASE_SEPOLIA_CHAIN_ID} (Base Sepolia). Refusing to deploy.`
  );
  process.exit(1);
}

// Check deployer balance
const balance = await publicClient.getBalance({ address: account.address });
console.log(`   Balance:  ${(Number(balance) / 1e18).toFixed(6)} ETH`);

if (balance === 0n) {
  console.error('❌ Deployer has no ETH on Base Sepolia. Get some from a faucet:');
  console.error('   https://www.alchemy.com/faucets/base-sepolia');
  process.exit(1);
}

// Deploy
const hash = await walletClient.deployContract({
  abi,
  bytecode,
  args: [BASE_SEPOLIA_USDC, OWNER, TREASURY],
});

console.log(`\n⏳ Tx submitted: ${hash}`);
console.log(`   https://sepolia.basescan.org/tx/${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });

if (receipt.status === 'success') {
  console.log(`\n🎉 Contract deployed!`);
  console.log(`   Address: ${receipt.contractAddress}`);
  console.log(`   https://sepolia.basescan.org/address/${receipt.contractAddress}`);
  console.log(`\n📋 Next step — add this to your .env:`);
  console.log(`   VITE_ESCROW_CONTRACT_ADDRESS=${receipt.contractAddress}`);
  console.log(`   VITE_ESCROW_CHAIN_ID=84532`);
} else {
  console.error('❌ Deployment failed!');
  console.error(receipt);
  process.exit(1);
}
