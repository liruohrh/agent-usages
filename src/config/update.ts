/**
 * Keeping the shipped configuration fresh.
 *
 * Two rules shape everything here:
 *
 * - **The command never fails because of the network.** A stale cache is fine, a
 *   missing cache is fine, a timeout is fine: the report still runs, on the best
 *   data available, and says which data that was.
 * - **A check happens at most once a day.** The answer is written down whether it
 *   succeeded or not, so a machine that is offline for a week makes one attempt
 *   per day rather than one per command.
 *
 * The price list is fetched from this repository, conditionally on its ETag: a
 * commit to `config/pricing.json` therefore reaches every user without a release,
 * and an unchanged file costs a 304. Rates come from the sources named in
 * `config/rates.json`, tried in order, with retries, because any single free
 * endpoint can be down.
 */

import { renderDiagnostic } from '../i18n/errors.ts';
import { t } from '../i18n/index.ts';
import { parseHolidaysConfig } from './holidays.ts';
import { parsePricingConfig } from './pricing.ts';
import { parseRatesConfig, shippedRates } from './rates.ts';
import { cachePath, statePath } from './paths.ts';
import { readJson, writeJsonQuietly } from './store.ts';

/** Which configuration file an update concerns. */
export type UpdateKind = 'pricing' | 'rates';

/** Where the price list is fetched from. */
export const PRICING_URL = 'https://raw.githubusercontent.com/liruohrh/agent-usages/master/config/pricing.json';

/**
 * The holiday calendar, from the same repository.
 *
 * It rides on the price-list check rather than having one of its own: both are
 * hand-maintained files in this repository, both change when a vendor's rules
 * change, and the three-week cadence is right for both — the days off for a year
 * are announced once, in November.
 */
export const HOLIDAYS_URL = 'https://raw.githubusercontent.com/liruohrh/agent-usages/master/config/holidays.json';

/** How long a single request may take before it is abandoned. */
const TIMEOUT_MS = 2_000;

/** Attempts per rate source before moving to the next one. */
const RATE_ATTEMPTS = 2;

/** A cached copy of a fetched configuration file. */
interface CacheEntry {
  /** When it was fetched, epoch milliseconds. */
  fetchedAt: number;
  /** ETag the server gave, for a conditional request next time. */
  etag?: string | undefined;
  /** The file's text, exactly as fetched. */
  text: string;
}

/** Bookkeeping shared by both kinds of update. */
interface UpdateState {
  /** Schema version. */
  version: number;
  /** First time the tool ran, so a fresh install can schedule its first check. */
  firstRunAt: number;
  /** Last check per kind, successful or not. */
  checkedAt: Partial<Record<UpdateKind, number>>;
}

/** The outcome of one update attempt, for a status line. */
export interface UpdateOutcome {
  /** Which configuration was concerned. */
  kind: UpdateKind;
  /** What happened. */
  status: 'updated' | 'unchanged' | 'skipped' | 'failed';
  /** One line a human can read. */
  detail: string;
}

/** Everything the updater needs to know from the outside. */
export interface UpdateOptions {
  /** Environment to resolve paths from. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Ignore the once-a-day rule. */
  force?: boolean | undefined;
  /** Injectable clock, for tests. */
  now?: Date | undefined;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch | undefined;
}

/** Read the bookkeeping file, or a fresh one. */
function readState(env: NodeJS.ProcessEnv, now: Date): UpdateState {
  const { value } = readJson<UpdateState>(statePath(env));
  if (value === undefined || typeof value['firstRunAt'] !== 'number') {
    return { version: 1, firstRunAt: now.getTime(), checkedAt: {} };
  }
  return { version: 1, firstRunAt: value.firstRunAt, checkedAt: value.checkedAt ?? {} };
}

/**
 * How long one kind of update waits between checks.
 *
 * The two sources change at very different speeds: the vendor's rate table moves
 * every day but a weekly check is plenty for a report about the past, while the
 * price list is a hand-maintained file that changes when a vendor changes its
 * pricing — three weeks apart is often enough to be current and rare enough not
 * to nag GitHub. `--force` ignores both.
 */
const CHECK_EVERY_DAYS: Readonly<Record<UpdateKind, number>> = { pricing: 21, rates: 7 };

/** The `every …` phrase an outcome line uses: whole weeks once the wait is a week. */
function everyText(days: number): string {
  return days % 7 === 0 && days >= 7
    ? t().update.everyWeeks(String(days / 7))
    : t().update.everyDays(String(days));
}

/** How long ago a check was, in words: `今天` reads better than `0 天前`. */
function agoText(last: number, now: number): string {
  const days = String(Math.max(0, Math.round((now - last) / 86_400_000)));
  return days === '0' ? t().update.agoToday : t().update.agoDays(days);
}

/** Whether a check is due, given that kind's interval. */
function isDue(state: UpdateState, kind: UpdateKind, now: Date, force: boolean): boolean {
  if (force) return true;
  const last = state.checkedAt[kind];
  // A clock that moved backwards is also a reason to look again: the alternative
  // is a machine that never checks anything until the date catches up.
  if (last === undefined || now.getTime() < last) return true;
  return now.getTime() - last >= CHECK_EVERY_DAYS[kind] * 86_400_000;
}

/** Fetch with a timeout, returning the response or `undefined`. */
async function request(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refresh the price list from the repository, when a check is due.
 * @param options - environment, clock, fetch, and whether to force.
 * @returns what happened, never a thrown error.
 */
export async function updatePricing(options: UpdateOptions = {}): Promise<UpdateOutcome> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const state = readState(env, now);
  if (!isDue(state, 'pricing', now, options.force === true)) {
    return {
      kind: 'pricing',
      status: 'skipped',
      detail: renderDiagnostic('updatePricesChecked', {
        ago: agoText(state.checkedAt.pricing ?? now.getTime(), now.getTime()),
        every: everyText(CHECK_EVERY_DAYS.pricing),
      }),
    };
  }
  state.checkedAt.pricing = now.getTime();
  const cached = readJson<CacheEntry>(cachePath('pricing', env)).value;
  const headers: Record<string, string> = {};
  // `--force` means "check now", not "download again": a 304 is still the
  // cheapest way to check, so the validator is sent whenever it is known.
  if (cached?.etag !== undefined) headers['If-None-Match'] = cached.etag;
  const response = await request(PRICING_URL, { headers }, fetchImpl);
  if (response === undefined) {
    writeJsonQuietly(statePath(env), state);
    return { kind: 'pricing', status: 'failed', detail: renderDiagnostic('updatePricesOffline', {}) };
  }
  if (response.status === 304) {
    writeJsonQuietly(statePath(env), state);
    return { kind: 'pricing', status: 'unchanged', detail: renderDiagnostic('updatePricesUnchanged', {}) };
  }
  if (!response.ok) {
    writeJsonQuietly(statePath(env), state);
    return {
      kind: 'pricing',
      status: 'failed',
      detail: renderDiagnostic('updatePricesHttp', { status: String(response.status) }),
    };
  }
  const text = await response.text();
  try {
    // Validate before caching: a broken file must never replace a good one.
    const parsed = parsePricingConfig(text);
    writeJsonQuietly(cachePath('pricing', env), {
      fetchedAt: now.getTime(),
      etag: response.headers.get('etag') ?? undefined,
      text,
    } satisfies CacheEntry);
    // The calendar goes with the price list; a failed calendar fetch is worth a
    // note but never a reason to throw away a price list that arrived.
    const calendar = await updateHolidays({ ...options, fetchImpl, now });
    writeJsonQuietly(statePath(env), state);
    return {
      kind: 'pricing',
      status: 'updated',
      detail: renderDiagnostic('updatePricesUpdated', { date: parsed.updatedAt, calendar }),
    };
  } catch (error) {
    writeJsonQuietly(statePath(env), state);
    return {
      kind: 'pricing',
      status: 'failed',
      detail: renderDiagnostic('updatePricesUnusable', { reason: (error as Error).message }),
    };
  }
}

/**
 * Refresh the holiday calendar next to the price list.
 *
 * Never fatal: the shipped calendar is a valid fallback, so a repository that is
 * unreachable, or a file that no longer parses, leaves the previous copy in place
 * and says so in the price-list line.
 * @param options - environment, clock, fetch.
 * @returns a short note for the update line: `''` when nothing needed doing.
 */
async function updateHolidays(options: UpdateOptions & { fetchImpl: typeof fetch; now: Date }): Promise<string> {
  const env = options.env ?? process.env;
  const cached = readJson<CacheEntry>(cachePath('holidays', env)).value;
  const headers: Record<string, string> = {};
  if (cached?.etag !== undefined) headers['If-None-Match'] = cached.etag;
  const response = await request(HOLIDAYS_URL, { headers }, options.fetchImpl);
  if (response === undefined || !response.ok) return renderDiagnostic('calendarUnchanged', {});
  if (response.status === 304) return renderDiagnostic('calendarUnchanged', {});
  const text = await response.text();
  try {
    const calendar = parseHolidaysConfig(JSON.parse(text));
    writeJsonQuietly(cachePath('holidays', env), {
      fetchedAt: options.now.getTime(),
      etag: response.headers.get('etag') ?? undefined,
      text,
    } satisfies CacheEntry);
    return renderDiagnostic('calendarUpdated', { to: calendar.to });
  } catch (error) {
    return renderDiagnostic('calendarUnusable', { reason: (error as Error).message });
  }
}

/** Build a rate table from a frankfurter-style response. */
function ratesFromFrankfurter(body: unknown): unknown {
  const node = body as { base?: string; date?: string; rates?: Record<string, number> };
  if (node.base === undefined || node.rates === undefined) throw new Error('缺少 base / rates 字段');
  const table: Record<string, string> = { [node.base]: '1' };
  for (const [code, value] of Object.entries(node.rates)) table[code] = String(value);
  return {
    version: 1,
    updatedAt: node.date ?? new Date().toISOString().slice(0, 10),
    base: node.base,
    source: 'frankfurter.dev（欧洲央行参考汇率）',
    table,
    sources: shippedRates().sources,
  };
}

/** Build a rate table from an open.er-api.com response. */
function ratesFromErApi(body: unknown): unknown {
  const node = body as { result?: string; base_code?: string; time_last_update_utc?: string; rates?: Record<string, number> };
  if (node.result !== 'success' || node.base_code === undefined || node.rates === undefined) {
    throw new Error('响应不是成功状态');
  }
  const date = node.time_last_update_utc === undefined ? undefined : new Date(node.time_last_update_utc);
  const table: Record<string, string> = { [node.base_code]: '1' };
  for (const [code, value] of Object.entries(node.rates)) table[code] = String(value);
  return {
    version: 1,
    updatedAt: date === undefined || Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10),
    base: node.base_code,
    source: 'open.er-api.com（exchangerate-api）',
    table,
    sources: shippedRates().sources,
  };
}

/**
 * Fetch a fresh rate table from the configured sources, in order.
 * @param options - environment, clock, fetch.
 * @returns the validated configuration text, or `undefined` when every source failed.
 */
export async function fetchRates(options: UpdateOptions = {}): Promise<{ text: string; source: string } | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const config = shippedRates();
  for (const source of config.sources) {
    for (let attempt = 0; attempt < RATE_ATTEMPTS; attempt += 1) {
      const response = await request(source.url, {}, fetchImpl);
      if (response === undefined || !response.ok) continue;
      try {
        const body: unknown = await response.json();
        const document = source.kind === 'frankfurter' ? ratesFromFrankfurter(body) : ratesFromErApi(body);
        const text = `${JSON.stringify(document, null, 2)}\n`;
        // Validate through the same parser the shipped file goes through.
        parseRatesConfig(text);
        return { text, source: source.id };
      } catch {
        // Try the next attempt, then the next source.
      }
    }
  }
  return undefined;
}

/**
 * Refresh the rate table, when a check is due.
 * @param options - environment, clock, fetch, and whether to force.
 * @returns what happened, never a thrown error.
 */
export async function updateRates(options: UpdateOptions = {}): Promise<UpdateOutcome> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const state = readState(env, now);
  if (!isDue(state, 'rates', now, options.force === true)) {
    return {
      kind: 'rates',
      status: 'skipped',
      detail: renderDiagnostic('updateRatesChecked', {
        ago: agoText(state.checkedAt.rates ?? now.getTime(), now.getTime()),
        every: everyText(CHECK_EVERY_DAYS.rates),
      }),
    };
  }
  state.checkedAt.rates = now.getTime();
  const fetched = await fetchRates(options);
  if (fetched === undefined) {
    writeJsonQuietly(statePath(env), state);
    return { kind: 'rates', status: 'failed', detail: renderDiagnostic('updateRatesFailed', {}) };
  }
  writeJsonQuietly(cachePath('rates', env), { fetchedAt: now.getTime(), text: fetched.text } satisfies CacheEntry);
  writeJsonQuietly(statePath(env), state);
  const date = parseRatesConfig(fetched.text).updatedAt;
  return { kind: 'rates', status: 'updated', detail: renderDiagnostic('updateRatesUpdated', { source: fetched.source, date }) };
}

/**
 * Run the updates the user's settings allow.
 * @param settings - which kinds may refresh.
 * @param options - environment, clock, fetch, and whether to force.
 * @returns one outcome per kind that was considered.
 */
export async function runUpdates(
  settings: { pricing: boolean; rates: boolean },
  options: UpdateOptions & { kinds?: readonly UpdateKind[] | undefined } = {},
): Promise<UpdateOutcome[]> {
  const kinds = options.kinds ?? (['pricing', 'rates'] as const);
  const outcomes: UpdateOutcome[] = [];
  for (const kind of kinds) {
    if (options.force !== true && !settings[kind]) {
      outcomes.push({
        kind,
        status: 'skipped',
        detail: renderDiagnostic(kind === 'pricing' ? 'updatePricesDisabled' : 'updateRatesDisabled', {}),
      });
      continue;
    }
    outcomes.push(kind === 'pricing' ? await updatePricing(options) : await updateRates(options));
  }
  return outcomes;
}

/**
 * The text last fetched for one kind.
 * @param kind - which configuration.
 * @param env - environment to resolve the cache path from.
 * @returns the cached text, or `undefined` when there is no usable cache.
 */
export function cachedConfigText(kind: UpdateKind | 'holidays', env: NodeJS.ProcessEnv = process.env): string | undefined {
  const entry = readJson<CacheEntry>(cachePath(kind, env)).value;
  return typeof entry?.text === 'string' ? entry.text : undefined;
}

/** When one kind was fetched, for a provenance line. */
export function cachedAt(kind: UpdateKind, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const entry = readJson<CacheEntry>(cachePath(kind, env)).value;
  return typeof entry?.fetchedAt === 'number' ? entry.fetchedAt : undefined;
}
