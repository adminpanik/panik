/**
 * The staging rules, which are the half of the watchlist UI that can be wrong
 * silently.
 *
 * A batch is authorized by ONE signature, so every op inside it rides on a
 * consent the user gave once. That makes "which ops does this draft produce"
 * a correctness question rather than a convenience one: an invented `remove`
 * turns off somebody's liquidation alerts, and a `label: null` sent where the
 * user changed only the profile blanks a name they chose.
 */

import { describe, expect, it } from "vitest";
import {
  canActOnViewedWallet,
  deepLinkTab,
  draftCount,
  draftFromSubscriptions,
  stagedOps,
  subscriptionFor,
  viewableWallets,
  viewParamWallet,
  type WatchDraftRow,
  type WatchSubscription,
} from "./watchlist";

const sub = (
  wallet: string,
  profile: WatchSubscription["profile"],
  label: string | null,
): WatchSubscription => ({
  wallet,
  profile,
  label,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
});

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);

describe("draftFromSubscriptions", () => {
  it("reads a null label back as the empty string an input holds", () => {
    expect(draftFromSubscriptions([sub(A, "moderate", null)])).toEqual([
      { wallet: A, profile: "moderate", label: "", isNew: false, removed: false },
    ]);
  });

  it("lowercases the wallet so a checksummed address is not a phantom edit", () => {
    const checksummed = "0x" + "A".repeat(40);
    expect(draftFromSubscriptions([sub(checksummed, "aggressive", "Cold")])[0].wallet).toBe(A);
  });
});

describe("stagedOps", () => {
  it("stages nothing for an untouched draft", () => {
    const server = [sub(A, "moderate", "Main"), sub(B, "conservative", null)];
    expect(stagedOps(server, draftFromSubscriptions(server))).toEqual([]);
  });

  it("stages nothing when a label is typed and typed back", () => {
    const server = [sub(A, "moderate", "Main")];
    const draft = draftFromSubscriptions(server);
    draft[0].label = "Something else";
    draft[0].label = "Main";
    expect(stagedOps(server, draft)).toEqual([]);
  });

  it("treats surrounding whitespace as no change", () => {
    const server = [sub(A, "moderate", "Main")];
    const draft = draftFromSubscriptions(server);
    draft[0].label = "  Main  ";
    expect(stagedOps(server, draft)).toEqual([]);
  });

  it("sends only the profile when only the profile moved", () => {
    const server = [sub(A, "moderate", "Main")];
    const draft = draftFromSubscriptions(server);
    draft[0].profile = "conservative";
    // No `label` key at all: absent means "leave whatever is there", and null
    // would blank the name the user chose.
    expect(stagedOps(server, draft)).toEqual([
      { op: "update", wallet: A, profile: "conservative" },
    ]);
  });

  it("sends an explicit null when a label is cleared", () => {
    const server = [sub(A, "moderate", "Main")];
    const draft = draftFromSubscriptions(server);
    draft[0].label = "";
    expect(stagedOps(server, draft)).toEqual([{ op: "update", wallet: A, label: null }]);
  });

  it("sends both when both moved", () => {
    const server = [sub(A, "moderate", null)];
    const draft = draftFromSubscriptions(server);
    draft[0].profile = "aggressive";
    draft[0].label = "Trading";
    expect(stagedOps(server, draft)).toEqual([
      { op: "update", wallet: A, profile: "aggressive", label: "Trading" },
    ]);
  });

  it("adds a new row with its label stated, null when it is blank", () => {
    const draft: WatchDraftRow[] = [
      { wallet: B, profile: "conservative", label: "", isNew: true, removed: false },
    ];
    expect(stagedOps([], draft)).toEqual([
      { op: "add", wallet: B, profile: "conservative", label: null },
    ]);
  });

  it("removes a row that exists on the server", () => {
    const server = [sub(A, "moderate", "Main")];
    const draft = draftFromSubscriptions(server);
    draft[0].removed = true;
    expect(stagedOps(server, draft)).toEqual([{ op: "remove", wallet: A }]);
  });

  it("stages nothing for a row added and removed in the same session", () => {
    // The API 404s a remove for a wallet the owner does not watch, which would
    // fail the whole transaction and take the other, valid ops down with it.
    const draft: WatchDraftRow[] = [
      { wallet: B, profile: "moderate", label: "Typo", isNew: true, removed: true },
    ];
    expect(stagedOps([], draft)).toEqual([]);
  });

  it("stages a mixed batch in row order", () => {
    const server = [sub(A, "moderate", "Main"), sub(B, "conservative", "Cold")];
    const draft = draftFromSubscriptions(server);
    draft[0].profile = "aggressive";
    draft[1].removed = true;
    draft.push({
      wallet: "0x" + "c".repeat(40),
      profile: "moderate",
      label: "New",
      isNew: true,
      removed: false,
    });
    expect(stagedOps(server, draft)).toEqual([
      { op: "update", wallet: A, profile: "aggressive" },
      { op: "remove", wallet: B },
      { op: "add", wallet: "0x" + "c".repeat(40), profile: "moderate", label: "New" },
    ]);
  });
});

describe("draftCount", () => {
  it("counts what the list would hold, not what it holds now", () => {
    const draft: WatchDraftRow[] = [
      { wallet: A, profile: "moderate", label: "", isNew: false, removed: true },
      { wallet: B, profile: "moderate", label: "", isNew: true, removed: false },
    ];
    expect(draftCount(draft)).toBe(1);
  });
});

describe("subscriptionFor", () => {
  const list = [sub(A, "conservative", "Main")];

  it("matches regardless of address case", () => {
    expect(subscriptionFor(list, "0x" + "A".repeat(40))?.profile).toBe("conservative");
  });

  it("answers null for a wallet that is not watched", () => {
    expect(subscriptionFor(list, B)).toBeNull();
  });

  it("answers null rather than guessing when the list was never read", () => {
    // The Compass hint hangs off this: "we could not read your watchlist" must
    // not render as "your subscribed profile is the one you are looking at".
    expect(subscriptionFor(null, A)).toBeNull();
  });
});

/**
 * What the Portfolio switcher offers. It is the same authority `viewParamWallet`
 * checks a link against, so the two are tested side by side.
 */
describe("viewableWallets", () => {
  it("puts the bound wallet first, with the label its own subscription carries", () => {
    expect(viewableWallets(A, [sub(B, "moderate", "The whale"), sub(A, "conservative", "Main")])).toEqual([
      { wallet: A, label: "Main", own: true },
      { wallet: B, label: "The whale", own: false },
    ]);
  });

  it("offers the bound wallet even with no self-subscription and no list at all", () => {
    // The self-subscription is written at onboarding and that write can fail (a
    // pasted address cannot sign). Dropping the user's own dashboard out of the
    // picker there is exactly the case where they most need to find it again.
    expect(viewableWallets(A, null)).toEqual([{ wallet: A, label: null, own: true }]);
    expect(viewableWallets("0x" + "A".repeat(40), [sub(B, "moderate", null)])).toEqual([
      { wallet: A, label: null, own: true },
      { wallet: B, label: null, own: false },
    ]);
  });

  it("offers nothing before a wallet is bound", () => {
    expect(viewableWallets(null, [sub(B, "moderate", "The whale")])).toEqual([]);
  });
});

/**
 * The `?view=` deep link, which arrives from OUTSIDE the app: it is the tail of
 * the "Open in PANIK" button on a Telegram alert (server/watchDispatch.ts).
 */
describe("canActOnViewedWallet", () => {
  it("allows the action when the shown wallet is the connected one", () => {
    expect(canActOnViewedWallet(A, A)).toBe(true);
  });

  it("ignores capitalisation, because an EVM address does", () => {
    expect(canActOnViewedWallet(A.toUpperCase(), A)).toBe(true);
    expect(canActOnViewedWallet(` ${A} `, A.toUpperCase())).toBe(true);
  });

  it("withholds the action on a wallet that is merely watched", () => {
    expect(canActOnViewedWallet(B, A)).toBe(false);
  });

  it("withholds it when no wallet is connected, however the dashboard got one", () => {
    // The pasted-address case: the dashboard is showing the user's OWN wallet
    // and there is still no key that could sign an exit for it.
    expect(canActOnViewedWallet(A, null)).toBe(false);
    expect(canActOnViewedWallet(A, undefined)).toBe(false);
  });

  it("withholds it before a wallet is bound at all", () => {
    expect(canActOnViewedWallet(null, A)).toBe(false);
    expect(canActOnViewedWallet(null, null)).toBe(false);
  });

  it("treats an empty string as no wallet rather than as a match", () => {
    expect(canActOnViewedWallet("", "")).toBe(false);
  });
});

describe("viewParamWallet", () => {
  const list = [sub(B, "moderate", "The whale")];

  it("honours a wallet the owner watches", () => {
    expect(viewParamWallet(`?view=${B}`, list, A)).toBe(B);
  });

  it("accepts the bound wallet even without a self-subscription row", () => {
    // That write can fail (a pasted address cannot sign), and the bound wallet
    // is the default view regardless.
    expect(viewParamWallet(`?view=${A}`, list, A)).toBe(A);
    expect(viewParamWallet(`?view=${A}`, null, A)).toBe(A);
  });

  it("normalises case, since the button lowercases and a user may not", () => {
    expect(viewParamWallet(`?view=0x${"B".repeat(40)}`, list, A)).toBe(B);
  });

  it("ignores a wallet that is not on the list", () => {
    // The parameter comes from a link. Honouring an arbitrary address would let
    // one render somebody else's position inside this dashboard.
    expect(viewParamWallet(`?view=0x${"c".repeat(40)}`, list, A)).toBeNull();
  });

  it("ignores a malformed or absent value, and says nothing about it", () => {
    expect(viewParamWallet("?view=not-an-address", list, A)).toBeNull();
    expect(viewParamWallet("?view=", list, A)).toBeNull();
    expect(viewParamWallet("?tab=compass", list, A)).toBeNull();
    expect(viewParamWallet("", list, A)).toBeNull();
  });

  it("answers null before a wallet is bound", () => {
    expect(viewParamWallet(`?view=${B}`, list, null)).toBeNull();
  });
});

describe("deepLinkTab", () => {
  const tabs = ["compass", "watch", "advisor", "portfolio", "settings"] as const;

  it("honours the tab the alert button asks for", () => {
    expect(deepLinkTab(`?view=${B}&tab=advisor`, tabs)).toBe("advisor");
  });

  it("normalises case", () => {
    expect(deepLinkTab("?tab=ADVISOR", tabs)).toBe("advisor");
  });

  it("ignores a tab this build does not have, and says nothing", () => {
    // A link from a newer or older version of the app. The right answer is the
    // screen the user would have got anyway.
    expect(deepLinkTab("?tab=trading", tabs)).toBeNull();
    expect(deepLinkTab("?tab=", tabs)).toBeNull();
    expect(deepLinkTab(`?view=${B}`, tabs)).toBeNull();
    expect(deepLinkTab("", tabs)).toBeNull();
  });
});
