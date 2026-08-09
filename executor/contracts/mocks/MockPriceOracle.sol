// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAssetOracle} from "../interfaces/IAssetOracle.sol";

contract MockPriceOracle is IAssetOracle {
    mapping(address asset => uint256 price) private _prices;

    function setPrice(address asset, uint256 price) external {
        _prices[asset] = price;
    }

    function getAssetPrice(address asset) external view returns (uint256) {
        return _prices[asset];
    }
}
