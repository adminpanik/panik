# Deployment Notes (Phase 2 - multi-protocol executor)

Phase 2 replaces the Aave-only entrypoints (`atomicExit(address[],uint256[])` /
`partialExit`) with ONE function:

```solidity
atomicExit(ExitTypes.ExitLeg[] legs, uint256[] uniswapTokenIds)
```

Amount semantics per leg: `0` = skip, `type(uint256).max` = full, else exact
cap. See `contracts/libraries/ExitTypes.sol` for the per-protocol meaning of
`asset` and `data`.

NOTE: the legacy `frontend/` in this repo targets the retired Phase 0 ABI and
is DEPRECATED - the product UI now lives in the panik_waitlist repo
(`src/panik-core`), which syncs `deploy/onchain-config.json` from here.

## Required env (scripts/deploy.ts)

| Env | Meaning |
|---|---|
| `USDC` | canonical USDC |
| `AAVE_POOL` | Aave V3 Pool |
| `AAVE_PROTOCOL_DATA_PROVIDER` | Aave data provider |
| `AAVE_ORACLE` | Aave market oracle |
| `MOCK_ORACLE` | demo-token oracle (Sepolia only; zero-address on mainnet) |
| `UNIVERSAL_ROUTER` | Uniswap UniversalRouter |
| `NFT_POSITION_MANAGER` | Uniswap V3 NonfungiblePositionManager |
| `MORPHO_BLUE` | Morpho Blue singleton |
| `SWAP_ASSETS` / `SWAP_PATHS` / `SWAP_MIN_OUT_BPS` | per-asset swap routes + slippage floors |
| `MOCK_ORACLE_ASSETS` / `TRACKED_ASSETS` | optional lists |
| `PRICE_FEED_ASSETS` / `PRICE_FEEDS` | Chainlink feed per swappable asset (v2 delegated floor) |
| `ORACLE_STALENESS_SECONDS` | max feed age, 60-86400, default 3600 |
| `SEQUENCER_UPTIME_FEED` | Chainlink L2 uptime feed; unset = check skipped (Sepolia only) |
| `SEQUENCER_GRACE_PERIOD_SECONDS` | cooldown after a sequencer restart, default 3600 |
| `MAX_PERMIT_SLIPPAGE_BPS` | ceiling on `ExitPermit.maxSlippageBps`, 1-2000, default 1000 |
| `DELEGATED_MARKETS` | mTokens + Comets a permit may name (see below) |

Moonwell and Compound V3 need no deploy-time addresses for the SELF-SERVE path:
the mToken and Comet addresses ride inside each `ExitLeg` (`asset` / `data`).
The DELEGATED path is different - there the leg is built by a third party, and
the executor both calls the named market and approves tokens to it, so it must
come from `DELEGATED_MARKETS`. Aave and Morpho need no entries: the Aave pool
and the Morpho singleton are immutable inside their adapters, and every amount
moved there is bounded by what the protocol says the user owes or owns.

## Delegated exits (v2, `atomicExitFor`)

Anyone may submit an `ExitPermit` the position owner signed (EIP-712, domain
`PanikExecutor` / version `2`). There is no relayer allowlist because there is
nothing an allowlist would add: proceeds always go to the signer, the funds
moved are the signer's own under their own allowances, and the signed trigger,
deadline and slippage bound when and how badly it may run.

Revocation belongs to the user alone:

| Call | Effect |
|---|---|
| `invalidateUnorderedNonces(wordPos, mask)` | burns specific nonce bits (`nonce >> 8` selects the word, `nonce % 256` the bit) |
| `revokeAll()` | bumps `revocationEpoch[user]`, orphaning every permit signed against the old epoch |

Both are immediate - the next transaction already sees them.

Trigger support is per protocol, and refuses rather than guesses:

| Protocol | `triggerHealthFactorWad > 0` |
|---|---|
| Aave V3 | exact HF from `getUserAccountData` |
| Moonwell | Comptroller shortfall proves HF < 1, so triggers >= 1e18 work; tighter ones revert `TriggerNotMet` |
| Compound V3 | `TriggerUnsupported` - Comet only exposes a borrow-CF boolean, which would fire early |
| Morpho Blue | `TriggerUnsupported` - health needs the market's own oracle, which `IMorpho` does not expose |

Execute-now permits (`triggerHealthFactorWad == 0`) work on all four.

## Slippage floors (mainnet-ready posture)

`SWAP_MIN_OUT_BPS` is now validated to `9000-10000`. The Phase 0 `[1,...]`
near-zero floors are rejected by the deploy script. Recommended:
stables `9970`, WETH/cbBTC `9900`, long-tail `9800`.

## Deployment command

```bash
npm run deploy:base-sepolia
```

Outputs:

- `deploy/addresses.<network>.json` - full deployment snapshot
- `deploy/onchain-config.json` - addresses + executor/lockChecker ABIs,
  consumed by the panik-core frontend via its `sync:exit-config` script

## User approvals per protocol (frontend contract)

| Protocol | Debt repay | Collateral withdrawal |
|---|---|---|
| Aave V3 | debt asset ERC-20 approve -> executor | aToken ERC-20 approve -> executor |
| Moonwell | underlying ERC-20 approve -> executor | mToken ERC-20 approve -> executor |
| Compound V3 | base asset ERC-20 approve -> executor | `comet.allow(compoundAdapter, true)` |
| Morpho Blue | loanToken ERC-20 approve -> executor | `morpho.setAuthorization(morphoAdapter, true)` |

The Comet/Morpho grants are boolean (all-or-nothing) - surface a one-click
revoke in the UI after the exit receipt.

## Tests

```bash
npx hardhat test                                    # mock suites (self-serve + delegated)
BASE_MAINNET_RPC=<url> npx hardhat test test/fork   # Base mainnet fork proof
```

`test/executor.spec.ts` covers the self-serve path, `test/executor-v2.spec.ts`
the delegated one (signatures, replay, revocation, scope, trigger, slippage,
sequencer).

The fork suite impersonates real borrowers (defaults = PANIK validation-registry
wallets; override `FORK_AAVE_USER` / `FORK_MOONWELL_USER` / `FORK_COMET_USER`
when positions rotate).

## Short checklist
1. Confirm network is Base Sepolia (`84532`).
2. Fill `.env` with Aave/Uniswap/Morpho/USDC/oracle addresses.
3. Verify `SWAP_ASSETS`, `SWAP_PATHS`, `SWAP_MIN_OUT_BPS` list lengths match
   (floors must be 9000-10000).
4. Set `TRACKED_ASSETS` to all assets you want shown in scan flows.
5. Give every swappable asset a `PRICE_FEEDS` entry (or list it in
   `MOCK_ORACLE_ASSETS`), or delegated exits touching it will revert.
6. Set `DELEGATED_MARKETS` to the mTokens and Comets permits may name.
7. Run `npm run build` and `npm test`.
8. Deploy with `npm run deploy:base-sepolia` - it now reads the deployed state
   back and aborts on any mismatch, printing a verification table.
9. Verify deployed addresses in `deploy/addresses.base-sepolia.json` and hand
   `deploy/onchain-config.json` to the panik-core frontend.
