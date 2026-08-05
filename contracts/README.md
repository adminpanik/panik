# PanikEscrow — Smart Contract

Founding-user escrow for PANIK. Accepts **exactly 5 USDC** per wallet on **Base**. There is a **single global deadline**, fixed at deployment. Before it, the owner can sweep the balance to the treasury by calling `ship()`. After it, the owner is locked out forever and every depositor can claim a full refund.

## Trust Properties

- **One global refund deadline** — `refundDeadline` is a no-argument immutable set to `deploy time + 90 days`. It is identical for every depositor; a wallet that deposits on day 89 gets the same deadline as one that deposited on day 1. `depositTime[wallet]` is recorded for auditing but is not used in any time math.
- **`ship()` is discretionary before the deadline** — it is a one-shot owner-only sweep of the whole USDC balance to `treasury`. The contract cannot verify that anything was actually shipped, and the owner can call `setTreasury()` beforehand to change the destination. For that window, depositors are trusting the team, not the code.
- **Hard lockout after the deadline** — once `block.timestamp >= refundDeadline`, `ship()` reverts permanently and the funds belong to the depositors.
- **Refunds claimable forever** — no sweep, no expiry on the refund right.
- **Deposits close at the deadline too** — `deposit()` reverts once it passes, and after `ship()`.
- **No selfdestruct, no admin withdrawal, no upgrade proxy.**

## Prerequisites

1. Install [Foundry](https://getfoundry.sh):

   ```bash
   curl -L https://foundry.paradigm.xyz | bash
   foundryup
   ```

2. Install the test dependencies. `contracts/lib/` is gitignored, so a fresh
   clone has no `forge-std` — the **tests** need it (the contract in `src/`
   does not, it compiles against the vendored `src/interfaces/IERC20.sol`):

   ```bash
   cd contracts
   forge install foundry-rs/forge-std
   ```

## Build

```bash
cd contracts
forge build
```

`forge build` works on a fresh clone with no `lib/` present: nothing under
`src/` imports `forge-std`.

## Test

```bash
forge test -vvv
```

Requires the `forge install` step above (`test/` and `script/` import `forge-std`).

## Deploy

### Base Sepolia (testnet)

```bash
export PRIVATE_KEY=<your-deployer-private-key>
export OWNER_ADDRESS=<team-eoa-or-multisig>
export TREASURY_ADDRESS=<treasury-wallet>

forge script script/Deploy.s.sol:DeployPanikEscrow \
  --rpc-url base_sepolia \
  --broadcast \
  -vvvv
```

### Base Mainnet

```bash
forge script script/Deploy.s.sol:DeployPanikEscrow \
  --rpc-url base \
  --broadcast \
  --verify \
  -vvvv
```

## Contract Interface

Generated from the compiled ABI — every entry below exists on the contract.

| Function | Access | Description |
|----------|--------|-------------|
| `deposit()` | Anyone | Deposit exactly 5 USDC (must approve first). One per wallet |
| `ship()` | Owner | One-shot sweep of the whole balance to `treasury`. Takes no arguments. Reverts on or after `refundDeadline` |
| `claimRefund()` | Depositor | Claim your 5 USDC once `refundDeadline` has passed and `ship()` was never called |
| `transferOwnership(address)` | Owner | Transfer contract ownership |
| `setTreasury(address)` | Owner | Update the `ship()` destination |
| `hasPaid(address)` | View | Whether a wallet has deposited |
| `isRefundable(address)` | View | Whether a refund is claimable right now |
| `getDepositInfo(address)` | View | Returns `(depositTime, shipped, refunded)` |
| `refundDeadline()` | View | The single global deadline timestamp. **No arguments** |
| `depositTime(address)` | View | Timestamp of that wallet's deposit (`0` = never). Record only |
| `refunded(address)` | View | Whether that wallet already claimed a refund |
| `depositorCount()` | View | Total unique depositors |
| `shipped()` | View | Whether `ship()` has been called |
| `owner()` | View | Current owner |
| `treasury()` | View | Current sweep destination |
| `usdc()` | View | The escrowed token address |
| `DEPOSIT_AMOUNT()` | View | `5_000_000` (5 USDC at 6 decimals) |
| `REFUND_WINDOW()` | View | `90 days`, in seconds |

There is no `release(address)` function, and `refundDeadline` does not take an
address — earlier revisions of this document described both. `ship()` releases
everything at once.

## Addresses

| Chain | USDC |
|-------|------|
| Base Mainnet (8453) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Base Sepolia (84532) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

The **chain id decides** which of these the deploy script uses. `USDC_ADDRESS`
is read only on chains other than these two, so a stale export in your shell
cannot hardwire a mainnet escrow to the testnet token. The constructor also
requires `decimals() == 6`, so pointing at a non-USDC token (or an address with
no code) reverts the deployment instead of silently mispricing deposits.
