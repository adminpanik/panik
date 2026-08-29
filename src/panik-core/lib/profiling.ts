/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PANIK onboarding profiling: deterministic, explainable scoring.
 *
 * Two independent outputs from one 5-question behavioral quiz:
 *   1. User SEGMENT: Explorer | Yield Seeker | Liquidity Provider | Active Trader | Risk Optimizer
 *   2. Risk TIER: Conservative ... Aggressive (5 levels)
 *
 * Design notes (full rationale lives in the product spec):
 *  - Q2, Q4, Q5 are the behavioral core of the risk score (4 pts each = 12/18).
 *  - Q1 anchors the segment; Q3 disambiguates; Q5 is pure risk capacity.
 *  - Behavioral overrides beat the stated Q1 goal (someone who "just learns"
 *    but actively runs leverage is not an Explorer).
 */

export type OptionKey = "A" | "B" | "C" | "D" | "E";
export type QuestionId = "q1" | "q2" | "q3" | "q4" | "q5";
export type Answers = Partial<Record<QuestionId, OptionKey>>;

export type Segment =
  | "explorer"
  | "yield_seeker"
  | "liquidity_provider"
  | "active_trader"
  | "risk_optimizer";

export type RiskTier =
  | "conservative"
  | "moderately_conservative"
  | "moderate"
  | "moderately_aggressive"
  | "aggressive";

/** 3-level bucket the existing dashboard (Compass) already understands. */
export type RiskProfile3 = "conservative" | "moderate" | "aggressive";

export interface QuizQuestion {
  id: QuestionId;
  text: string;
  subtitle?: string;
  options: { key: OptionKey; label: string }[];
}

export const QUESTIONS: QuizQuestion[] = [
  {
    id: "q1",
    text: "What's your main focus in DeFi right now?",
    subtitle: "There's no wrong answer. This tailors what Panik shows you.",
    options: [
      { key: "A", label: "Learning how it works. I want to start carefully and understand the risks" },
      { key: "B", label: "Earning yield on crypto I already hold, without taking on too much risk" },
      { key: "C", label: "Providing liquidity to pools to earn trading fees" },
      { key: "D", label: "Actively moving capital to capture opportunities as markets move" },
      { key: "E", label: "Maximizing returns per unit of risk: leverage, capital efficiency, portfolio construction" },
    ],
  },
  {
    id: "q2",
    text: "One of your positions drops 25% in 48 hours. What do you do?",
    subtitle: "Go with your honest gut reaction.",
    options: [
      { key: "A", label: "Exit. Protecting what I have left is the priority" },
      { key: "B", label: "Hold and wait. It'll likely recover" },
      { key: "C", label: "Review it carefully, then decide whether to hold, trim, or exit" },
      { key: "D", label: "Consider adding to it. Lower prices can be better entry points" },
      { key: "E", label: "Assess whether to hedge, rebalance, or adjust leverage, then act on a plan" },
    ],
  },
  {
    id: "q3",
    text: "How often do you move capital between DeFi positions?",
    options: [
      { key: "A", label: "Rarely or never. I mostly hold, or I'm just getting started" },
      { key: "B", label: "Every few months, when a clearly better opportunity comes along" },
      { key: "C", label: "About monthly, based on yields and market conditions" },
      { key: "D", label: "Weekly or more. I'm always looking for better setups" },
      { key: "E", label: "On a set schedule or trigger. I rebalance systematically, not on impulse" },
    ],
  },
  {
    id: "q4",
    text: "What's your relationship with borrowing or leverage in DeFi?",
    options: [
      { key: "A", label: "I don't use it and don't plan to" },
      { key: "B", label: "I haven't used it, but I'm open to understanding it" },
      { key: "C", label: "I've used it in small amounts to experiment" },
      { key: "D", label: "I actively manage leveraged or borrowed positions" },
      { key: "E", label: "Leverage and capital efficiency are central to how I operate" },
    ],
  },
  {
    id: "q5",
    text: "How much of the crypto you're putting into DeFi could drop 50% without causing you serious stress?",
    subtitle: "This is about capacity to absorb a loss, not a prediction.",
    options: [
      { key: "A", label: "None of it. I need this to stay relatively safe" },
      { key: "B", label: "A small portion (less than 10%)" },
      { key: "C", label: "A meaningful slice (around a third)" },
      { key: "D", label: "Most of it (more than half)" },
      { key: "E", label: "All of it. I treat this as high-risk, high-conviction capital" },
    ],
  },
];

// ── Risk points per answer (total range 0–18) ─────────────────────────────
const RISK_POINTS: Record<QuestionId, Record<OptionKey, number>> = {
  q1: { A: 0, B: 1, C: 1, D: 2, E: 3 },
  q2: { A: 0, B: 1, C: 2, D: 3, E: 4 },
  q3: { A: 0, B: 1, C: 2, D: 3, E: 2 },
  q4: { A: 0, B: 1, C: 2, D: 3, E: 4 },
  q5: { A: 0, B: 1, C: 2, D: 3, E: 4 },
};

// ── Segment weights per answer (Q5 is pure risk → no segment weight) ───────
type SegmentWeights = Partial<Record<Segment, number>>;
const SEGMENT_WEIGHTS: Record<QuestionId, Partial<Record<OptionKey, SegmentWeights>>> = {
  q1: {
    A: { explorer: 3 },
    B: { yield_seeker: 3 },
    C: { liquidity_provider: 3 },
    D: { active_trader: 3 },
    E: { risk_optimizer: 3 },
  },
  q2: {
    A: { explorer: 1 },
    B: { yield_seeker: 1 },
    C: { liquidity_provider: 1 },
    D: { active_trader: 1 },
    E: { risk_optimizer: 2 },
  },
  q3: {
    A: { explorer: 2 },
    B: { yield_seeker: 1 },
    C: { liquidity_provider: 1 },
    D: { active_trader: 2 },
    E: { risk_optimizer: 2 },
  },
  q4: {
    A: { explorer: 1, yield_seeker: 1 },
    B: { yield_seeker: 1, liquidity_provider: 1 },
    C: { liquidity_provider: 1 },
    D: { active_trader: 1 },
    E: { risk_optimizer: 2 },
  },
  q5: {},
};

export const SEGMENT_LABELS: Record<Segment, string> = {
  explorer: "Explorer",
  yield_seeker: "Yield Seeker",
  liquidity_provider: "Liquidity Provider",
  active_trader: "Active Trader",
  risk_optimizer: "Risk Optimizer",
};

export const RISK_TIER_LABELS: Record<RiskTier, string> = {
  conservative: "Conservative",
  moderately_conservative: "Moderately Conservative",
  moderate: "Moderate",
  moderately_aggressive: "Moderately Aggressive",
  aggressive: "Aggressive",
};

/** One-line, plain-language description of each segment for the UI. */
export const SEGMENT_BLURB: Record<Segment, string> = {
  explorer: "New to DeFi and learning the ropes. Panik will keep things simple and explain as you go.",
  yield_seeker: "Focused on earning steady yield. Panik watches for yield that's quietly turning risky.",
  liquidity_provider: "You supply liquidity and know the risks. Panik tracks impermanent loss and range health.",
  active_trader: "You move fast and reallocate often. Panik gives you tight, real-time liquidation warnings.",
  risk_optimizer: "You optimize risk-adjusted returns. Panik surfaces portfolio-level, capital-efficiency signals.",
};

const SEGMENT_PRIORITY: Segment[] = [
  "risk_optimizer",
  "active_trader",
  "liquidity_provider",
  "yield_seeker",
  "explorer",
];

function toRiskTier(score: number): RiskTier {
  if (score <= 3) return "conservative";
  if (score <= 6) return "moderately_conservative";
  if (score <= 10) return "moderate";
  if (score <= 14) return "moderately_aggressive";
  return "aggressive";
}

/** Collapse the 5-level tier to the 3 buckets the Compass toggle uses. */
export function toRiskProfile3(tier: RiskTier): RiskProfile3 {
  if (tier === "conservative" || tier === "moderately_conservative") return "conservative";
  if (tier === "moderate") return "moderate";
  return "aggressive";
}

export interface ProfileResult {
  riskScore: number;
  riskTier: RiskTier;
  riskTierLabel: string;
  riskProfile3: RiskProfile3;
  segment: Segment;
  segmentLabel: string;
}

/**
 * Deterministic profiling. Missing answers count as 0 so partial inputs are
 * safe, though the UI only calls this once all five are answered.
 */
export function computeProfile(answers: Answers): ProfileResult {
  const ids: QuestionId[] = ["q1", "q2", "q3", "q4", "q5"];

  // 1. Risk score.
  let riskScore = 0;
  for (const id of ids) {
    const ans = answers[id];
    if (ans) riskScore += RISK_POINTS[id][ans];
  }
  const riskTier = toRiskTier(riskScore);

  // 2. Segment scores.
  const scores: Record<Segment, number> = {
    explorer: 0,
    yield_seeker: 0,
    liquidity_provider: 0,
    active_trader: 0,
    risk_optimizer: 0,
  };
  for (const id of ids) {
    const ans = answers[id];
    if (!ans) continue;
    const weights = SEGMENT_WEIGHTS[id][ans];
    if (!weights) continue;
    for (const seg of Object.keys(weights) as Segment[]) {
      scores[seg] += weights[seg] ?? 0;
    }
  }

  const anchor: Segment | null =
    answers.q1 != null ? (Object.keys(SEGMENT_WEIGHTS.q1[answers.q1] ?? {})[0] as Segment) : null;

  // argmax, tie-break to the Q1 anchor, then to a fixed priority order.
  let best: Segment = "explorer";
  let bestScore = -1;
  for (const seg of SEGMENT_PRIORITY) {
    const s = scores[seg];
    if (s > bestScore || (s === bestScore && seg === anchor)) {
      best = seg;
      bestScore = s;
    }
  }

  // 3. Behavioral overrides (beat the stated Q1 goal).
  let segment = best;
  const { q2, q3, q4 } = answers;
  if (q2 === "E" && q3 === "E" && q4 === "E") {
    segment = "risk_optimizer";
  } else if (q2 === "D" && q3 === "D" && q4 === "D") {
    segment = "active_trader";
  } else if (best === "explorer" && riskScore >= 7) {
    // "Learning" but behaving with real risk appetite → not an Explorer.
    segment = q4 === "D" || q4 === "E" || q2 === "D" ? "active_trader" : "yield_seeker";
  }

  return {
    riskScore,
    riskTier,
    riskTierLabel: RISK_TIER_LABELS[riskTier],
    riskProfile3: toRiskProfile3(riskTier),
    segment,
    segmentLabel: SEGMENT_LABELS[segment],
  };
}
