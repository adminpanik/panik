// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IChainlinkFeed} from "./interfaces/IChainlinkFeed.sol";
import {IComet} from "./interfaces/IComet.sol";
import {IMToken} from "./interfaces/IMToken.sol";
import {IComptroller} from "./interfaces/IComptroller.sol";
import {IMorpho} from "./interfaces/IMorpho.sol";
import {IUniversalRouter} from "./interfaces/IUniversalRouter.sol";
import {IAaveProtocolDataProvider} from "./interfaces/IAaveProtocolDataProvider.sol";
import {ExitTypes} from "./libraries/ExitTypes.sol";
import {
    IBalancerVault,
    IBalancerFlashLoanRecipient,
    IAaveFlashPool,
    IFlashLoanSimpleReceiver,
    IMorphoFlash,
    IMorphoFlashLoanCallback
} from "./interfaces/IFlashProviders.sol";
import {IMorphoRepayCallback, ICometAssetInfo, IComptrollerMarkets} from "./interfaces/IProtocolExtras.sol";

/// @title PanikDeleverager
/// @notice Collateral-funded deleverage (Phase 3.A). A borrower reduces their
/// debt on Aave V3, Moonwell, Compound V3 or Morpho Blue using the position's
/// OWN collateral and NO fresh capital, in a single atomic transaction.
///
/// The naive order (withdraw collateral -> sell -> repay) fails: withdrawing
/// first drops the health factor and the protocol reverts. The debt asset must
/// therefore be obtained BEFORE the collateral is freed:
///   Aave / Moonwell / Compound  - external flash loan funds the repay, the
///     freed collateral is sold to repay the flash (+ fee) inside the callback.
///   Morpho Blue                 - the NATIVE onMorphoRepay callback fires
///     BEFORE Morpho pulls repayment, so the collateral is freed and sold
///     inside it with no external flash, no flash fee and no flash-liquidity
///     dependency.
///
/// ARCHITECTURE (option b of the Phase 3.A steer). This is a SEPARATE contract
/// that talks to the protocols DIRECTLY (repay + withdraw only) and swaps
/// through the UniversalRouter directly. It deliberately does NOT reuse the v2
/// executor's adapters: those are `onlyExecutor`-bound to the deployed executor
/// v2 (0x554530E0...42E4), and rebinding or cloning them would either touch v2's
/// frozen audit scope or add six stateful clones to this one. Direct calls give
/// the tightest possible surface - repay and withdrawCollateral are the only
/// lending entrypoints this contract needs, and they are bounded entirely by the
/// user's OWN on-chain debt and collateral. v2 is not referenced anywhere here.
///
/// SAFETY MODEL (audit scope - every external-call surface is enumerated in the
/// PR's AUDIT NOTES):
///   - No admin, no owner, no upgradeability. Every protocol address and every
///     risk parameter is immutable, set once at construction. Same philosophy as
///     v2: an admin-upgradeable deleverager is a rug vector.
///   - No delegated path. `msg.sender` is ALWAYS the position owner AND the sole
///     payout destination; there is no recipient parameter anywhere. Funds moved
///     are the owner's own, freed under the owner's own per-protocol grants
///     (aToken approve / mToken approve / comet.allow / morpho.setAuthorization)
///     and bounded by the owner's live debt/collateral.
///   - The entrypoint is `nonReentrant`. The flash callbacks are authenticated
///     three ways: caller == the expected immutable provider, a flash IS in
///     progress (`_flashActive`), and the initiator/user encoded in the payload
///     equals the stored `_activeUser`. An out-of-band callback reverts.
///   - The collateral->debt swap is floored by an oracle-derived minimum with a
///     staleness bound and an L2 sequencer-uptime check; a stale or lagging feed
///     fails CLOSED and legibly (StalePrice / SequencerDown), never silently.
///   - A chosen flash source that cannot serve the amount reverts with the named
///     FlashLiquidityInsufficient, never an opaque provider revert.
///   - Assets and markets are validated against an immutable allowlist exactly
///     as v2 does (tracked assets + delegated markets).
///   - After the debt is reduced the live health is re-read and asserted to have
///     IMPROVED (Aave HF up / Moonwell shortfall not up / Comet collateralized);
///     Morpho reverts an unhealthy withdrawal itself. A mis-sized withdrawal that
///     would leave the user worse off reverts the whole transaction.
contract PanikDeleverager is
    ReentrancyGuard,
    IBalancerFlashLoanRecipient,
    IFlashLoanSimpleReceiver,
    IMorphoFlashLoanCallback,
    IMorphoRepayCallback
{
    using SafeERC20 for IERC20;

    // --- errors ---
    error ZeroAmount();
    error InvalidProtocol(uint8 protocol);
    error InvalidFlashSource(uint8 source);
    error InvalidSlippage(uint16 maxSlippageBps, uint16 ceiling);
    error EmptySwapPath();
    error AssetNotTracked(address asset);
    error MarketNotAllowed(address market);
    error TokenMarketMismatch(address expected, address actual);
    error FlashLiquidityInsufficient(uint8 source, address asset, uint256 requested, uint256 available);
    error UnauthorizedFlashCallback(address caller);
    error UnauthorizedFlashInitiator(address initiator);
    error NoFlashInProgress();
    error FlashParamsMismatch();
    error InsufficientSwapProceeds(address asset, uint256 required, uint256 available);
    error SwapSlippage(address tokenOut, uint256 minOut, uint256 received);
    error MissingPriceFeed(address asset);
    error PriceUnavailable(address asset);
    error StalePrice(address asset, uint256 updatedAt, uint256 currentTimestamp);
    error SequencerDown(int256 answer);
    error SequencerGracePeriodNotOver(uint256 startedAt, uint256 readyAt);
    error InvalidOracleDecimals(uint8 decimals);
    error MissingAToken(address asset);
    error HealthNotImproved();
    error MTokenError(address mToken, uint256 errorCode);
    error NotCollateralized(address comet, address user);
    error TargetNotAnImprovement(uint256 currentHf, uint256 targetHf);
    error TargetBelowLiquidationThreshold(uint256 targetHf, uint256 wltWad);

    // --- events ---
    event Deleveraged(
        address indexed user,
        ExitTypes.ProtocolId indexed protocol,
        address debtAsset,
        address collateralToken,
        uint256 repaid,
        uint256 collateralSold,
        uint256 debtAssetReturned
    );

    /// @notice External flash-liquidity source for the non-Morpho protocols.
    enum FlashSource {
        BALANCER, // 0% fee, primary
        MORPHO, // 0% fee, fallback (singleton flashLoan)
        AAVE // FLASHLOAN_PREMIUM_TOTAL bps, last resort
    }

    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant WAD = 1e18;
    uint8 private constant PRICE_DECIMALS = 8;
    uint256 private constant AAVE_VARIABLE_RATE = 2;

    // --- immutable config ---
    IBalancerVault public immutable balancerVault;
    IAaveFlashPool public immutable aavePool;
    IMorpho public immutable morpho;
    IAaveProtocolDataProvider public immutable aaveDataProvider;
    IUniversalRouter public immutable universalRouter;
    uint256 public immutable swapDeadlineBuffer;

    uint256 public immutable oracleStalenessSeconds;
    address public immutable sequencerUptimeFeed;
    uint256 public immutable sequencerGracePeriod;
    uint16 public immutable maxSlippageBpsCeiling;

    // --- allowlists / feeds (immutable after construction) ---
    mapping(address asset => bool) private _trackedAsset;
    address[] private _trackedAssets;
    mapping(address market => bool) private _allowedMarket;
    address[] private _allowedMarkets;
    mapping(address asset => address feed) private _priceFeed;
    mapping(address asset => uint8 decimals) private _priceFeedDecimals;

    // --- transient flash state (regular storage; paris target has no tstore) ---
    // Set before the flash/native-repay call and cleared after. Because a revert
    // rolls storage back, these can never persist across transactions.
    bool private _flashActive;
    address private _activeUser;

    /// @notice Everything a deleverage needs. `msg.sender` is the position owner
    /// and payout destination; there is no user or recipient field here.
    /// @dev marketData decoding per protocol:
    ///  AAVE_V3     - empty. debtAsset/collateralToken are Aave reserves.
    ///  MOONWELL    - abi.encode(address debtMToken, address collateralMToken).
    ///  COMPOUND_V3 - abi.encode(address comet).
    ///  MORPHO_BLUE - abi.encode(IMorpho.MarketParams); flashSource is ignored.
    /// swapPath is a UniversalRouter V3 path from collateralToken to debtAsset.
    struct DeleverageParams {
        uint8 protocol; // ExitTypes.ProtocolId
        uint8 flashSource; // FlashSource (ignored for MORPHO_BLUE)
        address debtAsset;
        address collateralToken;
        uint256 repayAmount; // debt-asset units to repay (> 0)
        uint256 collateralWithdraw; // collateral units to free and sell (> 0)
        uint16 maxSlippageBps;
        bytes swapPath;
        bytes marketData;
    }

    struct CoreConfig {
        address balancerVault;
        address aavePool;
        address morpho;
        address aaveDataProvider;
        address universalRouter;
        uint256 swapDeadlineBuffer;
    }

    struct OracleConfig {
        address[] priceFeedAssets;
        address[] priceFeeds;
        uint256 oracleStalenessSeconds;
        address sequencerUptimeFeed;
        uint256 sequencerGracePeriod;
        uint16 maxSlippageBpsCeiling;
    }

    constructor(
        CoreConfig memory core,
        OracleConfig memory oracle,
        address[] memory trackedAssets_,
        address[] memory allowedMarkets_
    ) {
        require(core.balancerVault != address(0), "Deleverager: zero balancer");
        require(core.aavePool != address(0), "Deleverager: zero aave pool");
        require(core.morpho != address(0), "Deleverager: zero morpho");
        require(core.aaveDataProvider != address(0), "Deleverager: zero data provider");
        require(core.universalRouter != address(0), "Deleverager: zero router");
        require(
            oracle.priceFeedAssets.length == oracle.priceFeeds.length,
            "Deleverager: feed length mismatch"
        );
        require(oracle.oracleStalenessSeconds > 0, "Deleverager: zero staleness");
        require(
            oracle.maxSlippageBpsCeiling > 0 && oracle.maxSlippageBpsCeiling < BPS_DENOMINATOR,
            "Deleverager: invalid slippage ceiling"
        );

        balancerVault = IBalancerVault(core.balancerVault);
        aavePool = IAaveFlashPool(core.aavePool);
        morpho = IMorpho(core.morpho);
        aaveDataProvider = IAaveProtocolDataProvider(core.aaveDataProvider);
        universalRouter = IUniversalRouter(core.universalRouter);
        swapDeadlineBuffer = core.swapDeadlineBuffer;

        oracleStalenessSeconds = oracle.oracleStalenessSeconds;
        sequencerUptimeFeed = oracle.sequencerUptimeFeed;
        sequencerGracePeriod = oracle.sequencerGracePeriod;
        maxSlippageBpsCeiling = oracle.maxSlippageBpsCeiling;

        for (uint256 i; i < trackedAssets_.length; ++i) {
            _trackAsset(trackedAssets_[i]);
        }
        for (uint256 i; i < allowedMarkets_.length; ++i) {
            address market = allowedMarkets_[i];
            require(market != address(0), "Deleverager: zero market");
            if (_allowedMarket[market]) continue;
            _allowedMarket[market] = true;
            _allowedMarkets.push(market);
        }
        for (uint256 i; i < oracle.priceFeedAssets.length; ++i) {
            address asset = oracle.priceFeedAssets[i];
            address feed = oracle.priceFeeds[i];
            require(feed != address(0), "Deleverager: zero feed");
            uint8 dec = IChainlinkFeed(feed).decimals();
            require(dec <= 18, "Deleverager: feed decimals too high");
            _priceFeed[asset] = feed;
            _priceFeedDecimals[asset] = dec;
            _trackAsset(asset);
        }
    }

    // ------------------------------------------------------- entrypoint --

    /// @notice Deleverage the caller's OWN position by `repayAmount`, funded from
    /// their own collateral. Proceeds and every remainder go to the caller.
    function deleverage(DeleverageParams calldata p) external nonReentrant {
        address user = msg.sender;
        ExitTypes.ProtocolId proto = _validate(p);
        _checkSequencer();

        if (proto == ExitTypes.ProtocolId.MORPHO_BLUE) {
            _deleverageMorphoNative(user, p);
        } else {
            _deleverageViaFlash(user, p, proto);
        }
    }

    // ----------------------------------------------- external-flash path --

    function _deleverageViaFlash(
        address user,
        DeleverageParams calldata p,
        ExitTypes.ProtocolId proto
    ) private {
        FlashSource src = FlashSource(p.flashSource);
        bytes memory payload = abi.encode(p, user);

        _flashActive = true;
        _activeUser = user;

        if (src == FlashSource.BALANCER) {
            uint256 available = IERC20(p.debtAsset).balanceOf(address(balancerVault));
            if (available < p.repayAmount) {
                revert FlashLiquidityInsufficient(uint8(src), p.debtAsset, p.repayAmount, available);
            }
            address[] memory tokens = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            tokens[0] = p.debtAsset;
            amounts[0] = p.repayAmount;
            balancerVault.flashLoan(address(this), tokens, amounts, payload);
        } else if (src == FlashSource.MORPHO) {
            uint256 available = IERC20(p.debtAsset).balanceOf(address(morpho));
            if (available < p.repayAmount) {
                revert FlashLiquidityInsufficient(uint8(src), p.debtAsset, p.repayAmount, available);
            }
            IMorphoFlash(address(morpho)).flashLoan(p.debtAsset, p.repayAmount, payload);
        } else {
            // AAVE: the aToken custodies the reserve's underlying liquidity.
            (address aToken, , ) = aaveDataProvider.getReserveTokensAddresses(p.debtAsset);
            if (aToken == address(0)) revert MissingAToken(p.debtAsset);
            uint256 available = IERC20(p.debtAsset).balanceOf(aToken);
            if (available < p.repayAmount) {
                revert FlashLiquidityInsufficient(uint8(src), p.debtAsset, p.repayAmount, available);
            }
            aavePool.flashLoanSimple(address(this), p.debtAsset, p.repayAmount, payload, 0);
        }

        _flashActive = false;
        _activeUser = address(0);
        // Proceeds/remainders are swept to the user inside each callback so the
        // exact retained amount for the provider pull is left behind.
        proto; // silence unused (proto is validated in _validate)
    }

    /// @dev Balancer V2 flash callback. Repay is a plain transfer of amount+fee
    /// back to the Vault before this returns.
    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external override {
        if (msg.sender != address(balancerVault)) revert UnauthorizedFlashCallback(msg.sender);
        (DeleverageParams memory p, address user) = _authFlash(userData);
        if (tokens.length != 1 || tokens[0] != p.debtAsset || amounts[0] != p.repayAmount) {
            revert FlashParamsMismatch();
        }

        uint256 retain = amounts[0] + feeAmounts[0];
        _runExternalDeleverage(p, user);
        _requireBalance(p.debtAsset, retain);
        IERC20(p.debtAsset).safeTransfer(address(balancerVault), retain);
        _sweepDebtAsset(p, user, 0);
    }

    /// @dev Aave V3 flashLoanSimple callback. Leave amount+premium approved to
    /// the Pool; it pulls after this returns.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != address(aavePool)) revert UnauthorizedFlashCallback(msg.sender);
        if (initiator != address(this)) revert UnauthorizedFlashInitiator(initiator);
        (DeleverageParams memory p, address user) = _authFlash(params);
        if (asset != p.debtAsset || amount != p.repayAmount) revert FlashParamsMismatch();

        uint256 retain = amount + premium;
        _runExternalDeleverage(p, user);
        _requireBalance(p.debtAsset, retain);
        IERC20(p.debtAsset).forceApprove(address(aavePool), retain);
        _sweepDebtAsset(p, user, retain);
        return true;
    }

    /// @dev Morpho singleton flashLoan callback (fallback source for the
    /// non-Morpho protocols). Leave `assets` approved to Morpho; it pulls after.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external override {
        if (msg.sender != address(morpho)) revert UnauthorizedFlashCallback(msg.sender);
        (DeleverageParams memory p, address user) = _authFlash(data);
        if (assets != p.repayAmount) revert FlashParamsMismatch();

        _runExternalDeleverage(p, user);
        _requireBalance(p.debtAsset, assets);
        IERC20(p.debtAsset).forceApprove(address(morpho), assets);
        _sweepDebtAsset(p, user, assets);
    }

    /// @dev Repay the user's debt with the flashed asset, free their collateral,
    /// and sell it to the debt asset. Runs inside a flash callback for Aave,
    /// Moonwell and Compound V3.
    function _runExternalDeleverage(DeleverageParams memory p, address user) private {
        ExitTypes.ProtocolId proto = ExitTypes.ProtocolId(p.protocol);

        if (proto == ExitTypes.ProtocolId.AAVE_V3) {
            (, , , , , uint256 hfBefore) = aavePool.getUserAccountData(user);
            _aaveRepay(p.debtAsset, p.repayAmount, user);
            _aaveWithdraw(user, p.collateralToken, p.collateralWithdraw);
            (, , , , , uint256 hfAfter) = aavePool.getUserAccountData(user);
            if (hfAfter <= hfBefore) revert HealthNotImproved();
        } else if (proto == ExitTypes.ProtocolId.MOONWELL) {
            (address debtMToken, address collMToken) = abi.decode(p.marketData, (address, address));
            address comptroller = IMToken(debtMToken).comptroller();
            uint256 shortfallBefore = _moonwellShortfall(comptroller, user);
            _moonwellRepay(debtMToken, p.debtAsset, p.repayAmount, user);
            _moonwellWithdraw(collMToken, p.collateralToken, p.collateralWithdraw, user);
            uint256 shortfallAfter = _moonwellShortfall(comptroller, user);
            if (shortfallAfter > shortfallBefore) revert HealthNotImproved();
        } else {
            // COMPOUND_V3
            address comet = abi.decode(p.marketData, (address));
            _cometRepay(comet, p.debtAsset, p.repayAmount, user);
            _cometWithdraw(comet, p.collateralToken, p.collateralWithdraw, user);
            if (!IComet(comet).isBorrowCollateralized(user)) revert NotCollateralized(comet, user);
        }

        _swap(p.collateralToken, p.debtAsset, p.collateralWithdraw, p.swapPath, p.maxSlippageBps);
    }

    // ----------------------------------------------- Morpho native path --

    function _deleverageMorphoNative(address user, DeleverageParams calldata p) private {
        IMorpho.MarketParams memory mp = abi.decode(p.marketData, (IMorpho.MarketParams));
        bytes memory payload = abi.encode(p, user);

        _flashActive = true;
        _activeUser = user;
        // Accrue so the repay figure is exact for this block; the callback frees
        // collateral against fresh accounting.
        morpho.accrueInterest(mp);
        // Fires onMorphoRepay(repayAmount, payload) BEFORE Morpho pulls repayment.
        morpho.repay(mp, p.repayAmount, 0, user, payload);
        _flashActive = false;
        _activeUser = address(0);

        _sweepDebtAsset(p, user, 0);
    }

    /// @dev Morpho native repay callback. Free collateral, sell it to the loan
    /// asset, and approve Morpho for `assets`; Morpho pulls it after this
    /// returns. Morpho reverts an unhealthy withdrawCollateral, so no extra
    /// health assertion is needed.
    function onMorphoRepay(uint256 assets, bytes calldata data) external override {
        if (msg.sender != address(morpho)) revert UnauthorizedFlashCallback(msg.sender);
        (DeleverageParams memory p, address user) = _authFlash(data);
        if (assets != p.repayAmount) revert FlashParamsMismatch();

        IMorpho.MarketParams memory mp = abi.decode(p.marketData, (IMorpho.MarketParams));
        morpho.withdrawCollateral(mp, p.collateralWithdraw, user, address(this));
        _swap(p.collateralToken, p.debtAsset, p.collateralWithdraw, p.swapPath, p.maxSlippageBps);
        _requireBalance(p.debtAsset, assets);
        IERC20(p.debtAsset).forceApprove(address(morpho), assets);
    }

    // ------------------------------------------------- per-protocol ops --

    function _aaveRepay(address asset, uint256 amount, address user) private {
        IERC20(asset).forceApprove(address(aavePool), amount);
        aavePool.repay(asset, amount, AAVE_VARIABLE_RATE, user);
        IERC20(asset).forceApprove(address(aavePool), 0);
    }

    function _aaveWithdraw(address user, address collateral, uint256 amount) private {
        (address aToken, , ) = aaveDataProvider.getReserveTokensAddresses(collateral);
        if (aToken == address(0)) revert MissingAToken(collateral);
        // Pull the user's aTokens (they approved this contract), then redeem.
        IERC20(aToken).safeTransferFrom(user, address(this), amount);
        aavePool.withdraw(collateral, amount, address(this));
    }

    function _moonwellRepay(address mToken, address underlying, uint256 amount, address user) private {
        IERC20(underlying).forceApprove(mToken, amount);
        uint256 err = IMToken(mToken).repayBorrowBehalf(user, amount);
        if (err != 0) revert MTokenError(mToken, err);
        IERC20(underlying).forceApprove(mToken, 0);
    }

    function _moonwellWithdraw(address collMToken, address collateral, uint256 amount, address user) private {
        // Pull the user's collateral mTokens (they approved this contract) and
        // redeem them for the underlying collateral.
        IERC20(collMToken).safeTransferFrom(user, address(this), amount);
        uint256 err = IMToken(collMToken).redeem(amount);
        if (err != 0) revert MTokenError(collMToken, err);
        collateral; // underlying is fixed by the mToken; retained for the event/caller
    }

    function _moonwellShortfall(address comptroller, address user) private view returns (uint256 shortfall) {
        (, , shortfall) = IComptroller(comptroller).getAccountLiquidity(user);
    }

    function _cometRepay(address comet, address base, uint256 amount, address user) private {
        IERC20(base).forceApprove(comet, amount);
        IComet(comet).supplyTo(user, base, amount);
        IERC20(base).forceApprove(comet, 0);
    }

    function _cometWithdraw(address comet, address collateral, uint256 amount, address user) private {
        // Requires the user's prior comet.allow(address(this), true).
        IComet(comet).withdrawFrom(user, address(this), collateral, amount);
    }

    // ------------------------------------------------------------- swap --

    /// @dev Sell `amountIn` of `tokenIn` to `tokenOut` through the UniversalRouter
    /// (V3_SWAP_EXACT_IN, payerIsUser=false, funds pre-sent to the router). The
    /// oracle-derived floor is enforced both by the router (amountOutMin) and by
    /// a post-swap balance check for a legible revert.
    function _swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bytes memory path,
        uint16 maxSlippageBps
    ) private returns (uint256 amountOut) {
        uint256 floor = _computeMinOut(tokenIn, tokenOut, amountIn, maxSlippageBps);

        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).safeTransfer(address(universalRouter), amountIn);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(address(this), amountIn, floor, path, false);
        universalRouter.execute(hex"00", inputs, block.timestamp + swapDeadlineBuffer);

        amountOut = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (amountOut < floor) revert SwapSlippage(tokenOut, floor, amountOut);
    }

    function _computeMinOut(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint16 maxSlippageBps
    ) private view returns (uint256) {
        uint256 expectedOut = _oracleQuote(
            tokenIn,
            tokenOut,
            amountIn,
            _getFreshPrice(tokenIn),
            _getFreshPrice(tokenOut)
        );
        return Math.mulDiv(expectedOut, BPS_DENOMINATOR - maxSlippageBps, BPS_DENOMINATOR);
    }

    /// @dev tokenIn -> tokenOut quote from two prices that share a scale. The
    /// ratio is what matters, so only the exponent has to match (both are 8-dec
    /// Chainlink answers, normalised in _getFreshPrice).
    function _oracleQuote(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 inPrice,
        uint256 outPrice
    ) private view returns (uint256) {
        if (inPrice == 0) revert PriceUnavailable(tokenIn);
        if (outPrice == 0) revert PriceUnavailable(tokenOut);
        uint256 inScale = _pow10(IERC20Metadata(tokenIn).decimals());
        uint256 outScale = _pow10(IERC20Metadata(tokenOut).decimals());
        uint256 usdValue = Math.mulDiv(amountIn, inPrice, inScale);
        return Math.mulDiv(usdValue, outScale, outPrice);
    }

    function _getFreshPrice(address asset) private view returns (uint256) {
        address feed = _priceFeed[asset];
        if (feed == address(0)) revert MissingPriceFeed(asset);
        (, int256 answer, , uint256 updatedAt, ) = IChainlinkFeed(feed).latestRoundData();
        if (answer <= 0) revert PriceUnavailable(asset);
        if (updatedAt == 0 || updatedAt > block.timestamp) {
            revert StalePrice(asset, updatedAt, block.timestamp);
        }
        if (block.timestamp - updatedAt > oracleStalenessSeconds) {
            revert StalePrice(asset, updatedAt, block.timestamp);
        }
        return _scalePrice(uint256(answer), _priceFeedDecimals[asset]);
    }

    function _scalePrice(uint256 price, uint8 feedDecimals) private pure returns (uint256) {
        if (feedDecimals == PRICE_DECIMALS) return price;
        if (feedDecimals < PRICE_DECIMALS) return price * _pow10(PRICE_DECIMALS - feedDecimals);
        return price / _pow10(feedDecimals - PRICE_DECIMALS);
    }

    function _checkSequencer() private view {
        address feed = sequencerUptimeFeed;
        if (feed == address(0)) return;
        (, int256 answer, uint256 startedAt, , ) = IChainlinkFeed(feed).latestRoundData();
        if (answer != 0) revert SequencerDown(answer);
        if (startedAt == 0) revert SequencerDown(answer);
        uint256 readyAt = startedAt + sequencerGracePeriod;
        if (block.timestamp < readyAt) revert SequencerGracePeriodNotOver(startedAt, readyAt);
    }

    // -------------------------------------------------------- sweeping --

    /// @dev Return every debt-asset remainder above `retain` to the user, plus
    /// any un-sold collateral dust. `retain` is what a provider still needs to
    /// pull (Aave amount+premium / Morpho assets); Balancer already got its
    /// transfer so passes 0.
    function _sweepDebtAsset(DeleverageParams memory p, address user, uint256 retain) private {
        uint256 debtBal = IERC20(p.debtAsset).balanceOf(address(this));
        uint256 returned;
        if (debtBal > retain) {
            returned = debtBal - retain;
            IERC20(p.debtAsset).safeTransfer(user, returned);
        }
        uint256 collBal = IERC20(p.collateralToken).balanceOf(address(this));
        if (collBal > 0) {
            IERC20(p.collateralToken).safeTransfer(user, collBal);
        }
        emit Deleveraged(
            user,
            ExitTypes.ProtocolId(p.protocol),
            p.debtAsset,
            p.collateralToken,
            p.repayAmount,
            p.collateralWithdraw,
            returned
        );
    }

    // ------------------------------------------------------- validation --

    function _validate(DeleverageParams calldata p) private view returns (ExitTypes.ProtocolId proto) {
        if (p.protocol > uint8(ExitTypes.ProtocolId.MORPHO_BLUE)) revert InvalidProtocol(p.protocol);
        proto = ExitTypes.ProtocolId(p.protocol);

        if (p.repayAmount == 0 || p.collateralWithdraw == 0) revert ZeroAmount();
        if (p.maxSlippageBps == 0 || p.maxSlippageBps > maxSlippageBpsCeiling) {
            revert InvalidSlippage(p.maxSlippageBps, maxSlippageBpsCeiling);
        }
        if (p.swapPath.length == 0) revert EmptySwapPath();

        _requireTracked(p.debtAsset);
        _requireTracked(p.collateralToken);

        if (proto == ExitTypes.ProtocolId.MOONWELL) {
            (address debtMToken, address collMToken) = abi.decode(p.marketData, (address, address));
            _requireMarket(debtMToken);
            _requireMarket(collMToken);
        } else if (proto == ExitTypes.ProtocolId.COMPOUND_V3) {
            _requireMarket(abi.decode(p.marketData, (address)));
        } else if (proto == ExitTypes.ProtocolId.MORPHO_BLUE) {
            IMorpho.MarketParams memory mp = abi.decode(p.marketData, (IMorpho.MarketParams));
            if (mp.loanToken != p.debtAsset) revert TokenMarketMismatch(mp.loanToken, p.debtAsset);
            if (mp.collateralToken != p.collateralToken) {
                revert TokenMarketMismatch(mp.collateralToken, p.collateralToken);
            }
        } else {
            // AAVE_V3: no market registry needed (pool is immutable; bounded by
            // the user's own reserve position). flashSource must be valid.
            if (p.flashSource > uint8(FlashSource.AAVE)) revert InvalidFlashSource(p.flashSource);
        }

        if (proto != ExitTypes.ProtocolId.MORPHO_BLUE && p.flashSource > uint8(FlashSource.AAVE)) {
            revert InvalidFlashSource(p.flashSource);
        }
    }

    /// @dev Authenticate a flash/native callback and decode its payload. Every
    /// callback funnels through here: a flash must be in progress and the user
    /// baked into the payload must equal the one the entrypoint stored.
    function _authFlash(bytes calldata payload)
        private
        view
        returns (DeleverageParams memory p, address user)
    {
        if (!_flashActive) revert NoFlashInProgress();
        (p, user) = abi.decode(payload, (DeleverageParams, address));
        if (user != _activeUser) revert FlashParamsMismatch();
    }

    function _requireBalance(address asset, uint256 required) private view {
        uint256 have = IERC20(asset).balanceOf(address(this));
        if (have < required) revert InsufficientSwapProceeds(asset, required, have);
    }

    function _requireTracked(address asset) private view {
        if (!_trackedAsset[asset]) revert AssetNotTracked(asset);
    }

    function _requireMarket(address market) private view {
        if (!_allowedMarket[market]) revert MarketNotAllowed(market);
    }

    function _trackAsset(address asset) private {
        require(asset != address(0), "Deleverager: zero asset");
        if (_trackedAsset[asset]) return;
        _trackedAsset[asset] = true;
        _trackedAssets.push(asset);
    }

    function _pow10(uint8 decimals) private pure returns (uint256 result) {
        if (decimals > 77) revert InvalidOracleDecimals(decimals);
        result = 1;
        for (uint8 i; i < decimals; ++i) result *= 10;
    }

    // ------------------------------------------------------------ views --

    function isTrackedAsset(address asset) external view returns (bool) {
        return _trackedAsset[asset];
    }

    function getTrackedAssets() external view returns (address[] memory) {
        return _trackedAssets;
    }

    function isAllowedMarket(address market) external view returns (bool) {
        return _allowedMarket[market];
    }

    function getAllowedMarkets() external view returns (address[] memory) {
        return _allowedMarkets;
    }

    function getPriceFeed(address asset) external view returns (address feed, uint8 decimals) {
        return (_priceFeed[asset], _priceFeedDecimals[asset]);
    }

    /// @notice Live Aave flash premium in basis points (e.g. 5 == 0.05%).
    function aaveFlashPremiumBps() external view returns (uint256) {
        return aavePool.FLASHLOAN_PREMIUM_TOTAL();
    }

    // --- on-chain liquidation parameters (per the Phase 3.A steer: the
    // contract reads WLT per protocol so the advisor can size a target-HF repay
    // against on-chain truth). These are VIEWS used for sizing/cross-check; the
    // state-changing path acts on an explicit repayAmount and enforces the live
    // HF-improvement post-condition, so a wrong preview can never move funds. ---

    /// @notice Aave weighted liquidation threshold (bps) and health factor (wad)
    /// for `user`, straight from the pool.
    function getAaveRiskParams(address user)
        external
        view
        returns (uint256 totalDebtBase, uint256 weightedLiquidationThresholdBps, uint256 healthFactorWad)
    {
        (, totalDebtBase, , weightedLiquidationThresholdBps, , healthFactorWad) = aavePool
            .getUserAccountData(user);
    }

    /// @notice Suggested debt-asset repay to reach `targetHfWad` on Aave, sized
    /// from live account data by repay = D*(T-HF)/(T-WLT) and priced into
    /// debt-asset units by the configured Chainlink feed. Advisory only.
    function previewAaveRepayForTargetHf(
        address user,
        address debtAsset,
        uint256 targetHfWad
    ) external view returns (uint256 repayAmount) {
        (, uint256 totalDebtBase, , uint256 wltBps, , uint256 hf) = aavePool.getUserAccountData(user);
        if (targetHfWad <= hf) revert TargetNotAnImprovement(hf, targetHfWad);
        uint256 wltWad = Math.mulDiv(wltBps, WAD, BPS_DENOMINATOR);
        if (targetHfWad <= wltWad) revert TargetBelowLiquidationThreshold(targetHfWad, wltWad);

        // repay in base currency (8-dec USD).
        uint256 repayBase = Math.mulDiv(totalDebtBase, targetHfWad - hf, targetHfWad - wltWad);
        // convert to debt-asset units via its USD feed (both 8-dec, so the USD
        // exponent cancels): amount = repayBase * 10^assetDecimals / price.
        uint256 price = _getFreshPrice(debtAsset);
        uint256 assetScale = _pow10(IERC20Metadata(debtAsset).decimals());
        repayAmount = Math.mulDiv(repayBase, assetScale, price);
    }

    /// @notice Compound V3 liquidation collateral factor (wad, 1e18 == 100%).
    function getCometLiquidationFactorWad(address comet, address collateral)
        external
        view
        returns (uint256)
    {
        return ICometAssetInfo(comet).getAssetInfoByAddress(collateral).liquidateCollateralFactor;
    }

    /// @notice Moonwell/Compound-V2 collateral factor (wad). One factor gates
    /// both borrow capacity and liquidation on a V2 fork.
    function getMoonwellCollateralFactorWad(address comptroller, address mToken)
        external
        view
        returns (uint256)
    {
        (, uint256 collateralFactorMantissa) = IComptrollerMarkets(comptroller).markets(mToken);
        return collateralFactorMantissa;
    }
}
