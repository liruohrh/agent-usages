/**
 * Time-range parsing.
 *
 * Every range is half-open: `from` is inclusive and `to` is exclusive, taken
 * literally — `2026-09-01..2026-09-19` covers the 1st up to (not including) the
 * 19th, and no end date is silently widened to "the whole day".
 *
 * An endpoint is a bare date (`2026-09-01`, meaning local midnight) or a full
 * `YYYY-MM-DDTHH:MM:SS`, optionally followed by `Z` or `±HH:MM`. Without an
 * offset the machine's local zone applies, which is what a user means by "today";
 * an explicit offset is honoured exactly as written.
 */

import { t } from './i18n/index.ts';

/** Resolved half-open instant range. */
export interface TimeRange {
  /** Inclusive lower bound, or `null` for unbounded. */
  from: number | null;
  /** Exclusive upper bound, or `null` for unbounded. */
  to: number | null;
  /** How the range was requested, for display. */
  label: string;
}

/** Built-in relative presets. */
export type RangePreset = 'today' | 'week' | 'month' | 'year';

/** A local calendar date/time, before timezone resolution. */
interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A full local datetime: seconds are required, so `10:30` cannot be misread. */
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;
/** The same, with the offset the user wrote instead of the local zone. */
const OFFSET_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})$/;
const PRESET_PATTERN = /^(today|week|month|year|今日|本周|这周|本月|今年|今天)(?:([+-])(\d+))?$/;

/** Parse a bare ISO date, rejecting impossible calendar dates. */
function parseDate(text: string): LocalParts | undefined {
  const match = DATE_PATTERN.exec(text);
  if (match === null) return undefined;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  };
}

/** Parse a full ISO-like datetime from a regex match. */
function partsOf(match: RegExpExecArray): LocalParts {
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    millisecond: match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0')),
  };
}

/** Parse an ISO-like datetime with no offset suffix. */
function parseDateTime(text: string): LocalParts | undefined {
  const match = DATETIME_PATTERN.exec(text);
  return match === null ? undefined : partsOf(match);
}

/** Reject values that `Date.UTC` would silently roll over, e.g. month 13 or day 32. */
function assertRealDate(parts: LocalParts, source: string): void {
  const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond));
  const matches =
    probe.getUTCFullYear() === parts.year &&
    probe.getUTCMonth() === parts.month - 1 &&
    probe.getUTCDate() === parts.day &&
    probe.getUTCHours() === parts.hour &&
    probe.getUTCMinutes() === parts.minute &&
    probe.getUTCSeconds() === parts.second;
  if (!matches) {
    throw new Error(`无效的日期时间: ${JSON.stringify(source)}`);
  }
}

/**
 * Convert a wall-clock time in the machine's local zone to an instant.
 *
 * `new Date(y, m, d, …)` is the one constructor that is specified to interpret
 * its arguments as local time, and it resolves DST gaps and overlaps the same
 * way the rest of the platform does.
 */
function localInstant(parts: LocalParts): number {
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond).getTime();
}

/**
 * Parse one user-supplied endpoint.
 *
 * Deliberately strict: a bare date means local midnight and a datetime must
 * carry seconds, so `2026-09-01T10:30` is rejected rather than guessed at. The
 * range is half-open, so an endpoint is used exactly as written — nothing is
 * widened to the end of a day.
 * @param text - a bare date, or `YYYY-MM-DDTHH:MM:SS` with an optional offset.
 * @returns the instant and whether the user supplied an explicit offset.
 * @throws when the text is not a recognisable date or datetime.
 */
export function parseInstant(text: string): { instant: number; explicitOffset: boolean } {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error('时间不能为空');

  const dateOnly = parseDate(trimmed);
  if (dateOnly !== undefined) {
    assertRealDate(dateOnly, trimmed);
    return { instant: localInstant(dateOnly), explicitOffset: false };
  }

  const local = DATETIME_PATTERN.exec(trimmed);
  if (local !== null) {
    const parts = partsOf(local);
    assertRealDate(parts, trimmed);
    return { instant: localInstant(parts), explicitOffset: false };
  }

  const offset = OFFSET_DATETIME_PATTERN.exec(trimmed);
  if (offset !== null) {
    const parts = partsOf(offset);
    assertRealDate(parts, trimmed);
    const instant = Date.parse(trimmed);
    if (Number.isNaN(instant)) throw new Error(`无效的日期时间: ${JSON.stringify(text)}`);
    return { instant, explicitOffset: true };
  }

  throw new Error(
    `无法识别的时间: ${JSON.stringify(text)}（支持 2026-09-01、2026-09-01T10:30:00、2026-09-01T10:30:00+08:00）`,
  );
}

const PRESET_ALIASES: Readonly<Record<string, RangePreset>> = {
  today: 'today',
  '今日': 'today',
  '今天': 'today',
  week: 'week',
  '本周': 'week',
  '这周': 'week',
  month: 'month',
  '本月': 'month',
  year: 'year',
  '今年': 'year',
};

/** Shift a preset's anchor date by whole calendar units, staying in local time. */
function shiftAnchor(anchor: Date, preset: RangePreset, amount: number): Date {
  if (preset === 'today') return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + amount);
  if (preset === 'week') {
    // Weeks start on Monday, so Sunday (0) counts as the seventh day.
    const sinceMonday = (anchor.getDay() + 6) % 7;
    return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - sinceMonday + amount * 7);
  }
  if (preset === 'month') return new Date(anchor.getFullYear(), anchor.getMonth() + amount, 1);
  return new Date(anchor.getFullYear() + amount, 0, 1);
}

/**
 * Resolve a named preset to a half-open range.
 * @param preset - `today`, `week`, `month`, or `year`.
 * @param now - the reference instant; defaults to the current time.
 * @returns the range covering the whole current period.
 */
export function presetRange(preset: RangePreset, now: Date = new Date()): TimeRange {
  const start = shiftAnchor(now, preset, 0);
  const end = shiftAnchor(now, preset, 1);
  return { from: start.getTime(), to: end.getTime(), label: t().range.presets[preset] };
}

/**
 * Resolve a `today|week|month|year` token, optionally offset, e.g. `month-1`.
 * @param token - the user's token.
 * @param now - the reference instant.
 * @returns the resolved range, or `undefined` when the token is not a preset.
 */
export function presetFromToken(token: string, now: Date = new Date()): TimeRange | undefined {
  const match = PRESET_PATTERN.exec(token.trim());
  if (match === null) return undefined;
  const preset = PRESET_ALIASES[match[1] ?? ''];
  if (preset === undefined) return undefined;
  const sign = match[2];
  const amount = match[3] === undefined ? 0 : Number(match[3]);
  const offset = sign === '-' ? -amount : sign === '+' ? amount : 0;
  if (offset === 0) return presetRange(preset, now);
  const start = shiftAnchor(now, preset, offset);
  const end = shiftAnchor(start, preset, 1);
  const base = presetRange(preset, now).label;
  return {
    from: start.getTime(),
    to: end.getTime(),
    label: t().range.offset(base, offset > 0 ? 'forward' : 'back', Math.abs(offset), t().range.unit[preset]),
  };
}

/** The one range input the CLI accepts. */
export interface RangeInput {
  /** A preset token (`today`, `week-1`, `本月`) or `A..B`; omitted means everything. */
  spec?: string | undefined;
  /** Reference instant, for tests. */
  now?: Date | undefined;
}

/**
 * Resolve the range the user asked for.
 * @param input - the CLI's single range input.
 * @returns the resolved range; `{from: null, to: null}` when nothing was asked.
 * @throws when an endpoint is unreadable or the bounds are the wrong way round.
 */
export function resolveRange(input: RangeInput = {}): TimeRange {
  const now = input.now ?? new Date();
  const spec = input.spec?.trim() ?? '';
  if (spec.length === 0) return { from: null, to: null, label: t().range.all };

  const preset = presetFromToken(spec, now);
  if (preset !== undefined) return preset;

  const parts = spec.split('..');
  if (parts.length > 2) {
    throw new Error(`无法识别的时间范围: ${JSON.stringify(spec)}（至多一个 ".."）`);
  }
  if (parts.length === 1) {
    // A single instant is a lower bound: "from here on".
    const text = spec;
    return { from: parseInstant(text).instant, to: null, label: t().range.from(text) };
  }
  const lower = parts[0]?.trim() ?? '';
  const upper = parts[1]?.trim() ?? '';
  const from = lower.length > 0 ? parseInstant(lower).instant : null;
  const to = upper.length > 0 ? parseInstant(upper).instant : null;
  if (from !== null && to !== null && from > to) {
    throw new Error('时间范围的起始时间不能晚于结束时间');
  }
  // Equal bounds are a legal, empty range: the same instant twice excludes it.
  return {
    from,
    to,
    label: t().range.between(lower.length > 0 ? lower : t().range.openStart, upper.length > 0 ? upper : t().range.openEnd),
  };
}

/**
 * Whether an instant falls inside a half-open range.
 * @param instant - milliseconds since the Unix epoch.
 * @param range - the range to test.
 * @returns `true` when the instant is inside.
 */
export function inRange(instant: number, range: TimeRange): boolean {
  if (range.from !== null && instant < range.from) return false;
  if (range.to !== null && instant >= range.to) return false;
  return true;
}
