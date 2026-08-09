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
    ///  FULL_EXIT   - repay AND withdraw, both in full. maxRepayFractionBps must
    ///                be 10000; each executed leg must fully repay its live debt
    ///                and withdraw its full collateral balance or the tx reverts.
    ///  FULL_REPAY  - repay only, in full (every leg carries withdrawAmount == 0)
    ///                and maxRepayFractionBps must be 10000.
    ///  REDUCE      - repay only, exactly maxRepayFractionBps of the live debt.
    /// Collateral can therefore never leave a position under a repay-only
    /// permit, whatever legs the submitter builds; and no kind can be spent by a
    /// leg that does less than the authorised work (see maxSlippageBps note).
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
    ///                            The nonce-burn floor is NOT a field here: the
    ///                            executor derives "did the full authorised work"
    ///                            from LIVE state per leg at execution (full
    ///                            authorised repay + full withdrawal for a full
    ///                            exit, the signed fraction for a reduce), so a
    ///                            partial / 1-wei / do-nothing execution reverts
    ///                            and unwinds the nonce spend. An absolute signed
    ///                            USDC floor was rejected: it is inert for
    ///                            repay-only permits and goes stale for full
    ///                            exits, bricking the exit in the very crash it
    ///                            was signed for.
    ///  protocolsMask           - bit i set means ProtocolId(i) is allowed.
    ///                            AAVE_V3 = bit 0 ... MORPHO_BLUE = bit 3.
    ///  epoch                   - the signer's revocation epoch at signing time.
    ///                            revokeAll() sets it to an unpredictable value
    ///                            (the block number) and orphans every permit
    ///                            signed against the previous value, including
    ///                            ones pre-signed for a guessed future epoch.
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
