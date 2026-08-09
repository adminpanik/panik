// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho} from "../interfaces/IMorpho.sol";

/// @notice Minimal Morpho Blue singleton mock with real shares math (virtual
/// offsets), authorization gating, and a settable-unhealthy flag.
contract MockMorpho {
    uint256 private constant VIRTUAL_SHARES = 1e6;
    uint256 private constant VIRTUAL_ASSETS = 1;

    mapping(bytes32 id => IMorpho.Market) private _marketById;
    mapping(bytes32 id => mapping(address user => IMorpho.Position)) private _positionByIdUser;
    mapping(address authorizer => mapping(address authorized => bool)) private _isAuthorized;
    mapping(address user => bool) private _unhealthy;

    function marketId(IMorpho.MarketParams memory mp) public pure returns (bytes32) {
        return keccak256(abi.encode(mp));
    }

    // -- test setup -----------------------------------------------------------

    function setMarket(
        IMorpho.MarketParams calldata mp,
        uint128 totalBorrowAssets,
        uint128 totalBorrowShares
    ) external {
        IMorpho.Market storage m = _marketById[marketId(mp)];
        m.totalBorrowAssets = totalBorrowAssets;
        m.totalBorrowShares = totalBorrowShares;
    }

    function setPosition(
        IMorpho.MarketParams calldata mp,
        address user,
        uint128 borrowShares,
        uint128 collateral
    ) external {
        IMorpho.Position storage p = _positionByIdUser[marketId(mp)][user];
        p.borrowShares = borrowShares;
        p.collateral = collateral;
    }

    function setUnhealthy(address user, bool value) external {
        _unhealthy[user] = value;
    }

    // -- IMorpho --------------------------------------------------------------

    function position(bytes32 id, address user) external view returns (IMorpho.Position memory) {
        return _positionByIdUser[id][user];
    }

    function market(bytes32 id) external view returns (IMorpho.Market memory) {
        return _marketById[id];
    }

    function accrueInterest(IMorpho.MarketParams memory) external {}

    function repay(
        IMorpho.MarketParams memory mp,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid) {
        require((assets == 0) != (shares == 0), "MockMorpho: exactly one zero");
        bytes32 id = marketId(mp);
        IMorpho.Market storage m = _marketById[id];
        IMorpho.Position storage p = _positionByIdUser[id][onBehalf];

        if (shares > 0) {
            sharesRepaid = shares;
            assetsRepaid = _toAssetsUp(shares, m.totalBorrowAssets, m.totalBorrowShares);
        } else {
            assetsRepaid = assets;
            sharesRepaid = _toSharesDown(assets, m.totalBorrowAssets, m.totalBorrowShares);
        }

        require(p.borrowShares >= sharesRepaid, "MockMorpho: repay too much");
        IERC20(mp.loanToken).transferFrom(msg.sender, address(this), assetsRepaid);
        p.borrowShares -= uint128(sharesRepaid);
        m.totalBorrowShares -= uint128(sharesRepaid);
        m.totalBorrowAssets = assetsRepaid >= m.totalBorrowAssets
            ? 0
            : m.totalBorrowAssets - uint128(assetsRepaid);
    }

    function withdrawCollateral(
        IMorpho.MarketParams memory mp,
        uint256 assets,
        address onBehalf,
        address receiver
    ) external {
        require(
            msg.sender == onBehalf || _isAuthorized[onBehalf][msg.sender],
            "MockMorpho: unauthorized"
        );
        require(!_unhealthy[onBehalf], "MockMorpho: unhealthy");
        IMorpho.Position storage p = _positionByIdUser[marketId(mp)][onBehalf];
        require(p.collateral >= assets, "MockMorpho: insufficient collateral");
        p.collateral -= uint128(assets);
        IERC20(mp.collateralToken).transfer(receiver, assets);
    }

    function setAuthorization(address authorized, bool newIsAuthorized) external {
        _isAuthorized[msg.sender][authorized] = newIsAuthorized;
    }

    function isAuthorized(address authorizer, address authorized) external view returns (bool) {
        return _isAuthorized[authorizer][authorized];
    }

    function _toAssetsUp(
        uint256 shares,
        uint256 totalAssets,
        uint256 totalShares
    ) private pure returns (uint256) {
        uint256 denominator = totalShares + VIRTUAL_SHARES;
        return (shares * (totalAssets + VIRTUAL_ASSETS) + denominator - 1) / denominator;
    }

    function _toSharesDown(
        uint256 assets,
        uint256 totalAssets,
        uint256 totalShares
    ) private pure returns (uint256) {
        return (assets * (totalShares + VIRTUAL_SHARES)) / (totalAssets + VIRTUAL_ASSETS);
    }
}
