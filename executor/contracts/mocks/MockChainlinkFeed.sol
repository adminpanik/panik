// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IChainlinkFeed} from "../interfaces/IChainlinkFeed.sol";

/// @notice Settable Chainlink-shaped feed. Serves both roles in the tests:
/// a price feed (answer = price, updatedAt = age) and an L2 sequencer-uptime
/// feed (answer 0 = up / 1 = down, startedAt = when that status began).
contract MockChainlinkFeed is IChainlinkFeed {
    uint8 private _decimals;
    int256 private _answer;
    uint256 private _startedAt;
    uint256 private _updatedAt;
    uint80 private _roundId;

    constructor(uint8 decimals_, int256 answer_) {
        _decimals = decimals_;
        _answer = answer_;
        _roundId = 1;
        _startedAt = block.timestamp;
        _updatedAt = block.timestamp;
    }

    function setAnswer(int256 answer_) external {
        _answer = answer_;
        _updatedAt = block.timestamp;
        _startedAt = block.timestamp;
        _roundId += 1;
    }

    /// @notice Set the answer without refreshing the timestamps (lets a test
    /// age a feed while the price stays put, and vice versa).
    function setAnswerAt(int256 answer_, uint256 startedAt_, uint256 updatedAt_) external {
        _answer = answer_;
        _startedAt = startedAt_;
        _updatedAt = updatedAt_;
        _roundId += 1;
    }

    function setUpdatedAt(uint256 updatedAt_) external {
        _updatedAt = updatedAt_;
    }

    function setStartedAt(uint256 startedAt_) external {
        _startedAt = startedAt_;
    }

    /// @dev Optional description, so the deploy script's "/ USD" base-currency
    /// check has something to read in a fork test. Not part of IChainlinkFeed.
    string public description = "MOCK / USD";

    function setDescription(string calldata description_) external {
        description = description_;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (_roundId, _answer, _startedAt, _updatedAt, _roundId);
    }
}
