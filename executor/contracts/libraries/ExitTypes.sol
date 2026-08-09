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

    /// @notice What the signer authorised. The kind constrains the legs a
    /// submitter may pair with the permit; it is NOT a hint.
    ///  FULL_EXIT   - repay and withdraw are both allowed.
    ///  FULL_REPAY  - repay only (every leg must carry withdrawAmount == 0) and
    ///                maxRepayFractionBps must be 10000.
    ///  REDUCE      - repay only, capped by maxRepayFractionBps.
    /// Collateral can therefore never leave a position under a repay-only
    /// permit, whatever legs the submitter builds.
    enum ExitKind {
        FULL_EXIT,
        FULL_REPAY,
        REDUCE
    }

    /// @notice EIP-712 payload signed by the position owner authorising anyone
    /// to run an exit on their behalf. The permit carries no recipient and no
    /// relayer: proceeds always land on `user`, so a submitter can choose WHEN
    /// (within the signed scope) but never WHO gets paid.
    ///
    /// Field units and semantics:
    ///  user                    - the position owner AND the sole payout
    ///                            destination. Also the ECDSA/ERC-1271 signer.
    ///  kind                    - ExitKind above, as uint8.
    ///  maxRepayFractionBps     - per-leg cap on how much of the LIVE debt may
    ///                            be repaid, in basis points (10000 = all of
    ///                            it). Applied per debt type on Aave (variable
    ///                            and stable are capped separately).
    ///  triggerHealthFactorWad  - execute only while the live health factor is
    ///                            strictly BELOW this, 1e18 = HF 1.0. 0 turns
    ///                            the gate off (an execute-now permit, bounded
    ///                            by `deadline` alone).
    ///  maxSlippageBps          - worst execution the signer accepts against
    ///                            the oracle price, in basis points: the swap
    ///                            floor is oracleQuote * (10000 - this) / 10000.
    ///  protocolsMask           - bit i set means ProtocolId(i) is allowed.
    ///                            AAVE_V3 = bit 0 ... MORPHO_BLUE = bit 3.
    ///  epoch                   - the signer's revocation epoch at signing time.
    ///                            revokeAll() bumps it and orphans every permit
    ///                            signed against the previous value.
    ///  nonce                   - unordered (Permit2-style bitmap) nonce; any
    ///                            unused 256-bit value. Spent on execution and
    ///                            spendable in advance via
    ///                            invalidateUnorderedNonces.
    ///  deadline                - last block.timestamp at which this may run.
    struct ExitPermit {
        address user;
        uint8 kind;
        uint16 maxRepayFractionBps;
        uint256 triggerHealthFactorWad;
        uint16 maxSlippageBps;
        uint8 protocolsMask;
        uint256 epoch;
        uint256 nonce;
        uint256 deadline;
    }
}
