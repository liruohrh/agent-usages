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

import type { CalendarId, HolidayCalendar } from '../config/holidays.ts';
import type { CacheWriteTtl, CostTotals, TokenBuckets, UsageRecord } from '../core/types.ts';

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

/**
 * A long-context tranche: the quantity above `tokens` is billed at `rate`.
 *
 * Graduated, not a flat surcharge: the first `tokens` units keep the component's
 * own `rate`, so the charge is `min(q, tokens) × rate + max(0, q − tokens) × rate′`
 * — the way a published "over 200k, the excess costs more" table reads. It is
 * applied per request, to the quantity this component bills, and per component:
 * a vendor whose threshold spans several buckets states it on each of them.
 */
export interface AboveThreshold {
  /** Units of the component's own basis billed at `rate` before the higher rate starts. */
  tokens: number;
  /** Rate for the units above {@link AboveThreshold.tokens}, quoted per {@link RateComponent.per}. */
  rate: string;
}

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
  /**
   * Higher rate for the quantity above a threshold, when the vendor publishes one.
   *
   * Absent means one rate for the whole quantity, which is the common case.
   */
  aboveThreshold?: AboveThreshold | undefined;
  /**
   * Cache-write TTL multipliers over {@link RateComponent.rate}, keyed by tier.
   *
   * Only meaningful on a component that bills cache writes alone (`cacheWrite`):
   * the multiplier reprices those tokens for a longer-lived cache, and a rate
   * that folds writes into another basis has no separate write quantity to
   * reprice. A missing tier means that tier costs the base rate, which is why a
   * record without a TTL is billed at `rate` unchanged.
   */
  ttlMultipliers?: Readonly<Partial<Record<CacheWriteTtl, string>>> | undefined;
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
  /** Peak windows in the period's own wall-clock time. */
  peakWindows: readonly PeakWindow[];
  /**
   * Holiday calendar whose days are off-peak for the whole day.
   *
   * DeepSeek's peak windows are "Monday to Friday, excluding Chinese public
   * holidays": a weekday that happens to be a holiday is off-peak all day, and
   * the dates cannot be computed (lunar calendar plus a yearly announcement), so
   * they come from `config/holidays.json` — see {@link PricePeriod.peakWindows}.
   * Absent means "this period only knows about weekdays".
   */
  holidayCalendar?: CalendarId | undefined;
  /**
   * Minutes east of UTC that this period's wall clock runs on.
   *
   * Read from the offset the period's own `from` carries (`+08:00` → 480), which
   * is why a period never names a zone: the timestamps already say which clock
   * the vendor's hours are written in. A vendor whose hours follow a DST zone
   * would need that zone back; none of the published lists here do.
   */
  utcOffset: number;
  /**
   * ISO code of the currency these rates are quoted in.
   *
   * Per period, not per provider: a vendor publishes its price list once per
   * currency (DeepSeek writes CNY for the Chinese site and USD for the
   * international one), and the two lists are separate published numbers rather
   * than a conversion of each other. A model may therefore carry parallel
   * periods, one per currency, covering the same windows.
   *
   * Only the code is data: its symbol comes from the tool's own currency table,
   * so a new period never has to spell out how to print the money.
   */
  currency: string;
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
  /** Why that tier: a peak window, a holiday, everything else, or no tiers. */
  reason: TierReason;
  /** The holiday's name, when {@link ResolvedRate.reason} is `holiday`. */
  holiday?: string | undefined;
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
  /**
   * Tranche detail per component id, present only where a second rate applied.
   *
   * A view of {@link CostBreakdown.amounts}, never an extra line: the amounts here
   * are parts of the component's own amount, so summing this beside `amounts`
   * would count money twice.
   */
  charges?: Readonly<Record<string, CostCharge>> | undefined;
  /** Part of the output amount attributable to this group's reasoning tokens. */
  reasoningCost: string;
  /** Sum of {@link CostBreakdown.amounts}. */
  total: string;
}

/** How one band component's money split, at display precision. */
export interface CostCharge {
  /** Tokens billed at the component's own rate. */
  baseTokens: number;
  /** Tokens billed above the long-context threshold. */
  excessTokens: number;
  /** Money the excess tranche produced; part of the component's amount. */
  excessAmount: string;
  /** Published rate the excess was billed at, or `null` when nothing exceeded it. */
  excessRate: string | null;
  /** Cache-write TTL tier that scaled the rate, or `null` when none did. */
  ttlTier: CacheWriteTtl | null;
  /** Tokens whose rate the tier scaled. */
  ttlTokens: number;
  /** The multiplier the tier applied, as an exact decimal string (`"1"` when none). */
  ttlMultiplier: string;
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
  /** Total charged, in the currency the record is being reported in. */
  total: bigint;
  /** Amount per component id, in the currency the record is being reported in. */
  amounts: Map<string, bigint>;
  /** The rates that produced the amounts. */
  rate: ResolvedRate;
  /**
   * How a component's charge was split, keyed by component id.
   *
   * Present only for components whose money was changed by a tranche or a TTL
   * multiplier: `amounts` stays the authority on what was charged, and this only
   * explains the part of it that a second rate produced. A component whose rate
   * card has neither never appears here, so the common record carries no map.
   */
  charges?: ReadonlyMap<string, ComponentCharge> | undefined;
}

/**
 * One component's charge for one request, split by what produced it.
 *
 * The pieces are exact (`base + excess === total`, in scaled units) so a report
 * can attribute the money without re-deriving it, and without the split losing
 * or duplicating a fraction of a unit.
 */
export interface ComponentCharge {
  /** Amount charged at the component's own rate, TTL multiplier included. */
  base: bigint;
  /** Amount charged above the long-context threshold; `0n` when nothing exceeded it. */
  excess: bigint;
  /** `base + excess`, exactly. */
  total: bigint;
  /** Quantity billed at the component's own rate. */
  baseTokens: number;
  /** Quantity billed above the threshold. */
  excessTokens: number;
  /** Rate the excess was billed at, scaled by 1e9, or `null` when none was. */
  excessRate: bigint | null;
  /** Cache-write TTL tier that scaled the rate, or `null` when no tier changed it. */
  ttlTier: CacheWriteTtl | null;
  /** Tokens whose rate {@link ComponentCharge.ttlTier} scaled. */
  ttlTokens: number;
  /** Multiplier the tier applied, scaled by 1e9 (`1_000_000_000n` = 1×). */
  ttlMultiplier: bigint;
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

/** Why a record landed in the tier it did, for reports and readers. */
export type TierReason =
  /** Inside a peak window on a working day. */
  | 'peak-window'
  /** A day the calendar says is a holiday: off-peak all day. */
  | 'holiday'
  /** Outside every window, or on a day no window applies to. */
  | 'off-window'
  /** The period has no tiers at all. */
  | 'flat';

/** Options for {@link createPricingEngine}. */
export interface PricingEngineOptions {
  /**
   * Model to fall back to when a schedule cannot price a record, overriding the
   * provider's own {@link PricingProvider.defaultModel}.
   */
  defaultModel?: string | null | undefined;
  /**
   * Currency factor to apply to one record's amounts, by its instant.
   *
   * The usual conversion rewrites a provider's *rates* once, which needs a single
   * factor. A report that converts at the rate of each record's own date cannot
   * do that, so it hands the factor in here instead: the amounts come out already
   * converted, and everything above them — bands, totals, the tree — stays as
   * additive as before. Returns a decimal string, units of the display currency
   * per one unit of the price list's.
   */
  convertAt?: ((instant: number) => string) | undefined;
  /**
   * The holiday calendar periods may refer to.
   *
   * A period that names a calendar this engine does not have keeps the weekday
   * rule — and the configuration says so, because the alternative is billing a
   * holiday at the peak rate without telling anyone.
   */
  holidays?: HolidayCalendar | undefined;
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
