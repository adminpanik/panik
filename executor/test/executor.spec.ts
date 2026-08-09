import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
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

const abi = ethers.AbiCoder.defaultAbiCoder();

function encodeV3Path(tokenIn: string, fee: number, tokenOut: string): string {
  return ethers.solidityPacked(["address", "uint24", "address"], [tokenIn, fee, tokenOut]);
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

describe("PanikExecutor - multi-protocol atomic exit (Phase 2)", function () {
  async function deployFixture() {
    const [deployer, user, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const MockDataProvider = await ethers.getContractFactory("MockAaveProtocolDataProvider");
    const MockPool = await ethers.getContractFactory("MockAavePool");
    const MockRouter = await ethers.getContractFactory("MockUniversalRouter");
    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
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
    const CallerProxy = await ethers.getContractFactory("CallerProxy");

    const usdc: any = await MockERC20.deploy("USDC", "USDC", 18);
    const weth: any = await MockERC20.deploy("WETH", "WETH", 18);
    const aUsdc: any = await MockERC20.deploy("aUSDC", "aUSDC", 18);
    const aWeth: any = await MockERC20.deploy("aWETH", "aWETH", 18);

    const dataProvider: any = await MockDataProvider.deploy();
    const pool: any = await MockPool.deploy(await dataProvider.getAddress());
    const router: any = await MockRouter.deploy();
    const marketOracle: any = await MockPriceOracle.deploy();
    const mockOracle: any = await MockPriceOracle.deploy();

    // Moonwell: user has WETH collateral (mWETH) and USDC debt (mUSDC).
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

    // Compound V3: USDC base debt, WETH collateral.
    const comet: any = await MockComet.deploy(await usdc.getAddress());

    // Morpho Blue: USDC loan, WETH collateral.
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
    // LP exits are dormant; the adapter still needs a nonzero manager address.
    const uniswapAdapter: any = await UniswapAdapter.deploy(other.address);

    // --- Aave state: 100 USDC variable debt, 1 aWETH collateral ---
    const aaveDebt = 100n * WAD;
    const aaveCollateral = 1n * WAD;

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
    await dataProvider.setReserveConfigurationData(await usdc.getAddress(), reserveConfigTemplate);
    await dataProvider.setReserveConfigurationData(await weth.getAddress(), reserveConfigTemplate);
    await dataProvider.setReserveData(await usdc.getAddress(), reserveDataTemplate);
    await dataProvider.setReserveData(await weth.getAddress(), reserveDataTemplate);
    await dataProvider.setReserveTokens(
      await usdc.getAddress(),
      await aUsdc.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress
    );
    await dataProvider.setReserveTokens(
      await weth.getAddress(),
      await aWeth.getAddress(),
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
    await pool.setUserAccountData(user.address, {
      totalCollateralBase: 2_000n * PRICE_SCALE,
      totalDebtBase: 100n * PRICE_SCALE,
      availableBorrowsBase: 0n,
      currentLiquidationThreshold: 0n,
      ltv: 0n,
      healthFactor: 1n * WAD,
    });

    // --- Moonwell state: 30 USDC debt, 2 mWETH collateral (1:1 redeem) ---
    const moonwellDebt = 30n * WAD;
    const moonwellCollateral = 2n * WAD;
    await mUsdc.setBorrowBalance(user.address, moonwellDebt);
    await mWeth.mint(user.address, moonwellCollateral);
    await weth.mint(await mWeth.getAddress(), moonwellCollateral); // redeem cash

    // --- Comet state: 40 USDC debt, 0.5 WETH collateral ---
    const cometDebt = 40n * WAD;
    const cometCollateral = WAD / 2n;
    await comet.setBorrowBalance(user.address, cometDebt);
    await comet.setCollateral(user.address, await weth.getAddress(), cometCollateral);
    await weth.mint(await comet.getAddress(), cometCollateral);

    // --- Morpho state: 20 USDC debt (by shares), 0.7 WETH collateral ---
    const morphoDebt = 20n * WAD;
    const morphoCollateral = (7n * WAD) / 10n;
    const marketParams = {
      loanToken: await usdc.getAddress(),
      collateralToken: await weth.getAddress(),
      oracle: ethers.ZeroAddress,
      irm: ethers.ZeroAddress,
      lltv: 860_000_000_000_000_000n,
    };
    const mpTuple = [
      marketParams.loanToken,
      marketParams.collateralToken,
      marketParams.oracle,
      marketParams.irm,
      marketParams.lltv,
    ];
    const morphoData = abi.encode(
      ["tuple(address,address,address,address,uint256)"],
      [mpTuple]
    );
    const SHARES = 1_000_000n; // Morpho virtual-shares scale
    await morpho.setMarket(marketParams, 1_000n * WAD, 1_000n * WAD * SHARES);
    await morpho.setPosition(marketParams, user.address, morphoDebt * SHARES, morphoCollateral);
    await weth.mint(await morpho.getAddress(), morphoCollateral);

    // --- Oracles + swap routing (WETH -> USDC @ 2000, floor 95%) ---
    await marketOracle.setPrice(await usdc.getAddress(), 1n * PRICE_SCALE);
    await marketOracle.setPrice(await weth.getAddress(), 2_000n * PRICE_SCALE);
    await mockOracle.setPrice(await usdc.getAddress(), 1n * PRICE_SCALE);
    await mockOracle.setPrice(await weth.getAddress(), 2_000n * PRICE_SCALE);
    await router.setRateWad(await weth.getAddress(), 2_000n * WAD);
    await usdc.mint(await router.getAddress(), 10_000_000n * WAD);
    await weth.mint(await pool.getAddress(), 100n * WAD);

    // --- User funding + approvals ---
    await usdc.mint(user.address, 5_000n * WAD);
    await aWeth.mint(user.address, aaveCollateral);

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
      other.address, // nftManager - LP path untested here
      {
        assets: [await weth.getAddress()],
        paths: [encodeV3Path(await weth.getAddress(), 3_000, await usdc.getAddress())],
        minOutBps: [9_500],
      },
      [],
      [await weth.getAddress(), await usdc.getAddress()],
      3_600
    );

    await aaveAdapter.setExecutor(await executor.getAddress());
    await moonwellAdapter.setExecutor(await executor.getAddress());
    await compoundAdapter.setExecutor(await executor.getAddress());
    await morphoAdapter.setExecutor(await executor.getAddress());
    await swapAdapter.setExecutor(await executor.getAddress());
    await uniswapAdapter.setExecutor(await executor.getAddress());

    await usdc.connect(user).approve(await executor.getAddress(), MAX);
    await aWeth.connect(user).approve(await executor.getAddress(), MAX);
    await mWeth.connect(user).approve(await executor.getAddress(), MAX);
    await comet.connect(user).allow(await compoundAdapter.getAddress(), true);
    await morpho.connect(user).setAuthorization(await morphoAdapter.getAddress(), true);

    const proxy: any = await CallerProxy.deploy();

    const addr = async (c: any) => await c.getAddress();
    const legs = {
      aaveUsdcDebt: leg(AAVE, await addr(usdc), MAX, 0n),
      aaveWethCollateral: leg(AAVE, await addr(weth), 0n, MAX),
      moonwellUsdcDebt: leg(MOONWELL, await addr(mUsdc), MAX, 0n),
      moonwellWethCollateral: leg(MOONWELL, await addr(mWeth), 0n, MAX),
      comet: leg(COMET, await addr(weth), MAX, MAX, abi.encode(["address"], [await addr(comet)])),
      morpho: leg(MORPHO, await addr(usdc), MAX, MAX, morphoData),
    };

    return {
      deployer,
      user,
      other,
      usdc,
      weth,
      aUsdc,
      aWeth,
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
      lockChecker,
      aaveAdapter,
      moonwellAdapter,
      compoundAdapter,
      morphoAdapter,
      swapAdapter,
      executor,
      proxy,
      legs,
      aaveDebt,
      aaveCollateral,
      moonwellDebt,
      moonwellCollateral,
      cometDebt,
      cometCollateral,
      morphoDebt,
      morphoCollateral,
    };
  }

  async function expectExecutorDrained(f: any) {
    const executorAddr = await f.executor.getAddress();
    expect(await f.usdc.balanceOf(executorAddr)).to.equal(0n);
    expect(await f.weth.balanceOf(executorAddr)).to.equal(0n);
    expect(await f.aWeth.balanceOf(executorAddr)).to.equal(0n);
    expect(await f.mWeth.balanceOf(executorAddr)).to.equal(0n);
  }

  describe("full multi-protocol exit", function () {
    it("closes all four protocols in one tx and sweeps USDC to the user", async function () {
      const f = await loadFixture(deployFixture);
      const { user, usdc, executor, legs } = f;

      const usdcBefore = await usdc.balanceOf(user.address);
      const tx = await executor
        .connect(user)
        .atomicExit(
          [
            legs.aaveUsdcDebt,
            legs.aaveWethCollateral,
            legs.moonwellUsdcDebt,
            legs.moonwellWethCollateral,
            legs.comet,
            legs.morpho,
          ],
          []
        );
      await expect(tx)
        .to.emit(executor, "ExitCompleted")
        .withArgs(user.address, anyValue, anyValue, anyValue);

      // All debts closed on the mocks.
      expect(await f.mUsdc.borrowBalanceCurrent.staticCall(user.address)).to.equal(0n);
      expect(await f.comet.borrowBalanceOf(user.address)).to.equal(0n);
      const pos = await f.morpho.position(
        await f.morpho.marketId(f.marketParams),
        user.address
      );
      expect(pos.borrowShares).to.equal(0n);
      expect(pos.collateral).to.equal(0n);

      // Collateral gone from the user, USDC proceeds arrived.
      expect(await f.aWeth.balanceOf(user.address)).to.equal(0n);
      expect(await f.mWeth.balanceOf(user.address)).to.equal(0n);
      expect(await f.comet.collateralBalanceOf(user.address, await f.weth.getAddress())).to.equal(0n);

      // Net USDC: paid 100+30+40+20 debt, received swaps of
      // (1 + 2 + 0.5 + 0.7) WETH @ 2000 = 8400 USDC.
      const usdcAfter = await usdc.balanceOf(user.address);
      expect(usdcAfter - usdcBefore).to.equal(8_400n * WAD - 190n * WAD);

      await expectExecutorDrained(f);
    });

    it("emits LegClosed per protocol leg", async function () {
      const f = await loadFixture(deployFixture);
      const tx = await f.executor
        .connect(f.user)
        .atomicExit([f.legs.aaveWethCollateral, f.legs.moonwellWethCollateral, f.legs.comet], []);
      await expect(tx)
        .to.emit(f.executor, "LegClosed")
        .withArgs(f.user.address, AAVE, await f.weth.getAddress());
      await expect(tx)
        .to.emit(f.executor, "LegClosed")
        .withArgs(f.user.address, MOONWELL, await f.mWeth.getAddress());
      await expect(tx)
        .to.emit(f.executor, "LegClosed")
        .withArgs(f.user.address, COMET, await f.weth.getAddress());
    });
  });

  describe("individual (single-leg) exits", function () {
    it("moonwell-only exit", async function () {
      const f = await loadFixture(deployFixture);
      const before = await f.usdc.balanceOf(f.user.address);
      await f.executor
        .connect(f.user)
        .atomicExit([f.legs.moonwellUsdcDebt, f.legs.moonwellWethCollateral], []);
      // -30 debt + 2 WETH swapped @2000 = +4000.
      expect((await f.usdc.balanceOf(f.user.address)) - before).to.equal(3_970n * WAD);
      await expectExecutorDrained(f);
    });

    it("comet-only exit", async function () {
      const f = await loadFixture(deployFixture);
      const before = await f.usdc.balanceOf(f.user.address);
      await f.executor.connect(f.user).atomicExit([f.legs.comet], []);
      // -40 debt + 0.5 WETH @2000 = +1000.
      expect((await f.usdc.balanceOf(f.user.address)) - before).to.equal(960n * WAD);
      await expectExecutorDrained(f);
    });

    it("morpho-only exit (full close by shares)", async function () {
      const f = await loadFixture(deployFixture);
      const before = await f.usdc.balanceOf(f.user.address);
      await f.executor.connect(f.user).atomicExit([f.legs.morpho], []);
      const delta = (await f.usdc.balanceOf(f.user.address)) - before;
      // -~20 debt (share-rounding may add a wei) + 0.7 WETH @2000 = +1400.
      expect(delta).to.be.closeTo(1_380n * WAD, WAD / 1_000_000n);
      const pos = await f.morpho.position(
        await f.morpho.marketId(f.marketParams),
        f.user.address
      );
      expect(pos.borrowShares).to.equal(0n);
      await expectExecutorDrained(f);
    });
  });

  describe("partial (REDUCE) semantics", function () {
    it("aave partial repay leaves collateral untouched", async function () {
      const f = await loadFixture(deployFixture);
      const repay = 40n * WAD;
      const reduceLeg = leg(AAVE, await f.usdc.getAddress(), repay, 0n);
      const before = await f.usdc.balanceOf(f.user.address);
      await f.executor.connect(f.user).atomicExit([reduceLeg], []);
      expect(before - (await f.usdc.balanceOf(f.user.address))).to.equal(repay);
      // Collateral untouched.
      expect(await f.aWeth.balanceOf(f.user.address)).to.equal(f.aaveCollateral);
      const reserve = await f.dataProvider.getUserReserveData(
        await f.usdc.getAddress(),
        f.user.address
      );
      expect(reserve.currentVariableDebt).to.equal(f.aaveDebt - repay);
      await expectExecutorDrained(f);
    });

    it("comet partial repay caps at the requested amount", async function () {
      const f = await loadFixture(deployFixture);
      const partial = leg(
        COMET,
        ethers.ZeroAddress,
        15n * WAD,
        0n,
        abi.encode(["address"], [await f.comet.getAddress()])
      );
      await f.executor.connect(f.user).atomicExit([partial], []);
      expect(await f.comet.borrowBalanceOf(f.user.address)).to.equal(f.cometDebt - 15n * WAD);
      await expectExecutorDrained(f);
    });

    it("repay caps at actual debt when the requested amount exceeds it", async function () {
      const f = await loadFixture(deployFixture);
      const over = leg(MOONWELL, await f.mUsdc.getAddress(), 10_000n * WAD, 0n);
      const before = await f.usdc.balanceOf(f.user.address);
      await f.executor.connect(f.user).atomicExit([over], []);
      expect(before - (await f.usdc.balanceOf(f.user.address))).to.equal(f.moonwellDebt);
      await expectExecutorDrained(f);
    });
  });

  describe("reverts and guards", function () {
    it("rejects contract callers (onlyEOA)", async function () {
      const f = await loadFixture(deployFixture);
      await expect(
        f.proxy.callAtomicExit(await f.executor.getAddress(), [f.legs.comet])
      ).to.be.revertedWithCustomError(f.executor, "CallerNotEOA");
    });

    it("rejects an empty exit", async function () {
      const f = await loadFixture(deployFixture);
      await expect(f.executor.connect(f.user).atomicExit([], [])).to.be.revertedWithCustomError(
        f.executor,
        "EmptyExit"
      );
    });

    it("rejects duplicate (protocol, asset) legs", async function () {
      const f = await loadFixture(deployFixture);
      await expect(
        f.executor
          .connect(f.user)
          .atomicExit([f.legs.aaveUsdcDebt, f.legs.aaveUsdcDebt], [])
      ).to.be.revertedWithCustomError(f.executor, "DuplicateAsset");
    });

    it("allows the same asset on two different protocols", async function () {
      const f = await loadFixture(deployFixture);
      // WETH as Aave reserve AND Comet collateral in one exit.
      await expect(
        f.executor.connect(f.user).atomicExit([f.legs.aaveWethCollateral, f.legs.comet], [])
      ).to.not.be.reverted;
    });

    it("reverts when the user cannot fund the repay", async function () {
      const f = await loadFixture(deployFixture);
      const balance = await f.usdc.balanceOf(f.user.address);
      await f.usdc.burn(f.user.address, balance); // no USDC left
      await expect(
        f.executor.connect(f.user).atomicExit([f.legs.comet], [])
      ).to.be.revertedWithCustomError(f.executor, "InsufficientDebtAssetBalance");
    });

    it("reverts on locked comet legs (supply paused with debt)", async function () {
      const f = await loadFixture(deployFixture);
      await f.comet.setSupplyPaused(true);
      await expect(
        f.executor.connect(f.user).atomicExit([f.legs.comet], [])
      ).to.be.revertedWithCustomError(f.executor, "LockedPositions");
    });

    it("reverts on locked moonwell legs (no redeem cash)", async function () {
      const f = await loadFixture(deployFixture);
      // Drain the mWETH market's cash.
      const cash = await f.weth.balanceOf(await f.mWeth.getAddress());
      await f.weth.burn(await f.mWeth.getAddress(), cash);
      await expect(
        f.executor.connect(f.user).atomicExit([f.legs.moonwellWethCollateral], [])
      ).to.be.revertedWithCustomError(f.executor, "LockedPositions");
    });

    it("propagates an unhealthy morpho withdrawal revert", async function () {
      const f = await loadFixture(deployFixture);
      await f.morpho.setUnhealthy(f.user.address, true);
      const withdrawOnly = leg(MORPHO, await f.usdc.getAddress(), 0n, MAX, f.morphoData);
      await expect(
        f.executor.connect(f.user).atomicExit([withdrawOnly], [])
      ).to.be.revertedWith("MockMorpho: unhealthy");
    });

    it("reverts comet withdrawal without the user's allow()", async function () {
      const f = await loadFixture(deployFixture);
      await f.comet.connect(f.user).allow(await f.compoundAdapter.getAddress(), false);
      await expect(
        f.executor.connect(f.user).atomicExit([f.legs.comet], [])
      ).to.be.revertedWith("MockComet: not allowed");
    });

    it("reverts when an aave repay does not improve the health factor", async function () {
      const f = await loadFixture(deployFixture);
      await f.pool.setHealthFactorDeltaPerUnitRepaid(0n);
      await expect(
        f.executor.connect(f.user).atomicExit([f.legs.aaveUsdcDebt], [])
      ).to.be.revertedWithCustomError(f.aaveAdapter, "HealthFactorNotImproved");
    });

    it("reverts moonwell repay on a nonzero mToken error code", async function () {
      const f = await loadFixture(deployFixture);
      await f.mUsdc.setRepayError(3n);
      await expect(
        f.executor.connect(f.user).atomicExit([f.legs.moonwellUsdcDebt], [])
      ).to.be.revertedWithCustomError(f.moonwellAdapter, "MTokenError");
    });
  });

  describe("adapter access control", function () {
    it("only the executor may call adapter entrypoints", async function () {
      const f = await loadFixture(deployFixture);
      await expect(
        f.moonwellAdapter.connect(f.user).redeem(await f.mWeth.getAddress(), 1n)
      ).to.be.revertedWithCustomError(f.moonwellAdapter, "CallerNotExecutor");
      await expect(
        f.compoundAdapter
          .connect(f.user)
          .repayBase(await f.comet.getAddress(), f.user.address, 1n)
      ).to.be.revertedWithCustomError(f.compoundAdapter, "CallerNotExecutor");
      await expect(
        f.morphoAdapter.connect(f.user).repay(f.marketParams, f.user.address, 1n)
      ).to.be.revertedWithCustomError(f.morphoAdapter, "CallerNotExecutor");
    });

    it("only the manager may relink the executor", async function () {
      const f = await loadFixture(deployFixture);
      await expect(
        f.moonwellAdapter.connect(f.user).setExecutor(f.user.address)
      ).to.be.revertedWithCustomError(f.moonwellAdapter, "CallerNotManager");
    });
  });

  describe("lock pre-flight (getLockedLegs)", function () {
    it("reports locked legs without reverting", async function () {
      const f = await loadFixture(deployFixture);
      await f.comet.setSupplyPaused(true);
      const locked = await f.lockChecker.getLockedLegs(f.user.address, [
        f.legs.comet,
        f.legs.morpho,
      ]);
      expect(locked).to.deep.equal([await f.weth.getAddress()]);
    });

    it("morpho legs are never locked", async function () {
      const f = await loadFixture(deployFixture);
      const locked = await f.lockChecker.getLockedLegs(f.user.address, [f.legs.morpho]);
      expect(locked).to.deep.equal([]);
    });
  });
});
