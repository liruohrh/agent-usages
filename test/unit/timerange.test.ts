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
    const { instant, explicitOffset } = parseInstant('2026-09-01');
    expect(new Date(instant)).toEqual(new Date(2026, 8, 1, 0, 0, 0, 0));
    expect(explicitOffset).toBe(false);
  });

  it('reads a full datetime, offset optional', () => {
    expect(new Date(parseInstant('2026-09-01T10:30:45').instant)).toEqual(new Date(2026, 8, 1, 10, 30, 45, 0));
    expect(new Date(parseInstant('2026-09-01T10:30:45.250').instant)).toEqual(new Date(2026, 8, 1, 10, 30, 45, 250));
    // An explicit offset is honoured as written, whatever the machine's zone is.
    expect(parseInstant('2026-09-01T10:30:45+08:00').instant).toBe(Date.parse('2026-09-01T10:30:45+08:00'));
    expect(parseInstant('2026-09-01T10:30:45Z').instant).toBe(Date.parse('2026-09-01T10:30:45Z'));
  });

  it('flags an explicit offset, so a caller can tell the two apart', () => {
    expect(parseInstant('2026-09-01T10:30:45+08:00').explicitOffset).toBe(true);
    expect(parseInstant('2026-09-01T10:30:45').explicitOffset).toBe(false);
  });

  it('rejects an impossible calendar date', () => {
    expect(() => parseInstant('2026-13-01')).toThrow(/无效的日期时间/);
    expect(() => parseInstant('2026-02-30')).toThrow(/无效的日期时间/);
    expect(() => parseInstant('2026-09-01T25:00:00')).toThrow(/无效的日期时间/);
  });

  it('rejects a partial time instead of guessing the missing field', () => {
    // Seconds are required: `10:30` could be 10:30:00 or a typo for `10:30:xx`.
    expect(() => parseInstant('2026-09-01T10:30')).toThrow(/无法识别的时间/);
    expect(() => parseInstant('2026-09-01 10:30:45')).toThrow(/无法识别的时间/);
  });

  it('rejects anything that is not a date or datetime', () => {
    expect(() => parseInstant('yesterday')).toThrow(/无法识别的时间/);
    expect(() => parseInstant('')).toThrow(/时间不能为空/);
  });
});

describe('resolveRange', () => {
  it('returns an unbounded range when nothing is requested', () => {
    expect(resolveRange({ now: NOW })).toEqual({ from: null, to: null, label: '全部时间' });
  });

  it('accepts a preset token, including an offset', () => {
    const range = resolveRange({ spec: 'month', now: NOW });
    expect(new Date(range.from as number)).toEqual(new Date(2026, 8, 1));
    expect(new Date(range.to as number)).toEqual(new Date(2026, 9, 1));
    expect(new Date(resolveRange({ spec: 'today', now: NOW }).from as number)).toEqual(new Date(2026, 8, 17));
    const lastMonth = resolveRange({ spec: 'month-1', now: NOW });
    expect(new Date(lastMonth.from as number)).toEqual(new Date(2026, 7, 1));
    expect(new Date(lastMonth.to as number)).toEqual(new Date(2026, 8, 1));
    const lastYear = resolveRange({ spec: 'year-1', now: NOW });
    expect(new Date(lastYear.from as number)).toEqual(new Date(2025, 0, 1));
  });

  it('accepts the Chinese preset words', () => {
    expect(resolveRange({ spec: '今年', now: NOW }).label).toBe('今年');
    expect(resolveRange({ spec: '本月', now: NOW }).label).toBe('本月');
    expect(resolveRange({ spec: '今日', now: NOW }).label).toBe('今日');
  });

  it('takes A..B literally: the end date is not included', () => {
    const range = resolveRange({ spec: '2026-09-01..2026-09-19', now: NOW });
    expect(new Date(range.from as number)).toEqual(new Date(2026, 8, 1, 0, 0, 0, 0));
    expect(new Date(range.to as number)).toEqual(new Date(2026, 8, 19, 0, 0, 0, 0));
    expect(inRange(new Date(2026, 8, 18, 23, 59, 59).getTime(), range)).toBe(true);
    expect(inRange(new Date(2026, 8, 19, 0, 0, 0).getTime(), range)).toBe(false);
  });

  it('accepts a full datetime on either side', () => {
    const range = resolveRange({ spec: '2026-09-01T08:00:00..2026-09-19T17:30:00', now: NOW });
    expect(new Date(range.from as number)).toEqual(new Date(2026, 8, 1, 8, 0, 0, 0));
    expect(new Date(range.to as number)).toEqual(new Date(2026, 8, 19, 17, 30, 0, 0));
  });

  it('leaves either side open', () => {
    const openStart = resolveRange({ spec: '..2026-09-19', now: NOW });
    expect(openStart.from).toBeNull();
    expect(new Date(openStart.to as number)).toEqual(new Date(2026, 8, 19));
    const openEnd = resolveRange({ spec: '2026-09-01..', now: NOW });
    expect(new Date(openEnd.from as number)).toEqual(new Date(2026, 8, 1));
    expect(openEnd.to).toBeNull();
  });

  it('treats a lone instant as a lower bound', () => {
    const range = resolveRange({ spec: '2026-09-01', now: NOW });
    expect(new Date(range.from as number)).toEqual(new Date(2026, 8, 1));
    expect(range.to).toBeNull();
    expect(range.label).toBe('2026-09-01 起');
  });

  it('accepts equal bounds as an empty range rather than an error', () => {
    const range = resolveRange({ spec: '2026-09-19..2026-09-19', now: NOW });
    expect(range.from).toBe(range.to);
    expect(inRange(range.from as number, range)).toBe(false);
  });

  it('rejects an inverted range', () => {
    expect(() => resolveRange({ spec: '2026-09-10..2026-09-01', now: NOW })).toThrow(/不能晚于/);
    expect(() => resolveRange({ spec: '2026-09-10T10:00:00..2026-09-10T09:00:00', now: NOW })).toThrow(/不能晚于/);
  });

  it('rejects a spec with more than one range separator', () => {
    expect(() => resolveRange({ spec: '2026-09-01..2026-09-10..2026-09-19', now: NOW })).toThrow(/至多一个/);
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
