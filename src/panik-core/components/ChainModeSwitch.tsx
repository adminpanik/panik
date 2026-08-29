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
 * NOT do is hide once it is set, so which chain is selected is the SELECTED
 * STATE of the control below, which is the honest place for it.
 *
 * No risk hue anywhere in here. A chain is not a risk band, and the ramp is
 * rationed to the indicators that carry one (docs/DESIGN_SYSTEM.md).
 */

import { Network } from "lucide-react";
import {
  SettingsCard,
  SettingsCardBlock,
  SettingsCardTitle,
  SettingsRow,
} from "./SettingsCard";
import {
  CHAIN_MODE_LABEL,
  EXIT_EXECUTABLE_MODE,
  setChainMode,
  useChainMode,
  type ChainMode,
} from "../lib/chainMode";

const ORDER: ChainMode[] = ["mainnet", "testnet"];

/**
 * `ChainModeBadge` used to live here: a "TESTNET" chip in the app header that
 * navigated to this card. It is gone with the header strip, for the reason
 * above: a marker whose whole job was to point at a setting is a marker the
 * setting can carry itself.
 */

export function ChainModeSwitch() {
  const mode = useChainMode();
  return (
    <SettingsCard>
      <SettingsCardTitle icon={Network} title="Network" />

      {/* One segmented strip rather than two plates with a gap between them,
          the same shape `RiskProfileToggle` takes below `md`: the choice is
          between two named chains and it reads as one control with two
          positions. `aria-pressed` carries the state to a screen reader, and
          the selected cell is lavender rather than a risk hue, because a chain
          is not a band. */}
      <SettingsCardBlock>
        <div
          role="group"
          aria-label="Which network the app reads"
          className="grid grid-cols-2 hard-edge shadow-hard-sm bg-surface-raised"
        >
          {ORDER.map((option, i) => {
            const selected = option === mode;
            return (
              <button
                key={option}
                type="button"
                aria-pressed={selected}
                onClick={() => setChainMode(option)}
                className={`h-12 min-w-0 cursor-pointer truncate px-1 label-type text-2xs text-text-primary ${
                  i > 0 ? "border-l-[3px] border-solid border-border-strong" : ""
                } ${selected ? "bg-highlight" : "bg-surface-raised"}`}
              >
                {CHAIN_MODE_LABEL[option]}
              </button>
            );
          })}
        </div>
      </SettingsCardBlock>

      {/* The one fact the strip cannot state, and it is now a reading rather
          than the 27-word sentence it replaces ("Exits cannot be signed on Base
          yet. The exit executor is deployed on Base Sepolia, and Base execution
          ships after the audit."). That sentence rendered only on the mode
          where exits do NOT work, so the card said nothing at all on the other
          one, and a settings row that appears and disappears is a row a reader
          cannot check.

          Derived from `EXIT_EXECUTABLE_MODE`, which `sync:exit-config` rewrites
          at cutover, so the day the executor moves to Base this row moves with
          it instead of standing there insisting on Sepolia. The long form
          survives on the surfaces where a control is actually being withheld:
          `exitUnavailableLine` still feeds the Advisor's exit hint and the exit
          modal's dead end. */}
      <SettingsRow label="Exits sign on" value={CHAIN_MODE_LABEL[EXIT_EXECUTABLE_MODE]} />
    </SettingsCard>
  );
}
