// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IAaveProtocolDataProvider} from "./interfaces/IAaveProtocolDataProvider.sol";
import {IAssetOracle} from "./interfaces/IAssetOracle.sol";
import {IChainlinkFeed} from "./interfaces/IChainlinkFeed.sol";
import {IComet} from "./interfaces/IComet.sol";
import {IMorpho} from "./interfaces/IMorpho.sol";
import {IMToken} from "./interfaces/IMToken.sol";
import {INonfungiblePositionManager} from "./interfaces/INonfungiblePositionManager.sol";
import {LockChecker} from "./LockChecker.sol";
import {ExitTypes} from "./libraries/ExitTypes.sol";
import {SequenceLib} from "./libraries/SequenceLib.sol";
import {AaveAdapter} from "./adapters/AaveAdapter.sol";
import {CompoundV3Adapter} from "./adapters/CompoundV3Adapter.sol";
import {MoonwellAdapter} from "./adapters/MoonwellAdapter.sol";
import {MorphoAdapter} from "./adapters/MorphoAdapter.sol";
import {SwapAdapter} from "./adapters/SwapAdapter.sol";
import {UniswapAdapter} from "./adapters/UniswapAdapter.sol";

/// @notice Multi-protocol atomic exit (Phase 2): Aave V3, Moonwell,
/// Compound V3 (Comet) and Morpho Blue legs in ONE transaction - repay debt
/// (wallet-funded), withdraw collateral, swap everything to USDC, sweep to the
/// user. Amount semantics per leg: 0 = skip, type(uint256).max = full,
/// otherwise the exact cap. Individual exits are single-element leg arrays.
///
/// Phase 2.A adds `atomicExitFor`: the same exit, run by ANYONE against an
/// EIP-712 permit the position owner signed. There is no relayer allowlist and
/// no owner. Safety comes from scope, not from caller identity:
///   - the payout destination is always the signer (no recipient parameter
///     exists anywhere in the delegated path);
///   - the funds moved are the signer's own, pulled under the signer's own
///     ERC-20 allowances, and capped by their live debt;
///   - WHEN it may run is gated by the signed trigger health factor and
///     deadline, and HOW BADLY it may execute by the signed slippage floor.
/// A submitter can therefore only pick a moment inside the signed window; it
/// can never redirect value. Adding an allowlist would buy nothing and would
/// re-introduce the privileged role this contract deliberately does not have.
contract PanikExecutor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error CallerNotEOA();
    error LockedPositions(address[] lockedAssets);
    error InsufficientDebtAssetBalance(
        address asset,
        uint256 requiredAmount,
        uint256 availableAmount
    );
    error MissingSwapRoute(address asset);
    error InvalidMinOutBps(address asset, uint16 minOutBps);
    error PriceUnavailable(address asset);
    error MissingAToken(address asset);
    error InvalidOracleDecimals(uint8 decimals);
    error InvalidTrackedAsset(address asset);
    error DuplicateAsset(address asset);
    error InvalidRepayAmount(address asset, uint256 attemptedAmount, uint256 repaidAmount);
    error EmptyExit();

    // --- delegated execution (Phase 2.A) ---
    error PermitUserMismatch(address user, address permitUser);
    error InvalidSignature();
    error PermitExpired(uint256 deadline, uint256 currentTimestamp);
    error PermitRevoked(uint256 permitEpoch, uint256 currentEpoch);
    error NonceAlreadyUsed(address user, uint256 nonce);
    error InvalidPermitKind(uint8 kind);
    error InvalidRepayFraction(uint16 maxRepayFractionBps);
    error InvalidPermitSlippage(uint16 maxSlippageBps, uint16 maxAllowedBps);
    error ProtocolNotPermitted(uint8 protocol);
    error WithdrawNotPermitted(uint8 kind);
    error EmptyLeg(uint8 protocol, address asset);
    error RepayFloorNotMet(uint8 protocol, address asset, uint256 repaid, uint256 required);
    error WithdrawFloorNotMet(uint8 protocol, address asset, uint256 withdrawn, uint256 required);
    error NoWorkDone(uint8 protocol, address asset);
    error MarketNotPermitted(address market);
    error AssetNotTracked(address asset);
    error UniswapLegNotPermitted();
    error TriggerNotMet(uint8 protocol, uint256 liveHf, uint256 trigger);
    error TriggerUnsupported(uint8 protocol);
    error MissingPriceFeed(address asset);
    error StalePrice(address asset, uint256 updatedAt, uint256 currentTimestamp);
    error SequencerDown(int256 answer);
    error SequencerGracePeriodNotOver(uint256 startedAt, uint256 readyAt);

    event ExitCompleted(
        address user,
        uint256 usdcReceived,
        address[] closed,
        address[] locked
    );
    event LegClosed(address indexed user, ExitTypes.ProtocolId protocol, address asset);
    event DelegatedExitExecuted(
        address indexed user,
        address indexed submitter,
        uint256 nonce,
        uint256 usdcReceived
    );
    event UnorderedNonceInvalidation(address indexed user, uint256 wordPos, uint256 mask);
    event AllPermitsRevoked(address indexed user, uint256 epoch);

    uint256 public constant AMOUNT_FULL = type(uint256).max;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 private constant WAD = 1e18;

    /// @dev Common scale every delegated price is normalised to. The ratio
    /// assetPrice/usdcPrice is what the floor uses, so the exponent only has to
    /// be IDENTICAL on both sides - it is fixed at 8 to match the Aave-style
    /// oracle base currency this repo has always assumed (and which the mock
    /// oracle mirrors on testnet).
    uint8 private constant DELEGATED_PRICE_DECIMALS = 8;

    /// @dev Provable upper bound on a health factor known only to be < 1.0.
    /// Moonwell's Comptroller reports shortfall, not a ratio; a nonzero
    /// shortfall proves HF < 1 exactly (Compound V2 uses ONE collateral factor
    /// for both borrow capacity and liquidation) but says nothing finer. Using
    /// the bound keeps the gate conservative: it can refuse an exit that would
    /// in fact have qualified, and can never fire one that would not.
    uint256 private constant HF_BOUND_BELOW_ONE = WAD - 1;

    /// @dev EIP-712 domain, built here rather than inherited from OZ's EIP712.
    /// That contract transitively reaches OZ's Bytes.sol, which calls the
    /// `mcopy` BUILTIN directly in inline assembly. That builtin exists only at
    /// evmVersion >= cancun; under the pinned `paris` target solc rejects it as
    /// a DeclarationError ("Function mcopy not found") and the whole import tree
    /// fails to compile - verified, not assumed. (This is distinct from the
    /// compiler EMITTING an MCOPY opcode for its own memory copies, which it
    /// only does at cancun+ and otherwise lowers to a loop; that would have been
    /// fine.) What remains here is a keccak of ABI-encoded constants - no
    /// cryptography is hand-rolled; recovery still goes through OZ's ECDSA.
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("PanikExecutor");
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256("2");

    bytes32 private constant EXIT_PERMIT_TYPEHASH =
        keccak256(
            "ExitPermit(address user,uint8 kind,uint16 maxRepayFractionBps,uint256 triggerHealthFactorWad,uint16 maxSlippageBps,uint8 protocolsMask,uint256 epoch,uint256 nonce,uint256 deadline)"
        );

    address public immutable usdc;
    IAaveProtocolDataProvider public immutable dataProvider;
    IAssetOracle public immutable marketOracle;
    IAssetOracle public immutable mockOracle;
    LockChecker public immutable lockChecker;
    AaveAdapter public immutable aaveAdapter;
    MoonwellAdapter public immutable moonwellAdapter;
    CompoundV3Adapter public immutable compoundAdapter;
    MorphoAdapter public immutable morphoAdapter;
    SwapAdapter public immutable swapAdapter;
    UniswapAdapter public immutable uniswapAdapter;
    INonfungiblePositionManager public immutable nftManager;
    uint256 public immutable swapDeadlineBuffer;

    /// @notice Maximum age, in seconds, of a price feed answer used to floor a
    /// DELEGATED swap. Older than this and the exit reverts rather than pricing
    /// against a frozen feed.
    uint256 public immutable oracleStalenessSeconds;
    /// @notice Chainlink L2 sequencer-uptime feed. address(0) skips the check -
    /// intended only for chains that do not publish one (Base Sepolia).
    address public immutable sequencerUptimeFeed;
    /// @notice Seconds to wait after the sequencer comes back up before
    /// delegated exits are allowed again (orders queued during the outage land
    /// first and can move the price).
    uint256 public immutable sequencerGracePeriod;
    /// @notice Ceiling on ExitPermit.maxSlippageBps. A user could otherwise
    /// sign away 100% of their proceeds; immutable so nobody can raise it later.
    uint16 public immutable maxPermitSlippageBps;

    mapping(address asset => bytes path) private _swapPathByAsset;
    mapping(address asset => uint16 minOutBps) private _swapMinOutBpsByAsset;
    mapping(address asset => bool enabled) private _swapEnabledByAsset;
    mapping(address asset => bool useMock) private _useMockOracleByAsset;
    mapping(address asset => bool tracked) private _trackedAssetByAsset;
    address[] private _trackedAssets;

    mapping(address asset => address feed) private _priceFeedByAsset;
    /// @dev Feed answer decimals, read and range-checked ONCE at construction so
    /// a wrong-decimals feed cannot silently produce a near-zero (robbery)
    /// floor at execution time. Bounded to <= 18 so _scalePrice cannot overflow.
    mapping(address asset => uint8 decimals) private _priceFeedDecimalsByAsset;
    /// @dev Markets a permit may name: Moonwell mTokens and Comet instances.
    /// Both are called with attacker-chosen calldata in the delegated path
    /// (`leg.asset` / `leg.data`), and both hand out an ERC-20 approval on the
    /// way through, so an unregistered address is a direct theft vector. Aave
    /// and Morpho need no registry: the Aave pool and the Morpho singleton are
    /// immutable inside their adapters, and everything moved there is bounded
    /// by what those protocols say the user actually owes or owns.
    mapping(address market => bool allowed) private _delegatedMarketAllowed;
    address[] private _delegatedMarkets;

    /// @notice Permit2-style unordered nonces: bit `nonce % 256` of word
    /// `nonce / 256`. Set means spent.
    mapping(address user => mapping(uint256 wordPos => uint256 bitmap)) public nonceBitmap;
    /// @notice Bumped by revokeAll(); a permit is only valid while its signed
    /// `epoch` equals this.
    mapping(address user => uint256 epoch) public revocationEpoch;

    struct AdapterAddresses {
        address aave;
        address moonwell;
        address compound;
        address morpho;
        address swap;
        address uniswap;
    }

    struct SwapConfigInput {
        address[] assets;
        bytes[] paths;
        uint16[] minOutBps;
    }

    /// @notice Everything the delegated path needs that v1 had no use for.
    struct DelegatedConfig {
        address[] priceFeedAssets;
        address[] priceFeeds;
        uint256 oracleStalenessSeconds;
        address sequencerUptimeFeed;
        uint256 sequencerGracePeriod;
        uint16 maxPermitSlippageBps;
        address[] markets;
    }

    /// @dev Per-execution context. It exists so the leg processors can serve
    /// both entrypoints without a second copy: on the self-serve path `user` is
    /// msg.sender, the repay cap is 100% and the swap floor is v1's frozen
    /// per-asset minOutBps; on the delegated path all three come from the
    /// signed permit.
    struct ExecContext {
        address user;
        uint16 maxRepayBps;
        bool permitFloor;
        uint16 maxSlippageBps;
    }

    modifier onlyEOA() {
        if (msg.sender != tx.origin) revert CallerNotEOA();
        _;
    }

    constructor(
        address usdc_,
        address dataProvider_,
        address marketOracle_,
        address mockOracle_,
        address lockChecker_,
        AdapterAddresses memory adapters_,
        address nftManager_,
        SwapConfigInput memory swapConfig_,
        address[] memory mockOracleAssets_,
        address[] memory trackedAssets_,
        uint256 swapDeadlineBuffer_,
        DelegatedConfig memory delegated_
    ) {
        require(usdc_ != address(0), "PanikExecutor: zero usdc");
        require(dataProvider_ != address(0), "PanikExecutor: zero data provider");
        require(lockChecker_ != address(0), "PanikExecutor: zero lock checker");
        require(adapters_.aave != address(0), "PanikExecutor: zero aave adapter");
        require(adapters_.moonwell != address(0), "PanikExecutor: zero moonwell adapter");
        require(adapters_.compound != address(0), "PanikExecutor: zero compound adapter");
        require(adapters_.morpho != address(0), "PanikExecutor: zero morpho adapter");
        require(adapters_.swap != address(0), "PanikExecutor: zero swap adapter");
        require(adapters_.uniswap != address(0), "PanikExecutor: zero uniswap adapter");
        require(nftManager_ != address(0), "PanikExecutor: zero nft manager");
        require(
            swapConfig_.assets.length == swapConfig_.paths.length &&
                swapConfig_.assets.length == swapConfig_.minOutBps.length,
            "PanikExecutor: swap config length mismatch"
        );
        require(
            delegated_.priceFeedAssets.length == delegated_.priceFeeds.length,
            "PanikExecutor: price feed length mismatch"
        );
        // A zero bound would accept any age; the delegated slippage floor is
        // only worth having if the price behind it is known to be recent.
        require(
            delegated_.oracleStalenessSeconds > 0,
            "PanikExecutor: zero staleness bound"
        );
        require(
            delegated_.maxPermitSlippageBps > 0 &&
                delegated_.maxPermitSlippageBps < BPS_DENOMINATOR,
            "PanikExecutor: invalid max permit slippage"
        );
        // The mock-oracle branch of _getFreshAssetPrice trusts a hand-set price
        // with no staleness or positivity guarantee - a testnet-only escape
        // hatch. Refuse to construct with any mock asset on Base mainnet so it
        // can never reach the delegated slippage floor there.
        require(
            mockOracleAssets_.length == 0 || block.chainid != 8453,
            "PanikExecutor: mock oracle on mainnet"
        );

        usdc = usdc_;
        dataProvider = IAaveProtocolDataProvider(dataProvider_);
        marketOracle = IAssetOracle(marketOracle_);
        mockOracle = IAssetOracle(mockOracle_);
        lockChecker = LockChecker(lockChecker_);
        aaveAdapter = AaveAdapter(adapters_.aave);
        // payable(): MoonwellAdapter has a receive() so Moonwell's mWETH redeem
        // (which pays NATIVE ETH) does not revert. Compile-time cast only - it
        // emits no code and leaves this contract's bytecode unchanged.
        moonwellAdapter = MoonwellAdapter(payable(adapters_.moonwell));
        compoundAdapter = CompoundV3Adapter(adapters_.compound);
        morphoAdapter = MorphoAdapter(adapters_.morpho);
        swapAdapter = SwapAdapter(adapters_.swap);
        uniswapAdapter = UniswapAdapter(adapters_.uniswap);
        nftManager = INonfungiblePositionManager(nftManager_);
        swapDeadlineBuffer = swapDeadlineBuffer_;

        _trackAsset(usdc_);
        for (uint256 i; i < swapConfig_.assets.length; ++i) {
            _swapPathByAsset[swapConfig_.assets[i]] = swapConfig_.paths[i];
            _swapMinOutBpsByAsset[swapConfig_.assets[i]] = swapConfig_.minOutBps[i];
            _swapEnabledByAsset[swapConfig_.assets[i]] = true;
            _trackAsset(swapConfig_.assets[i]);
        }

        for (uint256 i; i < mockOracleAssets_.length; ++i) {
            _useMockOracleByAsset[mockOracleAssets_[i]] = true;
            _trackAsset(mockOracleAssets_[i]);
        }

        for (uint256 i; i < trackedAssets_.length; ++i) {
            _trackAsset(trackedAssets_[i]);
        }

        oracleStalenessSeconds = delegated_.oracleStalenessSeconds;
        sequencerUptimeFeed = delegated_.sequencerUptimeFeed;
        sequencerGracePeriod = delegated_.sequencerGracePeriod;
        maxPermitSlippageBps = delegated_.maxPermitSlippageBps;

        for (uint256 i; i < delegated_.priceFeedAssets.length; ++i) {
            address feedAsset = delegated_.priceFeedAssets[i];
            address feed = delegated_.priceFeeds[i];
            require(feed != address(0), "PanikExecutor: zero price feed");
            // An asset routed through the mock oracle must not also carry a real
            // feed: the two branches would disagree and the mock (unguarded)
            // one wins in _getFreshAssetPrice. Force a single source per asset.
            require(
                !_useMockOracleByAsset[feedAsset],
                "PanikExecutor: feed/mock overlap"
            );
            // Read the feed's decimals once and range-check here rather than
            // trusting an unbounded runtime read (M-2).
            uint8 feedDecimals = IChainlinkFeed(feed).decimals();
            require(feedDecimals <= 18, "PanikExecutor: feed decimals too high");
            _priceFeedByAsset[feedAsset] = feed;
            _priceFeedDecimalsByAsset[feedAsset] = feedDecimals;
            _trackAsset(feedAsset);
        }

        for (uint256 i; i < delegated_.markets.length; ++i) {
            address market = delegated_.markets[i];
            require(market != address(0), "PanikExecutor: zero market");
            if (_delegatedMarketAllowed[market]) continue;
            _delegatedMarketAllowed[market] = true;
            _delegatedMarkets.push(market);
        }
    }

    /// @notice Atomic multi-protocol exit. Each leg: repay (wallet-funded),
    /// withdraw collateral, swap to USDC. Uniswap V3 LP exits ride along.
    function atomicExit(
        ExitTypes.ExitLeg[] calldata legs,
        uint256[] calldata uniswapTokenIds
    ) external nonReentrant onlyEOA {
        // Self-serve semantics, unchanged from v1: the caller acts on their own
        // position, may repay all of it, and is floored by the deploy-time
        // per-asset minOutBps.
        _exit(
            ExecContext({
                user: msg.sender,
                maxRepayBps: uint16(BPS_DENOMINATOR),
                permitFloor: false,
                maxSlippageBps: 0
            }),
            legs,
            uniswapTokenIds
        );
    }

    /// @notice The same exit, submitted by anyone against a permit the position
    /// owner signed. Proceeds go to `user` and nowhere else.
    /// @param user position owner; must equal `permit.user`, so a permit signed
    /// by A can never be replayed against B's position.
    /// @param uniswapTokenIds must be empty: an ExitPermit has no field naming
    /// LP token ids, so there is nothing for a signature to scope them by.
    function atomicExitFor(
        address user,
        ExitTypes.ExitLeg[] calldata legs,
        uint256[] calldata uniswapTokenIds,
        ExitTypes.ExitPermit calldata permit,
        bytes calldata signature
    ) external nonReentrant {
        if (uniswapTokenIds.length != 0) revert UniswapLegNotPermitted();
        if (legs.length == 0) revert EmptyExit();
        if (permit.user != user) revert PermitUserMismatch(user, permit.user);

        // Checks-effects-interactions: the nonce is spent before any external
        // call, so a reentering token cannot replay the same permit.
        _consumePermit(permit, signature);
        _validatePermitScope(permit, legs);
        _checkSequencer();
        _assertTriggerMet(permit, legs);

        uint256 usdcReceived = _exit(
            ExecContext({
                user: user,
                maxRepayBps: permit.maxRepayFractionBps,
                permitFloor: true,
                maxSlippageBps: permit.maxSlippageBps
            }),
            legs,
            uniswapTokenIds
        );

        emit DelegatedExitExecuted(user, msg.sender, permit.nonce, usdcReceived);
    }

    /// @notice Spend nonce bits without executing anything: `mask` bits set in
    /// word `wordPos` become unusable. Effective in the next block, and in this
    /// one for anything mined after it.
    function invalidateUnorderedNonces(uint256 wordPos, uint256 mask) external {
        nonceBitmap[msg.sender][wordPos] |= mask;
        emit UnorderedNonceInvalidation(msg.sender, wordPos, mask);
    }

    /// @notice Orphan every outstanding permit at once by moving the epoch the
    /// signature must commit to. Only the signer can call it for themselves -
    /// there is no admin able to revoke, and none able to un-revoke.
    /// @dev The new epoch is `block.number`, not a +1 increment. An increment
    /// is predictable: a submitter who already holds a permit for epoch N could
    /// pre-sign one for N+1 that survives the revocation and activates on the
    /// next revokeAll. Binding the epoch to the block the revocation lands in
    /// makes the target unguessable, so revokeAll is a true kill switch for
    /// everything signed beforehand. Same block twice is a harmless no-op (the
    /// epoch is unchanged and every prior permit was already dead).
    /// @dev The epoch rides in the signed struct rather than in the EIP-712
    /// domain salt: a domain must stay constant per contract for wallets and
    /// verifiers to cache and reproduce it, and a per-user salt would make the
    /// domain separator user-dependent - unusual, and every client would have
    /// to recompute it anyway. Same immediacy, far less surprise.
    function revokeAll() external {
        uint256 epoch = block.number;
        revocationEpoch[msg.sender] = epoch;
        emit AllPermitsRevoked(msg.sender, epoch);
    }

    // ------------------------------------------------- delegated views --

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparator();
    }

    /// @notice ERC-5267 domain description, so a client can rebuild the domain
    /// without hardcoding it.
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        )
    {
        return (
            hex"0f", // name, version, chainId, verifyingContract
            "PanikExecutor",
            "2",
            block.chainid,
            address(this),
            bytes32(0),
            new uint256[](0)
        );
    }

    /// @notice The EIP-712 digest a signer must sign for `permit`.
    function hashExitPermit(
        ExitTypes.ExitPermit calldata permit
    ) public view returns (bytes32) {
        return _hashTypedData(_hashPermitStruct(permit));
    }

    function isNonceUsed(address user, uint256 nonce) external view returns (bool) {
        return nonceBitmap[user][nonce >> 8] & (1 << uint8(nonce)) != 0;
    }

    function getPriceFeed(address asset) external view returns (address) {
        return _priceFeedByAsset[asset];
    }

    function getPriceFeedDecimals(address asset) external view returns (uint8) {
        return _priceFeedDecimalsByAsset[asset];
    }

    function isDelegatedMarket(address market) external view returns (bool) {
        return _delegatedMarketAllowed[market];
    }

    function getDelegatedMarkets() external view returns (address[] memory) {
        return _delegatedMarkets;
    }

    function getSwapConfig(
        address asset
    )
        external
        view
        returns (bool enabled, bytes memory path, uint16 minOutBps, bool useMockOracle)
    {
        return (
            _swapEnabledByAsset[asset],
            _swapPathByAsset[asset],
            _swapMinOutBpsByAsset[asset],
            _useMockOracleByAsset[asset]
        );
    }

    function getTrackedAssets() external view returns (address[] memory) {
        return _trackedAssets;
    }

    // ------------------------------------------------------ exit engine --

    /// @dev The one exit implementation. Both entrypoints reach the protocols
    /// through here; only `ctx` differs.
    function _exit(
        ExecContext memory ctx,
        ExitTypes.ExitLeg[] calldata legs,
        uint256[] calldata uniswapTokenIds
    ) private returns (uint256 usdcReceived) {
        if (legs.length == 0 && uniswapTokenIds.length == 0) revert EmptyExit();
        _validateUniqueLegs(legs);

        address[] memory locked;
        if (legs.length > 0) {
            locked = lockChecker.getLockedLegs(ctx.user, legs);
            if (locked.length > 0) revert LockedPositions(locked);
        } else {
            locked = new address[](0);
        }

        uint256 usdcBefore = IERC20(usdc).balanceOf(address(this));
        address[] memory closedTemp = new address[](legs.length);
        uint256 closedCount;

        // --- Phase 1: Aave V3 legs (SequenceLib ordering: USDC debt first,
        // withdrawals USD-descending, HF-improvement assertion) ---
        closedCount = _processAaveLegs(ctx, legs, closedTemp, closedCount);

        // --- Phases 2-4: Moonwell, Compound V3, Morpho Blue legs ---
        for (uint256 i; i < legs.length; ++i) {
            ExitTypes.ExitLeg calldata leg = legs[i];
            if (leg.protocol == ExitTypes.ProtocolId.MOONWELL) {
                if (_processMoonwellLeg(ctx, leg)) closedTemp[closedCount++] = leg.asset;
            } else if (leg.protocol == ExitTypes.ProtocolId.COMPOUND_V3) {
                if (_processCometLeg(ctx, leg)) closedTemp[closedCount++] = leg.asset;
            } else if (leg.protocol == ExitTypes.ProtocolId.MORPHO_BLUE) {
                if (_processMorphoLeg(ctx, leg)) closedTemp[closedCount++] = leg.asset;
            }
        }

        // --- Phase 5: Uniswap V3 LP exits (dormant in the main app) ---
        for (uint256 i; i < uniswapTokenIds.length; ++i) {
            _exitUniswapPosition(ctx, uniswapTokenIds[i]);
        }

        // --- Phase 6: USDC sweep ---
        usdcReceived = IERC20(usdc).balanceOf(address(this)) - usdcBefore;
        if (usdcReceived > 0) {
            IERC20(usdc).safeTransfer(ctx.user, usdcReceived);
        }

        // The nonce-burn floor is NOT here. An end-of-exit USDC floor is inert
        // for repay-only permits (no USDC is swept, so any floor is 0) and stale
        // for full exits (an absolute figure signed pre-crash bricks the exit in
        // the crash it was signed for). Instead each leg enforces its own
        // execution-time-RELATIVE floor as it runs (full authorised repay /
        // full withdrawal / real work done), so a partial or do-nothing
        // execution reverts before reaching here and unwinds the nonce spend.

        emit ExitCompleted(ctx.user, usdcReceived, _shrink(closedTemp, closedCount), locked);
    }

    // ---------------------------------------------------------------- Aave --

    function _processAaveLegs(
        ExecContext memory ctx,
        ExitTypes.ExitLeg[] calldata legs,
        address[] memory closedTemp,
        uint256 closedCount
    ) private returns (uint256) {
        uint256 aaveCount;
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].protocol == ExitTypes.ProtocolId.AAVE_V3) aaveCount++;
        }
        if (aaveCount == 0) return closedCount;

        SequenceLib.AssetPosition[] memory positions = new SequenceLib.AssetPosition[](aaveCount);
        uint256 p;
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].protocol != ExitTypes.ProtocolId.AAVE_V3) continue;
            positions[p++] = _buildAavePosition(ctx, legs[i]);
        }

        SequenceLib.ExitSequence memory sequence = SequenceLib.buildExitSequence(positions, usdc);

        (, uint256 totalDebtBaseBefore, , , , uint256 healthFactorBefore) = aaveAdapter
            .getUserAccountData(ctx.user);

        bool didRepay;
        didRepay = _repayAaveDebtActions(ctx, sequence.variableDebtRepays) || didRepay;
        didRepay = _repayAaveDebtActions(ctx, sequence.stableDebtRepays) || didRepay;

        if (didRepay && totalDebtBaseBefore > 0) {
            aaveAdapter.assertHealthFactorImproved(ctx.user, healthFactorBefore);
        }

        for (uint256 i; i < sequence.withdrawals.length; ++i) {
            SequenceLib.WithdrawAction memory action = sequence.withdrawals[i];
            if (action.amount == 0) continue;
            uint256 withdrawn = _withdrawAaveCollateralFromUser(
                ctx.user,
                action.asset,
                action.amount
            );
            if (withdrawn == 0) continue;
            closedTemp[closedCount++] = action.asset;
            emit LegClosed(ctx.user, ExitTypes.ProtocolId.AAVE_V3, action.asset);
            if (action.asset != usdc) {
                _swapAssetToUsdc(ctx, action.asset, withdrawn);
            }
        }
        return closedCount;
    }

    function _buildAavePosition(
        ExecContext memory ctx,
        ExitTypes.ExitLeg calldata leg
    ) private view returns (SequenceLib.AssetPosition memory) {
        (
            uint256 currentATokenBalance,
            uint256 currentStableDebt,
            uint256 currentVariableDebt,
            ,
            ,
            ,
            ,
            ,

        ) = dataProvider.getUserReserveData(leg.asset, ctx.user);

        // Repay cap: variable debt first, remainder to stable.
        uint256 variableDebt;
        uint256 stableDebt;
        if (leg.repayAmount == AMOUNT_FULL) {
            variableDebt = currentVariableDebt;
            stableDebt = currentStableDebt;
        } else if (leg.repayAmount > 0) {
            variableDebt = _min(currentVariableDebt, leg.repayAmount);
            stableDebt = _min(currentStableDebt, leg.repayAmount - variableDebt);
        }

        // Permit cap: a fraction of the LIVE debt, applied to each rate mode
        // separately so "reduce by 50%" cannot become "close the variable side
        // entirely" on an account holding both.
        variableDebt = _capRepay(ctx, variableDebt, currentVariableDebt);
        stableDebt = _capRepay(ctx, stableDebt, currentStableDebt);

        // Relative repay floor (delegated path): each rate mode must repay its
        // full authorised amount, so a 1-wei / partial repayAmount reverts and
        // unwinds the nonce. Checked per rate mode to match how the cap is
        // applied (no cross-rate rounding gap).
        if (ctx.permitFloor && leg.repayAmount > 0) {
            uint256 authorizedVariable = _capRepay(ctx, currentVariableDebt, currentVariableDebt);
            uint256 authorizedStable = _capRepay(ctx, currentStableDebt, currentStableDebt);
            if (variableDebt < authorizedVariable || stableDebt < authorizedStable) {
                revert RepayFloorNotMet(
                    uint8(ExitTypes.ProtocolId.AAVE_V3),
                    leg.asset,
                    variableDebt + stableDebt,
                    authorizedVariable + authorizedStable
                );
            }
        }

        uint256 collateralAmount;
        if (leg.withdrawAmount == AMOUNT_FULL) {
            collateralAmount = currentATokenBalance;
        } else {
            collateralAmount = _min(currentATokenBalance, leg.withdrawAmount);
        }

        // A withdraw is only ever authorised by a FULL_EXIT: take all of it.
        if (leg.withdrawAmount > 0) {
            _assertWithdrawFloor(
                ctx,
                ExitTypes.ProtocolId.AAVE_V3,
                leg.asset,
                collateralAmount,
                currentATokenBalance
            );
        }

        // Dynamic no-op guard: the leg must actually move debt or collateral.
        _assertWorkDone(
            ctx,
            ExitTypes.ProtocolId.AAVE_V3,
            leg.asset,
            variableDebt + stableDebt > 0 || collateralAmount > 0
        );

        return
            SequenceLib.AssetPosition({
                asset: leg.asset,
                variableDebt: variableDebt,
                stableDebt: stableDebt,
                collateralAmount: collateralAmount,
                usdPrice: _getAssetPrice(leg.asset)
            });
    }

    function _repayAaveDebtActions(
        ExecContext memory ctx,
        SequenceLib.DebtAction[] memory actions
    ) private returns (bool repaidAny) {
        for (uint256 i; i < actions.length; ++i) {
            SequenceLib.DebtAction memory action = actions[i];
            if (action.amount == 0) continue;

            _pullFromUser(ctx, action.asset, action.amount, address(aaveAdapter));
            uint256 repaid = aaveAdapter.repay(
                action.asset,
                action.amount,
                action.rateMode,
                ctx.user
            );

            if (repaid > action.amount) {
                revert InvalidRepayAmount(action.asset, action.amount, repaid);
            }

            if (repaid < action.amount) {
                uint256 refundable = action.amount - repaid;
                uint256 adapterBalance = IERC20(action.asset).balanceOf(address(aaveAdapter));
                uint256 recoverable = _min(refundable, adapterBalance);
                if (recoverable > 0) {
                    aaveAdapter.recoverToken(action.asset, address(this), recoverable);
                    IERC20(action.asset).safeTransfer(ctx.user, recoverable);
                }
            }

            repaidAny = repaidAny || (repaid > 0);
        }
    }

    function _withdrawAaveCollateralFromUser(
        address user,
        address asset,
        uint256 amount
    ) private returns (uint256 withdrawn) {
        (address aTokenAddress, , ) = dataProvider.getReserveTokensAddresses(asset);
        if (aTokenAddress == address(0)) {
            revert MissingAToken(asset);
        }

        IERC20(aTokenAddress).safeTransferFrom(user, address(aaveAdapter), amount);
        withdrawn = aaveAdapter.withdraw(asset, amount, address(this));
    }

    // ------------------------------------------------------------ Moonwell --

    function _processMoonwellLeg(
        ExecContext memory ctx,
        ExitTypes.ExitLeg calldata leg
    ) private returns (bool acted) {
        address mToken = leg.asset;
        address comptroller = IMToken(mToken).comptroller();
        uint256 shortfallBefore = moonwellAdapter.accountShortfall(comptroller, ctx.user);

        // Repay (wallet-funded; borrowBalanceCurrent accrues so full is exact).
        if (leg.repayAmount > 0) {
            uint256 debt = moonwellAdapter.debtOf(mToken, ctx.user);
            uint256 amount = leg.repayAmount == AMOUNT_FULL ? debt : _min(debt, leg.repayAmount);
            amount = _capRepay(ctx, amount, debt);
            _assertRepayFloor(ctx, ExitTypes.ProtocolId.MOONWELL, mToken, amount, debt);
            if (amount > 0) {
                address underlying = IMToken(mToken).underlying();
                _pullFromUser(ctx, underlying, amount, address(moonwellAdapter));
                moonwellAdapter.repayBehalf(mToken, ctx.user, amount);
                moonwellAdapter.assertShortfallNotIncreased(
                    comptroller,
                    ctx.user,
                    shortfallBefore
                );
                acted = true;
            }
        }

        // Withdraw: pull the user's mTokens (ERC-20 approved to the executor),
        // redeem on the adapter; the Comptroller blocks any redeem that would
        // create shortfall, so health is protocol-enforced here.
        if (leg.withdrawAmount > 0) {
            uint256 balance = IMToken(mToken).balanceOf(ctx.user);
            uint256 amount = leg.withdrawAmount == AMOUNT_FULL
                ? balance
                : _min(balance, leg.withdrawAmount);
            _assertWithdrawFloor(ctx, ExitTypes.ProtocolId.MOONWELL, mToken, amount, balance);
            if (amount > 0) {
                IERC20(mToken).safeTransferFrom(ctx.user, address(moonwellAdapter), amount);
                (address underlying, uint256 received) = moonwellAdapter.redeem(mToken, amount);
                if (received > 0 && underlying != usdc) {
                    _swapAssetToUsdc(ctx, underlying, received);
                }
                acted = acted || received > 0;
            }
        }

        _assertWorkDone(ctx, ExitTypes.ProtocolId.MOONWELL, mToken, acted);
        if (acted) emit LegClosed(ctx.user, ExitTypes.ProtocolId.MOONWELL, mToken);
    }

    // ---------------------------------------------------------- Compound V3 --

    function _processCometLeg(
        ExecContext memory ctx,
        ExitTypes.ExitLeg calldata leg
    ) private returns (bool acted) {
        address comet = abi.decode(leg.data, (address));

        // Repay base debt (repay == supplyTo on behalf of the borrower).
        if (leg.repayAmount > 0) {
            uint256 debt = IComet(comet).borrowBalanceOf(ctx.user);
            uint256 amount = leg.repayAmount == AMOUNT_FULL ? debt : _min(debt, leg.repayAmount);
            amount = _capRepay(ctx, amount, debt);
            _assertRepayFloor(ctx, ExitTypes.ProtocolId.COMPOUND_V3, leg.asset, amount, debt);
            if (amount > 0) {
                address base = IComet(comet).baseToken();
                _pullFromUser(ctx, base, amount, address(compoundAdapter));
                compoundAdapter.repayBase(comet, ctx.user, amount);
                acted = true;
            }
        }

        // Withdraw collateral (Comet reverts if it would under-collateralize).
        if (leg.withdrawAmount > 0 && leg.asset != address(0)) {
            uint256 balance = IComet(comet).collateralBalanceOf(ctx.user, leg.asset);
            uint256 amount = leg.withdrawAmount == AMOUNT_FULL
                ? balance
                : _min(balance, leg.withdrawAmount);
            _assertWithdrawFloor(ctx, ExitTypes.ProtocolId.COMPOUND_V3, leg.asset, amount, balance);
            if (amount > 0) {
                compoundAdapter.withdrawCollateral(
                    comet,
                    ctx.user,
                    leg.asset,
                    amount,
                    address(this)
                );
                if (leg.asset != usdc) {
                    _swapAssetToUsdc(ctx, leg.asset, amount);
                }
                acted = true;
            }
        }

        _assertWorkDone(ctx, ExitTypes.ProtocolId.COMPOUND_V3, leg.asset, acted);
        if (acted) {
            compoundAdapter.assertCollateralized(comet, ctx.user);
            emit LegClosed(ctx.user, ExitTypes.ProtocolId.COMPOUND_V3, leg.asset);
        }
    }

    // -------------------------------------------------------------- Morpho --

    function _processMorphoLeg(
        ExecContext memory ctx,
        ExitTypes.ExitLeg calldata leg
    ) private returns (bool acted) {
        IMorpho.MarketParams memory mp = abi.decode(leg.data, (IMorpho.MarketParams));

        // Repay (full closes by shares - exact, no dust).
        if (leg.repayAmount > 0) {
            uint256 debt = morphoAdapter.debtAssets(mp, ctx.user);
            uint256 amount = leg.repayAmount == AMOUNT_FULL ? debt : _min(debt, leg.repayAmount);
            amount = _capRepay(ctx, amount, debt);
            _assertRepayFloor(ctx, ExitTypes.ProtocolId.MORPHO_BLUE, leg.asset, amount, debt);
            if (amount > 0) {
                // Closing by shares is only exact when the whole debt is going;
                // a permit-capped repay must go by assets or it would overshoot
                // the fraction the signer authorised.
                bool closeByShares = leg.repayAmount == AMOUNT_FULL && amount == debt;
                _pullFromUser(ctx, mp.loanToken, amount, address(morphoAdapter));
                uint256 loanBefore = IERC20(mp.loanToken).balanceOf(address(this));
                morphoAdapter.repay(mp, ctx.user, closeByShares ? 0 : amount);
                // Share-rounding leftovers come back here; return them to the
                // user (non-USDC would otherwise be stranded pre-sweep).
                uint256 leftover = IERC20(mp.loanToken).balanceOf(address(this)) - loanBefore;
                if (leftover > 0 && mp.loanToken != usdc) {
                    IERC20(mp.loanToken).safeTransfer(ctx.user, leftover);
                }
                acted = true;
            }
        }

        // Withdraw collateral (Morpho reverts an unhealthy withdrawal).
        if (leg.withdrawAmount > 0) {
            uint256 balance = morphoAdapter.collateralOf(mp, ctx.user);
            uint256 amount = leg.withdrawAmount == AMOUNT_FULL
                ? balance
                : _min(balance, leg.withdrawAmount);
            _assertWithdrawFloor(ctx, ExitTypes.ProtocolId.MORPHO_BLUE, leg.asset, amount, balance);
            if (amount > 0) {
                morphoAdapter.withdrawCollateral(mp, ctx.user, amount, address(this));
                if (mp.collateralToken != usdc) {
                    _swapAssetToUsdc(ctx, mp.collateralToken, amount);
                }
                acted = true;
            }
        }

        _assertWorkDone(ctx, ExitTypes.ProtocolId.MORPHO_BLUE, leg.asset, acted);
        if (acted) emit LegClosed(ctx.user, ExitTypes.ProtocolId.MORPHO_BLUE, leg.asset);
    }

    // ------------------------------------------------------------- helpers --

    /// @dev Cap a repay at `maxRepayBps` of the live debt. A no-op on the
    /// self-serve path, where maxRepayBps is 10000.
    function _capRepay(
        ExecContext memory ctx,
        uint256 amount,
        uint256 liveDebt
    ) private pure returns (uint256) {
        if (ctx.maxRepayBps >= BPS_DENOMINATOR) return amount;
        return _min(amount, Math.mulDiv(liveDebt, ctx.maxRepayBps, BPS_DENOMINATOR));
    }

    // --- execution-time-relative floors (delegated path only) ---------------
    // The permit authorises WORK, not a submitter-chosen leg amount. These
    // assert, from LIVE state at execution, that a leg did the full authorised
    // work; a partial / 1-wei / do-nothing leg reverts and unwinds the nonce
    // spend. Derived from live state, so they never go stale the way an absolute
    // signed figure would (they hold in the crash the permit was signed for).
    // No-ops on the self-serve path.

    /// @dev Full authorised repay for a single-debt protocol: the whole live
    /// debt, or `maxRepayBps` of it for a REDUCE. `planned` is what the leg is
    /// about to repay (already capped); it must not fall short.
    function _assertRepayFloor(
        ExecContext memory ctx,
        ExitTypes.ProtocolId protocol,
        address asset,
        uint256 planned,
        uint256 liveDebt
    ) private pure {
        if (!ctx.permitFloor) return;
        uint256 authorized = _capRepay(ctx, liveDebt, liveDebt);
        if (planned < authorized) {
            revert RepayFloorNotMet(uint8(protocol), asset, planned, authorized);
        }
    }

    /// @dev Withdraw is only ever authorised by a FULL_EXIT, which means take
    /// ALL of it: `planned` must equal the full live balance.
    function _assertWithdrawFloor(
        ExecContext memory ctx,
        ExitTypes.ProtocolId protocol,
        address asset,
        uint256 planned,
        uint256 balance
    ) private pure {
        if (!ctx.permitFloor) return;
        if (planned < balance) {
            revert WithdrawFloorNotMet(uint8(protocol), asset, planned, balance);
        }
    }

    /// @dev A delegated leg must move something. Catches the dynamic no-op a
    /// static check cannot (a leg that asks to repay/withdraw but the user has
    /// no debt/collateral there), which would otherwise burn the nonce for free.
    function _assertWorkDone(
        ExecContext memory ctx,
        ExitTypes.ProtocolId protocol,
        address asset,
        bool acted
    ) private pure {
        if (ctx.permitFloor && !acted) revert NoWorkDone(uint8(protocol), asset);
    }

    /// @dev Pull `amount` of `asset` from the user (balance-checked) and push
    /// it to `to` (an adapter).
    function _pullFromUser(
        ExecContext memory ctx,
        address asset,
        uint256 amount,
        address to
    ) private {
        uint256 userBalance = IERC20(asset).balanceOf(ctx.user);
        if (userBalance < amount) {
            revert InsufficientDebtAssetBalance(asset, amount, userBalance);
        }
        IERC20(asset).safeTransferFrom(ctx.user, address(this), amount);
        IERC20(asset).safeTransfer(to, amount);
    }

    /// @dev Transfer NFT from user, exit position via adapter, swap received tokens to USDC.
    function _exitUniswapPosition(ExecContext memory ctx, uint256 tokenId) private {
        nftManager.transferFrom(ctx.user, address(uniswapAdapter), tokenId);

        (
            address token0,
            uint256 amount0,
            address token1,
            uint256 amount1
        ) = uniswapAdapter.exitPosition(tokenId);

        if (amount0 > 0 && token0 != usdc) {
            _swapAssetToUsdc(ctx, token0, amount0);
        }
        if (amount1 > 0 && token1 != usdc) {
            _swapAssetToUsdc(ctx, token1, amount1);
        }
    }

    function _swapAssetToUsdc(
        ExecContext memory ctx,
        address asset,
        uint256 amountIn
    ) private {
        if (!_swapEnabledByAsset[asset]) {
            revert MissingSwapRoute(asset);
        }

        uint256 amountOutMinimum = ctx.permitFloor
            ? _computePermitAmountOutMinimum(asset, amountIn, ctx.maxSlippageBps)
            : _computeAmountOutMinimum(asset, amountIn);
        IERC20(asset).safeTransfer(address(swapAdapter), amountIn);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(
            address(swapAdapter),
            amountIn,
            amountOutMinimum,
            _swapPathByAsset[asset],
            false
        );

        swapAdapter.swapToUSDC(
            SwapAdapter.SwapRequest({
                tokenIn: asset,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                commands: hex"00",
                inputs: inputs,
                deadline: block.timestamp + swapDeadlineBuffer
            })
        );
    }

    /// @dev Slippage floor from deploy-time per-asset config + oracle prices.
    /// This is the SELF-SERVE floor and is deliberately untouched by v2: the
    /// caller is the position owner, present at execution, and the frozen bps
    /// is what the deployed v1 promises them.
    function _computeAmountOutMinimum(
        address asset,
        uint256 amountIn
    ) private view returns (uint256) {
        uint16 minOutBps = _swapMinOutBpsByAsset[asset];
        if (minOutBps == 0 || minOutBps > BPS_DENOMINATOR) {
            revert InvalidMinOutBps(asset, minOutBps);
        }

        uint256 expectedOut = _oracleQuote(
            asset,
            amountIn,
            _getAssetPrice(asset),
            _getAssetPrice(usdc)
        );
        return Math.mulDiv(expectedOut, minOutBps, BPS_DENOMINATOR);
    }

    /// @dev DELEGATED floor: the signer's own worst-acceptable execution,
    /// measured at execution time against a price whose age is bounded. This is
    /// the whole point of the v2 slippage model - a crash moves the market
    /// faster than a constructor-frozen 9500 can follow, and a floor the user
    /// chose is the only one that can be both safe and executable.
    function _computePermitAmountOutMinimum(
        address asset,
        uint256 amountIn,
        uint16 maxSlippageBps
    ) private view returns (uint256) {
        uint256 expectedOut = _oracleQuote(
            asset,
            amountIn,
            _getFreshAssetPrice(asset),
            _getFreshAssetPrice(usdc)
        );
        return
            Math.mulDiv(expectedOut, BPS_DENOMINATOR - maxSlippageBps, BPS_DENOMINATOR);
    }

    /// @dev The single copy of the asset -> USDC quote. Both floors call it, so
    /// they can never disagree on the money math; only the haircut differs.
    /// Prices must share a scale - the ratio is what is used, not the absolute.
    function _oracleQuote(
        address asset,
        uint256 amountIn,
        uint256 assetPrice,
        uint256 usdcPrice
    ) private view returns (uint256) {
        if (assetPrice == 0) revert PriceUnavailable(asset);
        if (usdcPrice == 0) revert PriceUnavailable(usdc);

        uint256 assetScale = _pow10(IERC20Metadata(asset).decimals());
        uint256 usdcScale = _pow10(IERC20Metadata(usdc).decimals());

        uint256 usdValue = Math.mulDiv(amountIn, assetPrice, assetScale);
        return Math.mulDiv(usdValue, usdcScale, usdcPrice);
    }

    /// @dev Price for the delegated path, normalised to 8 decimals.
    /// Deliberately NOT the Aave-style oracle: `getAssetPrice(address)` returns
    /// a number with no timestamp, and a floor computed from a price of unknown
    /// age is exactly the hole this phase closes. Testnet demo assets keep the
    /// v1 mock-oracle escape hatch (those feeds are hand-set and carry no
    /// timestamp either - they are not deployed to mainnet).
    function _getFreshAssetPrice(address asset) private view returns (uint256) {
        if (_useMockOracleByAsset[asset]) {
            uint256 mockPrice = _readPrice(mockOracle, asset);
            if (mockPrice == 0) revert PriceUnavailable(asset);
            return mockPrice;
        }

        address feed = _priceFeedByAsset[asset];
        if (feed == address(0)) revert MissingPriceFeed(asset);

        (, int256 answer, , uint256 updatedAt, ) = IChainlinkFeed(feed).latestRoundData();
        if (answer <= 0) revert PriceUnavailable(asset);
        if (updatedAt == 0 || updatedAt > block.timestamp) {
            revert StalePrice(asset, updatedAt, block.timestamp);
        }
        if (block.timestamp - updatedAt > oracleStalenessSeconds) {
            revert StalePrice(asset, updatedAt, block.timestamp);
        }

        // Decimals were read and bounded (<= 18) at construction.
        return _scalePrice(uint256(answer), _priceFeedDecimalsByAsset[asset]);
    }

    function _scalePrice(uint256 price, uint8 feedDecimals) private pure returns (uint256) {
        if (feedDecimals == DELEGATED_PRICE_DECIMALS) return price;
        if (feedDecimals < DELEGATED_PRICE_DECIMALS) {
            return price * _pow10(DELEGATED_PRICE_DECIMALS - feedDecimals);
        }
        return price / _pow10(feedDecimals - DELEGATED_PRICE_DECIMALS);
    }

    /// @dev Chainlink L2 sequencer-uptime pattern: answer 0 = up, 1 = down, and
    /// a fresh restart needs a grace period before its prices can be trusted
    /// (queued transactions land first and move the market). Skipped when no
    /// feed is configured, which is the Base Sepolia case - the alternative
    /// would be to make testnet undeployable.
    function _checkSequencer() private view {
        address feed = sequencerUptimeFeed;
        if (feed == address(0)) return;

        (, int256 answer, uint256 startedAt, , ) = IChainlinkFeed(feed).latestRoundData();
        if (answer != 0) revert SequencerDown(answer);
        if (startedAt == 0) revert SequencerDown(answer);

        uint256 readyAt = startedAt + sequencerGracePeriod;
        if (block.timestamp < readyAt) {
            revert SequencerGracePeriodNotOver(startedAt, readyAt);
        }
    }

    function _getAssetPrice(address asset) private view returns (uint256) {
        if (_useMockOracleByAsset[asset]) {
            uint256 mockPrice = _readPrice(mockOracle, asset);
            if (mockPrice == 0) revert PriceUnavailable(asset);
            return mockPrice;
        }

        uint256 marketPrice = _readPrice(marketOracle, asset);
        if (marketPrice > 0) {
            return marketPrice;
        }

        uint256 fallbackMockPrice = _readPrice(mockOracle, asset);
        if (fallbackMockPrice > 0) {
            return fallbackMockPrice;
        }

        revert PriceUnavailable(asset);
    }

    function _readPrice(
        IAssetOracle oracle,
        address asset
    ) private view returns (uint256 price) {
        if (address(oracle) == address(0)) {
            return 0;
        }

        try oracle.getAssetPrice(asset) returns (uint256 p) {
            price = p;
        } catch {
            price = 0;
        }
    }

    // ------------------------------------------------- permit internals --

    /// @dev Recomputed per call rather than cached, so a chain fork (new
    /// chainid) cannot leave a stale separator behind that would let permits
    /// signed on one chain verify on the other.
    function _domainSeparator() private view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    DOMAIN_TYPEHASH,
                    DOMAIN_NAME_HASH,
                    DOMAIN_VERSION_HASH,
                    block.chainid,
                    address(this)
                )
            );
    }

    function _hashTypedData(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", _domainSeparator(), structHash));
    }

    function _hashPermitStruct(
        ExitTypes.ExitPermit calldata permit
    ) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    EXIT_PERMIT_TYPEHASH,
                    permit.user,
                    permit.kind,
                    permit.maxRepayFractionBps,
                    permit.triggerHealthFactorWad,
                    permit.maxSlippageBps,
                    permit.protocolsMask,
                    permit.epoch,
                    permit.nonce,
                    permit.deadline
                )
            );
    }

    /// @dev Authenticate the permit and spend its nonce. Every field of the
    /// struct is covered by the digest, so tampering with any of them - the
    /// user, the cap, the trigger, the slippage - invalidates the signature.
    /// The EIP-712 domain pins chainId and this contract's address, so a permit
    /// cannot be lifted to another chain or another deployment.
    function _consumePermit(
        ExitTypes.ExitPermit calldata permit,
        bytes calldata signature
    ) private {
        if (block.timestamp > permit.deadline) {
            revert PermitExpired(permit.deadline, block.timestamp);
        }

        uint256 currentEpoch = revocationEpoch[permit.user];
        if (permit.epoch != currentEpoch) {
            revert PermitRevoked(permit.epoch, currentEpoch);
        }

        bytes32 digest = _hashTypedData(_hashPermitStruct(permit));
        if (!_isValidSignature(permit.user, digest, signature)) {
            revert InvalidSignature();
        }

        uint256 wordPos = permit.nonce >> 8;
        uint256 bit = 1 << uint8(permit.nonce);
        uint256 flipped = nonceBitmap[permit.user][wordPos] ^= bit;
        if (flipped & bit == 0) revert NonceAlreadyUsed(permit.user, permit.nonce);
    }

    /// @dev EOA signatures go through OZ's ECDSA (which rejects malleable `s`
    /// and zero recoveries - the reason none of this is hand-rolled); contract
    /// signers go through ERC-1271, so a smart-contract wallet can delegate
    /// too. OZ's SignatureChecker would do both, but it calls the `mcopy`
    /// builtin directly in inline assembly, which does not compile under the
    /// pinned `paris` target (see the DOMAIN_TYPEHASH note), so the ERC-1271
    /// branch is the plain staticcall here - an interface call, not cryptography.
    function _isValidSignature(
        address signer,
        bytes32 digest,
        bytes calldata signature
    ) private view returns (bool) {
        if (signer.code.length == 0) {
            (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signature);
            return err == ECDSA.RecoverError.NoError && recovered == signer;
        }

        (bool success, bytes memory result) = signer.staticcall(
            abi.encodeCall(IERC1271.isValidSignature, (digest, signature))
        );
        return
            success &&
            result.length == 32 &&
            abi.decode(result, (bytes32)) == bytes32(IERC1271.isValidSignature.selector);
    }

    /// @dev The security core. Everything a submitter controls - which legs,
    /// which markets, how much - is checked against the signed scope here,
    /// before a single token moves.
    function _validatePermitScope(
        ExitTypes.ExitPermit calldata permit,
        ExitTypes.ExitLeg[] calldata legs
    ) private view {
        if (permit.kind > uint8(ExitTypes.ExitKind.REDUCE)) {
            revert InvalidPermitKind(permit.kind);
        }
        // Only REDUCE carries a partial fraction. FULL_REPAY and FULL_EXIT both
        // mean "all of the debt": pinning them to 10000 makes the per-leg repay
        // floor unambiguous (full exit = full repay + full withdraw), so a
        // FULL_EXIT can never quietly leave debt behind.
        bool full =
            permit.kind == uint8(ExitTypes.ExitKind.FULL_REPAY) ||
            permit.kind == uint8(ExitTypes.ExitKind.FULL_EXIT);
        if (
            permit.maxRepayFractionBps == 0 ||
            permit.maxRepayFractionBps > BPS_DENOMINATOR ||
            (full && permit.maxRepayFractionBps != BPS_DENOMINATOR)
        ) {
            revert InvalidRepayFraction(permit.maxRepayFractionBps);
        }
        if (permit.maxSlippageBps > maxPermitSlippageBps) {
            revert InvalidPermitSlippage(permit.maxSlippageBps, maxPermitSlippageBps);
        }

        // Only a full exit may move collateral. Under FULL_REPAY / REDUCE the
        // position keeps every unit of its collateral no matter what legs the
        // submitter assembles.
        bool withdrawAllowed = permit.kind == uint8(ExitTypes.ExitKind.FULL_EXIT);

        for (uint256 i; i < legs.length; ++i) {
            ExitTypes.ExitLeg calldata leg = legs[i];
            uint8 protocol = uint8(leg.protocol);

            if (permit.protocolsMask & (uint8(1) << protocol) == 0) {
                revert ProtocolNotPermitted(protocol);
            }
            // Static half of the nonce-burn guard: a leg that names neither a
            // repay nor a withdraw is dead weight. The dynamic half (a leg that
            // asks to act but on a zero balance, or repays less than authorised)
            // is caught per-protocol by the relative floors below as it runs.
            if (leg.repayAmount == 0 && leg.withdrawAmount == 0) {
                revert EmptyLeg(protocol, leg.asset);
            }
            if (!withdrawAllowed && leg.withdrawAmount != 0) {
                revert WithdrawNotPermitted(permit.kind);
            }

            if (leg.protocol == ExitTypes.ProtocolId.AAVE_V3) {
                _requireTrackedAsset(leg.asset);
            } else if (leg.protocol == ExitTypes.ProtocolId.MOONWELL) {
                // leg.asset is the mToken: the executor calls it AND approves
                // the underlying to it. An unregistered one is a drain.
                _requireDelegatedMarket(leg.asset);
            } else if (leg.protocol == ExitTypes.ProtocolId.COMPOUND_V3) {
                // Same for the Comet named in leg.data.
                _requireDelegatedMarket(abi.decode(leg.data, (address)));
                if (leg.asset != address(0)) _requireTrackedAsset(leg.asset);
            } else {
                // Morpho markets are permissionless, so an allowlist would go
                // stale; instead everything that moves is bounded by the real
                // singleton (immutable in the adapter): the repay is capped by
                // the user's own borrowShares in that market and the collateral
                // by their own balance, neither of which a market creator can
                // fabricate. Only the token addresses need pinning, because
                // those decide what leaves the user's wallet.
                IMorpho.MarketParams memory mp = abi.decode(leg.data, (IMorpho.MarketParams));
                _requireTrackedAsset(mp.loanToken);
                if (leg.withdrawAmount != 0) _requireTrackedAsset(mp.collateralToken);
            }
        }
    }

    /// @dev Live-health gate. Support is per protocol and the rule is the same
    /// everywhere: only refuse or execute on a number the chain can prove.
    ///  AAVE_V3     - exact health factor from the pool, 1e18 scale.
    ///  MOONWELL    - the Comptroller reports shortfall, not a ratio. Nonzero
    ///                shortfall proves HF < 1 (Compound V2 uses one collateral
    ///                factor for both borrow capacity and liquidation), so a
    ///                trigger of 1e18 or looser is enforceable and anything
    ///                tighter conservatively refuses.
    ///  COMPOUND_V3 - Comet exposes only isBorrowCollateralized, which is
    ///                measured against the BORROW collateral factor, not the
    ///                liquidation one. It can read false while the position is
    ///                still far from liquidation, so using it would fire exits
    ///                the signer did not authorise. Refused outright.
    ///  MORPHO_BLUE - health needs the market's own oracle and lltv; IMorpho
    ///                exposes neither a price nor a health view. Refused.
    /// Refused protocols keep the full delegated path for execute-now permits
    /// (triggerHealthFactorWad == 0), which are bounded by `deadline` instead.
    function _assertTriggerMet(
        ExitTypes.ExitPermit calldata permit,
        ExitTypes.ExitLeg[] calldata legs
    ) private view {
        uint256 trigger = permit.triggerHealthFactorWad;
        if (trigger == 0) return;

        for (uint256 i; i < legs.length; ++i) {
            ExitTypes.ExitLeg calldata leg = legs[i];
            uint8 protocol = uint8(leg.protocol);

            if (leg.protocol == ExitTypes.ProtocolId.AAVE_V3) {
                (, , , , , uint256 healthFactor) = aaveAdapter.getUserAccountData(permit.user);
                if (healthFactor >= trigger) {
                    revert TriggerNotMet(protocol, healthFactor, trigger);
                }
            } else if (leg.protocol == ExitTypes.ProtocolId.MOONWELL) {
                address comptroller = IMToken(leg.asset).comptroller();
                uint256 shortfall = moonwellAdapter.accountShortfall(comptroller, permit.user);
                uint256 bound = shortfall > 0 ? HF_BOUND_BELOW_ONE : type(uint256).max;
                if (bound >= trigger) {
                    revert TriggerNotMet(protocol, bound, trigger);
                }
            } else {
                revert TriggerUnsupported(protocol);
            }
        }
    }

    function _requireTrackedAsset(address asset) private view {
        if (!_trackedAssetByAsset[asset]) revert AssetNotTracked(asset);
    }

    function _requireDelegatedMarket(address market) private view {
        if (!_delegatedMarketAllowed[market]) revert MarketNotPermitted(market);
    }

    function _pow10(uint8 decimals) private pure returns (uint256 result) {
        if (decimals > 77) revert InvalidOracleDecimals(decimals);

        result = 1;
        for (uint8 i; i < decimals; ++i) {
            result *= 10;
        }
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _trackAsset(address asset) private {
        if (asset == address(0)) {
            revert InvalidTrackedAsset(asset);
        }
        if (_trackedAssetByAsset[asset]) {
            return;
        }
        _trackedAssetByAsset[asset] = true;
        _trackedAssets.push(asset);
    }

    /// @dev Duplicate legs are rejected per (protocol, asset) pair; the same
    /// underlying address may legitimately appear on two different protocols.
    function _validateUniqueLegs(ExitTypes.ExitLeg[] calldata legs) private pure {
        for (uint256 i; i < legs.length; ++i) {
            for (uint256 j = i + 1; j < legs.length; ++j) {
                if (legs[i].protocol == legs[j].protocol && legs[i].asset == legs[j].asset) {
                    revert DuplicateAsset(legs[i].asset);
                }
            }
        }
    }

    function _shrink(
        address[] memory values,
        uint256 size
    ) private pure returns (address[] memory result) {
        result = new address[](size);
        for (uint256 i; i < size; ++i) {
            result[i] = values[i];
        }
    }
}
