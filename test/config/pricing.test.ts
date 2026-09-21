/**
 * Pricing-configuration tests.
 *
 * The file is data a human edits, so the parser's job is to say exactly which
 * field is wrong rather than to fail somewhere later with a mysterious number.
 * The shipped file is parsed too: it is the tool's own default, so a typo in it
 * must break this suite rather than a user's first run.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ConfigError, parsePricingConfig, providerFromConfig, shippedProviders } from '../../src/config/pricing.ts';
import { parseRatesConfig, shippedRates } from '../../src/config/rates.ts';
import { createPricingEngine, rateFrom, seedTable } from '../../src/pricing/index.ts';

/** The shipped configuration, as a mutable copy a test can break. */
function shipped(): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL('../../config/pricing.json', import.meta.url), 'utf8')) as Record<string, unknown>;
}

/** The first provider's first model's first period, for targeted edits. */
function firstPeriod(document: Record<string, unknown>): Record<string, unknown> {
  const providers = document['providers'] as { models: { periods: Record<string, unknown>[] }[] }[];
  return providers[0]!.models[0]!.periods[0]!;
}

describe('parsePricingConfig', () => {
  it('reads the shipped file into providers', () => {
    const config = parsePricingConfig(shipped());
    expect(config.version).toBe(1);
    expect(config.providers.map((entry) => entry.id)).toEqual(['deepseek']);
    const deepseek = config.providers[0]!;
    expect(deepseek.defaultModel).toBe('deepseek-flash');
    expect(deepseek.models.map((model) => model.model)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });

  it('keeps both published currencies, window for window', () => {
    const config = parsePricingConfig(shipped());
    for (const model of config.providers[0]!.models) {
      const cny = model.periods.filter((period) => period.currency.code === 'CNY');
      const usd = model.periods.filter((period) => period.currency.code === 'USD');
      expect(cny.length).toBeGreaterThan(1);
      expect(usd.map((period) => period.id)).toEqual(cny.map((period) => period.id));
    }
  });

  it('reads a rate as an exact decimal, not a float', () => {
    const config = parsePricingConfig(shipped());
    const rates = config.providers[0]!.models[0]!.periods.flatMap((period) => period.offPeak.map((entry) => entry.rate));
    expect(rates).toContain('0.0028');
    expect(rates.every((rate) => typeof rate === 'string')).toBe(true);
  });

  it('accepts a string as well as a parsed document', () => {
    expect(parsePricingConfig(JSON.stringify(shipped())).providers).toHaveLength(1);
  });

  it('reports the path of the field that is wrong', () => {
    const document = shipped();
    firstPeriod(document)['from'] = '2026-01-01';
    expect(() => parsePricingConfig(document)).toThrow(/providers\[0\]\.models\[0\]\.periods\[0\]\.from: 应为带时区的 ISO 时间/);
  });

  it('rejects a rate that is not a decimal', () => {
    const document = shipped();
    (firstPeriod(document)['offPeak'] as { rate: string }[])[0]!.rate = '¥0.2';
    expect(() => parsePricingConfig(document)).toThrow(/rate: 不是十进制数/);
  });

  it('rejects an unknown billing basis', () => {
    const document = shipped();
    (firstPeriod(document)['offPeak'] as { basis: string }[])[0]!.basis = 'vibes';
    expect(() => parsePricingConfig(document)).toThrow(/未知的计费基准/);
  });

  it('rejects a peak price without peak windows, and the reverse', () => {
    const noWindows = shipped();
    const period = firstPeriod(noWindows);
    period['peak'] = [{ id: 'output', label: '输出', basis: 'output', rate: '1', per: 1_000_000 }];
    expect(() => parsePricingConfig(noWindows)).toThrow(/有高峰价却没有高峰时段/);
    const noPeak = shipped();
    firstPeriod(noPeak)['peakWindows'] = [{ fromHour: 9, toHour: 12, weekdays: null }];
    expect(() => parsePricingConfig(noPeak)).toThrow(/没有高峰价却写了高峰时段/);
  });

  it('rejects a gap or overlap inside one currency history', () => {
    const document = shipped();
    const periods = (document['providers'] as { models: { periods: Record<string, unknown>[] }[] }[])[0]!.models[0]!.periods;
    // Move the yuan list's second period a day later, leaving a hole.
    const second = periods.filter((period) => (period['currency'] as { code: string }).code === 'CNY')[1]!;
    second['from'] = '2026-04-25T00:00:00+08:00';
    expect(() => parsePricingConfig(document)).toThrow(/区间不连续/);
  });

  it('rejects a history that never ends', () => {
    const document = shipped();
    const periods = (document['providers'] as { models: { periods: Record<string, unknown>[] }[] }[])[0]!.models[0]!.periods;
    const yuan = periods.filter((period) => (period['currency'] as { code: string }).code === 'CNY');
    yuan[yuan.length - 1]!['to'] = '2026-10-01T00:00:00+08:00';
    expect(() => parsePricingConfig(document)).toThrow(/没有结束时间/);
  });

  it('rejects a default model that is not in the list', () => {
    const document = shipped();
    (document['providers'] as Record<string, unknown>[])[0]!['defaultModel'] = 'gpt-9';
    expect(() => parsePricingConfig(document)).toThrow(/默认模型 gpt-9 不在模型列表里/);
  });

  it('rejects a document from a future schema', () => {
    const document = shipped();
    document['version'] = 2;
    expect(() => parsePricingConfig(document)).toThrow(/只认识版本 1/);
  });

  it('rejects something that is not a configuration at all', () => {
    expect(() => parsePricingConfig('[]')).toThrow(ConfigError);
    expect(() => parsePricingConfig('{')).toThrow();
  });
});

describe('providerFromConfig', () => {
  it('prices through the same engine as before', () => {
    const provider = providerFromConfig(parsePricingConfig(shipped()).providers[0]!);
    const engine = createPricingEngine(provider);
    const resolved = engine.resolve({
      id: 'r',
      time: Date.parse('2026-09-20T04:00:00Z'),
      model: 'deepseek-v4-flash',
      modelLabel: 'deepseek-v4-flash',
      tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    });
    expect(resolved?.period.id).toBe('2026-09-10');
    expect(resolved?.period.currency.code).toBe('CNY');
  });

  it('finds models by alias, case-insensitively', () => {
    const provider = shippedProviders()[0]!;
    expect(provider.find('DeepSeek-Chat')?.model).toBe('deepseek-flash');
    expect(provider.find('  deepseek-v4-pro ')?.model).toBe('deepseek-v4-pro');
    expect(provider.find('nope')).toBeUndefined();
  });
});

describe('rates configuration', () => {
  it('reads the shipped rate table with its sources', () => {
    const config = shippedRates();
    expect(config.base).toBe('USD');
    expect(config.table['USD']).toBe('1');
    expect(config.table['CNY']).toBeDefined();
    expect(config.sources.map((source) => source.id)).toEqual(['frankfurter', 'er-api']);
    expect(config.sources[0]?.kind).toBe('frankfurter');
  });

  it('turns the table into the rate table the report uses', () => {
    const table = seedTable();
    const config = shippedRates();
    expect(table.base).toBe(config.base);
    expect(table.provenance.date).toBe(config.updatedAt);
    expect(table.provenance.source).toContain(config.source);
    // 1 USD = 6.70471 CNY, so 1 CNY = 1/6.70471 USD.
    expect(Number(rateFrom(table, 'CNY', 'USD'))).toBeCloseTo(1 / 6.70471, 8);
  });

  it('rejects a table without its own base', () => {
    const document = JSON.parse(readFileSync(new URL('../../config/rates.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    delete (document['table'] as Record<string, string>)['USD'];
    expect(() => parseRatesConfig(document)).toThrow(/缺少基准币种 USD/);
  });

  it('rejects a base that is not 1', () => {
    const document = JSON.parse(readFileSync(new URL('../../config/rates.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    (document['table'] as Record<string, string>)['USD'] = '1.01';
    expect(() => parseRatesConfig(document)).toThrow(/基准币种的汇率应为 "1"/);
  });

  it('rejects an unknown source kind', () => {
    const document = JSON.parse(readFileSync(new URL('../../config/rates.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    (document['sources'] as Record<string, unknown>[])[0]!['kind'] = 'scrape';
    expect(() => parseRatesConfig(document)).toThrow(/未知的汇率源类型/);
  });

  it('rejects a negative rate', () => {
    const document = JSON.parse(readFileSync(new URL('../../config/rates.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    (document['table'] as Record<string, string>)['EUR'] = '-0.8';
    expect(() => parseRatesConfig(document)).toThrow(/汇率必须为正/);
  });
});
