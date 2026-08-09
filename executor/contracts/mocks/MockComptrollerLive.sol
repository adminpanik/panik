// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice A Compound-V2-style comptroller whose reported shortfall RISES as the
/// user's collateral mToken balance falls. The deleverager reads shortfall
/// before repay and after the collateral is pulled; with this comptroller the
/// second read exceeds the first, exercising the Moonwell HealthNotImproved
/// post-condition (which a static mock cannot express across two view calls).
contract MockComptrollerLive {
    address public collMToken;
    uint256 public baseline; // the user's mToken balance at "healthy" state
    uint256 public factor;

    function config(address collMToken_, uint256 baseline_, uint256 factor_) external {
        collMToken = collMToken_;
        baseline = baseline_;
        factor = factor_;
    }

    function getAccountLiquidity(address user) external view returns (uint256, uint256, uint256) {
        uint256 current = IERC20(collMToken).balanceOf(user);
        uint256 shortfall = current < baseline ? (baseline - current) * factor : 0;
        return (0, 0, shortfall);
    }
}
