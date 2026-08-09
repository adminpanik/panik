// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IBalancerFlashLoanRecipient} from "../interfaces/IFlashProviders.sol";

/// @notice Minimal Balancer V2 Vault flash-loan mock. Funds are pre-held by the
/// vault (funded by the test). `feeBps` defaults to 0 (mainnet Balancer fee) but
/// is settable so a fee path can be exercised. After the callback the vault
/// asserts it was made whole (amount + fee), exactly as the real Vault does.
contract MockBalancerVault {
    uint256 public feeBps;

    function setFeeBps(uint256 feeBps_) external {
        feeBps = feeBps_;
    }

    function flashLoan(
        address recipient,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external {
        uint256[] memory fees = new uint256[](tokens.length);
        uint256[] memory balBefore = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            balBefore[i] = IERC20(tokens[i]).balanceOf(address(this));
            fees[i] = (amounts[i] * feeBps) / 10_000;
            IERC20(tokens[i]).transfer(recipient, amounts[i]);
        }

        IBalancerFlashLoanRecipient(recipient).receiveFlashLoan(tokens, amounts, fees, userData);

        for (uint256 i; i < tokens.length; ++i) {
            require(
                IERC20(tokens[i]).balanceOf(address(this)) >= balBefore[i] + fees[i],
                "MockBalancer: not repaid"
            );
        }
    }
}
