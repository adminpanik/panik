import { expect } from "chai";
import { ethers } from "hardhat";

// ExitTypes.ProtocolId
const AAVE = 0;
const MOONWELL = 1;
const COMPOUND = 2;
const MORPHO = 3;
// FlashSource
const SRC_BALANCER = 0;
const SRC_MORPHO = 1;
const SRC_AAVE = 2;

const coder = ethers.AbiCoder.defaultAbiCoder();

function v3Path(tokenIn: string, tokenOut: string): string {
  return ethers.solidityPacked(["address", "uint24", "address"], [tokenIn, 500, tokenOut]);
}

function cometData(comet: string): string {
  return coder.encode(["address"], [comet]);
}

function morphoData(mp: {
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: bigint;
}): string {
  return coder.encode(
    ["tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)"],
    [mp]
  );
}

const UNIT6 = 10n ** 6n;
const UNIT18 = 10n ** 18n;
const P8 = 10n ** 8n; // 8-decimal price scale

describe("PanikDeleverager", function () {
  async function deployBase(opts: { sequencerFeed?: string } = {}) {
    const [deployer, user, stranger] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const debt = await MockERC20.deploy("USD Coin", "USDC", 6);
    const coll = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

    const MockChainlinkFeed = await ethers.getContractFactory("MockChainlinkFeed");
    const debtFeed = await MockChainlinkFeed.deploy(8, 1n * P8); // $1
    const collFeed = await MockChainlinkFeed.deploy(8, 2000n * P8); // $2000

    const MockUniversalRouter = await ethers.getContractFactory("MockUniversalRouter");
    const router = await MockUniversalRouter.deploy();
    // 1 coll (1e18) -> 2000 debt (2000e6). The mock is decimal-naive:
    // out = amountIn * rate / 1e18, so rate for coll = 2000e6.
    await router.setRateWad(await coll.getAddress(), 2000n * UNIT6);

    const MockBalancerVault = await ethers.getContractFactory("MockBalancerVault");
    const vault = await MockBalancerVault.deploy();

    const MockMorphoDeleverage = await ethers.getContractFactory("MockMorphoDeleverage");
    const morpho = await MockMorphoDeleverage.deploy();

    const MockComet = await ethers.getContractFactory("MockComet");
    const comet = await MockComet.deploy(await debt.getAddress());

    const MockAaveProtocolDataProvider = await ethers.getContractFactory(
      "MockAaveProtocolDataProvider"
    );
    const dataProvider = await MockAaveProtocolDataProvider.deploy();
    const MockAavePool = await ethers.getContractFactory("MockAavePool");
    const aavePool = await MockAavePool.deploy(await dataProvider.getAddress());

    const Deleverager = await ethers.getContractFactory("PanikDeleverager");
    const core = {
      balancerVault: await vault.getAddress(),
      aavePool: await aavePool.getAddress(),
      morpho: await morpho.getAddress(),
      aaveDataProvider: await dataProvider.getAddress(),
      universalRouter: await router.getAddress(),
      swapDeadlineBuffer: 300,
    };
    const oracle = {
      priceFeedAssets: [await debt.getAddress(), await coll.getAddress()],
      priceFeeds: [await debtFeed.getAddress(), await collFeed.getAddress()],
      oracleStalenessSeconds: 3600,
      sequencerUptimeFeed: opts.sequencerFeed ?? ethers.ZeroAddress,
      sequencerGracePeriod: 3600,
      maxSlippageBpsCeiling: 1000, // 10%
    };
    const deleverager = await Deleverager.deploy(
      core,
      oracle,
      [await debt.getAddress(), await coll.getAddress()],
      [await comet.getAddress()]
    );

    return {
      deployer, user, stranger,
      debt, coll, debtFeed, collFeed, router, vault, morpho, comet, dataProvider, aavePool,
      deleverager,
    };
  }

  // A well-formed Compound leg used as the "valid params" baseline for the
  // negative/guard tests, cloned and mutated per case.
  async function baseCompoundParams(f: Awaited<ReturnType<typeof deployBase>>) {
    return {
      protocol: COMPOUND,
      flashSource: SRC_BALANCER,
      debtAsset: await f.debt.getAddress(),
      collateralToken: await f.coll.getAddress(),
      repayAmount: 1500n * UNIT6,
      collateralWithdraw: 1n * UNIT18,
      maxSlippageBps: 500,
      swapPath: v3Path(await f.coll.getAddress(), await f.debt.getAddress()),
      marketData: cometData(await f.comet.getAddress()),
    };
  }

  describe("construction", function () {
    it("rejects a zero core address", async function () {
      const f = await deployBase();
      const Deleverager = await ethers.getContractFactory("PanikDeleverager");
      const core = {
        balancerVault: ethers.ZeroAddress,
        aavePool: await f.aavePool.getAddress(),
        morpho: await f.morpho.getAddress(),
        aaveDataProvider: await f.dataProvider.getAddress(),
        universalRouter: await f.router.getAddress(),
        swapDeadlineBuffer: 300,
      };
      const oracle = {
        priceFeedAssets: [],
        priceFeeds: [],
        oracleStalenessSeconds: 3600,
        sequencerUptimeFeed: ethers.ZeroAddress,
        sequencerGracePeriod: 3600,
        maxSlippageBpsCeiling: 1000,
      };
      await expect(Deleverager.deploy(core, oracle, [], [])).to.be.revertedWith(
        "Deleverager: zero balancer"
      );
    });

    it("rejects a zero staleness bound and an out-of-range slippage ceiling", async function () {
      const f = await deployBase();
      const Deleverager = await ethers.getContractFactory("PanikDeleverager");
      const core = {
        balancerVault: await f.vault.getAddress(),
        aavePool: await f.aavePool.getAddress(),
        morpho: await f.morpho.getAddress(),
        aaveDataProvider: await f.dataProvider.getAddress(),
        universalRouter: await f.router.getAddress(),
        swapDeadlineBuffer: 300,
      };
      const base = {
        priceFeedAssets: [],
        priceFeeds: [],
        sequencerUptimeFeed: ethers.ZeroAddress,
        sequencerGracePeriod: 3600,
      };
      await expect(
        Deleverager.deploy(core, { ...base, oracleStalenessSeconds: 0, maxSlippageBpsCeiling: 1000 }, [], [])
      ).to.be.revertedWith("Deleverager: zero staleness");
      await expect(
        Deleverager.deploy(core, { ...base, oracleStalenessSeconds: 3600, maxSlippageBpsCeiling: 0 }, [], [])
      ).to.be.revertedWith("Deleverager: invalid slippage ceiling");
      await expect(
        Deleverager.deploy(core, { ...base, oracleStalenessSeconds: 3600, maxSlippageBpsCeiling: 10000 }, [], [])
      ).to.be.revertedWith("Deleverager: invalid slippage ceiling");
    });

    it("exposes the allowlists and feeds it was built with", async function () {
      const f = await deployBase();
      expect(await f.deleverager.isTrackedAsset(await f.debt.getAddress())).to.equal(true);
      expect(await f.deleverager.isTrackedAsset(await f.coll.getAddress())).to.equal(true);
      expect(await f.deleverager.isAllowedMarket(await f.comet.getAddress())).to.equal(true);
      const [feed, dec] = await f.deleverager.getPriceFeed(await f.debt.getAddress());
      expect(feed).to.equal(await f.debtFeed.getAddress());
      expect(dec).to.equal(8);
    });
  });

  describe("input validation", function () {
    it("rejects zero amounts, bad slippage and empty path", async function () {
      const f = await deployBase();
      const p = await baseCompoundParams(f);
      await expect(f.deleverager.connect(f.user).deleverage({ ...p, repayAmount: 0 }))
        .to.be.revertedWithCustomError(f.deleverager, "ZeroAmount");
      await expect(f.deleverager.connect(f.user).deleverage({ ...p, collateralWithdraw: 0 }))
        .to.be.revertedWithCustomError(f.deleverager, "ZeroAmount");
      await expect(f.deleverager.connect(f.user).deleverage({ ...p, maxSlippageBps: 0 }))
        .to.be.revertedWithCustomError(f.deleverager, "InvalidSlippage");
      await expect(f.deleverager.connect(f.user).deleverage({ ...p, maxSlippageBps: 2000 }))
        .to.be.revertedWithCustomError(f.deleverager, "InvalidSlippage");
      await expect(f.deleverager.connect(f.user).deleverage({ ...p, swapPath: "0x" }))
        .to.be.revertedWithCustomError(f.deleverager, "EmptySwapPath");
    });

    it("rejects an invalid protocol and flash source", async function () {
      const f = await deployBase();
      const p = await baseCompoundParams(f);
      await expect(f.deleverager.connect(f.user).deleverage({ ...p, protocol: 5 }))
        .to.be.revertedWithCustomError(f.deleverager, "InvalidProtocol");
      await expect(f.deleverager.connect(f.user).deleverage({ ...p, flashSource: 3 }))
        .to.be.revertedWithCustomError(f.deleverager, "InvalidFlashSource");
    });

    it("rejects untracked assets and disallowed markets", async function () {
      const f = await deployBase();
      const p = await baseCompoundParams(f);
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const rogue = await MockERC20.deploy("Rogue", "RGE", 18);
      await expect(
        f.deleverager.connect(f.user).deleverage({ ...p, debtAsset: await rogue.getAddress() })
      ).to.be.revertedWithCustomError(f.deleverager, "AssetNotTracked");
      await expect(
        f.deleverager.connect(f.user).deleverage({ ...p, collateralToken: await rogue.getAddress() })
      ).to.be.revertedWithCustomError(f.deleverager, "AssetNotTracked");
      await expect(
        f.deleverager.connect(f.user).deleverage({ ...p, marketData: cometData(await rogue.getAddress()) })
      ).to.be.revertedWithCustomError(f.deleverager, "MarketNotAllowed");
    });

    it("rejects a Morpho leg whose market tokens disagree with the leg tokens", async function () {
      const f = await deployBase();
      const mp = {
        loanToken: await f.coll.getAddress(), // wrong: not the debt asset
        collateralToken: await f.coll.getAddress(),
        oracle: ethers.ZeroAddress,
        irm: ethers.ZeroAddress,
        lltv: 860000000000000000n,
      };
      const p = {
        protocol: MORPHO,
        flashSource: SRC_BALANCER,
        debtAsset: await f.debt.getAddress(),
        collateralToken: await f.coll.getAddress(),
        repayAmount: 1500n * UNIT6,
        collateralWithdraw: 1n * UNIT18,
        maxSlippageBps: 500,
        swapPath: v3Path(await f.coll.getAddress(), await f.debt.getAddress()),
        marketData: morphoData(mp),
      };
      await expect(f.deleverager.connect(f.user).deleverage(p)).to.be.revertedWithCustomError(
        f.deleverager,
        "TokenMarketMismatch"
      );
    });
  });

  describe("flash-liquidity guard", function () {
    it("reverts with FlashLiquidityInsufficient when Balancer cannot serve", async function () {
      const f = await deployBase();
      const p = await baseCompoundParams(f); // vault holds 0 debt
      await expect(f.deleverager.connect(f.user).deleverage(p))
        .to.be.revertedWithCustomError(f.deleverager, "FlashLiquidityInsufficient")
        .withArgs(SRC_BALANCER, await f.debt.getAddress(), 1500n * UNIT6, 0n);
    });

    it("reverts with FlashLiquidityInsufficient when the Morpho singleton cannot serve", async function () {
      const f = await deployBase();
      const p = await baseCompoundParams(f);
      await expect(f.deleverager.connect(f.user).deleverage({ ...p, flashSource: SRC_MORPHO }))
        .to.be.revertedWithCustomError(f.deleverager, "FlashLiquidityInsufficient")
        .withArgs(SRC_MORPHO, await f.debt.getAddress(), 1500n * UNIT6, 0n);
    });
  });

  describe("callback authentication", function () {
    it("rejects every flash/native callback called out of band", async function () {
      const f = await deployBase();
      const d = f.deleverager.connect(f.stranger);
      const debtAddr = await f.debt.getAddress();
      await expect(d.receiveFlashLoan([debtAddr], [1n], [0n], "0x"))
        .to.be.revertedWithCustomError(f.deleverager, "UnauthorizedFlashCallback");
      await expect(d.executeOperation(debtAddr, 1n, 0n, await f.deleverager.getAddress(), "0x"))
        .to.be.revertedWithCustomError(f.deleverager, "UnauthorizedFlashCallback");
      await expect(d.onMorphoFlashLoan(1n, "0x"))
        .to.be.revertedWithCustomError(f.deleverager, "UnauthorizedFlashCallback");
      await expect(d.onMorphoRepay(1n, "0x"))
        .to.be.revertedWithCustomError(f.deleverager, "UnauthorizedFlashCallback");
    });
  });

  describe("sequencer fail-closed", function () {
    it("reverts SequencerDown and grace-period when the L2 sequencer feed says so", async function () {
      const MockChainlinkFeed = await ethers.getContractFactory("MockChainlinkFeed");
      const seq = await MockChainlinkFeed.deploy(0, 1n); // answer 1 == down
      const f = await deployBase({ sequencerFeed: await seq.getAddress() });
      const p = await baseCompoundParams(f);
      await expect(f.deleverager.connect(f.user).deleverage(p)).to.be.revertedWithCustomError(
        f.deleverager,
        "SequencerDown"
      );

      const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      await seq.setAnswerAt(0, now, now); // up, but just restarted -> within grace
      await expect(f.deleverager.connect(f.user).deleverage(p)).to.be.revertedWithCustomError(
        f.deleverager,
        "SequencerGracePeriodNotOver"
      );
    });
  });

  describe("Compound V3 collateral-funded deleverage via Balancer flash", function () {
    it("repays debt from collateral, spends no user capital, returns the remainder", async function () {
      const f = await deployBase();
      const userAddr = await f.user.getAddress();
      const delevAddr = await f.deleverager.getAddress();

      // Position: 5000 USDC borrowed against 3 WETH collateral in Comet.
      await f.comet.setBorrowBalance(userAddr, 5000n * UNIT6);
      await f.comet.setCollateral(userAddr, await f.coll.getAddress(), 3n * UNIT18);
      await f.coll.mint(await f.comet.getAddress(), 3n * UNIT18); // comet custodies collateral
      await f.comet.connect(f.user).allow(delevAddr, true);

      // Fund the flash vault and the swap router with the debt asset.
      await f.debt.mint(await f.vault.getAddress(), 10_000n * UNIT6);
      await f.debt.mint(await f.router.getAddress(), 10_000n * UNIT6);

      const userDebtBefore = await f.debt.balanceOf(userAddr);
      const p = await baseCompoundParams(f);
      await f.deleverager.connect(f.user).deleverage(p);

      // Debt reduced by exactly the repay amount.
      expect(await f.comet.borrowBalanceOf(userAddr)).to.equal(3500n * UNIT6);
      // 1 WETH of collateral was freed and sold.
      expect(await f.comet.collateralBalanceOf(userAddr, await f.coll.getAddress())).to.equal(2n * UNIT18);
      // User spent no debt-asset capital; they only RECEIVED the swap remainder
      // (2000 sold - 1500 repaid = 500 USDC).
      expect(await f.debt.balanceOf(userAddr)).to.equal(userDebtBefore + 500n * UNIT6);
      // Nothing is stranded on the deleverager.
      expect(await f.debt.balanceOf(delevAddr)).to.equal(0n);
      expect(await f.coll.balanceOf(delevAddr)).to.equal(0n);
    });

    it("routes the same flow through the Morpho singleton as the fallback source", async function () {
      const f = await deployBase();
      const userAddr = await f.user.getAddress();
      await f.comet.setBorrowBalance(userAddr, 5000n * UNIT6);
      await f.comet.setCollateral(userAddr, await f.coll.getAddress(), 3n * UNIT18);
      await f.coll.mint(await f.comet.getAddress(), 3n * UNIT18);
      await f.comet.connect(f.user).allow(await f.deleverager.getAddress(), true);
      await f.debt.mint(await f.morpho.getAddress(), 10_000n * UNIT6); // morpho is the flash source
      await f.debt.mint(await f.router.getAddress(), 10_000n * UNIT6);

      const p = { ...(await baseCompoundParams(f)), flashSource: SRC_MORPHO };
      await f.deleverager.connect(f.user).deleverage(p);
      expect(await f.comet.borrowBalanceOf(userAddr)).to.equal(3500n * UNIT6);
    });
  });

  describe("Morpho Blue collateral-funded deleverage via the native repay callback", function () {
    it("frees collateral inside onMorphoRepay and repays without external flash", async function () {
      const f = await deployBase();
      const userAddr = await f.user.getAddress();
      const delevAddr = await f.deleverager.getAddress();

      const mp = {
        loanToken: await f.debt.getAddress(),
        collateralToken: await f.coll.getAddress(),
        oracle: ethers.ZeroAddress,
        irm: ethers.ZeroAddress,
        lltv: 860000000000000000n,
      };
      await f.morpho.setPosition(mp, userAddr, 5000n * UNIT6, 3n * UNIT18);
      await f.coll.mint(await f.morpho.getAddress(), 3n * UNIT18);
      await f.morpho.connect(f.user).setAuthorization(delevAddr, true);
      await f.debt.mint(await f.router.getAddress(), 10_000n * UNIT6);

      const userDebtBefore = await f.debt.balanceOf(userAddr);
      const p = {
        protocol: MORPHO,
        flashSource: SRC_BALANCER, // ignored
        debtAsset: await f.debt.getAddress(),
        collateralToken: await f.coll.getAddress(),
        repayAmount: 1500n * UNIT6,
        collateralWithdraw: 1n * UNIT18,
        maxSlippageBps: 500,
        swapPath: v3Path(await f.coll.getAddress(), await f.debt.getAddress()),
        marketData: morphoData(mp),
      };
      await f.deleverager.connect(f.user).deleverage(p);

      const id = await f.morpho.marketId(mp);
      expect(await f.morpho.debtOf(id, userAddr)).to.equal(3500n * UNIT6);
      expect(await f.morpho.collateralOf(id, userAddr)).to.equal(2n * UNIT18);
      expect(await f.debt.balanceOf(userAddr)).to.equal(userDebtBefore + 500n * UNIT6);
      expect(await f.debt.balanceOf(delevAddr)).to.equal(0n);
    });
  });

  describe("Aave V3 collateral-funded deleverage via Balancer flash", function () {
    async function setupAave(f: Awaited<ReturnType<typeof deployBase>>, hfDelta: bigint) {
      const userAddr = await f.user.getAddress();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const aToken = await MockERC20.deploy("aWETH", "aWETH", 18);
      await f.dataProvider.setReserveTokens(
        await f.coll.getAddress(),
        await aToken.getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress
      );
      // User holds aTokens and approves the deleverager to pull them.
      await aToken.mint(userAddr, 1n * UNIT18);
      await aToken.connect(f.user).approve(await f.deleverager.getAddress(), ethers.MaxUint256);
      // Pool custodies the underlying it will hand back on withdraw.
      await f.coll.mint(await f.aavePool.getAddress(), 1n * UNIT18);

      await f.aavePool.setUserAccountData(userAddr, {
        totalCollateralBase: 10000n * P8,
        totalDebtBase: 5000n * P8,
        availableBorrowsBase: 0n,
        currentLiquidationThreshold: 8000n,
        ltv: 7000n,
        healthFactor: 12n * 10n ** 17n, // 1.2
      });
      await f.aavePool.setHealthFactorDeltaPerUnitRepaid(hfDelta);

      await f.debt.mint(await f.vault.getAddress(), 10_000n * UNIT6);
      await f.debt.mint(await f.router.getAddress(), 10_000n * UNIT6);
      return { aToken };
    }

    it("improves the health factor and returns the swap remainder", async function () {
      const f = await deployBase();
      await setupAave(f, 1n);
      const userAddr = await f.user.getAddress();
      const [, , hfBefore] = await f.deleverager.getAaveRiskParams(userAddr);

      const p = {
        protocol: AAVE,
        flashSource: SRC_BALANCER,
        debtAsset: await f.debt.getAddress(),
        collateralToken: await f.coll.getAddress(),
        repayAmount: 1500n * UNIT6,
        collateralWithdraw: 1n * UNIT18,
        maxSlippageBps: 500,
        swapPath: v3Path(await f.coll.getAddress(), await f.debt.getAddress()),
        marketData: "0x",
      };
      const userDebtBefore = await f.debt.balanceOf(userAddr);
      await f.deleverager.connect(f.user).deleverage(p);

      const [, , hfAfter] = await f.deleverager.getAaveRiskParams(userAddr);
      expect(hfAfter).to.be.greaterThan(hfBefore);
      expect(await f.debt.balanceOf(userAddr)).to.equal(userDebtBefore + 500n * UNIT6);
    });

    it("reverts HealthNotImproved when the repay does not raise the health factor", async function () {
      const f = await deployBase();
      await setupAave(f, 0n); // repay changes nothing -> HF flat
      const p = {
        protocol: AAVE,
        flashSource: SRC_BALANCER,
        debtAsset: await f.debt.getAddress(),
        collateralToken: await f.coll.getAddress(),
        repayAmount: 1500n * UNIT6,
        collateralWithdraw: 1n * UNIT18,
        maxSlippageBps: 500,
        swapPath: v3Path(await f.coll.getAddress(), await f.debt.getAddress()),
        marketData: "0x",
      };
      await expect(f.deleverager.connect(f.user).deleverage(p)).to.be.revertedWithCustomError(
        f.deleverager,
        "HealthNotImproved"
      );
    });
  });

  describe("Moonwell collateral-funded deleverage (exchange-rate-correct swap)", function () {
    it("sells the redeemed underlying, not the mToken count", async function () {
      const f = await deployBase();
      const userAddr = await f.user.getAddress();
      const delevAddr = await f.deleverager.getAddress();

      const MockComptroller = await ethers.getContractFactory("MockComptroller");
      const comptroller = await MockComptroller.deploy();
      await comptroller.setAccountLiquidity(userAddr, 0, 0); // no shortfall

      const MockMTokenRate = await ethers.getContractFactory("MockMTokenRate");
      // Debt market (mUSDC). Collateral market (mWETH) redeems at 1 mToken ->
      // 0.02 WETH, i.e. 50 mWETH -> 1 WETH (the real Moonwell ballpark).
      const mUsdc = await MockMTokenRate.deploy(
        "mUSDC", "mUSDC", await f.debt.getAddress(), await comptroller.getAddress(), UNIT18
      );
      const mWeth = await MockMTokenRate.deploy(
        "mWETH", "mWETH", await f.coll.getAddress(), await comptroller.getAddress(), 2n * 10n ** 16n
      );

      // Redeploy a deleverager that allowlists the two mToken markets.
      const Deleverager = await ethers.getContractFactory("PanikDeleverager");
      const deleverager = await Deleverager.deploy(
        {
          balancerVault: await f.vault.getAddress(),
          aavePool: await f.aavePool.getAddress(),
          morpho: await f.morpho.getAddress(),
          aaveDataProvider: await f.dataProvider.getAddress(),
          universalRouter: await f.router.getAddress(),
          swapDeadlineBuffer: 300,
        },
        {
          priceFeedAssets: [await f.debt.getAddress(), await f.coll.getAddress()],
          priceFeeds: [await f.debtFeed.getAddress(), await f.collFeed.getAddress()],
          oracleStalenessSeconds: 3600,
          sequencerUptimeFeed: ethers.ZeroAddress,
          sequencerGracePeriod: 3600,
          maxSlippageBpsCeiling: 1000,
        },
        [await f.debt.getAddress(), await f.coll.getAddress()],
        [await mUsdc.getAddress(), await mWeth.getAddress()]
      );

      // Position: 5000 USDC borrowed; user holds 50 mWETH (== 1 WETH of collateral).
      await mUsdc.setBorrowBalance(userAddr, 5000n * UNIT6);
      await mWeth.mint(userAddr, 50n * UNIT18);
      await f.coll.mint(await mWeth.getAddress(), 1n * UNIT18); // redeem liquidity
      await mWeth.connect(f.user).approve(await deleverager.getAddress(), ethers.MaxUint256);

      await f.debt.mint(await f.vault.getAddress(), 10_000n * UNIT6);
      await f.debt.mint(await f.router.getAddress(), 10_000n * UNIT6);

      const userDebtBefore = await f.debt.balanceOf(userAddr);
      const p = {
        protocol: MOONWELL,
        flashSource: SRC_BALANCER,
        debtAsset: await f.debt.getAddress(),
        collateralToken: await f.coll.getAddress(),
        repayAmount: 1500n * UNIT6,
        collateralWithdraw: 50n * UNIT18, // mTokens -> redeems to 1 WETH
        maxSlippageBps: 500,
        swapPath: v3Path(await f.coll.getAddress(), await f.debt.getAddress()),
        marketData: coder.encode(["address", "address"], [await mUsdc.getAddress(), await mWeth.getAddress()]),
      };
      await deleverager.connect(f.user).deleverage(p);

      // Debt down 1500; the 1 redeemed WETH sold for 2000 USDC; 500 back to user.
      expect(await mUsdc.borrowBalanceCurrent(userAddr)).to.equal(3500n * UNIT6);
      expect(await f.debt.balanceOf(userAddr)).to.equal(userDebtBefore + 500n * UNIT6);
      expect(await f.debt.balanceOf(await deleverager.getAddress())).to.equal(0n);
      expect(await f.coll.balanceOf(await deleverager.getAddress())).to.equal(0n);
    });
  });

  describe("target-HF sizing (advisory view)", function () {
    it("prices repay = D*(T-HF)/(T-WLT) into debt-asset units from live Aave data", async function () {
      const f = await deployBase();
      const userAddr = await f.user.getAddress();
      await f.aavePool.setUserAccountData(userAddr, {
        totalCollateralBase: 20000n * P8,
        totalDebtBase: 10000n * P8,
        availableBorrowsBase: 0n,
        currentLiquidationThreshold: 8000n, // 0.8 WLT
        ltv: 7000n,
        healthFactor: 15n * 10n ** 17n, // 1.5
      });
      // target 2.0: repayBase = 1e12 * (2.0-1.5)/(2.0-0.8) = 416666666666 (8dp),
      // /price($1,8dp) * 1e6 = 4166666666 (6dp USDC).
      const repay = await f.deleverager.previewAaveRepayForTargetHf(
        userAddr,
        await f.debt.getAddress(),
        2n * UNIT18
      );
      expect(repay).to.equal(4166666666n);
    });

    it("refuses a target that is not an improvement", async function () {
      const f = await deployBase();
      const userAddr = await f.user.getAddress();
      await f.aavePool.setUserAccountData(userAddr, {
        totalCollateralBase: 20000n * P8,
        totalDebtBase: 10000n * P8,
        availableBorrowsBase: 0n,
        currentLiquidationThreshold: 8000n,
        ltv: 7000n,
        healthFactor: 15n * 10n ** 17n,
      });
      await expect(
        f.deleverager.previewAaveRepayForTargetHf(userAddr, await f.debt.getAddress(), 12n * 10n ** 17n)
      ).to.be.revertedWithCustomError(f.deleverager, "TargetNotAnImprovement");
    });
  });
});
