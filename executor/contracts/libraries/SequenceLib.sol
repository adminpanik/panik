// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

library SequenceLib {
    uint256 internal constant RATE_MODE_STABLE = 1;
    uint256 internal constant RATE_MODE_VARIABLE = 2;

    struct AssetPosition {
        address asset;
        uint256 variableDebt;
        uint256 stableDebt;
        uint256 collateralAmount;
        uint256 usdPrice;
    }

    struct DebtAction {
        address asset;
        uint256 amount;
        uint256 rateMode;
    }

    struct WithdrawAction {
        address asset;
        uint256 amount;
        uint256 usdValue;
    }

    struct ExitSequence {
        DebtAction[] variableDebtRepays;
        DebtAction[] stableDebtRepays;
        WithdrawAction[] withdrawals;
        address[] swapAssets;
    }

    function buildExitSequence(
        AssetPosition[] memory positions,
        address usdc
    ) internal pure returns (ExitSequence memory sequence) {
        sequence.variableDebtRepays = _buildVariableDebtRepays(positions, usdc);
        sequence.stableDebtRepays = _buildStableDebtRepays(positions);
        sequence.withdrawals = _buildWithdrawals(positions);
        sequence.swapAssets = _buildSwapAssets(sequence.withdrawals, usdc);
    }

    function _buildVariableDebtRepays(
        AssetPosition[] memory positions,
        address usdc
    ) private pure returns (DebtAction[] memory result) {
        DebtAction[] memory actions = new DebtAction[](positions.length);
        uint256 count;

        for (uint256 i; i < positions.length; ++i) {
            AssetPosition memory p = positions[i];
            if (p.asset == usdc && p.variableDebt > 0) {
                actions[count++] = DebtAction({
                    asset: p.asset,
                    amount: p.variableDebt,
                    rateMode: RATE_MODE_VARIABLE
                });
            }
        }

        for (uint256 i; i < positions.length; ++i) {
            AssetPosition memory p = positions[i];
            if (p.asset != usdc && p.variableDebt > 0) {
                actions[count++] = DebtAction({
                    asset: p.asset,
                    amount: p.variableDebt,
                    rateMode: RATE_MODE_VARIABLE
                });
            }
        }

        result = _shrinkDebtArray(actions, count);
    }

    function _buildStableDebtRepays(
        AssetPosition[] memory positions
    ) private pure returns (DebtAction[] memory result) {
        DebtAction[] memory actions = new DebtAction[](positions.length);
        uint256 count;

        for (uint256 i; i < positions.length; ++i) {
            AssetPosition memory p = positions[i];
            if (p.stableDebt > 0) {
                actions[count++] = DebtAction({
                    asset: p.asset,
                    amount: p.stableDebt,
                    rateMode: RATE_MODE_STABLE
                });
            }
        }

        result = _shrinkDebtArray(actions, count);
    }

    function _buildWithdrawals(
        AssetPosition[] memory positions
    ) private pure returns (WithdrawAction[] memory result) {
        WithdrawAction[] memory actions = new WithdrawAction[](positions.length);
        uint256 count;

        for (uint256 i; i < positions.length; ++i) {
            AssetPosition memory p = positions[i];
            if (p.collateralAmount > 0) {
                actions[count++] = WithdrawAction({
                    asset: p.asset,
                    amount: p.collateralAmount,
                    usdValue: p.collateralAmount * p.usdPrice
                });
            }
        }

        result = _shrinkWithdrawArray(actions, count);
        _sortWithdrawalsByUsdDesc(result);
    }

    function _buildSwapAssets(
        WithdrawAction[] memory withdrawals,
        address usdc
    ) private pure returns (address[] memory result) {
        address[] memory assets = new address[](withdrawals.length);
        uint256 count;

        for (uint256 i; i < withdrawals.length; ++i) {
            if (withdrawals[i].asset != usdc) {
                assets[count++] = withdrawals[i].asset;
            }
        }

        result = _shrinkAddressArray(assets, count);
    }

    function _sortWithdrawalsByUsdDesc(
        WithdrawAction[] memory withdrawals
    ) private pure {
        // Insertion sort is enough here because assets list is expected to be small in Phase 0.
        for (uint256 i = 1; i < withdrawals.length; ++i) {
            WithdrawAction memory current = withdrawals[i];
            uint256 j = i;

            while (j > 0 && withdrawals[j - 1].usdValue < current.usdValue) {
                withdrawals[j] = withdrawals[j - 1];
                unchecked {
                    --j;
                }
            }

            withdrawals[j] = current;
        }
    }

    function _shrinkDebtArray(
        DebtAction[] memory values,
        uint256 size
    ) private pure returns (DebtAction[] memory result) {
        result = new DebtAction[](size);
        for (uint256 i; i < size; ++i) {
            result[i] = values[i];
        }
    }

    function _shrinkWithdrawArray(
        WithdrawAction[] memory values,
        uint256 size
    ) private pure returns (WithdrawAction[] memory result) {
        result = new WithdrawAction[](size);
        for (uint256 i; i < size; ++i) {
            result[i] = values[i];
        }
    }

    function _shrinkAddressArray(
        address[] memory values,
        uint256 size
    ) private pure returns (address[] memory result) {
        result = new address[](size);
        for (uint256 i; i < size; ++i) {
            result[i] = values[i];
        }
    }

}
