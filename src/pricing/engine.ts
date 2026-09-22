/**
 * The provider-neutral pricing engine.
 *
 * Two decisions belong to every vendor and therefore live here rather than in a
 * vendor module:
 *
 * 1. **Which period applies.** A record is priced by its own timestamp, using the
 *    half-open validity window that contains it. When nothing contains it the
 *    caller's documented fallback order applies: prefer the earliest period that
 *    starts *after* the instant, else the latest that starts before it. Nothing
 *    is ever silently guessed without {@link PriceResolution} saying so.
 * 2. **Which tier applies.** Peak windows are wall-clock properties of the
 *    period's *own* timezone, so the answer never depends on the machine's zone
 *    or on daylight-saving rules the vendor never mentioned.
 *
 * The arithmetic is the component list's job: each component names a token basis
 * and a rate per N tokens, so a vendor that bills a bucket nobody else bills just
 * lists another component.
 */

import { MONEY_SCALE, parseDecimal } from '../core/money.ts';
import { t } from '../i18n/index.ts';
import type { TokenBuckets, UsageRecord } from '../core/types.ts';
import {
  type BillingBasis,
  type CostBreakdown,
  type ModelPrice,
  type PeakWindow,
  type PricePeriod,
  type PriceResolution,
  type PricingEngine,
  type PricingEngineOptions,
  type PricingProvider,
  type RateComponent,
  type RecordCost,
  type ResolvedRate,
} from './contract.ts';

/** Local wall-clock facts about one instant. */
export interface ZoneTime {
  /** Day of week, 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Seconds elapsed since local midnight. */
  secondsOfDay: number;
  /** Local calendar date as `YYYY-MM-DD`. */
  isoDate: string;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** `Date#getUTCDay` index back to a name, for {@link zoneTime}. */
const WEEKDAY_NAMES: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Formatted parts of an instant on a fixed clock, keyed by part type. */
function partsOf(instant: number, utcOffset: number): Record<string, string> {
  const shifted = new Date(instant + utcOffset * 60_000);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return {
    year: String(shifted.getUTCFullYear()),
    month: pad(shifted.getUTCMonth() + 1),
    day: pad(shifted.getUTCDate()),
    hour: pad(shifted.getUTCHours()),
    minute: pad(shifted.getUTCMinutes()),
    second: pad(shifted.getUTCSeconds()),
    weekday: WEEKDAY_NAMES[shifted.getUTCDay()] as string,
  };
}

/**
 * Describe one instant on the clock a period's rules are written in.
 * @param instant - milliseconds since the Unix epoch.
 * @param utcOffset - minutes east of UTC.
 * @returns the local weekday, second-of-day, and calendar date.
 */
export function zoneTime(instant: number, utcOffset: number): ZoneTime {
  const parts = partsOf(instant, utcOffset);
  const weekday = WEEKDAY_INDEX[parts['weekday'] as string];
  if (weekday === undefined) {
    throw new Error(`zoneTime: unexpected weekday ${JSON.stringify(parts['weekday'])}`);
  }
  return {
    weekday,
    secondsOfDay: Number(parts['hour']) * 3600 + Number(parts['minute']) * 60 + Number(parts['second']),
    isoDate: `${parts['year']}-${parts['month']}-${parts['day']}`,
  };
}

/**
 * Whether an instant falls inside any peak window.
 * Windows are half-open: `fromHour` belongs to the window, `toHour` does not.
 * @param instant - milliseconds since the Unix epoch.
 * @param windows - windows expressed in the period's wall-clock time.
 * @param utcOffset - minutes east of UTC that clock runs on.
 * @returns `true` when at least one window contains the instant.
 */
export function isPeak(instant: number, windows: readonly PeakWindow[], utcOffset: number): boolean {
  if (windows.length === 0) return false;
  const { weekday, secondsOfDay } = zoneTime(instant, utcOffset);
  for (const window of windows) {
    // A `null` weekday list means the window applies every day.
    if (window.weekdays !== null && !window.weekdays.includes(weekday)) continue;
    if (secondsOfDay >= window.fromHour * 3600 && secondsOfDay < window.toHour * 3600) return true;
  }
  return false;
}

/** Format an instant as `YYYY-MM-DD HH:MM` on the period's clock. */
export function formatInstant(instant: number, utcOffset: number): string {
  const parts = partsOf(instant, utcOffset);
  return `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}`;
}

/** How a period's clock reads, e.g. `UTC+08:00`. */
export function offsetLabel(utcOffset: number): string {
  const sign = utcOffset < 0 ? '-' : '+';
  const absolute = Math.abs(utcOffset);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${minutes}`;
}

/** Milliseconds since local midnight rendered as `HH:MM`. */
function clockLabel(secondsOfDay: number): string {
  return `${String(Math.floor(secondsOfDay / 3600)).padStart(2, '0')}:${String(Math.floor((secondsOfDay % 3600) / 60)).padStart(2, '0')}`;
}

/**
 * Strip a provider prefix from a reported model label.
 * @param label - a label such as `deepseek-official / deepseek-v4-flash`.
 * @returns the bare model name.
 */
export function bareModelName(label: string): string {
  const slash = label.lastIndexOf('/');
  return (slash === -1 ? label : label.slice(slash + 1)).trim();
}

/** The token quantity a component charges. */
export function basisQuantity(basis: BillingBasis, tokens: TokenBuckets): number {
  switch (basis) {
    case 'input':
      return tokens.input;
    case 'output':
      return tokens.output;
    case 'cacheRead':
      return tokens.cacheRead;
    case 'cacheWrite':
      return tokens.cacheWrite;
    case 'inputAndCacheWrite':
      return tokens.input + tokens.cacheWrite;
    case 'prompt':
      return tokens.input + tokens.cacheRead + tokens.cacheWrite;
    default: {
      const unreachable: never = basis;
      throw new Error(`basisQuantity: unhandled basis ${String(unreachable)}`);
    }
  }
}

/** Which {@link CostTotals} counter a component's tokens belong to. */
type TokenCounter = 'cacheHitInputTokens' | 'cacheMissInputTokens' | 'outputTokens' | 'cacheWriteTokens';

/**
 * Map a billing basis onto the token counters a report exposes.
 *
 * A basis that spans several buckets (`prompt`) has no single counter; it is
 * attributed to the cache-miss input counter, which is the bucket the vendor's
 * own breakdown would call "input".
 */
export function counterForBasis(basis: BillingBasis): TokenCounter {
  switch (basis) {
    case 'cacheRead':
      return 'cacheHitInputTokens';
    case 'output':
      return 'outputTokens';
    case 'cacheWrite':
      return 'cacheWriteTokens';
    case 'input':
    case 'inputAndCacheWrite':
    case 'prompt':
      return 'cacheMissInputTokens';
    default: {
      const unreachable: never = basis;
      throw new Error(`counterForBasis: unhandled basis ${String(unreachable)}`);
    }
  }
}

/** Display text for a billing basis. */
const BASIS_LABELS: Readonly<Record<BillingBasis, string>> = {
  input: '缓存未命中输入',
  output: '输出',
  cacheRead: '缓存命中输入',
  cacheWrite: '缓存写入',
  inputAndCacheWrite: '未命中输入 + 缓存写入',
  prompt: '全部输入',
};

/**
 * Parse a decimal rate into a scaled integer.
 *
 * Rates are authored as decimal strings because that is how vendors publish
 * them; keeping them exact matters when the same rate is applied to millions of
 * tokens.
 * @param text - decimal literal such as `"0.02"`.
 * @returns the value scaled by 1e9.
 * @throws when `text` is not a plain decimal literal.
 */
export function parseRate(text: string): bigint {
  const trimmed = text.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) {
    throw new Error(`价格: 不是合法的十进制字面量: ${JSON.stringify(text)}`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = trimmed.replace(/^[+-]/, '');
  const [whole = '0', fraction = ''] = unsigned.split('.');
  if (fraction.length > 9) {
    throw new Error(`价格: 小数位超过 9 位: ${JSON.stringify(text)}`);
  }
  const value = BigInt(`${whole}${fraction.padEnd(9, '0')}`);
  return negative ? -value : value;
}

/**
 * Charge a token quantity at a per-N rate.
 * @param tokens - token quantity; a non-negative safe integer.
 * @param rate - rate per `per` tokens, in scaled units.
 * @param per - tokens one rate unit covers.
 * @returns `tokens * rate / per`, exactly.
 */
export function charge(tokens: number, rate: bigint, per: number): bigint {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new Error(`计费: token 数必须是非负安全整数，收到 ${String(tokens)}`);
  }
  if (tokens === 0 || rate === 0n) return 0n;
  return (BigInt(tokens) * rate) / BigInt(per);
}

/** Rate components memoized by identity, since the literals recur constantly. */
const rateCache = new WeakMap<RateComponent, bigint>();

/** Parsed rate for a component, memoized. */
function rateOf(component: RateComponent): bigint {
  let parsed = rateCache.get(component);
  if (parsed === undefined) {
    parsed = parseRate(component.rate);
    rateCache.set(component, parsed);
  }
  return parsed;
}

/** The default engine implementation. */
class Engine implements PricingEngine {
  readonly provider: PricingProvider;
  private readonly fallbackModel: string | null;
  /** Period lookups keyed by model + how many period boundaries precede the instant. */
  private readonly periodCache = new Map<string, { period: PricePeriod; resolution: PriceResolution }>();

  private readonly convertAt: ((instant: number) => string) | undefined;

  constructor(provider: PricingProvider, options: PricingEngineOptions) {
    this.provider = provider;
    this.fallbackModel = options.defaultModel === undefined ? provider.defaultModel : options.defaultModel;
    this.convertAt = options.convertAt;
  }

  /** The factor for one record, as a scaled integer, or `undefined` at 1:1. */
  private factorFor(instant: number): bigint | undefined {
    if (this.convertAt === undefined) return undefined;
    const factor = parseDecimal(this.convertAt(instant));
    return factor === MONEY_SCALE ? undefined : factor;
  }

  /** Find the schedule for a model name, canonical or aliased. */
  private scheduleFor(model: string): ModelPrice | undefined {
    return this.provider.find(model) ?? this.provider.find(bareModelName(model));
  }

  /** Select the period governing one instant, per the documented fallback order. */
  private periodAt(model: string, instant: number): { period: PricePeriod; resolution: PriceResolution } | undefined {
    const schedule = this.scheduleFor(model);
    if (schedule === undefined) return undefined;

    // An instant's period depends only on which boundaries precede it, so the
    // boundary count — not the instant — forms the cache key.
    let boundaries = 0;
    for (const period of schedule.periods) {
      if (period.from <= instant) boundaries += 1;
    }
    const cacheKey = `${schedule.model}\u0000${boundaries}`;
    const cached = this.periodCache.get(cacheKey);
    if (cached !== undefined) return cached;

    let resolved: { period: PricePeriod; resolution: PriceResolution } | undefined;
    for (const period of schedule.periods) {
      const withinStart = instant >= period.from;
      const withinEnd = period.to === null || instant < period.to;
      if (withinStart && withinEnd) {
        resolved = { period, resolution: 'exact' };
        break;
      }
    }
    if (resolved === undefined) {
      // Prefer the earliest period that starts later; only when none does fall
      // back to the newest known price. `periods` is ascending, so `find` gives
      // the earliest later period and the last entry is the latest overall.
      const later = schedule.periods.find((period) => period.from > instant);
      const fallback = later ?? schedule.periods[schedule.periods.length - 1];
      if (fallback === undefined) return undefined;
      resolved = { period: fallback, resolution: later === undefined ? 'fallback-earlier' : 'fallback-later' };
    }
    this.periodCache.set(cacheKey, resolved);
    return resolved;
  }

  resolve(record: UsageRecord): ResolvedRate | undefined {
    let selected = this.periodAt(record.model, record.time);
    let model = this.scheduleFor(record.model)?.model;
    let usedDefault = false;
    if (selected === undefined && this.fallbackModel !== null) {
      selected = this.periodAt(this.fallbackModel, record.time);
      model = this.fallbackModel;
      usedDefault = true;
    }
    if (selected === undefined || model === undefined) return undefined;

    const { period } = selected;
    // Borrowing another model's schedule is its own kind of approximation, so it
    // replaces — rather than nests inside — the period's own resolution.
    const resolution: PriceResolution = usedDefault ? 'fallback-default' : selected.resolution;
    const tiered = period.peak !== null && period.peakWindows.length > 0;
    if (!tiered) {
      return { model, period, tier: 'flat', components: period.offPeak, resolution };
    }
    const peak = isPeak(record.time, period.peakWindows, period.utcOffset);
    return {
      model,
      period,
      tier: peak ? 'peak' : 'off-peak',
      // `peak` is non-null whenever `tiered` is true.
      components: peak ? (period.peak as readonly RateComponent[]) : period.offPeak,
      resolution,
    };
  }

  costOf(record: UsageRecord): RecordCost | undefined {
    const rate = this.resolve(record);
    if (rate === undefined) return undefined;
    const factor = this.factorFor(record.time);
    const amounts = new Map<string, bigint>();
    let total = 0n;
    for (const component of rate.components) {
      const charged = charge(basisQuantity(component.basis, record.tokens), rateOf(component), component.per);
      // Truncating at the arithmetic scale: a record is never worth less than a
      // billionth of a currency unit, so this cannot lose a visible amount.
      const amount = factor === undefined ? charged : (charged * factor) / MONEY_SCALE;
      amounts.set(component.id, (amounts.get(component.id) ?? 0n) + amount);
      total += amount;
    }
    return { total, amounts, rate };
  }

  describeWindow(period: PricePeriod): string {
    const from = formatInstant(period.from, period.utcOffset);
    const to = period.to === null ? t().period.toNow : formatInstant(period.to, period.utcOffset);
    return t().period.window(from, to, offsetLabel(period.utcOffset));
  }

  describeTiers(period: PricePeriod): string {
    const labels = t().period;
    if (period.peak === null || period.peakWindows.length === 0) return labels.flat;
    const windows = period.peakWindows
      .map((window) => `${clockLabel(window.fromHour * 3600)}-${clockLabel(window.toHour * 3600)}`)
      .join(labels.listJoin);
    const everyDay = period.peakWindows.every((window) => window.weekdays === null);
    const weekdaysOnly = period.peakWindows.every(
      (window) =>
        window.weekdays !== null &&
        window.weekdays.length === 5 &&
        !window.weekdays.includes(0) &&
        !window.weekdays.includes(6),
    );
    const days = everyDay ? labels.everyDay : weekdaysOnly ? labels.weekdays : labels.someDays;
    return labels.tiers(days, windows, offsetLabel(period.utcOffset));
  }

  describeBasis(basis: BillingBasis): string {
    return BASIS_LABELS[basis];
  }

  quantityOf(component: RateComponent, tokens: TokenBuckets): number {
    return basisQuantity(component.basis, tokens);
  }
}

/**
 * Build an engine for a provider.
 * @param provider - the vendor's price list.
 * @param options - overrides, notably the model used for unknown models.
 * @returns a reusable engine.
 */
export function createPricingEngine(provider: PricingProvider, options: PricingEngineOptions = {}): PricingEngine {
  return new Engine(provider, options);
}

/** A component id used in breakdowns, exposed so reports can label rows. */
export type { CostBreakdown };
