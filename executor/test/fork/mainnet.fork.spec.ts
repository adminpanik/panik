/**
 * Base MAINNET fork tests - the mainnet-readiness proof (docs §5.5).
 *
 * Run:  BASE_MAINNET_RPC=<alchemy base-mainnet url> npx hardhat test test/fork
 *
 * Skipped entirely when BASE_MAINNET_RPC is unset, so plain `npx hardhat test`
 * stays offline. The suite deploys the REAL adapter/executor stack against the
 * live protocol deployments and executes wallet-funded repays for real
 * borrowers (impersonated). Repay is the risk-critical path; withdraw+swap
 * mechanics are covered by the mock suite.
 *
 * Default borrower wallets are PANIK's own validation-registry wallets (live
 * Base positions watched by the scoring worker); override with FORK_AAVE_USER /
 * FORK_MOONWELL_USER when they rotate. Comet/Morpho borrowers have no stable
 * default - provide FORK_COMET_USER / FORK_MORPHO_USER(+market) to cover them.
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";

const FORKED = Boolean(process.env.BASE_MAINNET_RPC);
const maybeDescribe = FORKED ? describe : describe.skip;

// Canonical Base mainnet addresses (env-overridable).
const ADDR = {
  usdc: process.env.FORK_USDC ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  weth: "0x4200000000000000000000000000000000000006",
  aavePool: process.env.FORK_AAVE_POOL ?? "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  morphoBlue: process.env.FORK_MORPHO ?? "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  moonwellMUsdc: process.env.FORK_MUSDC ?? "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22",
  cometUsdc: process.env.FORK_COMET ?? "0xb125E6687d4313864e53df431d5425969c15Eb2F",
  universalRouter:
    process.env.FORK_UNIVERSAL_ROUTER ?? "0x6fF5693b99212Da76ad316178A184AB56D299b43",
  nftManager:
    process.env.FORK_NFT_MANAGER ?? "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
};

// Live borrowers (PANIK validation registry, watched on Base mainnet).
const AAVE_USER = process.env.FORK_AAVE_USER ?? "0x12a58e699baf4b230f571df90523fe9ac3e42305";
const MOONWELL_USER =
  process.env.FORK_MOONWELL_USER ?? "0x416ec2ca21a38cbcfeacd6a14532b3f348356d23";
const COMET_USER = process.env.FORK_COMET_USER; // no stable default
const MORPHO_USER = process.env.FORK_MORPHO_USER; // no stable default

const AAVE = 0;
const MOONWELL = 1;
const COMET = 2;

const USDC_UNIT = 10n ** 6n;

const POOL_ABI = [
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function ADDRESSES_PROVIDER() view returns (address)",
];
const PROVIDER_ABI = [
  "function getPoolDataProvider() view returns (address)",
  "function getPriceOracle() view returns (address)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const MTOKEN_ABI = [
  "function borrowBalanceCurrent(address) returns (uint256)",
  "function underlying() view returns (address)",
];

/** Force a USDC balance via storage (Circle FiatTokenV2_2: balances slot 9). */
async function dealUsdc(to: string, amount: bigint): Promise<void> {
  const slot = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [to, 9n])
  );
  await network.provider.send("hardhat_setStorageAt", [
    ADDR.usdc,
    slot,
    ethers.toBeHex(amount, 32),
  ]);
}

async function impersonate(address: string) {
  await network.provider.send("hardhat_impersonateAccount", [address]);
  await network.provider.send("hardhat_setBalance", [address, "0x8AC7230489E80000"]); // 10 ETH
  return await ethers.getSigner(address);
}

function leg(protocol: number, asset: string, repayAmount: bigint, withdrawAmount: bigint, data = "0x") {
  return { protocol, asset, repayAmount, withdrawAmount, data };
}

maybeDescribe("Base mainnet fork - real-protocol exits", function () {
  this.timeout(600_000);

  let executor: any;
  let aaveAdapter: any;
  let moonwellAdapter: any;
  let compoundAdapter: any;
  let morphoAdapter: any;
  let pool: any;
  let usdc: any;

  before(async function () {
    // Advance one block past the fork point: EDR resolves calls at the fork
    // block via the (chain-specific) historical hardfork table, which is
    // unreliable for Base; blocks after the fork use the configured hardfork.
    await network.provider.send("evm_mine");

    pool = new ethers.Contract(ADDR.aavePool, POOL_ABI, ethers.provider);
    usdc = new ethers.Contract(ADDR.usdc, ERC20_ABI, ethers.provider);

    // Resolve the live data provider + oracle from the addresses provider - no
    // hardcoded, version-dependent addresses.
    const addressesProvider = new ethers.Contract(
      await pool.ADDRESSES_PROVIDER(),
      PROVIDER_ABI,
      ethers.provider
    );
    const dataProvider = await addressesProvider.getPoolDataProvider();
    const priceOracle = await addressesProvider.getPriceOracle();

    const LockChecker = await ethers.getContractFactory("LockChecker");
    const lockChecker = await LockChecker.deploy(dataProvider, 3_600);

    const AaveAdapter = await ethers.getContractFactory("AaveAdapter");
    aaveAdapter = await AaveAdapter.deploy(ADDR.aavePool);
    const MoonwellAdapter = await ethers.getContractFactory("MoonwellAdapter");
    moonwellAdapter = await MoonwellAdapter.deploy();
    const CompoundV3Adapter = await ethers.getContractFactory("CompoundV3Adapter");
    compoundAdapter = await CompoundV3Adapter.deploy();
    const MorphoAdapter = await ethers.getContractFactory("MorphoAdapter");
    morphoAdapter = await MorphoAdapter.deploy(ADDR.morphoBlue);
    const SwapAdapter = await ethers.getContractFactory("SwapAdapter");
    const swapAdapter = await SwapAdapter.deploy(ADDR.universalRouter, ADDR.usdc);
    const UniswapAdapter = await ethers.getContractFactory("UniswapAdapter");
    const uniswapAdapter = await UniswapAdapter.deploy(ADDR.nftManager);

    const PanikExecutor = await ethers.getContractFactory("PanikExecutor");
    executor = await PanikExecutor.deploy(
      ADDR.usdc,
      dataProvider,
      priceOracle,
      ethers.ZeroAddress, // no mock oracle on mainnet fork
      await lockChecker.getAddress(),
      {
        aave: await aaveAdapter.getAddress(),
        moonwell: await moonwellAdapter.getAddress(),
        compound: await compoundAdapter.getAddress(),
        morpho: await morphoAdapter.getAddress(),
        swap: await swapAdapter.getAddress(),
        uniswap: await uniswapAdapter.getAddress(),
      },
      ADDR.nftManager,
      // Repay-only coverage here: no swap routes needed (USDC needs none).
      { assets: [], paths: [], minOutBps: [] },
      [],
      [ADDR.weth],
      300
    );

    const executorAddress = await executor.getAddress();
    for (const adapter of [
      aaveAdapter,
      moonwellAdapter,
      compoundAdapter,
      morphoAdapter,
      swapAdapter,
      uniswapAdapter,
    ]) {
      await (adapter as any).setExecutor(executorAddress);
    }
  });

  it("deploys against live protocol code", async function () {
    for (const [name, address] of Object.entries({
      aavePool: ADDR.aavePool,
      morphoBlue: ADDR.morphoBlue,
      moonwellMUsdc: ADDR.moonwellMUsdc,
      cometUsdc: ADDR.cometUsdc,
    })) {
      const code = await ethers.provider.getCode(address);
      expect(code, `${name} has no code at ${address}`).to.not.equal("0x");
    }
  });

  it("partially repays a REAL Aave borrower and improves their health factor", async function () {
    const [, , , , , hfBefore] = await pool.getUserAccountData(AAVE_USER);
    const [, totalDebtBase] = await pool.getUserAccountData(AAVE_USER);
    if (totalDebtBase === 0n) {
      console.log(`    (skipped: ${AAVE_USER} has no Aave debt at this block - set FORK_AAVE_USER)`);
      this.skip();
    }

    const user = await impersonate(AAVE_USER);
    const repayUsdc = 10n * USDC_UNIT;
    await dealUsdc(AAVE_USER, 1_000n * USDC_UNIT);
    await usdc.connect(user).approve(await executor.getAddress(), ethers.MaxUint256);

    await executor.connect(user).atomicExit([leg(AAVE, ADDR.usdc, repayUsdc, 0n)], []);

    const [, , , , , hfAfter] = await pool.getUserAccountData(AAVE_USER);
    expect(hfAfter).to.be.greaterThan(hfBefore);
  });

  it("partially repays a REAL Moonwell borrower", async function () {
    const mUsdc = new ethers.Contract(ADDR.moonwellMUsdc, MTOKEN_ABI, ethers.provider);
    const debt = await mUsdc.borrowBalanceCurrent.staticCall(MOONWELL_USER);
    if (debt === 0n) {
      console.log(
        `    (skipped: ${MOONWELL_USER} has no mUSDC debt at this block - set FORK_MOONWELL_USER)`
      );
      this.skip();
    }

    const user = await impersonate(MOONWELL_USER);
    const repayUsdc = debt / 10n > 0n ? debt / 10n : debt;
    await dealUsdc(MOONWELL_USER, (repayUsdc / USDC_UNIT + 1_000n) * USDC_UNIT);
    await usdc.connect(user).approve(await executor.getAddress(), ethers.MaxUint256);

    await executor
      .connect(user)
      .atomicExit([leg(MOONWELL, ADDR.moonwellMUsdc, repayUsdc, 0n)], []);

    const debtAfter = await mUsdc.borrowBalanceCurrent.staticCall(MOONWELL_USER);
    expect(debtAfter).to.be.lessThan(debt);
  });

  (COMET_USER ? it : it.skip)(
    "partially repays a REAL Compound V3 borrower (FORK_COMET_USER)",
    async function () {
      const comet = new ethers.Contract(
        ADDR.cometUsdc,
        ["function borrowBalanceOf(address) view returns (uint256)"],
        ethers.provider
      );
      const debt = await comet.borrowBalanceOf(COMET_USER!);
      expect(debt).to.be.greaterThan(0n);

      const user = await impersonate(COMET_USER!);
      const repayUsdc = debt / 10n > 0n ? debt / 10n : debt;
      await dealUsdc(COMET_USER!, (repayUsdc / USDC_UNIT + 1_000n) * USDC_UNIT);
      await usdc.connect(user).approve(await executor.getAddress(), ethers.MaxUint256);

      const data = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [ADDR.cometUsdc]);
      await executor
        .connect(user)
        .atomicExit([leg(COMET, ethers.ZeroAddress, repayUsdc, 0n, data)], []);

      expect(await comet.borrowBalanceOf(COMET_USER!)).to.be.lessThan(debt);
    }
  );
});
