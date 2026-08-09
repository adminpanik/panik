// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniversalRouter} from "../interfaces/IUniversalRouter.sol";

contract SwapAdapter {
    using SafeERC20 for IERC20;

    error CallerNotManager(address caller);
    error CallerNotExecutor(address caller);
    error InvalidExecutor(address executor);
    struct SwapRequest {
        address tokenIn;
        uint256 amountIn;
        uint256 amountOutMinimum;
        bytes commands;
        bytes[] inputs;
        uint256 deadline;
    }

    error InvalidTokenIn();
    error InvalidTokenOut();
    error SlippageExceeded(uint256 amountOutMinimum, uint256 actualAmountOut);

    event ExecutorUpdated(address indexed previousExecutor, address indexed newExecutor);
    event TokenRecovered(address indexed token, address indexed to, uint256 amount);

    address public immutable manager;
    IUniversalRouter public immutable universalRouter;
    address public immutable usdc;
    address public executor;

    modifier onlyManager() {
        if (msg.sender != manager) {
            revert CallerNotManager(msg.sender);
        }
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) {
            revert CallerNotExecutor(msg.sender);
        }
        _;
    }

    constructor(address universalRouter_, address usdc_) {
        require(universalRouter_ != address(0), "SwapAdapter: zero router");
        require(usdc_ != address(0), "SwapAdapter: zero usdc");

        manager = msg.sender;
        universalRouter = IUniversalRouter(universalRouter_);
        usdc = usdc_;
    }

    function setExecutor(address executor_) external onlyManager {
        if (executor_ == address(0)) {
            revert InvalidExecutor(executor_);
        }

        address previousExecutor = executor;
        executor = executor_;
        emit ExecutorUpdated(previousExecutor, executor_);
    }

    function swapToUSDC(
        SwapRequest calldata request
    ) external onlyExecutor returns (uint256 usdcOut) {
        usdcOut = _swapExactIn(request, usdc);
    }

    function swapExactIn(
        SwapRequest calldata request,
        address tokenOut
    ) external onlyExecutor returns (uint256 amountOut) {
        amountOut = _swapExactIn(request, tokenOut);
    }

    function _swapExactIn(
        SwapRequest calldata request,
        address tokenOut
    ) private returns (uint256 amountOut) {
        if (request.tokenIn == address(0)) revert InvalidTokenIn();
        if (tokenOut == address(0)) revert InvalidTokenOut();
        if (request.amountIn == 0) return 0;

        // UniversalRouter V3_SWAP_EXACT_IN with payerIsUser=false expects tokenIn to be
        // pre-funded on the router (payer = address(this) inside router modules).
        // We transfer exact input amount to the router before execute.
        uint256 tokenOutBefore = IERC20(tokenOut).balanceOf(address(this));

        IERC20(request.tokenIn).safeTransfer(
            address(universalRouter),
            request.amountIn
        );
        universalRouter.execute(
            request.commands,
            request.inputs,
            request.deadline
        );

        uint256 tokenOutAfter = IERC20(tokenOut).balanceOf(address(this));
        amountOut = tokenOutAfter - tokenOutBefore;

        if (amountOut < request.amountOutMinimum) {
            revert SlippageExceeded(request.amountOutMinimum, amountOut);
        }

        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }

    function recoverToken(
        address token,
        address to,
        uint256 amount
    ) external onlyExecutor {
        if (amount == 0) {
            return;
        }

        IERC20(token).safeTransfer(to, amount);
        emit TokenRecovered(token, to, amount);
    }
}
