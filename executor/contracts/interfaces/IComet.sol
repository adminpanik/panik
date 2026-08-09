// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Compound V3 (Comet) surface used by the exit flow.
/// Repaying base debt == supplying base on behalf of the borrower.
interface IComet {
    function baseToken() external view returns (address);

    function borrowBalanceOf(address account) external view returns (uint256);

    function collateralBalanceOf(address account, address asset) external view returns (uint128);

    function isBorrowCollateralized(address account) external view returns (bool);

    function isSupplyPaused() external view returns (bool);

    function isWithdrawPaused() external view returns (bool);

    /// @dev Requires prior ERC-20 approval of the base token by the caller.
    function supplyTo(address dst, address asset, uint256 amount) external;

    /// @dev Requires src to have called allow(caller, true).
    function withdrawFrom(address src, address to, address asset, uint256 amount) external;
}
