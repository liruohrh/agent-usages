/**
 * Configuration-resolution tests.
 *
 * These pin the layer that everything else runs on: a user override must survive
 * the merge into a real provider (both currencies intact), a cached file must
 * win over the shipped one, and a broken file anywhere must degrade to the layer
 * below rather than stop the command.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderRounded } from '../../src/accounting.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { createPricingEngine } from '../../src/pricing/index.ts';
import { buckets, record } from '../support/dataset.ts';
import { stubProvider } from '../support/stub-pricing.ts';

/** An isolated config directory, optionally pre-populated. */
function envWith(files: Record<string, unknown> = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'agent-usages-resolve-'));
  const configDir = join(dir, 'agent-usages');
  mkdirSync(configDir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(configDir, name), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  }
  return { ...process.env, XDG_CONFIG_HOME: dir };
}

/** A user config that reprices one window of the Flash model, in yuan. */
function userOverride(): Record<string, unknown> {
  return {
    version: 1,
    updates: { pricing: false, rates: false },
    pricing: {
      version: 1,
      updatedAt: '2026-09-21',
      providers: [
        {
          id: 'deepseek',
          label: 'DeepSeek',
          defaultModel: 'deepseek-flash',
          models: [
            {
              model: 'deepseek-flash',
              aliases: ['deepseek-flash'],
              periods: [
                {
                  id: 'my-price',
                  label: '我的价',
                  from: '2026-09-15T00:00:00+08:00',
                  to: null,
                  utcOffset: 480,
                  currency: 'CNY',
                  offPeak: [
                    { id: 'input-hit', label: '缓存命中输入', basis: 'cacheRead', rate: '0.01', per: 1_000_000 },
                  ],
                  peak: null,
                  peakWindows: [],
                  source: 'https://example.com/me',
                  note: '自用',
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

describe('resolveConfig', () => {
  it('runs on the shipped files with no configuration at all', async () => {
    const config = await resolveConfig({ noUpdate: true, env: envWith() });
    expect(config.warnings).toEqual([]);
    expect(config.providers[0]?.id).toBe('deepseek');
    expect(config.rateTable.base).toBe('USD');
    expect(config.updates).toEqual({ pricing: true, rates: false });
  });

  it('merges a user override without dropping the other currency', async () => {
    const config = await resolveConfig({ noUpdate: true, env: envWith({ 'config.json': userOverride() }) });
    expect(config.warnings).toEqual([]);
    const flash = config.providers[0]!.find('deepseek-flash')!;
    const codes = new Set(flash.periods.map((period) => period.currency));
    expect([...codes].sort()).toEqual(['CNY', 'USD']);
    // The user's window is in the yuan list, and the vendor's other windows too.
    const cny = flash.periods.filter((period) => period.currency === 'CNY');
    expect(cny.some((period) => period.id === 'my-price')).toBe(true);
    expect(cny.some((period) => period.id.startsWith('2026-09-10'))).toBe(true);
    expect(cny.some((period) => period.id === '2026-01-01')).toBe(true);
    // The dollar list is untouched.
    expect(flash.periods.filter((period) => period.currency === 'USD').map((period) => period.id)).toEqual([
      '2026-01-01',
      '2026-04-24',
      '2026-04-26',
      '2026-08-17',
      '2026-08-23',
      '2026-09-10',
    ]);
  });

  it('prices the user window with the user price and the rest with the vendor price', async () => {
    const config = await resolveConfig({ noUpdate: true, env: envWith({ 'config.json': userOverride() }) });
    const flash = config.providers[0]!.find('deepseek-flash')!;
    const engine = createPricingEngine({
      ...config.providers[0]!,
      models: () => [flash],
    });
    const rateAt = (time: string): string | undefined =>
      engine
        .resolve(record({ time: Date.parse(time), model: 'deepseek-flash' }))!
        .components.find((component) => component.id === 'input-hit')?.rate;
    // Inside the user's window: the user's price.
    expect(rateAt('2026-09-20T00:00:00+08:00')).toBe('0.01');
    // Before it, the vendor's published 2026-09-10 price still applies.
    expect(rateAt('2026-09-12T00:00:00+08:00')).toBe('0.02');
    // And the earlier vendor period is untouched either.
    expect(rateAt('2026-09-01T00:00:00+08:00')).toBe('0.05');
  });

  it('carries the user currency and switches through', async () => {
    const config = await resolveConfig({
      noUpdate: true,
      env: envWith({ 'config.json': { ...userOverride(), currency: 'eur', rateSource: 'er-api', updates: { rates: true } } }),
    });
    expect(config.currency).toBe('EUR');
    expect(config.rateSource).toBe('er-api');
    expect(config.updates).toEqual({ pricing: true, rates: true });
  });

  it('prefers a fetched price file over the shipped one', async () => {
    // A cached file whose only difference is a renamed default model: proving the
    // cache is read, without inventing prices.
    const shipped = JSON.parse(readFileSync(new URL('../../config/pricing.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const providers = shipped['providers'] as { defaultModel: string }[];
    providers[0]!.defaultModel = 'deepseek-v4-pro';
    const config = await resolveConfig({
      noUpdate: true,
      env: envWith({ 'cache-pricing.json': { fetchedAt: 1, text: JSON.stringify(shipped) } }),
    });
    expect(config.warnings).toEqual([]);
    expect(config.providers[0]?.defaultModel).toBe('deepseek-v4-pro');
  });

  it('falls back to the shipped file when the cache is unusable', async () => {
    const config = await resolveConfig({
      noUpdate: true,
      env: envWith({ 'cache-pricing.json': { fetchedAt: 1, text: '{"version":1}' } }),
    });
    expect(config.providers[0]?.defaultModel).toBe('deepseek-flash');
    expect(config.warnings.map((warning) => warning.message).join('\n')).toMatch(/已缓存的价目表不可用/);
  });

  it('keeps running when the user file is broken, and says so', async () => {
    const config = await resolveConfig({
      noUpdate: true,
      env: envWith({ 'config.json': { version: 1, currency: 'dollars' } }),
    });
    expect(config.warnings.map((warning) => warning.message).join('\n')).toMatch(/忽略用户配置/);
    expect(config.providers[0]!.find('deepseek-flash')).toBeDefined();
    expect(config.currency).toBeUndefined();
  });

  it('uses the cached rate table when there is one', async () => {
    const rates = JSON.parse(readFileSync(new URL('../../config/rates.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    (rates['table'] as Record<string, string>)['CNY'] = '9.999';
    rates['updatedAt'] = '2026-09-22';
    const config = await resolveConfig({
      noUpdate: true,
      env: envWith({ 'cache-rates.json': { fetchedAt: 1, text: JSON.stringify(rates) } }),
    });
    expect(config.rateTable.rates['CNY']).toBe('9.999');
    expect(config.rateTable.provenance.date).toBe('2026-09-22');
  });
});

describe('historical rate mode', () => {
  /** A cached daily series, so the run needs no network. */
  function withSeries(rates: Record<string, string>): NodeJS.ProcessEnv {
    const dates = Object.keys(rates).sort();
    return envWith({
      'config.json': { version: 1, currency: 'EUR', rateMode: 'historical', updates: { pricing: false, rates: false } },
      'cache-series-USD-EUR.json': {
        base: 'USD',
        target: 'EUR',
        from: dates[0],
        to: dates[dates.length - 1],
        requestedFrom: '2025-01-01',
        requestedTo: '2099-01-01',
        fetchedAt: Date.now(),
        source: 'test',
        rates,
      },
    });
  }

  it('carries the mode through the configuration', async () => {
    const config = await resolveConfig({ noUpdate: true, env: withSeries({ '2026-09-18': '0.9' }) });
    expect(config.currency).toBe('EUR');
    expect(config.rateMode).toBe('historical');
  });

  it('converts each record at its own day rate', async () => {
    const { loadRateSeries, rateOn } = await import('../../src/config/series.ts');
    const series = await loadRateSeries({
      base: 'USD',
      target: 'EUR',
      env: withSeries({ '2026-09-18': '0.9', '2026-09-21': '0.5' }),
      offline: true,
    });
    expect(series).toBeDefined();
    // A real engine over the stub list, converting per record: 1M output tokens
    // cost 20 units, so the two days differ by exactly the two rates.
    const engine = createPricingEngine(stubProvider(), { convertAt: (instant: number) => rateOn(series!, instant) });
    const total = (day: string): string =>
      renderRounded(
        engine.costOf(record({ time: Date.parse(day), model: 'flat-model', tokens: buckets({ output: 1_000_000 }) }))!.total,
      );
    expect(total('2026-09-18T12:00:00Z')).toBe('18.0000');
    expect(total('2026-09-21T12:00:00Z')).toBe('10.0000');
    // And the weekend in between carries Friday's rate.
    expect(total('2026-09-19T12:00:00Z')).toBe('18.0000');
  });
});
