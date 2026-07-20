/**
 * Advisor narrator - rephrases a deterministic AdvisorRecommendation into the
 * 4-section advice format. Same contract as the persona narrator (narrator.ts):
 * the LLM NARRATES, it never decides. The action, urgency, and every number are
 * ground truth; any failure degrades to the deterministic fallback sections
 * already attached to the recommendation.
 *
 * Provider: OpenRouter, google/gemini-2.5-flash. Server-side only.
 */

import type { AdvisorRecommendation, AdvisorSections, WalletInsights } from "../advisor/types";
import type { RiskProfile } from "../types";
import type { FetchFn } from "./types";

const SYSTEM_PROMPT = `You narrate risk advice for ONE DeFi lending position. A deterministic engine
has already decided the action - you only phrase it. You receive: action, urgency, triggers,
numbers (PANIK score 0-100 where higher = more risk, band, healthFactor, collateral/borrow USD,
sub-scores), an optional repayPlan (repayUsd, targetHf), an optional openPlan (collateralUsd,
borrowUsd, projectedScore, apy), an optional rebalance target, the user's risk profile, and
optional wallet-history insights - ALL GROUND TRUTH.
NEVER change the action or urgency. NEVER invent, extrapolate, or re-round numbers (cite them as
given, at most 2 significant figures of rounding). NEVER soften a critical urgency. NEVER promise
outcomes ("you will be safe"). If a field is null or absent, omit it - do not say "unknown".
If insights are present you may reference the wallet's real history (e.g. its favorite protocol
or past liquidations) when it sharpens the advice - never fabricate history.

Return ONLY JSON:
{"position": string, "market": string, "recommendation": string, "execution": string}
- position: 1-2 sentences. Where the position stands: health factor, band, collateral vs debt,
  distance from liquidation - cite real values.
- market: 1-2 sentences. WHY the score is what it is - name the dominant driver from the
  sub-scores/triggers (position health, asset volatility, protocol safety, TVL stress) with its value.
- recommendation: 1-2 sentences, imperative mood. For REDUCE include the exact repayUsd and
  targetHf. For EXIT state that a full atomic exit is offered. For OPEN include the sized
  amounts and projected score/APY.
- execution: 1 sentence. What pressing the action button does (pre-filled amounts, which
  protocol, that the user signs the transaction from their own wallet).
Tone: calm, precise, factual. No hype, no hedging filler. Max ~40 words per section.`;

export interface AdvisorNarratorOptions {
  baseUrl?: string;
  model?: string;
  temperature?: number;
  fetchFn?: FetchFn;
}

export class AdvisorNarrator {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly fetchFn: FetchFn;

  constructor(
    private readonly apiKey: string,
    opts: AdvisorNarratorOptions = {},
  ) {
    this.baseUrl = opts.baseUrl ?? "https://openrouter.ai/api/v1";
    this.model = opts.model ?? "google/gemini-2.5-flash";
    this.temperature = opts.temperature ?? 0.3;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /**
   * Narrate one recommendation; on ANY failure return the deterministic
   * sections the engine already attached (rec.sections).
   */
  async narrate(
    rec: AdvisorRecommendation,
    profile: RiskProfile,
    insights?: WalletInsights,
  ): Promise<AdvisorSections> {
    try {
      return await this.callLlm(rec, profile, insights);
    } catch {
      return rec.sections;
    }
  }

  private async callLlm(
    rec: AdvisorRecommendation,
    profile: RiskProfile,
    insights?: WalletInsights,
  ): Promise<AdvisorSections> {
    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: this.temperature,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              action: rec.action,
              urgency: rec.urgency,
              protocol: rec.protocol,
              triggers: rec.triggers,
              numbers: rec.numbers,
              repayPlan: rec.repayPlan ?? null,
              openPlan: rec.openPlan ?? null,
              rebalance: rec.rebalance ?? null,
              profile,
              insights: insights ?? null,
            }),
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter: HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenRouter: empty completion");
    const parsed = JSON.parse(content) as Partial<AdvisorSections>;
    if (
      typeof parsed.position !== "string" ||
      typeof parsed.market !== "string" ||
      typeof parsed.recommendation !== "string" ||
      typeof parsed.execution !== "string"
    ) {
      throw new Error("OpenRouter: malformed JSON");
    }
    return {
      position: parsed.position,
      market: parsed.market,
      recommendation: parsed.recommendation,
      execution: parsed.execution,
    };
  }
}
