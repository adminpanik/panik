// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Shared multi-protocol exit types (Phase 2).
/// One ExitLeg describes one reserve/market interaction on one protocol.
/// Amount semantics (both repayAmount and withdrawAmount):
///   0                 - skip this side of the leg entirely
///   type(uint256).max - full (all outstanding debt / all collateral)
///   anything else     - exact cap (partial repay / partial withdrawal)
/// A REDUCE is repayAmount = X with withdrawAmount = 0; a full exit is
/// max/max. Individual exits are single-element leg arrays.
library ExitTypes {
    enum ProtocolId {
        AAVE_V3,
        MOONWELL,
        COMPOUND_V3,
        MORPHO_BLUE
    }

    /// @dev Per-protocol meaning of `asset`:
    ///  AAVE_V3     - the underlying reserve address (debt and/or collateral).
    ///  MOONWELL    - the mToken address.
    ///  COMPOUND_V3 - the collateral asset (address(0) for repay-only legs);
    ///                `data` = abi.encode(address comet).
    ///  MORPHO_BLUE - the loan token; `data` = abi.encode(MarketParams).
    struct ExitLeg {
        ProtocolId protocol;
        address asset;
        uint256 repayAmount;
        uint256 withdrawAmount;
        bytes data;
    }
}
