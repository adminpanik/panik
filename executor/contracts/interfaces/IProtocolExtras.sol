// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Extra protocol surfaces the deleverager needs beyond the exit-flow
/// interfaces: Morpho's native repay callback (the flash-free deleverage path)
/// and the per-protocol liquidation parameters read on-chain for target-HF
/// sizing (weightedLiquidationThreshold / liquidateCollateralFactor /
/// collateralFactor / lltv). Kept separate so the v2 interfaces are untouched.

/// @dev Fires INSIDE Morpho.repay(marketParams, assets, 0, onBehalf, data) when
/// `data` is non-empty, BEFORE Morpho pulls `assets`. The deleverager withdraws
/// collateral, swaps it to the loan asset, and approves Morpho for `assets`
/// here; Morpho then pulls it. This removes the flash fee and the flash
/// liquidity dependency for Morpho entirely.
interface IMorphoRepayCallback {
    function onMorphoRepay(uint256 assets, bytes calldata data) external;
}

/// @dev Compound V3 (Comet) per-collateral risk config. `liquidateCollateralFactor`
/// is 18-decimal (1e18 == 100%) and is the deleverage-relevant threshold (the
/// borrow collateral factor is looser and only gates new borrows).
interface ICometAssetInfo {
    struct AssetInfo {
        uint8 offset;
        address asset;
        address priceFeed;
        uint64 scale;
        uint64 borrowCollateralFactor;
        uint64 liquidateCollateralFactor;
        uint64 liquidationFactor;
        uint128 supplyCap;
    }

    function getAssetInfoByAddress(address asset) external view returns (AssetInfo memory);
}

/// @dev Wrapped-native token deposit, used to re-wrap the NATIVE ETH that
/// Moonwell's mWETH returns on redeem back into the ERC-20 the swap needs.
interface IWETH {
    function deposit() external payable;
}

/// @dev Moonwell/Compound-V2 Comptroller collateral-factor read. Compound V2
/// uses ONE factor for both borrow capacity and liquidation, so
/// `collateralFactorMantissa` (1e18 scale) is the liquidation threshold too.
interface IComptrollerMarkets {
    function markets(address mToken) external view returns (bool isListed, uint256 collateralFactorMantissa);
}
