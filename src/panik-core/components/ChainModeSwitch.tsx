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

import { Card } from "../ui";
import {
  CHAIN_MODE_LABEL,
  exitAvailabilityLine,
  setChainMode,
  useChainMode,
  type ChainMode,
} from "../lib/chainMode";

const ORDER: ChainMode[] = ["mainnet", "testnet"];

/**
 * `ChainModeBadge` used to live here: a "TESTNET" chip in the app header that
 * navigated to this card. It is gone with the header strip. Which chain is
 * selected is the SELECTED STATE of the control below, which is the honest
 * place for it, and a marker whose whole job was to point at a setting is a
 * marker the setting can carry itself.
 */

export function ChainModeSwitch() {
  const mode = useChainMode();
  const unavailable = exitAvailabilityLine(mode);
  return (
    <Card tone="raised" className="space-y-3">
      <div className="flex items-center gap-2 border-b border-border-subtle pb-2.5">
        <h3 id="chain-mode-heading" className="text-sm font-sans font-semibold text-text-primary">
          Network
        </h3>
      </div>

      {/* Two buttons rather than a slider: the choice is between two named
          chains, and a slider would leave the reader to work out which end is
          which. `aria-pressed` carries the state to a screen reader, and the
          selected one is a filled plate rather than a tinted one so no hue is
          spent on it.

          NO PARAGRAPH UNDER IT any more. "Positions and scores are read from
          Base, the chain your money is on" is the selected button's own label
          in a sentence, which is the copy rule's delete case: a label, a
          control, and a line only where the control is ambiguous. */}
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

      {/* The one line that survives, and only on the mode where it says
          something: that an exit cannot be signed here. It changes what the
          reader does next, which is the whole test. */}
      {unavailable && (
        <p className="font-sans text-xs leading-relaxed text-text-secondary">{unavailable}</p>
      )}
    </Card>
  );
}
