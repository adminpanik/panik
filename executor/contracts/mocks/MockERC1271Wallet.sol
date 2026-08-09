// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Minimal ERC-1271 smart-contract wallet. Returns the magic value iff
/// the signature recovers to its configured owner - enough to exercise the
/// executor's contract-signer branch. Also lets a test flip a global switch to
/// prove revocability (a contract signature can turn from valid to invalid).
contract MockERC1271Wallet {
    bytes4 private constant MAGIC = 0x1626ba7e; // IERC1271.isValidSignature.selector
    address public immutable owner;
    bool public disabled;

    constructor(address owner_) {
        owner = owner_;
    }

    function setDisabled(bool value) external {
        disabled = value;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (disabled) return 0xffffffff;
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == owner) {
            return MAGIC;
        }
        return 0xffffffff;
    }
}
