/**
 * Daily exchange-rate series, for reports that convert on each record's own date.
 *
 * The default conversion needs one factor, so it rewrites the price list once and
 * every amount is exact as published. A report spanning months is a different
 * question: "what did this cost in the currency of the day it was spent?" — and
 * answering it needs a rate per day rather than one for the whole span.
 *
 * Only one of the shipped sources publishes history (frankfurter, from the ECB's
 * daily reference rates), so a series is fetched from there, cached with the range
 * it covers, and looked up by date: a record on a weekend or holiday uses the most
 * recent published rate, which is what "the rate that day" means.
 */

import { readJson, writeJsonQuietly } from './store.ts';
import { seriesPath } from './paths.ts';
import { shippedRates } from './rates.ts';

/** How far back a series is fetched, so any realistic report is covered. */
const LOOKBACK_DAYS = 400;

/** How long a single request may take. */
const TIMEOUT_MS = 3_000;

/** A cached series of daily rates between two currencies. */
export interface RateSeries {
  /** Currency every rate is quoted from. */
  base: string;
  /** Currency every rate is quoted to. */
  target: string;
  /** First date the source actually published, `YYYY-MM-DD`. */
  from: string;
  /** Last date the source actually published, `YYYY-MM-DD`. */
  to: string;
  /** First date that was asked for; the cache is valid for a span inside this. */
  requestedFrom: string;
  /** Last date that was asked for. */
  requestedTo: string;
  /** When it was fetched, epoch milliseconds. */
  fetchedAt: number;
  /** Where it came from. */
  source: string;
  /** `date → units of target per 1 base`. */
  rates: Readonly<Record<string, string>>;
}

/** What a caller gets back, plus how to describe it. */
export interface LoadedRateSeries {
  /** `YYYY-MM-DD → rate`. */
  rates: Readonly<Record<string, string>>;
  /** Dates in ascending order. */
  dates: readonly string[];
  /** Where the data came from. */
  source: string;
  /** Provenance for a status line: source and the span it covers. */
  detail: string;
  /** Whether this came from the cache rather than a fresh fetch. */
  fromCache: boolean;
}

/** Local calendar date key for an instant, in UTC. */
function dateKey(instant: number): string {
  return new Date(instant).toISOString().slice(0, 10);
}

/** Today, `YYYY-MM-DD`. */
function today(now: Date): string {
  return dateKey(now.getTime());
}

/** A date `days` before another. */
function daysBefore(date: string, days: number): string {
  const instant = Date.parse(`${date}T00:00:00Z`) - days * 86_400_000;
  return dateKey(instant);
}

/**
 * Whether a cached series answers a request.
 *
 * Compared against the span that was *requested* rather than the dates the
 * source happened to publish: a series fetched for a two-year window but with
 * gaps on holidays is still the right answer for that window.
 */
function covers(cached: RateSeries | undefined, base: string, target: string, from: string, to: string): boolean {
  if (cached === undefined) return false;
  if (cached.base !== base || cached.target !== target) return false;
  if (cached.requestedFrom === undefined || cached.requestedTo === undefined) return false;
  return cached.requestedFrom <= from && cached.requestedTo >= to;
}

/**
 * Fetch a daily series from frankfurter.
 * @param base - currency to quote from.
 * @param target - currency to quote to.
 * @param from - first date, `YYYY-MM-DD`.
 * @param to - last date, `YYYY-MM-DD`.
 * @param fetchImpl - fetch to use.
 * @returns the series, or `undefined` when the source could not answer.
 */
async function fetchSeries(
  base: string,
  target: string,
  from: string,
  to: string,
  fetchImpl: typeof fetch,
): Promise<RateSeries | undefined> {
  const url = `https://api.frankfurter.dev/v1/${from}..${to}?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(target)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { rates?: Record<string, Record<string, number>> };
    if (body.rates === undefined) return undefined;
    const rates: Record<string, string> = {};
    for (const [date, entry] of Object.entries(body.rates)) {
      const rate = entry[target];
      if (typeof rate === 'number') rates[date] = String(rate);
    }
    if (Object.keys(rates).length === 0) return undefined;
    const dates = Object.keys(rates).sort();
    return {
      base,
      target,
      from: dates[0] as string,
      to: dates[dates.length - 1] as string,
      requestedFrom: from,
      requestedTo: to,
      fetchedAt: Date.now(),
      source: 'frankfurter.dev（欧洲央行参考汇率）',
      rates,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load a daily series, from the cache when it covers the span.
 *
 * Never throws and never fails a report: when no series is available the caller
 * falls back to the single latest rate and says so.
 * @param input - the currencies, the span, and the usual injection points.
 * @returns the series, or `undefined` when neither cache nor source could supply one.
 */
export async function loadRateSeries(input: {
  base: string;
  target: string;
  /** Range the report will cover, as epoch milliseconds; `null` means unbounded. */
  from?: number | null | undefined;
  to?: number | null | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  now?: Date | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Skip the network and use the cache only. */
  offline?: boolean | undefined;
}): Promise<LoadedRateSeries | undefined> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const todayKey = today(now);
  const earliest = input.from === null || input.from === undefined ? daysBefore(todayKey, LOOKBACK_DAYS) : dateKey(input.from);
  const latest = input.to === null || input.to === undefined ? todayKey : dateKey(input.to - 1);
  const path = seriesPath(input.base, input.target, env);
  const cached = readJson<RateSeries>(path).value;
  if (covers(cached, input.base, input.target, earliest, latest)) {
    return describe(cached as RateSeries, true);
  }
  if (input.offline === true || input.base === input.target) {
    return cached === undefined ? undefined : describe(cached, true);
  }
  // One request covers the lookback window, which is what a report can plausibly
  // span; anything older than that falls back to the earliest rate we have.
  const wanted = daysBefore(todayKey, LOOKBACK_DAYS);
  const fetched = await fetchSeries(input.base, input.target, wanted < earliest ? wanted : earliest, todayKey, input.fetchImpl ?? fetch);
  if (fetched === undefined) {
    return cached === undefined ? undefined : describe(cached, true);
  }
  writeJsonQuietly(path, fetched);
  return describe(fetched, false);
}

/** Turn a stored series into the lookup shape, keeping its provenance. */
function describe(series: RateSeries, fromCache: boolean): LoadedRateSeries {
  const dates = Object.keys(series.rates).sort();
  return {
    rates: series.rates,
    dates,
    source: series.source,
    detail: `${series.source} ${series.from} ~ ${series.to}（${dates.length} 个交易日）`,
    fromCache,
  };
}

/**
 * The rate in effect on a date.
 * @param series - the loaded series.
 * @param instant - the record's instant.
 * @returns units of the target per 1 base on that date, as a decimal string.
 */
export function rateOn(series: LoadedRateSeries, instant: number): string {
  const key = dateKey(instant);
  // Rates are published on business days only, so a weekend or holiday uses the
  // most recent one before it — that is the rate that was in effect.
  let best: string | undefined;
  for (const date of series.dates) {
    if (date <= key) best = series.rates[date];
    else break;
  }
  if (best !== undefined) return best;
  // Before the first published date: the earliest known rate is the closest
  // honest answer, and it is the one a reader would use.
  return series.rates[series.dates[0] as string] as string;
}

/** The shipped sources, for a status line about where history is available. */
export function seriesSourceIds(): string[] {
  return shippedRates()
    .sources.filter((source) => source.kind === 'frankfurter')
    .map((source) => source.id);
}
