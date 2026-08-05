// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "./interfaces/IERC20.sol";

/**
 * @title  PanikEscrow
 * @notice Founding-user escrow for PANIK. Each wallet deposits exactly 5 USDC.
 *         If PANIK ships (team calls `release`), funds go to the treasury.
 *         If 90 days pass from a depositor's own deposit without release,
 *         the depositor can call `claimRefund` to get their 5 USDC back.
 *
 * @dev    Trust properties:
 *         - Refunds are claimable **forever** (no sweep, no expiry).
 *         - Once the 90-day window passes without release, the team can
 *           NEVER release that depositor's funds — they are forfeited to the user.
 *         - `release()` is per-wallet so early depositors can be released
 *           while later depositors' windows are still open.
 *         - No selfdestruct, no admin withdrawal, no upgrade proxy.
 */
contract PanikEscrow {
    // ───────────────────────── Constants ─────────────────────────────────

    /// @notice The ERC-20 token accepted (USDC on Base).
    IERC20 public immutable usdc;

    /// @notice Exactly 5 USDC (6 decimals).
    uint256 public constant DEPOSIT_AMOUNT = 5_000_000;

    /// @notice 90-day refund window.
    uint256 public constant REFUND_WINDOW = 90 days;

    // ───────────────────────── State ─────────────────────────────────────

    /// @notice Team address authorized to call `ship()`.
    address public owner;

    /// @notice Where released funds are sent.
    address public treasury;

    /// @notice Global deadline timestamp (deployment time + 90 days).
    uint256 public immutable refundDeadline;

    /// @notice Global status flag set by the team when the product launches.
    bool public shipped;

    /// @notice Block timestamp of each depositor's deposit (0 = never deposited).
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
    error ZeroAddress();
    error TransferFailed();

    // ───────────────────────── Constructor ───────────────────────────────

    /**
     * @param _usdc     USDC token address on this chain.
     * @param _owner    Initial owner (team EOA or multisig).
     * @param _treasury Address that receives released funds.
     */
    constructor(address _usdc, address _owner, address _treasury) {
        if (_usdc == address(0) || _owner == address(0) || _treasury == address(0)) {
            revert ZeroAddress();
        }
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

        // Transfer 5 USDC from depositor to this contract
        bool success = usdc.transferFrom(msg.sender, address(this), DEPOSIT_AMOUNT);
        if (!success) revert TransferFailed();

        depositTime[msg.sender] = block.timestamp;
        depositorCount++;

        emit Deposited(msg.sender, block.timestamp);
    }

    // ───────────────────────── Core: Ship ────────────────────────────────

    /**
     * @notice Ship the product and release all locked escrow funds to treasury. Owner only.
     * @dev    Reverts if the global 90-day deadline has already passed.
     */
    function ship() external onlyOwner {
        if (shipped) revert AlreadyShipped();

        // Team cannot claim funds after the global refund deadline
        if (block.timestamp >= refundDeadline) {
            revert RefundWindowPassed();
        }

        shipped = true;

        uint256 balance = usdc.balanceOf(address(this));
        if (balance > 0) {
            bool success = usdc.transfer(treasury, balance);
            if (!success) revert TransferFailed();
        }

        emit Shipped();
    }

    // ───────────────────────── Core: Refund ──────────────────────────────

    /**
     * @notice Claim your 5 USDC refund. Only callable by the depositor after
     *         the global 90-day deadline has passed, if the project didn't ship.
     * @dev    Claimable forever — no sweep, no expiry on the refund right.
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
     * @return _depositTime   Unix timestamp of deposit (0 = never)
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
     */
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }
}
