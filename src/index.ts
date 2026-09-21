/**
 * `@agent/usages` — usage and cost reporting for coding agents.
 *
 * The library is organized around two independent extension axes:
 *
 * - **Agents** ({@link AgentAdapter}) know where a coding agent keeps its usage
 *   state and convert it into the neutral {@link UsageDataset}.
 * - **Pricing providers** ({@link PricingProvider}) turn those records into money
 *   under one vendor's published price list.
 *
 * Adding either is a module plus a registry entry; nothing else needs to change.
 */

export * from './core/index.ts';
export * from './agents/index.ts';
export * from './pricing/index.ts';
export {
  expandWithDescendants,
  collectDescendantIds,
  listSessions,
  resolveProjectSelectors,
  resolveSessionSelectors,
  runQuery,
} from './report.ts';
export type {
  BandComponent,
  BandSummary,
  ModelBreakdown,
  ProjectReport,
  ReportContext,
  SessionListEntry,
  SessionListFilters,
  SessionListProject,
  SessionListResult,
  SessionReport,
  ScopeBreakdown,
  ScopeTotals,
  SubagentMode,
  UsageDimension,
  UsageQuery,
  UsageResult,
} from './report.ts';
export {
  COST_DIGITS,
  costOf,
  costOfGrouped,
  mergeCosts,
  moneyBreakdown,
  priceRecords,
  reconcile,
  renderRounded,
  sumTokens,
  summarize,
} from './accounting.ts';
export type { ComponentUsage, CostGroup, CostSummary, ExactCost, MoneyBreakdown, UsageCost } from './accounting.ts';
export { formatSessionList, formatUsageReport, sessionListToJson, usageToJson } from './format.ts';
export { inRange, parseInstant, presetRange, resolveRange } from './timerange.ts';
export type { RangePreset, TimeRange } from './timerange.ts';
