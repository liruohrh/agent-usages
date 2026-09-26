/**
 * Currency tests.
 *
 * Conversion happens once, on a provider's published rates, so these pin the two
 * halves of that promise: picking a display currency from flags and locale, and
 * rewriting the rates exactly enough that the amounts and the unit prices printed
 * beside them stay the same money.
 */

import { describe, expect, it } from 'vitest';

import { costOf } from '../../src/report/accounting.ts';
import {
  seedDate,
  convertProvider,
  currencyOf,
  displayRate,
  localeCurrency,
  rateFor,
  rateFrom,
  seedTable,
  selectCurrency,
  chooseDisplay,
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
    // Derived from the table rather than written down: the shipped rates are
    // refreshed by a scheduled job, so a literal would rot.
    const cny = Number(table.rates['CNY']);
    const jpy = Number(table.rates['JPY']);
    expect(Number(rateFrom(table, 'CNY', 'JPY'))).toBeCloseTo(jpy / cny, 6);
    expect(Number(rateFrom(table, 'CNY', 'USD'))).toBeCloseTo(1 / cny, 8);
  });

  it('refuses a currency the table does not quote', () => {
    expect(() => rateFrom(table, 'CNY', 'XYZ')).toThrow(/没有 XYZ 的汇率/);
  });
});

describe('chooseDisplay', () => {
  const published = ['CNY', 'USD'];

  it('uses the published list the reader currency belongs to', () => {
    const zh = chooseDisplay({ published, locale: 'zh-CN' });
    expect(zh.currency?.code).toBe('CNY');
    expect(zh.reason).toBe('locale');
    const en = chooseDisplay({ published, locale: 'en-US' });
    expect(en.currency?.code).toBe('USD');
    expect(en.reason).toBe('locale');
  });

  it('prefers a published currency over a conversion', () => {
    // The locale says EUR, which DeepSeek does not publish; the documented
    // fallback is the dollar, whose numbers are exact as published.
    const choice = chooseDisplay({ published, locale: 'de-DE' });
    expect(choice.currency?.code).toBe('USD');
    expect(choice.reason).toBe('locale-default');
  });

  it('prefers the dollar when the locale says nothing useful', () => {
    const choice = chooseDisplay({ published, locale: 'xx-YY' });
    expect(choice.currency?.code).toBe('USD');
    expect(choice.reason).toBe('locale-default');
  });

  it('takes --currency even when it is not published', () => {
    const choice = chooseDisplay({ published, currencyFlag: 'eur', locale: 'zh-CN' });
    expect(choice.currency?.code).toBe('EUR');
    expect(choice.reason).toBe('flag');
  });

  it('converts without naming a currency when only a rate is given', () => {
    const choice = chooseDisplay({ published, rateFlag: '0.5', locale: 'zh-CN' });
    expect(choice.currency).toBeNull();
    expect(choice.manualRate).toBe('0.5');
    expect(choice.reason).toBe('manual-rate');
    // The rate converts from the list the reader would otherwise have seen.
    expect(choice.baseWanted).toBe('CNY');
  });

  it('keeps the reader list as the base of a manual rate', () => {
    // `--currency USD --currency-rate 0.14` means "1 CNY = 0.14 USD", so the
    // yuan list is the one billed and the dollar list is not used as published.
    const zh = chooseDisplay({ published, currencyFlag: 'USD', rateFlag: '0.14', locale: 'zh-CN' });
    expect(zh.baseWanted).toBe('CNY');
    const en = chooseDisplay({ published, currencyFlag: 'CNY', rateFlag: '7', locale: 'en-US' });
    expect(en.baseWanted).toBe('USD');
  });

  it('rejects a rate that is not a positive decimal', () => {
    for (const bad of ['0', '-1', 'abc', '1/2']) {
      expect(() => chooseDisplay({ published, rateFlag: bad })).toThrow(/汇率必须是正的十进制数/);
    }
  });
});

describe('rateFor', () => {
  it('is the identity when the displayed list is the published one', () => {
    const { rate, provenance } = rateFor({ base: 'USD', target: 'USD' });
    expect(rate).toBe('1');
    expect(provenance.source).toMatch(/未折算/);
  });

  it('crosses through the table otherwise', () => {
    const { rate, provenance } = rateFor({ base: 'USD', target: 'EUR' });
    expect(Number(rate)).toBeCloseTo(Number(seedTable().rates['EUR']), 6);
    expect(provenance.date).toBe(seedDate());
  });

  it('lets a manual rate win', () => {
    const { rate, provenance } = rateFor({ base: 'CNY', target: 'USD', manualRate: '0.2' });
    expect(rate).toBe('0.2');
    expect(provenance.source).toBe('手工指定');
  });

  it('converts without a target when a manual rate is given', () => {
    const { rate } = rateFor({ base: 'CNY', target: null, manualRate: '0.5' });
    expect(rate).toBe('0.5');
  });
});

describe('selectCurrency', () => {
  const provider = stubProvider();

  it('keeps the wanted list', () => {
    const { provider: picked, currencies } = selectCurrency(provider, 'XTS');
    expect(currencies).toEqual(['XTS']);
    for (const price of picked.models()) {
      for (const period of price.periods) expect(period.currency).toBe('XTS');
    }
  });

  it('falls back to the first published list when the wanted one is absent', () => {
    const { currencies } = selectCurrency(provider, 'EUR');
    expect(currencies).toEqual(['XTS']);
  });
});

describe('convertProvider', () => {
  const provider = stubProvider();
  const target = currencyOf('USD');

  it('rewrites every published rate and the currency it is quoted in', () => {
    const converted = convertProvider(provider, target, '0.5');
    const original = provider.find('flat-model')?.periods[0]?.offPeak.find((entry) => entry.id === 'input-miss');
    const rewritten = converted.find('flat-model')?.periods[0]?.offPeak.find((entry) => entry.id === 'input-miss');
    expect(converted.find('flat-model')?.periods[0]?.currency).toBe('USD');
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
