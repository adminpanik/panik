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

Moonwell and Compound V3 need no deploy-time addresses: the mToken and Comet
addresses ride inside each `ExitLeg` (`asset` / `data`).

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
npx hardhat test                                    # mock suite (test/executor.spec.ts)
BASE_MAINNET_RPC=<url> npx hardhat test test/fork   # Base mainnet fork proof
```

The fork suite impersonates real borrowers (defaults = PANIK validation-registry
wallets; override `FORK_AAVE_USER` / `FORK_MOONWELL_USER` / `FORK_COMET_USER`
when positions rotate).

## Short checklist
1. Confirm network is Base Sepolia (`84532`).
2. Fill `.env` with Aave/Uniswap/Morpho/USDC/oracle addresses.
3. Verify `SWAP_ASSETS`, `SWAP_PATHS`, `SWAP_MIN_OUT_BPS` list lengths match
   (floors must be 9000-10000).
4. Set `TRACKED_ASSETS` to all assets you want shown in scan flows.
5. Run `npm run build` and `npm test`.
6. Deploy with `npm run deploy:base-sepolia`.
7. Verify deployed addresses in `deploy/addresses.base-sepolia.json` and hand
   `deploy/onchain-config.json` to the panik-core frontend.
