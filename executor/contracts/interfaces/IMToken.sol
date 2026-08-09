// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Moonwell mToken surface (Compound V2 fork). All state-changing
/// calls return a Compound error code where 0 == success.
interface IMToken {
    function underlying() external view returns (address);

    function comptroller() external view returns (address);

    function balanceOf(address owner) external view returns (uint256);

    function getCash() external view returns (uint256);

    /// @dev Accrues interest; NOT a view.
    function borrowBalanceCurrent(address account) external returns (uint256);

    function repayBorrowBehalf(address borrower, uint256 repayAmount) external returns (uint256);

    /// @dev Redeems mTokens held by the caller for underlying.
    function redeem(uint256 redeemTokens) external returns (uint256);

    function transferFrom(address src, address dst, uint256 amount) external returns (bool);

    function approve(address spender, uint256 amount) external returns (bool);
}
