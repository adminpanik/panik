# PANIK — Founding User Escrow System

## Context
As part of the PANIK waitlist and pre-launch program, we have established a hidden **Founding User program** accessible via `/founding` and `/early-access`. 
To build trust with early adopters, we implement a non-custodial $5 USDC escrow contract on Base. The contract has a **single global deadline** set at deployment (deploy time + 90 days), shared by every depositor — it is not a per-user clock. If the team has not called `ship()` by that deadline, every depositor can claim their 5 USDC back directly from the contract, permanently.

---

## 1. Smart Contract Architecture (`PanikEscrow.sol`)

The smart contract is written in Solidity `^0.8.24`. It interacts with USDC through a minimal ERC-20 interface vendored at `contracts/src/interfaces/IERC20.sol` (production sources do not depend on `forge-std`).

**One compiler configuration:** `contracts/foundry.toml` — solc `0.8.24`, `evm_version = "cancun"`, optimizer on at 200 runs, no `via_ir`. `evm_version` is pinned explicitly because it is hashed into the contract metadata, so a solc default change would silently alter the deployed bytecode and break Basescan verification. Every deploy path builds through Foundry; nothing else compiles this contract.

### State & Parameters
- **Accepted Token:** `usdc` (USDC on Base/Base Sepolia). The constructor requires `decimals() == 6`, since the deposit size hardcodes that assumption.
- **Deposit Size:** `5_000_000` (exactly 5 USDC, utilizing USDC's 6-decimal format).
- **Refund Window:** A single global `90 days` from the time of deployment. Not per depositor.
- **Roles:**
  - `owner`: Authorized to trigger `ship()`. Can transfer ownership or update the treasury wallet.
  - `treasury`: Receives the balance when `ship()` is called.

### State Mapping & Auditing Tables
- `refundDeadline`: Global immutable timestamp (deployment time + 90 days), **no arguments**. After this timestamp, deposits are closed, `ship()` is permanently blocked, and refunds become available.
- `shipped`: Global status flag. If `true`, the owner has swept the funds to the treasury.
- `depositTime[address]`: Unix timestamp of the wallet's deposit. Used as the "has deposited" flag and as an audit record **only** — no time math reads it. Refund eligibility depends solely on the global `refundDeadline`.
- `refunded[address]`: Set to `true` when a depositor claims their refund.

---

## 2. Core Operational Flows

### A. Deposit Flow (`deposit()`)
```solidity
function deposit() external;
```
1. Reverts if `shipped` is true.
2. Reverts if the global `refundDeadline` has passed (`block.timestamp >= refundDeadline`).
3. Checks that the sender has not deposited before (`depositTime[msg.sender] == 0`).
4. Records `depositTime[msg.sender] = block.timestamp`.
5. Increments the `depositorCount` total.
6. Performs `transferFrom` for exactly 5 USDC from the user's wallet to the contract. State is written *before* this external call (checks-effects-interactions), so a reentrant call from a hostile token hits `AlreadyDeposited`.
7. Emits `Deposited(msg.sender, block.timestamp)`.

### B. Shipping Flow (`ship()`)
```solidity
function ship() external onlyOwner;
```
1. Verifies the caller is the owner.
2. Reverts if already `shipped` is true.
3. Enforces the strict global deadline:
   `block.timestamp < refundDeadline`.
   - If the global 90-day deadline has passed, the call reverts with `RefundWindowPassed` and the team forfeits all funds.
4. Reverts with `NothingToShip` if the escrow balance is zero. `shipped` is one-way and closes `deposit()` and `claimRefund()` permanently, so an accidental empty-escrow call would brick the contract for nothing.
5. Marks `shipped = true`.
6. Transfers the entire contract balance of USDC to the `treasury` address.
7. Emits `Shipped()`.

> **No proof-of-shipping check.** Those are the only conditions. The contract
> cannot observe whether the app actually launched, so before the deadline
> `ship()` is a discretionary owner action, and `setTreasury()` can change the
> destination first. The enforceable guarantee is the deadline, not the launch.

### C. Refund Flow (`claimRefund()`)
```solidity
function claimRefund() external;
```
1. Reverts if `shipped` is true.
2. Checks that the sender has deposited.
3. Checks that the sender has not already refunded.
4. Enforces that the global deadline has passed:
   `block.timestamp >= refundDeadline`.
5. Marks `refunded[msg.sender] = true`.
6. Transfers 5 USDC back to the depositor.
7. Emits `Refunded(msg.sender)`.

---

## 3. Base Sepolia Deployment Details

The contract is compiled and deployed to **Base Sepolia** testnet:

| Property | Value |
| --- | --- |
| **Contract Address** | [`0xd69adb3ddf57993c352106f021e88c23167abb06`](https://sepolia.basescan.org/address/0xd69adb3ddf57993c352106f021e88c23167abb06) |
| **USDC Contract** | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| **Owner Address** | `0xFE3EbAC628dCD84Ac87f75b12114B8D36cD47E62` |
| **Default Treasury** | `0xFE3EbAC628dCD84Ac87f75b12114B8D36cD47E62` (Modifiable by owner) |
| **Deployment Tx** | [`0xa69ed7807d5a5791bb31233d0cb275408337347b48cde76b05e80e7824eb2883`](https://sepolia.basescan.org/tx/0xa69ed7807d5a5791bb31233d0cb275408337347b48cde76b05e80e7824eb2883) |

> **This deployment predates the current source.** The Sepolia instance above
> runs the *previous* bytecode. It does not include the constructor
> `decimals() == 6` check or the checks-effects-interactions ordering in
> `deposit()`; those apply from the next deploy onward. Its externally visible
> behaviour (global deadline, `ship()`, `claimRefund()`) is otherwise the same
> as described here. Do not verify the current source against this address —
> it will not match. Redeploy to pick the changes up.

---

## 4. Pretty-URL Routing Architecture

To keep the page hidden and remove the ugly `.html` extensions from URLs, routing rewrites are configured in two separate environments.

### A. Development (Vite Dev Server)
In `vite.config.ts`, a custom dev server middleware rewrites requests dynamically:
```typescript
{
  name: 'html-rewrite',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url ? req.url.split('?')[0] : '';
      if (url === '/founding' || url === '/early-access') {
        req.url = '/founding.html' + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
      } else if (url === '/app') {
        req.url = '/app.html' + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
      }
      next();
    });
  }
}
```

### B. Production (Vercel)
In `vercel.json`, rewrite rules are defined:
```json
{
  "cleanUrls": true,
  "trailingSlash": false,
  "rewrites": [
    { "source": "/app", "destination": "/app.html" },
    { "source": "/founding", "destination": "/founding.html" },
    { "source": "/early-access", "destination": "/founding.html" }
  ]
}
```

---

## 5. Frontend Client Integration

The frontend React application lives in `src/panik-founding/` and is bundled separately from the main landing page to ensure optimal load times for public waitlist users.

### Tech Stack
- **Wagmi v2 & Viem v2** for secure EVM interactions.
- **@tanstack/react-query** for state management and contract query caching.
- Custom premium styling mirroring the main landing page.

### Key Client Components
1. **`App.tsx`:** The root layout which sets up `WagmiProvider` and `QueryClientProvider`, presenting the founding perks.
2. **`EscrowStats.tsx`:** Dynamically queries the contract for the total number of unique depositors (`depositorCount()` — there is no `getDepositorCount`) and the global `refundDeadline()`, and tracks user-specific details.
3. **`DepositFlow.tsx`:**
   - Renders a multi-step user experience: Connect Wallet ➔ Switch Chain (Base/Base Sepolia) ➔ Verify USDC Balance ➔ Approve/Permit USDC ➔ Deposit 5 USDC ➔ Transacting ➔ Confirmed Success.
4. **`RefundBanner.tsx`:**
   - Evaluates if the connected wallet is eligible for a refund (`isRefundable`).
   - If `true` (the global `refundDeadline` has passed, `ship()` was never called, and this wallet has not already refunded), shows an immediate, single-click refund claim banner.

---

## 6. Base Mainnet Migration Guide

When ready to publish the founding page to Base Mainnet:

> ⚠️ **Do not use `scripts/deploy-escrow.mjs` for mainnet.** It is Base Sepolia
> only and now throws if pointed anywhere else. Mainnet deploys go through the
> Foundry script below.

1. **Deploy the Mainnet Contract (Foundry):**
   Set the following variables in your `.env` or deployment terminal — note the
   names differ from the testnet script's:
   ```env
   PRIVATE_KEY=<your-mainnet-deployer-private-key>
   OWNER_ADDRESS=<your-multisig-or-safe-address>
   TREASURY_ADDRESS=<your-treasury-or-multisig-address>
   ```
   Deploy:
   ```bash
   cd contracts
   forge script script/Deploy.s.sol:DeployPanikEscrow --rpc-url base --broadcast --verify -vvvv
   ```

   The **chain id** selects USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
   on Base Mainnet (8453), the Circle test token on Base Sepolia (84532).
   `USDC_ADDRESS` is ignored on both, so a stale export cannot hardwire the
   immutable `usdc` field to the wrong token.

   After the deployment tx the script asserts, aborting the run on failure:
   the chain id is 8453 or 84532; `refundDeadline() == block.timestamp + 90 days`;
   `DEPOSIT_AMOUNT() == 5_000_000`; `!shipped()`; the owner is not the deployer
   key; and on mainnet, that the owner address has code (i.e. a Safe/multisig,
   not an EOA). It does **not** re-read `usdc`/`owner`/`treasury` back out —
   the constructor assigns those unconditionally, so such a check can only
   fail if the compiler is broken.

   *Testnet only:* `scripts/deploy-escrow.mjs` deploys to Base Sepolia using
   `DEPLOYER_PRIVATE_KEY` / `ESCROW_OWNER_ADDRESS` / `ESCROW_TREASURY_ADDRESS`,
   and throws if pointed at any chain other than 84532. It shells out to
   `forge build` and deploys `contracts/out/PanikEscrow.sol/PanikEscrow.json`,
   so both paths share one compiler configuration and emit byte-identical
   creation code, metadata included:
   ```bash
   node --env-file=.env scripts/deploy-escrow.mjs   # requires Foundry on PATH
   ```

2. **Update Environment Variables:**
   Set the following on Vercel and in your production `.env`:
   ```env
   VITE_ESCROW_CONTRACT_ADDRESS=<newly-deployed-mainnet-address>
   VITE_ESCROW_CHAIN_ID=8453
   ```
3. **Deploy Frontend:**
   Re-deploy to Vercel. The app will immediately pick up the Base Mainnet settings and direct users to the live USDC contract.
