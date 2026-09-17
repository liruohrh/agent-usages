/**
 * Temporal pricing resolution.
 *
 * Two questions are answered here, both per usage record:
 *  1. **Which price period applies?** The record's own timestamp decides, so a
 *     single session that spans a price change is billed correctly on both
 *     sides of it. When no period covers the timestamp the caller-specified
 *     fallback applies: prefer the earliest period that starts *after* the
 *     timestamp, otherwise the latest period that starts *before* it.
 *  2. **Which band inside that period applies?** Peak vs. off-peak is a
 *     wall-clock property of the period's own timezone, so it stays correct
 *     regardless of the machine's local timezone.
 */

import {
  DEFAULT_PRICING_MODEL,
  MODEL_PRICING,
  type ModelPricing,
  type PeakWindow,
  type PricingPeriod,
  type RateCard,
} from './pricing-data.ts';
import { type PricingResolution, type TokenBuckets } from './types.ts';

const MS_PER_DAY = 86_400_000;

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

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** Memoized formatter: constructing `Intl.DateTimeFormat` is expensive. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Build a `{year, month, day}`-keyed lookup from formatted parts. */
function partsOf(timeZone: string, instant: number): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return parts;
}

/**
 * Describe one instant in a specific IANA timezone.
 * @param instant - milliseconds since the Unix epoch.
 * @param timeZone - IANA zone name, e.g. `Asia/Shanghai`.
 * @returns the local weekday, second-of-day, and calendar date.
 * @throws when the timezone is unknown to `Intl`.
 */
export function zoneTime(instant: number, timeZone: string): ZoneTime {
  const parts = partsOf(timeZone, instant);
  const weekdayName = parts['weekday'] ?? 'Sun';
  const weekday = WEEKDAY_INDEX[weekdayName];
  if (weekday === undefined) {
    throw new Error(`zoneTime: unexpected weekday ${JSON.stringify(weekdayName)} from Intl`);
  }
  // Some ICU versions emit hour 24 for midnight despite hourCycle: 'h23'.
  const hour = Number(parts['hour'] ?? '0') % 24;
  const minute = Number(parts['minute'] ?? '0');
  const second = Number(parts['second'] ?? '0');
  const year = parts['year'] ?? '1970';
  const month = parts['month'] ?? '01';
  const day = parts['day'] ?? '01';
  return {
    weekday,
    secondsOfDay: hour * 3600 + minute * 60 + second,
    isoDate: `${year}-${month}-${day}`,
  };
}

/** Milliseconds since local midnight rendered as `HH:MM`. */
function clockLabel(secondsOfDay: number): string {
  const hour = Math.floor(secondsOfDay / 3600);
  const minute = Math.floor((secondsOfDay % 3600) / 60);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Whether an instant falls inside a peak window.
 * @param instant - milliseconds since the Unix epoch.
 * @param windows - windows expressed in `timeZone` wall-clock time.
 * @param timeZone - IANA zone the windows are expressed in.
 * @returns `true` when at least one window contains the instant.
 */
export function isPeak(instant: number, windows: readonly PeakWindow[], timeZone: string): boolean {
  if (windows.length === 0) return false;
  const { weekday, secondsOfDay } = zoneTime(instant, timeZone);
  for (const window of windows) {
    // `weekdays: null` means the window applies every day, which is what
    // DeepSeek charged from 2026-08-17 until weekends were exempted on 08-23.
    if (window.weekdays !== null && !window.weekdays.includes(weekday)) continue;
    const from = window.fromHour * 3600;
    const to = window.toHour * 3600;
    if (secondsOfDay >= from && secondsOfDay < to) return true;
  }
  return false;
}

/** A period selected for one instant, with the audit trail of how. */
export interface ResolvedPeriod {
  /** The selected period. */
  period: PricingPeriod;
  /** How the selection was reached. */
  resolution: PricingResolution;
}

/** A priced band: the rate card plus the labels describing it. */
export interface ResolvedRate {
  /** The selected period. */
  period: PricingPeriod;
  /** `'peak'` or `'off-peak'` for tiered periods, `'flat'` for untiered ones. */
  band: 'peak' | 'off-peak' | 'flat';
  /** The rate card to apply. */
  rates: RateCard;
  /** How the period was selected. */
  resolution: PricingResolution;
}

/** Lookup table from a model name (canonical or alias) to its schedule. */
const BY_NAME = new Map<string, ModelPricing>();
for (const pricing of MODEL_PRICING) {
  for (const alias of pricing.aliases) BY_NAME.set(alias.toLowerCase(), pricing);
}

/**
 * Strip a provider prefix from a reported model label.
 * Ledger `modelId` values look like `deepseek-official / deepseek-v4-flash`.
 * @param modelId - the raw label.
 * @returns the bare model name.
 */
export function bareModelName(modelId: string): string {
  const slash = modelId.lastIndexOf('/');
  return (slash === -1 ? modelId : modelId.slice(slash + 1)).trim();
}

/** Resolves model names to price periods and computes request costs. */
export class PricingEngine {
  /**
   * Cache of period lookups keyed by `model\0localDate\0periodBoundaryRevision`.
   *
   * An instant's period is a pure function of the model and the instant, so the
   * key must be exact. Keying by the last period boundary at or before the
   * instant keeps the entry stable for every instant inside one period while
   * staying collision-free across period changes.
   */
  private readonly periodCache = new Map<string, ResolvedPeriod>();

  /**
   * Find the schedule for a model name.
   * @param modelId - canonical name, alias, or provider-qualified label.
   * @returns the schedule, or `undefined` when the model is unpriced.
   */
  scheduleFor(modelId: string): ModelPricing | undefined {
    return BY_NAME.get(bareModelName(modelId).toLowerCase());
  }

  /**
   * Select the price period governing one instant.
   * @param modelId - model name or alias.
   * @param instant - milliseconds since the Unix epoch.
   * @returns the period and how it was chosen, or `undefined` when the model is unknown.
   */
  periodAt(modelId: string, instant: number): ResolvedPeriod | undefined {
    const schedule = this.scheduleFor(modelId);
    if (schedule === undefined) return undefined;
    const periods = schedule.periods;
    // An instant's period is decided by which boundaries precede it, so the
    // boundaries — not the instant itself — form the cache key. Every instant
    // inside one period therefore shares a single entry.
    let boundaryKey = 0;
    for (const period of periods) {
      if (period.effectiveFrom <= instant) boundaryKey += 1;
    }
    const cacheKey = `${schedule.model}\u0000${boundaryKey}`;
    const cached = this.periodCache.get(cacheKey);
    if (cached !== undefined) return cached;

    let resolved: ResolvedPeriod | undefined;
    for (const period of periods) {
      const withinStart = instant >= period.effectiveFrom;
      const withinEnd = period.effectiveTo === null || instant < period.effectiveTo;
      if (withinStart && withinEnd) {
        resolved = { period, resolution: 'exact' };
        break;
      }
    }
    if (resolved === undefined) {
      // No period covers this instant: prefer the earliest period that starts
      // later, and only fall back to an earlier one when none does. `periods`
      // is ascending, so the first period starting after `instant` is the
      // earliest such period; the last entry is the latest overall.
      const later = periods.find((period) => period.effectiveFrom > instant);
      const fallback = later ?? periods[periods.length - 1];
      if (fallback === undefined) return undefined;
      resolved = {
        period: fallback,
        resolution: later === undefined ? 'fallback-earlier' : 'fallback-later',
      };
    }
    this.periodCache.set(cacheKey, resolved);
    return resolved;
  }

  /**
   * Resolve the exact rate card for one record.
   * @param modelId - model name or alias.
   * @param instant - milliseconds since the Unix epoch.
   * @param fallbackModel - model whose schedule to borrow when `modelId` is unpriced.
   * @returns the rate, band, and selection provenance; `undefined` only when even the fallback is unpriced.
   */
  rateAt(modelId: string, instant: number, fallbackModel = DEFAULT_PRICING_MODEL): ResolvedRate | undefined {
    let selected = this.periodAt(modelId, instant);
    let resolution: PricingResolution;
    if (selected === undefined) {
      selected = this.periodAt(fallbackModel, instant);
      if (selected === undefined) return undefined;
      resolution = 'fallback-default';
    } else {
      resolution = selected.resolution;
    }
    const { period } = selected;
    if (period.peak === null || period.peakWindows.length === 0) {
      return { period, band: 'flat', rates: period.offPeak, resolution };
    }
    const peak = isPeak(instant, period.peakWindows, period.peakTimezone);
    return {
      period,
      band: peak ? 'peak' : 'off-peak',
      rates: peak ? period.peak : period.offPeak,
      resolution,
    };
  }

  /**
   * Human-readable description of when a period is in force.
   * @param period - the period to describe.
   * @returns a label such as `2026-08-17 00:00 → 2026-09-10 12:00 (Asia/Shanghai)`.
   */
  describeWindow(period: PricingPeriod): string {
    const from = formatInstant(period.effectiveFrom, period.peakTimezone);
    const to = period.effectiveTo === null ? '至今' : formatInstant(period.effectiveTo, period.peakTimezone);
    return `${from} → ${to} (${period.peakTimezone})`;
  }

  /**
   * Human-readable description of a period's peak windows.
   * @param period - the period to describe.
   * @returns e.g. `周一至周五 09:00-12:00、14:00-18:00（Asia/Shanghai）`.
   */
  describePeakWindows(period: PricingPeriod): string {
    if (period.peak === null || period.peakWindows.length === 0) return '不分峰谷（统一价格）';
    const windows = period.peakWindows
      .map((window) => `${clockLabel(window.fromHour * 3600)}-${clockLabel(window.toHour * 3600)}`)
      .join('、');
    const everyDay = period.peakWindows.every((window) => window.weekdays === null);
    const weekdaysOnly = period.peakWindows.every(
      (window) => window.weekdays !== null && window.weekdays.length === 5 && !window.weekdays.includes(0) && !window.weekdays.includes(6),
    );
    const days = everyDay ? '每天' : weekdaysOnly ? '周一至周五' : '指定星期';
    return `${days} ${windows}（${period.peakTimezone}）`;
  }

  /** Every schedule this engine knows about. */
  get schedules(): readonly ModelPricing[] {
    return MODEL_PRICING;
  }
}

/** Format an instant as `YYYY-MM-DD HH:MM` in a timezone. */
export function formatInstant(instant: number, timeZone: string): string {
  const parts = partsOf(timeZone, instant);
  const hour = String(Number(parts['hour'] ?? '0') % 24).padStart(2, '0');
  const minute = parts['minute'] ?? '00';
  return `${parts['year'] ?? '1970'}-${parts['month'] ?? '01'}-${parts['day'] ?? '01'} ${hour}:${minute}`;
}

/**
 * How many whole UTC days separate two instants.
 * @param a - earlier instant.
 * @param b - later instant.
 * @returns the day difference, floored.
 */
export function daysBetween(a: number, b: number): number {
  return Math.floor((b - a) / MS_PER_DAY);
}
