/**
 * Time-range parsing.
 *
 * Every range is half-open: `from` is inclusive and `to` is exclusive. Bare
 * dates and datetimes without an explicit offset are interpreted in the
 * machine's local timezone, which is what a user means by "today" or
 * "2026-09-01"; an explicit `Z` or `±HH:MM` offset is honoured as written.
 */

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
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
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

/** Parse an ISO-like datetime with no offset suffix. */
function parseDateTime(text: string): LocalParts | undefined {
  const match = DATETIME_PATTERN.exec(text);
  if (match === null) return undefined;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] === undefined ? 0 : Number(match[6]),
    millisecond: match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0')),
  };
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
 * @param text - an ISO date, an ISO-like datetime, or an offset-qualified datetime.
 * @param edge - which side of the range this endpoint is; an upper bound given as a bare date covers that whole day.
 * @returns the instant and whether the input carried an explicit UTC offset.
 * @throws when the text is not a recognisable date or datetime.
 */
export function parseInstant(text: string, edge: 'from' | 'to'): { instant: number; explicitOffset: boolean } {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error('时间不能为空');

  // An explicit zone designator means "interpret exactly as written".
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    const instant = Date.parse(trimmed);
    if (Number.isNaN(instant)) throw new Error(`无效的时间: ${JSON.stringify(text)}`);
    return { instant, explicitOffset: true };
  }

  const dateOnly = parseDate(trimmed);
  if (dateOnly !== undefined) {
    assertRealDate(dateOnly, trimmed);
    // A bare end date means "through the end of that day", which the half-open
    // convention expresses as the start of the next day.
    if (edge === 'to') {
      const next = new Date(dateOnly.year, dateOnly.month - 1, dateOnly.day + 1);
      return {
        instant: new Date(next.getFullYear(), next.getMonth(), next.getDate()).getTime(),
        explicitOffset: false,
      };
    }
    return { instant: localInstant(dateOnly), explicitOffset: false };
  }

  const dateTime = parseDateTime(trimmed);
  if (dateTime !== undefined) {
    assertRealDate(dateTime, trimmed);
    return { instant: localInstant(dateTime), explicitOffset: false };
  }

  throw new Error(`无法识别的时间: ${JSON.stringify(text)}（支持 2026-09-01、2026-09-01T10:30、2026-09-01T10:30:00+08:00）`);
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
  const labels: Record<RangePreset, string> = { today: '今日', week: '本周', month: '本月', year: '今年' };
  const start = shiftAnchor(now, preset, 0);
  const end = shiftAnchor(now, preset, 1);
  return { from: start.getTime(), to: end.getTime(), label: labels[preset] };
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
  const direction = offset > 0 ? '后' : '前';
  return {
    from: start.getTime(),
    to: end.getTime(),
    label: `${base}${direction}${Math.abs(offset)}${preset === 'today' ? '天' : preset === 'week' ? '周' : preset === 'month' ? '个月' : '年'}`,
  };
}

/** Combine `--from` / `--to` / preset flags into one range. */
export interface RangeInput {
  /** Lower bound text, already parsed from `--from`. */
  from?: string | undefined;
  /** Upper bound text, already parsed from `--to`. */
  to?: string | undefined;
  /** A preset selected by `--today` / `--week` / `--month` / `--year`. */
  preset?: RangePreset | undefined;
  /** A positional range spec: a preset token or `A..B`. */
  spec?: string | undefined;
  /** Reference instant, for tests. */
  now?: Date | undefined;
}

/**
 * Resolve every time-range input into a single half-open range.
 * @param input - the CLI's range inputs.
 * @returns the resolved range; `{from: null, to: null}` when nothing was requested.
 * @throws when inputs contradict each other or a range is empty.
 */
export function resolveRange(input: RangeInput = {}): TimeRange {
  const now = input.now ?? new Date();
  const given = [input.preset !== undefined, input.spec !== undefined, input.from !== undefined || input.to !== undefined];
  if (given.filter(Boolean).length > 1) {
    throw new Error('时间范围只能指定一次：--today/--week/--month/--year、位置参数、或 --from/--to 三选一');
  }

  let from: number | null = null;
  let to: number | null = null;
  let label = '全部时间';

  if (input.preset !== undefined) {
    const range = presetRange(input.preset, now);
    return range;
  }

  if (input.spec !== undefined) {
    const spec = input.spec.trim();
    const preset = presetFromToken(spec, now);
    if (preset !== undefined) return preset;
    const parts = spec.split('..');
    if (parts.length === 2) {
      const lower = parts[0]?.trim() ?? '';
      const upper = parts[1]?.trim() ?? '';
      if (lower.length > 0) from = parseInstant(lower, 'from').instant;
      if (upper.length > 0) to = parseInstant(upper, 'to').instant;
      label = `${lower.length > 0 ? lower : '起始'} → ${upper.length > 0 ? upper : '现在'}`;
    } else {
      // A single bare instant is treated as a lower bound, matching `--from`.
      from = parseInstant(spec, 'from').instant;
      label = `${spec} 起`;
    }
  } else {
    if (input.from !== undefined) {
      from = parseInstant(input.from, 'from').instant;
      label = `${input.from} 起`;
    }
    if (input.to !== undefined) {
      to = parseInstant(input.to, 'to').instant;
      label = from === null ? `至 ${input.to}` : `${input.from ?? ''} → ${input.to}`;
    }
  }

  if (from !== null && to !== null && from >= to) {
    throw new Error('时间范围的起始时间必须早于结束时间');
  }
  return { from, to, label };
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
