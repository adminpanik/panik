// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Moonwell mToken mock with a NON-1:1 redeem exchange rate, unlike the
/// exit-flow MockMToken (which is 1:1 and so could not surface the deleverager's
/// mToken-vs-underlying unit bug). redeem(mTokens) yields
/// `mTokens * redeemRateWad / 1e18` underlying, modelling the real ~1:50
/// mToken:underlying ratio. Redeem liquidity comes from this contract's balance.
contract MockMTokenRate is ERC20 {
    IERC20 public immutable underlyingToken;
    address public immutable comptrollerAddress;
    uint256 public redeemRateWad; // underlying out per 1e18 mTokens

    mapping(address borrower => uint256 balance) private _borrowBalanceByUser;

    constructor(
        string memory name_,
        string memory symbol_,
        address underlying_,
        address comptroller_,
        uint256 redeemRateWad_
    ) ERC20(name_, symbol_) {
        underlyingToken = IERC20(underlying_);
        comptrollerAddress = comptroller_;
        redeemRateWad = redeemRateWad_;
    }

    function underlying() external view returns (address) {
        return address(underlyingToken);
    }

    function comptroller() external view returns (address) {
        return comptrollerAddress;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBorrowBalance(address borrower, uint256 amount) external {
        _borrowBalanceByUser[borrower] = amount;
    }

    function borrowBalanceCurrent(address account) external view returns (uint256) {
        return _borrowBalanceByUser[account];
    }

    function repayBorrowBehalf(address borrower, uint256 repayAmount) external returns (uint256) {
        underlyingToken.transferFrom(msg.sender, address(this), repayAmount);
        uint256 debt = _borrowBalanceByUser[borrower];
        _borrowBalanceByUser[borrower] = repayAmount >= debt ? 0 : debt - repayAmount;
        return 0;
    }

    function redeem(uint256 redeemTokens) external returns (uint256) {
        _burn(msg.sender, redeemTokens);
        uint256 underlyingOut = (redeemTokens * redeemRateWad) / 1e18;
        underlyingToken.transfer(msg.sender, underlyingOut);
        return 0;
    }
}
