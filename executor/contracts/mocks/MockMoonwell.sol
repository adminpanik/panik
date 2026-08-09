// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal Compound V2 comptroller mock: settable liquidity/shortfall.
contract MockComptroller {
    struct Liquidity {
        uint256 liquidity;
        uint256 shortfall;
    }

    mapping(address account => Liquidity) private _liquidityByAccount;

    function setAccountLiquidity(address account, uint256 liquidity, uint256 shortfall) external {
        _liquidityByAccount[account] = Liquidity(liquidity, shortfall);
    }

    function getAccountLiquidity(address account) external view returns (uint256, uint256, uint256) {
        Liquidity memory l = _liquidityByAccount[account];
        return (0, l.liquidity, l.shortfall);
    }
}

/// @notice Minimal Moonwell mToken mock. 1 mToken redeems for 1 underlying
/// unit (exchange rate 1:1) - enough to exercise the adapter/executor flow.
/// Redeem liquidity comes from this contract's underlying balance (getCash).
contract MockMToken is ERC20 {
    IERC20 public immutable underlyingToken;
    address public immutable comptrollerAddress;

    mapping(address borrower => uint256 balance) private _borrowBalanceByUser;
    uint256 public repayError;
    uint256 public redeemError;

    constructor(
        string memory name_,
        string memory symbol_,
        address underlying_,
        address comptroller_
    ) ERC20(name_, symbol_) {
        underlyingToken = IERC20(underlying_);
        comptrollerAddress = comptroller_;
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

    function setRepayError(uint256 code) external {
        repayError = code;
    }

    function setRedeemError(uint256 code) external {
        redeemError = code;
    }

    function getCash() external view returns (uint256) {
        return underlyingToken.balanceOf(address(this));
    }

    function borrowBalanceCurrent(address account) external view returns (uint256) {
        return _borrowBalanceByUser[account];
    }

    function repayBorrowBehalf(address borrower, uint256 repayAmount) external returns (uint256) {
        if (repayError != 0) return repayError;
        underlyingToken.transferFrom(msg.sender, address(this), repayAmount);
        uint256 debt = _borrowBalanceByUser[borrower];
        _borrowBalanceByUser[borrower] = repayAmount >= debt ? 0 : debt - repayAmount;
        return 0;
    }

    function redeem(uint256 redeemTokens) external returns (uint256) {
        if (redeemError != 0) return redeemError;
        _burn(msg.sender, redeemTokens);
        underlyingToken.transfer(msg.sender, redeemTokens);
        return 0;
    }
}
