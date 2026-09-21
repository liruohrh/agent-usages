/**
 * The pricing contract.
 *
 * A *pricing provider* answers one question: given a request that happened at
 * instant `t` against model `m`, what does each of its token buckets cost?
 * Everything vendor-specific — which models exist, when prices changed, how peak
 * hours work, whether cache writes are billed — lives behind that question, so
 * adding a vendor means adding one module and one registry entry, never touching
 * the accounting or reporting layers.
 *
 * Two things are deliberately structured rather than hard-coded:
 *
 * - **Validity windows.** A model's price is a list of periods, each covering a
 *   half-open span of time. A request is priced by the period its own timestamp
 *   falls in, so one session can legitimately span several prices.
 * - **Billing components.** A period publishes a set of components
 *   (`input-miss`, `input-hit`, `output`, …) with a rate and the bucket it
 *   charges. A vendor that bills a bucket this tool has never heard of adds a
 *   component; a vendor that does not bill cache writes simply omits one.
 */

import type { CostTotals, TokenBuckets, UsageRecord } from '../core/types.ts';

/** A billable quantity: which tokens a rate applies to. */
export type TokenBucket = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

/**
 * Which buckets a component charges.
 *
 * `cacheWrite` is listed separately from `input` because vendors differ: some
 * fold cache writes into the ordinary input rate, others never bill them at all.
 */
export type BillingBasis =
  /** The cache-miss prompt tokens alone. */
  | 'input'
  /** The completion tokens (reasoning included). */
  | 'output'
  /** The prompt tokens served from cache. */
  | 'cacheRead'
  /** The prompt tokens written to cache. */
  | 'cacheWrite'
  /** Everything the caller could not cache: `input + cacheWrite`. */
  | 'inputAndCacheWrite'
  /** The whole prompt: `input + cacheRead + cacheWrite`. */
  | 'prompt';

/** One rate within a price period. */
export interface RateComponent {
  /** Stable component id, e.g. `input-miss`. Also the key in cost breakdowns. */
  id: string;
  /** Label for humans, e.g. `缓存未命中输入`. */
  label: string;
  /** Which tokens the rate charges. */
  basis: BillingBasis;
  /** Rate as an exact decimal string, per {@link RateComponent.per}. */
  rate: string;
  /** Token quantity one `rate` unit covers. */
  per: number;
}

/**
 * Which rate within a period applies to a given instant.
 *
 * Most vendors have a single flat rate. Vendors with time-of-day pricing supply
 * `tiers`: named groups of rates that apply during local wall-clock windows, and
 * the pricing engine picks the matching tier (or the `offPeak` rates when none
 * matches).
 */
export interface PeakWindow {
  /** Start hour, inclusive, in 24-hour local time. */
  fromHour: number;
  /** End hour, exclusive, in 24-hour local time. */
  toHour: number;
  /**
   * Weekdays (0 = Sunday … 6 = Saturday) the window applies to, or `null` for
   * every day. Vendors have changed this mid-flight, so it is data, not a rule.
   */
  weekdays: readonly number[] | null;
}

/** A model's rates across a contiguous span of time. */
export interface PricePeriod {
  /** Stable id, conventionally the effective date. */
  id: string;
  /** Label for display. */
  label: string;
  /** Inclusive start of validity, milliseconds since the Unix epoch. */
  from: number;
  /** Exclusive end of validity, or `null` when open-ended. */
  to: number | null;
  /** Rates charged outside every {@link PricePeriod.peakWindows} window. */
  offPeak: readonly RateComponent[];
  /** Rates charged inside a peak window; `null` when the period has no tiers. */
  peak: readonly RateComponent[] | null;
  /** Peak windows in {@link PricePeriod.timezone} wall-clock time. */
  peakWindows: readonly PeakWindow[];
  /** IANA zone the peak window hours are expressed in. */
  timezone: string;
  /**
   * Currency these rates are quoted in.
   *
   * Per period, not per provider: a vendor publishes its price list once per
   * currency (DeepSeek writes CNY for the Chinese site and USD for the
   * international one), and the two lists are separate published numbers rather
   * than a conversion of each other. A model may therefore carry parallel
   * periods, one per currency, covering the same windows.
   */
  currency: PricingCurrency;
  /** Where these rates were published. */
  source: string;
  /** Provenance note shown by `price`. */
  note: string;
}

/** One model's price history. */
export interface ModelPrice {
  /** Canonical model id. */
  model: string;
  /** Model names the vendor has routed to this model, including retired spellings. */
  aliases: readonly string[];
  /** Periods in ascending `from` order. */
  periods: readonly PricePeriod[];
}

/**
 * How the engine selected a period for one request.
 *
 * Reported alongside every cost so a reader can tell an exact hit from a
 * fallback instead of trusting a silently-approximated number.
 */
export type PriceResolution =
  /** The request's instant fell inside the period's validity window. */
  | 'exact'
  /** No period covered the instant; the earliest later period was used. */
  | 'fallback-later'
  /** No period covered or followed the instant; the latest earlier period was used. */
  | 'fallback-earlier'
  /** The model is unknown; the provider's default model schedule was used. */
  | 'fallback-default';

/** The rates chosen for one request. */
export interface ResolvedRate {
  /** Model whose schedule applied (may differ when a fallback was used). */
  model: string;
  /** The selected period. */
  period: PricePeriod;
  /** Tier within the period: `peak`, `off-peak`, or `flat`. */
  tier: 'peak' | 'off-peak' | 'flat';
  /** The components to charge. */
  components: readonly RateComponent[];
  /** How the period was selected. */
  resolution: PriceResolution;
}

/** One (model, period, tier) group of cost, before currency conversion. */
export interface CostBreakdown {
  /** Model that was billed. */
  model: string;
  /** Period id the rate came from. */
  periodId: string;
  /** Period label the rate came from. */
  periodLabel: string;
  /** Tier the rate came from. */
  tier: 'peak' | 'off-peak' | 'flat';
  /** How the period was selected. */
  resolution: PriceResolution;
  /** Requests billed under this group. */
  requests: number;
  /** Amount per component id, as exact decimal strings in the pricing currency. */
  amounts: Readonly<Record<string, string>>;
  /** Part of the output amount attributable to this group's reasoning tokens. */
  reasoningCost: string;
  /** Sum of {@link CostBreakdown.amounts}. */
  total: string;
}

/** Currency a provider's rates are quoted in. */
export interface PricingCurrency {
  /** ISO code, e.g. `CNY`. */
  code: string;
  /** Symbol for display. */
  symbol: string;
}

/**
 * A vendor's price list.
 *
 * Implementations are pure data plus the two lookups below; they never see the
 * filesystem, the clock, or the CLI, which keeps them trivially testable and
 * makes the temporal rules auditable.
 */
export interface PricingProvider {
  /** Provider id, e.g. `deepseek`. */
  id: string;
  /** Human-readable name. */
  label: string;
  /**
   * Model used when a record names something this provider has no schedule for.
   * `null` disables the fallback, in which case unknown models are reported as
   * unpriced instead of being guessed at.
   */
  defaultModel: string | null;
  /** Every model with a published schedule. */
  models(): readonly ModelPrice[];
  /** Find a schedule by canonical id, alias, or provider-qualified label. */
  find(model: string): ModelPrice | undefined;
}

/** Cost of one request, as charged. */
export interface RecordCost {
  /** Total charged, in the provider's currency. */
  total: bigint;
  /** Amount per component id, in the provider's currency. */
  amounts: Map<string, bigint>;
  /** The rates that produced the amounts. */
  rate: ResolvedRate;
}

/**
 * Turn records into money.
 *
 * The engine owns the two decisions every vendor shares — which period applies,
 * and which tier within it — and delegates the arithmetic to the components the
 * period published. Currency conversion is applied by the caller, after
 * grouping, so a converted total is the sum of converted parts.
 */
export interface PricingEngine {
  /** The provider backing this engine. */
  readonly provider: PricingProvider;
  /**
   * Resolve the rates for one record.
   * @param record - the record to price.
   * @returns the rates, or `undefined` when nothing can price this model.
   */
  resolve(record: UsageRecord): ResolvedRate | undefined;
  /**
   * Charge one record.
   * @param record - the record to price.
   * @returns the cost, or `undefined` when nothing can price this model.
   */
  costOf(record: UsageRecord): RecordCost | undefined;
  /** Describe a period's validity window for display. */
  describeWindow(period: PricePeriod): string;
  /** Describe a period's tiers for display. */
  describeTiers(period: PricePeriod): string;
  /** Human-readable name for a billing basis, for breakdown tables. */
  describeBasis(basis: BillingBasis): string;
  /**
   * Tokens one component charges for a given request.
   *
   * Exposed so a cost report can show which quantities produced each amount
   * without re-deriving the bucket arithmetic itself.
   */
  quantityOf(component: RateComponent, tokens: TokenBuckets): number;
}

/** Options for {@link createPricingEngine}. */
export interface PricingEngineOptions {
  /**
   * Model to fall back to when a schedule cannot price a record, overriding the
   * provider's own {@link PricingProvider.defaultModel}.
   */
  defaultModel?: string | null | undefined;
}

/** Everything a cost report exposes. */
export interface CostReport {
  /** Totals for the group. */
  totals: CostTotals;
  /** Per (model, period, tier) groups, newest period first. */
  breakdown: CostBreakdown[];
  /** Requests that were billed under some period. */
  priced: number;
  /** Records no schedule could price. */
  unpriced: number;
  /** Currency the amounts are expressed in. */
  currency: string;
}

/** Aggregate token totals from records. */
export type TokenTotalsOf = (records: readonly UsageRecord[]) => TokenBuckets;
