// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal Compound V3 (Comet) mock. Collateral tokens are held by
/// this contract (tests fund it via setCollateral + transfer).
contract MockComet {
    address public immutable baseTokenAddress;

    mapping(address account => uint256 balance) private _borrowBalanceByUser;
    mapping(address account => mapping(address asset => uint128 balance)) private _collateral;
    mapping(address src => mapping(address operator => bool)) public allowance_;
    mapping(address account => bool) private _underCollateralized;
    /// @dev Independent of _underCollateralized (which gates withdrawFrom): lets a
    /// test make a withdraw SUCCEED yet isBorrowCollateralized() read false, to
    /// exercise the deleverager's post-withdraw NotCollateralized guard.
    bool private _reportUncollateralized;
    bool public supplyPaused;
    bool public withdrawPaused;

    constructor(address baseToken_) {
        baseTokenAddress = baseToken_;
    }

    // -- test setup -----------------------------------------------------------

    function setBorrowBalance(address account, uint256 amount) external {
        _borrowBalanceByUser[account] = amount;
    }

    function setCollateral(address account, address asset, uint128 amount) external {
        _collateral[account][asset] = amount;
    }

    function setUnderCollateralized(address account, bool value) external {
        _underCollateralized[account] = value;
    }

    function setReportUncollateralized(bool value) external {
        _reportUncollateralized = value;
    }

    function setSupplyPaused(bool value) external {
        supplyPaused = value;
    }

    function setWithdrawPaused(bool value) external {
        withdrawPaused = value;
    }

    // -- IComet ---------------------------------------------------------------

    function baseToken() external view returns (address) {
        return baseTokenAddress;
    }

    function borrowBalanceOf(address account) external view returns (uint256) {
        return _borrowBalanceByUser[account];
    }

    function collateralBalanceOf(address account, address asset) external view returns (uint128) {
        return _collateral[account][asset];
    }

    function isBorrowCollateralized(address account) external view returns (bool) {
        return !_underCollateralized[account] && !_reportUncollateralized;
    }

    function isSupplyPaused() external view returns (bool) {
        return supplyPaused;
    }

    function isWithdrawPaused() external view returns (bool) {
        return withdrawPaused;
    }

    function allow(address manager, bool isAllowed) external {
        allowance_[msg.sender][manager] = isAllowed;
    }

    function supplyTo(address dst, address asset, uint256 amount) external {
        require(!supplyPaused, "MockComet: supply paused");
        require(asset == baseTokenAddress, "MockComet: not base");
        IERC20(asset).transferFrom(msg.sender, address(this), amount);
        uint256 debt = _borrowBalanceByUser[dst];
        _borrowBalanceByUser[dst] = amount >= debt ? 0 : debt - amount;
    }

    function withdrawFrom(address src, address to, address asset, uint256 amount) external {
        require(!withdrawPaused, "MockComet: withdraw paused");
        require(allowance_[src][msg.sender], "MockComet: not allowed");
        require(!_underCollateralized[src], "MockComet: undercollateralized");
        uint128 bal = _collateral[src][asset];
        require(bal >= amount, "MockComet: insufficient collateral");
        _collateral[src][asset] = bal - uint128(amount);
        IERC20(asset).transfer(to, amount);
    }
}
