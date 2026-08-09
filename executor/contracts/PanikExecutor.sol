// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAaveProtocolDataProvider} from "./interfaces/IAaveProtocolDataProvider.sol";
import {IAssetOracle} from "./interfaces/IAssetOracle.sol";
import {IComet} from "./interfaces/IComet.sol";
import {IMorpho} from "./interfaces/IMorpho.sol";
import {IMToken} from "./interfaces/IMToken.sol";
import {INonfungiblePositionManager} from "./interfaces/INonfungiblePositionManager.sol";
import {LockChecker} from "./LockChecker.sol";
import {ExitTypes} from "./libraries/ExitTypes.sol";
import {SequenceLib} from "./libraries/SequenceLib.sol";
import {AaveAdapter} from "./adapters/AaveAdapter.sol";
import {CompoundV3Adapter} from "./adapters/CompoundV3Adapter.sol";
import {MoonwellAdapter} from "./adapters/MoonwellAdapter.sol";
import {MorphoAdapter} from "./adapters/MorphoAdapter.sol";
import {SwapAdapter} from "./adapters/SwapAdapter.sol";
import {UniswapAdapter} from "./adapters/UniswapAdapter.sol";

/// @notice Multi-protocol atomic exit (Phase 2): Aave V3, Moonwell,
/// Compound V3 (Comet) and Morpho Blue legs in ONE transaction - repay debt
/// (wallet-funded), withdraw collateral, swap everything to USDC, sweep to the
/// user. Amount semantics per leg: 0 = skip, type(uint256).max = full,
/// otherwise the exact cap. Individual exits are single-element leg arrays.
contract PanikExecutor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error CallerNotEOA();
    error LockedPositions(address[] lockedAssets);
    error InsufficientDebtAssetBalance(
        address asset,
        uint256 requiredAmount,
        uint256 availableAmount
    );
    error MissingSwapRoute(address asset);
    error InvalidMinOutBps(address asset, uint16 minOutBps);
    error PriceUnavailable(address asset);
    error MissingAToken(address asset);
    error InvalidOracleDecimals(uint8 decimals);
    error InvalidTrackedAsset(address asset);
    error DuplicateAsset(address asset);
    error InvalidRepayAmount(address asset, uint256 attemptedAmount, uint256 repaidAmount);
    error EmptyExit();

    event ExitCompleted(
        address user,
        uint256 usdcReceived,
        address[] closed,
        address[] locked
    );
    event LegClosed(address indexed user, ExitTypes.ProtocolId protocol, address asset);

    uint256 public constant AMOUNT_FULL = type(uint256).max;

    address public immutable usdc;
    IAaveProtocolDataProvider public immutable dataProvider;
    IAssetOracle public immutable marketOracle;
    IAssetOracle public immutable mockOracle;
    LockChecker public immutable lockChecker;
    AaveAdapter public immutable aaveAdapter;
    MoonwellAdapter public immutable moonwellAdapter;
    CompoundV3Adapter public immutable compoundAdapter;
    MorphoAdapter public immutable morphoAdapter;
    SwapAdapter public immutable swapAdapter;
    UniswapAdapter public immutable uniswapAdapter;
    INonfungiblePositionManager public immutable nftManager;
    uint256 public immutable swapDeadlineBuffer;

    mapping(address asset => bytes path) private _swapPathByAsset;
    mapping(address asset => uint16 minOutBps) private _swapMinOutBpsByAsset;
    mapping(address asset => bool enabled) private _swapEnabledByAsset;
    mapping(address asset => bool useMock) private _useMockOracleByAsset;
    mapping(address asset => bool tracked) private _trackedAssetByAsset;
    address[] private _trackedAssets;

    struct AdapterAddresses {
        address aave;
        address moonwell;
        address compound;
        address morpho;
        address swap;
        address uniswap;
    }

    struct SwapConfigInput {
        address[] assets;
        bytes[] paths;
        uint16[] minOutBps;
    }

    modifier onlyEOA() {
        if (msg.sender != tx.origin) revert CallerNotEOA();
        _;
    }

    constructor(
        address usdc_,
        address dataProvider_,
        address marketOracle_,
        address mockOracle_,
        address lockChecker_,
        AdapterAddresses memory adapters_,
        address nftManager_,
        SwapConfigInput memory swapConfig_,
        address[] memory mockOracleAssets_,
        address[] memory trackedAssets_,
        uint256 swapDeadlineBuffer_
    ) {
        require(usdc_ != address(0), "PanikExecutor: zero usdc");
        require(dataProvider_ != address(0), "PanikExecutor: zero data provider");
        require(lockChecker_ != address(0), "PanikExecutor: zero lock checker");
        require(adapters_.aave != address(0), "PanikExecutor: zero aave adapter");
        require(adapters_.moonwell != address(0), "PanikExecutor: zero moonwell adapter");
        require(adapters_.compound != address(0), "PanikExecutor: zero compound adapter");
        require(adapters_.morpho != address(0), "PanikExecutor: zero morpho adapter");
        require(adapters_.swap != address(0), "PanikExecutor: zero swap adapter");
        require(adapters_.uniswap != address(0), "PanikExecutor: zero uniswap adapter");
        require(nftManager_ != address(0), "PanikExecutor: zero nft manager");
        require(
            swapConfig_.assets.length == swapConfig_.paths.length &&
                swapConfig_.assets.length == swapConfig_.minOutBps.length,
            "PanikExecutor: swap config length mismatch"
        );

        usdc = usdc_;
        dataProvider = IAaveProtocolDataProvider(dataProvider_);
        marketOracle = IAssetOracle(marketOracle_);
        mockOracle = IAssetOracle(mockOracle_);
        lockChecker = LockChecker(lockChecker_);
        aaveAdapter = AaveAdapter(adapters_.aave);
        moonwellAdapter = MoonwellAdapter(adapters_.moonwell);
        compoundAdapter = CompoundV3Adapter(adapters_.compound);
        morphoAdapter = MorphoAdapter(adapters_.morpho);
        swapAdapter = SwapAdapter(adapters_.swap);
        uniswapAdapter = UniswapAdapter(adapters_.uniswap);
        nftManager = INonfungiblePositionManager(nftManager_);
        swapDeadlineBuffer = swapDeadlineBuffer_;

        _trackAsset(usdc_);
        for (uint256 i; i < swapConfig_.assets.length; ++i) {
            _swapPathByAsset[swapConfig_.assets[i]] = swapConfig_.paths[i];
            _swapMinOutBpsByAsset[swapConfig_.assets[i]] = swapConfig_.minOutBps[i];
            _swapEnabledByAsset[swapConfig_.assets[i]] = true;
            _trackAsset(swapConfig_.assets[i]);
        }

        for (uint256 i; i < mockOracleAssets_.length; ++i) {
            _useMockOracleByAsset[mockOracleAssets_[i]] = true;
            _trackAsset(mockOracleAssets_[i]);
        }

        for (uint256 i; i < trackedAssets_.length; ++i) {
            _trackAsset(trackedAssets_[i]);
        }
    }

    /// @notice Atomic multi-protocol exit. Each leg: repay (wallet-funded),
    /// withdraw collateral, swap to USDC. Uniswap V3 LP exits ride along.
    function atomicExit(
        ExitTypes.ExitLeg[] calldata legs,
        uint256[] calldata uniswapTokenIds
    ) external nonReentrant onlyEOA {
        if (legs.length == 0 && uniswapTokenIds.length == 0) revert EmptyExit();
        _validateUniqueLegs(legs);

        address[] memory locked;
        if (legs.length > 0) {
            locked = lockChecker.getLockedLegs(msg.sender, legs);
            if (locked.length > 0) revert LockedPositions(locked);
        } else {
            locked = new address[](0);
        }

        uint256 usdcBefore = IERC20(usdc).balanceOf(address(this));
        address[] memory closedTemp = new address[](legs.length);
        uint256 closedCount;

        // --- Phase 1: Aave V3 legs (SequenceLib ordering: USDC debt first,
        // withdrawals USD-descending, HF-improvement assertion) ---
        closedCount = _processAaveLegs(legs, closedTemp, closedCount);

        // --- Phases 2-4: Moonwell, Compound V3, Morpho Blue legs ---
        for (uint256 i; i < legs.length; ++i) {
            ExitTypes.ExitLeg calldata leg = legs[i];
            if (leg.protocol == ExitTypes.ProtocolId.MOONWELL) {
                if (_processMoonwellLeg(leg)) closedTemp[closedCount++] = leg.asset;
            } else if (leg.protocol == ExitTypes.ProtocolId.COMPOUND_V3) {
                if (_processCometLeg(leg)) closedTemp[closedCount++] = leg.asset;
            } else if (leg.protocol == ExitTypes.ProtocolId.MORPHO_BLUE) {
                if (_processMorphoLeg(leg)) closedTemp[closedCount++] = leg.asset;
            }
        }

        // --- Phase 5: Uniswap V3 LP exits (dormant in the main app) ---
        for (uint256 i; i < uniswapTokenIds.length; ++i) {
            _exitUniswapPosition(uniswapTokenIds[i]);
        }

        // --- Phase 6: USDC sweep ---
        uint256 usdcReceived = IERC20(usdc).balanceOf(address(this)) - usdcBefore;
        if (usdcReceived > 0) {
            IERC20(usdc).safeTransfer(msg.sender, usdcReceived);
        }

        emit ExitCompleted(msg.sender, usdcReceived, _shrink(closedTemp, closedCount), locked);
    }

    function getSwapConfig(
        address asset
    )
        external
        view
        returns (bool enabled, bytes memory path, uint16 minOutBps, bool useMockOracle)
    {
        return (
            _swapEnabledByAsset[asset],
            _swapPathByAsset[asset],
            _swapMinOutBpsByAsset[asset],
            _useMockOracleByAsset[asset]
        );
    }

    function getTrackedAssets() external view returns (address[] memory) {
        return _trackedAssets;
    }

    // ---------------------------------------------------------------- Aave --

    function _processAaveLegs(
        ExitTypes.ExitLeg[] calldata legs,
        address[] memory closedTemp,
        uint256 closedCount
    ) private returns (uint256) {
        uint256 aaveCount;
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].protocol == ExitTypes.ProtocolId.AAVE_V3) aaveCount++;
        }
        if (aaveCount == 0) return closedCount;

        SequenceLib.AssetPosition[] memory positions = new SequenceLib.AssetPosition[](aaveCount);
        uint256 p;
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].protocol != ExitTypes.ProtocolId.AAVE_V3) continue;
            positions[p++] = _buildAavePosition(msg.sender, legs[i]);
        }

        SequenceLib.ExitSequence memory sequence = SequenceLib.buildExitSequence(positions, usdc);

        (, uint256 totalDebtBaseBefore, , , , uint256 healthFactorBefore) = aaveAdapter
            .getUserAccountData(msg.sender);

        bool didRepay;
        didRepay = _repayAaveDebtActions(sequence.variableDebtRepays) || didRepay;
        didRepay = _repayAaveDebtActions(sequence.stableDebtRepays) || didRepay;

        if (didRepay && totalDebtBaseBefore > 0) {
            aaveAdapter.assertHealthFactorImproved(msg.sender, healthFactorBefore);
        }

        for (uint256 i; i < sequence.withdrawals.length; ++i) {
            SequenceLib.WithdrawAction memory action = sequence.withdrawals[i];
            if (action.amount == 0) continue;
            uint256 withdrawn = _withdrawAaveCollateralFromUser(
                msg.sender,
                action.asset,
                action.amount
            );
            if (withdrawn == 0) continue;
            closedTemp[closedCount++] = action.asset;
            emit LegClosed(msg.sender, ExitTypes.ProtocolId.AAVE_V3, action.asset);
            if (action.asset != usdc) {
                _swapAssetToUsdc(action.asset, withdrawn);
            }
        }
        return closedCount;
    }

    function _buildAavePosition(
        address user,
        ExitTypes.ExitLeg calldata leg
    ) private view returns (SequenceLib.AssetPosition memory) {
        (
            uint256 currentATokenBalance,
            uint256 currentStableDebt,
            uint256 currentVariableDebt,
            ,
            ,
            ,
            ,
            ,

        ) = dataProvider.getUserReserveData(leg.asset, user);

        // Repay cap: variable debt first, remainder to stable.
        uint256 variableDebt;
        uint256 stableDebt;
        if (leg.repayAmount == AMOUNT_FULL) {
            variableDebt = currentVariableDebt;
            stableDebt = currentStableDebt;
        } else if (leg.repayAmount > 0) {
            variableDebt = _min(currentVariableDebt, leg.repayAmount);
            stableDebt = _min(currentStableDebt, leg.repayAmount - variableDebt);
        }

        uint256 collateralAmount;
        if (leg.withdrawAmount == AMOUNT_FULL) {
            collateralAmount = currentATokenBalance;
        } else {
            collateralAmount = _min(currentATokenBalance, leg.withdrawAmount);
        }

        return
            SequenceLib.AssetPosition({
                asset: leg.asset,
                variableDebt: variableDebt,
                stableDebt: stableDebt,
                collateralAmount: collateralAmount,
                usdPrice: _getAssetPrice(leg.asset)
            });
    }

    function _repayAaveDebtActions(
        SequenceLib.DebtAction[] memory actions
    ) private returns (bool repaidAny) {
        for (uint256 i; i < actions.length; ++i) {
            SequenceLib.DebtAction memory action = actions[i];
            if (action.amount == 0) continue;

            _pullFromUser(action.asset, action.amount, address(aaveAdapter));
            uint256 repaid = aaveAdapter.repay(
                action.asset,
                action.amount,
                action.rateMode,
                msg.sender
            );

            if (repaid > action.amount) {
                revert InvalidRepayAmount(action.asset, action.amount, repaid);
            }

            if (repaid < action.amount) {
                uint256 refundable = action.amount - repaid;
                uint256 adapterBalance = IERC20(action.asset).balanceOf(address(aaveAdapter));
                uint256 recoverable = _min(refundable, adapterBalance);
                if (recoverable > 0) {
                    aaveAdapter.recoverToken(action.asset, address(this), recoverable);
                    IERC20(action.asset).safeTransfer(msg.sender, recoverable);
                }
            }

            repaidAny = repaidAny || (repaid > 0);
        }
    }

    function _withdrawAaveCollateralFromUser(
        address user,
        address asset,
        uint256 amount
    ) private returns (uint256 withdrawn) {
        (address aTokenAddress, , ) = dataProvider.getReserveTokensAddresses(asset);
        if (aTokenAddress == address(0)) {
            revert MissingAToken(asset);
        }

        IERC20(aTokenAddress).safeTransferFrom(user, address(aaveAdapter), amount);
        withdrawn = aaveAdapter.withdraw(asset, amount, address(this));
    }

    // ------------------------------------------------------------ Moonwell --

    function _processMoonwellLeg(ExitTypes.ExitLeg calldata leg) private returns (bool acted) {
        address mToken = leg.asset;
        address comptroller = IMToken(mToken).comptroller();
        uint256 shortfallBefore = moonwellAdapter.accountShortfall(comptroller, msg.sender);

        // Repay (wallet-funded; borrowBalanceCurrent accrues so full is exact).
        if (leg.repayAmount > 0) {
            uint256 debt = moonwellAdapter.debtOf(mToken, msg.sender);
            uint256 amount = leg.repayAmount == AMOUNT_FULL ? debt : _min(debt, leg.repayAmount);
            if (amount > 0) {
                address underlying = IMToken(mToken).underlying();
                _pullFromUser(underlying, amount, address(moonwellAdapter));
                moonwellAdapter.repayBehalf(mToken, msg.sender, amount);
                moonwellAdapter.assertShortfallNotIncreased(
                    comptroller,
                    msg.sender,
                    shortfallBefore
                );
                acted = true;
            }
        }

        // Withdraw: pull the user's mTokens (ERC-20 approved to the executor),
        // redeem on the adapter; the Comptroller blocks any redeem that would
        // create shortfall, so health is protocol-enforced here.
        if (leg.withdrawAmount > 0) {
            uint256 balance = IMToken(mToken).balanceOf(msg.sender);
            uint256 amount = leg.withdrawAmount == AMOUNT_FULL
                ? balance
                : _min(balance, leg.withdrawAmount);
            if (amount > 0) {
                IERC20(mToken).safeTransferFrom(msg.sender, address(moonwellAdapter), amount);
                (address underlying, uint256 received) = moonwellAdapter.redeem(mToken, amount);
                if (received > 0 && underlying != usdc) {
                    _swapAssetToUsdc(underlying, received);
                }
                acted = acted || received > 0;
            }
        }

        if (acted) emit LegClosed(msg.sender, ExitTypes.ProtocolId.MOONWELL, mToken);
    }

    // ---------------------------------------------------------- Compound V3 --

    function _processCometLeg(ExitTypes.ExitLeg calldata leg) private returns (bool acted) {
        address comet = abi.decode(leg.data, (address));

        // Repay base debt (repay == supplyTo on behalf of the borrower).
        if (leg.repayAmount > 0) {
            uint256 debt = IComet(comet).borrowBalanceOf(msg.sender);
            uint256 amount = leg.repayAmount == AMOUNT_FULL ? debt : _min(debt, leg.repayAmount);
            if (amount > 0) {
                address base = IComet(comet).baseToken();
                _pullFromUser(base, amount, address(compoundAdapter));
                compoundAdapter.repayBase(comet, msg.sender, amount);
                acted = true;
            }
        }

        // Withdraw collateral (Comet reverts if it would under-collateralize).
        if (leg.withdrawAmount > 0 && leg.asset != address(0)) {
            uint256 balance = IComet(comet).collateralBalanceOf(msg.sender, leg.asset);
            uint256 amount = leg.withdrawAmount == AMOUNT_FULL
                ? balance
                : _min(balance, leg.withdrawAmount);
            if (amount > 0) {
                compoundAdapter.withdrawCollateral(
                    comet,
                    msg.sender,
                    leg.asset,
                    amount,
                    address(this)
                );
                if (leg.asset != usdc) {
                    _swapAssetToUsdc(leg.asset, amount);
                }
                acted = true;
            }
        }

        if (acted) {
            compoundAdapter.assertCollateralized(comet, msg.sender);
            emit LegClosed(msg.sender, ExitTypes.ProtocolId.COMPOUND_V3, leg.asset);
        }
    }

    // -------------------------------------------------------------- Morpho --

    function _processMorphoLeg(ExitTypes.ExitLeg calldata leg) private returns (bool acted) {
        IMorpho.MarketParams memory mp = abi.decode(leg.data, (IMorpho.MarketParams));

        // Repay (full closes by shares - exact, no dust).
        if (leg.repayAmount > 0) {
            uint256 debt = morphoAdapter.debtAssets(mp, msg.sender);
            uint256 amount = leg.repayAmount == AMOUNT_FULL ? debt : _min(debt, leg.repayAmount);
            if (amount > 0) {
                _pullFromUser(mp.loanToken, amount, address(morphoAdapter));
                uint256 loanBefore = IERC20(mp.loanToken).balanceOf(address(this));
                morphoAdapter.repay(mp, msg.sender, leg.repayAmount == AMOUNT_FULL ? 0 : amount);
                // Share-rounding leftovers come back here; return them to the
                // user (non-USDC would otherwise be stranded pre-sweep).
                uint256 leftover = IERC20(mp.loanToken).balanceOf(address(this)) - loanBefore;
                if (leftover > 0 && mp.loanToken != usdc) {
                    IERC20(mp.loanToken).safeTransfer(msg.sender, leftover);
                }
                acted = true;
            }
        }

        // Withdraw collateral (Morpho reverts an unhealthy withdrawal).
        if (leg.withdrawAmount > 0) {
            uint256 balance = morphoAdapter.collateralOf(mp, msg.sender);
            uint256 amount = leg.withdrawAmount == AMOUNT_FULL
                ? balance
                : _min(balance, leg.withdrawAmount);
            if (amount > 0) {
                morphoAdapter.withdrawCollateral(mp, msg.sender, amount, address(this));
                if (mp.collateralToken != usdc) {
                    _swapAssetToUsdc(mp.collateralToken, amount);
                }
                acted = true;
            }
        }

        if (acted) emit LegClosed(msg.sender, ExitTypes.ProtocolId.MORPHO_BLUE, leg.asset);
    }

    // ------------------------------------------------------------- helpers --

    /// @dev Pull `amount` of `asset` from the user (balance-checked) and push
    /// it to `to` (an adapter).
    function _pullFromUser(address asset, uint256 amount, address to) private {
        uint256 userBalance = IERC20(asset).balanceOf(msg.sender);
        if (userBalance < amount) {
            revert InsufficientDebtAssetBalance(asset, amount, userBalance);
        }
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(asset).safeTransfer(to, amount);
    }

    /// @dev Transfer NFT from user, exit position via adapter, swap received tokens to USDC.
    function _exitUniswapPosition(uint256 tokenId) private {
        nftManager.transferFrom(msg.sender, address(uniswapAdapter), tokenId);

        (
            address token0,
            uint256 amount0,
            address token1,
            uint256 amount1
        ) = uniswapAdapter.exitPosition(tokenId);

        if (amount0 > 0 && token0 != usdc) {
            _swapAssetToUsdc(token0, amount0);
        }
        if (amount1 > 0 && token1 != usdc) {
            _swapAssetToUsdc(token1, amount1);
        }
    }

    function _swapAssetToUsdc(address asset, uint256 amountIn) private {
        if (!_swapEnabledByAsset[asset]) {
            revert MissingSwapRoute(asset);
        }

        uint256 amountOutMinimum = _computeAmountOutMinimum(asset, amountIn);
        IERC20(asset).safeTransfer(address(swapAdapter), amountIn);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(
            address(swapAdapter),
            amountIn,
            amountOutMinimum,
            _swapPathByAsset[asset],
            false
        );

        swapAdapter.swapToUSDC(
            SwapAdapter.SwapRequest({
                tokenIn: asset,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                commands: hex"00",
                inputs: inputs,
                deadline: block.timestamp + swapDeadlineBuffer
            })
        );
    }

    /// @dev Slippage floor from deploy-time per-asset config + oracle prices.
    function _computeAmountOutMinimum(
        address asset,
        uint256 amountIn
    ) private view returns (uint256) {
        uint16 minOutBps = _swapMinOutBpsByAsset[asset];
        if (minOutBps == 0 || minOutBps > 10_000) {
            revert InvalidMinOutBps(asset, minOutBps);
        }

        uint256 assetPrice = _getAssetPrice(asset);
        uint256 usdcPrice = _getAssetPrice(usdc);
        if (assetPrice == 0) revert PriceUnavailable(asset);
        if (usdcPrice == 0) revert PriceUnavailable(usdc);

        uint8 assetDecimals = IERC20Metadata(asset).decimals();
        uint8 usdcDecimals = IERC20Metadata(usdc).decimals();
        uint256 assetScale = _pow10(assetDecimals);
        uint256 usdcScale = _pow10(usdcDecimals);

        uint256 usdValue = Math.mulDiv(amountIn, assetPrice, assetScale);
        uint256 expectedOut = Math.mulDiv(usdValue, usdcScale, usdcPrice);
        return Math.mulDiv(expectedOut, minOutBps, 10_000);
    }

    function _getAssetPrice(address asset) private view returns (uint256) {
        if (_useMockOracleByAsset[asset]) {
            uint256 mockPrice = _readPrice(mockOracle, asset);
            if (mockPrice == 0) revert PriceUnavailable(asset);
            return mockPrice;
        }

        uint256 marketPrice = _readPrice(marketOracle, asset);
        if (marketPrice > 0) {
            return marketPrice;
        }

        uint256 fallbackMockPrice = _readPrice(mockOracle, asset);
        if (fallbackMockPrice > 0) {
            return fallbackMockPrice;
        }

        revert PriceUnavailable(asset);
    }

    function _readPrice(
        IAssetOracle oracle,
        address asset
    ) private view returns (uint256 price) {
        if (address(oracle) == address(0)) {
            return 0;
        }

        try oracle.getAssetPrice(asset) returns (uint256 p) {
            price = p;
        } catch {
            price = 0;
        }
    }

    function _pow10(uint8 decimals) private pure returns (uint256 result) {
        if (decimals > 77) revert InvalidOracleDecimals(decimals);

        result = 1;
        for (uint8 i; i < decimals; ++i) {
            result *= 10;
        }
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _trackAsset(address asset) private {
        if (asset == address(0)) {
            revert InvalidTrackedAsset(asset);
        }
        if (_trackedAssetByAsset[asset]) {
            return;
        }
        _trackedAssetByAsset[asset] = true;
        _trackedAssets.push(asset);
    }

    /// @dev Duplicate legs are rejected per (protocol, asset) pair; the same
    /// underlying address may legitimately appear on two different protocols.
    function _validateUniqueLegs(ExitTypes.ExitLeg[] calldata legs) private pure {
        for (uint256 i; i < legs.length; ++i) {
            for (uint256 j = i + 1; j < legs.length; ++j) {
                if (legs[i].protocol == legs[j].protocol && legs[i].asset == legs[j].asset) {
                    revert DuplicateAsset(legs[i].asset);
                }
            }
        }
    }

    function _shrink(
        address[] memory values,
        uint256 size
    ) private pure returns (address[] memory result) {
        result = new address[](size);
        for (uint256 i; i < size; ++i) {
            result[i] = values[i];
        }
    }
}
