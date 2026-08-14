/**
 * The card is decoration with a job: it must say the same thing the message
 * says, and it must never be the reason a message did not go out.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { alertCardSvg, renderAlertCard, type AlertCardInput } from "./alertCard";

const card = (over: Partial<AlertCardInput> = {}): AlertCardInput => ({
  score: 15,
  band: "LOW",
  status: "approaching",
  profile: "conservative",
  wallet: "0x12a5aa0f9f0d0f0e0a0b0c0d0e0f0102030a2305",
  protocol: "aave_v3",
  label: "Simulation target",
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
  it("states the score, the headline, the wallet and the limit", () => {
    const svg = alertCardSvg(card());
    expect(svg).toContain(">15<");
    expect(svg).toContain("Nearing your risk limit");
    expect(svg).toContain("Simulation target");
    expect(svg).toContain("0x12a5...2305");
    expect(svg).toContain("Aave V3");
    expect(svg).toContain("Conservative limit 25 · alerts warn from 15");
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
    expect(alertCardSvg(card({ simulated: true }))).toContain("SIMULATED DRILL");
    expect(alertCardSvg(card())).not.toContain("SIMULATED");
  });

  it("keeps the brand mark on a drill card too", () => {
    // A card with no logo is not obviously ours, and "ours" is half of why a
    // reader trusts the warning.
    expect(alertCardSvg(card({ simulated: true }))).toContain(">PANIK<");
  });

  it("says the all-clear for a recovery", () => {
    const svg = alertCardSvg(card({ status: "within", score: 31, band: "LOW" }));
    expect(svg).toContain("Back under your limit");
    expect(svg).not.toContain("alerts warn from");
  });

  it("escapes a hostile label rather than emitting broken SVG", () => {
    const svg = alertCardSvg(card({ label: '<tspan>&"x"' }));
    expect(svg).toContain("&lt;tspan&gt;&amp;");
    expect(svg).not.toContain("<tspan>");
  });

  it("clips a label that would run off the card", () => {
    const svg = alertCardSvg(card({ label: "x".repeat(200) }));
    expect(svg).toContain("...");
    expect(svg).not.toContain("x".repeat(40));
  });

  it("falls back to the address alone when there is no label", () => {
    const svg = alertCardSvg(card({ label: null }));
    expect(svg).toContain("0x12a5...2305");
    expect(svg).not.toContain("Simulation target");
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
