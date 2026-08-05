# PANIK Founding Program: Simple Escrow Explainer

This guide explains how the **Founding User Escrow System** works in plain, non-technical English. It is designed for founders, marketing, operations, and support team members.

---

## 1. What is the Founding User Escrow?

To build trust with our earliest and most loyal supporters, we are offering an exclusive **Founding User Program**. Curated users can back PANIK by depositing **$5 USDC**.

Instead of sending the money directly to us, their deposit is held on the blockchain by a **Smart Contract** (a secure, automated digital vault). 

### The Trust Guarantee:
* **If we ship PANIK within 90 days:** We call `ship()` to unlock the $5 USDC to support development, and the user gets lifetime benefits (50% fee discount, early access, etc.). Calling `ship()` is our decision and our commitment—the contract records it publicly but cannot itself verify a launch.
* **If we do NOT call `ship()` within 90 days:** The contract blocks us from touching the money, permanently. The user can click a button to retrieve their exact $5 USDC automatically, with no deadline on that right.

---

## 2. The Four Golden Rules of the Vault

The smart contract's **code is immutable**: once deployed, the rules below cannot be rewritten, upgraded, or bypassed—not by the team, not by anyone. That is what the code guarantees. What the code does *not* do is judge whether we shipped: within the 90-day window, moving the funds to the treasury is a decision the team makes on-chain by calling `ship()`. Be precise about this when you talk to users—the enforceable promise is the deadline, not the launch.

```
       [ Users Deposit $5 USDC ]
                   │
                   ▼
       [ Global 90-Day Timer Starts ]
           (Started at deployment)
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
  [ Team Ships App ]   [ Deadline Passes ]
     Before 90d           No launch yet
         │                   │
         ▼                   ▼
  [ Team claims all ]  [ Users claim refunds ]
  (Sent to Treasury)   (100% Refunded)
```

### Rule 1: The 90-day timer is global
The 90-day countdown starts on a single global date: the moment the contract was deployed. All users share the exact same refund deadline.
* *Example:* If the contract was deployed on June 19th, the launch target is September 17th. We must ship the app and claim the funds before this date.

### Rule 2: Non-Custodial (We don't hold the money)
The deposited funds sit inside the contract address, not in a team wallet. There are exactly two ways money ever leaves it:

1. **Before the deadline**, the owner wallet calls `ship()`, which sends the whole balance to the Treasury. This is a team decision, taken on-chain and publicly visible. The contract has no way to check that the app really launched, and the owner can point the Treasury at a different address (see 3C) before calling. So during this window, users are trusting *us*—the code only makes the decision transparent and irreversible.
2. **After the deadline**, if we never called `ship()`, the contract locks us out for good and each depositor withdraws their own 5 USDC.

There is no third path: no admin withdrawal, no partial skim, no upgrade that could add one. The honest one-line version for users is: **your $5 is refundable after the deadline if we haven't shipped, and before that, any release is a team action recorded on the blockchain.**

### Rule 3: The "Claim" is a single global action (Shipping)
When the app launches, the team calls a single function (`ship()`). This changes the state of the project to "Shipped" and pulls all deposited funds into our **Treasury** in one go. No need to release deposits address-by-address.

### Rule 4: Missed deadlines are final (Forfeiture)
If we fail to call `ship()` before the global 90-day deadline, the contract locks us out of the funds **permanently**. We can never touch them, and every depositor can withdraw their 5 USDC at any time. There is no expiry date on their right to claim a refund.

---

## 3. How to Manage the Escrow (For the Team)

As a founder or team member, you may need to perform basic administrative tasks. 

### A. How do we claim the money?
When the app launches, the contract owner triggers the release of all funds:
1. The team uses the owner wallet to log into a simple admin interface (or directly on the Base block explorer).
2. You call the `ship()` function.
3. The contract marks the project as shipped, closes future deposits, and sends the entire USDC balance to our **Treasury**.

### B. How do users get a refund?
If we miss the global 90-day deadline, users go back to the hidden link (`/founding` or `/early-access`).
1. The page detects that the global deadline has passed and the project was not shipped.
2. A button labeled **"Claim $5 USDC Refund"** will appear automatically.
3. The user clicks it, approves the transaction in their wallet, and their 5 USDC is returned instantly. We do not need to process this manually.

### C. Can we change where the claimed money goes?
Yes. If we need to redirect the funds (for example, moving the treasury from a single team wallet to a multi-signature secure vault like Gnosis Safe):
* The contract owner can change the destination address by calling the `setTreasury` setting.

---

## 4. Key Links for the Team

* **The Hidden Backer Page:** `https://panik.finance/early-access` (or `/founding` in local development).
* **The On-chain Vault Address (Base Sepolia Testnet):** [`0xd69adb3ddf57993c352106f021e88c23167abb06`](https://sepolia.basescan.org/address/0xd69adb3ddf57993c352106f021e88c23167abb06)
  *(This is where you can see the active balance and total backers in real-time).*
