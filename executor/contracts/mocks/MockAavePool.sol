// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAavePool} from "../interfaces/IAavePool.sol";
import {MockAaveProtocolDataProvider} from "./MockAaveProtocolDataProvider.sol";
import {MockERC20} from "./MockERC20.sol";

contract MockAavePool is IAavePool {
    struct AccountData {
        uint256 totalCollateralBase;
        uint256 totalDebtBase;
        uint256 availableBorrowsBase;
        uint256 currentLiquidationThreshold;
        uint256 ltv;
        uint256 healthFactor;
    }

    MockAaveProtocolDataProvider public immutable dataProvider;
    mapping(address user => AccountData data) private _accountDataByUser;
    uint256 public healthFactorDeltaPerUnitRepaid = 1;
    uint256 public repayReturnBps = 10_000;

    constructor(address dataProvider_) {
        require(dataProvider_ != address(0), "MockAavePool: zero data provider");
        dataProvider = MockAaveProtocolDataProvider(dataProvider_);
    }

    function setHealthFactorDeltaPerUnitRepaid(uint256 delta) external {
        healthFactorDeltaPerUnitRepaid = delta;
    }

    function setRepayReturnBps(uint256 bps) external {
        require(bps <= 10_000, "MockAavePool: bps too high");
        repayReturnBps = bps;
    }

    function setUserAccountData(
        address user,
        AccountData calldata data
    ) external {
        _accountDataByUser[user] = data;
    }

    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external returns (uint256) {
        uint256 repaid = (amount * repayReturnBps) / 10_000;
        IERC20(asset).transferFrom(msg.sender, address(this), repaid);
        dataProvider.reduceUserDebt(onBehalfOf, asset, repaid, interestRateMode);
        dataProvider.increaseReserveLiquidity(asset, repaid);

        AccountData storage accountData = _accountDataByUser[onBehalfOf];
        accountData.totalDebtBase = repaid >= accountData.totalDebtBase
            ? 0
            : accountData.totalDebtBase - repaid;

        if (accountData.healthFactor == 0) {
            accountData.healthFactor = 1;
        }
        accountData.healthFactor += repaid * healthFactorDeltaPerUnitRepaid;
        return repaid;
    }

    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external returns (uint256) {
        (address aTokenAddress, , ) = dataProvider.getReserveTokensAddresses(asset);
        MockERC20(aTokenAddress).burn(msg.sender, amount);

        dataProvider.reduceReserveLiquidity(asset, amount);

        IERC20(asset).transfer(to, amount);

        AccountData storage accountData = _accountDataByUser[msg.sender];
        accountData.totalCollateralBase = amount >= accountData.totalCollateralBase
            ? 0
            : accountData.totalCollateralBase - amount;

        return amount;
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
        AccountData memory data = _accountDataByUser[user];
        return (
            data.totalCollateralBase,
            data.totalDebtBase,
            data.availableBorrowsBase,
            data.currentLiquidationThreshold,
            data.ltv,
            data.healthFactor
        );
    }
}
