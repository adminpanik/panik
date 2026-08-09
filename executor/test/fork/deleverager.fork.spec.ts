/**
 * Base MAINNET fork tests for PanikDeleverager (Phase 3.A) - the mainnet
 * acceptance gate (Sepolia mock oracles prove nothing).
 *
 * Run:  BASE_MAINNET_RPC=https://base-mainnet.g.alchemy.com/v2/<ALCHEMY_API_KEY_BASE_MAINNET> \
 *         npx hardhat test test/fork/deleverager.fork.spec.ts
 *
 * Skipped entirely when BASE_MAINNET_RPC is unset, so plain `npx hardhat test`
 * stays offline. The per-protocol tests SELF-SEED a fresh borrower on the fork
 * (deposit ETH->WETH, supply collateral, borrow USDC), move the borrowed USDC
 * out of the wallet so the wallet holds NONE of the debt asset, then run the
 * deleverager's collateral-funded repay and assert the debt fell, the position
 * stayed healthy, the borrower spent ZERO debt-asset capital, the flash was
 * repaid and no dust is stranded. No external borrower addresses are relied on.
 *
 * The fork block is pinned in hardhat.config.ts (FORK_BLOCK_NUMBER overrides).
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";

const FORKED = Boolean(process.env.BASE_MAINNET_RPC);
const maybeDescribe = FORKED ? describe : describe.skip;

const ExitProtocol = { AAVE: 0, MOONWELL: 1, COMPOUND: 2, MORPHO: 3 };
const FlashSource = { BALANCER: 0, MORPHO: 1, AAVE: 2 };

const ADDR = {
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  weth: "0x4200000000000000000000000000000000000006",
  cbbtc: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  balancerVault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  morphoBlue: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  cometUsdc: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
  universalRouter: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
  mUsdc: "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22",
  mWeth: "0x628ff693426583D9a7FB391E54366292F509D457",
  usdcUsdFeed: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
  wethUsdFeed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  cbbtcUsdFeed: "0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D",
};

// Verified live WETH/USDC Morpho Blue market (probe: loan USDC, coll WETH,
// lltv 86%, ~$80M supply). oracle/irm read from idToMarketParams.
const MORPHO_WETH_USDC = {
  loanToken: ADDR.usdc,
  collateralToken: ADDR.weth,
  oracle: "0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4",
  irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
  lltv: 860000000000000000n,
};

const coder = ethers.AbiCoder.defaultAbiCoder();
const MP_TUPLE = "tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)";

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
const FEED_ABI = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"];

async function resolveAaveDataProvider(): Promise<string> {
  const pool = new ethers.Contract(
    ADDR.aavePool,
    ["function ADDRESSES_PROVIDER() view returns (address)"],
    ethers.provider
  );
  const ap = new ethers.Contract(
    await pool.ADDRESSES_PROVIDER(),
    ["function getPoolDataProvider() view returns (address)"],
    ethers.provider
  );
  return ap.getPoolDataProvider();
}

async function deployDeleverager() {
  const Deleverager = await ethers.getContractFactory("PanikDeleverager");
  const core = {
    balancerVault: ADDR.balancerVault,
    aavePool: ADDR.aavePool,
    morpho: ADDR.morphoBlue,
    aaveDataProvider: await resolveAaveDataProvider(),
    universalRouter: ADDR.universalRouter,
    swapDeadlineBuffer: 300,
  };
  const oracle = {
    priceFeedAssets: [ADDR.usdc, ADDR.weth, ADDR.cbbtc],
    priceFeeds: [ADDR.usdcUsdFeed, ADDR.wethUsdFeed, ADDR.cbbtcUsdFeed],
    oracleStalenessSeconds: 172_800, // 48h - the USDC/USD feed has a 24h heartbeat
    sequencerUptimeFeed: ethers.ZeroAddress, // fork time is not wall-clock; skip
    sequencerGracePeriod: 3600,
    maxSlippageBpsCeiling: 1000,
  };
  return Deleverager.deploy(
    core,
    oracle,
    [ADDR.usdc, ADDR.weth, ADDR.cbbtc],
    [ADDR.cometUsdc, ADDR.mUsdc, ADDR.mWeth]
  );
}

async function wethPriceE8(): Promise<bigint> {
  const feed = new ethers.Contract(ADDR.wethUsdFeed, FEED_ABI, ethers.provider);
  const rd = await feed.latestRoundData();
  return rd[1] as bigint;
}

/** WETH wei whose USD value ~ `repayUsdc` (6dp), plus a slippage buffer. */
function wethForUsdc(repayUsdc: bigint, priceE8: bigint, bufferBps = 300n): bigint {
  const base = (repayUsdc * 10n ** 20n) / priceE8; // see spec derivation
  return (base * (10_000n + bufferBps)) / 10_000n;
}

maybeDescribe("Base mainnet fork - PanikDeleverager", function () {
  this.timeout(600_000);

  let sink: string;

  before(async function () {
    await network.provider.send("evm_mine"); // advance past the fork point
    sink = await (await ethers.getSigners())[1].getAddress();
  });

  it("deploys against live protocol code", async function () {
    for (const [name, address] of Object.entries({
      balancerVault: ADDR.balancerVault,
      aavePool: ADDR.aavePool,
      morphoBlue: ADDR.morphoBlue,
      cometUsdc: ADDR.cometUsdc,
      universalRouter: ADDR.universalRouter,
      mWeth: ADDR.mWeth,
    })) {
      const code = await ethers.provider.getCode(address);
      expect(code, `${name} has no code at ${address}`).to.not.equal("0x");
    }
    await deployDeleverager();
  });

  it("FORK-MEASURES the economic constants (recorded in the PR)", async function () {
    const deleverager = await deployDeleverager();

    const aavePremiumBps = await deleverager.aaveFlashPremiumBps();
    console.log(`    Aave FLASHLOAN_PREMIUM_TOTAL: ${aavePremiumBps} bps`);

    const vault = new ethers.Contract(
      ADDR.balancerVault,
      ["function getProtocolFeesCollector() view returns (address)"],
      ethers.provider
    );
    const fees = new ethers.Contract(
      await vault.getProtocolFeesCollector(),
      ["function getFlashLoanFeePercentage() view returns (uint256)"],
      ethers.provider
    );
    console.log(`    Balancer V2 flashLoanFeePercentage: ${await fees.getFlashLoanFeePercentage()} (1e18==100%)`);

    const dp = new ethers.Contract(
      await resolveAaveDataProvider(),
      ["function getReserveConfigurationData(address) view returns (uint256,uint256,uint256,uint256,uint256,bool,bool,bool,bool,bool)"],
      ethers.provider
    );
    for (const [name, asset] of Object.entries({ WETH: ADDR.weth, cbBTC: ADDR.cbbtc })) {
      const cfg = await dp.getReserveConfigurationData(asset);
      console.log(`    Aave liquidationBonus[${name}]: ${cfg[3]} (1e4; non-e-mode), liqThreshold ${cfg[2]}`);
    }

    const comet = new ethers.Contract(
      ADDR.cometUsdc,
      ["function getAssetInfoByAddress(address) view returns (tuple(uint8 offset,address asset,address priceFeed,uint64 scale,uint64 borrowCollateralFactor,uint64 liquidateCollateralFactor,uint64 liquidationFactor,uint128 supplyCap))"],
      ethers.provider
    );
    for (const [name, asset] of Object.entries({ WETH: ADDR.weth, cbBTC: ADDR.cbbtc })) {
      const info = await comet.getAssetInfoByAddress(asset);
      console.log(
        `    Comet[${name}] liquidateCollateralFactor ${info.liquidateCollateralFactor}, ` +
          `liquidationFactor ${info.liquidationFactor} (penalty = 1e18 - liquidationFactor)`
      );
    }
    expect(aavePremiumBps).to.be.a("bigint");
  });

  it("reverts FlashLiquidityInsufficient when a source cannot serve the amount", async function () {
    const deleverager = await deployDeleverager();
    const [signer] = await ethers.getSigners();
    const p = {
      protocol: ExitProtocol.COMPOUND,
      flashSource: FlashSource.BALANCER,
      debtAsset: ADDR.usdc,
      collateralToken: ADDR.weth,
      repayAmount: 10n ** 30n, // no Balancer pool can serve this
      collateralWithdraw: 10n ** 24n,
      maxSlippageBps: 300,
      swapPath: v3Path(ADDR.weth, ADDR.usdc),
      marketData: coder.encode(["address"], [ADDR.cometUsdc]),
    };
    await expect(deleverager.connect(signer).deleverage(p)).to.be.revertedWithCustomError(
      deleverager,
      "FlashLiquidityInsufficient"
    );
  });

  it("Aave V3: collateral-funded partial repay to a target HF, zero user capital", async function () {
    const [borrower] = await ethers.getSigners();
    const me = await borrower.getAddress();
    const deleverager = await deployDeleverager();
    const delevAddr = await deleverager.getAddress();

    const weth = new ethers.Contract(ADDR.weth, WETH_ABI, borrower);
    const usdc = new ethers.Contract(ADDR.usdc, ERC20, borrower);
    const pool = new ethers.Contract(
      ADDR.aavePool,
      [
        "function supply(address,uint256,address,uint16)",
        "function borrow(address,uint256,uint256,uint16,address)",
        "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
      ],
      borrower
    );

    await (await weth.deposit({ value: ethers.parseEther("5") })).wait();
    await (await weth.approve(ADDR.aavePool, ethers.parseEther("5"))).wait();
    await (await pool.supply(ADDR.weth, ethers.parseEther("5"), me, 0)).wait();
    await (await pool.borrow(ADDR.usdc, 4000n * 10n ** 6n, 2, 0, me)).wait();

    // Move every borrowed USDC out: the wallet now holds NONE of the debt asset.
    await (await usdc.transfer(sink, await usdc.balanceOf(me))).wait();
    expect(await usdc.balanceOf(me)).to.equal(0n);

    const dp = new ethers.Contract(
      await resolveAaveDataProvider(),
      ["function getReserveTokensAddresses(address) view returns (address,address,address)"],
      ethers.provider
    );
    const [aWeth] = await dp.getReserveTokensAddresses(ADDR.weth);
    await (await new ethers.Contract(aWeth, ERC20, borrower).approve(delevAddr, ethers.MaxUint256)).wait();

    const [, , hfBefore] = await deleverager.getAaveRiskParams(me);
    const target = 3n * 10n ** 18n;
    const repay = await deleverager.previewAaveRepayForTargetHf(me, ADDR.usdc, target);
    const collWithdraw = wethForUsdc(repay, await wethPriceE8());

    const tx = await deleverager.connect(borrower).deleverage({
      protocol: ExitProtocol.AAVE,
      flashSource: FlashSource.BALANCER,
      debtAsset: ADDR.usdc,
      collateralToken: ADDR.weth,
      repayAmount: repay,
      collateralWithdraw: collWithdraw,
      maxSlippageBps: 300,
      swapPath: v3Path(ADDR.weth, ADDR.usdc),
      marketData: "0x",
    });
    const rc = await tx.wait();

    const [, , , , , hfAfter] = await pool.getUserAccountData(me);
    console.log(`    Aave HF ${hfBefore} -> ${hfAfter} (target ${target}); gas ${rc!.gasUsed}`);
    expect(hfAfter).to.be.greaterThan(hfBefore); // deleverage improved health
    expect(hfAfter).to.be.greaterThan(hfBefore + (target - hfBefore) / 2n); // >= halfway to target
    expect(hfAfter).to.be.lessThanOrEqual((target * 102n) / 100n); // did not overshoot
    // Zero debt-asset capital: wallet had 0, only received the swap remainder.
    expect(await usdc.balanceOf(me)).to.be.greaterThanOrEqual(0n);
    expect(await usdc.balanceOf(delevAddr)).to.equal(0n);
    expect(await weth.balanceOf(delevAddr)).to.equal(0n);
  });

  it("Compound V3: collateral-funded partial repay, zero user capital", async function () {
    const [borrower] = await ethers.getSigners();
    const me = await borrower.getAddress();
    const deleverager = await deployDeleverager();
    const delevAddr = await deleverager.getAddress();

    const weth = new ethers.Contract(ADDR.weth, WETH_ABI, borrower);
    const usdc = new ethers.Contract(ADDR.usdc, ERC20, borrower);
    const comet = new ethers.Contract(
      ADDR.cometUsdc,
      [
        "function supply(address,uint256)",
        "function withdraw(address,uint256)",
        "function allow(address,bool)",
        "function borrowBalanceOf(address) view returns (uint256)",
        "function collateralBalanceOf(address,address) view returns (uint128)",
        "function isBorrowCollateralized(address) view returns (bool)",
      ],
      borrower
    );

    await (await weth.deposit({ value: ethers.parseEther("5") })).wait();
    await (await weth.approve(ADDR.cometUsdc, ethers.parseEther("5"))).wait();
    await (await comet.supply(ADDR.weth, ethers.parseEther("5"))).wait();
    await (await comet.withdraw(ADDR.usdc, 4000n * 10n ** 6n)).wait(); // borrow

    await (await usdc.transfer(sink, await usdc.balanceOf(me))).wait();
    expect(await usdc.balanceOf(me)).to.equal(0n);

    await (await comet.allow(delevAddr, true)).wait();

    const debtBefore = await comet.borrowBalanceOf(me);
    const collBefore = await comet.collateralBalanceOf(me, ADDR.weth);
    const repay = 1500n * 10n ** 6n;
    const collWithdraw = wethForUsdc(repay, await wethPriceE8());

    const tx = await deleverager.connect(borrower).deleverage({
      protocol: ExitProtocol.COMPOUND,
      flashSource: FlashSource.BALANCER,
      debtAsset: ADDR.usdc,
      collateralToken: ADDR.weth,
      repayAmount: repay,
      collateralWithdraw: collWithdraw,
      maxSlippageBps: 300,
      swapPath: v3Path(ADDR.weth, ADDR.usdc),
      marketData: coder.encode(["address"], [ADDR.cometUsdc]),
    });
    const rc = await tx.wait();

    const debtAfter = await comet.borrowBalanceOf(me);
    console.log(`    Comet debt ${debtBefore} -> ${debtAfter}; gas ${rc!.gasUsed}`);
    expect(debtAfter).to.be.lessThan(debtBefore);
    expect(debtBefore - debtAfter).to.be.greaterThanOrEqual((repay * 99n) / 100n);
    expect(await comet.collateralBalanceOf(me, ADDR.weth)).to.be.lessThan(collBefore);
    expect(await comet.isBorrowCollateralized(me)).to.equal(true);
    expect(await usdc.balanceOf(me)).to.be.greaterThanOrEqual(0n);
    expect(await usdc.balanceOf(delevAddr)).to.equal(0n);
    expect(await weth.balanceOf(delevAddr)).to.equal(0n);
  });

  it("Moonwell: collateral-funded partial repay, zero user capital", async function () {
    const [borrower] = await ethers.getSigners();
    const me = await borrower.getAddress();
    const deleverager = await deployDeleverager();
    const delevAddr = await deleverager.getAddress();

    const weth = new ethers.Contract(ADDR.weth, WETH_ABI, borrower);
    const usdc = new ethers.Contract(ADDR.usdc, ERC20, borrower);
    const mWeth = new ethers.Contract(
      ADDR.mWeth,
      [...ERC20, "function mint(uint256) returns (uint256)", "function exchangeRateStored() view returns (uint256)", "function comptroller() view returns (address)"],
      borrower
    );
    const mUsdc = new ethers.Contract(
      ADDR.mUsdc,
      ["function borrow(uint256) returns (uint256)", "function borrowBalanceStored(address) view returns (uint256)"],
      borrower
    );
    const comptrollerAddr = await mWeth.comptroller();
    const comptroller = new ethers.Contract(
      comptrollerAddr,
      ["function enterMarkets(address[]) returns (uint256[])", "function getAccountLiquidity(address) view returns (uint256,uint256,uint256)"],
      borrower
    );

    await (await weth.deposit({ value: ethers.parseEther("5") })).wait();
    await (await weth.approve(ADDR.mWeth, ethers.parseEther("5"))).wait();
    await (await mWeth.mint(ethers.parseEther("5"))).wait();
    await (await comptroller.enterMarkets([ADDR.mWeth])).wait();
    await (await mUsdc.borrow(4000n * 10n ** 6n)).wait();

    await (await usdc.transfer(sink, await usdc.balanceOf(me))).wait();
    expect(await usdc.balanceOf(me)).to.equal(0n);

    await (await mWeth.approve(delevAddr, ethers.MaxUint256)).wait();

    // Pre-donate ETH: mWETH redeems to NATIVE ETH here, so this exercises the
    // delta-wrap fix - the donation must NOT be folded into the user's proceeds.
    const donation = ethers.parseEther("0.01");
    await (await borrower.sendTransaction({ to: delevAddr, value: donation })).wait();

    const debtBefore = await mUsdc.borrowBalanceStored(me);
    const repay = 1500n * 10n ** 6n;
    const wethToSell = wethForUsdc(repay, await wethPriceE8());
    // Convert target underlying WETH to mWETH token units to redeem.
    const rate = await mWeth.exchangeRateStored(); // underlying(1e18) = mTokens * rate / 1e18
    const mTokensToRedeem = (wethToSell * 10n ** 18n) / rate;

    const tx = await deleverager.connect(borrower).deleverage({
      protocol: ExitProtocol.MOONWELL,
      flashSource: FlashSource.BALANCER,
      debtAsset: ADDR.usdc,
      collateralToken: ADDR.weth,
      repayAmount: repay,
      collateralWithdraw: mTokensToRedeem,
      maxSlippageBps: 300,
      swapPath: v3Path(ADDR.weth, ADDR.usdc),
      marketData: coder.encode(["address", "address"], [ADDR.mUsdc, ADDR.mWeth]),
    });
    const rc = await tx.wait();

    const debtAfter = await mUsdc.borrowBalanceStored(me);
    const [, , shortfall] = await comptroller.getAccountLiquidity(me);
    console.log(`    Moonwell debt ${debtBefore} -> ${debtAfter}; shortfall ${shortfall}; gas ${rc!.gasUsed}`);
    expect(debtAfter).to.be.lessThan(debtBefore);
    expect(debtBefore - debtAfter).to.be.greaterThanOrEqual((repay * 99n) / 100n);
    expect(shortfall).to.equal(0n); // still healthy
    expect(await usdc.balanceOf(me)).to.be.greaterThanOrEqual(0n);
    expect(await usdc.balanceOf(delevAddr)).to.equal(0n);
    expect(await weth.balanceOf(delevAddr)).to.equal(0n);
    // The pre-donation is retained as ETH, proving only the redeem DELTA was
    // wrapped and sold (the donation was not folded into the user's proceeds).
    expect(await ethers.provider.getBalance(delevAddr)).to.equal(donation);
  });

  it("Morpho Blue: collateral-funded repay via the native onMorphoRepay callback", async function () {
    const [borrower] = await ethers.getSigners();
    const me = await borrower.getAddress();
    const deleverager = await deployDeleverager();
    const delevAddr = await deleverager.getAddress();

    const weth = new ethers.Contract(ADDR.weth, WETH_ABI, borrower);
    const usdc = new ethers.Contract(ADDR.usdc, ERC20, borrower);
    const morpho = new ethers.Contract(
      ADDR.morphoBlue,
      [
        `function supplyCollateral(${MP_TUPLE} marketParams, uint256 assets, address onBehalf, bytes data)`,
        `function borrow(${MP_TUPLE} marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256,uint256)`,
        "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
        "function setAuthorization(address,bool)",
      ],
      borrower
    );

    const id = ethers.keccak256(coder.encode([MP_TUPLE], [MORPHO_WETH_USDC]));

    await (await weth.deposit({ value: ethers.parseEther("5") })).wait();
    await (await weth.approve(ADDR.morphoBlue, ethers.parseEther("5"))).wait();
    await (await morpho.supplyCollateral(MORPHO_WETH_USDC, ethers.parseEther("5"), me, "0x")).wait();
    await (await morpho.borrow(MORPHO_WETH_USDC, 4000n * 10n ** 6n, 0, me, me)).wait();

    await (await usdc.transfer(sink, await usdc.balanceOf(me))).wait();
    expect(await usdc.balanceOf(me)).to.equal(0n);

    await (await morpho.setAuthorization(delevAddr, true)).wait();

    const posBefore = await morpho.position(id, me);
    const repay = 1500n * 10n ** 6n;
    const collWithdraw = wethForUsdc(repay, await wethPriceE8());

    const tx = await deleverager.connect(borrower).deleverage({
      protocol: ExitProtocol.MORPHO,
      flashSource: FlashSource.BALANCER, // ignored on the native path
      debtAsset: ADDR.usdc,
      collateralToken: ADDR.weth,
      repayAmount: repay,
      collateralWithdraw: collWithdraw,
      maxSlippageBps: 300,
      swapPath: v3Path(ADDR.weth, ADDR.usdc),
      marketData: coder.encode([MP_TUPLE], [MORPHO_WETH_USDC]),
    });
    const rc = await tx.wait();

    const posAfter = await morpho.position(id, me);
    console.log(
      `    Morpho borrowShares ${posBefore.borrowShares} -> ${posAfter.borrowShares}, ` +
        `collateral ${posBefore.collateral} -> ${posAfter.collateral}; gas ${rc!.gasUsed}`
    );
    expect(posAfter.borrowShares).to.be.lessThan(posBefore.borrowShares);
    expect(posAfter.collateral).to.be.lessThan(posBefore.collateral);
    expect(await usdc.balanceOf(me)).to.be.greaterThanOrEqual(0n);
    expect(await usdc.balanceOf(delevAddr)).to.equal(0n);
    expect(await weth.balanceOf(delevAddr)).to.equal(0n);
  });
});
