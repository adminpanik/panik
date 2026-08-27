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
  wrapHeadline,
  type AlertCardInput,
} from "./alertCard";

/**
 * Every `<text>` on the card as {content, position, size, weight, colour}.
 *
 * `content` is the run with its markup stripped, because a value can carry a
 * `tspan` for the figure inside it ("cbBTC falls" + "4.8%") and the assertions
 * below are about what a reader sees, not about how it was assembled.
 */
const textRuns = (svg: string) =>
  [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map((m) => ({
    attrs: m[1]!,
    content: m[2]!.replace(/<[^>]*>/g, ""),
    x: Number(m[1]!.match(/ x="([\d.]+)"/)?.[1] ?? 0),
    y: Number(m[1]!.match(/ y="([\d.]+)"/)?.[1] ?? 0),
    size: Number(m[1]!.match(/font-size="([\d.]+)"/)?.[1] ?? 0),
    weight: Number(m[1]!.match(/font-weight="(\d+)"/)?.[1] ?? 400),
    family: m[1]!.match(/font-family="([^"]+)"/)?.[1],
    fill: m[1]!.match(/fill="([^"]+)"/)?.[1],
  }));

const card = (over: Partial<AlertCardInput> = {}): AlertCardInput => ({
  score: 15,
  band: "LOW",
  status: "approaching",
  profile: "conservative",
  wallet: "0x12a5aa0f9f0d0f0e0a0b0c0d0e0f0102030a2305",
  protocol: "aave_v3",
  label: "Simulation target",
  chainLabel: "Base",
  healthFactor: 1.05,
  collateralSymbol: "cbBTC",
  ...over,
});

/**
 * The card's ONE colour channel, read back off the SVG on its own.
 *
 * On its own is the point: a `toContain("#22C55E")` passes when the hue is
 * ANYWHERE on the card, which is exactly how a green headline once shipped
 * beside a green dial without a test noticing. The score panel is tagged
 * `id="alert-card-panel"` so this helper cannot match some other element.
 */
const panelColorOf = (svg: string): string | undefined =>
  svg.match(/id="alert-card-panel"[^>]*fill="(#[0-9A-F]{6})"/i)?.[1];

/** The headline, which is one run per line and always the largest words. */
const headlineRuns = (svg: string) => textRuns(svg).filter((r) => r.size === 40);
/** The position line: what this card is about, under the headline. */
const positionLine = (svg: string) => textRuns(svg).find((r) => r.size === 16 && r.family === "Archivo")!;
/** The ledger row along the bottom, cell by cell, in render order. */
const ledger = (svg: string) => {
  const runs = textRuns(svg);
  const captions = runs.filter((r) => r.size === 12);
  return captions.map((c) => ({
    caption: c.content,
    value: runs.find((r) => r.x === c.x && r.size >= 16 && r.y > c.y)!.content,
  }));
};

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
    expect(svg).toContain("Nearing your risk");
    expect(svg).toContain("Simulation target");
    expect(svg).toContain("0x12a5...2305");
    expect(svg).toContain("Aave V3");
  });

  it("leaves the limit sentence to the message, which has room to explain it", () => {
    // On the card it was a further line of small grey text under three other
    // facts, which is noise; in the body it is the sentence that stops a LOW
    // score with an alert attached from reading as a contradiction.
    for (const status of ["approaching", "outside", "within"] as const) {
      const svg = alertCardSvg(card({ status }));
      expect(svg).not.toContain("limit 25");
      expect(svg).not.toContain("alerts warn from");
      expect(svg).not.toMatch(/Conservative|Moderate|Aggressive/);
    }
  });

  it("colours the SCORE PANEL by the band, the same ramp RISK_CHIP uses", () => {
    for (const [band, hex] of [
      ["LOW", "#22C55E"],
      ["ELEVATED", "#F59E0B"],
      ["HIGH", "#FF5C00"],
      ["CRITICAL", "#EF4444"],
    ] as const) {
      const svg = alertCardSvg(card({ band }));
      expect(panelColorOf(svg)).toBe(hex);
      // ...and the band says its own name on the panel, so the colour is never
      // the only carrier of it.
      expect(svg).toContain(`>${band}<`);
    }
    // An unrecognised band is drawn as UNKNOWN rather than as the calmest
    // colour in the ramp: "we do not know" must never render as "you are fine".
    const unknown = alertCardSvg(card({ band: "UNMEASURED" as never }));
    expect(panelColorOf(unknown)).toBe("#9CA3AF");
    expect(unknown).toContain(">UNKNOWN<");
  });

  /**
   * THE PANEL IS THE ONLY COLOUR. An earlier card coloured the headline by what
   * the alert EVENT meant and the dial by the band, which put a risk hue on a
   * whole sentence. The design system rules that out ("never colour a whole
   * sentence"), and two colour channels for one position is one channel that
   * can drift from the other.
   */
  describe("the band colour lives on the panel and nowhere else", () => {
    const RAMP = ["#22C55E", "#F59E0B", "#FF5C00", "#EF4444", "#9CA3AF"];

    it("sets the headline in black at every status and every band", () => {
      for (const status of ["approaching", "outside", "within"] as const) {
        for (const band of ["LOW", "ELEVATED", "HIGH", "CRITICAL"] as const) {
          const svg = alertCardSvg(card({ status, band }));
          for (const line of headlineRuns(svg)) expect(line.fill).toBe("#000000");
          expect(panelColorOf(svg)).toBe(
            { LOW: "#22C55E", ELEVATED: "#F59E0B", HIGH: "#FF5C00", CRITICAL: "#EF4444" }[band],
          );
        }
      }
    });

    it("puts no ramp colour on any text at all", () => {
      // The exact case that made this a test: a conservative reader warned at a
      // score of 15, where 15 genuinely IS low. The panel is green and the
      // sentence beside it is black, not amber.
      for (const status of ["approaching", "outside", "within"] as const) {
        const runs = textRuns(alertCardSvg(card({ status, score: 15, band: "LOW" })));
        for (const run of runs) expect(RAMP).not.toContain(run.fill?.toUpperCase());
      }
    });

    it("uses the ramp exactly once in the whole document", () => {
      const svg = alertCardSvg(card({ band: "CRITICAL" }));
      expect(svg.match(/#EF4444/g)).toHaveLength(1);
    });
  });

  it("says the all-clear for a recovery", () => {
    expect(alertCardSvg(card({ status: "within", score: 31, band: "LOW" }))).toContain(
      "Back under your limit",
    );
  });

  it("keeps every line at or above the 11px floor", () => {
    const svg = alertCardSvg(card({ simulated: true }));
    for (const run of textRuns(svg)) expect(run.size).toBeGreaterThanOrEqual(11);
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
 * The score panel is the first thing a lock-screen thumbnail delivers: a block
 * of colour with a number on it, before any of it is read as words.
 */
describe("the score panel", () => {
  it("sets the score in mono at the card's one display size", () => {
    const score = textRuns(alertCardSvg(card({ score: 62 }))).find((r) => r.content === "62")!;
    expect(score.family).toBe("Space Mono");
    expect(score.weight).toBe(700);
    expect(score.size).toBe(150);
    expect(score.fill).toBe("#000000");
  });

  it("rounds and clamps the way the message rounds and clamps", () => {
    expect(alertCardSvg(card({ score: 61.6 }))).toContain(">62<");
    expect(alertCardSvg(card({ score: 480 }))).toContain(">100<");
    expect(alertCardSvg(card({ score: -20 }))).toContain(">0<");
  });

  it("says it does not know rather than printing a zero", () => {
    // A 0 on a green panel reads as "perfectly safe", which is the one lie this
    // product may never tell. Both channels go unknown together, so the panel
    // cannot be calm while the number is missing.
    const svg = alertCardSvg(card({ score: Number.NaN }));
    expect(svg).toContain(">?<");
    expect(svg).not.toContain(">0<");
    expect(panelColorOf(svg)).toBe("#9CA3AF");
    expect(svg).toContain(">UNKNOWN<");
  });

  it("leaves exactly one thing larger than the headline", () => {
    const large = textRuns(alertCardSvg(card({ score: 62, status: "outside" })))
      .filter((r) => r.size > 40)
      .map((r) => r.content);
    expect(large).toEqual(["62"]);
  });
});

/**
 * The headline is the card's one statement. `CARD_HEADLINE` holds three short
 * strings, and the wrap exists so a fourth one cannot run off the plate.
 */
describe("the headline", () => {
  it("is set in Archivo at the display size, in black", () => {
    for (const line of headlineRuns(alertCardSvg(card()))) {
      expect(line.family).toBe("Archivo");
      expect(line.weight).toBe(700);
      expect(line.fill).toBe("#000000");
    }
  });

  it("breaks on words, never mid-word, and never past two lines", () => {
    const long = "Nearing the limit you set on this particular leveraged position today";
    const lines = wrapHeadline(long);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines.join(" ")).toContain("Nearing the limit");
    for (const line of lines) {
      expect(estimateTextWidth(line, 40)).toBeLessThanOrEqual(CARD_CONTENT_WIDTH);
    }
    // Something had to give, and the card says so rather than dropping it.
    expect(lines[lines.length - 1]).toContain("...");
  });

  it("leaves a headline that already fits on one line", () => {
    expect(wrapHeadline("Over your risk limit")).toEqual(["Over your risk limit"]);
  });

  it("stacks its lines downward, with the position line under them", () => {
    const svg = alertCardSvg(card({ status: "approaching" }));
    const lines = headlineRuns(svg);
    for (let i = 1; i < lines.length; i++) expect(lines[i]!.y).toBeGreaterThan(lines[i - 1]!.y);
    expect(positionLine(svg).y).toBeGreaterThan(lines[lines.length - 1]!.y);
  });

  it("centres one-line and two-line headlines alike in the room they share", () => {
    // Neither variant may hang off the top of a half-empty card.
    const spread = (svg: string) => {
      const lines = headlineRuns(svg);
      return { top: lines[0]!.y, bottom: positionLine(svg).y };
    };
    const one = spread(alertCardSvg(card({ status: "outside" })));
    const two = spread(alertCardSvg(card({ status: "approaching" })));
    expect(two.top).toBeLessThan(one.top);
    expect(two.bottom).toBeGreaterThan(one.bottom);
    // Both stay clear of the header above and the ledger rule below.
    for (const s of [one, two]) {
      expect(s.top).toBeGreaterThan(72);
      expect(s.bottom).toBeLessThan(250);
    }
  });
});

/**
 * WHICH position, on one line: the reader's own name for it, then what it
 * actually is. The label is a nickname somebody typed into a text field, and
 * setting it large and bold under the headline gave it the typography of
 * product vocabulary - "Simulation target" read as a PANIK term for a kind of
 * position rather than as this reader's word for this wallet.
 */
describe("the position line", () => {
  it("reads name, protocol and chain as one sentence", () => {
    expect(positionLine(alertCardSvg(card({ label: "Main wallet" }))).content).toBe(
      "Main wallet, Aave V3 on Base",
    );
  });

  it("carries no quotation marks around a name the reader gave", () => {
    // The line is 16px plain text under a 40px headline, which already says
    // "this is a label, not the statement". Quotes added nothing, and a clipped
    // name left the opening one dangling with no closing one.
    const svg = alertCardSvg(card({ label: "Main wallet" }));
    expect(positionLine(svg).content).not.toContain('"');
    expect(svg).not.toContain("&quot;");
  });

  it("is quieter than the headline, and black rather than grey", () => {
    const svg = alertCardSvg(card());
    const line = positionLine(svg);
    expect(line.size).toBe(16);
    expect(line.weight).toBe(400);
    expect(line.fill).toBe("#000000");
    expect(line.size).toBeLessThan(headlineRuns(svg)[0]!.size);
  });

  it("drops the name entirely when the wallet was never named", () => {
    for (const label of [null, undefined, "   "]) {
      expect(positionLine(alertCardSvg(card({ label }))).content).toBe("Aave V3 on Base");
    }
  });

  it("names the chain the worker actually scored", () => {
    // A card that says "Base" over a Base Sepolia position is a false claim
    // about where somebody's money is.
    expect(positionLine(alertCardSvg(card({ chainLabel: "Base Sepolia" }))).content).toBe(
      "Simulation target, Aave V3 on Base Sepolia",
    );
    expect(positionLine(alertCardSvg(card({ protocol: "compound_v3" }))).content).toBe(
      "Simulation target, Compound V3 on Base",
    );
  });

  it("drops the chain segment, rather than defaulting it, when none was given", () => {
    for (const chainLabel of [null, undefined, "", "   "]) {
      const svg = alertCardSvg(card({ chainLabel }));
      expect(positionLine(svg).content).toBe("Simulation target, Aave V3");
      expect(svg).not.toContain("Base");
    }
  });

  /**
   * THE REASON THE PROTOCOL IS BUDGETED FIRST. A user-typed name can be
   * arbitrarily long, and a card that keeps "My extremely long-term leveraged
   * cbBTC position" intact and loses "Aave V3 on Base" has kept the wrong half.
   */
  describe("long names are cut, not allowed off the card", () => {
    const LONG = "My extremely long-term leveraged cbBTC position";

    it("truncates with an ellipsis and stays inside the content width", () => {
      const line = positionLine(alertCardSvg(card({ label: LONG })));
      expect(line.content).not.toContain("position");
      expect(line.content).toContain("...");
      expect(estimateTextWidth(line.content, 16)).toBeLessThanOrEqual(CARD_CONTENT_WIDTH);
    });

    it("keeps the protocol and the chain whole while it does it", () => {
      expect(positionLine(alertCardSvg(card({ label: LONG }))).content).toContain(
        "Aave V3 on Base",
      );
    });

    it("holds the line for a 60-character name and a wide all-caps one", () => {
      for (const label of ["x".repeat(60), "W".repeat(60), "MMMM WWWW MMMM WWWW MMMM"]) {
        const line = positionLine(alertCardSvg(card({ label })));
        expect(line.content).toContain("...");
        expect(estimateTextWidth(line.content, 16)).toBeLessThanOrEqual(CARD_CONTENT_WIDTH);
      }
    });

    it("leaves a name that already fits completely alone", () => {
      const line = positionLine(alertCardSvg(card({ label: "Cold wallet" })));
      expect(line.content).toBe("Cold wallet, Aave V3 on Base");
      expect(line.content).not.toContain("...");
    });

    it("cuts the platform line too, so a long chain name cannot escape either", () => {
      const line = positionLine(
        alertCardSvg(card({ label: null, chainLabel: "A Chain With A Preposterously Long Name" })),
      );
      expect(estimateTextWidth(line.content, 16)).toBeLessThanOrEqual(CARD_CONTENT_WIDTH);
    });
  });
});

/**
 * The ledger row is the two facts a reader acts on. Both come from the engine:
 * the buffer through `drawdownToLiquidation`, the address through
 * `truncateWallet`, so the card cannot disagree with the message beside it.
 */
describe("the ledger row", () => {
  it("states the buffer the same way the app's outlook states it", () => {
    const cells = ledger(alertCardSvg(card({ healthFactor: 1.05, collateralSymbol: "cbBTC" })));
    expect(cells[0]).toEqual({ caption: "LIQUIDATES IF", value: "cbBTC falls4.8%" });
  });

  it("sets the percentage in mono and the words in Archivo", () => {
    const svg = alertCardSvg(card());
    expect(svg).toMatch(/cbBTC falls<tspan font-family="Space Mono" font-weight="700"[^>]*>4\.8%/);
  });

  it("keeps the ticker's own casing, never uppercased", () => {
    expect(ledger(alertCardSvg(card({ collateralSymbol: "cbBTC" })))[0]!.value).toContain("cbBTC");
  });

  it("strips the engine's proxy suffix, as the message body does", () => {
    expect(ledger(alertCardSvg(card({ collateralSymbol: "WETH (proxy)" })))[0]!.value).toContain(
      "WETH falls",
    );
    expect(alertCardSvg(card({ collateralSymbol: "WETH (proxy)" }))).not.toContain("proxy");
  });

  it("names the collateral in words when the engine named no symbol", () => {
    expect(ledger(alertCardSvg(card({ collateralSymbol: null })))[0]!.value).toContain(
      "your collateral falls",
    );
  });

  it("drops the cell entirely when the caller holds no health factor", () => {
    const { healthFactor, ...rest } = card();
    const cells = ledger(alertCardSvg(rest as AlertCardInput));
    // One cell, and it is the wallet: an empty cell with a caption over it
    // claims a fact nobody has.
    expect(cells.map((c) => c.caption)).toEqual(["WALLET"]);
    expect(cells[0]!.value).toBe("0x12a5...2305");
  });

  it("gives the wallet the whole row when there is no buffer beside it", () => {
    const { healthFactor, ...rest } = card();
    const spanning = ledger(alertCardSvg(rest as AlertCardInput))[0]!;
    const split = ledger(alertCardSvg(card()))[1]!;
    expect(spanning.value).toBe(split.value);
    // ...and it starts where the first cell would have, not where the second did.
    const x = (svg: string, caption: string) =>
      textRuns(svg).find((r) => r.content === caption)!.x;
    expect(x(alertCardSvg(rest as AlertCardInput), "WALLET")).toBe(
      x(alertCardSvg(card()), "LIQUIDATES IF"),
    );
  });

  it("says no debt rather than a zero buffer", () => {
    // null is "no debt", which is a different claim from "we hold no reading".
    const cells = ledger(alertCardSvg(card({ healthFactor: null })));
    expect(cells[0]).toEqual({ caption: "LIQUIDATION RISK", value: "No debt" });
    expect(cells[0]!.value).not.toContain("0%");
  });

  it("says liquidatable now rather than falls 0%", () => {
    // "falls 0%" reads as "perfectly safe", the exact inverse of the truth.
    for (const hf of [1, 0.94, 0]) {
      const cells = ledger(alertCardSvg(card({ healthFactor: hf })));
      expect(cells[0]).toEqual({ caption: "LIQUIDATION RISK", value: "Liquidatable now" });
      expect(cells[0]!.value).not.toContain("0%");
    }
  });

  it("keeps the address on its own mono line, truncated as the message truncates it", () => {
    const svg = alertCardSvg(card());
    const address = textRuns(svg).find((r) => r.content.startsWith("0x"))!;
    expect(address.content).toBe("0x12a5...2305");
    expect(address.family).toBe("Space Mono");
    expect(address.weight).toBe(400);
    expect(address.fill).toBe("#000000");
  });
});

/**
 * The drill tag is a TAG, and it has to look like one. Carrying "SIMULATED
 * DRILL" in a 228px pill it was the widest object on the card and read as
 * heavier than the brand lockup opposite it, which inverts the order a reader
 * needs: whose warning this is first, that this one is a rehearsal second.
 *
 * Nothing is lost by shortening it. The full sentence lives in the message,
 * which says "Simulated event (label) - prices in this alert are from an armed
 * drill, not the market" above the body and repeats the reminder in the footer;
 * `alertMessage.test.ts` holds that copy to both ends.
 */
describe("the drill tag", () => {
  it("marks a drill on the card itself, not only in the body", () => {
    expect(alertCardSvg(card({ simulated: true }))).toContain(">DRILL<");
    expect(alertCardSvg(card())).not.toContain("DRILL");
  });

  it("is black and white, never the risk ramp", () => {
    // A simulation is not a risk band: a simulated position can be perfectly
    // safe, and the ramp on this card belongs to the score panel alone.
    const run = textRuns(alertCardSvg(card({ simulated: true }))).find(
      (r) => r.content === "DRILL",
    )!;
    expect(run.fill).toBe("#FFFFFF");
  });

  it("is sized to the word it carries, not to the one it used to", () => {
    const svg = alertCardSvg(card({ simulated: true }));
    const rect = svg.match(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="22"/)!;
    expect(Number(rect[3])).toBe(DRILL_CHIP_WIDTH);
    // The word plus its tracking fits inside, with padding to spare.
    expect(estimateTextWidth("DRILL", 11) + "DRILL".length * 0.66).toBeLessThan(DRILL_CHIP_WIDTH);
    // Still flush with the column's own right margin, so it reads as placed.
    expect(Number(rect[1]) + Number(rect[3])).toBe(734);
    // And materially smaller than the pill it replaces, rather than trimmed.
    expect(DRILL_CHIP_WIDTH).toBeLessThan(228 / 2);
  });

  it("is narrower than the brand lockup it sits opposite", () => {
    // The lockup, measured with the renderer's own estimator: the 26px mark, a
    // 10px gap, and "PANIK" at 13px tracked 0.78.
    const lockup = 26 + 10 + estimateTextWidth("PANIK", 13) + "PANIK".length * 0.78;
    expect(DRILL_CHIP_WIDTH).toBeLessThan(lockup);
  });

  it("keeps the brand mark and the wordmark on a drill card too", () => {
    // A card with no logo is not obviously ours, and "ours" is half of why a
    // reader trusts the warning.
    const svg = alertCardSvg(card({ simulated: true }));
    expect(svg).toContain(">PANIK<");
    expect(svg).toMatch(/<path d="m138 57/);
  });
});

describe("renderAlertCard", () => {
  it.runIf(resvgAvailable)("rasterises a real PNG with the vendored fonts", () => {
    const png = renderAlertCard(card());
    expect(png).not.toBeNull();
    // PNG magic. Proves the fonts loaded too: resvg throws on a missing font
    // file rather than substituting one, and a throw here would be a null.
    expect([...png!.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // 800x360 at 2x is a real image, not an empty one.
    expect(png!.length).toBeGreaterThan(10_000);
  });

  it("never throws on a score that cannot be drawn", () => {
    // The contract is that the dispatcher gets a buffer or a null, never an
    // exception mid-drain.
    const logs: string[] = [];
    expect(() =>
      renderAlertCard(card({ score: Number.NaN }), { error: (m) => logs.push(m) }),
    ).not.toThrow();
  });

  it("never throws on a hostile label", () => {
    expect(() => renderAlertCard(card({ label: "</svg><script>x</script>" }))).not.toThrow();
  });
});
