// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Flash-liquidity provider surfaces used by PanikDeleverager for the
/// external-flash protocols (Aave V3, Moonwell, Compound V3). Morpho Blue is
/// deleveraged through its NATIVE repay callback (see IMorphoDeleverage) and
/// needs no external flash.
///
/// Fee ordering the deleverager prefers: Balancer V2 (0%) -> Morpho singleton
/// (0%) -> Aave V3 flashLoanSimple (FLASHLOAN_PREMIUM_TOTAL bps). The provider
/// is chosen by the caller (FlashSource) because liquidity availability is an
/// off-chain, block-local fact; the on-chain contract only refuses cleanly with
/// FlashLiquidityInsufficient when a chosen source cannot serve the amount.

/// @dev Balancer V2 Vault. flashLoan calls back `receiveFlashLoan` on the
/// recipient, which must return tokens[i] + feeAmounts[i] to the Vault before
/// the call ends. Base Vault: 0xBA12222222228d8Ba445958a75a0704d566BF2C8.
interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external;
}

/// @dev Balancer flash-loan recipient callback. `tokens` are IERC20 addresses;
/// repayment is a plain transfer of amount+fee back to msg.sender (the Vault).
interface IBalancerFlashLoanRecipient {
    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external;
}

/// @dev Aave V3 Pool flash surface (only what the deleverager needs; kept
/// separate from the exit-flow IAavePool so v2's interface is untouched).
interface IAaveFlashPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /// @return the flash premium in basis points (e.g. 5 == 0.05%).
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);

    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external returns (uint256);

    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    function getUserAccountData(
        address user
    )
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

/// @dev Aave V3 flashLoanSimple receiver. Return true and leave amount+premium
/// approved to the Pool (the Pool pulls it after the callback returns).
interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/// @dev Morpho Blue singleton flash loan (0% fee). Calls back
/// `onMorphoFlashLoan`; leave `assets` approved to Morpho on return.
interface IMorphoFlash {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IMorphoFlashLoanCallback {
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}
