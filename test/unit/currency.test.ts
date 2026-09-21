/**
 * Currency tests.
 *
 * Conversion happens once, on a provider's published rates, so these pin the two
 * halves of that promise: picking a display currency from flags and locale, and
 * rewriting the rates exactly enough that the amounts and the unit prices printed
 * beside them stay the same money.
 */

import { describe, expect, it } from 'vitest';

import { costOf } from '../../src/accounting.ts';
import {
  SEED_DATE,
  convertProvider,
  currencyOf,
  displayRate,
  localeCurrency,
  rateFrom,
  resolveDisplay,
  seedTable,
} from '../../src/pricing/currency.ts';
import { createPricingEngine } from '../../src/pricing/index.ts';
import { buckets, record } from '../support/dataset.ts';
import { STUB_AT, TEST_CURRENCY, stubProvider } from '../support/stub-pricing.ts';

describe('localeCurrency', () => {
  it('maps a language to the currency its speakers use', () => {
    expect(localeCurrency('zh-CN')).toBe('CNY');
    expect(localeCurrency('ja-JP')).toBe('JPY');
    expect(localeCurrency('de-DE')).toBe('EUR');
  });

  it('lets the region override the language', () => {
    // An English speaker in Britain does not pay in dollars.
    expect(localeCurrency('en-US')).toBe('USD');
    expect(localeCurrency('en-GB')).toBe('GBP');
    expect(localeCurrency('zh-TW')).toBe('TWD');
    expect(localeCurrency('pt-BR')).toBe('BRL');
  });

  it('admits when it has no opinion', () => {
    expect(localeCurrency('xx-YY')).toBeUndefined();
    expect(localeCurrency('')).toBeUndefined();
  });
});

describe('rateFrom', () => {
  const table = seedTable();

  it('is the identity for the same currency', () => {
    expect(rateFrom(table, 'CNY', 'CNY')).toBe('1');
  });

  it('crosses through the table base', () => {
    // 1 USD = 6.70471 CNY and 1 USD = 156.919 JPY, so 1 CNY = 156.919/6.70471 JPY.
    expect(Number(rateFrom(table, 'CNY', 'JPY'))).toBeCloseTo(156.919 / 6.70471, 6);
    expect(Number(rateFrom(table, 'CNY', 'USD'))).toBeCloseTo(1 / 6.70471, 8);
  });

  it('refuses a currency the table does not quote', () => {
    expect(() => rateFrom(table, 'CNY', 'XYZ')).toThrow(/没有 XYZ 的汇率/);
  });
});

describe('resolveDisplay', () => {
  it('keeps the vendor currency when the locale agrees with it', () => {
    const choice = resolveDisplay({ base: 'CNY', locale: 'zh-CN' });
    expect(choice.currency?.code).toBe('CNY');
    expect(choice.rate).toBe('1');
    expect(choice.reason).toBe('fallback-base');
  });

  it('follows the locale otherwise', () => {
    const choice = resolveDisplay({ base: 'CNY', locale: 'en-US' });
    expect(choice.currency?.code).toBe('USD');
    expect(Number(choice.rate)).toBeCloseTo(1 / 6.70471, 6);
    expect(choice.reason).toBe('locale');
    expect(choice.provenance.date).toBe(SEED_DATE);
  });

  it('prefers the dollar when the locale says nothing useful', () => {
    const choice = resolveDisplay({ base: 'CNY', locale: 'xx-YY' });
    expect(choice.currency?.code).toBe('USD');
    expect(choice.reason).toBe('locale-default');
  });

  it('takes --currency from the rate table', () => {
    const choice = resolveDisplay({ base: 'CNY', currencyFlag: 'eur', locale: 'zh-CN' });
    expect(choice.currency?.code).toBe('EUR');
    expect(choice.reason).toBe('flag');
    expect(Number(choice.rate)).toBeCloseTo(0.871295 / 6.70471, 8);
  });

  it('converts without naming a currency when only a rate is given', () => {
    const choice = resolveDisplay({ base: 'CNY', rateFlag: '0.5', locale: 'zh-CN' });
    expect(choice.currency).toBeNull();
    expect(choice.rate).toBe('0.5');
    expect(choice.reason).toBe('manual-rate');
    expect(choice.provenance.source).toBe('手工指定');
  });

  it('lets a manual rate win over the table', () => {
    const choice = resolveDisplay({ base: 'CNY', currencyFlag: 'USD', rateFlag: '0.2' });
    expect(choice.currency?.code).toBe('USD');
    expect(choice.rate).toBe('0.2');
    expect(choice.reason).toBe('flag');
  });

  it('rejects a rate that is not a positive decimal', () => {
    for (const bad of ['0', '-1', 'abc', '1/2']) {
      expect(() => resolveDisplay({ base: 'CNY', rateFlag: bad })).toThrow(/汇率必须是正的十进制数/);
    }
  });
});

describe('convertProvider', () => {
  const provider = stubProvider();
  const target = currencyOf('USD');

  it('rewrites every published rate and the currency it is quoted in', () => {
    const converted = convertProvider(provider, target, '0.5');
    const original = provider.find('flat-model')?.periods[0]?.offPeak.find((entry) => entry.id === 'input-miss');
    const rewritten = converted.find('flat-model')?.periods[0]?.offPeak.find((entry) => entry.id === 'input-miss');
    expect(converted.currency).toEqual({ code: 'USD', symbol: '$' });
    expect(original?.rate).toBe('10');
    expect(rewritten?.rate).toBe('5');
  });

  it('keeps aliases findable', () => {
    const converted = convertProvider(provider, target, '0.5');
    expect(converted.find('flat-alias')).toBeDefined();
    expect(converted.find('no-such-model')).toBeUndefined();
  });

  it('prices records in the target currency, unit prices included', () => {
    const engine = createPricingEngine(convertProvider(provider, target, '0.5'));
    const summary = costOf(
      [
        record({
          time: STUB_AT.early,
          model: 'flat-model',
          tokens: buckets({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }),
        }),
      ],
      engine,
    );
    // 0.5 × (1 + 10 + 20 + 5) = 18, in the vendor's own arithmetic.
    expect(summary.totals.total).toBe('18.0000');
    expect(summary.breakdown[0]?.amounts['input-miss']).toBe('5.0000');
  });

  it('leaves the vendor currency alone at a rate of one', () => {
    const engine = createPricingEngine(convertProvider(provider, currencyOf(TEST_CURRENCY.code), '1'));
    const summary = costOf([record({ time: STUB_AT.early, model: 'flat-model', tokens: buckets({ output: 1_000_000 }) })], engine);
    expect(summary.totals.total).toBe('20.0000');
  });
});

describe('displayRate', () => {
  it('prints six decimals without trailing zeros', () => {
    expect(displayRate('0.149148881')).toBe('0.149149');
    expect(displayRate('0.500000000')).toBe('0.5');
    expect(displayRate('1.000000000')).toBe('1');
  });
});
