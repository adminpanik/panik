// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {INonfungiblePositionManager} from "../interfaces/INonfungiblePositionManager.sol";

contract UniswapAdapter {
    using SafeERC20 for IERC20;

    error CallerNotManager(address caller);
    error CallerNotExecutor(address caller);
    error InvalidExecutor(address executor);
    error NotOwner(uint256 tokenId, address actual, address expected);

    event ExecutorUpdated(address indexed previousExecutor, address indexed newExecutor);
    event TokenRecovered(address indexed token, address indexed to, uint256 amount);
    event PositionExited(
        uint256 indexed tokenId,
        address token0,
        address token1,
        uint256 amount0,
        uint256 amount1
    );

    address public immutable manager;
    INonfungiblePositionManager public immutable nftManager;
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

    constructor(address nftManager_) {
        require(nftManager_ != address(0), "UniswapAdapter: zero nft manager");
        manager = msg.sender;
        nftManager = INonfungiblePositionManager(nftManager_);
    }

    function setExecutor(address executor_) external onlyManager {
        if (executor_ == address(0)) {
            revert InvalidExecutor(executor_);
        }

        address previousExecutor = executor;
        executor = executor_;
        emit ExecutorUpdated(previousExecutor, executor_);
    }

    /// @notice Exit a Uniswap V3 LP position: remove 100% liquidity + collect all tokens.
    /// @dev The NFT must already be owned by this contract (transferred by executor).
    /// @param tokenId The Uniswap V3 LP NFT token ID.
    /// @return token0 The address of token0.
    /// @return amount0 The amount of token0 received.
    /// @return token1 The address of token1.
    /// @return amount1 The amount of token1 received.
    function exitPosition(
        uint256 tokenId
    )
        external
        onlyExecutor
        returns (address token0, uint256 amount0, address token1, uint256 amount1)
    {
        address owner = nftManager.ownerOf(tokenId);
        if (owner != address(this)) {
            revert NotOwner(tokenId, owner, address(this));
        }

        (
            ,
            ,
            address t0,
            address t1,
            ,
            ,
            ,
            uint128 liquidity,
            ,
            ,
            ,

        ) = nftManager.positions(tokenId);

        token0 = t0;
        token1 = t1;

        // Step 1: Remove all liquidity (if any)
        if (liquidity > 0) {
            nftManager.decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: tokenId,
                    liquidity: liquidity,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: block.timestamp
                })
            );
        }

        // Step 2: Collect all tokens (liquidity + accrued fees)
        (amount0, amount1) = nftManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: msg.sender, // send tokens back to executor
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        emit PositionExited(tokenId, token0, token1, amount0, amount1);
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
