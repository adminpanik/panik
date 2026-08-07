// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "./interfaces/IERC20.sol";

/**
 * @title  PanikEscrow
 * @notice Founding-user escrow for PANIK. Each wallet deposits exactly 5 USDC.
 *         There is ONE global deadline for the whole contract, fixed at
 *         deployment (`refundDeadline` = deploy time + 90 days) and immutable.
 *         Before that deadline the owner may call `ship()` once, which sweeps
 *         the entire USDC balance to `treasury`. After the deadline, `ship()`
 *         is permanently blocked and every depositor can call `claimRefund()`.
 *
 * @dev    Trust properties — stated precisely, including the limits:
 *         - The deadline is GLOBAL, not per depositor. A wallet that deposits
 *           on day 89 gets the same deadline as one that deposited on day 1.
 *         - `ship()` is an unconditional owner action before the deadline. The
 *           contract does not and cannot verify that anything was shipped, and
 *           the owner may call `setTreasury()` first to change the recipient.
 *           Depositors are trusting the owner's judgement for that window.
 *         - Once `block.timestamp >= refundDeadline` without `ship()`, the team
 *           is locked out permanently and the funds belong to the depositors.
 *         - Refunds are then claimable **forever** — no sweep, no expiry.
 *         - No selfdestruct, no admin withdrawal, no upgrade proxy.
 */
contract PanikEscrow {
    // ───────────────────────── Constants ─────────────────────────────────

    /// @notice The ERC-20 token accepted (USDC on Base).
    IERC20 public immutable usdc;

    /// @notice Exactly 5 USDC (6 decimals).
    uint256 public constant DEPOSIT_AMOUNT = 5_000_000;

    /// @notice Length of the single global refund window, measured from deployment.
    uint256 public constant REFUND_WINDOW = 90 days;

    // ───────────────────────── State ─────────────────────────────────────

    /// @notice Team address authorized to call `ship()`.
    address public owner;

    /// @notice Where released funds are sent.
    address public treasury;

    /// @notice The single global deadline timestamp (deployment time + 90 days).
    /// @dev    No-argument immutable — it is the same value for every depositor.
    uint256 public immutable refundDeadline;

    /// @notice Global status flag set by the team when the product launches.
    bool public shipped;

    /// @notice Block timestamp of each depositor's deposit (0 = never deposited).
    /// @dev    Used only as the "has this wallet deposited?" flag and as an
    ///         audit/record value. It does NOT feed any time math: refund
    ///         eligibility is decided solely by the global `refundDeadline`.
    mapping(address => uint256) public depositTime;

    /// @notice Whether a depositor has been refunded.
    mapping(address => bool) public refunded;

    /// @notice Total number of unique depositors.
    uint256 public depositorCount;

    // ───────────────────────── Events ────────────────────────────────────

    event Deposited(address indexed depositor, uint256 timestamp);
    event Shipped();
    event Refunded(address indexed depositor);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);

    // ───────────────────────── Errors ────────────────────────────────────

    error NotOwner();
    error AlreadyDeposited();
    error NotDeposited();
    error AlreadyShipped();
    error AlreadyRefunded();
    error RefundWindowNotPassed();
    error RefundWindowPassed();
    error NothingToShip();
    error ZeroAddress();
    error TransferFailed();
    error UnexpectedDecimals();

    // ───────────────────────── Constructor ───────────────────────────────

    /**
     * @param _usdc     USDC token address on this chain.
     * @param _owner    Initial owner (team EOA or multisig).
     * @param _treasury Address that receives released funds.
     *
     * @dev `DEPOSIT_AMOUNT` hardcodes 6 decimals, so a token with any other
     *      decimals (or an address with no token code at all) would silently
     *      change the deposit size. Reject it at deploy time instead.
     */
    constructor(address _usdc, address _owner, address _treasury) {
        if (_usdc == address(0) || _owner == address(0) || _treasury == address(0)) {
            revert ZeroAddress();
        }
        if (IERC20(_usdc).decimals() != 6) revert UnexpectedDecimals();
        usdc = IERC20(_usdc);
        owner = _owner;
        treasury = _treasury;
        refundDeadline = block.timestamp + REFUND_WINDOW;
    }

    // ───────────────────────── Modifiers ─────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ───────────────────────── Core: Deposit ─────────────────────────────

    /**
     * @notice Deposit exactly 5 USDC into escrow. One deposit per wallet.
     * @dev    Caller must have approved this contract for ≥ 5 USDC beforehand.
     */
    function deposit() external {
        if (shipped) revert AlreadyShipped();
        if (block.timestamp >= refundDeadline) revert RefundWindowPassed();
        if (depositTime[msg.sender] != 0) revert AlreadyDeposited();

        // Effects before interactions: mark the depositor first so a
        // reentrant call from a hostile token hits AlreadyDeposited.
        depositTime[msg.sender] = block.timestamp;
        depositorCount++;

        // Transfer 5 USDC from depositor to this contract
        bool success = usdc.transferFrom(msg.sender, address(this), DEPOSIT_AMOUNT);
        if (!success) revert TransferFailed();

        emit Deposited(msg.sender, block.timestamp);
    }

    // ───────────────────────── Core: Ship ────────────────────────────────

    /**
     * @notice Sweep the entire escrow balance to `treasury`. Owner only, once.
     * @dev    The only on-chain conditions are: caller is `owner`, not already
     *         shipped, `block.timestamp < refundDeadline`, and a non-zero
     *         balance to sweep. There is NO
     *         proof-of-shipping check — this is a discretionary owner action,
     *         and `treasury` can have been changed by `setTreasury()` first.
     *         Reverts once the global deadline has passed.
     *
     *         `shipped` is one-way and closes `deposit()` and `claimRefund()`
     *         forever, so an empty-balance call would brick the contract for
     *         no gain — there is nothing to sweep. Reject it instead.
     */
    function ship() external onlyOwner {
        if (shipped) revert AlreadyShipped();

        // Team cannot claim funds after the global refund deadline
        if (block.timestamp >= refundDeadline) {
            revert RefundWindowPassed();
        }

        uint256 balance = usdc.balanceOf(address(this));
        if (balance == 0) revert NothingToShip();

        shipped = true;

        bool success = usdc.transfer(treasury, balance);
        if (!success) revert TransferFailed();

        emit Shipped();
    }

    // ───────────────────────── Core: Refund ──────────────────────────────

    /**
     * @notice Claim your 5 USDC refund. Callable by the depositor once the
     *         single global deadline has passed and `ship()` was never called.
     * @dev    Claimable forever — no sweep, no expiry on the refund right.
     *         The depositor's own deposit time is irrelevant here; only
     *         `refundDeadline` gates the claim.
     */
    function claimRefund() external {
        if (shipped) revert AlreadyShipped();
        if (depositTime[msg.sender] == 0) revert NotDeposited();
        if (refunded[msg.sender]) revert AlreadyRefunded();

        if (block.timestamp < refundDeadline) {
            revert RefundWindowNotPassed();
        }

        refunded[msg.sender] = true;

        bool success = usdc.transfer(msg.sender, DEPOSIT_AMOUNT);
        if (!success) revert TransferFailed();

        emit Refunded(msg.sender);
    }

    // ───────────────────────── Views ─────────────────────────────────────

    /**
     * @notice Check if a wallet has deposited.
     */
    function hasPaid(address wallet) external view returns (bool) {
        return depositTime[wallet] != 0;
    }

    /**
     * @notice Check if a wallet's refund is currently claimable.
     */
    function isRefundable(address wallet) external view returns (bool) {
        return depositTime[wallet] != 0
            && !shipped
            && !refunded[wallet]
            && block.timestamp >= refundDeadline;
    }

    /**
     * @notice Get the deposit status for a wallet.
     * @return _depositTime   Unix timestamp of deposit (0 = never); a record
     *                        only — the refund clock is global, not per wallet
     * @return _shipped       Whether the product has been shipped globally
     * @return _refunded      Whether the depositor claimed a refund
     */
    function getDepositInfo(address wallet)
        external
        view
        returns (uint256 _depositTime, bool _shipped, bool _refunded)
    {
        return (depositTime[wallet], shipped, refunded[wallet]);
    }

    // ───────────────────────── Admin ─────────────────────────────────────

    /**
     * @notice Transfer ownership (e.g. EOA → multisig).
     */
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /**
     * @notice Update the treasury address.
     * @dev    Takes effect immediately, including for a later `ship()` call.
     *         The owner can therefore choose the sweep destination at will.
     */
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }
}
