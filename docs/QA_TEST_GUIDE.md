# PANIK - QA Test Guide (non-technical)

This guide is for testers. No coding needed. Just follow each step, compare what you
see to the "Expected result", and mark Pass or Fail. If something differs, note it in
the bug template at the bottom.

## Before you start

- **What you're testing:** two things - the public **Landing page + waitlist**, and the
  **Core app** (the dashboard at the panik.fi/app address).
- **Where:** the live site.
  - Landing page: **https://panik.fi**
  - Core app: **https://panik.fi/app**
- **Devices:** test on a **laptop/desktop browser** AND a **phone** (or resize the
  browser narrow). Chrome and Safari at minimum.
- **Reset trick (important):** to test the "first-time" experience again, open the site
  in a **new Incognito / Private window** (Chrome: Ctrl+Shift+N, Safari: Cmd+Shift+N).
  That gives you a clean slate every time - you do not need any technical steps.
- **Test data to use:**
  - Valid email: `qa.tester@example.com`
  - Valid wallet address (copy exactly): `0x76f88702325c92c83efad341a932fb326957056f`
  - "Bad" wallet for error testing: `0x123` (too short)
  - "Bad" email for error testing: `tester` (no @)

---

# PART A - Landing page + waitlist

### A1. Page loads and looks right
1. Open **https://panik.fi**.
2. **Expected:** Page loads with the PANIK logo top-left, an orange **JOIN WAITLIST →**
   button top-right, and a big headline with another **JOIN WAITLIST →** button below it.
   Nothing is broken, blank, or overlapping. Images and text show.

### A2. Navigation links scroll to sections
1. Click the top menu items one by one: **Products** (hover to see Compass / Watch /
   Advisor), **How it works**, **FAQ**.
2. **Expected:** Each click smoothly scrolls the page to that section. The logo click
   scrolls back to the top.

### A3. Dashboard preview animation
1. Slowly scroll down to the "dashboard preview" area (a mock app screen).
2. **Expected:** The mock screen grows/animates as you scroll, and its tabs
   (Portfolio → Compass → Watch → Advisor) rotate by themselves every few seconds.

### A4. Open the waitlist form
1. Click any **JOIN WAITLIST →** (or **JOIN THE WAITLIST →** at the bottom).
2. **Expected:** A popup opens titled **"Join the Panik Early Access Program"**, showing
   **"Step 1 of 4"** and an email box.

### A5. Email step - error check
1. In the email box type `tester` (no @), click **Continue**.
2. **Expected:** Red message **"Please enter a valid email address"**. You cannot move on.
3. Now type `qa.tester@example.com` and click **Continue**.
4. **Expected:** Moves to **Step 2 of 4**, question **Q1/5**.

### A6. Answer the 5 questions
1. **Q1 "How actively do you use DeFi lending or borrowing right now?"** - pick any option.
   **Expected:** It auto-advances to Q2.
2. **Q2 "Have you ever been liquidated or come close to liquidation?"** - pick any option.
3. **Q3 "How do you currently track the risk of your open positions?"** (says "Select all
   that apply") - pick one or two, then click **Next**. **Expected:** multiple can be selected.
4. **Q4 "Your biggest frustration..."** (says "Pick up to two") - try to select **three**.
   **Expected:** an amber note **"You can only select up to 2 options."** and the 3rd won't add.
   Leave two selected, click **Next**.
5. **Q5 "How much do you currently have in active DeFi positions?"** - pick any option.
   Optionally type in the "Anything else..." box. Click **Review**.
6. Use the **Back** button at least once and confirm your earlier answers are still selected.

### A7. Review step
1. **Expected:** A summary titled **"Onboarding Profile Summary"** shows your email and
   answers, plus a coloured box **"Your Panik profile · Conservative/Moderate/Aggressive"**
   with a one-line description. Click **Continue to Wallet**.

### A8. Wallet step - error check
1. **Expected:** Title **"Reserve Your Beta Access"** with **MetaMask** and **Coinbase
   Wallet** buttons, and a link **"…or paste a wallet address"**.
2. Click **"…or paste a wallet address"**, type `0x123`, try to submit.
   **Expected:** Red message **"Enter a valid EVM address (0x + 40 hex chars) to continue."**
3. Clear it and paste the valid wallet `0x76f88702325c92c83efad341a932fb326957056f`.
   **Expected:** A green **"Connected: 0x76f8…056f"** confirmation appears.

### A9. Submit the waitlist
1. Click **Join the waitlist**.
2. **Expected:** Button briefly shows **"Submitting…"**, then a success screen:
   heading **"You're on the list."**, a position number like **"Your position is #X."**,
   and three green checkmarks (email, risk profile, wallet).

### A10. After-submit state
1. Click **Return to Site**.
2. **Expected:** The JOIN buttons are now replaced by an orange box
   **"ACCESS GRANTED // SLOT IMMINENT"**. Reopening the page (same window) keeps this state.
3. Click **Follow on X for launch news**. **Expected:** opens the PANIK X/Twitter page in a
   new tab.

### A11. Duplicate email check
1. Open a **fresh Incognito window**, repeat A4-A9 but reuse the **same email**
   `qa.tester@example.com`.
2. **Expected:** On submit you get **"This email is already registered."** (not a crash).

### A12. Close / cancel behaviour
1. Open the form, type an email, then press the **Esc** key or the **X**.
2. **Expected:** A confirm prompt **"Leave the waitlist signup? Your progress is saved for
   this session."** Cancelling keeps the form; confirming closes it. Reopening in the same
   window restores where you left off.

### A13. Mobile check (phone or narrow browser)
1. **Expected:** The top menu collapses into a hamburger (☰) menu. JOIN buttons stack and
   are full-width. The waitlist popup fits the screen with no cut-off text or sideways scroll.

---

# PART B - Core app (dashboard at panik.fi/app)

> Tip: always start Part B in a **fresh Incognito window** so you see onboarding from scratch.

## B1. Onboarding - wallet step
1. Open **https://panik.fi/app**.
2. **Expected:** A full-screen onboarding showing **"Step 1 - your wallet"**, heading
   **"Start with your wallet"**, and an input that says **"0x... your Base wallet address"**.
3. Type `0x123` (bad). **Expected:** red message **"That doesn't look like a valid Base (0x...)
   address."** and **Continue** stays greyed out. A Solana-style (base58) address must also
   be rejected with the same message.
4. Paste the valid wallet `0x76f88702325c92c83efad341a932fb326957056f`. **Expected:**
   the box turns orange and **Continue** becomes clickable. Click it.

## B2. Onboarding - the 5 questions
1. **Expected:** "Question 1 of 5" appears. Each question has 5 options (A-E). Pick one per
   question; **expected** it auto-advances after each pick. The questions are:
   - Q1: "What's your main focus in DeFi right now?"
   - Q2: "One of your positions drops 25% in 48 hours. What do you do?"
   - Q3: "How often do you move capital between DeFi positions?"
   - Q4: "What's your relationship with borrowing or leverage in DeFi?"
   - Q5: "How much of the crypto... could drop 50% without causing you serious stress?"
2. Use the **← Back** link once and confirm it returns to the previous question.

## B3. Onboarding - analysis reveal
1. After Q5, **expected:** a screen **"Reading your on-chain history…"** with a spinner,
   then a result card showing a risk profile (e.g. "Moderate risk profile"), a coloured
   badge (e.g. "EXPLORER"), and four small chips: **CHAINS, PROTOCOLS, LEVERAGE,
   LIQUIDATIONS**. A button **Enter Panik** appears.
2. Click **Enter Panik**. **Expected:** the dashboard opens.

> Note: if the wallet has no on-chain history, it's normal to see
> "We couldn't read your on-chain history right now, so this is based on your answers."
> That is expected, not a bug.

## B4. Guided tour
1. **Expected:** A small tour box at the bottom shows **"STEP 1 OF 3"**, **"Start here"**.
   Click **Next →** through all 3 steps, or **Skip tour**. **Expected:** it closes and does
   not reappear on the next tab change.

## B5. Top bar and sidebar
1. **Expected:** Left sidebar lists five tabs: **Portfolio, Compass, Watch, Advisor,
   Settings**, plus **← Back to Landing** at the bottom. The top bar shows coloured badges
   for your profile and a shortened wallet like `0x76f8…056f`, and a gas reading
   ("EST GAS: x.x GWEI").
2. Click each tab once. **Expected:** each switches smoothly and the active tab highlights
   in orange.
3. Click **← Back to Landing**. **Expected:** returns to the landing page. (Then go back to
   panik.fi/app.)

## B6. Portfolio tab
1. **Expected:** Title **"DeFi Portfolio"** and four cards: **MONITORED CAPITAL**,
   **MONITORED LIABILITIES**, **PROTOCOLS WATCHED**, **AGGREGATE RISK INDEX** (a number out
   of 100, coloured green/amber/red).
2. **Expected:** A live positions list and an **ASSET ALLOCATION WEIGHT** breakdown with a
   coloured bar.
3. **Important:** On the live site you should see real data and a green "live"/"REAL DATA"
   indicator. If you instead see **"Live feed offline... showing simulation data"**, that is
   a **bug to report** (the backend is unreachable).

## B7. Compass tab
1. **Expected:** Title **"Compass"**, and three buttons **CONSERVATIVE / MODERATE /
   AGGRESSIVE**. Click between them. **Expected:** the recommended position cards update.
2. **Expected:** Two groups: "Recommended for your profile" and "Outside your profile".
   Each card shows a protocol, a risk badge (e.g. "8 LOW"), and an **Audit & Simulate →**
   button.
3. Click **Audit & Simulate →** on a card. **Expected:** it jumps to the **Watch** tab with
   that position loaded.

## B8. Watch tab (simulator)
1. **Expected:** A big **PANIK RISK INDEX** number (0-100, coloured), a status word
   (LOW RISK / ELEVATED / HIGH RISK / CRITICAL THREAT), **Top Risk Drivers** bars, and
   **HEALTH FACTOR** and **POSITION LTV** cards.
2. On the right, drag the **Collateral Asset Mock Price** slider down.
   **Expected:** as the price drops, the risk score rises (turns amber/red) and the
   recommendation text changes (e.g. a repay warning). Drag it back up - score recovers.
3. Drag the **Borrowed Outstanding Liability** slider up. **Expected:** higher debt = higher
   risk score.

## B9. Risk breakdown panel
1. On a Compass or Watch card, click the risk badge (e.g. "41 ELEVATED").
2. **Expected:** A panel slides in from the right with **PANIK RISK SCORE**, sub-scores, a
   list of liquidation metrics, and written "risk signals". Buttons **Close Panel** and
   **Open Simulator** work.

## B10. Advisor tab
1. **Expected:** A **"COMING SOON"** card titled "Adaptive Intelligence at Your Service",
   with a checkbox **"Notify me when Advisor goes live"**. Tick it - it should stay ticked.

## B11. Settings tab - Telegram connect (newest feature)
> Needs: you finished onboarding with the **EVM** wallet above, and you have Telegram on
> your phone or desktop.

1. Open **Settings**. **Expected:** a card **"WEB3 TELEGRAM ALERTS DISPATCHER"** with a
   **Connect Telegram** button, and a side panel **"HOW TO CONNECT ALERTS"** with 4 steps.
2. Click **Connect Telegram**. **Expected:** button shows **"Opening..."**, then your
   Telegram opens to the **@PanikDeFi_Bot** chat with a **Start** button. The app now shows
   **"Waiting..."** and a note "Waiting for you to press Start... this confirms
   automatically", plus a copyable `/start <code>` line as a fallback.
3. In Telegram, press **Start**. **Expected (two things):**
   - In Telegram you receive a **welcome message** ("Welcome to PANIK alerts...").
   - Back in the app, within a few seconds the card flips to **"Connected as @yourname"**
     (green), the button becomes **Reconnect**, and it says "Alerts are on. Send /stop in
     the bot anytime to pause them."
4. In Telegram, send **/stop**. **Expected:** the bot replies that alerts are paused.
5. Reload the app and open Settings again. **Expected:** if still linked, it shows your
   connected state on load.
6. **Not-eligible check:** in a fresh Incognito window open panik.fi/app but do NOT finish
   onboarding, then look at Settings. **Expected:** the button is disabled and it says
   **"Onboard with an EVM wallet (0x...) to enable alerts."**

## B12. Settings - auto-repayment control
1. **Expected:** an **"EMERGENCY AUTO REPAYMENT TRIGGER"** card with an on/off toggle and a
   percentage slider. Toggle it off. **Expected:** the slider greys out. Toggle on, drag the
   slider. **Expected:** the percentage label updates (e.g. "60% of liability").

## B13. Mobile check
1. On a phone (or narrow browser), repeat a few tabs. **Expected:** cards stack into one
   column, sliders and buttons still work, text stays readable, no sideways scrolling.

---

# What counts as a bug

Report it if you see any of these:
- A page is blank, frozen, or shows an error/crash.
- A button does nothing, or the wrong thing happens.
- Text is cut off, overlapping, unreadable, or shows raw code/placeholders.
- A wrong or missing error message (e.g. a bad email is accepted).
- The Portfolio shows **"Live feed offline"** on the live site.
- Telegram **Start** does not produce a welcome message, or the app never shows
  **"Connected as @..."**.
- Anything that looks broken on mobile but fine on desktop (or vice versa).

# Bug report template (copy for each issue)

```
Title:        (one line)
Where:        Landing / Core app  +  which step (e.g. "B11 step 3")
Device:       Desktop Chrome / iPhone Safari / etc.
What I did:   (the exact steps)
Expected:     (what the guide says should happen)
Actual:       (what really happened)
Screenshot:   (attach)
How often:    Every time / Sometimes / Once
```

---

### Quick coverage checklist

Landing: [ ] A1 [ ] A2 [ ] A3 [ ] A4 [ ] A5 [ ] A6 [ ] A7 [ ] A8 [ ] A9 [ ] A10 [ ] A11 [ ] A12 [ ] A13

Core app: [ ] B1 [ ] B2 [ ] B3 [ ] B4 [ ] B5 [ ] B6 [ ] B7 [ ] B8 [ ] B9 [ ] B10 [ ] B11 [ ] B12 [ ] B13
