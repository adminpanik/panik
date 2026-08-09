import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

const WAD = 10n ** 18n;
const PRICE_SCALE = 10n ** 8n;
const MAX = ethers.MaxUint256;

// ExitTypes.ProtocolId
const AAVE = 0;
const MOONWELL = 1;
const COMET = 2;
const MORPHO = 3;

// ExitTypes.ExitKind
const FULL_EXIT = 0;
const FULL_REPAY = 1;
const REDUCE = 2;

const MASK_AAVE = 1 << AAVE;
const MASK_MOONWELL = 1 << MOONWELL;
const MASK_COMET = 1 << COMET;
const MASK_MORPHO = 1 << MORPHO;

const STALENESS = 3_600;
const GRACE = 3_600;
const MAX_PERMIT_SLIPPAGE_BPS = 2_000;

const abi = ethers.AbiCoder.defaultAbiCoder();

const PERMIT_TYPES = {
  ExitPermit: [
    { name: "user", type: "address" },
    { name: "kind", type: "uint8" },
    { name: "maxRepayFractionBps", type: "uint16" },
    { name: "triggerHealthFactorWad", type: "uint256" },
    { name: "maxSlippageBps", type: "uint16" },
    { name: "minUsdcOut", type: "uint256" },
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
  minUsdcOut: bigint;
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

function encodeV3Path(tokenIn: string, fee: number, tokenOut: string): string {
  return ethers.solidityPacked(["address", "uint24", "address"], [tokenIn, fee, tokenOut]);
}

describe("PanikExecutor - delegated exits (Phase 2.A)", function () {
  async function build(withSequencerFeed: boolean, wethFeedDecimals = 8) {
    const [deployer, user, relayer, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const MockDataProvider = await ethers.getContractFactory("MockAaveProtocolDataProvider");
    const MockPool = await ethers.getContractFactory("MockAavePool");
    const MockRouter = await ethers.getContractFactory("MockUniversalRouter");
    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    const MockFeed = await ethers.getContractFactory("MockChainlinkFeed");
    const MockComptroller = await ethers.getContractFactory("MockComptroller");
    const MockMToken = await ethers.getContractFactory("MockMToken");
    const MockComet = await ethers.getContractFactory("MockComet");
    const MockMorpho = await ethers.getContractFactory("MockMorpho");
    const LockChecker = await ethers.getContractFactory("LockChecker");
    const AaveAdapter = await ethers.getContractFactory("AaveAdapter");
    const MoonwellAdapter = await ethers.getContractFactory("MoonwellAdapter");
    const CompoundV3Adapter = await ethers.getContractFactory("CompoundV3Adapter");
    const MorphoAdapter = await ethers.getContractFactory("MorphoAdapter");
    const SwapAdapter = await ethers.getContractFactory("SwapAdapter");
    const UniswapAdapter = await ethers.getContractFactory("UniswapAdapter");
    const PanikExecutor = await ethers.getContractFactory("PanikExecutor");

    const usdc: any = await MockERC20.deploy("USDC", "USDC", 18);
    const weth: any = await MockERC20.deploy("WETH", "WETH", 18);
    // DAI has a swap route but deliberately NO price feed: it is how the suite
    // proves the delegated path refuses to price a swap it cannot date.
    const dai: any = await MockERC20.deploy("DAI", "DAI", 18);
    const aWeth: any = await MockERC20.deploy("aWETH", "aWETH", 18);
    const aDai: any = await MockERC20.deploy("aDAI", "aDAI", 18);

    const dataProvider: any = await MockDataProvider.deploy();
    const pool: any = await MockPool.deploy(await dataProvider.getAddress());
    const router: any = await MockRouter.deploy();
    const marketOracle: any = await MockPriceOracle.deploy();
    const mockOracle: any = await MockPriceOracle.deploy();

    // wethFeed decimals are parametrised so a test can prove _scalePrice copes
    // with a non-8-decimal feed (the on-chain scaling path is otherwise dead in
    // CI). Its answer is scaled to match.
    const wethFeed: any = await MockFeed.deploy(
      wethFeedDecimals,
      2_000n * 10n ** BigInt(wethFeedDecimals)
    );
    const usdcFeed: any = await MockFeed.deploy(8, 1n * PRICE_SCALE);
    const sequencerFeed: any = await MockFeed.deploy(0, 0n); // 0 = sequencer up

    const comptroller: any = await MockComptroller.deploy();
    const mUsdc: any = await MockMToken.deploy(
      "mUSDC",
      "mUSDC",
      await usdc.getAddress(),
      await comptroller.getAddress()
    );
    const mWeth: any = await MockMToken.deploy(
      "mWETH",
      "mWETH",
      await weth.getAddress(),
      await comptroller.getAddress()
    );
    const comet: any = await MockComet.deploy(await usdc.getAddress());
    const morpho: any = await MockMorpho.deploy();

    const lockChecker: any = await LockChecker.deploy(await dataProvider.getAddress(), 3_600);
    const aaveAdapter: any = await AaveAdapter.deploy(await pool.getAddress());
    const moonwellAdapter: any = await MoonwellAdapter.deploy();
    const compoundAdapter: any = await CompoundV3Adapter.deploy();
    const morphoAdapter: any = await MorphoAdapter.deploy(await morpho.getAddress());
    const swapAdapter: any = await SwapAdapter.deploy(
      await router.getAddress(),
      await usdc.getAddress()
    );
    const uniswapAdapter: any = await UniswapAdapter.deploy(other.address);

    // --- Aave state: 100 USDC variable debt, 1 aWETH + 10 aDAI collateral ---
    const aaveDebt = 100n * WAD;
    const aaveCollateral = 1n * WAD;
    const daiCollateral = 10n * WAD;

    const reserveConfigTemplate = {
      decimals: 18n,
      ltv: 0n,
      liquidationThreshold: 0n,
      liquidationBonus: 0n,
      reserveFactor: 0n,
      usageAsCollateralEnabled: true,
      borrowingEnabled: true,
      stableBorrowRateEnabled: true,
      isActive: true,
      isFrozen: false,
    };
    const reserveDataTemplate = {
      availableLiquidity: 1_000_000n * WAD,
      totalStableDebt: 0n,
      totalVariableDebt: 0n,
      liquidityRate: 0n,
      variableBorrowRate: 0n,
      stableBorrowRate: 0n,
      averageStableBorrowRate: 0n,
      liquidityIndex: 0n,
      variableBorrowIndex: 0n,
      lastUpdateTimestamp: BigInt(await time.latest()),
    };
    for (const token of [usdc, weth, dai]) {
      await dataProvider.setReserveConfigurationData(
        await token.getAddress(),
        reserveConfigTemplate
      );
      await dataProvider.setReserveData(await token.getAddress(), reserveDataTemplate);
    }
    await dataProvider.setReserveTokens(
      await usdc.getAddress(),
      await (await MockERC20.deploy("aUSDC", "aUSDC", 18)).getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress
    );
    await dataProvider.setReserveTokens(
      await weth.getAddress(),
      await aWeth.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress
    );
    await dataProvider.setReserveTokens(
      await dai.getAddress(),
      await aDai.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress
    );

    const userReserveTemplate = {
      currentATokenBalance: 0n,
      currentStableDebt: 0n,
      currentVariableDebt: 0n,
      principalStableDebt: 0n,
      scaledVariableDebt: 0n,
      stableBorrowRate: 0n,
      liquidityRate: 0n,
      stableRateLastUpdated: BigInt((await time.latest()) - 7_200),
      usageAsCollateralEnabled: false,
    };
    await dataProvider.setUserReserveData(user.address, await usdc.getAddress(), {
      ...userReserveTemplate,
      currentVariableDebt: aaveDebt,
    });
    await dataProvider.setUserReserveData(user.address, await weth.getAddress(), {
      ...userReserveTemplate,
      currentATokenBalance: aaveCollateral,
      usageAsCollateralEnabled: true,
    });
    await dataProvider.setUserReserveData(user.address, await dai.getAddress(), {
      ...userReserveTemplate,
      currentATokenBalance: daiCollateral,
      usageAsCollateralEnabled: true,
    });
    await pool.setUserAccountData(user.address, {
      totalCollateralBase: 2_000n * PRICE_SCALE,
      totalDebtBase: 100n * PRICE_SCALE,
      availableBorrowsBase: 0n,
      currentLiquidationThreshold: 0n,
      ltv: 0n,
      healthFactor: 1n * WAD,
    });

    // --- Moonwell: 30 USDC debt, 2 mWETH collateral ---
    const moonwellDebt = 30n * WAD;
    const moonwellCollateral = 2n * WAD;
    await mUsdc.setBorrowBalance(user.address, moonwellDebt);
    await mWeth.mint(user.address, moonwellCollateral);
    await weth.mint(await mWeth.getAddress(), moonwellCollateral);

    // --- Comet: 40 USDC debt, 0.5 WETH collateral ---
    const cometDebt = 40n * WAD;
    const cometCollateral = WAD / 2n;
    await comet.setBorrowBalance(user.address, cometDebt);
    await comet.setCollateral(user.address, await weth.getAddress(), cometCollateral);
    await weth.mint(await comet.getAddress(), cometCollateral);

    // --- Morpho: 20 USDC debt, 0.7 WETH collateral ---
    const morphoDebt = 20n * WAD;
    const morphoCollateral = (7n * WAD) / 10n;
    const marketParams = {
      loanToken: await usdc.getAddress(),
      collateralToken: await weth.getAddress(),
      oracle: ethers.ZeroAddress,
      irm: ethers.ZeroAddress,
      lltv: 860_000_000_000_000_000n,
    };
    const morphoData = abi.encode(
      ["tuple(address,address,address,address,uint256)"],
      [
        [
          marketParams.loanToken,
          marketParams.collateralToken,
          marketParams.oracle,
          marketParams.irm,
          marketParams.lltv,
        ],
      ]
    );
    const SHARES = 1_000_000n;
    await morpho.setMarket(marketParams, 1_000n * WAD, 1_000n * WAD * SHARES);
    await morpho.setPosition(marketParams, user.address, morphoDebt * SHARES, morphoCollateral);
    await weth.mint(await morpho.getAddress(), morphoCollateral);

    // --- Oracles + routing ---
    await marketOracle.setPrice(await usdc.getAddress(), 1n * PRICE_SCALE);
    await marketOracle.setPrice(await weth.getAddress(), 2_000n * PRICE_SCALE);
    await marketOracle.setPrice(await dai.getAddress(), 1n * PRICE_SCALE);
    await router.setRateWad(await weth.getAddress(), 2_000n * WAD);
    await router.setRateWad(await dai.getAddress(), 1n * WAD);
    await usdc.mint(await router.getAddress(), 10_000_000n * WAD);
    await weth.mint(await pool.getAddress(), 100n * WAD);
    await dai.mint(await pool.getAddress(), 1_000n * WAD);

    await usdc.mint(user.address, 5_000n * WAD);
    await aWeth.mint(user.address, aaveCollateral);
    await aDai.mint(user.address, daiCollateral);

    const executor: any = await PanikExecutor.deploy(
      await usdc.getAddress(),
      await dataProvider.getAddress(),
      await marketOracle.getAddress(),
      await mockOracle.getAddress(),
      await lockChecker.getAddress(),
      {
        aave: await aaveAdapter.getAddress(),
        moonwell: await moonwellAdapter.getAddress(),
        compound: await compoundAdapter.getAddress(),
        morpho: await morphoAdapter.getAddress(),
        swap: await swapAdapter.getAddress(),
        uniswap: await uniswapAdapter.getAddress(),
      },
      other.address,
      {
        assets: [await weth.getAddress(), await dai.getAddress()],
        paths: [
          encodeV3Path(await weth.getAddress(), 3_000, await usdc.getAddress()),
          encodeV3Path(await dai.getAddress(), 3_000, await usdc.getAddress()),
        ],
        minOutBps: [9_500, 9_500],
      },
      [],
      [await weth.getAddress(), await usdc.getAddress(), await dai.getAddress()],
      3_600,
      {
        priceFeedAssets: [await weth.getAddress(), await usdc.getAddress()],
        priceFeeds: [await wethFeed.getAddress(), await usdcFeed.getAddress()],
        oracleStalenessSeconds: STALENESS,
        sequencerUptimeFeed: withSequencerFeed
          ? await sequencerFeed.getAddress()
          : ethers.ZeroAddress,
        sequencerGracePeriod: GRACE,
        maxPermitSlippageBps: MAX_PERMIT_SLIPPAGE_BPS,
        markets: [
          await mUsdc.getAddress(),
          await mWeth.getAddress(),
          await comet.getAddress(),
        ],
      }
    );

    for (const adapter of [
      aaveAdapter,
      moonwellAdapter,
      compoundAdapter,
      morphoAdapter,
      swapAdapter,
      uniswapAdapter,
    ]) {
      await adapter.setExecutor(await executor.getAddress());
    }

    await usdc.connect(user).approve(await executor.getAddress(), MAX);
    await aWeth.connect(user).approve(await executor.getAddress(), MAX);
    await aDai.connect(user).approve(await executor.getAddress(), MAX);
    await mWeth.connect(user).approve(await executor.getAddress(), MAX);
    await comet.connect(user).allow(await compoundAdapter.getAddress(), true);
    await morpho.connect(user).setAuthorization(await morphoAdapter.getAddress(), true);

    const executorAddress = await executor.getAddress();
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const domain = {
      name: "PanikExecutor",
      version: "2",
      chainId,
      verifyingContract: executorAddress,
    };

    const addr = async (c: any) => await c.getAddress();
    const legs = {
      aaveUsdcDebt: leg(AAVE, await addr(usdc), MAX, 0n),
      aaveWethCollateral: leg(AAVE, await addr(weth), 0n, MAX),
      aaveDaiCollateral: leg(AAVE, await addr(dai), 0n, MAX),
      moonwellUsdcDebt: leg(MOONWELL, await addr(mUsdc), MAX, 0n),
      moonwellWethCollateral: leg(MOONWELL, await addr(mWeth), 0n, MAX),
      comet: leg(COMET, await addr(weth), MAX, MAX, abi.encode(["address"], [await addr(comet)])),
      cometRepayOnly: leg(
        COMET,
        ethers.ZeroAddress,
        MAX,
        0n,
        abi.encode(["address"], [await addr(comet)])
      ),
      morpho: leg(MORPHO, await addr(usdc), MAX, MAX, morphoData),
      morphoRepayOnly: leg(MORPHO, await addr(usdc), MAX, 0n, morphoData),
    };

    return {
      deployer,
      user,
      relayer,
      other,
      usdc,
      weth,
      dai,
      aWeth,
      aDai,
      mUsdc,
      mWeth,
      comptroller,
      comet,
      morpho,
      marketParams,
      morphoData,
      dataProvider,
      pool,
      router,
      wethFeed,
      usdcFeed,
      sequencerFeed,
      lockChecker,
      aaveAdapter,
      moonwellAdapter,
      compoundAdapter,
      morphoAdapter,
      swapAdapter,
      executor,
      executorAddress,
      chainId,
      domain,
      legs,
      aaveDebt,
      aaveCollateral,
      moonwellDebt,
      cometDebt,
      morphoDebt,
    };
  }

  async function deployFixture() {
    return build(false);
  }

  async function deploySequencerFixture() {
    return build(true);
  }

  async function deploy18DecimalFeedFixture() {
    return build(false, 18);
  }

  async function makePermit(f: any, overrides: Partial<Permit> = {}): Promise<Permit> {
    return {
      user: f.user.address,
      kind: FULL_EXIT,
      maxRepayFractionBps: 10_000,
      triggerHealthFactorWad: 0n,
      maxSlippageBps: 500,
      minUsdcOut: 0n,
      protocolsMask: MASK_AAVE | MASK_MOONWELL | MASK_COMET | MASK_MORPHO,
      epoch: 0n,
      nonce: 1n,
      deadline: BigInt((await time.latest()) + 3_600),
      ...overrides,
    };
  }

  async function sign(f: any, permit: Permit, signer = f.user, domain = f.domain) {
    return signer.signTypedData(domain, PERMIT_TYPES, permit);
  }

  // Submits as `relayer` (never the position owner) so every happy path in this
  // suite also proves a third party can drive the exit.
  async function submit(f: any, permit: Permit, legs: Leg[], signature: string, from?: any) {
    return f.executor
      .connect(from ?? f.relayer)
      .atomicExitFor(permit.user, legs, [], permit, signature);
  }

  describe("EIP-712 domain and digest", function () {
    it("matches the domain and digest a standard client computes", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f);

      expect(await f.executor.DOMAIN_SEPARATOR()).to.equal(
        ethers.TypedDataEncoder.hashDomain(f.domain)
      );
      expect(await f.executor.hashExitPermit(permit)).to.equal(
        ethers.TypedDataEncoder.hash(f.domain, PERMIT_TYPES, permit)
      );

      const d = await f.executor.eip712Domain();
      expect(d.name).to.equal("PanikExecutor");
      expect(d.version).to.equal("2");
      expect(Number(d.chainId)).to.equal(f.chainId);
      expect(d.verifyingContract).to.equal(f.executorAddress);
    });
  });

  describe("signature validity", function () {
    it("executes a permit signed by the position owner and submitted by anyone", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      const signature = await sign(f, permit);

      const before = await f.usdc.balanceOf(f.user.address);
      await expect(
        submit(f, permit, [f.legs.aaveUsdcDebt, f.legs.aaveWethCollateral], signature)
      )
        .to.emit(f.executor, "DelegatedExitExecuted")
        .withArgs(f.user.address, f.relayer.address, permit.nonce, 2_000n * WAD);

      // -100 USDC debt repaid, +1 WETH @2000 swapped in.
      expect((await f.usdc.balanceOf(f.user.address)) - before).to.equal(1_900n * WAD);
      expect(await f.aWeth.balanceOf(f.user.address)).to.equal(0n);
    });

    it("rejects a signature from the wrong signer", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      const signature = await sign(f, permit, f.other);
      await expect(
        submit(f, permit, [f.legs.aaveWethCollateral], signature)
      ).to.be.revertedWithCustomError(f.executor, "InvalidSignature");
    });

    it("rejects a signature bound to another chainId", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      const signature = await sign(f, permit, f.user, { ...f.domain, chainId: f.chainId + 1 });
      await expect(
        submit(f, permit, [f.legs.aaveWethCollateral], signature)
      ).to.be.revertedWithCustomError(f.executor, "InvalidSignature");
    });

    it("rejects a signature bound to another verifyingContract", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      const signature = await sign(f, permit, f.user, {
        ...f.domain,
        verifyingContract: await f.swapAdapter.getAddress(),
      });
      await expect(
        submit(f, permit, [f.legs.aaveWethCollateral], signature)
      ).to.be.revertedWithCustomError(f.executor, "InvalidSignature");
    });

    it("rejects a tampered field (slippage widened after signing)", async function () {
      const f = await loadFixture(deployFixture);
      const signed = await makePermit(f, { protocolsMask: MASK_AAVE, maxSlippageBps: 100 });
      const signature = await sign(f, signed);
      const tampered = { ...signed, maxSlippageBps: 2_000 };
      await expect(
        submit(f, tampered, [f.legs.aaveWethCollateral], signature)
      ).to.be.revertedWithCustomError(f.executor, "InvalidSignature");
    });

    it("rejects a tampered trigger", async function () {
      const f = await loadFixture(deployFixture);
      const signed = await makePermit(f, {
        protocolsMask: MASK_AAVE,
        triggerHealthFactorWad: WAD / 2n,
      });
      const signature = await sign(f, signed);
      const tampered = { ...signed, triggerHealthFactorWad: 10n * WAD };
      await expect(
        submit(f, tampered, [f.legs.aaveWethCollateral], signature)
      ).to.be.revertedWithCustomError(f.executor, "InvalidSignature");
    });

    it("rejects an empty exit and LP token ids", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      const signature = await sign(f, permit);
      await expect(
        f.executor
          .connect(f.relayer)
          .atomicExitFor(f.user.address, [], [], permit, signature)
      ).to.be.revertedWithCustomError(f.executor, "EmptyExit");
      await expect(
        f.executor
          .connect(f.relayer)
          .atomicExitFor(f.user.address, [f.legs.aaveWethCollateral], [1n], permit, signature)
      ).to.be.revertedWithCustomError(f.executor, "UniswapLegNotPermitted");
    });
  });

  describe("replay, expiry and revocation", function () {
    it("cannot spend the same nonce twice", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      const signature = await sign(f, permit);

      await submit(f, permit, [f.legs.aaveWethCollateral], signature);
      expect(await f.executor.isNonceUsed(f.user.address, permit.nonce)).to.equal(true);
      await expect(
        submit(f, permit, [f.legs.aaveDaiCollateral], signature)
      ).to.be.revertedWithCustomError(f.executor, "NonceAlreadyUsed");
    });

    it("rejects an expired permit", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, {
        protocolsMask: MASK_AAVE,
        deadline: BigInt((await time.latest()) - 1),
      });
      const signature = await sign(f, permit);
      await expect(
        submit(f, permit, [f.legs.aaveWethCollateral], signature)
      ).to.be.revertedWithCustomError(f.executor, "PermitExpired");
    });

    it("invalidateUnorderedNonces kills a specific permit immediately", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE, nonce: 260n });
      const signature = await sign(f, permit);

      // nonce 260 => word 1, bit 4
      await expect(f.executor.connect(f.user).invalidateUnorderedNonces(1n, 1n << 4n))
        .to.emit(f.executor, "UnorderedNonceInvalidation")
        .withArgs(f.user.address, 1n, 1n << 4n);

      expect(await f.executor.isNonceUsed(f.user.address, 260n)).to.equal(true);
      await expect(
        submit(f, permit, [f.legs.aaveWethCollateral], signature)
      ).to.be.revertedWithCustomError(f.executor, "NonceAlreadyUsed");
    });

    it("invalidating one nonce leaves the neighbouring ones usable", async function () {
      const f = await loadFixture(deployFixture);
      await f.executor.connect(f.user).invalidateUnorderedNonces(0n, 1n << 4n);
      expect(await f.executor.isNonceUsed(f.user.address, 4n)).to.equal(true);
      expect(await f.executor.isNonceUsed(f.user.address, 5n)).to.equal(false);

      const permit = await makePermit(f, { protocolsMask: MASK_AAVE, nonce: 5n });
      const signature = await sign(f, permit);
      await expect(submit(f, permit, [f.legs.aaveWethCollateral], signature)).to.not.be.reverted;
    });

    it("revokeAll orphans every outstanding permit", async function () {
      const f = await loadFixture(deployFixture);
      const permitA = await makePermit(f, { protocolsMask: MASK_AAVE, nonce: 7n });
      const permitB = await makePermit(f, { protocolsMask: MASK_AAVE, nonce: 8n });
      const sigA = await sign(f, permitA);
      const sigB = await sign(f, permitB);

      const tx = await f.executor.connect(f.user).revokeAll();
      const receipt = await tx.wait();
      // M-1: the new epoch is the block number, not a +1 increment.
      const newEpoch = BigInt(receipt!.blockNumber);
      await expect(tx)
        .to.emit(f.executor, "AllPermitsRevoked")
        .withArgs(f.user.address, newEpoch);
      expect(await f.executor.revocationEpoch(f.user.address)).to.equal(newEpoch);

      for (const [permit, signature] of [
        [permitA, sigA],
        [permitB, sigB],
      ] as const) {
        await expect(
          submit(f, permit, [f.legs.aaveWethCollateral], signature)
        ).to.be.revertedWithCustomError(f.executor, "PermitRevoked");
      }

      // ... and a permit signed against the new epoch still works.
      const fresh = await makePermit(f, {
        protocolsMask: MASK_AAVE,
        nonce: 9n,
        epoch: newEpoch,
      });
      await expect(submit(f, fresh, [f.legs.aaveWethCollateral], await sign(f, fresh))).to.not.be
        .reverted;
    });

    it("M-1: a permit pre-signed for a guessed future epoch dies on revokeAll", async function () {
      const f = await loadFixture(deployFixture);
      // With the old ++ scheme the next epoch was always 1, so an attacker
      // holding an epoch-0 permit could also stash an epoch-1 permit that would
      // survive the first revokeAll and reactivate. Binding the epoch to the
      // block number makes the target unguessable; a "current + 1" guess is
      // dead after the revoke.
      const current = await f.executor.revocationEpoch(f.user.address);
      const preSigned = await makePermit(f, {
        protocolsMask: MASK_AAVE,
        nonce: 40n,
        epoch: current + 1n,
      });
      const signature = await sign(f, preSigned);

      await f.executor.connect(f.user).revokeAll();

      await expect(
        submit(f, preSigned, [f.legs.aaveWethCollateral], signature)
      ).to.be.revertedWithCustomError(f.executor, "PermitRevoked");
    });

    it("one user's revocation does not touch another's permits", async function () {
      const f = await loadFixture(deployFixture);
      await f.executor.connect(f.other).revokeAll();
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      await expect(submit(f, permit, [f.legs.aaveWethCollateral], await sign(f, permit))).to.not.be
        .reverted;
    });
  });

  describe("scope enforcement", function () {
    it("proceeds land on the signer, never on the submitter", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      const signature = await sign(f, permit);

      const userBefore = await f.usdc.balanceOf(f.user.address);
      const relayerBefore = await f.usdc.balanceOf(f.relayer.address);
      const relayerWethBefore = await f.weth.balanceOf(f.relayer.address);

      await submit(f, permit, [f.legs.aaveWethCollateral], signature);

      expect((await f.usdc.balanceOf(f.user.address)) - userBefore).to.equal(2_000n * WAD);
      expect(await f.usdc.balanceOf(f.relayer.address)).to.equal(relayerBefore);
      expect(await f.weth.balanceOf(f.relayer.address)).to.equal(relayerWethBefore);
      expect(await f.usdc.balanceOf(f.executorAddress)).to.equal(0n);
      expect(await f.weth.balanceOf(f.executorAddress)).to.equal(0n);
    });

    it("rejects a leg on a protocol outside the mask", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      const signature = await sign(f, permit);
      await expect(
        submit(f, permit, [f.legs.aaveWethCollateral, f.legs.comet], signature)
      ).to.be.revertedWithCustomError(f.executor, "ProtocolNotPermitted");
    });

    it("rejects a permit presented for a different user", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      const signature = await sign(f, permit);
      await expect(
        f.executor
          .connect(f.relayer)
          .atomicExitFor(f.other.address, [f.legs.aaveWethCollateral], [], permit, signature)
      ).to.be.revertedWithCustomError(f.executor, "PermitUserMismatch");
    });

    it("re-signing another user's permit body does not reach their position", async function () {
      const f = await loadFixture(deployFixture);
      // `other` signs a permit naming themselves and points it at legs that
      // describe the victim's markets. Everything acts on `other`'s (empty)
      // position, so the victim keeps every token.
      const permit = await makePermit(f, {
        user: f.other.address,
        protocolsMask: MASK_AAVE,
      });
      const signature = await sign(f, permit, f.other);

      const victimUsdc = await f.usdc.balanceOf(f.user.address);
      const victimAWeth = await f.aWeth.balanceOf(f.user.address);
      await f.executor
        .connect(f.relayer)
        .atomicExitFor(f.other.address, [f.legs.aaveWethCollateral], [], permit, signature);

      expect(await f.usdc.balanceOf(f.user.address)).to.equal(victimUsdc);
      expect(await f.aWeth.balanceOf(f.user.address)).to.equal(victimAWeth);
      expect(await f.usdc.balanceOf(f.other.address)).to.equal(0n);
    });

    it("caps the repay at maxRepayFractionBps of the live debt", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, {
        kind: REDUCE,
        maxRepayFractionBps: 2_500,
        protocolsMask: MASK_AAVE,
      });
      const signature = await sign(f, permit);

      const before = await f.usdc.balanceOf(f.user.address);
      // The leg asks for the FULL debt; the permit is what binds.
      await submit(f, permit, [f.legs.aaveUsdcDebt], signature);

      expect(before - (await f.usdc.balanceOf(f.user.address))).to.equal(
        (f.aaveDebt * 2_500n) / 10_000n
      );
      const reserve = await f.dataProvider.getUserReserveData(
        await f.usdc.getAddress(),
        f.user.address
      );
      expect(reserve.currentVariableDebt).to.equal(f.aaveDebt - (f.aaveDebt * 2_500n) / 10_000n);
    });

    it("caps a Morpho repay by assets rather than closing by shares", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, {
        kind: REDUCE,
        maxRepayFractionBps: 5_000,
        protocolsMask: MASK_MORPHO,
      });
      const signature = await sign(f, permit);

      const before = await f.usdc.balanceOf(f.user.address);
      await submit(f, permit, [f.legs.morphoRepayOnly], signature);
      expect(before - (await f.usdc.balanceOf(f.user.address))).to.equal(f.morphoDebt / 2n);

      const pos = await f.morpho.position(
        await f.morpho.marketId(f.marketParams),
        f.user.address
      );
      expect(pos.borrowShares).to.be.greaterThan(0n);
      expect(pos.collateral).to.equal((7n * WAD) / 10n);
    });

    it("refuses to move collateral under a repay-only permit", async function () {
      const f = await loadFixture(deployFixture);
      for (const kind of [FULL_REPAY, REDUCE]) {
        const permit = await makePermit(f, {
          kind,
          maxRepayFractionBps: kind === FULL_REPAY ? 10_000 : 5_000,
          protocolsMask: MASK_AAVE,
          nonce: BigInt(20 + kind),
        });
        const signature = await sign(f, permit);
        await expect(
          submit(f, permit, [f.legs.aaveWethCollateral], signature)
        ).to.be.revertedWithCustomError(f.executor, "WithdrawNotPermitted");
      }
    });

    it("blocks collateral withdrawal on a non-Aave protocol too", async function () {
      const f = await loadFixture(deployFixture);
      // The guard is protocol-agnostic; prove it on Moonwell so it is not an
      // Aave-only accident.
      const permit = await makePermit(f, {
        kind: REDUCE,
        maxRepayFractionBps: 5_000,
        protocolsMask: MASK_MOONWELL,
      });
      const signature = await sign(f, permit);
      await expect(
        submit(f, permit, [f.legs.moonwellWethCollateral], signature)
      ).to.be.revertedWithCustomError(f.executor, "WithdrawNotPermitted");
    });

    it("rejects a FULL_REPAY permit carrying a partial fraction", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, {
        kind: FULL_REPAY,
        maxRepayFractionBps: 5_000,
        protocolsMask: MASK_AAVE,
      });
      const signature = await sign(f, permit);
      await expect(
        submit(f, permit, [f.legs.aaveUsdcDebt], signature)
      ).to.be.revertedWithCustomError(f.executor, "InvalidRepayFraction");
    });

    it("rejects an unregistered Comet (a fake market cannot be smuggled in)", async function () {
      const f = await loadFixture(deployFixture);
      const MockComet = await ethers.getContractFactory("MockComet");
      const rogue: any = await MockComet.deploy(await f.usdc.getAddress());
      await rogue.setBorrowBalance(f.user.address, 5_000n * WAD);

      const permit = await makePermit(f, { protocolsMask: MASK_COMET });
      const signature = await sign(f, permit);
      const rogueLeg = leg(
        COMET,
        ethers.ZeroAddress,
        MAX,
        0n,
        abi.encode(["address"], [await rogue.getAddress()])
      );
      await expect(submit(f, permit, [rogueLeg], signature))
        .to.be.revertedWithCustomError(f.executor, "MarketNotPermitted")
        .withArgs(await rogue.getAddress());
    });

    it("rejects an unregistered mToken", async function () {
      const f = await loadFixture(deployFixture);
      const MockMToken = await ethers.getContractFactory("MockMToken");
      const rogue: any = await MockMToken.deploy(
        "mROGUE",
        "mROGUE",
        await f.usdc.getAddress(),
        await f.comptroller.getAddress()
      );
      await rogue.setBorrowBalance(f.user.address, 5_000n * WAD);

      const permit = await makePermit(f, { protocolsMask: MASK_MOONWELL });
      const signature = await sign(f, permit);
      await expect(
        submit(f, permit, [leg(MOONWELL, await rogue.getAddress(), MAX, 0n)], signature)
      ).to.be.revertedWithCustomError(f.executor, "MarketNotPermitted");
    });

    it("rejects an untracked asset", async function () {
      const f = await loadFixture(deployFixture);
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const rogue: any = await MockERC20.deploy("ROGUE", "ROGUE", 18);

      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      const signature = await sign(f, permit);
      await expect(
        submit(f, permit, [leg(AAVE, await rogue.getAddress(), MAX, 0n)], signature)
      )
        .to.be.revertedWithCustomError(f.executor, "AssetNotTracked")
        .withArgs(await rogue.getAddress());
    });

    it("rejects slippage wider than the deployment ceiling", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, {
        protocolsMask: MASK_AAVE,
        maxSlippageBps: MAX_PERMIT_SLIPPAGE_BPS + 1,
      });
      const signature = await sign(f, permit);
      await expect(submit(f, permit, [f.legs.aaveWethCollateral], signature))
        .to.be.revertedWithCustomError(f.executor, "InvalidPermitSlippage")
        .withArgs(MAX_PERMIT_SLIPPAGE_BPS + 1, MAX_PERMIT_SLIPPAGE_BPS);
    });
  });

  describe("trigger gate", function () {
    it("executes when the live health factor is below the trigger", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, {
        protocolsMask: MASK_AAVE,
        triggerHealthFactorWad: 2n * WAD, // live HF is 1.0
      });
      const signature = await sign(f, permit);
      await expect(submit(f, permit, [f.legs.aaveWethCollateral], signature)).to.not.be.reverted;
    });

    it("reverts TriggerNotMet when the position is healthier than the trigger", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, {
        protocolsMask: MASK_AAVE,
        triggerHealthFactorWad: (9n * WAD) / 10n,
      });
      const signature = await sign(f, permit);
      await expect(submit(f, permit, [f.legs.aaveWethCollateral], signature))
        .to.be.revertedWithCustomError(f.executor, "TriggerNotMet")
        .withArgs(AAVE, WAD, (9n * WAD) / 10n);
    });

    it("honours a Moonwell trigger only once the account is in shortfall", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, {
        protocolsMask: MASK_MOONWELL,
        triggerHealthFactorWad: WAD,
        kind: REDUCE,
        maxRepayFractionBps: 5_000,
      });
      const signature = await sign(f, permit);

      await expect(
        submit(f, permit, [f.legs.moonwellUsdcDebt], signature)
      ).to.be.revertedWithCustomError(f.executor, "TriggerNotMet");

      await f.comptroller.setAccountLiquidity(f.user.address, 0n, 1n);
      await expect(submit(f, permit, [f.legs.moonwellUsdcDebt], signature)).to.not.be.reverted;
    });

    it("refuses a Moonwell trigger tighter than 1.0 rather than guessing", async function () {
      const f = await loadFixture(deployFixture);
      await f.comptroller.setAccountLiquidity(f.user.address, 0n, 1n);
      const permit = await makePermit(f, {
        protocolsMask: MASK_MOONWELL,
        triggerHealthFactorWad: (9n * WAD) / 10n,
        kind: REDUCE,
        maxRepayFractionBps: 5_000,
      });
      const signature = await sign(f, permit);
      await expect(
        submit(f, permit, [f.legs.moonwellUsdcDebt], signature)
      ).to.be.revertedWithCustomError(f.executor, "TriggerNotMet");
    });

    it("refuses trigger-gated Compound V3 and Morpho legs outright", async function () {
      const f = await loadFixture(deployFixture);
      const cometPermit = await makePermit(f, {
        protocolsMask: MASK_COMET,
        triggerHealthFactorWad: 2n * WAD,
        kind: REDUCE,
        maxRepayFractionBps: 5_000,
        nonce: 30n,
      });
      await expect(
        submit(f, cometPermit, [f.legs.cometRepayOnly], await sign(f, cometPermit))
      )
        .to.be.revertedWithCustomError(f.executor, "TriggerUnsupported")
        .withArgs(COMET);

      const morphoPermit = await makePermit(f, {
        protocolsMask: MASK_MORPHO,
        triggerHealthFactorWad: 2n * WAD,
        kind: REDUCE,
        maxRepayFractionBps: 5_000,
        nonce: 31n,
      });
      await expect(
        submit(f, morphoPermit, [f.legs.morphoRepayOnly], await sign(f, morphoPermit))
      )
        .to.be.revertedWithCustomError(f.executor, "TriggerUnsupported")
        .withArgs(MORPHO);
    });

    it("runs Compound V3 and Morpho legs on an execute-now permit", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, {
        protocolsMask: MASK_COMET | MASK_MORPHO,
        triggerHealthFactorWad: 0n,
      });
      const signature = await sign(f, permit);
      await expect(submit(f, permit, [f.legs.comet, f.legs.morpho], signature)).to.not.be.reverted;
      expect(await f.comet.borrowBalanceOf(f.user.address)).to.equal(0n);
    });
  });

  describe("slippage v2", function () {
    it("floors the swap at the signer's maxSlippageBps against the live oracle", async function () {
      const f = await loadFixture(deployFixture);
      // 1 WETH quoted at 2000 USDC; a 100 bps permit floors at 1980, and the
      // pool is paying 1970.
      await f.router.setRateWad(await f.weth.getAddress(), 1_970n * WAD);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE, maxSlippageBps: 100 });
      const signature = await sign(f, permit);
      await expect(submit(f, permit, [f.legs.aaveWethCollateral], signature)).to.be.revertedWith(
        "MockUR: too little out"
      );

      // Same trade, same block conditions, a wider signed tolerance: allowed.
      const looser = await makePermit(f, {
        protocolsMask: MASK_AAVE,
        maxSlippageBps: 200,
        nonce: 2n,
      });
      await expect(
        submit(f, looser, [f.legs.aaveWethCollateral], await sign(f, looser))
      ).to.not.be.reverted;
    });

    it("CRASH: executes at the signer's tolerance where v1's frozen 9500 floor reverts", async function () {
      const f = await loadFixture(deployFixture);
      // The market gaps 10% below the oracle mid. The oracle itself is fine -
      // it was updated this block - so this is honest price movement, not a
      // stale feed. v1's constructor-frozen 9500 floor demands 1900 out of a
      // pool paying 1800 and the exit dies exactly when it is needed most.
      await f.router.setRateWad(await f.weth.getAddress(), 1_800n * WAD);
      await f.wethFeed.setAnswer(2_000n * PRICE_SCALE);

      await expect(
        f.executor.connect(f.user).atomicExit([f.legs.aaveWethCollateral], [])
      ).to.be.revertedWith("MockUR: too little out");

      // The same block, the same price, a permit whose signer accepted 10%.
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE, maxSlippageBps: 1_000 });
      const signature = await sign(f, permit);

      const before = await f.usdc.balanceOf(f.user.address);
      await submit(f, permit, [f.legs.aaveWethCollateral], signature);
      expect((await f.usdc.balanceOf(f.user.address)) - before).to.equal(1_800n * WAD);
    });

    it("reverts StalePrice when the feed is older than the staleness bound", async function () {
      const f = await loadFixture(deployFixture);
      const now = await time.latest();
      await f.wethFeed.setAnswerAt(
        2_000n * PRICE_SCALE,
        now - STALENESS - 600,
        now - STALENESS - 600
      );

      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      const signature = await sign(f, permit);
      await expect(
        submit(f, permit, [f.legs.aaveWethCollateral], signature)
      ).to.be.revertedWithCustomError(f.executor, "StalePrice");
    });

    it("accepts a feed inside the staleness bound", async function () {
      const f = await loadFixture(deployFixture);
      const now = await time.latest();
      await f.wethFeed.setAnswerAt(2_000n * PRICE_SCALE, now - 60, now - 60);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      await expect(
        submit(f, permit, [f.legs.aaveWethCollateral], await sign(f, permit))
      ).to.not.be.reverted;
    });

    it("reverts on a non-positive feed answer", async function () {
      const f = await loadFixture(deployFixture);
      await f.wethFeed.setAnswer(0n);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      await expect(
        submit(f, permit, [f.legs.aaveWethCollateral], await sign(f, permit))
      ).to.be.revertedWithCustomError(f.executor, "PriceUnavailable");
    });

    it("reverts MissingPriceFeed rather than pricing off an undateable oracle", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      const signature = await sign(f, permit);
      await expect(submit(f, permit, [f.legs.aaveDaiCollateral], signature))
        .to.be.revertedWithCustomError(f.executor, "MissingPriceFeed")
        .withArgs(await f.dai.getAddress());

      // The self-serve path still handles DAI: it never claimed freshness.
      await expect(f.executor.connect(f.user).atomicExit([f.legs.aaveDaiCollateral], [])).to.not.be
        .reverted;
    });
  });

  describe("sequencer uptime", function () {
    it("skips the check when no feed is configured", async function () {
      const f = await loadFixture(deployFixture);
      expect(await f.executor.sequencerUptimeFeed()).to.equal(ethers.ZeroAddress);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      await expect(
        submit(f, permit, [f.legs.aaveWethCollateral], await sign(f, permit))
      ).to.not.be.reverted;
    });

    it("executes while the feed reports the sequencer up and past its grace period", async function () {
      const f = await loadFixture(deploySequencerFixture);
      await f.sequencerFeed.setStartedAt((await time.latest()) - GRACE - 1);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      await expect(
        submit(f, permit, [f.legs.aaveWethCollateral], await sign(f, permit))
      ).to.not.be.reverted;
    });

    it("reverts SequencerDown when the feed reports an outage", async function () {
      const f = await loadFixture(deploySequencerFixture);
      await f.sequencerFeed.setAnswer(1n);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      await expect(submit(f, permit, [f.legs.aaveWethCollateral], await sign(f, permit)))
        .to.be.revertedWithCustomError(f.executor, "SequencerDown")
        .withArgs(1n);
    });

    it("reverts inside the grace period after a restart", async function () {
      const f = await loadFixture(deploySequencerFixture);
      await f.sequencerFeed.setAnswer(0n); // just came back up
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      await expect(
        submit(f, permit, [f.legs.aaveWethCollateral], await sign(f, permit))
      ).to.be.revertedWithCustomError(f.executor, "SequencerGracePeriodNotOver");
    });

    it("leaves the self-serve path untouched by the sequencer feed", async function () {
      const f = await loadFixture(deploySequencerFixture);
      await f.sequencerFeed.setAnswer(1n);
      await expect(f.executor.connect(f.user).atomicExit([f.legs.aaveWethCollateral], [])).to.not
        .be.reverted;
    });
  });

  describe("multi-protocol delegated exit", function () {
    it("closes all four protocols under one permit and sweeps to the signer", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, { maxSlippageBps: 500 });
      const signature = await sign(f, permit);

      const before = await f.usdc.balanceOf(f.user.address);
      await submit(
        f,
        permit,
        [
          f.legs.aaveUsdcDebt,
          f.legs.aaveWethCollateral,
          f.legs.moonwellUsdcDebt,
          f.legs.moonwellWethCollateral,
          f.legs.comet,
          f.legs.morpho,
        ],
        signature
      );

      // Same arithmetic as the self-serve suite: 4.2 WETH @2000 in,
      // 190 USDC of debt out.
      const delta = (await f.usdc.balanceOf(f.user.address)) - before;
      expect(delta).to.be.closeTo(8_400n * WAD - 190n * WAD, WAD / 1_000_000n);
      expect(await f.usdc.balanceOf(f.relayer.address)).to.equal(0n);
      expect(await f.usdc.balanceOf(f.executorAddress)).to.equal(0n);
      expect(await f.weth.balanceOf(f.executorAddress)).to.equal(0n);
    });
  });

  // H-1: the nonce is spent up front, so an exit that does no work would burn
  // the permit for free at the exact moment protection should fire. Two guards:
  // the minUsdcOut floor (primary) and the empty-leg rejection (defense).
  describe("H-1 nonce-burn resistance", function () {
    it("rejects a leg that neither repays nor withdraws", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      const signature = await sign(f, permit);
      const noop = leg(AAVE, await f.weth.getAddress(), 0n, 0n);
      await expect(submit(f, permit, [noop], signature))
        .to.be.revertedWithCustomError(f.executor, "EmptyLeg")
        .withArgs(AAVE, await f.weth.getAddress());
    });

    it("reverts (and does NOT spend the nonce) when the exit underruns minUsdcOut", async function () {
      const f = await loadFixture(deployFixture);
      // Withdrawing only the DAI leg nets ~10 USDC; a permit demanding 5000 out
      // must revert. The nonce is spent inside the same tx, so the revert has to
      // unwind it or the permit is dead.
      const permit = await makePermit(f, {
        protocolsMask: MASK_AAVE,
        minUsdcOut: 5_000n * WAD,
        // DAI has no feed, so use WETH which does; 1 WETH -> ~2000 USDC < 5000.
      });
      const signature = await sign(f, permit);

      await expect(submit(f, permit, [f.legs.aaveWethCollateral], signature))
        .to.be.revertedWithCustomError(f.executor, "InsufficientUsdcOut")
        .withArgs(5_000n * WAD, 2_000n * WAD);

      // Nonce survived the revert: the real exit still runs.
      expect(await f.executor.isNonceUsed(f.user.address, permit.nonce)).to.equal(false);
      const ok = await makePermit(f, {
        protocolsMask: MASK_AAVE,
        minUsdcOut: 1_000n * WAD,
        nonce: permit.nonce,
      });
      await expect(submit(f, ok, [f.legs.aaveWethCollateral], await sign(f, ok))).to.not.be
        .reverted;
    });

    it("executes when the exit clears minUsdcOut", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, {
        protocolsMask: MASK_AAVE,
        minUsdcOut: 1_900n * WAD,
      });
      const before = await f.usdc.balanceOf(f.user.address);
      await submit(f, permit, [f.legs.aaveWethCollateral], await sign(f, permit));
      expect((await f.usdc.balanceOf(f.user.address)) - before).to.equal(2_000n * WAD);
    });

    it("multi-leg: a subset that underruns the floor cannot burn the permit", async function () {
      const f = await loadFixture(deployFixture);
      // Signer authorises a full four-protocol exit AND a floor. A submitter who
      // runs only the smallest leg (Morpho, ~1400 USDC) to burn the nonce and
      // liquidate the rest is stopped by minUsdcOut.
      const permit = await makePermit(f, {
        protocolsMask: MASK_AAVE | MASK_MOONWELL | MASK_COMET | MASK_MORPHO,
        minUsdcOut: 8_000n * WAD,
      });
      const signature = await sign(f, permit);
      await expect(
        submit(f, permit, [f.legs.morpho], signature)
      ).to.be.revertedWithCustomError(f.executor, "InsufficientUsdcOut");
      expect(await f.executor.isNonceUsed(f.user.address, permit.nonce)).to.equal(false);
    });
  });

  describe("ERC-1271 contract-wallet signing", function () {
    async function walletFixture() {
      const f = await loadFixture(deployFixture);
      const Wallet = await ethers.getContractFactory("MockERC1271Wallet");
      // The wallet's owner is `other`; the wallet address is the permit.user.
      const wallet: any = await Wallet.deploy(f.other.address);
      const walletAddr = await wallet.getAddress();

      // Fund + approve the wallet exactly like an EOA position owner.
      await f.usdc.mint(walletAddr, 5_000n * WAD);
      await f.aWeth.mint(walletAddr, 1n * WAD);
      await f.dataProvider.setUserReserveData(walletAddr, await f.weth.getAddress(), {
        currentATokenBalance: 1n * WAD,
        currentStableDebt: 0n,
        currentVariableDebt: 0n,
        principalStableDebt: 0n,
        scaledVariableDebt: 0n,
        stableBorrowRate: 0n,
        liquidityRate: 0n,
        stableRateLastUpdated: 0n,
        usageAsCollateralEnabled: true,
      });
      // The wallet can't call approve itself in this mock, so approve from an
      // impersonated wallet account. Fund gas via setBalance (the mock has no
      // receive(), so a value transfer would revert).
      await ethers.provider.send("hardhat_impersonateAccount", [walletAddr]);
      await ethers.provider.send("hardhat_setBalance", [walletAddr, "0xDE0B6B3A7640000"]);
      const walletSigner = await ethers.getSigner(walletAddr);
      await f.aWeth.connect(walletSigner).approve(f.executorAddress, MAX);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [walletAddr]);

      return { ...f, wallet, walletAddr };
    }

    it("accepts a permit whose contract signer validates the signature (ERC-1271)", async function () {
      const f = await walletFixture();
      const permit = await makePermit(f, { user: f.walletAddr, protocolsMask: MASK_AAVE });
      // The inner EOA (the wallet's owner) produces the signature bytes.
      const signature = await sign(f, permit, f.other);

      const before = await f.usdc.balanceOf(f.walletAddr);
      await f.executor
        .connect(f.relayer)
        .atomicExitFor(f.walletAddr, [f.legs.aaveWethCollateral], [], permit, signature);
      expect((await f.usdc.balanceOf(f.walletAddr)) - before).to.equal(2_000n * WAD);
    });

    it("rejects when the contract signer disowns the signature", async function () {
      const f = await walletFixture();
      await f.wallet.setDisabled(true); // revocable, as ERC-1271 allows
      const permit = await makePermit(f, { user: f.walletAddr, protocolsMask: MASK_AAVE });
      const signature = await sign(f, permit, f.other);
      await expect(
        f.executor
          .connect(f.relayer)
          .atomicExitFor(f.walletAddr, [f.legs.aaveWethCollateral], [], permit, signature)
      ).to.be.revertedWithCustomError(f.executor, "InvalidSignature");
    });

    it("rejects a contract signer whose owner did not sign", async function () {
      const f = await walletFixture();
      const permit = await makePermit(f, { user: f.walletAddr, protocolsMask: MASK_AAVE });
      const signature = await sign(f, permit, f.user); // wrong inner signer
      await expect(
        f.executor
          .connect(f.relayer)
          .atomicExitFor(f.walletAddr, [f.legs.aaveWethCollateral], [], permit, signature)
      ).to.be.revertedWithCustomError(f.executor, "InvalidSignature");
    });
  });

  describe("signature malleability and shape", function () {
    const SECP256K1N =
      0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

    it("rejects the high-s malleable twin of a valid signature", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      const good = await sign(f, permit);

      const sig = ethers.Signature.from(good);
      // Build the raw 65 bytes by hand: ethers.Signature refuses to hold a
      // non-canonical (high-s) value, which is precisely what we need to feed
      // the contract to prove OZ's ECDSA rejects it.
      const highS = SECP256K1N - BigInt(sig.s);
      const flippedV = sig.v === 27 ? 28 : 27;
      const flipped = ethers.concat([
        sig.r,
        ethers.toBeHex(highS, 32),
        ethers.toBeHex(flippedV, 1),
      ]);

      await expect(
        submit(f, permit, [f.legs.aaveWethCollateral], flipped)
      ).to.be.revertedWithCustomError(f.executor, "InvalidSignature");
    });

    it("rejects a wrong-length signature", async function () {
      const f = await loadFixture(deployFixture);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE });
      await expect(
        submit(f, permit, [f.legs.aaveWethCollateral], "0xdeadbeef")
      ).to.be.revertedWithCustomError(f.executor, "InvalidSignature");
    });
  });

  describe("feed decimals scaling (M-2)", function () {
    it("prices correctly off an 18-decimal feed", async function () {
      const f = await loadFixture(deploy18DecimalFeedFixture);
      expect(await f.executor.getPriceFeedDecimals(await f.weth.getAddress())).to.equal(18n);

      // A tight 100 bps floor only passes if _scalePrice normalised the
      // 18-decimal answer to the same base as USDC; a botched scale would make
      // the floor near-zero. The pool pays the full 2000, so assert the OUTPUT
      // amount (a near-zero floor would also let a bad price through).
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE, maxSlippageBps: 100 });
      const before = await f.usdc.balanceOf(f.user.address);
      await submit(f, permit, [f.legs.aaveWethCollateral], await sign(f, permit));
      expect((await f.usdc.balanceOf(f.user.address)) - before).to.equal(2_000n * WAD);
    });

    it("the 18-decimal floor still bites at the signer's tolerance", async function () {
      const f = await loadFixture(deploy18DecimalFeedFixture);
      // 1970 out under a 100 bps (1980) floor must fail - proving the scaled
      // price feeds a real, non-zero floor rather than a rounding artefact.
      await f.router.setRateWad(await f.weth.getAddress(), 1_970n * WAD);
      const permit = await makePermit(f, { protocolsMask: MASK_AAVE, maxSlippageBps: 100 });
      await expect(
        submit(f, permit, [f.legs.aaveWethCollateral], await sign(f, permit))
      ).to.be.revertedWith("MockUR: too little out");
    });
  });
});
