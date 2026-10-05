/**
 * The time series' coarser grids.
 *
 * A scan pre-computes two grids (`hour` and `day`); `week`, `month` and `year`
 * are folded from the day grid when a reader asks for them. The folding is what
 * decides which local day belongs to which week — so the boundaries are pinned
 * here: Monday starts the week, the ISO week-year is not the calendar year
 * (2025-12-29 is `2026-W01`), and a bucket's `t` is always its own local start,
 * which is what a click on the chart drills into.
 */

import { describe, expect, it } from 'vitest';

import { aggregateTimeseries, filterDashboard, keepsHourBucket } from '../../src/serve/data.ts';
import type { Dashboard, SeriesPoint, TimeseriesBucket } from '../../src/serve/types.ts';
import type { TimeRange } from '../../src/report/timerange.ts';
import { emptyBuckets } from '../../src/core/buckets.ts';

/** A day point at local midnight, the way the scan writes them. */
function day(year: number, month: number, date: number, requests = 1, cost = '1.0000'): SeriesPoint {
  const t = new Date(year, month - 1, date).getTime();
  return {
    t,
    bucket: 'day',
    agent: 'dsh',
    projectId: 'p',
    requests,
    tokens: { ...emptyBuckets(), input: 100, output: 10 },
    cost,
  };
}

/**
 * A dashboard carrying the two grids this file reads.
 *
 * The empty project/model lists are what `filterDashboard` walks when it narrows
 * by range; the folding itself only looks at `timeseries`.
 */
/** A zero cost total, for the project stub's own/spawned figures. */
const ZERO_COST = {
  cacheHitInputTokens: 0,
  cacheMissInputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheHitInputCost: '0.0000',
  cacheMissInputCost: '0.0000',
  outputCost: '0.0000',
  cacheWriteInputCost: '0.0000',
  reasoningCost: '0.0000',
  total: '0.0000',
};

/** A zero scope, in the shape `filterDashboard` adds up. */
const ZERO_SCOPE = { sessions: 0, requests: 0, tokens: emptyBuckets(), cost: ZERO_COST };

function dashboardOf(dayPoints: readonly SeriesPoint[], hourPoints: readonly SeriesPoint[] = []): Dashboard {
  return {
    timeseries: { day: [...dayPoints], hour: [...hourPoints] },
    // One project owning the points, so `filterDashboard` has something to keep
    // them for (it drops rows of projects that are not in the scope).
    projects: [
      {
        id: 'p',
        name: 'p',
        kind: 'path',
        workspaces: [],
        agents: ['dsh'],
        sessionReports: [],
        models: [],
        bands: [],
        agentTotals: [],
        workspaceNodes: [],
        own: ZERO_SCOPE,
        spawned: ZERO_SCOPE,
        total: ZERO_SCOPE,
      },
    ],
    repos: [],
    models: [],
    bands: [],
    agents: [],
    warnings: [],
  } as unknown as Dashboard;
}

/** A day point carrying `requests`, for the retention test. */
function dayPointOf(t: number, requests: number): SeriesPoint {
  return { t, bucket: 'day', agent: 'dsh', projectId: 'p', requests, tokens: emptyBuckets(), cost: '0' };
}

/** An hour point carrying `requests`. */
function hourPointOf(t: number, requests: number): SeriesPoint {
  return { ...dayPointOf(t, requests), bucket: 'hour' };
}

/** `YYYY-MM-DD` of a local instant. */
function localDate(t: number): string {
  const date = new Date(t);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** The label/t pair the assertions read. */
function labels(buckets: readonly TimeseriesBucket[]): [string, string][] {
  return buckets.map((bucket) => [bucket.label, localDate(bucket.t)]);
}

describe('aggregateTimeseries', () => {
  it('keeps the hour and day grids exactly as the scan wrote them', () => {
    const dayPoint = day(2026, 10, 5);
    const hourPoint: SeriesPoint = { ...dayPoint, t: new Date(2026, 9, 5, 13).getTime(), bucket: 'hour' };
    const dashboard = dashboardOf([dayPoint], [hourPoint]);
    expect(labels(aggregateTimeseries(dashboard, 'day'))).toEqual([['2026-10-05', '2026-10-05']]);
    expect(labels(aggregateTimeseries(dashboard, 'hour'))).toEqual([['2026-10-05 13:00', '2026-10-05']]);
  });

  it('starts the week on Monday and keeps Sunday with the week before it', () => {
    // 2026-10-05 is a Monday; the Sunday after it belongs to the same week.
    const week = aggregateTimeseries(
      dashboardOf([day(2026, 10, 5), day(2026, 10, 11), day(2026, 10, 12)]),
      'week',
    );
    expect(labels(week)).toEqual([
      ['2026-W41', '2026-10-05'],
      ['2026-W42', '2026-10-12'],
    ]);
    expect(week[0]?.requests).toBe(2);
    // `t` is the bucket's own local start: the drill narrows to [t, t + 7 days).
    expect(new Date(week[0]?.t ?? 0).getDay()).toBe(1);
    expect(new Date(week[0]?.t ?? 0).getHours()).toBe(0);
  });

  it('labels a week that spans a year boundary by its ISO week-year', () => {
    // 2025-12-29 is a Monday, and the week it opens is ISO 2026-W01: the year's
    // first Thursday is 2026-01-01, so that week belongs to 2026. Labelling it
    // with the calendar year would print `2025-W01` next to `2025-W53`.
    const week = aggregateTimeseries(dashboardOf([day(2025, 12, 28), day(2025, 12, 29), day(2026, 1, 4)]), 'week');
    expect(labels(week)).toEqual([
      ['2025-W52', '2025-12-22'],
      ['2026-W01', '2025-12-29'],
    ]);
    expect(week[1]?.requests).toBe(2);
  });

  it('folds a week that spans two months into one bucket', () => {
    // 2026-09-28 (Monday) … 2026-10-04 (Sunday) crosses the month boundary.
    const week = aggregateTimeseries(dashboardOf([day(2026, 9, 30), day(2026, 10, 1)]), 'week');
    expect(labels(week)).toEqual([['2026-W40', '2026-09-28']]);
  });

  it('folds months on the calendar, whatever day the month starts on', () => {
    const months = aggregateTimeseries(
      dashboardOf([day(2026, 9, 30), day(2026, 10, 1), day(2026, 10, 31), day(2026, 11, 1)]),
      'month',
    );
    expect(labels(months)).toEqual([
      ['2026-09', '2026-09-01'],
      ['2026-10', '2026-10-01'],
      ['2026-11', '2026-11-01'],
    ]);
    expect(months[1]?.requests).toBe(2);
  });

  it('folds years on the calendar, across a year boundary', () => {
    const years = aggregateTimeseries(dashboardOf([day(2025, 12, 31), day(2026, 1, 1), day(2026, 12, 31)]), 'year');
    expect(labels(years)).toEqual([
      ['2025', '2025-01-01'],
      ['2026', '2026-01-01'],
    ]);
    expect(years[0]?.requests).toBe(1);
    expect(years[1]?.requests).toBe(2);
  });

  it('adds the days up: requests, tokens, money and the per-agent split', () => {
    const one = day(2026, 10, 5, 2, '1.5000');
    const two: SeriesPoint = { ...day(2026, 10, 6, 3, '2.2500'), agent: 'claude' };
    const month = aggregateTimeseries(dashboardOf([one, two]), 'month')[0];
    expect(month?.requests).toBe(5);
    expect(month?.tokens.input).toBe(200);
    expect(month?.cost).toBe('3.7500');
    expect(Object.keys(month?.byAgent ?? {}).sort()).toEqual(['claude', 'dsh']);
    expect(month?.byAgent['dsh']?.requests).toBe(2);
    expect(month?.byAgent['claude']?.cost).toBe('2.2500');
  });

  it('returns the buckets oldest first, whatever order the days arrive in', () => {
    const buckets = aggregateTimeseries(dashboardOf([day(2026, 10, 12), day(2026, 10, 5)]), 'week');
    expect(buckets.map((bucket) => bucket.label)).toEqual(['2026-W41', '2026-W42']);
  });
});

describe('hour bucket retention', () => {
  const NOW = new Date(2026, 9, 5, 12, 0, 0).getTime();
  const day = (y: number, m: number, d: number): number => new Date(y, m - 1, d).getTime();
  const window = (from: number, to: number): TimeRange => ({ from, to, label: 'test' });

  it('keeps the hours of any bounded window a drill can ask for', () => {
    // One day from three months ago: this is the case the 14-day rule used to
    // lose, and drilling into it is exactly what the chart offers.
    expect(keepsHourBucket(day(2026, 7, 22) + 9 * 3600_000, window(day(2026, 7, 22), day(2026, 7, 23)), NOW)).toBe(true);
    // A month preset: still inside the keep-everything bound.
    expect(keepsHourBucket(day(2026, 4, 3), window(day(2026, 4, 1), day(2026, 5, 1)), NOW)).toBe(true);
  });

  it('keeps exactly 31 days, and drops back to the recent rule one instant later', () => {
    const from = day(2026, 7, 1);
    expect(keepsHourBucket(from, window(from, from + 31 * 86_400_000), NOW)).toBe(true);
    // 31 days plus a millisecond is a window no drill produces, and it falls
    // back to the recent-window rule: an old record then has no hour bucket.
    expect(keepsHourBucket(from, window(from, from + 31 * 86_400_000 + 1), NOW)).toBe(false);
    // A record inside the recent window is kept under either rule.
    expect(keepsHourBucket(NOW - 3 * 86_400_000, window(from, from + 32 * 86_400_000), NOW)).toBe(true);
  });

  it('keeps only the recent window when the range is wide or open-ended', () => {
    const old = day(2026, 7, 22);
    const recent = NOW - 2 * 86_400_000;
    for (const range of [
      { from: null, to: null, label: 'all' },
      { from: old, to: null, label: 'open end' },
      { from: null, to: NOW, label: 'open start' },
      window(day(2026, 1, 1), day(2026, 12, 31)),
    ] satisfies TimeRange[]) {
      expect(keepsHourBucket(old, range, NOW), 'an old record is dropped').toBe(false);
      expect(keepsHourBucket(recent, range, NOW), 'a recent record is kept').toBe(true);
    }
    // The recent rule's own edge: 14 days exactly is still inside it.
    expect(keepsHourBucket(NOW - 14 * 86_400_000, { from: null, to: null, label: 'all' }, NOW)).toBe(true);
    expect(keepsHourBucket(NOW - 14 * 86_400_000 - 1, { from: null, to: null, label: 'all' }, NOW)).toBe(false);
  });

  it('shows every hour of a past day, and their requests add up to that day', () => {
    // What the fixed scan now produces for an old day: day cells for it and hour
    // cells for it. Asking for that one day must return those hours, and their
    // requests must equal the day bucket the reader clicked.
    const target = day(2026, 7, 22);
    const days = [dayPointOf(target, 30), dayPointOf(target + 86_400_000, 22)];
    const hours = [hourPointOf(target + 9 * 3600_000, 20), hourPointOf(target + 10 * 3600_000, 10)];
    const dashboard = dashboardOf(days, hours);
    const spec = `${localDate(target)}T00:00:00..${localDate(target + 86_400_000)}T00:00:00`;
    const narrowed = filterDashboard(dashboard, { range: spec });
    const shown = aggregateTimeseries(narrowed, 'hour');
    expect(shown.map((bucket) => bucket.label)).toEqual([
      `${localDate(target)} 09:00`,
      `${localDate(target)} 10:00`,
    ]);
    const dayBucket = aggregateTimeseries(filterDashboard(dashboard, { range: spec }), 'day')[0];
    expect(shown.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(dayBucket?.requests);
    expect(dayBucket?.requests).toBe(30);
  });
});
