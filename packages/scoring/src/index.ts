export * from "./types";
export * from "./params";
export * from "./math";
export * from "./computeScore";
export * from "./profile";
export * from "./prospective";
export { scorePositionHealth } from "./subscores/positionHealth";
export { scoreAssetRisk } from "./subscores/assetRisk";
export { scoreProtocolSafety, PROTOCOL_SAFETY } from "./subscores/protocolSafety";
export { scoreSystemicRisk } from "./subscores/systemicRisk";
export * from "./markets";
export * from "./chains";
export * from "./adapters/prospective";
export * from "./adapters/chain";
export { AaveActiveReader, type ActiveReading } from "./adapters/activeAave";
export { MoonwellActiveReader } from "./adapters/activeMoonwell";
export { CompoundActiveReader, type CompoundReaderOptions } from "./adapters/activeCompound";
export { MorphoActiveReader } from "./adapters/activeMorpho";
export * from "./adapters/active";
export * from "./watch/loop";
export { formatAlert, formatWelcome, truncateWallet, type AlertExtras } from "./watch/alertMessage";
export {
  decideSend,
  type SendReason,
  type PriorAlert,
  type SendDecisionInput,
} from "./watch/alertPolicy";
export * from "./providers/types";
export { CoinGeckoProvider } from "./providers/coingecko";
export { DefiLlamaProvider } from "./providers/defillama";
export * from "./providers/chainlink";
export { TtlCache } from "./providers/cache";
export { DuneHistoryProvider, PANIK_FEATURES_QUERY_ID, EMPTY_FEATURES } from "./providers/duneHistory";
export { OpenRouterNarrator, fallbackNarration, fallbackCombined, type ProfileNarration } from "./providers/narrator";
// Advisor recommendation engine (deterministic; LLM narrates only) - Phase 2
export * from "./advisor/types";
export * from "./advisor/repayMath";
export {
  LIQUIDATION_PENALTY_BPS,
  DEFAULT_GAS_USD,
  repayUsdFloor,
  protocolRepayUsdFloor,
  type RepayFloorInput,
} from "./advisor/economicFloor";
export {
  adviseLeg,
  adviseWallet,
  safestAlternativeProtocol,
  REBALANCE_SAFETY_GATE,
  type AdviseOptions,
} from "./advisor/rules";
export {
  findOpportunities,
  DEFAULT_BUDGET_USD,
  FAMILIARITY_BOOST,
  type FindOpportunitiesInput,
  type ScenarioScorer,
  type YieldTable,
} from "./advisor/opportunities";
export { fallbackSections, overallHeadline, PROTOCOL_LABEL } from "./advisor/fallback";
export { insightsFromClassification } from "./advisor/insights";
export {
  AdvisorNarrator,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_FAILURE_THRESHOLD,
  type AdvisorNarratorOptions,
  type NarrationFallbackReason,
  type NarrationOutcome,
} from "./providers/advisorNarrator";
export {
  buildWhitelist,
  extractNumbers,
  fencePayload,
  hedgesOnVerdict,
  sanitizeSymbol,
  SYMBOL_MAX_LEN,
  UNKNOWN_TOKEN,
  verifyNarration,
  type NarrationVerdict,
  type NumberWhitelist,
  type NumericToken,
  type SanitizedSymbol,
} from "./providers/narrationGuard";
// DeFi-persona classifier (deterministic) — see docs/technical-docs/WALLET_PROFILER.md
export * from "./classify/types";
export * from "./classify/params";
export { classifyWallet, emergingProtocols, archetypeFor } from "./classify/classifyWallet";
export { alignmentOf } from "./classify/reconcile";
export { profileWallet, type WalletProfile } from "./classify/profileWallet";
export {
  startProfileScan,
  resolveProfileScan,
  type ProfileCache,
  type ProfileCacheEntry,
  type SessionDeps,
  type CombinedProfile,
  type StartResult,
  type ResolveResult,
} from "./classify/profileSession";
