/**
 * Daily-rate-series tests.
 *
 * Historical conversion is only worth having if it is *the* rate for the day:
 * business-day publication, weekends carrying the previous rate, and a span that
 * reaches back past anything the report can cover.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadRateSeries, rateOn } from '../../src/config/series.ts';

/** An isolated config directory. */
function env(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'agent-usages-series-'));
  mkdirSync(join(dir, 'agent-usages'), { recursive: true });
  return { ...process.env, XDG_CONFIG_HOME: dir };
}

/** A frankfurter-style response. */
function seriesResponse(rates: Record<string, Record<string, number>>): Response {
  return new Response(JSON.stringify({ amount: 1, base: 'USD', rates }), { status: 200 });
}

describe('loadRateSeries', () => {
  it('fetches a span, caches it, and reports where it came from', async () => {
    const directory = env();
    const calls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return seriesResponse({ '2026-09-18': { EUR: 0.87 }, '2026-09-21': { EUR: 0.871 } });
    }) as typeof fetch;
    const series = await loadRateSeries({ base: 'USD', target: 'EUR', env: directory, now: new Date('2026-09-22T00:00:00Z'), fetchImpl: impl });
    expect(series?.dates).toEqual(['2026-09-18', '2026-09-21']);
    expect(series?.detail).toContain('frankfurter');
    expect(series?.detail).toContain('2 个交易日');
    // The request reaches back far enough for any realistic report.
    expect(calls[0]).toContain('2025-08-18..2026-09-22');
    // And the second load is served from the cache.
    const again = await loadRateSeries({ base: 'USD', target: 'EUR', env: directory, now: new Date('2026-09-22T00:00:00Z'), fetchImpl: impl });
    expect(again?.fromCache).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('uses the cached series when offline', async () => {
    const directory = env();
    const impl = (async () => seriesResponse({ '2026-09-18': { EUR: 0.87 }, '2026-09-21': { EUR: 0.871 } })) as typeof fetch;
    await loadRateSeries({ base: 'USD', target: 'EUR', env: directory, now: new Date('2026-09-22T00:00:00Z'), fetchImpl: impl });
    const offline = await loadRateSeries({ base: 'USD', target: 'EUR', env: directory, now: new Date('2026-09-22T00:00:00Z'), offline: true });
    expect(offline?.dates).toHaveLength(2);
  });

  it('returns nothing when there is neither cache nor source', async () => {
    const failing = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const series = await loadRateSeries({ base: 'USD', target: 'EUR', env: env(), now: new Date('2026-09-22T00:00:00Z'), fetchImpl: failing });
    expect(series).toBeUndefined();
  });

  it('does not convert a currency into itself', async () => {
    let called = false;
    const impl = (async () => {
      called = true;
      return seriesResponse({});
    }) as typeof fetch;
    expect(await loadRateSeries({ base: 'USD', target: 'USD', env: env(), fetchImpl: impl })).toBeUndefined();
    expect(called).toBe(false);
  });
});

describe('rateOn', () => {
  const series = {
    rates: { '2026-09-18': '0.87', '2026-09-21': '0.871' },
    dates: ['2026-09-18', '2026-09-21'],
    source: 'test',
    detail: 'test',
    fromCache: true,
  };

  it('uses the rate of that day', () => {
    expect(rateOn(series, Date.parse('2026-09-21T10:00:00Z'))).toBe('0.871');
  });

  it('carries the previous business day over a weekend', () => {
    // 2026-09-19/20 are Saturday and Sunday: Friday's rate was in effect.
    expect(rateOn(series, Date.parse('2026-09-19T10:00:00Z'))).toBe('0.87');
    expect(rateOn(series, Date.parse('2026-09-20T23:59:59Z'))).toBe('0.87');
  });

  it('uses the earliest known rate for anything older', () => {
    expect(rateOn(series, Date.parse('2020-01-01T00:00:00Z'))).toBe('0.87');
  });
});
