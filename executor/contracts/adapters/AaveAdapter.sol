// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAavePool} from "../interfaces/IAavePool.sol";

contract AaveAdapter {
    using SafeERC20 for IERC20;

    error CallerNotManager(address caller);
    error CallerNotExecutor(address caller);
    error InvalidExecutor(address executor);
    error HealthFactorNotImproved(uint256 previousHealthFactor, uint256 currentHealthFactor);

    event ExecutorUpdated(address indexed previousExecutor, address indexed newExecutor);
    event TokenRecovered(address indexed token, address indexed to, uint256 amount);

    address public immutable manager;
    IAavePool public immutable pool;
    address public executor;

    modifier onlyManager() {
        if (msg.sender != manager) {
            revert CallerNotManager(msg.sender);
        }
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) {
            revert CallerNotExecutor(msg.sender);
        }
        _;
    }

    constructor(address pool_) {
        require(pool_ != address(0), "AaveAdapter: zero pool");
        manager = msg.sender;
        pool = IAavePool(pool_);
    }

    function setExecutor(address executor_) external onlyManager {
        if (executor_ == address(0)) {
            revert InvalidExecutor(executor_);
        }

        address previousExecutor = executor;
        executor = executor_;
        emit ExecutorUpdated(previousExecutor, executor_);
    }

    function repay(
        address asset,
        uint256 amount,
        uint256 rateMode,
        address onBehalfOf
    ) external onlyExecutor returns (uint256 repaid) {
        if (amount == 0) return 0;

        IERC20(asset).forceApprove(address(pool), amount);
        repaid = pool.repay(asset, amount, rateMode, onBehalfOf);
        IERC20(asset).forceApprove(address(pool), 0);
    }

    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external onlyExecutor returns (uint256 withdrawn) {
        if (amount == 0) return 0;
        withdrawn = pool.withdraw(asset, amount, to);
    }

    function recoverToken(
        address token,
        address to,
        uint256 amount
    ) external onlyExecutor {
        if (amount == 0) {
            return;
        }

        IERC20(token).safeTransfer(to, amount);
        emit TokenRecovered(token, to, amount);
    }

    function getUserAccountData(
        address user
    )
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        )
    {
        return pool.getUserAccountData(user);
    }

    function assertHealthFactorImproved(
        address user,
        uint256 previousHealthFactor
    ) external view returns (uint256 currentHealthFactor) {
        (, , , , , currentHealthFactor) = pool.getUserAccountData(user);
        if (currentHealthFactor <= previousHealthFactor) {
            revert HealthFactorNotImproved(previousHealthFactor, currentHealthFactor);
        }
    }
}
