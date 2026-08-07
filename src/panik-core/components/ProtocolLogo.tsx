import React from "react";

/**
 * Official brand colours. Full-colour tiles are still correct in marketing
 * contexts, and these are the values the brands themselves publish.
 *
 * Aave's was wrong: #8C82F2 was an eyeballed approximation. The value in the
 * official brand kit (aave.com/brand -> aave-brand-assets.zip) is #9391F7.
 */
export const PROTOCOL_BRAND_HEX = {
  aave: "#9391F7",
  moonwell: "#1D6AF3",
  morpho: "#2470FF",
  compound: "#00D395",
} as const;

/**
 * The hue the PRODUCT tile uses. Aave carries its own brand colour; the other
 * three do not, and the reasons are specific rather than stylistic.
 *
 * Compound's #00D395 is a saturated green, and green in this product means
 * "risk-low" - a green tile beside a CRITICAL chip states two contradictory
 * things about the same row. It is substituted with the nearest hue in the
 * reserved cool chart palette (sky / cyan / blue / indigo / violet; see
 * src/index.css, where every warm family is deleted on purpose).
 *
 * Moonwell (#1D6AF3) and Morpho (#2470FF) are seven degrees of hue apart, and
 * both marks are bilaterally-symmetric mirrored pairs - two crescents facing
 * each other, two wings facing each other. At 24px, in two blues that close,
 * they were the same icon. They are pushed to opposite ends of the cool range
 * on BOTH axes: Moonwell takes sky-300, the lightest tint of the four, which
 * suits its thin open crescents; Morpho takes blue-500, deeper and more
 * saturated, which suits a mark that already reads heavier because its two
 * outer shapes render at 0.8 opacity against two solid inner ones. Neither is
 * a risk hue and neither can become one.
 *
 * The tile stays a wash, never a fill: the mark renders at the hue, the
 * background at 10% of it. That is enough to separate four rows at a glance
 * and far too quiet to compete with a risk chip, which is a solid-bordered
 * tinted pill carrying a number.
 */
const PROTOCOL_TILE_HEX: Record<string, string> = {
  aave: "#9391F7", // official Aave purple, already cool
  moonwell: "#7DD3FC", // sky-300 - the lightest of the four
  morpho: "#3B82F6", // blue-500 - deeper, to break the Moonwell collision
  compound: "#22D3EE", // cyan-400, standing in for a brand green we cannot use
};

const TILE =
  "rounded-md overflow-hidden shrink-0 flex items-center justify-center bg-surface-sunken border border-border-subtle text-text-secondary p-1.5";

/** Muted brand wash for a known protocol; neutral for anything unrecognised. */
function tint(key: string) {
  const hex = PROTOCOL_TILE_HEX[key];
  if (!hex) return undefined;
  return { color: hex, backgroundColor: `rgb(from ${hex} r g b / 0.10)` };
}

/**
 * Uniform fit of a source glyph onto the shared 24x24 mark canvas.
 *
 * Three of the four marks are NOT square (Aave is 1.91:1, Moonwell 1.67:1,
 * Compound's glyph is taller than it is wide), and Aave's published guidelines
 * explicitly forbid cropping, rotating, and "stretching or deforming the mark
 * in a non-uniform way". So there is one scale factor for both axes and the
 * leftover space becomes padding - never a squeeze onto a square.
 *
 * `box` is the OPTICAL extent, not the bounding box: a wide arch and a tall
 * chevron drawn to the same bounding box do not carry the same weight, so each
 * mark is tuned by eye at 24px and the number is recorded here.
 */
function fit(x: number, y: number, w: number, h: number, box: number): string {
  const s = box / Math.max(w, h);
  return `translate(${12 - (x + w / 2) * s} ${12 - (y + h / 2) * s}) scale(${s})`;
}

function Mark({ transform, children }: { transform: string; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="w-full h-full"
      fill="currentColor"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={transform}>{children}</g>
    </svg>
  );
}

/**
 * The four brand marks, copied verbatim from each protocol's own published
 * vector. Nothing here is drawn by hand; the previous versions were, and one
 * of them (Compound, three stacked bars) was not a low-fidelity approximation
 * of the real logo but a different shape entirely.
 *
 * Every hardcoded `fill` is stripped so the glyph inherits `currentColor` and
 * the tile controls the hue. Morpho's `opacity` attributes are KEPT: the
 * two-tone reading is part of the mark.
 *
 * LICENCE, honestly stated. Simple Icons carries none of these four (verified
 * against its raw sources and slugs.md). Moonwell's vector comes from an
 * MIT-licensed repo the protocol itself publishes. Aave publishes a brand kit
 * with usage guidelines but no software licence. Morpho and Compound publish
 * no licence at all for their marks. We rely on nominative fair use: these
 * marks appear only to identify the protocol a user's own position is held in,
 * never as endorsement, branding, or decoration.
 */
const MARKS: { key: string; body: React.ReactNode }[] = [
  {
    key: "aave",
    // https://aave.com/brand -> aave-brand-assets.zip -> Aave Logo/Logomark Purple.svg
    // Brand guidelines, no software licence. Source viewBox 0 0 266 139.
    body: (
      <Mark transform={fit(0, 0, 266, 139, 23)}>
        <path d="M97.542 138.533c14.919 0 27.014-12.095 27.014-27.015s-12.095-27.014-27.014-27.014c-14.92 0-27.015 12.095-27.015 27.014 0 14.92 12.095 27.015 27.015 27.015m70.607 0c14.92 0 27.015-12.095 27.015-27.015s-12.095-27.014-27.015-27.014-27.014 12.095-27.014 27.014c0 14.92 12.095 27.015 27.014 27.015" />
        <path d="M132.8 0C59.45 0-.02 60.602 0 135.335h33.926c0-56.007 43.917-101.415 98.874-101.415s98.874 45.408 98.874 101.415H265.6C265.613 60.602 206.144 0 132.8 0" />
      </Mark>
    ),
  },
  {
    key: "moonwell",
    // moonwell-fi/moonwell-sdk (the protocol's own GitHub org), repo licence MIT,
    // site/public/Moonwell-Logo-White.svg. Source viewBox 0 0 126.63 75.77.
    // NOT the sibling favicon.svg: that one embeds a <style> block hardcoding
    // `fill: black`, which fights currentColor.
    body: (
      <Mark transform={fit(0, 0, 126.63, 75.77, 23)}>
        <path d="m50.6,73.58c-3.97,1.42-8.25,2.19-12.72,2.19C16.96,75.77,0,58.81,0,37.89S16.96,0,37.89,0c4.46,0,8.74.77,12.72,2.19-14.67,5.23-25.17,19.23-25.17,35.7s10.5,30.47,25.17,35.7ZM88.75,0c-4.46,0-8.74.77-12.72,2.19,14.67,5.23,25.17,19.23,25.17,35.7s-10.5,30.47-25.17,35.7c3.97,1.42,8.25,2.19,12.72,2.19,20.92,0,37.89-16.96,37.89-37.89S109.67,0,88.75,0Z" />
      </Mark>
    ),
  },
  {
    key: "morpho",
    // Asset served by morpho.org:
    // https://evcop6xwrqrpqrf9.public.blob.vercel-storage.com/globals/morpho.ytmrj.svg
    // NO published licence - nominative use only. Source viewBox 0 0 22 20.
    body: (
      <Mark transform={fit(0, 0, 22, 20, 17.5)}>
        <path
          opacity="0.8"
          d="M2.53223 13.5905V19.4119C2.53223 19.7702 2.83552 19.919 2.92987 19.9528C3.02423 19.9934 3.34099 20.0813 3.62405 19.8176L8.02794 15.5854C8.40298 15.2251 8.76493 14.8463 9.03693 14.403C9.16496 14.1947 9.21802 14.0773 9.21802 14.0773C9.48764 13.5296 9.48764 13.0023 9.22469 12.4749C8.83394 11.6906 7.83638 10.8928 6.33337 10.1355L3.76559 11.5689C3.00402 12.0016 2.53223 12.7656 2.53223 13.5905Z"
        />
        <path d="M0 0.642806V6.74819C0 7.5122 0.512226 8.18831 1.24012 8.40467C3.72033 9.12136 8.04046 10.6629 9.08514 12.9279C9.21983 13.2254 9.30074 13.5162 9.32787 13.8204C10.022 12.5561 10.3388 11.1024 10.1905 9.62844C9.98823 7.53924 8.88286 5.63933 7.15759 4.42908L1.00423 0.122192C0.89638 0.0410568 0.768328 0.000488281 0.640278 0.000488281C0.53243 0.000488281 0.438076 0.0207726 0.336987 0.0748625C0.134785 0.189803 0 0.399404 0 0.642806Z" />
        <path
          opacity="0.8"
          d="M18.9113 13.5905V19.4119C18.9113 19.7702 18.6081 19.919 18.5136 19.9528C18.4194 19.9934 18.1024 20.0813 17.8195 19.8176L13.3131 15.487C13.0063 15.1922 12.7134 14.8804 12.4823 14.5231C12.2993 14.2403 12.2255 14.0773 12.2255 14.0773C11.9559 13.5296 11.9559 13.0023 12.2186 12.4749C12.6096 11.6906 13.6072 10.8928 15.11 10.1355L17.6779 11.5689C18.4463 12.0016 18.9113 12.7656 18.9113 13.5905Z"
        />
        <path d="M21.448 0.642318V6.74769C21.448 7.5117 20.9357 8.18782 20.2077 8.40418C17.7276 9.12086 13.4075 10.6624 12.3629 12.9274C12.2279 13.2249 12.147 13.5157 12.1201 13.8199C11.426 12.5556 11.1092 11.1019 11.2575 9.62797C11.4595 7.53874 12.5649 5.63886 14.2904 4.4286L20.4438 0.121701C20.5516 0.0405662 20.6796 0 20.8076 0C20.9154 0 21.0099 0.0202842 21.1108 0.0743741C21.3131 0.189315 21.448 0.398914 21.448 0.642318Z" />
      </Mark>
    ),
  },
  {
    key: "compound",
    // https://compound.finance/images/comp-icn.svg - NO published licence,
    // nominative use only. The source is a 0 0 20 20 badge: two dark circles
    // then the mark. Only the third path is taken, which yields a clean
    // monochrome glyph whose bounds are x 5.590..14.247 / y 4.673..15.612.
    // Those bounds (not the 20x20 viewBox) are what gets fitted, or the glyph
    // would arrive at 55% the size of its neighbours.
    body: (
      <Mark transform={fit(5.58984, 4.67328, 8.65716, 10.93902, 20)}>
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M6.03371 13.2405C5.75829 13.0721 5.58984 12.7721 5.58984 12.45V10.6512C5.58984 10.5823 5.60829 10.5159 5.64271 10.4569C5.74968 10.2725 5.98698 10.2098 6.17141 10.318L10.2313 12.6848C10.4686 12.8237 10.615 13.077 10.615 13.3524V15.2164C10.615 15.3012 10.5916 15.386 10.5473 15.4586C10.4133 15.6774 10.1281 15.7463 9.9092 15.6123L6.03371 13.2405ZM12.0855 9.82495C12.3228 9.96389 12.4691 10.2172 12.4691 10.4926V14.2746C12.4691 14.3865 12.4088 14.4897 12.3117 14.5438L11.4228 15.0442C11.4117 15.0504 11.3994 15.0553 11.3871 15.059V12.959C11.3871 12.6873 11.2445 12.4352 11.0109 12.295L7.44521 10.1618V7.79133C7.44521 7.72248 7.46366 7.65609 7.49808 7.59707C7.60505 7.41264 7.84235 7.34994 8.02678 7.45813L12.0855 9.82495ZM13.8622 7.03149C14.1007 7.1692 14.247 7.42494 14.247 7.70035V13.2246C14.247 13.3377 14.1843 13.4422 14.0847 13.4963L13.2425 13.9512V10.1053C13.2425 9.83356 13.0998 9.58274 12.8675 9.44257L9.22312 7.25649V5.00771C9.22312 4.93886 9.24156 4.87246 9.27476 4.81345C9.38173 4.62902 9.61903 4.56632 9.80346 4.67328L13.8622 7.03149Z"
        />
      </Mark>
    ),
  },
];

/** Protocol brand mark - matches by name substring ("aave" / "moonwell"). */
export function ProtocolLogo({ protocol, size = "w-6 h-6" }: { protocol: string; size?: string }) {
  const name = protocol.toLowerCase();
  const mark = MARKS.find((m) => name.includes(m.key));

  if (!mark) {
    // Unrecognised protocol: a neutral lettermark, never a guessed logo.
    return (
      <div title={protocol} className={`${TILE} ${size} font-sans font-bold text-xs`}>
        {protocol[0]}
      </div>
    );
  }

  return (
    <div title={protocol} className={`${TILE} ${size}`} style={tint(mark.key)}>
      {mark.body}
    </div>
  );
}
