// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho} from "../interfaces/IMorpho.sol";
import {IMorphoRepayCallback} from "../interfaces/IProtocolExtras.sol";
import {IMorphoFlashLoanCallback as IFlashCb} from "../interfaces/IFlashProviders.sol";

/// @notice Morpho Blue mock exercising the two callbacks the deleverager uses
/// that the exit-flow MockMorpho does not: the NATIVE repay callback
/// (onMorphoRepay, fired BEFORE the loan asset is pulled) and the singleton
/// flashLoan (onMorphoFlashLoan, fallback flash source). Tracks debt/collateral
/// as plain balances - enough to assert the deleverage moved them.
contract MockMorphoDeleverage {
    mapping(bytes32 id => mapping(address user => uint256)) public debtOf;
    mapping(bytes32 id => mapping(address user => uint256)) public collateralOf;
    mapping(address authorizer => mapping(address authorized => bool)) public isAuthorized;
    mapping(address user => bool) public unhealthy;

    function marketId(IMorpho.MarketParams memory mp) public pure returns (bytes32) {
        return keccak256(abi.encode(mp));
    }

    function setPosition(
        IMorpho.MarketParams calldata mp,
        address user,
        uint256 debt,
        uint256 collateral
    ) external {
        bytes32 id = marketId(mp);
        debtOf[id][user] = debt;
        collateralOf[id][user] = collateral;
    }

    function setAuthorization(address authorized, bool value) external {
        isAuthorized[msg.sender][authorized] = value;
    }

    function setUnhealthy(address user, bool value) external {
        unhealthy[user] = value;
    }

    function accrueInterest(IMorpho.MarketParams memory) external {}

    /// @dev Native repay: fires onMorphoRepay BEFORE pulling `assets`, so the
    /// deleverager frees collateral and swaps inside the callback.
    function repay(
        IMorpho.MarketParams calldata mp,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes calldata data
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid) {
        require(shares == 0 && assets > 0, "MockMorphoD: assets-only");
        if (data.length > 0) {
            IMorphoRepayCallback(msg.sender).onMorphoRepay(assets, data);
        }
        IERC20(mp.loanToken).transferFrom(msg.sender, address(this), assets);
        bytes32 id = marketId(mp);
        uint256 debt = debtOf[id][onBehalf];
        debtOf[id][onBehalf] = assets >= debt ? 0 : debt - assets;
        return (assets, 0);
    }

    function withdrawCollateral(
        IMorpho.MarketParams calldata mp,
        uint256 assets,
        address onBehalf,
        address receiver
    ) external {
        require(msg.sender == onBehalf || isAuthorized[onBehalf][msg.sender], "MockMorphoD: unauthorized");
        require(!unhealthy[onBehalf], "MockMorphoD: unhealthy");
        bytes32 id = marketId(mp);
        require(collateralOf[id][onBehalf] >= assets, "MockMorphoD: insufficient collateral");
        collateralOf[id][onBehalf] -= assets;
        IERC20(mp.collateralToken).transfer(receiver, assets);
    }

    /// @dev Singleton flash loan (0% fee); pulls `assets` back via approval.
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(msg.sender, assets);
        IFlashCb(msg.sender).onMorphoFlashLoan(assets, data);
        IERC20(token).transferFrom(msg.sender, address(this), assets);
        require(IERC20(token).balanceOf(address(this)) >= balBefore, "MockMorphoD: flash not repaid");
    }
}
