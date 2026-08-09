import { config as loadEnv } from "dotenv";
import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";

loadEnv();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value.trim();
}

function csv(name: string): string[] {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function uniqueAddresses(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    if (!ethers.isAddress(value)) {
      throw new Error(`Invalid address value: ${value}`);
    }
    const normalized = ethers.getAddress(value);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}

type DeploymentFile = {
  chainId: number;
  network: string;
  deployedAt: string;
  deployer: string;
  addresses: {
    lockChecker: string;
    aaveAdapter: string;
    swapAdapter: string;
    uniswapAdapter?: string;
    panikExecutor: string;
  };
  config: Record<string, unknown>;
};

function readBaseDeploymentFile(): DeploymentFile {
  const deploymentPath = path.resolve(
    process.cwd(),
    "deploy",
    "addresses.base-sepolia.json"
  );
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(
      `Missing deployment file: ${deploymentPath}. Deploy base stack first.`
    );
  }

  const parsed = JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as DeploymentFile;
  if (parsed.chainId !== 84532) {
    throw new Error(`Unexpected deployment chainId ${parsed.chainId}. Expected 84532.`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No deployer signer available. Set DEPLOYER_PRIVATE_KEY in .env to a valid 32-byte private key."
    );
  }

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 84532n) {
    throw new Error(`Wrong network chainId ${network.chainId}. Expected 84532 (Base Sepolia).`);
  }

  const existing = readBaseDeploymentFile();
  const lockChecker = existing.addresses.lockChecker;
  const aaveAdapter = existing.addresses.aaveAdapter;
  const swapAdapter = existing.addresses.swapAdapter;

  const usdc = requiredEnv("USDC");
  const dataProvider = requiredEnv("AAVE_PROTOCOL_DATA_PROVIDER");
  const marketOracle = requiredEnv("AAVE_ORACLE");
  const mockOracle = requiredEnv("MOCK_ORACLE");
  const nftManager = requiredEnv("NONFUNGIBLE_POSITION_MANAGER");

  const swapDeadlineBufferSeconds = BigInt(
    process.env.SWAP_DEADLINE_BUFFER_SECONDS ?? "300"
  );
  const swapAssets = csv("SWAP_ASSETS");
  const swapPaths = csv("SWAP_PATHS");
  const swapMinOutBpsRaw = csv("SWAP_MIN_OUT_BPS");
  const mockOracleAssets = csv("MOCK_ORACLE_ASSETS");
  const trackedAssetsRaw = csv("TRACKED_ASSETS");

  if (
    swapAssets.length !== swapPaths.length ||
    swapAssets.length !== swapMinOutBpsRaw.length
  ) {
    throw new Error(
      "Swap config length mismatch: SWAP_ASSETS, SWAP_PATHS, SWAP_MIN_OUT_BPS must match."
    );
  }

  const swapMinOutBps = swapMinOutBpsRaw.map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
      throw new Error(`Invalid SWAP_MIN_OUT_BPS value: ${value}`);
    }
    return parsed;
  });

  const trackedAssets = uniqueAddresses([
    usdc,
    ...swapAssets,
    ...mockOracleAssets,
    ...trackedAssetsRaw,
  ]);

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Reusing lockChecker: ${lockChecker}`);
  console.log(`Reusing aaveAdapter: ${aaveAdapter}`);
  console.log(`Reusing swapAdapter: ${swapAdapter}`);
  console.log(`NFT Manager: ${nftManager}`);

  // ── Step 1: Deploy UniswapAdapter ──
  console.log("\n[1/3] Deploying UniswapAdapter...");
  const UniswapAdapter = await ethers.getContractFactory("UniswapAdapter");
  const uniswapAdapter = await UniswapAdapter.deploy(nftManager);
  await uniswapAdapter.waitForDeployment();
  const uniswapAdapterAddress = await uniswapAdapter.getAddress();
  console.log(`UniswapAdapter: ${uniswapAdapterAddress}`);

  // ── Step 2: Deploy PanikExecutor (with uniswapAdapter + nftManager) ──
  console.log("\n[2/3] Deploying PanikExecutor...");
  const PanikExecutor = await ethers.getContractFactory("PanikExecutor");
  const panikExecutor = await PanikExecutor.deploy(
    usdc,
    dataProvider,
    marketOracle,
    mockOracle,
    lockChecker,
    aaveAdapter,
    swapAdapter,
    uniswapAdapterAddress,  // NEW: uniswapAdapter
    nftManager,              // NEW: nftManager
    swapAssets,
    swapPaths,
    swapMinOutBps,
    mockOracleAssets,
    trackedAssets,
    swapDeadlineBufferSeconds
  );
  await panikExecutor.waitForDeployment();
  const panikExecutorAddress = await panikExecutor.getAddress();
  console.log(`PanikExecutor: ${panikExecutorAddress}`);

  // ── Step 3: Bind executor on all adapters ──
  console.log("\n[3/3] Binding executor on all adapters...");

  const aaveAdapterContract = await ethers.getContractAt("AaveAdapter", aaveAdapter);
  const bindAaveTx = await aaveAdapterContract.setExecutor(panikExecutorAddress);
  await bindAaveTx.wait();
  console.log(`  AaveAdapter.setExecutor(${panikExecutorAddress}) ✓`);

  const swapAdapterContract = await ethers.getContractAt("SwapAdapter", swapAdapter);
  const bindSwapTx = await swapAdapterContract.setExecutor(panikExecutorAddress);
  await bindSwapTx.wait();
  console.log(`  SwapAdapter.setExecutor(${panikExecutorAddress}) ✓`);

  const bindUniswapTx = await uniswapAdapter.setExecutor(panikExecutorAddress);
  await bindUniswapTx.wait();
  console.log(`  UniswapAdapter.setExecutor(${panikExecutorAddress}) ✓`);

  // ── Save deployment output ──
  const outputDir = path.resolve(process.cwd(), "deploy");
  fs.mkdirSync(outputDir, { recursive: true });

  const singleOutput = {
    chainId: 84532,
    network: "baseSepolia",
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    panikExecutor: panikExecutorAddress,
    uniswapAdapter: uniswapAdapterAddress,
    reused: {
      lockChecker,
      aaveAdapter,
      swapAdapter,
    },
    config: {
      usdc,
      dataProvider,
      marketOracle,
      mockOracle,
      nftManager,
      swapDeadlineBufferSeconds: swapDeadlineBufferSeconds.toString(),
      swapAssets,
      swapPaths,
      swapMinOutBps,
      mockOracleAssets,
      trackedAssets,
    },
  };

  const singleOutputFile = path.join(outputDir, "panik-executor.base-sepolia.json");
  fs.writeFileSync(singleOutputFile, JSON.stringify(singleOutput, null, 2));

  const merged: DeploymentFile = {
    ...existing,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    addresses: {
      ...existing.addresses,
      uniswapAdapter: uniswapAdapterAddress,
      panikExecutor: panikExecutorAddress,
    },
    config: {
      ...existing.config,
      usdc,
      dataProvider,
      marketOracle,
      mockOracle,
      nftManager,
      swapDeadlineBufferSeconds: swapDeadlineBufferSeconds.toString(),
      swapAssets,
      swapPaths,
      swapMinOutBps,
      mockOracleAssets,
      trackedAssets,
    },
  };

  const mergedOutputFile = path.join(outputDir, "addresses.base-sepolia.json");
  fs.writeFileSync(mergedOutputFile, JSON.stringify(merged, null, 2));

  console.log(`\nSaved: ${singleOutputFile}`);
  console.log(`Updated: ${mergedOutputFile}`);
  console.log("\n═══════════════════════════════════════════════");
  console.log("DEPLOYMENT COMPLETE");
  console.log("═══════════════════════════════════════════════");
  console.log(`PanikExecutor:   ${panikExecutorAddress}`);
  console.log(`UniswapAdapter:  ${uniswapAdapterAddress}`);
  console.log("");
  console.log("NEXT STEP: Run the frontend sync to update generated.ts:");
  console.log("  cd frontend && npm run sync:onchain");
  console.log("═══════════════════════════════════════════════");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
