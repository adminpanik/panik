// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { PanikEscrow } from "../src/PanikEscrow.sol";

/**
 * @title  DeployPanikEscrow
 * @notice Deployment script for the PanikEscrow contract.
 *
 * @dev    Usage:
 *
 *         Base Sepolia (testnet):
 *         forge script script/Deploy.s.sol:DeployPanikEscrow \
 *           --rpc-url base_sepolia \
 *           --broadcast \
 *           --verify \
 *           -vvvv
 *
 *         Base Mainnet:
 *         forge script script/Deploy.s.sol:DeployPanikEscrow \
 *           --rpc-url base \
 *           --broadcast \
 *           --verify \
 *           -vvvv
 *
 *         Environment variables:
 *           PRIVATE_KEY           — deployer wallet private key
 *           OWNER_ADDRESS         — initial owner (team EOA or multisig)
 *           TREASURY_ADDRESS      — where released funds go
 *           USDC_ADDRESS          — ONLY used on chains other than Base (8453)
 *                                   and Base Sepolia (84532); ignored on those
 *                                   two, where the chain id decides.
 */
contract DeployPanikEscrow is Script {
    // Base Mainnet USDC
    address constant BASE_MAINNET_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    // Base Sepolia USDC (circle-issued test USDC)
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address ownerAddr = vm.envAddress("OWNER_ADDRESS");
        address treasuryAddr = vm.envAddress("TREASURY_ADDRESS");

        // The chain we are broadcasting to decides the USDC address. USDC_ADDRESS
        // is only consulted on chains we don't know about — a stale value left in
        // the shell must never be able to hardwire a mainnet escrow (the `usdc`
        // field is immutable) to a testnet token address.
        address usdcAddr;
        if (block.chainid == 8453) {
            usdcAddr = BASE_MAINNET_USDC;
        } else if (block.chainid == 84532) {
            usdcAddr = BASE_SEPOLIA_USDC;
        } else {
            try vm.envAddress("USDC_ADDRESS") returns (address envUsdc) {
                usdcAddr = envUsdc;
            } catch {
                revert("Set USDC_ADDRESS env var for this chain");
            }
        }

        console2.log("Deploying PanikEscrow...");
        console2.log("  Chain ID:  ", block.chainid);
        console2.log("  USDC:      ", usdcAddr);
        console2.log("  Owner:     ", ownerAddr);
        console2.log("  Treasury:  ", treasuryAddr);

        vm.startBroadcast(deployerKey);

        PanikEscrow escrow = new PanikEscrow(usdcAddr, ownerAddr, treasuryAddr);

        vm.stopBroadcast();

        // Post-deploy checks. Deliberately NOT re-reading `usdc`/`owner`/
        // `treasury` back out: the constructor assigns those three locals
        // unconditionally, so asserting them can only fail if solc is broken.
        // These are the ones that can actually catch a misconfiguration.

        // We are on a chain whose USDC address this script knows.
        require(
            block.chainid == 8453 || block.chainid == 84532,
            "unsupported chain: only Base (8453) and Base Sepolia (84532)"
        );

        // The escrow's economics are what the frontend and docs assume.
        require(
            escrow.refundDeadline() == block.timestamp + 90 days,
            "refundDeadline is not deploy time + 90 days"
        );
        require(escrow.DEPOSIT_AMOUNT() == 5_000_000, "DEPOSIT_AMOUNT is not 5 USDC");
        require(!escrow.shipped(), "escrow deployed already shipped");

        // The deployer key is hot; it must never also be the key that can
        // call ship() and setTreasury().
        require(ownerAddr != vm.addr(deployerKey), "owner must not be the deployer key");

        // On mainnet the owner controls real money — require a contract
        // (Safe/multisig), not an EOA.
        if (block.chainid == 8453) {
            require(ownerAddr.code.length > 0, "owner must be a multisig");
        }

        console2.log("  Escrow deployed at:", address(escrow));
    }
}
