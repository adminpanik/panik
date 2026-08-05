/**
 * Compile and deploy PanikEscrow to Base Sepolia. **Testnet only** — this
 * script refuses to run against any other chain. For Base Mainnet use the
 * Foundry script, which picks USDC from the chain id:
 *
 *   cd contracts
 *   forge script script/Deploy.s.sol:DeployPanikEscrow --rpc-url base --broadcast --verify -vvvv
 *
 * Usage:
 *   node --env-file=.env scripts/deploy-escrow.mjs
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY   — private key of the deployer wallet (with Base Sepolia ETH for gas)
 *   ESCROW_OWNER_ADDRESS   — owner of the contract (can call ship())
 *   ESCROW_TREASURY_ADDRESS — where released funds go
 */

import solc from 'solc';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

// ── Chain guard ──────────────────────────────────────────────────────
// The USDC address below and every explorer link in this file are Base
// Sepolia, and `usdc` is immutable on the escrow — running this against
// mainnet would permanently hardwire a mainnet escrow to a testnet token.
// Assert the chain instead of trusting whoever edits the import above.
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

// ── Compile the contract ─────────────────────────────────────────────
console.log('🔨 Compiling PanikEscrow.sol...');

// Compile the real contracts/src/PanikEscrow.sol — never a copy. A second
// inlined copy of the source would drift from the file Foundry tests, and the
// deployed bytecode must come from the audited/tested source.
const CONTRACTS_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'contracts',
  'src',
);

const ENTRY = 'PanikEscrow.sol';

/**
 * Resolve a solc source-unit name to a file under contracts/src.
 * Relative imports (e.g. `./interfaces/IERC20.sol` from `PanikEscrow.sol`)
 * are normalised by solc before they reach us, so the unit name is already
 * a path relative to contracts/src.
 */
function readSource(unitName) {
  const filePath = path.resolve(CONTRACTS_SRC, unitName);
  if (!filePath.startsWith(CONTRACTS_SRC + path.sep)) {
    throw new Error(`Refusing to read source outside contracts/src: ${unitName}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

const input = {
  language: 'Solidity',
  sources: { [ENTRY]: { content: readSource(ENTRY) } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

// solc calls back for every import it can't find in `sources` above.
const findImport = (unitName) => {
  try {
    return { contents: readSource(unitName) };
  } catch (err) {
    return { error: err.message };
  }
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));

if (output.errors) {
  const fatal = output.errors.filter(e => e.severity === 'error');
  if (fatal.length > 0) {
    console.error('❌ Compilation errors:');
    fatal.forEach(e => console.error(e.formattedMessage));
    process.exit(1);
  }
  // Warnings are OK
  output.errors.filter(e => e.severity === 'warning').forEach(e => {
    console.warn('⚠️', e.message);
  });
}

const contract = output.contracts['PanikEscrow.sol']['PanikEscrow'];
const abi = contract.abi;
const bytecode = '0x' + contract.evm.bytecode.object;

console.log('✅ Compiled successfully');
console.log(`   ABI entries: ${abi.length}`);
console.log(`   Bytecode: ${bytecode.length} chars`);

// Save ABI to a file for the frontend to use
const abiDir = path.resolve('contracts', 'out');
fs.mkdirSync(abiDir, { recursive: true });
fs.writeFileSync(path.join(abiDir, 'PanikEscrow.abi.json'), JSON.stringify(abi, null, 2));
console.log('   ABI saved to contracts/out/PanikEscrow.abi.json');

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
