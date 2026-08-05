// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  IERC20
 * @notice Minimal ERC-20 interface vendored into the project.
 * @dev    Only the functions PanikEscrow actually calls are declared here.
 *         Production sources must not depend on `forge-std` (a test-only
 *         library that lives in the gitignored `lib/` directory), so this
 *         file is the single interface the contract compiles against.
 */
interface IERC20 {
    /// @notice Number of decimals the token uses. Checked at deploy time.
    function decimals() external view returns (uint8);

    /// @notice Token balance of `account`.
    function balanceOf(address account) external view returns (uint256);

    /// @notice Move `amount` tokens from the caller to `to`.
    function transfer(address to, uint256 amount) external returns (bool);

    /// @notice Move `amount` tokens from `from` to `to` using the caller's allowance.
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
