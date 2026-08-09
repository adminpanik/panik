// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniversalRouter} from "../interfaces/IUniversalRouter.sol";

contract MockUniversalRouter is IUniversalRouter {
    uint8 private constant COMMAND_V3_SWAP_EXACT_IN = 0x00;

    mapping(address tokenIn => uint256 rateWad) public rateWadByTokenIn;

    function setRateWad(address tokenIn, uint256 rateWad) external {
        rateWadByTokenIn[tokenIn] = rateWad;
    }

    function execute(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline
    ) external payable {
        require(block.timestamp <= deadline, "MockUR: expired");
        _execute(commands, inputs);
    }

    function execute(
        bytes calldata commands,
        bytes[] calldata inputs
    ) external payable {
        _execute(commands, inputs);
    }

    function _execute(bytes calldata commands, bytes[] calldata inputs) private {
        require(commands.length == inputs.length, "MockUR: input mismatch");

        for (uint256 i; i < commands.length; ++i) {
            require(
                uint8(commands[i]) == COMMAND_V3_SWAP_EXACT_IN,
                "MockUR: unsupported command"
            );

            (
                address recipient,
                uint256 amountIn,
                uint256 amountOutMinimum,
                bytes memory path,
                bool payerIsUser
            ) = abi.decode(
                    inputs[i],
                    (address, uint256, uint256, bytes, bool)
                );

            address tokenIn = _readFirstAddress(path);
            address tokenOut = _readLastAddress(path);

            if (payerIsUser) {
                IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
            } else {
                require(
                    IERC20(tokenIn).balanceOf(address(this)) >= amountIn,
                    "MockUR: insufficient prefund"
                );
            }

            uint256 rateWad = rateWadByTokenIn[tokenIn];
            if (rateWad == 0) {
                rateWad = 1e18;
            }

            uint256 amountOut = (amountIn * rateWad) / 1e18;
            require(amountOut >= amountOutMinimum, "MockUR: too little out");

            IERC20(tokenOut).transfer(recipient, amountOut);
        }
    }

    function _readFirstAddress(bytes memory data) private pure returns (address value) {
        require(data.length >= 20, "MockUR: short path");
        assembly {
            value := shr(96, mload(add(data, 32)))
        }
    }

    function _readLastAddress(bytes memory data) private pure returns (address value) {
        require(data.length >= 20, "MockUR: short path");
        uint256 offset = data.length - 20;
        assembly {
            value := shr(96, mload(add(add(data, 32), offset)))
        }
    }
}
