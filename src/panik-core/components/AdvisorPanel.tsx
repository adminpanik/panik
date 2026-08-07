/**
 * AI Advisor tab body (Phase 2). Renders the /api/advisor report: overall
 * banner, one card per position leg (the 4-section advice format), and the
 * OPEN opportunity row. Deterministic engine decides; sections may be
 * LLM-narrated server-side - this component only displays.
 *
 * Exit/Open CTAs are wired through optional callbacks so the panel ships
 * before the transaction flows do (undefined callback = disabled + tooltip).
 */

import React from "react";
import { AlertTriangle, ArrowRight, Eye, Sparkles, TrendingUp } from "lucide-react";
import type {
  AdvisorOpenPlan,
  AdvisorRecommendation,
  AdvisorReport,
  AdvisorUrgency,
  LiveProtocol,
} from "../lib/live";
import { ProtocolLogo } from "./ProtocolLogo";
import { EXIT_ENV } from "../lib/exit";

const PROTOCOL_LABEL: Record<LiveProtocol, string> = {
  aave_v3: "Aave V3",
  moonwell: "Moonwell",
  morpho: "Morpho",
  compound_v3: "Compound V3",
};

const URGENCY_CHIP: Record<AdvisorUrgency, string> = {
  info: "bg-white/[0.04] text-text-secondary border-border-subtle",
  warning: "bg-risk-elevated/10 text-risk-elevated border-risk-elevated/25",
  critical: "bg-risk-critical/10 text-risk-critical border-risk-critical/25",
};

const ACTION_CHIP: Record<string, string> = {
  HOLD: "bg-risk-low/10 text-risk-low border-risk-low/25",
  MONITOR: "bg-sky-500/10 text-sky-400 border-sky-500/25",
  REBALANCE: "bg-violet-500/10 text-violet-400 border-violet-500/25",
  REDUCE: "bg-risk-elevated/10 text-risk-elevated border-risk-elevated/25",
  EXIT: "bg-risk-critical/10 text-risk-critical border-risk-critical/25",
  OPEN: "bg-panik-orange/10 text-panik-orange border-panik-orange/25",
};

/** null = the engine could not price this leg (degraded feed); never show $0. */
const fmtUsd = (n: number | null) =>
  n === null || !Number.isFinite(n)
    ? "$…"
    : `$${Math.abs(n) >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toFixed(0)}`;

function SectionRow({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:gap-4">
      <span className="w-36 shrink-0 text-2xs font-mono tracking-widest uppercase text-text-muted pt-0.5">
        {label}
      </span>
      <p className="text-sm text-text-secondary leading-relaxed font-sans flex-1">{text}</p>
    </div>
  );
}

function ActionButton({
  rec,
  onExit,
  onOpen,
}: {
  rec: AdvisorRecommendation;
  onExit?: (prefill: NonNullable<AdvisorRecommendation["exitPrefill"]>) => void;
  onOpen?: (plan: AdvisorOpenPlan) => void;
}) {
  if (rec.action === "EXIT" || rec.action === "REDUCE") {
    const prefill = rec.exitPrefill ?? { protocol: rec.protocol, kind: "full" as const };
    const label = rec.action === "EXIT" ? "Execute exit" : "Reduce position";
    return (
      <span className="inline-flex items-center gap-2">
        {EXIT_ENV === "testnet" ? (
          <span className="px-1.5 py-0.5 rounded-sm border border-risk-elevated/40 bg-risk-elevated/10 text-risk-elevated text-2xs font-mono font-bold tracking-widest">
            TESTNET
          </span>
        ) : null}
        <button
          onClick={onExit ? () => onExit(prefill) : undefined}
          disabled={!onExit}
          title={onExit ? undefined : "Transaction flow ships with the Atomic Exit integration"}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-md text-xs font-mono font-bold tracking-wide transition-colors ${
            rec.action === "EXIT"
              ? "bg-risk-critical/15 text-risk-critical border border-risk-critical/30 hover:bg-risk-critical/25"
              : "bg-risk-elevated/15 text-risk-elevated border border-risk-elevated/30 hover:bg-risk-elevated/25"
          } disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {label} <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </span>
    );
  }
  if (rec.action === "OPEN" && rec.openPlan) {
    const plan = rec.openPlan;
    return (
      <button
        onClick={onOpen ? () => onOpen(plan) : undefined}
        disabled={!onOpen}
        title={onOpen ? undefined : "In-app opening ships with the position flows"}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-xs font-mono font-bold tracking-wide bg-panik-orange/15 text-panik-orange border border-panik-orange/30 hover:bg-panik-orange/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Open position <ArrowRight className="w-3.5 h-3.5" />
      </button>
    );
  }
  return null;
}

function NumbersStrip({ rec }: { rec: AdvisorRecommendation }) {
  const n = rec.numbers;
  const items: [string, string][] = [
    ["Score", `${n.total} · ${n.band}`],
    ["Health factor", n.healthFactor === null ? "no debt" : n.healthFactor.toFixed(2)],
    ["Collateral", fmtUsd(n.collateralValueUsd)],
    ["Debt", fmtUsd(n.borrowValueUsd)],
    ["Asset", n.scoredCollateralSymbol],
  ];
  if (n.usdValuesUnavailable) items.push(["Prices", "degraded - USD unverified"]);
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 pt-3 border-t border-border-subtle">
      {items.map(([label, value]) => (
        <div className="flex items-baseline gap-2" key={label}>
          <span className="text-2xs font-mono tracking-widest uppercase text-text-muted">{label}</span>
          <span className="text-xs font-mono tabular-nums text-text-secondary">{value}</span>
        </div>
      ))}
    </div>
  );
}

function RecommendationCard({
  rec,
  onExit,
  onOpen,
}: {
  rec: AdvisorRecommendation;
  onExit?: (prefill: NonNullable<AdvisorRecommendation["exitPrefill"]>) => void;
  onOpen?: (plan: AdvisorOpenPlan) => void;
}) {
  return (
    <div
      className={`bg-surface-raised/50 border rounded-lg p-5 space-y-4 ${
        rec.urgency === "critical"
          ? "border-risk-critical/30"
          : rec.urgency === "warning"
            ? "border-risk-elevated/20"
            : "border-border-subtle"
      }`}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <ProtocolLogo protocol={PROTOCOL_LABEL[rec.protocol]} size="w-8 h-8" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-display font-bold text-text-primary">
            {PROTOCOL_LABEL[rec.protocol]}
          </div>
          <div className="text-2xs font-mono text-text-muted tracking-wider uppercase">
            {rec.numbers.scoredCollateralSymbol} position
          </div>
        </div>
        <span
          className={`px-2.5 py-1 rounded-md border text-2xs font-mono font-bold tracking-widest ${ACTION_CHIP[rec.action] ?? URGENCY_CHIP[rec.urgency]}`}
        >
          {rec.action}
        </span>
      </div>

      <div className="space-y-3">
        <SectionRow label="Position" text={rec.sections.position} />
        <SectionRow label="Market" text={rec.sections.market} />
        <SectionRow label="Recommendation" text={rec.sections.recommendation} />
        <SectionRow label="Execution" text={rec.sections.execution} />
      </div>

      <NumbersStrip rec={rec} />

      <div className="flex justify-end">
        <ActionButton rec={rec} onExit={onExit} onOpen={onOpen} />
      </div>
    </div>
  );
}

function OpportunityCard({
  rec,
  onOpen,
}: {
  rec: AdvisorRecommendation;
  onOpen?: (plan: AdvisorOpenPlan) => void;
}) {
  const plan = rec.openPlan;
  if (!plan) return null;
  return (
    <div className="bg-surface-raised/50 border border-border-subtle rounded-lg p-5 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <ProtocolLogo protocol={PROTOCOL_LABEL[rec.protocol]} size="w-7 h-7" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-display font-bold text-text-primary truncate">
            {plan.collateralSymbol} on {PROTOCOL_LABEL[rec.protocol]}
          </div>
          <div className="text-2xs font-mono tabular-nums text-text-muted tracking-wider">
            Projected score {plan.projectedScore}
            {plan.apy !== null ? ` · ${(plan.apy * 100).toFixed(1)}% APY` : ""}
          </div>
        </div>
        <TrendingUp className="w-4 h-4 text-panik-orange/70" />
      </div>
      <p className="text-xs text-text-secondary leading-relaxed font-sans flex-1">
        {rec.sections.recommendation}
      </p>
      <div className="flex items-center justify-between pt-1">
        <span className="text-2xs font-mono tabular-nums text-text-muted">
          ~{fmtUsd(plan.collateralUsd)} collateral
          {plan.borrowUsd > 0 ? ` / ${fmtUsd(plan.borrowUsd)} borrow` : ""}
        </span>
        <ActionButton rec={rec} onOpen={onOpen} />
      </div>
    </div>
  );
}

export interface AdvisorPanelProps {
  report: AdvisorReport;
  onExit?: (prefill: NonNullable<AdvisorRecommendation["exitPrefill"]>) => void;
  onOpen?: (plan: AdvisorOpenPlan) => void;
}

export function AdvisorPanel({ report, onExit, onOpen }: AdvisorPanelProps) {
  const { overall, recommendations, opportunities, walletInsights } = report;
  return (
    <div className="space-y-6">
      {/* Overall banner */}
      <div
        className={`rounded-lg border p-4 flex items-start gap-3 ${
          overall.urgency === "critical"
            ? "bg-risk-critical/[0.06] border-risk-critical/30"
            : overall.urgency === "warning"
              ? "bg-risk-elevated/[0.05] border-risk-elevated/25"
              : "bg-surface-raised/50 border-border-subtle"
        }`}
      >
        {overall.urgency === "info" ? (
          <Eye className="w-4 h-4 mt-0.5 text-text-muted shrink-0" />
        ) : (
          <AlertTriangle
            className={`w-4 h-4 mt-0.5 shrink-0 ${overall.urgency === "critical" ? "text-risk-critical" : "text-risk-elevated"}`}
          />
        )}
        <div className="min-w-0">
          <p className="text-sm text-text-primary font-sans leading-relaxed">{overall.headline}</p>
          {walletInsights ? (
            <p className="text-2xs font-mono text-text-muted mt-1">
              Based on your history: {walletInsights.archetype}
              {walletInsights.lendingAgeDays > 0
                ? ` · ${Math.round(walletInsights.lendingAgeDays / 30)}mo lending tenure`
                : ""}
              {walletInsights.topProtocol ? ` · mostly ${walletInsights.topProtocol}` : ""}
              {walletInsights.liquidations > 0
                ? ` · ${walletInsights.liquidations} past liquidation${walletInsights.liquidations > 1 ? "s" : ""}`
                : " · no liquidations"}
            </p>
          ) : null}
          {report.narrated ? (
            <p className="text-2xs font-mono text-panik-orange/60 mt-1 flex items-center gap-1">
              <Sparkles className="w-3 h-3" /> AI-narrated · engine-decided
            </p>
          ) : null}
        </div>
      </div>

      {/* Position legs */}
      {recommendations.length > 0 ? (
        <div className="space-y-4">
          <h3 className="text-2xs font-mono tracking-widest uppercase text-text-muted">
            Your positions
          </h3>
          {recommendations.map((rec) => (
            <div key={`${rec.protocol}-${rec.numbers.scoredCollateralSymbol}`}>
              <RecommendationCard rec={rec} onExit={onExit} onOpen={onOpen} />
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-surface-raised/50 border border-border-subtle rounded-lg p-6 text-center">
          <p className="text-sm text-text-secondary font-sans">
            No open lending positions detected for this wallet on Base. The opportunities below are
            sized to your risk profile.
          </p>
        </div>
      )}

      {/* Opportunities */}
      {opportunities.length > 0 ? (
        <div className="space-y-4">
          <h3 className="text-2xs font-mono tracking-widest uppercase text-text-muted">
            Opportunities within your profile
          </h3>
          <div className="grid md:grid-cols-3 gap-4">
            {opportunities.map((rec) => (
              <div key={`${rec.protocol}-${rec.openPlan?.collateralSymbol}`} className="h-full">
                <OpportunityCard rec={rec} onOpen={onOpen} />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
