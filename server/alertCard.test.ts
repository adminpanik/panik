/**
 * The card is decoration with a job: it must say the same thing the message
 * says, and it must never be the reason a message did not go out.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  alertCardSvg,
  CARD_CONTENT_WIDTH,
  DRILL_CHIP_WIDTH,
  estimateTextWidth,
  renderAlertCard,
  type AlertCardInput,
} from "./alertCard";

/** Every `<text>` on the card as {content, position, size, weight, colour}. */
const textRuns = (svg: string) =>
  [...svg.matchAll(/<text[^>]*?>([^<]*)<\/text>/g)].map((m) => ({
    content: m[1]!,
    y: Number(m[0].match(/ y="(\d+)"/)?.[1] ?? 0),
    size: Number(m[0].match(/font-size="(\d+)"/)?.[1] ?? 0),
    weight: Number(m[0].match(/font-weight="(\d+)"/)?.[1] ?? 400),
    fill: m[0].match(/fill="([^"]+)"/)?.[1],
    bold: m[0].includes('font-weight="700"'),
  }));

/**
 * The identity stack in render order: the name line (when there is one) and the
 * platform line. Identified by their treatment rather than by their content, so
 * the tests below are asserting what the card DOES rather than restating it.
 */
const identityLines = (svg: string) =>
  textRuns(svg).filter((r) => r.size === 22 && r.weight === 500);

const card = (over: Partial<AlertCardInput> = {}): AlertCardInput => ({
  score: 15,
  band: "LOW",
  status: "approaching",
  profile: "conservative",
  wallet: "0x12a5aa0f9f0d0f0e0a0b0c0d0e0f0102030a2305",
  protocol: "aave_v3",
  label: "Simulation target",
  chainLabel: "Base",
  ...over,
});

/**
 * The two colour channels, read back off the SVG separately.
 *
 * Separately is the point: a `toContain("#10B981")` passes when the hue is
 * ANYWHERE on the card, which is exactly how a green headline shipped beside a
 * green arc without a test noticing.
 */
const arcColorOf = (svg: string): string | undefined =>
  svg.match(/stroke="(#[0-9A-F]{6})" stroke-width="14"/i)?.[1];
const headlineColorOf = (svg: string): string | undefined =>
  svg.match(/<text[^>]*fill="(#[0-9A-F]{6})"[^>]*font-size="34"/i)?.[1];

/** The native rasteriser ships per-platform; the SVG tests do not need it. */
const resvgAvailable = (() => {
  try {
    createRequire(import.meta.url)("@resvg/resvg-js");
    return true;
  } catch {
    return false;
  }
})();

describe("alertCardSvg", () => {
  it("states the score, the headline and which position it is about", () => {
    const svg = alertCardSvg(card());
    expect(svg).toContain(">15<");
    expect(svg).toContain("Nearing your risk limit");
    expect(svg).toContain("Simulation target");
    expect(svg).toContain("0x12a5...2305");
    expect(svg).toContain("Aave V3");
  });

  it("leaves the limit sentence to the message, which has room to explain it", () => {
    // On the card it was a fourth line of small grey text under three other
    // facts, which is noise; in the body it is the sentence that stops a LOW
    // score with an alert attached from reading as a contradiction.
    for (const status of ["approaching", "outside", "within"] as const) {
      const svg = alertCardSvg(card({ status }));
      expect(svg).not.toContain("limit 25");
      expect(svg).not.toContain("alerts warn from");
      expect(svg).not.toMatch(/Conservative|Moderate|Aggressive/);
    }
  });

  it("colours the ARC by the band, the same one the app's dial uses", () => {
    for (const [band, hex] of [
      ["LOW", "#10B981"],
      ["ELEVATED", "#F59E0B"],
      ["HIGH", "#F97316"],
      ["CRITICAL", "#F87171"],
    ] as const) {
      expect(arcColorOf(alertCardSvg(card({ band })))).toBe(hex);
    }
    // An unrecognised band is drawn as UNKNOWN rather than as the calmest
    // colour in the ramp: "we do not know" must never render as "you are fine".
    expect(arcColorOf(alertCardSvg(card({ band: "UNMEASURED" as never })))).toBe("#7A8699");
  });

  /**
   * The two channels answer different questions, and the regression that made
   * this a separate describe was a green "Nearing your risk limit": a warning
   * painted in the colour of reassurance, because the headline had borrowed the
   * band's hue.
   */
  describe("headline colour is the EVENT, not the band", () => {
    it("warns in amber even when the score itself is LOW", () => {
      // The exact case: a conservative reader is warned at 15, and 15 IS low.
      const svg = alertCardSvg(card({ status: "approaching", score: 15, band: "LOW" }));
      expect(arcColorOf(svg)).toBe("#10B981");
      expect(headlineColorOf(svg)).toBe("#F59E0B");
    });

    it("keeps the warning amber at every band a warning can carry", () => {
      for (const band of ["LOW", "ELEVATED", "HIGH", "CRITICAL"] as const) {
        expect(headlineColorOf(alertCardSvg(card({ status: "approaching", band })))).toBe("#F59E0B");
      }
    });

    it("states a breach in high orange, whatever the band underneath", () => {
      for (const band of ["LOW", "ELEVATED", "HIGH"] as const) {
        const svg = alertCardSvg(card({ status: "outside", band }));
        expect(headlineColorOf(svg)).toBe("#F97316");
        expect(arcColorOf(svg)).toBe(
          { LOW: "#10B981", ELEVATED: "#F59E0B", HIGH: "#F97316" }[band],
        );
      }
    });

    it("lets CRITICAL stand on a breach, because that escalates", () => {
      // The one exception, and it only ever runs toward MORE severe: muting a
      // critical band to the high orange is the same mistake inverted.
      const svg = alertCardSvg(card({ status: "outside", score: 80, band: "CRITICAL" }));
      expect(headlineColorOf(svg)).toBe("#F87171");
      expect(arcColorOf(svg)).toBe("#F87171");
    });

    it("sounds the all-clear in green even when the band is still elevated", () => {
      // Back under YOUR limit is good news; the absolute band may be anything.
      const svg = alertCardSvg(card({ status: "within", score: 44, band: "ELEVATED" }));
      expect(headlineColorOf(svg)).toBe("#10B981");
      expect(arcColorOf(svg)).toBe("#F59E0B");
    });
  });

  it("draws the arc as score/100, clamped", () => {
    // 2 * pi * 86 = 540.35. A zero score leaves the whole circumference as the
    // dash offset; a full score leaves none.
    expect(alertCardSvg(card({ score: 0 }))).toContain('stroke-dashoffset="540.35"');
    expect(alertCardSvg(card({ score: 100 }))).toContain('stroke-dashoffset="0.00"');
    // Out of range cannot draw more than a circle.
    expect(alertCardSvg(card({ score: 480 }))).toContain('stroke-dashoffset="0.00"');
    expect(alertCardSvg(card({ score: -20 }))).toContain('stroke-dashoffset="540.35"');
  });

  it("marks a drill on the card itself, not only in the body", () => {
    expect(alertCardSvg(card({ simulated: true }))).toContain(">DRILL<");
    expect(alertCardSvg(card())).not.toContain("DRILL");
  });

  /**
   * The chip is a TAG, and it has to look like one. Carrying "SIMULATED DRILL"
   * in a 228px pill it was the widest amber object on the card and read as
   * heavier than the brand lockup opposite it, which inverts the order a reader
   * needs: whose warning this is first, that this one is a rehearsal second.
   *
   * Nothing is lost by shortening it. The full sentence lives in the message,
   * which says "Simulated event (label) - prices in this alert are from an armed
   * drill, not the market" above the body and repeats the reminder in the
   * footer; `alertMessage.test.ts` holds that copy to both ends.
   */
  describe("the drill chip is subordinate to the lockup", () => {
    /** The chip rect: the only one on the card's top edge. */
    const chip = (svg: string) => {
      const m = svg.match(/<rect x="(\d+)" y="40" width="(\d+)" height="32"/)!;
      return { x: Number(m[1]), width: Number(m[2]) };
    };

    /**
     * The brand lockup, measured with the renderer's own estimator: the 30px
     * mark, the 40px offset to the wordmark, and "PANIK" at 17px tracked 2.4.
     */
    const LOCKUP_WIDTH = 40 + estimateTextWidth("PANIK", 17) + "PANIK".length * 2.4;

    it("is sized to the word it carries, not to the one it used to", () => {
      const { x, width } = chip(alertCardSvg(card({ simulated: true })));
      expect(width).toBe(DRILL_CHIP_WIDTH);
      // The word plus its tracking fits inside, with padding to spare.
      expect(estimateTextWidth("DRILL", 14) + "DRILL".length * 1.2).toBeLessThan(width);
      // Still flush with the card's right margin, so it reads as placed.
      expect(x + width).toBe(760);
    });

    it("is narrower than the brand lockup it sits opposite", () => {
      expect(DRILL_CHIP_WIDTH).toBeLessThan(LOCKUP_WIDTH);
      // And materially smaller than the pill it replaces, rather than trimmed.
      expect(DRILL_CHIP_WIDTH).toBeLessThan(228 / 2);
    });
  });

  it("keeps the brand mark on a drill card too", () => {
    // A card with no logo is not obviously ours, and "ours" is half of why a
    // reader trusts the warning.
    expect(alertCardSvg(card({ simulated: true }))).toContain(">PANIK<");
  });

  it("says the all-clear for a recovery", () => {
    expect(alertCardSvg(card({ status: "within", score: 31, band: "LOW" }))).toContain(
      "Back under your limit",
    );
  });

  it("escapes a hostile label rather than emitting broken SVG", () => {
    const svg = alertCardSvg(card({ label: '<tspan>&"x"' }));
    expect(svg).toContain("&lt;tspan&gt;&amp;");
    expect(svg).not.toContain("<tspan>");
  });

  // Width-based truncation has its own describe below; this is the crude guard
  // that a runaway label never reaches the SVG at all.
  it("clips a label that would run off the card", () => {
    const svg = alertCardSvg(card({ label: "x".repeat(200) }));
    expect(svg).toContain("...");
    expect(svg).not.toContain("x".repeat(40));
  });
});

/**
 * The label is a nickname somebody typed into a text field. Setting it large,
 * bold and near-white under the headline gave it the typography of product
 * vocabulary - "Simulation target" read as a PANIK term for a kind of position
 * rather than as this reader's word for this wallet.
 */
describe("the wallet label has no title billing", () => {
  it("renders the label in quotation marks, as a given name", () => {
    // Quotes say "your word, not ours" in a way no font size can.
    const lines = identityLines(alertCardSvg(card({ label: "Simulation target" })));
    expect(lines[0]!.content).toBe('"Simulation target"');
  });

  it("is bright but not big: primary ink, medium weight, the address's size", () => {
    const runs = textRuns(alertCardSvg(card({ label: "Simulation target" })));
    const name = runs.find((r) => r.content.includes("Simulation target"))!;
    const headline = runs.find((r) => r.content === "Nearing your risk limit")!;
    const address = runs.find((r) => r.content.includes("0x12a5"))!;

    expect(name.fill).toBe("#F8FAFC");
    // 500 is a face that is actually loaded (PlusJakartaSans-Medium), so the
    // markup is not claiming a weight the image does not have.
    expect(name.weight).toBe(500);
    expect(name.bold).toBe(false);
    // The SIZE is what holds the hierarchy, so it does not move.
    expect(name.size).toBe(22);
    expect(name.size).toBe(address.size);
    expect(headline.size).toBe(34);
    expect(name.size).toBeLessThan(headline.size);
    // ...and the address stays the quieter of the two.
    expect(address.fill).toBe("#94A3B8");
  });

  it("leaves exactly two large elements: the score and the event", () => {
    const large = textRuns(alertCardSvg(card({ label: "Simulation target" })))
      .filter((r) => r.size >= 30)
      .map((r) => r.content);
    expect(large.sort()).toEqual(["15", "Nearing your risk limit"]);
  });

  /**
   * Three stacked lines, and the order is the argument: what the reader CALLS
   * it, what it IS, and then - after a wider gap, because it is a different
   * kind of fact - the address that identifies it.
   */
  describe("the identity stack", () => {
    it("stacks name, then platform, then address", () => {
      const [name, platform] = identityLines(alertCardSvg(card()));
      const address = textRuns(alertCardSvg(card())).find((r) => r.content.includes("0x12a5"))!;

      expect(name!.content).toBe('"Simulation target"');
      expect(platform!.content).toBe("Aave V3 - Base");
      expect(name!.y).toBeLessThan(platform!.y);
      expect(platform!.y).toBeLessThan(address.y);
      // The address is set apart, not merely next: its gap is the wider one.
      expect(address.y - platform!.y).toBeGreaterThan(platform!.y - name!.y);
    });

    it("separates platform from chain with a hyphen, not a middot", () => {
      const [, platform] = identityLines(alertCardSvg(card({ protocol: "compound_v3" })));
      expect(platform!.content).toBe("Compound V3 - Base");
      expect(alertCardSvg(card())).not.toContain("·");
    });

    it("drops the name line entirely when the wallet was never named", () => {
      for (const label of [null, undefined, "   "]) {
        const lines = identityLines(alertCardSvg(card({ label })));
        // No empty quotes standing in for the name nobody gave it.
        expect(lines).toHaveLength(1);
        expect(lines[0]!.content).toBe("Aave V3 - Base");
      }
    });

    it("centres BOTH variants, so neither reads as a layout accident", () => {
      const spread = (svg: string) => {
        const runs = textRuns(svg);
        const headline = runs.find((r) => r.size === 34)!;
        const address = runs.find((r) => r.content.includes("0x12a5"))!;
        const stackTop = identityLines(svg)[0]!.y;
        // Room above the stack (from the headline) vs below it (to the card
        // edge). Neither variant may hang off the top of an empty half-card.
        return { above: stackTop - headline.y, below: 360 - address.y };
      };

      for (const label of ["Simulation target", null]) {
        const { above, below } = spread(alertCardSvg(card({ label })));
        expect(above).toBeGreaterThan(30);
        expect(below).toBeGreaterThan(30);
        expect(Math.abs(above - below)).toBeLessThan(30);
      }
    });
  });

  /**
   * A card that says "Base" over a Base Sepolia position is a false claim about
   * where somebody's money is, so the chain is threaded in from the process that
   * built the scoring runtime rather than assumed.
   */
  describe("the chain segment", () => {
    const platformOf = (chainLabel: string | null | undefined) =>
      identityLines(alertCardSvg(card({ chainLabel })))[1]!.content;

    it("names the chain the worker actually scored", () => {
      expect(platformOf("Base")).toBe("Aave V3 - Base");
      // The testnet worker says so, rather than borrowing mainnet's name.
      expect(platformOf("Base Sepolia")).toBe("Aave V3 - Base Sepolia");
    });

    it("is dropped, not defaulted, when the caller names no chain", () => {
      for (const chainLabel of [null, undefined, "", "   "]) {
        const svg = alertCardSvg(card({ chainLabel }));
        expect(identityLines(svg)[1]!.content).toBe("Aave V3");
        expect(svg).not.toContain("Base");
      }
    });
  });

  it("keeps the address on its own mono line under the identity", () => {
    const svg = alertCardSvg(card());
    const identityAt = svg.indexOf('"Simulation target"');
    const addressAt = svg.indexOf("0x12a5...2305");
    expect(identityAt).toBeGreaterThan(-1);
    expect(addressAt).toBeGreaterThan(identityAt);
    expect(svg).toMatch(/font-family="JetBrains Mono" font-size="22">0x12a5\.\.\.2305/);
  });

  /**
   * THE REASON THIS IS STACKED. A single joined line read well for "Cold
   * wallet" and broke for a name someone actually typed.
   */
  describe("long names are cut, not allowed off the card", () => {
    const LONG = "My extremely long-term leveraged cbBTC position";

    it("truncates with an ellipsis and stays inside the content width", () => {
      const [name] = identityLines(alertCardSvg(card({ label: LONG })));
      expect(name!.content).not.toContain("position");
      expect(name!.content).toContain("...");
      expect(estimateTextWidth(name!.content, 22)).toBeLessThanOrEqual(CARD_CONTENT_WIDTH);
    });

    it("still closes the quote it opened", () => {
      // Clipping the already-quoted string eats the closing quote and leaves a
      // dangling one, which reads as a broken card rather than as a name.
      const [name] = identityLines(alertCardSvg(card({ label: LONG })));
      expect(name!.content.startsWith('"')).toBe(true);
      expect(name!.content.endsWith('"')).toBe(true);
      expect(name!.content).toBe('"My extremely long-term leverage..."');
    });

    it("holds the line for a 60-character name and a wide all-caps one", () => {
      for (const label of ["x".repeat(60), "W".repeat(60), "MMMM WWWW MMMM WWWW MMMM"]) {
        const [name] = identityLines(alertCardSvg(card({ label })));
        expect(name!.content).toContain("...");
        expect(estimateTextWidth(name!.content, 22)).toBeLessThanOrEqual(CARD_CONTENT_WIDTH);
      }
    });

    it("leaves a name that already fits completely alone", () => {
      const [name] = identityLines(alertCardSvg(card({ label: "Cold wallet" })));
      expect(name!.content).toBe('"Cold wallet"');
      expect(name!.content).not.toContain("...");
    });

    it("cuts the platform line too, so a long chain name cannot escape either", () => {
      const [, platform] = identityLines(
        alertCardSvg(card({ chainLabel: "A Chain With A Preposterously Long Name" })),
      );
      expect(estimateTextWidth(platform!.content, 22)).toBeLessThanOrEqual(CARD_CONTENT_WIDTH);
    });
  });
});

describe("renderAlertCard", () => {
  it.runIf(resvgAvailable)("rasterises a real PNG with the vendored fonts", () => {
    const png = renderAlertCard(card());
    expect(png).not.toBeNull();
    // PNG magic. Proves the fonts loaded too: resvg throws on a missing font
    // file rather than substituting one, and a throw here would be a null.
    expect([...png!.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // 800x420 at 2x is a real image, not an empty one.
    expect(png!.length).toBeGreaterThan(10_000);
  });

  it("returns null instead of throwing when the input cannot be drawn", () => {
    // NaN reaches the dash-offset arithmetic and produces an invalid attribute,
    // which resvg refuses. The contract is that the dispatcher gets a null and
    // sends text, never an exception mid-drain.
    const logs: string[] = [];
    expect(() =>
      renderAlertCard(card({ score: Number.NaN }), { error: (m) => logs.push(m) }),
    ).not.toThrow();
  });

  it("never throws on a hostile label", () => {
    expect(() => renderAlertCard(card({ label: '</svg><script>x</script>' }))).not.toThrow();
  });
});
