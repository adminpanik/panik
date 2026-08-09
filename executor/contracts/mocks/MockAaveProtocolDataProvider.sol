// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAaveProtocolDataProvider} from "../interfaces/IAaveProtocolDataProvider.sol";

contract MockAaveProtocolDataProvider is IAaveProtocolDataProvider {
    struct ReserveConfig {
        uint256 decimals;
        uint256 ltv;
        uint256 liquidationThreshold;
        uint256 liquidationBonus;
        uint256 reserveFactor;
        bool usageAsCollateralEnabled;
        bool borrowingEnabled;
        bool stableBorrowRateEnabled;
        bool isActive;
        bool isFrozen;
    }

    struct ReserveData {
        uint256 availableLiquidity;
        uint256 totalStableDebt;
        uint256 totalVariableDebt;
        uint256 liquidityRate;
        uint256 variableBorrowRate;
        uint256 stableBorrowRate;
        uint256 averageStableBorrowRate;
        uint256 liquidityIndex;
        uint256 variableBorrowIndex;
        uint40 lastUpdateTimestamp;
    }

    struct UserReserveData {
        uint256 currentATokenBalance;
        uint256 currentStableDebt;
        uint256 currentVariableDebt;
        uint256 principalStableDebt;
        uint256 scaledVariableDebt;
        uint256 stableBorrowRate;
        uint256 liquidityRate;
        uint40 stableRateLastUpdated;
        bool usageAsCollateralEnabled;
    }

    struct ReserveTokens {
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
    }

    mapping(address asset => ReserveConfig config) private _reserveConfigByAsset;
    mapping(address asset => ReserveData data) private _reserveDataByAsset;
    mapping(address asset => ReserveTokens tokens) private _reserveTokensByAsset;
    mapping(address user => mapping(address asset => UserReserveData data))
        private _userReserveDataByUserAndAsset;

    function setReserveConfigurationData(
        address asset,
        ReserveConfig calldata config
    ) external {
        _reserveConfigByAsset[asset] = config;
    }

    function setReserveData(
        address asset,
        ReserveData calldata reserveData
    ) external {
        _reserveDataByAsset[asset] = reserveData;
    }

    function setReserveTokens(
        address asset,
        address aTokenAddress,
        address stableDebtTokenAddress,
        address variableDebtTokenAddress
    ) external {
        _reserveTokensByAsset[asset] = ReserveTokens({
            aTokenAddress: aTokenAddress,
            stableDebtTokenAddress: stableDebtTokenAddress,
            variableDebtTokenAddress: variableDebtTokenAddress
        });
    }

    function setUserReserveData(
        address user,
        address asset,
        UserReserveData calldata userReserveData
    ) external {
        _userReserveDataByUserAndAsset[user][asset] = userReserveData;
    }

    function reduceUserDebt(
        address user,
        address asset,
        uint256 amount,
        uint256 rateMode
    ) external {
        UserReserveData storage data = _userReserveDataByUserAndAsset[user][asset];
        if (rateMode == 1) {
            data.currentStableDebt = amount >= data.currentStableDebt
                ? 0
                : data.currentStableDebt - amount;
        } else {
            data.currentVariableDebt = amount >= data.currentVariableDebt
                ? 0
                : data.currentVariableDebt - amount;
        }
    }

    function reduceReserveLiquidity(address asset, uint256 amount) external {
        ReserveData storage data = _reserveDataByAsset[asset];
        data.availableLiquidity = amount >= data.availableLiquidity
            ? 0
            : data.availableLiquidity - amount;
    }

    function increaseReserveLiquidity(address asset, uint256 amount) external {
        _reserveDataByAsset[asset].availableLiquidity += amount;
    }

    function getReserveConfigurationData(
        address asset
    )
        external
        view
        returns (
            uint256 decimals,
            uint256 ltv,
            uint256 liquidationThreshold,
            uint256 liquidationBonus,
            uint256 reserveFactor,
            bool usageAsCollateralEnabled,
            bool borrowingEnabled,
            bool stableBorrowRateEnabled,
            bool isActive,
            bool isFrozen
        )
    {
        ReserveConfig memory c = _reserveConfigByAsset[asset];
        return (
            c.decimals,
            c.ltv,
            c.liquidationThreshold,
            c.liquidationBonus,
            c.reserveFactor,
            c.usageAsCollateralEnabled,
            c.borrowingEnabled,
            c.stableBorrowRateEnabled,
            c.isActive,
            c.isFrozen
        );
    }

    function getReserveData(
        address asset
    )
        external
        view
        returns (
            uint256 availableLiquidity,
            uint256 totalStableDebt,
            uint256 totalVariableDebt,
            uint256 liquidityRate,
            uint256 variableBorrowRate,
            uint256 stableBorrowRate,
            uint256 averageStableBorrowRate,
            uint256 liquidityIndex,
            uint256 variableBorrowIndex,
            uint40 lastUpdateTimestamp
        )
    {
        ReserveData memory d = _reserveDataByAsset[asset];
        return (
            d.availableLiquidity,
            d.totalStableDebt,
            d.totalVariableDebt,
            d.liquidityRate,
            d.variableBorrowRate,
            d.stableBorrowRate,
            d.averageStableBorrowRate,
            d.liquidityIndex,
            d.variableBorrowIndex,
            d.lastUpdateTimestamp
        );
    }

    function getUserReserveData(
        address asset,
        address user
    )
        external
        view
        returns (
            uint256 currentATokenBalance,
            uint256 currentStableDebt,
            uint256 currentVariableDebt,
            uint256 principalStableDebt,
            uint256 scaledVariableDebt,
            uint256 stableBorrowRate,
            uint256 liquidityRate,
            uint40 stableRateLastUpdated,
            bool usageAsCollateralEnabled
        )
    {
        UserReserveData memory d = _userReserveDataByUserAndAsset[user][asset];
        return (
            d.currentATokenBalance,
            d.currentStableDebt,
            d.currentVariableDebt,
            d.principalStableDebt,
            d.scaledVariableDebt,
            d.stableBorrowRate,
            d.liquidityRate,
            d.stableRateLastUpdated,
            d.usageAsCollateralEnabled
        );
    }

    function getReserveTokensAddresses(
        address asset
    )
        external
        view
        returns (
            address aTokenAddress,
            address stableDebtTokenAddress,
            address variableDebtTokenAddress
        )
    {
        ReserveTokens memory t = _reserveTokensByAsset[asset];
        return (
            t.aTokenAddress,
            t.stableDebtTokenAddress,
            t.variableDebtTokenAddress
        );
    }
}
