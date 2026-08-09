// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Moonwell/Compound V2 Comptroller surface.
interface IComptroller {
    /// @return error code (0 == success), account liquidity, account shortfall.
    function getAccountLiquidity(address account) external view returns (uint256, uint256, uint256);
}
