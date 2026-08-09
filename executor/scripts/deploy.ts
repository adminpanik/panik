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

function requiredNumberEnv(
  name: string,
  fallback: string,
  min: number,
  max: number
): number {
  const raw = (process.env[name] ?? fallback).trim();
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${name}: ${raw} (must be an integer in [${min}, ${max}])`);
  }
  return parsed;
}

async function assertIsContract(label: string, address: string): Promise<void> {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") {
    throw new Error(`${label} has no code at ${address} on this network`);
  }
}

function row(label: string, expected: string, actual: string): string {
  const ok = expected.toLowerCase() === actual.toLowerCase();
  return `${ok ? "  ok  " : " FAIL "} | ${label.padEnd(34)} | ${actual}`;
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

  // --- Delegated (v2) config ---------------------------------------------
  const BASE_MAINNET_CHAIN_ID = 8453n;
  const targetChainId = (await ethers.provider.getNetwork()).chainId;
  const isMainnet = targetChainId === BASE_MAINNET_CHAIN_ID;

  const priceFeedAssets = uniqueAddresses(csv("PRICE_FEED_ASSETS"));
  const priceFeeds = uniqueAddresses(csv("PRICE_FEEDS"));
  if (priceFeedAssets.length !== priceFeeds.length) {
    throw new Error(
      "Price feed config length mismatch: PRICE_FEED_ASSETS and PRICE_FEEDS must match."
    );
  }

  const mockOracleAssetsNorm = mockOracleAssets.map((value) => ethers.getAddress(value));
  // M-3: the mock oracle is an unguarded, hand-set price source (no staleness,
  // no positivity). The constructor reverts if it ships to Base mainnet; catch
  // it here first with a message that names the offending assets.
  if (isMainnet && mockOracleAssetsNorm.length > 0) {
    throw new Error(
      `MOCK_ORACLE_ASSETS must be empty on Base mainnet (chainId 8453). Offending: ${mockOracleAssetsNorm.join(", ")}`
    );
  }
  // A single asset must have ONE price source, or the mock (unguarded) branch
  // silently wins over its real feed. The constructor enforces this too.
  const overlap = priceFeedAssets.filter((asset) => mockOracleAssetsNorm.includes(asset));
  if (overlap.length > 0) {
    throw new Error(
      `Assets appear in both PRICE_FEED_ASSETS and MOCK_ORACLE_ASSETS: ${overlap.join(", ")}`
    );
  }

  // Every asset a delegated exit can swap needs a dateable feed, or the exit
  // reverts MissingPriceFeed at execution time. Catch that here, not on-chain.
  for (const asset of swapAssets.map((value) => ethers.getAddress(value))) {
    const hasFeed = priceFeedAssets.includes(asset);
    const isMockOracleAsset = mockOracleAssetsNorm.includes(asset);
    if (!hasFeed && !isMockOracleAsset) {
      console.warn(
        `WARNING: ${asset} has a swap route but no PRICE_FEEDS entry - delegated exits touching it will revert MissingPriceFeed.`
      );
    }
  }

  // An hour is already generous for a Chainlink heartbeat; a day is not a
  // staleness bound, it is a formality.
  const oracleStalenessSeconds = requiredNumberEnv(
    "ORACLE_STALENESS_SECONDS",
    "3600",
    60,
    86_400
  );
  const sequencerGracePeriod = requiredNumberEnv(
    "SEQUENCER_GRACE_PERIOD_SECONDS",
    "3600",
    0,
    86_400
  );
  // Default 200 bps (2%). The route is a fixed, submitter-sandwichable path, so
  // a wide default would make a large haircut the modelled norm; anything above
  // 2% must be an explicit, deliberate MAX_PERMIT_SLIPPAGE_BPS override. The
  // contract ceiling still caps it at 2000 (private-orderflow routing that would
  // justify going higher is a Phase-4 relayer concern, not built here).
  const maxPermitSlippageBps = requiredNumberEnv("MAX_PERMIT_SLIPPAGE_BPS", "200", 1, 2_000);
  const sequencerUptimeFeedRaw = (process.env.SEQUENCER_UPTIME_FEED ?? "").trim();
  const sequencerUptimeFeed =
    sequencerUptimeFeedRaw === "" || sequencerUptimeFeedRaw === ethers.ZeroAddress
      ? ethers.ZeroAddress
      : ethers.getAddress(sequencerUptimeFeedRaw);
  const delegatedMarkets = uniqueAddresses(csv("DELEGATED_MARKETS"));

  const trackedAssets = uniqueAddresses([
    usdc,
    ...swapAssets,
    ...mockOracleAssets,
    ...trackedAssetsRaw,
    ...priceFeedAssets,
  ]);

  console.log("Validating delegated config against the network...");
  if (sequencerUptimeFeed === ethers.ZeroAddress) {
    console.warn(
      "WARNING: SEQUENCER_UPTIME_FEED is unset - delegated exits will NOT check sequencer uptime. Acceptable on Base Sepolia only."
    );
  } else {
    await assertIsContract("SEQUENCER_UPTIME_FEED", sequencerUptimeFeed);
  }
  // M-2: a wrong-base or wrong-decimals feed produces a near-zero slippage
  // floor and the delegated swap then succeeds at a robbery price. The contract
  // reads and bounds decimals at construction, but base currency and sane value
  // can only be checked off-chain, so it happens here and HARD-FAILS.
  const feedAbi = [
    "function decimals() view returns (uint8)",
    "function description() view returns (string)",
    "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  ];
  // Plausible USD price band per asset, in whole dollars. Anything outside is
  // almost certainly a wrong feed (wrong base, wrong decimals, wrong asset).
  const PRICE_MIN_USD = 0.1;
  const PRICE_MAX_USD = 5_000_000;
  for (let i = 0; i < priceFeeds.length; i++) {
    const asset = priceFeedAssets[i];
    const feed = priceFeeds[i];
    await assertIsContract("PRICE_FEEDS entry", feed);
    const feedContract = new ethers.Contract(feed, feedAbi, ethers.provider);
    const decimals = Number(await feedContract.decimals());
    if (decimals > 18) {
      throw new Error(`PRICE_FEEDS ${feed} for ${asset}: decimals ${decimals} > 18`);
    }
    let description = "";
    try {
      description = await feedContract.description();
    } catch {
      throw new Error(`PRICE_FEEDS ${feed} for ${asset}: description() reverted - not a Chainlink feed?`);
    }
    if (!/\/\s*USD$/i.test(description.trim())) {
      throw new Error(
        `PRICE_FEEDS ${feed} for ${asset}: description "${description}" is not a "/ USD" feed. The floor math assumes a shared USD base.`
      );
    }
    const [, answer] = await feedContract.latestRoundData();
    if (answer <= 0n) {
      throw new Error(`PRICE_FEEDS ${feed} for ${asset}: non-positive answer ${answer}`);
    }
    const humanPrice = Number(ethers.formatUnits(answer, decimals));
    console.log(`  feed ${asset} -> ${feed}  "${description}"  ~$${humanPrice}`);
    if (humanPrice < PRICE_MIN_USD || humanPrice > PRICE_MAX_USD) {
      throw new Error(
        `PRICE_FEEDS ${feed} for ${asset}: decoded price $${humanPrice} outside [${PRICE_MIN_USD}, ${PRICE_MAX_USD}] - wrong feed or wrong decimals.`
      );
    }
  }
  for (const market of delegatedMarkets) {
    await assertIsContract("DELEGATED_MARKETS entry", market);
  }

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
    {
      priceFeedAssets,
      priceFeeds,
      oracleStalenessSeconds,
      sequencerUptimeFeed,
      sequencerGracePeriod,
      maxPermitSlippageBps,
      markets: delegatedMarkets,
    },
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

  // --- Post-deploy read-back ----------------------------------------------
  // v1 deployed and hoped. Everything below is read BACK off the chain and
  // compared with what was asked for, because a swap route or an adapter
  // binding that silently did not take is only discovered by a user's exit
  // reverting - or worse, not reverting.
  console.log("\nVerifying deployed state (read-back)...");
  const failures: string[] = [];
  const check = (label: string, expected: string, actual: string) => {
    const line = row(label, expected, actual);
    console.log(line);
    if (line.startsWith(" FAIL")) {
      failures.push(`${label}: expected ${expected}, got ${actual}`);
    }
  };

  console.log("  ---- swap routes ----");
  for (let i = 0; i < swapAssets.length; i++) {
    const asset = ethers.getAddress(swapAssets[i]);
    const [enabled, path, minOutBps, useMockOracle] = await panikExecutor.getSwapConfig(asset);
    check(`swap.enabled ${asset}`, "true", String(enabled));
    check(`swap.path ${asset}`, swapPaths[i].toLowerCase(), String(path).toLowerCase());
    check(`swap.minOutBps ${asset}`, String(swapMinOutBps[i]), String(minOutBps));
    check(
      `swap.useMockOracle ${asset}`,
      String(
        mockOracleAssets.map((value) => ethers.getAddress(value)).includes(asset)
      ),
      String(useMockOracle)
    );
  }

  console.log("  ---- adapter bindings ----");
  const adapterBindings: Array<[string, any]> = [
    ["aaveAdapter.executor", aaveAdapter],
    ["moonwellAdapter.executor", moonwellAdapter],
    ["compoundAdapter.executor", compoundAdapter],
    ["morphoAdapter.executor", morphoAdapter],
    ["swapAdapter.executor", swapAdapter],
    ["uniswapAdapter.executor", uniswapAdapter],
  ];
  for (const [label, adapter] of adapterBindings) {
    check(label, panikExecutorAddress, await (adapter as any).executor());
  }

  console.log("  ---- delegated config ----");
  check("usdc", ethers.getAddress(usdc), await panikExecutor.usdc());
  check(
    "oracleStalenessSeconds",
    String(oracleStalenessSeconds),
    String(await panikExecutor.oracleStalenessSeconds())
  );
  check(
    "sequencerUptimeFeed",
    sequencerUptimeFeed,
    await panikExecutor.sequencerUptimeFeed()
  );
  check(
    "sequencerGracePeriod",
    String(sequencerGracePeriod),
    String(await panikExecutor.sequencerGracePeriod())
  );
  check(
    "maxPermitSlippageBps",
    String(maxPermitSlippageBps),
    String(await panikExecutor.maxPermitSlippageBps())
  );
  for (let i = 0; i < priceFeedAssets.length; i++) {
    check(
      `priceFeed ${priceFeedAssets[i]}`,
      priceFeeds[i],
      await panikExecutor.getPriceFeed(priceFeedAssets[i])
    );
    const feedContract = new ethers.Contract(
      priceFeeds[i],
      ["function decimals() view returns (uint8)"],
      ethers.provider
    );
    check(
      `priceFeed.decimals ${priceFeedAssets[i]}`,
      String(Number(await feedContract.decimals())),
      String(await panikExecutor.getPriceFeedDecimals(priceFeedAssets[i]))
    );
  }
  for (const market of delegatedMarkets) {
    check(`delegatedMarket ${market}`, "true", String(await panikExecutor.isDelegatedMarket(market)));
  }

  console.log("  ---- tracked assets ----");
  const onChainTracked = (await panikExecutor.getTrackedAssets()).map((value: string) =>
    ethers.getAddress(value)
  );
  for (const asset of trackedAssets) {
    check(`tracked ${asset}`, "true", String(onChainTracked.includes(asset)));
  }

  if (failures.length > 0) {
    throw new Error(
      `Post-deploy verification failed (${failures.length}):\n - ${failures.join("\n - ")}`
    );
  }
  console.log("Read-back verification passed.\n");

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
      priceFeedAssets,
      priceFeeds,
      oracleStalenessSeconds,
      sequencerUptimeFeed,
      sequencerGracePeriod,
      maxPermitSlippageBps,
      delegatedMarkets,
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
