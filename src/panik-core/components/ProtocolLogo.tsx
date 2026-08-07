import React from "react";

/**
 * Official brand colours. Full-colour tiles are still correct in marketing
 * contexts, and the marks themselves are drawn from these.
 */
export const PROTOCOL_BRAND_HEX = {
  aave: "#8C82F2",
  moonwell: "#1D6AF3",
  morpho: "#2470FF",
  compound: "#00D395",
} as const;

/**
 * The hue the PRODUCT tile uses. Three of the four brands are already cool, so
 * they carry their own colour: a protocol is an identifier and the brand mark
 * is how people identify it, and four dead grey tiles down the left edge of the
 * positions list drain the rows of any life at all.
 *
 * Compound is the exception and it is not a stylistic one. Its #00D395 is a
 * saturated green, and green in this product means "risk-low" — a green tile
 * beside a CRITICAL chip states two contradictory things about the same row.
 * It is substituted with the nearest hue in the reserved cool chart palette.
 *
 * The tile stays a wash, never a fill: the mark renders at the hue, the
 * background at 10% of it. That is enough to separate four rows at a glance
 * and far too quiet to compete with a risk chip, which is a solid-bordered
 * tinted pill carrying a number.
 */
const PROTOCOL_TILE_HEX: Record<string, string> = {
  aave: "#8C82F2",
  moonwell: "#1D6AF3",
  morpho: "#2470FF",
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

/** Protocol brand mark — matches by name substring ("aave" / "moonwell"). */
export function ProtocolLogo({ protocol, size = "w-6 h-6" }: { protocol: string; size?: string }) {
  const name = protocol.toLowerCase();

  if (name.includes("aave")) {
    return (
      <div className={`${TILE} ${size}`} style={tint("aave")}>
        <svg viewBox="0 0 100 100" className="w-full h-full" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          {/* Aave Ghost Arc */}
          <path d="M 12,50 A 38,38 0 0,1 88,50 L 76,50 A 26,26 0 0,0 24,50 Z" />
          {/* Aave Eyes */}
          <circle cx="37" cy="50" r="7.5" />
          <circle cx="63" cy="50" r="7.5" />
        </svg>
      </div>
    );
  }
  if (name.includes("moonwell")) {
    return (
      <div className={`${TILE} ${size}`} style={tint("moonwell")}>
        <svg viewBox="0 0 100 100" className="w-full h-full" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          {/* Moonwell Left Crescent */}
          <path d="M 42,28 C 28,31 16,42 16,50 C 16,58 28,69 42,72 C 32,66 26,59 26,50 C 26,41 32,34 42,28 Z" />
          {/* Moonwell Right Crescent */}
          <path d="M 58,28 C 72,31 84,42 84,50 C 84,58 72,69 58,72 C 68,66 74,59 74,50 C 74,41 68,34 58,28 Z" />
        </svg>
      </div>
    );
  }
  if (name.includes("morpho")) {
    return (
      <div className={`${TILE} ${size}`} style={tint("morpho")}>
        <svg viewBox="0 0 100 100" className="w-full h-full" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          {/* Morpho butterfly — two mirrored wings */}
          <path d="M 50,22 C 38,34 24,38 16,38 C 16,56 30,72 48,78 L 50,60 Z" />
          <path d="M 50,22 C 62,34 76,38 84,38 C 84,56 70,72 52,78 L 50,60 Z" opacity="0.7" />
        </svg>
      </div>
    );
  }
  if (name.includes("compound")) {
    return (
      <div className={`${TILE} ${size}`} style={tint("compound")}>
        <svg viewBox="0 0 100 100" className="w-full h-full" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M15 30 H85 V42 H15 Z" />
          <path d="M15 48 H85 V60 H15 Z" opacity="0.8" />
          <path d="M15 66 H85 V78 H15 Z" opacity="0.6" />
        </svg>
      </div>
    );
  }
  return (
    <div className={`${TILE} ${size} font-sans font-bold text-xs`}>{protocol[0]}</div>
  );
}
