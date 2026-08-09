// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PanikExecutor} from "../PanikExecutor.sol";
import {ExitTypes} from "../libraries/ExitTypes.sol";

/// @notice Test helper proving the onlyEOA gate rejects contract callers.
contract CallerProxy {
    function callAtomicExit(
        address executor,
        ExitTypes.ExitLeg[] calldata legs
    ) external {
        uint256[] memory emptyTokenIds = new uint256[](0);
        PanikExecutor(executor).atomicExit(legs, emptyTokenIds);
    }
}
