# PanikEscrow — Smart Contract

Founding-user escrow for PANIK. Accepts **exactly 5 USDC** per wallet on **Base**. There is a **single global deadline**, fixed at deployment. Before it, the owner can sweep the balance to the treasury by calling `ship()`. After it, the owner is locked out forever and every depositor can claim a full refund.

## Trust Properties

- **One global refund deadline** — `refundDeadline` is a no-argument immutable set to `deploy time + 90 days`. It is identical for every depositor; a wallet that deposits on day 89 gets the same deadline as one that deposited on day 1. `depositTime[wallet]` is recorded for auditing but is not used in any time math.
- **`ship()` is discretionary before the deadline** — it is a one-shot owner-only sweep of the whole USDC balance to `treasury`. The contract cannot verify that anything was actually shipped, and the owner can call `setTreasury()` beforehand to change the destination. For that window, depositors are trusting the team, not the code. It does reject a zero-balance call (`NothingToShip`), so a stray owner transaction cannot brick the escrow by flipping the one-way `shipped` flag with nothing to sweep.
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

2. Check out the dependencies. `forge-std` is a **git submodule** pinned to
   `v1.16.2` (`contracts/lib/forge-std`), so clone recursively:

   ```bash
   git clone --recursive <repo-url>
   ```

   Already cloned without `--recursive`? Fetch it:

   ```bash
   git submodule update --init --recursive
   ```

   Do **not** run `forge install foundry-rs/forge-std` — untagged, it tracks
   `master` and silently moves you off the pinned commit.

## Build

```bash
cd contracts
forge build
```

`forge build` compiles `test/` and `script/` as well as `src/`, and both
import `forge-std`, so the submodule must be present. (It appears to work
without one only because `forge` will auto-install the dependency over the
network — offline or air-gapped CI fails.)

## Test

```bash
forge test -vvv
```

Same requirement: the `forge-std` submodule must be checked out.

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
| `ship()` | Owner | One-shot sweep of the whole balance to `treasury`. Takes no arguments. Reverts on or after `refundDeadline`, and on a zero balance (`NothingToShip`) |
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
