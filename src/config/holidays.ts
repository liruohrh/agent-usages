/**
 * The holiday calendar.
 *
 * Some vendors price by the working calendar rather than by the week: DeepSeek's
 * peak windows are "Monday to Friday, **excluding Chinese public holidays**", and
 * a holiday is off-peak for the whole day. A weekday that happens to be a
 * holiday therefore costs half of what the weekday rule alone would charge — the
 * difference is real money, so the dates have to come from somewhere citable.
 *
 * They cannot be computed: Spring Festival, Dragon Boat and Mid-Autumn follow the
 * lunar calendar, and the days off around every holiday are announced once a year
 * by the State Council (including which weekends are worked instead). So this is
 * *data*, shipped in `config/holidays.json` and refreshed from the same repository
 * as the price list — see `docs/config.md`.
 *
 * A period opts in by name (`holidayCalendar: "cn"`); the engine then asks this
 * calendar about the period's own local date. A date outside the calendar's
 * coverage is *not* silently treated as an ordinary working day: the engine falls
 * back to the weekday rule and the configuration carries a warning, because the
 * other behaviour would quietly bill a holiday at the peak rate.
 */

import { readFileSync } from 'node:fs';

import { CALENDAR_IDS, type CalendarId, type HolidayCalendar } from '../core/calendar.ts';
import { ConfigError, UserError, type Warning } from '../i18n/errors.ts';
import { cachePath } from './paths.ts';
import { cachedConfigText } from './update.ts';

/** Where the shipped calendar lives, relative to this module. */
const SHIPPED_PATH = new URL('../../config/holidays.json', import.meta.url);

/** The shape every calendar document parses into. */
interface HolidaysConfig {
  version: number;
  zone: string;
  source: string;
  days: Record<string, string>;
}

/** Read a value as a plain object. */
function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(path, 'configExpectsObject', { value: JSON.stringify(value) });
  }
  return value as Record<string, unknown>;
}

/** A bare `YYYY-MM-DD`, and a real calendar date. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Check one date string.
 *
 * A calendar is data a human edits once a year, and a typo like `2026-02-30` or
 * `2026-2-3` would silently stop protecting a holiday, so both the shape and the
 * calendar are checked here rather than at billing time.
 * @param value - the key to check.
 * @param path - where it was, for the error.
 * @returns the date, unchanged.
 */
function dateKey(value: string, path: string): string {
  const match = DATE.exec(value);
  if (match === null) {
    throw new ConfigError(path, 'configHolidayDate', { value: JSON.stringify(value) });
  }
  const [, year, month, day] = match as unknown as [string, string, string, string];
  const instant = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const round = new Date(instant);
  if (round.getUTCMonth() !== Number(month) - 1 || round.getUTCDate() !== Number(day)) {
    throw new ConfigError(path, 'configHolidayDate', { value: JSON.stringify(value) });
  }
  return value;
}

/**
 * Parse a calendar document.
 * @param value - the parsed JSON.
 * @returns the calendar, normalised.
 * @throws {ConfigError} naming the field that is wrong.
 */
export function parseHolidaysConfig(value: unknown): HolidayCalendar {
  const root = object(value, 'holidays');
  const version = root['version'] ?? 1;
  if (version !== 1) throw new ConfigError('version', 'configUnknownVersion', { version: JSON.stringify(version) });
  const zone = root['zone'];
  if (typeof zone !== 'string' || zone.trim().length === 0) {
    throw new ConfigError('zone', 'configNonEmptyString', { value: JSON.stringify(zone) });
  }
  const source = root['source'];
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new ConfigError('source', 'configNonEmptyString', { value: JSON.stringify(source) });
  }
  const raw = object(root['days'], 'days');
  const keys = Object.keys(raw);
  if (keys.length === 0) throw new ConfigError('days', 'configHolidaysEmpty', {});
  const days = new Map<string, string>();
  for (const key of keys) {
    const date = dateKey(key, `days.${key}`);
    const name = raw[key];
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ConfigError(`days.${key}`, 'configNonEmptyString', { value: JSON.stringify(name) });
    }
    days.set(date, name.trim());
  }
  const sorted = [...days.keys()].sort();
  return {
    id: 'cn',
    zone: zone.trim(),
    days,
    from: sorted[0] as string,
    to: sorted[sorted.length - 1] as string,
    source: source.trim(),
  };
}

/** The shipped calendar's text. */
export function shippedHolidaysText(): string {
  return readFileSync(SHIPPED_PATH, 'utf8');
}

/** The shipped calendar. */
export function shippedHolidays(): HolidayCalendar {
  return parseHolidaysConfig(JSON.parse(shippedHolidaysText()));
}

/**
 * The calendar to use: the cached one when it parses, otherwise the shipped one.
 *
 * Same rule as the price list: a fetched file that no longer parses is ignored
 * with a warning rather than taking the command down, and the shipped copy is
 * always there to fall back to.
 * @param env - environment to resolve the cache path from.
 * @param warnings - collects anything worth telling the user.
 * @returns the calendar, or `undefined` when even the shipped one is unreadable.
 */
export function readHolidays(env: NodeJS.ProcessEnv = process.env, warnings: Warning[] = []): HolidayCalendar | undefined {
  // The cache file wraps the fetched text with its ETag; the calendar is inside.
  const cached = cachedConfigText('holidays', env);
  if (cached !== undefined) {
    try {
      return parseHolidaysConfig(JSON.parse(cached));
    } catch (error) {
      warnings.push(new UserError('cachedHolidaysUnusable', { reason: (error as Error).message }));
    }
  }
  try {
    return shippedHolidays();
  } catch (error) {
    warnings.push(new UserError('cachedHolidaysUnusable', { reason: (error as Error).message }));
    return undefined;
  }
}
