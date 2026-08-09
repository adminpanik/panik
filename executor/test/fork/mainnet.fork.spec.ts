/**
 * Base MAINNET fork tests for PanikExecutor v2 - the mainnet-readiness proof.
 *
 * Run:  BASE_MAINNET_RPC=https://base-mainnet.g.alchemy.com/v2/<ALCHEMY_API_KEY_BASE_MAINNET> \
 *         npx hardhat test test/fork/mainnet.fork.spec.ts
 *
 * Skipped entirely when BASE_MAINNET_RPC is unset, so plain `npx hardhat test`
 * stays offline and CI needs no fork RPC.
 *
 * Every test SELF-SEEDS its own borrower on the fork (wrap ETH -> supply
 * collateral -> borrow) exactly as deleverager.fork.spec.ts does. No FORK_*_USER
 * address is consulted: an external borrower may hold nothing at the pinned
 * block, which is how the previous version of this file sat permanently PENDING
 * while its `before` hook no longer even compiled against the v2 constructor.
 *
 * Both executor entrypoints are exercised against live Base protocol code:
 *   atomicExit     - self-serve, onlyEOA, the v1-compatible path.
 *   atomicExitFor  - delegated: the borrower signs a real EIP-712 ExitPermit
 *                    (domain "PanikExecutor" / "2" / chainId / this deployment)
 *                    and a DIFFERENT account submits it. Proceeds must land on
 *                    the position owner and nowhere else, and the nonce must be
 *                    spent. The trigger gate is proven BOTH ways against the
 *                    live Aave health factor: a permit whose trigger the live HF
 *                    does not meet reverts TriggerNotMet, and the same position
 *                    executes once the trigger is loosened past the live HF.
 *
 * The fork block is pinned in hardhat.config.ts (FORK_BLOCK_NUMBER overrides).
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";

const FORKED = Boolean(process.env.BASE_MAINNET_RPC);
const maybeDescribe = FORKED ? describe : describe.skip;

// ExitTypes.ProtocolId
const AAVE = 0;
const MOONWELL = 1;
const COMET = 2;
const MORPHO = 3;

// ExitTypes.ExitKind
const FULL_EXIT = 0;
const FULL_REPAY = 1;

const MASK_AAVE = 1 << AAVE;
const MASK_MOONWELL = 1 << MOONWELL;
const MASK_COMET = 1 << COMET;
const MASK_MORPHO = 1 << MORPHO;

const MAX = ethers.MaxUint256;
const USDC_UNIT = 10n ** 6n;
const WAD = 10n ** 18n;

/** Canonical Base mainnet addresses (same set the deleverager fork suite uses). */
const ADDR = {
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  weth: "0x4200000000000000000000000000000000000006",
  aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  morphoBlue: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  cometUsdc: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
  mUsdc: "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22",
  mWeth: "0x628ff693426583D9a7FB391E54366292F509D457",
  universalRouter: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
  nftManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
  usdcUsdFeed: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
  wethUsdFeed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
};

// Verified live WETH/USDC Morpho Blue market (same one the deleverager suite
// uses; oracle/irm read from idToMarketParams).
const MORPHO_WETH_USDC = {
  loanToken: ADDR.usdc,
  collateralToken: ADDR.weth,
  oracle: "0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4",
  irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
  lltv: 860000000000000000n,
};

const coder = ethers.AbiCoder.defaultAbiCoder();
const MP_TUPLE =
  "tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)";

const PERMIT_TYPES = {
  ExitPermit: [
    { name: "user", type: "address" },
    { name: "kind", type: "uint8" },
    { name: "maxRepayFractionBps", type: "uint16" },
    { name: "triggerHealthFactorWad", type: "uint256" },
    { name: "maxSlippageBps", type: "uint16" },
    { name: "protocolsMask", type: "uint8" },
    { name: "epoch", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

interface Permit {
  user: string;
  kind: number;
  maxRepayFractionBps: number;
  triggerHealthFactorWad: bigint;
  maxSlippageBps: number;
  protocolsMask: number;
  epoch: bigint;
  nonce: bigint;
  deadline: bigint;
}

interface Leg {
  protocol: number;
  asset: string;
  repayAmount: bigint;
  withdrawAmount: bigint;
  data: string;
}

function leg(
  protocol: number,
  asset: string,
  repayAmount: bigint,
  withdrawAmount: bigint,
  data = "0x"
): Leg {
  return { protocol, asset, repayAmount, withdrawAmount, data };
}

function v3Path(tokenIn: string, tokenOut: string, fee = 500): string {
  return ethers.solidityPacked(["address", "uint24", "address"], [tokenIn, fee, tokenOut]);
}

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];
const WETH_ABI = [...ERC20, "function deposit() payable"];
const POOL_ABI = [
  "function supply(address,uint256,address,uint16)",
  "function borrow(address,uint256,uint256,uint16,address)",
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function ADDRESSES_PROVIDER() view returns (address)",
];
const COMET_ABI = [
  "function supply(address,uint256)",
  "function withdraw(address,uint256)",
  "function allow(address,bool)",
  "function borrowBalanceOf(address) view returns (uint256)",
  "function collateralBalanceOf(address,address) view returns (uint128)",
  "function isBorrowCollateralized(address) view returns (bool)",
];
const MTOKEN_ABI = [
  ...ERC20,
  "function mint(uint256) returns (uint256)",
  "function redeem(uint256) returns (uint256)",
  "function borrow(uint256) returns (uint256)",
  "function borrowBalanceStored(address) view returns (uint256)",
  "function comptroller() view returns (address)",
  "function underlying() view returns (address)",
];
const COMPTROLLER_ABI = [
  "function enterMarkets(address[]) returns (uint256[])",
  "function getAccountLiquidity(address) view returns (uint256,uint256,uint256)",
];
const MORPHO_ABI = [
  `function supplyCollateral(${MP_TUPLE} marketParams, uint256 assets, address onBehalf, bytes data)`,
  `function borrow(${MP_TUPLE} marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256,uint256)`,
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function setAuthorization(address,bool)",
];

/**
 * Force a USDC balance via storage (Circle FiatTokenV2_2 on Base keeps
 * balanceAndBlacklistStates at slot 9; the high bit is the blacklist flag, so a
 * plain amount writes a clean, transferable balance - asserted below).
 *
 * This tops up the WALLET that funds a repay. It is not a shortcut around the
 * position itself: every position in this suite is a real supply+borrow against
 * live protocol code. Wallet-funded repay is what atomicExit/atomicExitFor DO -
 * the collateral-funded route is PanikDeleverager's and is proven in its own
 * fork suite.
 */
async function dealUsdc(to: string, amount: bigint): Promise<void> {
  const slot = ethers.keccak256(coder.encode(["address", "uint256"], [to, 9n]));
  await network.provider.send("hardhat_setStorageAt", [
    ADDR.usdc,
    slot,
    ethers.toBeHex(amount, 32),
  ]);
}

maybeDescribe("Base mainnet fork - PanikExecutor v2 real-protocol exits", function () {
  this.timeout(900_000);

  let executor: any;
  let executorAddress: string;
  let aaveAdapter: any;
  let moonwellAdapter: any;
  let compoundAdapter: any;
  let morphoAdapter: any;
  let swapAdapter: any;
  let pool: any;
  let usdc: any;
  let dataProvider: string;
  let priceOracle: string;
  let domain: { name: string; version: string; chainId: number; verifyingContract: string };
  let signers: any[];
  let relayer: any;

  const morphoId = ethers.keccak256(coder.encode([MP_TUPLE], [MORPHO_WETH_USDC]));
  const morphoData = coder.encode([MP_TUPLE], [MORPHO_WETH_USDC]);
  const cometData = coder.encode(["address"], [ADDR.cometUsdc]);

  async function deadline(): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp) + 3_600n;
  }

  async function sign(signer: any, permit: Permit): Promise<string> {
    return signer.signTypedData(domain, PERMIT_TYPES, permit);
  }

  /** Wrap ETH, supply it to Aave, borrow USDC. Returns the borrower address. */
  async function seedAave(borrower: any, wethIn: bigint, borrowUsdc: bigint): Promise<string> {
    const me = await borrower.getAddress();
    const weth = new ethers.Contract(ADDR.weth, WETH_ABI, borrower);
    const aavePool = new ethers.Contract(ADDR.aavePool, POOL_ABI, borrower);
    await (await weth.deposit({ value: wethIn })).wait();
    await (await weth.approve(ADDR.aavePool, wethIn)).wait();
    await (await aavePool.supply(ADDR.weth, wethIn, me, 0)).wait();
    await (await aavePool.borrow(ADDR.usdc, borrowUsdc, 2, 0, me)).wait();
    return me;
  }

  /** aToken address for a reserve, from the live data provider. */
  async function aTokenOf(asset: string): Promise<string> {
    const dp = new ethers.Contract(
      dataProvider,
      ["function getReserveTokensAddresses(address) view returns (address,address,address)"],
      ethers.provider
    );
    const [aToken] = await dp.getReserveTokensAddresses(asset);
    return aToken;
  }

  before(async function () {
    // Advance one block past the fork point: EDR resolves calls at the fork
    // block via the (chain-specific) historical hardfork table, which is
    // unreliable for Base; blocks after the fork use the configured hardfork.
    await network.provider.send("evm_mine");

    signers = await ethers.getSigners();
    // Signers 0 and 1 are the deleverager fork suite's borrower and sink; this
    // suite takes 2+ so both suites can run in one `npx hardhat test test/fork/`.
    relayer = signers[2];

    pool = new ethers.Contract(ADDR.aavePool, POOL_ABI, ethers.provider);
    usdc = new ethers.Contract(ADDR.usdc, ERC20, ethers.provider);

    // Resolve the live data provider + oracle from the addresses provider - no
    // hardcoded, version-dependent addresses.
    const addressesProvider = new ethers.Contract(
      await pool.ADDRESSES_PROVIDER(),
      [
        "function getPoolDataProvider() view returns (address)",
        "function getPriceOracle() view returns (address)",
      ],
      ethers.provider
    );
    dataProvider = await addressesProvider.getPoolDataProvider();
    priceOracle = await addressesProvider.getPriceOracle();

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
    swapAdapter = await SwapAdapter.deploy(ADDR.universalRouter, ADDR.usdc);
    const UniswapAdapter = await ethers.getContractFactory("UniswapAdapter");
    const uniswapAdapter = await UniswapAdapter.deploy(ADDR.nftManager);

    const PanikExecutor = await ethers.getContractFactory("PanikExecutor");
    executor = await PanikExecutor.deploy(
      ADDR.usdc,
      dataProvider,
      priceOracle,
      ethers.ZeroAddress, // no mock oracle: the constructor forbids one on chainid 8453
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
      // Self-serve swap route: withdrawn WETH is sold to USDC on the live
      // Uniswap V3 0.05% pool, floored at 95% of the Aave oracle quote.
      {
        assets: [ADDR.weth],
        paths: [v3Path(ADDR.weth, ADDR.usdc)],
        minOutBps: [9_500],
      },
      [], // mockOracleAssets - must be empty on Base mainnet
      [ADDR.weth],
      300, // swapDeadlineBuffer
      {
        priceFeedAssets: [ADDR.usdc, ADDR.weth],
        priceFeeds: [ADDR.usdcUsdFeed, ADDR.wethUsdFeed],
        // 48h: the Base USDC/USD feed has a 24h heartbeat and the pinned fork
        // block sits ~16h into it (measured below).
        oracleStalenessSeconds: 172_800,
        // Fork time is not wall-clock, so the live sequencer feed's startedAt
        // would fail the grace check for reasons unrelated to the executor.
        sequencerUptimeFeed: ethers.ZeroAddress,
        sequencerGracePeriod: 3_600,
        maxPermitSlippageBps: 1_000,
        markets: [ADDR.mUsdc, ADDR.mWeth, ADDR.cometUsdc],
      }
    );

    executorAddress = await executor.getAddress();
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

    domain = {
      name: "PanikExecutor",
      version: "2",
      chainId: Number((await ethers.provider.getNetwork()).chainId),
      verifyingContract: executorAddress,
    };
  });

  it("deploys the v2 executor against live protocol code", async function () {
    for (const [name, address] of Object.entries({
      aavePool: ADDR.aavePool,
      morphoBlue: ADDR.morphoBlue,
      moonwellMUsdc: ADDR.mUsdc,
      moonwellMWeth: ADDR.mWeth,
      cometUsdc: ADDR.cometUsdc,
      universalRouter: ADDR.universalRouter,
      usdcUsdFeed: ADDR.usdcUsdFeed,
      wethUsdFeed: ADDR.wethUsdFeed,
      aaveDataProvider: dataProvider,
      aavePriceOracle: priceOracle,
    })) {
      const code = await ethers.provider.getCode(address);
      expect(code, `${name} has no code at ${address}`).to.not.equal("0x");
    }

    expect(await executor.usdc()).to.equal(ADDR.usdc);
    expect(await executor.maxPermitSlippageBps()).to.equal(1_000);
    expect(await executor.isDelegatedMarket(ADDR.cometUsdc)).to.equal(true);
    expect(await executor.isDelegatedMarket(ADDR.aavePool)).to.equal(false);
    expect(await executor.getPriceFeed(ADDR.weth)).to.equal(ADDR.wethUsdFeed);
    expect(await executor.getPriceFeedDecimals(ADDR.weth)).to.equal(8);

    // Record the live feed ages the delegated slippage floor is priced from.
    const block = await ethers.provider.getBlock("latest");
    for (const [name, feed] of Object.entries({
      "USDC/USD": ADDR.usdcUsdFeed,
      "WETH/USD": ADDR.wethUsdFeed,
    })) {
      const c = new ethers.Contract(
        feed,
        ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"],
        ethers.provider
      );
      const rd = await c.latestRoundData();
      console.log(
        `    live ${name}: answer ${rd[1]} (1e8), age ${
          BigInt(block!.timestamp) - rd[3]
        }s vs oracleStalenessSeconds ${await executor.oracleStalenessSeconds()}`
      );
    }
  });

  it("publishes an EIP-712 domain a standard client reproduces", async function () {
    expect(await executor.DOMAIN_SEPARATOR()).to.equal(
      ethers.TypedDataEncoder.hashDomain(domain)
    );
    const permit: Permit = {
      user: await signers[3].getAddress(),
      kind: FULL_REPAY,
      maxRepayFractionBps: 10_000,
      triggerHealthFactorWad: 0n,
      maxSlippageBps: 300,
      protocolsMask: MASK_AAVE,
      epoch: 0n,
      nonce: 999n,
      deadline: await deadline(),
    };
    expect(await executor.hashExitPermit(permit)).to.equal(
      ethers.TypedDataEncoder.hash(domain, PERMIT_TYPES, permit)
    );

    const d = await executor.eip712Domain();
    expect(d.name).to.equal("PanikExecutor");
    expect(d.version).to.equal("2");
    expect(Number(d.chainId)).to.equal(8453);
    expect(d.verifyingContract).to.equal(executorAddress);
  });

  // ------------------------------------------------------------ Aave V3 --

  it("Aave V3 self-serve: atomicExit closes a live position and pays the owner USDC", async function () {
    const borrower = signers[3];
    const me = await seedAave(borrower, ethers.parseEther("5"), 4_000n * USDC_UNIT);

    const [, debtBefore, , , , hfBefore] = await pool.getUserAccountData(me);
    expect(debtBefore).to.be.greaterThan(0n);

    // Wallet funds the repay (that is what atomicExit does); top up so the
    // accrued debt is fully covered.
    await dealUsdc(me, 4_100n * USDC_UNIT);
    const aWeth = new ethers.Contract(await aTokenOf(ADDR.weth), ERC20, borrower);
    const collateralBefore = await aWeth.balanceOf(me);
    expect(collateralBefore).to.be.greaterThan(0n);

    await (await usdc.connect(borrower).approve(executorAddress, MAX)).wait();
    await (await aWeth.approve(executorAddress, MAX)).wait();

    const usdcBefore = await usdc.balanceOf(me);
    const tx = await executor
      .connect(borrower)
      .atomicExit([leg(AAVE, ADDR.usdc, MAX, 0n), leg(AAVE, ADDR.weth, 0n, MAX)], []);
    const rc = await tx.wait();

    const [, debtAfter, , , , hfAfter] = await pool.getUserAccountData(me);
    const usdcAfter = await usdc.balanceOf(me);
    console.log(
      `    Aave self-serve: debt ${debtBefore} -> ${debtAfter} (base units), ` +
        `HF ${hfBefore} -> ${hfAfter}, USDC ${usdcBefore} -> ${usdcAfter}; gas ${rc.gasUsed}`
    );

    expect(debtAfter).to.equal(0n); // every unit of live debt repaid
    expect(await aWeth.balanceOf(me)).to.be.lessThan(collateralBefore / 1000n); // collateral out
    // Net: paid ~4000 USDC of debt, received ~5 WETH sold to USDC.
    expect(usdcAfter).to.be.greaterThan(usdcBefore);
    expect(await usdc.balanceOf(executorAddress)).to.equal(0n);
    expect(
      await new ethers.Contract(ADDR.weth, ERC20, ethers.provider).balanceOf(executorAddress)
    ).to.equal(0n);
  });

  it("Aave V3 delegated: a signed ExitPermit lets a third party run the exit, funds land on the owner", async function () {
    const borrower = signers[4];
    const me = await seedAave(borrower, ethers.parseEther("5"), 4_000n * USDC_UNIT);
    await dealUsdc(me, 4_100n * USDC_UNIT);

    const aWeth = new ethers.Contract(await aTokenOf(ADDR.weth), ERC20, borrower);
    await (await usdc.connect(borrower).approve(executorAddress, MAX)).wait();
    await (await aWeth.approve(executorAddress, MAX)).wait();

    const [, debtBefore, , , , hfLive] = await pool.getUserAccountData(me);
    const permit: Permit = {
      user: me,
      kind: FULL_EXIT,
      maxRepayFractionBps: 10_000,
      triggerHealthFactorWad: 0n, // execute-now permit, bounded by deadline
      maxSlippageBps: 300,
      protocolsMask: MASK_AAVE,
      epoch: 0n,
      nonce: 11n,
      deadline: await deadline(),
    };
    const signature = await sign(borrower, permit);

    expect(await executor.isNonceUsed(me, permit.nonce)).to.equal(false);

    const ownerUsdcBefore = await usdc.balanceOf(me);
    const relayerAddress = await relayer.getAddress();
    const relayerUsdcBefore = await usdc.balanceOf(relayerAddress);

    const tx = await executor
      .connect(relayer)
      .atomicExitFor(
        me,
        [leg(AAVE, ADDR.usdc, MAX, 0n), leg(AAVE, ADDR.weth, 0n, MAX)],
        [],
        permit,
        signature
      );
    const rc = await tx.wait();
    await expect(tx).to.emit(executor, "DelegatedExitExecuted");

    const [, debtAfter] = await pool.getUserAccountData(me);
    const ownerUsdcAfter = await usdc.balanceOf(me);
    console.log(
      `    Aave delegated: live HF at signing ${hfLive}, debt ${debtBefore} -> ${debtAfter}, ` +
        `owner USDC +${ownerUsdcAfter - ownerUsdcBefore}; submitter ${relayerAddress}; gas ${rc.gasUsed}`
    );

    expect(debtAfter).to.equal(0n);
    expect(await aWeth.balanceOf(me)).to.be.lessThan(WAD / 1000n);
    expect(ownerUsdcAfter).to.be.greaterThan(ownerUsdcBefore); // proceeds to the OWNER
    expect(await usdc.balanceOf(relayerAddress)).to.equal(relayerUsdcBefore); // and nobody else
    expect(await usdc.balanceOf(executorAddress)).to.equal(0n);

    // The nonce is spent and the permit cannot be replayed.
    expect(await executor.isNonceUsed(me, permit.nonce)).to.equal(true);
    await expect(
      executor
        .connect(relayer)
        .atomicExitFor(me, [leg(AAVE, ADDR.usdc, MAX, 0n)], [], permit, signature)
    ).to.be.revertedWithCustomError(executor, "NonceAlreadyUsed");
  });

  it("Aave V3 delegated: the trigger gate refuses and then allows the SAME live position", async function () {
    const borrower = signers[5];
    const me = await seedAave(borrower, ethers.parseEther("5"), 4_000n * USDC_UNIT);
    await dealUsdc(me, 4_100n * USDC_UNIT);
    await (await usdc.connect(borrower).approve(executorAddress, MAX)).wait();

    const [, , , , , liveHf] = await pool.getUserAccountData(me);
    expect(liveHf).to.be.greaterThan(WAD); // a healthy, real position

    // NOT met: the live HF is comfortably above the trigger the signer set, so
    // the exit must not fire. This is the assertion that proves the gate reads
    // LIVE Aave state rather than a mock.
    const tooTight = liveHf / 2n;
    const refused: Permit = {
      user: me,
      kind: FULL_REPAY,
      maxRepayFractionBps: 10_000,
      triggerHealthFactorWad: tooTight,
      maxSlippageBps: 300,
      protocolsMask: MASK_AAVE,
      epoch: 0n,
      nonce: 21n,
      deadline: await deadline(),
    };
    await expect(
      executor
        .connect(relayer)
        .atomicExitFor(
          me,
          [leg(AAVE, ADDR.usdc, MAX, 0n)],
          [],
          refused,
          await sign(borrower, refused)
        )
    )
      .to.be.revertedWithCustomError(executor, "TriggerNotMet")
      // The reported HF is read live inside the transaction, so it drifts a few
      // wei per block as interest accrues; what matters is that the number the
      // gate refused on is the real one and really is above the trigger.
      .withArgs(AAVE, (hf: bigint) => hf > tooTight && hf > WAD, tooTight);
    // A refused permit spends nothing.
    expect(await executor.isNonceUsed(me, refused.nonce)).to.equal(false);

    // MET: same position, same signer, trigger loosened past the live HF.
    const loose = liveHf * 2n;
    const allowed: Permit = { ...refused, triggerHealthFactorWad: loose, nonce: 22n };
    const [, debtBefore] = await pool.getUserAccountData(me);
    await (
      await executor
        .connect(relayer)
        .atomicExitFor(
          me,
          [leg(AAVE, ADDR.usdc, MAX, 0n)],
          [],
          allowed,
          await sign(borrower, allowed)
        )
    ).wait();

    const [, debtAfter] = await pool.getUserAccountData(me);
    console.log(
      `    Aave trigger gate: live HF ${liveHf}; refused at ${tooTight}, executed at ${loose}; ` +
        `debt ${debtBefore} -> ${debtAfter}`
    );
    expect(debtAfter).to.equal(0n);
    expect(await executor.isNonceUsed(me, allowed.nonce)).to.equal(true);
  });

  it("Aave V3 delegated: a permit signed by anyone else is refused against the live deployment", async function () {
    const borrower = signers[6];
    const me = await seedAave(borrower, ethers.parseEther("2"), 500n * USDC_UNIT);
    await dealUsdc(me, 600n * USDC_UNIT);
    await (await usdc.connect(borrower).approve(executorAddress, MAX)).wait();

    const permit: Permit = {
      user: me,
      kind: FULL_REPAY,
      maxRepayFractionBps: 10_000,
      triggerHealthFactorWad: 0n,
      maxSlippageBps: 300,
      protocolsMask: MASK_AAVE,
      epoch: 0n,
      nonce: 31n,
      deadline: await deadline(),
    };
    const legs = [leg(AAVE, ADDR.usdc, MAX, 0n)];

    // Signed by the relayer, not the position owner.
    await expect(
      executor.connect(relayer).atomicExitFor(me, legs, [], permit, await sign(relayer, permit))
    ).to.be.revertedWithCustomError(executor, "InvalidSignature");

    // Owner's own signature, pointed at somebody else's position.
    const other = await relayer.getAddress();
    await expect(
      executor
        .connect(relayer)
        .atomicExitFor(other, legs, [], permit, await sign(borrower, permit))
    ).to.be.revertedWithCustomError(executor, "PermitUserMismatch");

    // The valid permit still works afterwards, so nothing above burned it.
    await (
      await executor
        .connect(relayer)
        .atomicExitFor(me, legs, [], permit, await sign(borrower, permit))
    ).wait();
    const [, debtAfter] = await pool.getUserAccountData(me);
    expect(debtAfter).to.equal(0n);
  });

  // --------------------------------------------------------- Moonwell --

  it("Moonwell self-serve: atomicExit repays and redeems a live mUSDC position", async function () {
    const borrower = signers[7];
    const me = await borrower.getAddress();
    const mUsdc = new ethers.Contract(ADDR.mUsdc, MTOKEN_ABI, borrower);
    const comptroller = new ethers.Contract(await mUsdc.comptroller(), COMPTROLLER_ABI, borrower);

    // Supply USDC as collateral and borrow USDC from the same market: one leg
    // then covers both sides, and the redeemed underlying IS the debt asset so
    // no swap route is involved (mUSDC pays ERC-20 USDC).
    await dealUsdc(me, 20_000n * USDC_UNIT);
    await (await usdc.connect(borrower).approve(ADDR.mUsdc, MAX)).wait();
    await (await mUsdc.mint(20_000n * USDC_UNIT)).wait();
    await (await comptroller.enterMarkets([ADDR.mUsdc])).wait();
    await (await mUsdc.borrow(5_000n * USDC_UNIT)).wait();
    // The borrow lands exactly 5,000 USDC in the wallet while the debt accrues
    // past it within a block or two; top the wallet up so the full live debt is
    // coverable (Moonwell's borrowBalanceCurrent is exact at execution time).
    await dealUsdc(me, 5_100n * USDC_UNIT);

    const debtBefore = await mUsdc.borrowBalanceStored(me);
    const mBalanceBefore = await mUsdc.balanceOf(me);
    expect(debtBefore).to.be.greaterThan(0n);
    expect(mBalanceBefore).to.be.greaterThan(0n);

    await (await usdc.connect(borrower).approve(executorAddress, MAX)).wait();
    await (await mUsdc.approve(executorAddress, MAX)).wait();

    const usdcBefore = await usdc.balanceOf(me);
    const rc = await (
      await executor.connect(borrower).atomicExit([leg(MOONWELL, ADDR.mUsdc, MAX, MAX)], [])
    ).wait();

    const debtAfter = await mUsdc.borrowBalanceStored(me);
    const [, , shortfall] = await comptroller.getAccountLiquidity(me);
    console.log(
      `    Moonwell self-serve: debt ${debtBefore} -> ${debtAfter}, mUSDC ${mBalanceBefore} -> ` +
        `${await mUsdc.balanceOf(me)}, USDC ${usdcBefore} -> ${await usdc.balanceOf(me)}; gas ${rc.gasUsed}`
    );
    expect(debtAfter).to.equal(0n);
    expect(await mUsdc.balanceOf(me)).to.equal(0n);
    expect(shortfall).to.equal(0n);
    expect(await usdc.balanceOf(executorAddress)).to.equal(0n);
  });

  it("Moonwell delegated: a signed FULL_REPAY permit clears a live borrow, and the trigger gate refuses a healthy account", async function () {
    const borrower = signers[8];
    const me = await borrower.getAddress();
    const mUsdc = new ethers.Contract(ADDR.mUsdc, MTOKEN_ABI, borrower);
    const comptroller = new ethers.Contract(await mUsdc.comptroller(), COMPTROLLER_ABI, borrower);

    await dealUsdc(me, 20_000n * USDC_UNIT);
    await (await usdc.connect(borrower).approve(ADDR.mUsdc, MAX)).wait();
    await (await mUsdc.mint(15_000n * USDC_UNIT)).wait();
    await (await comptroller.enterMarkets([ADDR.mUsdc])).wait();
    await (await mUsdc.borrow(4_000n * USDC_UNIT)).wait();
    await (await usdc.connect(borrower).approve(executorAddress, MAX)).wait();

    const legs = [leg(MOONWELL, ADDR.mUsdc, MAX, 0n)];

    // Moonwell exposes shortfall, not a ratio: a healthy account proves only
    // HF >= 1, so any trigger must conservatively refuse. Proven live here.
    const refused: Permit = {
      user: me,
      kind: FULL_REPAY,
      maxRepayFractionBps: 10_000,
      triggerHealthFactorWad: WAD, // "liquidatable"
      maxSlippageBps: 300,
      protocolsMask: MASK_MOONWELL,
      epoch: 0n,
      nonce: 41n,
      deadline: await deadline(),
    };
    const [, , shortfall] = await comptroller.getAccountLiquidity(me);
    expect(shortfall).to.equal(0n);
    await expect(
      executor
        .connect(relayer)
        .atomicExitFor(me, legs, [], refused, await sign(borrower, refused))
    ).to.be.revertedWithCustomError(executor, "TriggerNotMet");

    // Execute-now permit (trigger 0) on the same live position.
    const permit: Permit = { ...refused, triggerHealthFactorWad: 0n, nonce: 42n };
    const debtBefore = await mUsdc.borrowBalanceStored(me);
    const relayerAddress = await relayer.getAddress();
    const relayerUsdcBefore = await usdc.balanceOf(relayerAddress);

    const rc = await (
      await executor
        .connect(relayer)
        .atomicExitFor(me, legs, [], permit, await sign(borrower, permit))
    ).wait();

    const debtAfter = await mUsdc.borrowBalanceStored(me);
    console.log(
      `    Moonwell delegated: debt ${debtBefore} -> ${debtAfter}; submitter ${relayerAddress}; gas ${rc.gasUsed}`
    );
    expect(debtAfter).to.equal(0n);
    expect(await mUsdc.balanceOf(me)).to.be.greaterThan(0n); // FULL_REPAY never moves collateral
    expect(await usdc.balanceOf(relayerAddress)).to.equal(relayerUsdcBefore);
    expect(await executor.isNonceUsed(me, permit.nonce)).to.equal(true);
  });

  /**
   * LIVE-PROTOCOL GAP, recorded so it cannot regress silently.
   *
   * Moonwell's WETH market on Base (mWETH, 0x628f...) reports underlying() ==
   * WETH but pays REDEEMS OUT IN NATIVE ETH. MoonwellAdapter.redeem measures its
   * result as an ERC-20 WETH balance delta and has no `receive()`, so the mToken's
   * native transfer reverts the whole call. Every Moonwell collateral leg on that
   * market is therefore unexecutable on Base mainnet today, on BOTH entrypoints.
   * Repay legs are unaffected (proven above), as are ERC-20 markets such as mUSDC
   * (proven above). This is v1 adapter behaviour that the previous, never-running
   * fork spec could not surface; fixing it is a contract change and out of scope
   * for this test-only PR.
   */
  it("Moonwell mWETH: collateral redeem is UNEXECUTABLE on live Base (native-ETH payout)", async function () {
    const borrower = signers[9];
    const me = await borrower.getAddress();
    const weth = new ethers.Contract(ADDR.weth, WETH_ABI, borrower);
    const mWeth = new ethers.Contract(ADDR.mWeth, MTOKEN_ABI, borrower);

    await (await weth.deposit({ value: ethers.parseEther("1") })).wait();
    await (await weth.approve(ADDR.mWeth, MAX)).wait();
    await (await mWeth.mint(ethers.parseEther("1"))).wait();
    await (await mWeth.approve(executorAddress, MAX)).wait();

    // The mToken itself pays native ETH, not the WETH it names as underlying.
    expect(await mWeth.underlying()).to.equal(ADDR.weth);
    const wethBefore = await weth.balanceOf(me);
    const ethBefore = await ethers.provider.getBalance(me);
    const mBalance = await mWeth.balanceOf(me);
    const rc = await (await mWeth.redeem(mBalance / 2n)).wait();
    const gasSpent = rc.gasUsed * rc.gasPrice;
    expect(await weth.balanceOf(me)).to.equal(wethBefore); // no WETH arrived
    expect((await ethers.provider.getBalance(me)) + gasSpent).to.be.greaterThan(ethBefore);

    // So the executor's Moonwell collateral leg cannot complete.
    await expect(
      executor.connect(borrower).atomicExit([leg(MOONWELL, ADDR.mWeth, 0n, MAX)], [])
    ).to.be.reverted;
  });

  // ------------------------------------------------------ Compound V3 --

  it("Compound V3 self-serve: atomicExit repays base debt and sells withdrawn collateral", async function () {
    const borrower = signers[10];
    const me = await borrower.getAddress();
    const weth = new ethers.Contract(ADDR.weth, WETH_ABI, borrower);
    const comet = new ethers.Contract(ADDR.cometUsdc, COMET_ABI, borrower);

    await (await weth.deposit({ value: ethers.parseEther("5") })).wait();
    await (await weth.approve(ADDR.cometUsdc, ethers.parseEther("5"))).wait();
    await (await comet.supply(ADDR.weth, ethers.parseEther("5"))).wait();
    await (await comet.withdraw(ADDR.usdc, 4_000n * USDC_UNIT)).wait(); // borrow

    await dealUsdc(me, 4_100n * USDC_UNIT);
    await (await usdc.connect(borrower).approve(executorAddress, MAX)).wait();
    await (await comet.allow(await compoundAdapter.getAddress(), true)).wait();

    const debtBefore = await comet.borrowBalanceOf(me);
    const collateralBefore = await comet.collateralBalanceOf(me, ADDR.weth);
    const usdcBefore = await usdc.balanceOf(me);
    expect(debtBefore).to.be.greaterThan(0n);

    const rc = await (
      await executor
        .connect(borrower)
        .atomicExit([leg(COMET, ADDR.weth, MAX, collateralBefore, cometData)], [])
    ).wait();

    const debtAfter = await comet.borrowBalanceOf(me);
    console.log(
      `    Comet self-serve: debt ${debtBefore} -> ${debtAfter}, WETH collateral ` +
        `${collateralBefore} -> ${await comet.collateralBalanceOf(me, ADDR.weth)}, ` +
        `USDC ${usdcBefore} -> ${await usdc.balanceOf(me)}; gas ${rc.gasUsed}`
    );
    expect(debtAfter).to.equal(0n);
    expect(await comet.collateralBalanceOf(me, ADDR.weth)).to.equal(0n);
    expect(await comet.isBorrowCollateralized(me)).to.equal(true);
    expect(await usdc.balanceOf(me)).to.be.greaterThan(usdcBefore);
    expect(await usdc.balanceOf(executorAddress)).to.equal(0n);
  });

  it("Compound V3 delegated: a signed permit clears a live Comet borrow; a trigger is refused as unsupported", async function () {
    const borrower = signers[11];
    const me = await borrower.getAddress();
    const weth = new ethers.Contract(ADDR.weth, WETH_ABI, borrower);
    const comet = new ethers.Contract(ADDR.cometUsdc, COMET_ABI, borrower);

    await (await weth.deposit({ value: ethers.parseEther("5") })).wait();
    await (await weth.approve(ADDR.cometUsdc, ethers.parseEther("5"))).wait();
    await (await comet.supply(ADDR.weth, ethers.parseEther("5"))).wait();
    await (await comet.withdraw(ADDR.usdc, 4_000n * USDC_UNIT)).wait();

    await dealUsdc(me, 4_100n * USDC_UNIT);
    await (await usdc.connect(borrower).approve(executorAddress, MAX)).wait();
    await (await comet.allow(await compoundAdapter.getAddress(), true)).wait();

    const legs = [leg(COMET, ethers.ZeroAddress, MAX, 0n, cometData)];

    // Comet exposes only isBorrowCollateralized, measured against the BORROW
    // collateral factor, so the executor refuses to gate on it at all.
    const triggered: Permit = {
      user: me,
      kind: FULL_REPAY,
      maxRepayFractionBps: 10_000,
      triggerHealthFactorWad: WAD,
      maxSlippageBps: 300,
      protocolsMask: MASK_COMET,
      epoch: 0n,
      nonce: 51n,
      deadline: await deadline(),
    };
    await expect(
      executor
        .connect(relayer)
        .atomicExitFor(me, legs, [], triggered, await sign(borrower, triggered))
    )
      .to.be.revertedWithCustomError(executor, "TriggerUnsupported")
      .withArgs(COMET);

    const permit: Permit = { ...triggered, triggerHealthFactorWad: 0n, nonce: 52n };
    const debtBefore = await comet.borrowBalanceOf(me);
    const collateralBefore = await comet.collateralBalanceOf(me, ADDR.weth);

    const rc = await (
      await executor
        .connect(relayer)
        .atomicExitFor(me, legs, [], permit, await sign(borrower, permit))
    ).wait();

    console.log(
      `    Comet delegated: debt ${debtBefore} -> ${await comet.borrowBalanceOf(me)}; gas ${rc.gasUsed}`
    );
    expect(await comet.borrowBalanceOf(me)).to.equal(0n);
    // FULL_REPAY must never move collateral, whatever legs the submitter builds.
    expect(await comet.collateralBalanceOf(me, ADDR.weth)).to.equal(collateralBefore);
    expect(await executor.isNonceUsed(me, permit.nonce)).to.equal(true);
  });

  // ---------------------------------------------------------- Morpho --

  it("Morpho Blue self-serve: atomicExit closes a live WETH/USDC position", async function () {
    const borrower = signers[12];
    const me = await borrower.getAddress();
    const weth = new ethers.Contract(ADDR.weth, WETH_ABI, borrower);
    const morpho = new ethers.Contract(ADDR.morphoBlue, MORPHO_ABI, borrower);

    await (await weth.deposit({ value: ethers.parseEther("5") })).wait();
    await (await weth.approve(ADDR.morphoBlue, ethers.parseEther("5"))).wait();
    await (await morpho.supplyCollateral(MORPHO_WETH_USDC, ethers.parseEther("5"), me, "0x")).wait();
    await (await morpho.borrow(MORPHO_WETH_USDC, 4_000n * USDC_UNIT, 0, me, me)).wait();

    await dealUsdc(me, 4_100n * USDC_UNIT);
    await (await usdc.connect(borrower).approve(executorAddress, MAX)).wait();
    await (await morpho.setAuthorization(await morphoAdapter.getAddress(), true)).wait();

    const posBefore = await morpho.position(morphoId, me);
    const usdcBefore = await usdc.balanceOf(me);
    expect(posBefore.borrowShares).to.be.greaterThan(0n);

    const rc = await (
      await executor.connect(borrower).atomicExit([leg(MORPHO, ADDR.usdc, MAX, MAX, morphoData)], [])
    ).wait();

    const posAfter = await morpho.position(morphoId, me);
    console.log(
      `    Morpho self-serve: borrowShares ${posBefore.borrowShares} -> ${posAfter.borrowShares}, ` +
        `collateral ${posBefore.collateral} -> ${posAfter.collateral}, ` +
        `USDC ${usdcBefore} -> ${await usdc.balanceOf(me)}; gas ${rc.gasUsed}`
    );
    expect(posAfter.borrowShares).to.equal(0n);
    expect(posAfter.collateral).to.equal(0n);
    expect(await usdc.balanceOf(me)).to.be.greaterThan(usdcBefore);
    expect(await usdc.balanceOf(executorAddress)).to.equal(0n);
  });

  it("Morpho Blue delegated: a signed FULL_EXIT permit closes the position and pays the owner", async function () {
    const borrower = signers[13];
    const me = await borrower.getAddress();
    const weth = new ethers.Contract(ADDR.weth, WETH_ABI, borrower);
    const morpho = new ethers.Contract(ADDR.morphoBlue, MORPHO_ABI, borrower);

    await (await weth.deposit({ value: ethers.parseEther("5") })).wait();
    await (await weth.approve(ADDR.morphoBlue, ethers.parseEther("5"))).wait();
    await (await morpho.supplyCollateral(MORPHO_WETH_USDC, ethers.parseEther("5"), me, "0x")).wait();
    await (await morpho.borrow(MORPHO_WETH_USDC, 4_000n * USDC_UNIT, 0, me, me)).wait();

    await dealUsdc(me, 4_100n * USDC_UNIT);
    await (await usdc.connect(borrower).approve(executorAddress, MAX)).wait();
    await (await morpho.setAuthorization(await morphoAdapter.getAddress(), true)).wait();

    const legs = [leg(MORPHO, ADDR.usdc, MAX, MAX, morphoData)];

    // Morpho health needs the market's own oracle and lltv; the executor refuses
    // to gate rather than guess.
    const triggered: Permit = {
      user: me,
      kind: FULL_EXIT,
      maxRepayFractionBps: 10_000,
      triggerHealthFactorWad: WAD,
      maxSlippageBps: 300,
      protocolsMask: MASK_MORPHO,
      epoch: 0n,
      nonce: 61n,
      deadline: await deadline(),
    };
    await expect(
      executor
        .connect(relayer)
        .atomicExitFor(me, legs, [], triggered, await sign(borrower, triggered))
    )
      .to.be.revertedWithCustomError(executor, "TriggerUnsupported")
      .withArgs(MORPHO);

    const permit: Permit = { ...triggered, triggerHealthFactorWad: 0n, nonce: 62n };
    const posBefore = await morpho.position(morphoId, me);
    const ownerUsdcBefore = await usdc.balanceOf(me);
    const relayerAddress = await relayer.getAddress();
    const relayerUsdcBefore = await usdc.balanceOf(relayerAddress);

    const rc = await (
      await executor
        .connect(relayer)
        .atomicExitFor(me, legs, [], permit, await sign(borrower, permit))
    ).wait();

    const posAfter = await morpho.position(morphoId, me);
    console.log(
      `    Morpho delegated: borrowShares ${posBefore.borrowShares} -> ${posAfter.borrowShares}, ` +
        `collateral ${posBefore.collateral} -> ${posAfter.collateral}, owner USDC +` +
        `${(await usdc.balanceOf(me)) - ownerUsdcBefore}; gas ${rc.gasUsed}`
    );
    expect(posAfter.borrowShares).to.equal(0n);
    expect(posAfter.collateral).to.equal(0n);
    expect(await usdc.balanceOf(me)).to.be.greaterThan(ownerUsdcBefore);
    expect(await usdc.balanceOf(relayerAddress)).to.equal(relayerUsdcBefore);
    expect(await usdc.balanceOf(executorAddress)).to.equal(0n);
    expect(await executor.isNonceUsed(me, permit.nonce)).to.equal(true);
  });

  // ------------------------------------------------- delegated safety --

  it("delegated: revokeAll orphans a permit already signed against the live deployment", async function () {
    const borrower = signers[14];
    const me = await seedAave(borrower, ethers.parseEther("2"), 500n * USDC_UNIT);
    await dealUsdc(me, 600n * USDC_UNIT);
    await (await usdc.connect(borrower).approve(executorAddress, MAX)).wait();

    const permit: Permit = {
      user: me,
      kind: FULL_REPAY,
      maxRepayFractionBps: 10_000,
      triggerHealthFactorWad: 0n,
      maxSlippageBps: 300,
      protocolsMask: MASK_AAVE,
      epoch: 0n,
      nonce: 71n,
      deadline: await deadline(),
    };
    const signature = await sign(borrower, permit);

    await (await executor.connect(borrower).revokeAll()).wait();
    expect(await executor.revocationEpoch(me)).to.be.greaterThan(0n);

    await expect(
      executor
        .connect(relayer)
        .atomicExitFor(me, [leg(AAVE, ADDR.usdc, MAX, 0n)], [], permit, signature)
    ).to.be.revertedWithCustomError(executor, "PermitRevoked");
  });
});
