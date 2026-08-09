// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMToken} from "../interfaces/IMToken.sol";
import {IComptroller} from "../interfaces/IComptroller.sol";

/// @notice Moonwell (Compound V2 fork) leg adapter. Same trust model as
/// AaveAdapter: funds are pushed in by the executor, results are pushed back,
/// and only the linked executor may call state-changing entrypoints.
contract MoonwellAdapter {
    using SafeERC20 for IERC20;

    error CallerNotManager(address caller);
    error CallerNotExecutor(address caller);
    error InvalidExecutor(address executor);
    error MTokenError(address mToken, uint256 errorCode);
    error ShortfallIncreased(uint256 shortfallBefore, uint256 shortfallAfter);

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

    function underlyingOf(address mToken) external view returns (address) {
        return IMToken(mToken).underlying();
    }

    /// @notice Current borrow balance (accrues interest; not a view).
    function debtOf(address mToken, address user) external onlyExecutor returns (uint256) {
        return IMToken(mToken).borrowBalanceCurrent(user);
    }

    /// @notice Repay `amount` of the borrower's debt. The underlying must
    /// already sit on this adapter (pushed by the executor).
    function repayBehalf(
        address mToken,
        address borrower,
        uint256 amount
    ) external onlyExecutor returns (uint256 repaid) {
        if (amount == 0) return 0;
        address underlying = IMToken(mToken).underlying();
        IERC20(underlying).forceApprove(mToken, amount);
        uint256 err = IMToken(mToken).repayBorrowBehalf(borrower, amount);
        if (err != 0) revert MTokenError(mToken, err);
        IERC20(underlying).forceApprove(mToken, 0);
        repaid = amount;
    }

    /// @notice Redeem mTokens held by this adapter (pushed by the executor) and
    /// forward the received underlying to the executor.
    function redeem(
        address mToken,
        uint256 mTokenAmount
    ) external onlyExecutor returns (address underlying, uint256 received) {
        underlying = IMToken(mToken).underlying();
        if (mTokenAmount == 0) return (underlying, 0);

        uint256 balanceBefore = IERC20(underlying).balanceOf(address(this));
        uint256 err = IMToken(mToken).redeem(mTokenAmount);
        if (err != 0) revert MTokenError(mToken, err);
        received = IERC20(underlying).balanceOf(address(this)) - balanceBefore;
        if (received > 0) {
            IERC20(underlying).safeTransfer(executor, received);
        }
    }

    function accountShortfall(address comptroller, address user) public view returns (uint256 shortfall) {
        (, , shortfall) = IComptroller(comptroller).getAccountLiquidity(user);
    }

    /// @notice Repaying debt must never worsen account shortfall.
    function assertShortfallNotIncreased(
        address comptroller,
        address user,
        uint256 shortfallBefore
    ) external view {
        uint256 shortfallAfter = accountShortfall(comptroller, user);
        if (shortfallAfter > shortfallBefore) {
            revert ShortfallIncreased(shortfallBefore, shortfallAfter);
        }
    }

    function recoverToken(address token, address to, uint256 amount) external onlyExecutor {
        if (amount == 0) return;
        IERC20(token).safeTransfer(to, amount);
        emit TokenRecovered(token, to, amount);
    }
}
