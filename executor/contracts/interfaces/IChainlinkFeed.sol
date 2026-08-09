// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Chainlink AggregatorV3 surface. Used for two things the
/// Aave-style `getAssetPrice(address)` oracle cannot express:
///   1. WHEN the price was written (`updatedAt`), so a delegated exit can
///      refuse to price a swap off a frozen feed;
///   2. the L2 sequencer-uptime feed, where `answer == 0` means "up" and
///      `startedAt` is when that status began.
interface IChainlinkFeed {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
