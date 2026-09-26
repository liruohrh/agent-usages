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

import { ConfigError } from '../../src/i18n/errors.ts';
import { parsePricingConfig, providerFromConfig, shippedProviders } from '../../src/pricing/catalog.ts';
import { parseRatesConfig, shippedRates } from '../../src/pricing/rates.ts';
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

/** The off-peak card of {@link firstPeriod}, as a mutable list. */
function firstCard(document: Record<string, unknown>): Record<string, unknown>[] {
  return firstPeriod(document)['offPeak'] as Record<string, unknown>[];
}

/** A cache-write component the shipped DeepSeek card deliberately does not have. */
function cacheWriteComponent(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'input-write', label: '缓存写入', basis: 'cacheWrite', rate: '3', per: 1_000_000, ...extra };
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
      const cny = model.periods.filter((period) => period.currency === 'CNY');
      const usd = model.periods.filter((period) => period.currency === 'USD');
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
    expect(() => parsePricingConfig(document)).toThrow(/providers\[0\]\.models\[0\]\.periods\[0\]\.from: 应为带偏移的 ISO 时间/);
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
    const second = periods.filter((period) => period['currency'] === 'CNY')[1]!;
    second['from'] = '2026-04-25T00:00:00+08:00';
    expect(() => parsePricingConfig(document)).toThrow(/区间不连续/);
  });

  it('rejects a history that never ends', () => {
    const document = shipped();
    const periods = (document['providers'] as { models: { periods: Record<string, unknown>[] }[] }[])[0]!.models[0]!.periods;
    const yuan = periods.filter((period) => period['currency'] === 'CNY');
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

describe('long-context tranches', () => {
  it('reads a tranche into the component it was written on', () => {
    const document = shipped();
    const card = firstCard(document);
    card[2]!['aboveThreshold'] = { tokens: 200_000, rate: '4.5' };
    const period = parsePricingConfig(document).providers[0]!.models[0]!.periods[0]!;
    expect(period.offPeak[2]!.aboveThreshold).toEqual({ tokens: 200_000, rate: '4.5' });
    // Every other component keeps the shape it had before the field existed.
    expect(period.offPeak[0]!.aboveThreshold).toBeUndefined();
  });

  it('rejects a tranche that is missing a field or typed wrongly', () => {
    const missingRate = shipped();
    firstCard(missingRate)[2]!['aboveThreshold'] = { tokens: 200_000 };
    expect(() => parsePricingConfig(missingRate)).toThrow(/aboveThreshold\.rate: 缺少字段 rate/);

    const missingTokens = shipped();
    firstCard(missingTokens)[2]!['aboveThreshold'] = { rate: '4' };
    expect(() => parsePricingConfig(missingTokens)).toThrow(/aboveThreshold\.tokens: 缺少字段 tokens/);

    const typedWrong = shipped();
    firstCard(typedWrong)[2]!['aboveThreshold'] = { tokens: '200000', rate: '4' };
    expect(() => parsePricingConfig(typedWrong)).toThrow(/aboveThreshold\.tokens: 应为数字/);

    const notANumber = shipped();
    firstCard(notANumber)[2]!['aboveThreshold'] = { tokens: 200_000, rate: '4元' };
    expect(() => parsePricingConfig(notANumber)).toThrow(/aboveThreshold\.rate: 不是十进制数/);
  });

  it('rejects a threshold that is zero, negative, or fractional', () => {
    for (const tokens of [0, -1, 1.5]) {
      const document = shipped();
      firstCard(document)[2]!['aboveThreshold'] = { tokens, rate: '4' };
      expect(() => parsePricingConfig(document)).toThrow(/aboveThreshold\.tokens: 应为正整数/);
    }
  });

  it('rejects a tranche rate that is not positive', () => {
    const document = shipped();
    firstCard(document)[2]!['aboveThreshold'] = { tokens: 200_000, rate: '-4' };
    expect(() => parsePricingConfig(document)).toThrow(/aboveThreshold\.rate: 单价\/倍率必须为正/);
  });
});

describe('cache-write TTL multipliers', () => {
  it('reads multipliers only on a component that bills cache writes alone', () => {
    const document = shipped();
    firstCard(document).push(cacheWriteComponent({ ttlMultipliers: { '1h': '2.0' } }));
    const period = parsePricingConfig(document).providers[0]!.models[0]!.periods[0]!;
    expect(period.offPeak[3]!.ttlMultipliers).toEqual({ '1h': '2.0' });

    const onInput = shipped();
    firstCard(onInput)[2]!['ttlMultipliers'] = { '1h': '2' };
    expect(() => parsePricingConfig(onInput)).toThrow(/只能写在 basis 为 cacheWrite 的组件上/);
  });

  it('rejects an unknown tier, an empty map, and a non-positive multiplier', () => {
    const unknownTier = shipped();
    firstCard(unknownTier).push(cacheWriteComponent({ ttlMultipliers: { '2h': '2' } }));
    expect(() => parsePricingConfig(unknownTier)).toThrow(/未知的缓存 TTL 档位/);

    const empty = shipped();
    firstCard(empty).push(cacheWriteComponent({ ttlMultipliers: {} }));
    expect(() => parsePricingConfig(empty)).toThrow(/至少要写一个档位/);

    for (const multiplier of ['0', '-2', '2元']) {
      const document = shipped();
      firstCard(document).push(cacheWriteComponent({ ttlMultipliers: { '1h': multiplier } }));
      expect(() => parsePricingConfig(document)).toThrow(/不是十进制数|必须为正/);
    }

    const notAString = shipped();
    firstCard(notAString).push(cacheWriteComponent({ ttlMultipliers: { '1h': 2 } }));
    expect(() => parsePricingConfig(notAString)).toThrow(/应为非空字符串/);
  });

  it('rejects a 5m multiplier that is not 1, since rate already is the 5m price', () => {
    const document = shipped();
    firstCard(document).push(cacheWriteComponent({ ttlMultipliers: { '5m': '1.5', '1h': '2' } }));
    expect(() => parsePricingConfig(document)).toThrow(/5m 档的倍率应为 "1"/);

    const explicit = shipped();
    firstCard(explicit).push(cacheWriteComponent({ ttlMultipliers: { '5m': '1' } }));
    expect(parsePricingConfig(explicit).providers[0]!.models[0]!.periods[0]!.offPeak[3]!.ttlMultipliers).toEqual({
      '5m': '1',
    });
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
    expect(resolved?.period.currency).toBe('CNY');
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
    // Derived, not written down: the scheduled job refreshes this file.
    expect(Number(rateFrom(table, 'CNY', 'USD'))).toBeCloseTo(1 / Number(config.table['CNY']), 8);
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
