// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test, console2 } from "forge-std/Test.sol";
import { PanikEscrow } from "../src/PanikEscrow.sol";
import { IERC20 } from "forge-std/interfaces/IERC20.sol";

contract MockUSDC is IERC20 {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "not approved");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

contract PanikEscrowTest is Test {
    PanikEscrow public escrow;
    MockUSDC public usdc;

    address public owner = makeAddr("owner");
    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    uint256 constant DEPOSIT = 5_000_000; // 5 USDC
    uint256 constant WINDOW = 90 days;

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new PanikEscrow(address(usdc), owner, treasury);

        usdc.mint(alice, 100_000_000);
        usdc.mint(bob, 100_000_000);
    }

    // ─────────────── Constructor ─────────────────────────────────────────

    function test_constructor_setsState() public view {
        assertEq(address(escrow.usdc()), address(usdc));
        assertEq(escrow.owner(), owner);
        assertEq(escrow.treasury(), treasury);
        assertEq(escrow.refundDeadline(), block.timestamp + WINDOW);
        assertEq(escrow.depositorCount(), 0);
        assertFalse(escrow.shipped());
    }

    // ─────────────── Deposit ─────────────────────────────────────────────

    function test_deposit_success() public {
        vm.startPrank(alice);
        usdc.approve(address(escrow), DEPOSIT);
        escrow.deposit();
        vm.stopPrank();

        assertEq(escrow.depositTime(alice), block.timestamp);
        assertEq(escrow.depositorCount(), 1);
        assertTrue(escrow.hasPaid(alice));
        assertEq(usdc.balanceOf(address(escrow)), DEPOSIT);
    }

    function test_deposit_revertsOnDouble() public {
        vm.startPrank(alice);
        usdc.approve(address(escrow), DEPOSIT * 2);
        escrow.deposit();

        vm.expectRevert(PanikEscrow.AlreadyDeposited.selector);
        escrow.deposit();
        vm.stopPrank();
    }

    function test_deposit_revertsAfterDeadline() public {
        vm.warp(block.timestamp + WINDOW);

        vm.startPrank(alice);
        usdc.approve(address(escrow), DEPOSIT);
        vm.expectRevert(PanikEscrow.RefundWindowPassed.selector);
        escrow.deposit();
        vm.stopPrank();
    }

    function test_deposit_revertsIfShipped() public {
        // `ship()` needs a non-zero balance, so bob funds the escrow first.
        vm.prank(bob);
        usdc.approve(address(escrow), DEPOSIT);
        vm.prank(bob);
        escrow.deposit();

        vm.prank(owner);
        escrow.ship();

        vm.startPrank(alice);
        usdc.approve(address(escrow), DEPOSIT);
        vm.expectRevert(PanikEscrow.AlreadyShipped.selector);
        escrow.deposit();
        vm.stopPrank();
    }

    // ─────────────── Shipping ────────────────────────────────────────────

    function test_ship_success() public {
        vm.prank(alice);
        usdc.approve(address(escrow), DEPOSIT);
        vm.prank(alice);
        escrow.deposit();

        vm.prank(bob);
        usdc.approve(address(escrow), DEPOSIT);
        vm.prank(bob);
        escrow.deposit();

        vm.prank(owner);
        escrow.ship();

        assertTrue(escrow.shipped());
        assertEq(usdc.balanceOf(treasury), DEPOSIT * 2);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_ship_revertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(PanikEscrow.NotOwner.selector);
        escrow.ship();
    }

    function test_ship_revertsAfterDeadline() public {
        vm.warp(block.timestamp + WINDOW);

        vm.prank(owner);
        vm.expectRevert(PanikEscrow.RefundWindowPassed.selector);
        escrow.ship();
    }

    function test_ship_revertsIfAlreadyShipped() public {
        vm.prank(alice);
        usdc.approve(address(escrow), DEPOSIT);
        vm.prank(alice);
        escrow.deposit();

        vm.prank(owner);
        escrow.ship();

        vm.prank(owner);
        vm.expectRevert(PanikEscrow.AlreadyShipped.selector);
        escrow.ship();
    }

    /// @dev `shipped` is one-way and closes both `deposit()` and
    ///      `claimRefund()`. An accidental day-0 `ship()` on an empty escrow
    ///      used to set it anyway, bricking the contract permanently.
    function test_ship_revertsOnEmptyBalance() public {
        vm.prank(owner);
        vm.expectRevert(PanikEscrow.NothingToShip.selector);
        escrow.ship();

        // The contract is still fully usable: not shipped, deposits open,
        // and the refund path still reachable after the deadline.
        assertFalse(escrow.shipped());

        vm.prank(alice);
        usdc.approve(address(escrow), DEPOSIT);
        vm.prank(alice);
        escrow.deposit();
        assertEq(escrow.depositorCount(), 1);

        vm.warp(block.timestamp + WINDOW);
        vm.prank(alice);
        escrow.claimRefund();
        assertTrue(escrow.refunded(alice));
    }

    // ─────────────── Refund ──────────────────────────────────────────────

    function test_claimRefund_success() public {
        vm.startPrank(alice);
        usdc.approve(address(escrow), DEPOSIT);
        escrow.deposit();
        vm.stopPrank();

        vm.warp(block.timestamp + WINDOW);

        vm.prank(alice);
        escrow.claimRefund();

        assertTrue(escrow.refunded(alice));
        assertEq(usdc.balanceOf(alice), 100_000_000);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_claimRefund_revertsBeforeDeadline() public {
        vm.startPrank(alice);
        usdc.approve(address(escrow), DEPOSIT);
        escrow.deposit();

        vm.expectRevert(PanikEscrow.RefundWindowNotPassed.selector);
        escrow.claimRefund();
        vm.stopPrank();
    }

    function test_claimRefund_revertsIfShipped() public {
        vm.prank(alice);
        usdc.approve(address(escrow), DEPOSIT);
        vm.prank(alice);
        escrow.deposit();

        vm.prank(owner);
        escrow.ship();

        vm.warp(block.timestamp + WINDOW);

        vm.prank(alice);
        vm.expectRevert(PanikEscrow.AlreadyShipped.selector);
        escrow.claimRefund();
    }

    function test_claimRefund_revertsOnDouble() public {
        vm.prank(alice);
        usdc.approve(address(escrow), DEPOSIT);
        vm.prank(alice);
        escrow.deposit();

        vm.warp(block.timestamp + WINDOW);

        vm.prank(alice);
        escrow.claimRefund();

        vm.prank(alice);
        vm.expectRevert(PanikEscrow.AlreadyRefunded.selector);
        escrow.claimRefund();
    }

    // ─────────────── View checks ─────────────────────────────────────────

    function test_isRefundable_checks() public {
        vm.prank(alice);
        usdc.approve(address(escrow), DEPOSIT);
        vm.prank(alice);
        escrow.deposit();

        assertFalse(escrow.isRefundable(alice));

        vm.warp(block.timestamp + WINDOW);
        assertTrue(escrow.isRefundable(alice));

        vm.prank(alice);
        escrow.claimRefund();
        assertFalse(escrow.isRefundable(alice));
    }
}
