import { config as loadEnv } from "dotenv";
import { ethers, network } from "hardhat";
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

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  let nextNonce = await ethers.provider.getTransactionCount(
    deployer.address,
    "pending"
  );

  const usdc = requiredEnv("USDC");
  const aavePool = requiredEnv("AAVE_POOL");
  const dataProvider = requiredEnv("AAVE_PROTOCOL_DATA_PROVIDER");
  const marketOracle = requiredEnv("AAVE_ORACLE");
  const mockOracle = requiredEnv("MOCK_ORACLE");
  const universalRouter = requiredEnv("UNIVERSAL_ROUTER");
  const nftManager = (
    process.env.NFT_POSITION_MANAGER ??
    requiredEnv("NONFUNGIBLE_POSITION_MANAGER")
  ).trim();
  // Morpho Blue singleton (same address on Base mainnet + sepolia deployments).
  const morphoBlue = requiredEnv("MORPHO_BLUE");

  const stableDebtCooldownSeconds = BigInt(
    process.env.STABLE_DEBT_COOLDOWN_SECONDS ?? "3600"
  );
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

  // Mainnet-ready posture: refuse the old near-zero slippage floors. Stables
  // belong at ~9970, majors ~9900, long-tail >= 9500.
  const swapMinOutBps = swapMinOutBpsRaw.map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 9_000 || parsed > 10_000) {
      throw new Error(
        `Invalid SWAP_MIN_OUT_BPS value: ${value} (must be 9000-10000; near-zero floors are not allowed)`
      );
    }
    return parsed;
  });

  const trackedAssets = uniqueAddresses([
    usdc,
    ...swapAssets,
    ...mockOracleAssets,
    ...trackedAssetsRaw,
  ]);

  console.log("Deploying LockChecker...");
  const LockChecker = await ethers.getContractFactory("LockChecker");
  const lockChecker = await LockChecker.deploy(
    dataProvider,
    stableDebtCooldownSeconds,
    { nonce: nextNonce++ }
  );
  await lockChecker.waitForDeployment();

  console.log("Deploying AaveAdapter...");
  const AaveAdapter = await ethers.getContractFactory("AaveAdapter");
  const aaveAdapter = await AaveAdapter.deploy(aavePool, { nonce: nextNonce++ });
  await aaveAdapter.waitForDeployment();

  console.log("Deploying MoonwellAdapter...");
  const MoonwellAdapter = await ethers.getContractFactory("MoonwellAdapter");
  const moonwellAdapter = await MoonwellAdapter.deploy({ nonce: nextNonce++ });
  await moonwellAdapter.waitForDeployment();

  console.log("Deploying CompoundV3Adapter...");
  const CompoundV3Adapter = await ethers.getContractFactory("CompoundV3Adapter");
  const compoundAdapter = await CompoundV3Adapter.deploy({ nonce: nextNonce++ });
  await compoundAdapter.waitForDeployment();

  console.log("Deploying MorphoAdapter...");
  const MorphoAdapter = await ethers.getContractFactory("MorphoAdapter");
  const morphoAdapter = await MorphoAdapter.deploy(morphoBlue, { nonce: nextNonce++ });
  await morphoAdapter.waitForDeployment();

  console.log("Deploying SwapAdapter...");
  const SwapAdapter = await ethers.getContractFactory("SwapAdapter");
  const swapAdapter = await SwapAdapter.deploy(universalRouter, usdc, {
    nonce: nextNonce++,
  });
  await swapAdapter.waitForDeployment();

  console.log("Deploying UniswapAdapter...");
  const UniswapAdapter = await ethers.getContractFactory("UniswapAdapter");
  const uniswapAdapter = await UniswapAdapter.deploy(nftManager, {
    nonce: nextNonce++,
  });
  await uniswapAdapter.waitForDeployment();

  console.log("Deploying PanikExecutor...");
  const PanikExecutor = await ethers.getContractFactory("PanikExecutor");
  const panikExecutor = await PanikExecutor.deploy(
    usdc,
    dataProvider,
    marketOracle,
    mockOracle,
    await lockChecker.getAddress(),
    {
      aave: await aaveAdapter.getAddress(),
      moonwell: await moonwellAdapter.getAddress(),
      compound: await compoundAdapter.getAddress(),
      morpho: await morphoAdapter.getAddress(),
      swap: await swapAdapter.getAddress(),
      uniswap: await uniswapAdapter.getAddress(),
    },
    nftManager,
    {
      assets: swapAssets,
      paths: swapPaths,
      minOutBps: swapMinOutBps,
    },
    mockOracleAssets,
    trackedAssets,
    swapDeadlineBufferSeconds,
    { nonce: nextNonce++ }
  );
  await panikExecutor.waitForDeployment();
  const panikExecutorAddress = await panikExecutor.getAddress();

  console.log("Binding executor access on adapters...");
  for (const adapter of [
    aaveAdapter,
    moonwellAdapter,
    compoundAdapter,
    morphoAdapter,
    swapAdapter,
    uniswapAdapter,
  ]) {
    const tx = await (adapter as any).setExecutor(panikExecutorAddress, {
      nonce: nextNonce++,
    });
    await tx.wait();
  }

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const deployment = {
    chainId,
    network: network.name,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    addresses: {
      lockChecker: await lockChecker.getAddress(),
      aaveAdapter: await aaveAdapter.getAddress(),
      moonwellAdapter: await moonwellAdapter.getAddress(),
      compoundAdapter: await compoundAdapter.getAddress(),
      morphoAdapter: await morphoAdapter.getAddress(),
      swapAdapter: await swapAdapter.getAddress(),
      uniswapAdapter: await uniswapAdapter.getAddress(),
      panikExecutor: panikExecutorAddress,
    },
    config: {
      usdc,
      aavePool,
      dataProvider,
      marketOracle,
      mockOracle,
      universalRouter,
      nftManager,
      morphoBlue,
      stableDebtCooldownSeconds: stableDebtCooldownSeconds.toString(),
      swapDeadlineBufferSeconds: swapDeadlineBufferSeconds.toString(),
      swapAssets,
      swapPaths,
      swapMinOutBps,
      mockOracleAssets,
      trackedAssets,
    },
  };

  const outputDir = path.resolve(process.cwd(), "deploy");
  const suffix = network.name === "baseSepolia" ? "base-sepolia" : network.name;
  const outputFile = path.join(outputDir, `addresses.${suffix}.json`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(deployment, null, 2));

  // Single config consumed by BOTH frontends (this repo's and panik-core's
  // sync:exit-config): addresses + the executor/lockChecker ABIs.
  const executorArtifact = await import(
    "../artifacts/contracts/PanikExecutor.sol/PanikExecutor.json"
  );
  const lockCheckerArtifact = await import(
    "../artifacts/contracts/LockChecker.sol/LockChecker.json"
  );
  const onchainConfig = {
    chainId,
    network: network.name,
    deployedAt: deployment.deployedAt,
    executor: panikExecutorAddress,
    adapters: deployment.addresses,
    tokens: { usdc },
    config: deployment.config,
    abi: {
      executor: executorArtifact.abi,
      lockChecker: lockCheckerArtifact.abi,
    },
  };
  const onchainConfigFile = path.join(outputDir, "onchain-config.json");
  fs.writeFileSync(onchainConfigFile, JSON.stringify(onchainConfig, null, 2));

  console.log("Deployment complete.");
  console.log(JSON.stringify(deployment.addresses, null, 2));
  console.log(`Saved deployment file: ${outputFile}`);
  console.log(`Saved onchain config: ${onchainConfigFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
