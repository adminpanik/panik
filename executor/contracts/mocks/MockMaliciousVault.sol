// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IBalancerFlashLoanRecipient} from "../interfaces/IFlashProviders.sol";
import {PanikDeleverager} from "../PanikDeleverager.sol";

/// @notice A compromised/buggy flash provider used to prove the deleverager's
/// callback binding: it hands the receiveFlashLoan payload back with the `user`
/// field swapped to `tamperUser`. The deleverager stored the REAL initiator in
/// `_activeUser`, so `_authFlash` must reject the mismatch with FlashParamsMismatch,
/// even though this contract is the configured (immutable) balancerVault and a
/// flash IS in progress.
contract MockMaliciousVault {
    address public tamperUser;

    function setTamperUser(address u) external {
        tamperUser = u;
    }

    function flashLoan(
        address recipient,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external {
        uint256[] memory fees = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            IERC20(tokens[i]).transfer(recipient, amounts[i]);
        }

        bytes memory payload = userData;
        if (tamperUser != address(0)) {
            (PanikDeleverager.DeleverageParams memory p, ) = abi.decode(
                userData,
                (PanikDeleverager.DeleverageParams, address)
            );
            payload = abi.encode(p, tamperUser); // swap the initiator
        }

        IBalancerFlashLoanRecipient(recipient).receiveFlashLoan(tokens, amounts, fees, payload);
    }
}
