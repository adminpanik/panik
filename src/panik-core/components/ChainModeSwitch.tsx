/**
 * The network switch, and the marker that says which side of it you are on.
 *
 * Two honest modes, one product. Base shows the risk management working on the
 * chain the user's money is actually on. Base Sepolia shows the execution
 * working, because the exit executor is deployed there and nowhere else until
 * the audit lands. Before this, those were two builds, and the one that shipped
 * scored Base while offering a Base Sepolia exit button.
 *
 * The switch lives in Settings, which is where Aave puts the same control and
 * where a preference that is set once and then left alone belongs. What it must
 * NOT do is hide once it is set, so `ChainModeBadge` rides in the header for
 * the whole session while testnet is selected: a mode that changes what every
 * number on screen refers to has to be visible from every screen. It is absent
 * in the default mode on purpose, so the common case pays nothing for it.
 *
 * No risk hue anywhere in here. A chain is not a risk band, and the ramp is
 * rationed to the indicators that carry one (docs/DESIGN_SYSTEM.md).
 */

import {
  CHAIN_MODE_LABEL,
  exitAvailabilityLine,
  setChainMode,
  useChainMode,
  type ChainMode,
} from "../lib/chainMode";

const ORDER: ChainMode[] = ["mainnet", "testnet"];

/** What the mode changes about the reading. */
const MODE_BODY: Record<ChainMode, string> = {
  mainnet: "Positions and scores are read from Base, the chain your money is on.",
  testnet:
    "Positions and scores are read from Base Sepolia. Nothing you hold on Base is read or touched.",
};

/** The neutral header marker. Present only while the non-default chain is selected. */
export function ChainModeBadge({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const mode = useChainMode();
  if (mode === "mainnet") return null;
  const label = `${CHAIN_MODE_LABEL.testnet} mode. Positions come from the test network. Change it in Settings.`;
  return (
    <button
      type="button"
      onClick={onOpenSettings}
      title={label}
      aria-label={label}
      className="shrink-0 rounded-sm border border-border-strong px-2 py-1 text-2xs font-sans font-bold text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
    >
      TESTNET
    </button>
  );
}

export function ChainModeSwitch() {
  const mode = useChainMode();
  return (
    <div className="bg-surface-raised/50 border border-border-subtle p-6 rounded-lg space-y-3">
      <div className="flex items-center gap-2 border-b border-border-subtle pb-2.5">
        <h3 id="chain-mode-heading" className="text-2xs font-sans text-text-primary font-bold">
          Network
        </h3>
      </div>

      {/* Two buttons rather than a slider: the choice is between two named
          chains, and a slider would leave the reader to work out which end is
          which. `aria-pressed` carries the state to a screen reader, and the
          selected one is a filled plate rather than a tinted one so no hue is
          spent on it. */}
      <div className="flex gap-2" role="group" aria-labelledby="chain-mode-heading">
        {ORDER.map((option) => {
          const selected = option === mode;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={selected}
              onClick={() => setChainMode(option)}
              className={`h-9 flex-1 rounded-md border text-xs font-sans font-bold transition-colors cursor-pointer ${
                selected
                  ? "bg-text-primary text-surface-base border-text-primary"
                  : "bg-white/[0.02] text-text-secondary border-border-subtle hover:bg-white/[0.06] hover:text-text-primary"
              }`}
            >
              {CHAIN_MODE_LABEL[option]}
            </button>
          );
        })}
      </div>

      <p className="text-xs text-text-secondary leading-relaxed font-sans">
        {MODE_BODY[mode]} {exitAvailabilityLine(mode)}
      </p>
    </div>
  );
}
