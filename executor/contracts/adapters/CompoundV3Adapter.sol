// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IComet} from "../interfaces/IComet.sol";

/// @notice Compound V3 (Comet) leg adapter. Repaying base debt is a supplyTo
/// on behalf of the borrower; collateral withdrawal uses withdrawFrom, which
/// requires the user to have called comet.allow(thisAdapter, true). Comet
/// itself reverts any withdrawal that would leave the account
/// under-collateralized, so no extra health assertion is needed post-withdraw.
contract CompoundV3Adapter {
    using SafeERC20 for IERC20;

    error CallerNotManager(address caller);
    error CallerNotExecutor(address caller);
    error InvalidExecutor(address executor);
    error NotCollateralized(address comet, address user);

    event ExecutorUpdated(address indexed previousExecutor, address indexed newExecutor);
    event TokenRecovered(address indexed token, address indexed to, uint256 amount);

    address public immutable manager;
    address public executor;

    modifier onlyManager() {
        if (msg.sender != manager) revert CallerNotManager(msg.sender);
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert CallerNotExecutor(msg.sender);
        _;
    }

    constructor() {
        manager = msg.sender;
    }

    function setExecutor(address executor_) external onlyManager {
        if (executor_ == address(0)) revert InvalidExecutor(executor_);
        address previousExecutor = executor;
        executor = executor_;
        emit ExecutorUpdated(previousExecutor, executor_);
    }

    /// @notice Repay `amount` of the user's base-token debt. The base token
    /// must already sit on this adapter (pushed by the executor).
    function repayBase(
        address comet,
        address user,
        uint256 amount
    ) external onlyExecutor returns (uint256 repaid) {
        if (amount == 0) return 0;
        address base = IComet(comet).baseToken();
        IERC20(base).forceApprove(comet, amount);
        IComet(comet).supplyTo(user, base, amount);
        IERC20(base).forceApprove(comet, 0);
        repaid = amount;
    }

    /// @notice Withdraw the user's collateral straight to the executor.
    /// Requires the user's prior comet.allow(thisAdapter, true).
    function withdrawCollateral(
        address comet,
        address user,
        address asset,
        uint256 amount,
        address receiver
    ) external onlyExecutor {
        if (amount == 0) return;
        IComet(comet).withdrawFrom(user, receiver, asset, amount);
    }

    function assertCollateralized(address comet, address user) external view {
        if (!IComet(comet).isBorrowCollateralized(user)) {
            revert NotCollateralized(comet, user);
        }
    }

    function recoverToken(address token, address to, uint256 amount) external onlyExecutor {
        if (amount == 0) return;
        IERC20(token).safeTransfer(to, amount);
        emit TokenRecovered(token, to, amount);
    }
}
