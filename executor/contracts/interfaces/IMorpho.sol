// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Morpho Blue singleton surface used by the exit flow.
interface IMorpho {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    struct Position {
        uint256 supplyShares;
        uint128 borrowShares;
        uint128 collateral;
    }

    struct Market {
        uint128 totalSupplyAssets;
        uint128 totalSupplyShares;
        uint128 totalBorrowAssets;
        uint128 totalBorrowShares;
        uint128 lastUpdate;
        uint128 fee;
    }

    function position(bytes32 id, address user) external view returns (Position memory);

    function market(bytes32 id) external view returns (Market memory);

    function accrueInterest(MarketParams memory marketParams) external;

    /// @dev Exactly one of assets/shares must be zero.
    function repay(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid);

    /// @dev Requires onBehalf to have authorized the caller (setAuthorization).
    function withdrawCollateral(
        MarketParams memory marketParams,
        uint256 assets,
        address onBehalf,
        address receiver
    ) external;

    function isAuthorized(address authorizer, address authorized) external view returns (bool);
}
