import { describe, expect, it } from 'vitest';

import { inRange, parseInstant, presetRange, resolveRange } from '../../src/timerange.ts';

/** A fixed local reference instant: 2026-09-17 15:30:00 local time. */
const NOW = new Date(2026, 8, 17, 15, 30, 0, 0);

describe('presetRange', () => {
  it('covers the whole current day, half-open', () => {
    const range = presetRange('today', NOW);
    expect(new Date(range.from as number)).toEqual(new Date(2026, 8, 17, 0, 0, 0, 0));
    expect(new Date(range.to as number)).toEqual(new Date(2026, 8, 18, 0, 0, 0, 0));
    expect(range.label).toBe('今日');
  });

  it('covers the whole current month', () => {
    const range = presetRange('month', NOW);
    expect(new Date(range.from as number)).toEqual(new Date(2026, 8, 1, 0, 0, 0, 0));
    expect(new Date(range.to as number)).toEqual(new Date(2026, 9, 1, 0, 0, 0, 0));
  });

  it('covers the current week, starting on Monday', () => {
    // 2026-09-17 is a Thursday, so the week runs 09-14 → 09-21.
    const range = presetRange('week', NOW);
    expect(new Date(range.from as number)).toEqual(new Date(2026, 8, 14, 0, 0, 0, 0));
    expect(new Date(range.to as number)).toEqual(new Date(2026, 8, 21, 0, 0, 0, 0));
    expect(range.label).toBe('本周');
  });

  it('treats Sunday as the last day of the week, not the first', () => {
    const sunday = new Date(2026, 8, 20, 23, 0, 0, 0);
    const range = presetRange('week', sunday);
    expect(new Date(range.from as number)).toEqual(new Date(2026, 8, 14, 0, 0, 0, 0));
  });

  it('covers the whole current year', () => {
    const range = presetRange('year', NOW);
    expect(new Date(range.from as number)).toEqual(new Date(2026, 0, 1, 0, 0, 0, 0));
    expect(new Date(range.to as number)).toEqual(new Date(2027, 0, 1, 0, 0, 0, 0));
  });
});

describe('week tokens', () => {
  it('accepts both spellings and offsets them by whole weeks', () => {
    const current = resolveRange({ spec: 'week', now: NOW });
    expect(current.label).toBe('本周');
    const previous = resolveRange({ spec: 'week-1', now: NOW });
    expect(previous.label).toBe('本周前1周');
    expect(new Date(previous.from as number)).toEqual(new Date(2026, 8, 7, 0, 0, 0, 0));
    expect(new Date(previous.to as number)).toEqual(new Date(2026, 8, 14, 0, 0, 0, 0));
    expect(resolveRange({ spec: '本周', now: NOW }).from).toBe(current.from);
  });
});

describe('parseInstant', () => {
  it('reads a bare date as local midnight', () => {
    const { instant, explicitOffset } = parseInstant('2026-09-01', 'from');
    expect(explicitOffset).toBe(false);
    expect(new Date(instant)).toEqual(new Date(2026, 8, 1, 0, 0, 0, 0));
  });

  it('extends a bare END date through the end of that day', () => {
    // `--to 2026-09-10` must include everything that happened on the 10th.
    const { instant } = parseInstant('2026-09-10', 'to');
    expect(new Date(instant)).toEqual(new Date(2026, 8, 11, 0, 0, 0, 0));
    expect(inRange(new Date(2026, 8, 10, 23, 59, 59).getTime(), { from: null, to: instant, label: '' })).toBe(true);
    expect(inRange(new Date(2026, 8, 11, 0, 0, 0).getTime(), { from: null, to: instant, label: '' })).toBe(false);
  });

  it('reads a datetime with and without seconds', () => {
    expect(new Date(parseInstant('2026-09-01T10:30', 'from').instant)).toEqual(new Date(2026, 8, 1, 10, 30, 0, 0));
    expect(new Date(parseInstant('2026-09-01 10:30:45', 'from').instant)).toEqual(new Date(2026, 8, 1, 10, 30, 45, 0));
    expect(new Date(parseInstant('2026-09-01T10:30:45.250', 'from').instant)).toEqual(new Date(2026, 8, 1, 10, 30, 45, 250));
  });

  it('honours an explicit offset instead of the local zone', () => {
    const withOffset = parseInstant('2026-09-01T10:30:00+08:00', 'from');
    expect(withOffset.explicitOffset).toBe(true);
    expect(withOffset.instant).toBe(Date.parse('2026-09-01T02:30:00Z'));
    expect(parseInstant('2026-09-01T10:30:00Z', 'from').instant).toBe(Date.parse('2026-09-01T10:30:00Z'));
  });

  it('rejects impossible calendar dates', () => {
    expect(() => parseInstant('2026-13-01', 'from')).toThrow(/无效的日期时间/);
    expect(() => parseInstant('2026-02-30', 'from')).toThrow(/无效的日期时间/);
    expect(() => parseInstant('2026-09-01T25:00', 'from')).toThrow(/无效的日期时间/);
  });

  it('rejects text that is not a time at all', () => {
    expect(() => parseInstant('yesterday', 'from')).toThrow(/无法识别的时间/);
    expect(() => parseInstant('', 'from')).toThrow(/时间不能为空/);
  });
});

describe('resolveRange', () => {
  it('returns an unbounded range when nothing is requested', () => {
    expect(resolveRange({ now: NOW })).toEqual({ from: null, to: null, label: '全部时间' });
  });

  it('accepts a preset flag', () => {
    const range = resolveRange({ preset: 'month', now: NOW });
    expect(new Date(range.from as number)).toEqual(new Date(2026, 8, 1));
    expect(new Date(range.to as number)).toEqual(new Date(2026, 9, 1));
  });

  it('accepts a preset token, including a negative offset', () => {
    expect(new Date(resolveRange({ spec: 'today', now: NOW }).from as number)).toEqual(new Date(2026, 8, 17));
    const lastMonth = resolveRange({ spec: 'month-1', now: NOW });
    expect(new Date(lastMonth.from as number)).toEqual(new Date(2026, 7, 1));
    expect(new Date(lastMonth.to as number)).toEqual(new Date(2026, 8, 1));
    const lastYear = resolveRange({ spec: 'year-1', now: NOW });
    expect(new Date(lastYear.from as number)).toEqual(new Date(2025, 0, 1));
    expect(new Date(lastYear.to as number)).toEqual(new Date(2026, 0, 1));
  });

  it('accepts the Chinese preset words', () => {
    expect(resolveRange({ spec: '今年', now: NOW }).label).toBe('今年');
    expect(resolveRange({ spec: '本月', now: NOW }).label).toBe('本月');
    expect(resolveRange({ spec: '今日', now: NOW }).label).toBe('今日');
  });

  it('accepts an explicit A..B range', () => {
    const range = resolveRange({ spec: '2026-09-01..2026-09-10', now: NOW });
    expect(new Date(range.from as number)).toEqual(new Date(2026, 8, 1, 0, 0, 0, 0));
    // The end date is inclusive of its whole day.
    expect(new Date(range.to as number)).toEqual(new Date(2026, 8, 11, 0, 0, 0, 0));
  });

  it('accepts --from/--to', () => {
    const range = resolveRange({ from: '2026-08-01', to: '2026-09-01', now: NOW });
    expect(new Date(range.from as number)).toEqual(new Date(2026, 7, 1));
    // `--to 2026-09-01` is inclusive of 2026-09-01 itself.
    expect(new Date(range.to as number)).toEqual(new Date(2026, 8, 2));
  });

  it('treats a lone positional value as a lower bound', () => {
    const range = resolveRange({ spec: '2026-09-01', now: NOW });
    expect(new Date(range.from as number)).toEqual(new Date(2026, 8, 1));
    expect(range.to).toBeNull();
  });

  it('lets a pre-existing price period gap stay queryable with an open range', () => {
    const range = resolveRange({ from: '2026-08-01', now: NOW });
    expect(range.to).toBeNull();
  });

  it('rejects combining range inputs', () => {
    expect(() => resolveRange({ preset: 'today', from: '2026-09-01', now: NOW })).toThrow(/只能指定一次/);
    expect(() => resolveRange({ preset: 'today', spec: 'today', now: NOW })).toThrow(/只能指定一次/);
    expect(() => resolveRange({ spec: 'today', from: '2026-09-01', now: NOW })).toThrow(/只能指定一次/);
  });

  it('rejects an empty or inverted range', () => {
    expect(() => resolveRange({ from: '2026-09-10', to: '2026-09-01', now: NOW })).toThrow(/起始时间必须早于结束时间/);
    expect(() => resolveRange({ from: '2026-09-10T10:00', to: '2026-09-10T10:00', now: NOW })).toThrow(
      /起始时间必须早于结束时间/,
    );
    expect(() => resolveRange({ spec: '2026-09-10T10:00..2026-09-10T09:00', now: NOW })).toThrow(
      /起始时间必须早于结束时间/,
    );
  });

  it('treats the same date for both bounds as the whole of that day', () => {
    // `--from 2026-09-10 --to 2026-09-10` is a one-day query, not an empty one:
    // the end date is inclusive of its own day.
    const range = resolveRange({ from: '2026-09-10', to: '2026-09-10', now: NOW });
    expect(new Date(range.from as number)).toEqual(new Date(2026, 8, 10, 0, 0, 0, 0));
    expect(new Date(range.to as number)).toEqual(new Date(2026, 8, 11, 0, 0, 0, 0));
  });
});

describe('inRange', () => {
  const range = { from: 1000, to: 2000, label: 'test' };

  it('includes the lower bound and excludes the upper bound', () => {
    expect(inRange(1000, range)).toBe(true);
    expect(inRange(1999, range)).toBe(true);
    expect(inRange(2000, range)).toBe(false);
    expect(inRange(999, range)).toBe(false);
  });

  it('treats null bounds as unbounded', () => {
    expect(inRange(0, { from: null, to: null, label: '' })).toBe(true);
    expect(inRange(0, { from: null, to: 1, label: '' })).toBe(true);
    expect(inRange(5, { from: 1, to: null, label: '' })).toBe(true);
  });
});
