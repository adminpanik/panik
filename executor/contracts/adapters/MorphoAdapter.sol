// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho} from "../interfaces/IMorpho.sol";

/// @notice Morpho Blue leg adapter. Full repays go by SHARES (exact close, no
/// dust); collateral withdrawal requires the user's prior
/// morpho.setAuthorization(thisAdapter, true). Morpho itself reverts an
/// unhealthy withdrawCollateral, so no extra health assertion is needed.
contract MorphoAdapter {
    using SafeERC20 for IERC20;

    error CallerNotManager(address caller);
    error CallerNotExecutor(address caller);
    error InvalidExecutor(address executor);

    event ExecutorUpdated(address indexed previousExecutor, address indexed newExecutor);
    event TokenRecovered(address indexed token, address indexed to, uint256 amount);

    /// @dev Morpho Blue SharesMathLib virtual offsets.
    uint256 private constant VIRTUAL_SHARES = 1e6;
    uint256 private constant VIRTUAL_ASSETS = 1;

    address public immutable manager;
    IMorpho public immutable morpho;
    address public executor;

    modifier onlyManager() {
        if (msg.sender != manager) revert CallerNotManager(msg.sender);
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert CallerNotExecutor(msg.sender);
        _;
    }

    constructor(address morpho_) {
        require(morpho_ != address(0), "MorphoAdapter: zero morpho");
        manager = msg.sender;
        morpho = IMorpho(morpho_);
    }

    function setExecutor(address executor_) external onlyManager {
        if (executor_ == address(0)) revert InvalidExecutor(executor_);
        address previousExecutor = executor;
        executor = executor_;
        emit ExecutorUpdated(previousExecutor, executor_);
    }

    function marketId(IMorpho.MarketParams memory mp) public pure returns (bytes32) {
        return keccak256(abi.encode(mp));
    }

    /// @notice Assets needed to fully repay the user's borrow shares, after
    /// accruing interest (so the figure is exact for this transaction).
    function debtAssets(
        IMorpho.MarketParams calldata mp,
        address user
    ) external onlyExecutor returns (uint256 assets) {
        morpho.accrueInterest(mp);
        bytes32 id = marketId(mp);
        IMorpho.Position memory pos = morpho.position(id, user);
        if (pos.borrowShares == 0) return 0;
        IMorpho.Market memory m = morpho.market(id);
        assets = _toAssetsUp(pos.borrowShares, m.totalBorrowAssets, m.totalBorrowShares);
    }

    /// @notice Repay the user's debt. The loan token must already sit on this
    /// adapter (pushed by the executor). `assets == 0` closes the debt in full
    /// by shares; leftovers (share-rounding) are returned to the executor.
    function repay(
        IMorpho.MarketParams calldata mp,
        address user,
        uint256 assets
    ) external onlyExecutor returns (uint256 assetsRepaid) {
        bytes32 id = marketId(mp);
        IMorpho.Position memory pos = morpho.position(id, user);
        if (pos.borrowShares == 0) return 0;

        IERC20 loan = IERC20(mp.loanToken);
        uint256 balance = loan.balanceOf(address(this));
        loan.forceApprove(address(morpho), balance);
        if (assets == 0) {
            (assetsRepaid, ) = morpho.repay(mp, 0, pos.borrowShares, user, "");
        } else {
            (assetsRepaid, ) = morpho.repay(mp, assets, 0, user, "");
        }
        loan.forceApprove(address(morpho), 0);

        uint256 leftover = loan.balanceOf(address(this));
        if (leftover > 0) {
            loan.safeTransfer(executor, leftover);
        }
    }

    function collateralOf(
        IMorpho.MarketParams calldata mp,
        address user
    ) external view returns (uint256) {
        return morpho.position(marketId(mp), user).collateral;
    }

    /// @notice Withdraw the user's collateral straight to the receiver.
    /// Requires the user's prior morpho.setAuthorization(thisAdapter, true).
    function withdrawCollateral(
        IMorpho.MarketParams calldata mp,
        address user,
        uint256 amount,
        address receiver
    ) external onlyExecutor {
        if (amount == 0) return;
        morpho.withdrawCollateral(mp, amount, user, receiver);
    }

    function recoverToken(address token, address to, uint256 amount) external onlyExecutor {
        if (amount == 0) return;
        IERC20(token).safeTransfer(to, amount);
        emit TokenRecovered(token, to, amount);
    }

    /// @dev Morpho SharesMathLib.toAssetsUp.
    function _toAssetsUp(
        uint256 shares,
        uint256 totalAssets,
        uint256 totalShares
    ) private pure returns (uint256) {
        uint256 denominator = totalShares + VIRTUAL_SHARES;
        return (shares * (totalAssets + VIRTUAL_ASSETS) + denominator - 1) / denominator;
    }
}
