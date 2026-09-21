/**
 * DeepSeek's published price lists, as shipped in `config/pricing.json`.
 *
 * These assertions pin the facts transcribed from DeepSeek's own docs and from
 * archived snapshots of the pricing pages, including the things that are easy to
 * get wrong: the 2026-08-23 weekend exemption, the 2026-04-26 cache-hit cut, and
 * the two currencies DeepSeek publishes (yuan for the Chinese site, dollars for
 * the international one, as separate numbers). Every period must name the URL it
 * came from, so a wrong number is traceable rather than mysterious.
 */

import { describe, expect, it } from 'vitest';

import { emptyBuckets } from '../../src/core/buckets.ts';
import { createPricingEngine, isPeak, type PricePeriod } from '../../src/pricing/index.ts';
import { shippedProviders } from '../../src/config/pricing.ts';

/**
 * The yuan list, which these assertions were written against: the engine prices
 * in the CNY schedule unless a reader asks for another currency.
 */
const deepseekPricing = shippedProviders()[0]!;
const DEEPSEEK_PRICES = deepseekPricing.models();
import { record } from '../support/dataset.ts';

const engine = createPricingEngine(deepseekPricing);

/** Instants in UTC, annotated with the Beijing wall clock they correspond to. */
const AT = {
  /** 2026-03-01 12:00 CST — inside the V3.2 flat period. */
  v32: Date.parse('2026-03-01T04:00:00Z'),
  /** 2026-04-24 12:00 CST — inside the V4 preview period. */
  v4Launch: Date.parse('2026-04-24T04:00:00Z'),
  /** 2026-05-01 12:00 CST — after the cache-hit cut. */
  afterCacheCut: Date.parse('2026-05-01T04:00:00Z'),
  /** 2026-08-20 10:00 CST (Thursday) — peak, before the weekend exemption. */
  augustPeak: Date.parse('2026-08-20T02:00:00Z'),
  /** 2026-08-22 10:00 CST (Saturday) — peak, because weekends were not yet exempt. */
  saturdayBeforeExemption: Date.parse('2026-08-22T02:00:00Z'),
  /** 2026-08-22 16:00:00 CST — the exemption takes effect at this instant. */
  exemptionEffective: Date.parse('2026-08-22T16:00:00Z'),
  /** 2026-08-29 10:00 CST (Saturday) — off-peak, after the exemption. */
  saturdayAfterExemption: Date.parse('2026-08-29T02:00:00Z'),
  /** 2026-08-31 10:00 CST (Monday) — peak, after the exemption. */
  mondayAfterExemption: Date.parse('2026-08-31T02:00:00Z'),
  /** 2026-09-10 11:59:59 CST — one second before the V4.1 price change. */
  beforePriceChange: Date.parse('2026-09-10T03:59:59Z'),
  /** 2026-09-10 12:00:00 CST — the new price takes effect exactly here. */
  priceChange: Date.parse('2026-09-10T04:00:00Z'),
  /** 2026-09-14 10:00 CST (Monday) — current period, peak. */
  currentPeak: Date.parse('2026-09-14T02:00:00Z'),
  /** 2026-09-14 20:00 CST — current period, off-peak. */
  currentOffPeak: Date.parse('2026-09-14T12:00:00Z'),
} as const;

/** One million of each prompt bucket, one million of output. */
function million(): { input: number; output: number; cacheRead: number } {
  return { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 };
}

/** The rates of the period governing an instant. */
function ratesAt(instant: number, model = 'deepseek-flash'): { hit: string; miss: string; out: string } {
  const resolved = engine.resolve(record({ time: instant, model }));
  if (resolved === undefined) throw new Error('no rate resolved');
  const at = (id: string): string => resolved.components.find((component) => component.id === id)?.rate ?? '?';
  return { hit: at('input-hit'), miss: at('input-miss'), out: at('output') };
}

describe('schedule integrity', () => {
  it('orders each currency\'s periods ascending with no gap or overlap', () => {
    for (const price of DEEPSEEK_PRICES) {
      // A model carries one history per published currency; each is contiguous
      // on its own, which is what period lookup relies on.
      const currencies = [...new Set(price.periods.map((period) => period.currency))];
      for (const code of currencies) {
        const history = price.periods.filter((period) => period.currency === code);
        for (let index = 1; index < history.length; index += 1) {
          const previous = history[index - 1] as PricePeriod;
          const current = history[index] as PricePeriod;
          expect(current.from).toBeGreaterThan(previous.from);
          expect(previous.to).toBe(current.from);
        }
      }
    }
  });

  it('publishes the dollar list as its own numbers, not a conversion', () => {
    // The two lists agree on windows but not on values: DeepSeek rounds the
    // dollar prices to two or three significant digits, so they are recorded
    // separately rather than derived from the yuan ones.
    const flash = deepseekPricing.models().find((price) => price.model === 'deepseek-flash');
    const current = (code: string): string | undefined =>
      flash?.periods
        .filter((period) => period.currency === code)
        .find((period) => period.to === null)
        ?.offPeak.find((component) => component.id === 'output')?.rate;
    expect(current('CNY')).toBe('4');
    expect(current('USD')).toBe('0.6');
  });

  it('gives every period a source URL and a note', () => {
    for (const price of DEEPSEEK_PRICES) {
      for (const period of price.periods) {
        expect(period.source).toMatch(/^https:\/\/(api-docs\.deepseek\.com|web\.archive\.org\/web\/\d+\/https:\/\/api-docs\.deepseek\.com)\//);
        expect(period.note.length).toBeGreaterThan(0);
      }
    }
  });

  it('prices peak at exactly twice off-peak, as DeepSeek states', () => {
    for (const price of DEEPSEEK_PRICES) {
      for (const period of price.periods) {
        if (period.peak === null) continue;
        for (const off of period.offPeak) {
          const peak = period.peak.find((component) => component.id === off.id);
          expect(peak).toBeDefined();
          expect(Number(peak?.rate)).toBeCloseTo(Number(off.rate) * 2, 10);
        }
      }
    }
  });

  it('never bills cache writes as a separate line item', () => {
    // DeepSeek builds its disk cache automatically and charges only reads, so
    // the miss component must charge `inputAndCacheWrite` rather than `input`.
    for (const price of DEEPSEEK_PRICES) {
      for (const period of price.periods) {
        for (const component of [...period.offPeak, ...(period.peak ?? [])]) {
          expect(component.id).not.toBe('input-write');
        }
        expect(period.offPeak.find((component) => component.id === 'input-miss')?.basis).toBe('inputAndCacheWrite');
      }
    }
  });
});

describe('published rates', () => {
  it('charges the V3.2 flat rate before V4', () => {
    expect(ratesAt(AT.v32)).toEqual({ hit: '0.2', miss: '2', out: '3' });
  });

  it('charges the V4 launch rate, then the 2026-04-26 cache-hit cut', () => {
    expect(ratesAt(AT.v4Launch)).toEqual({ hit: '0.2', miss: '1', out: '2' });
    expect(ratesAt(AT.afterCacheCut)).toEqual({ hit: '0.02', miss: '1', out: '2' });
  });

  it('charges the 2026-08-17 peak/valley rates', () => {
    const off = engine.resolve(record({ time: Date.parse('2026-08-20T12:00:00Z'), model: 'deepseek-flash' }));
    const peak = engine.resolve(record({ time: AT.augustPeak, model: 'deepseek-flash' }));
    expect(off?.period.id).toBe('2026-08-17');
    expect(off?.components.find((component) => component.id === 'input-miss')?.rate).toBe('1.5');
    expect(peak?.tier).toBe('peak');
    expect(peak?.components.find((component) => component.id === 'input-miss')?.rate).toBe('3');
  });

  it('charges the current V4.1-Flash rates from 2026-09-10 12:00 CST', () => {
    expect(ratesAt(AT.currentOffPeak)).toEqual({ hit: '0.02', miss: '1', out: '4' });
    expect(ratesAt(AT.currentPeak)).toEqual({ hit: '0.04', miss: '2', out: '8' });
  });

  it('switches rates exactly at the announced instant', () => {
    expect(engine.resolve(record({ time: AT.beforePriceChange, model: 'deepseek-flash' }))?.period.id).toBe('2026-08-23');
    expect(engine.resolve(record({ time: AT.priceChange, model: 'deepseek-flash' }))?.period.id).toBe('2026-09-10');
    expect(engine.resolve(record({ time: AT.priceChange, model: 'deepseek-flash' }))?.resolution).toBe('exact');
  });

  it('routes retired and aliased names onto the same schedule', () => {
    for (const alias of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-chat', 'deepseek-reasoner']) {
      expect(deepseekPricing.find(alias)?.model).toBe('deepseek-flash');
    }
    expect(ratesAt(AT.currentOffPeak, 'deepseek-v4-flash')).toEqual(ratesAt(AT.currentOffPeak, 'deepseek-flash'));
  });

  it('prices V4-Pro on its own schedule', () => {
    expect(ratesAt(AT.v4Launch, 'deepseek-v4-pro')).toEqual({ hit: '1', miss: '12', out: '24' });
    expect(ratesAt(AT.afterCacheCut, 'deepseek-v4-pro')).toEqual({ hit: '0.025', miss: '3', out: '6' });
    expect(ratesAt(AT.currentPeak, 'deepseek-v4-pro')).toEqual({ hit: '0.3', miss: '9', out: '27' });
  });
});

describe('the 2026-08-23 weekend exemption', () => {
  it('charged weekends at peak before the exemption', () => {
    // The first announcement scoped the window only by clock time.
    const resolved = engine.resolve(record({ time: AT.saturdayBeforeExemption, model: 'deepseek-flash' }));
    expect(resolved?.period.id).toBe('2026-08-17');
    expect(resolved?.tier).toBe('peak');
  });

  it('switches period exactly at Beijing 2026-08-23 00:00', () => {
    expect(engine.resolve(record({ time: AT.exemptionEffective - 1000, model: 'deepseek-flash' }))?.period.id).toBe('2026-08-17');
    expect(engine.resolve(record({ time: AT.exemptionEffective, model: 'deepseek-flash' }))?.period.id).toBe('2026-08-23');
  });

  it('exempts weekends while keeping weekdays at peak', () => {
    expect(engine.resolve(record({ time: AT.saturdayAfterExemption, model: 'deepseek-flash' }))?.tier).toBe('off-peak');
    expect(engine.resolve(record({ time: AT.mondayAfterExemption, model: 'deepseek-flash' }))?.tier).toBe('peak');
  });

  it('leaves the unit prices untouched across the exemption', () => {
    const before = engine.resolve(record({ time: AT.saturdayBeforeExemption, model: 'deepseek-flash' }));
    const after = engine.resolve(record({ time: AT.mondayAfterExemption, model: 'deepseek-flash' }));
    expect(before?.period.offPeak).toEqual(after?.period.offPeak);
    expect(before?.period.peak).toEqual(after?.period.peak);
  });

  it('applies the exemption to V4-Pro as well', () => {
    expect(engine.resolve(record({ time: AT.saturdayBeforeExemption, model: 'deepseek-v4-pro' }))?.tier).toBe('peak');
    expect(engine.resolve(record({ time: AT.saturdayAfterExemption, model: 'deepseek-v4-pro' }))?.tier).toBe('off-peak');
  });
});

describe('cost of a real request', () => {
  it('bills the three published line items and nothing else', () => {
    // 1M of each at the current off-peak rates: 1 + 0.02 + 4 = 5.02 CNY.
    const cost = engine.costOf(
      record({ time: AT.currentOffPeak, model: 'deepseek-flash', tokens: { ...emptyBuckets(), ...million() } }),
    );
    expect(cost?.amounts.get('input-miss')).toBe(1_000_000_000n);
    expect(cost?.amounts.get('input-hit')).toBe(20_000_000n);
    expect(cost?.amounts.get('output')).toBe(4_000_000_000n);
    expect(cost?.total).toBe(5_020_000_000n);
  });

  it('charges cache writes at the cache-miss rate rather than dropping them', () => {
    const cost = engine.costOf(
      record({ time: AT.currentOffPeak, model: 'deepseek-flash', tokens: { ...emptyBuckets(), cacheWrite: 1_000_000 } }),
    );
    expect(cost?.total).toBe(1_000_000_000n);
  });

  it('doubles every line item during peak', () => {
    const peak = engine.costOf(
      record({ time: AT.currentPeak, model: 'deepseek-flash', tokens: { ...emptyBuckets(), ...million() } }),
    );
    const off = engine.costOf(
      record({ time: AT.currentOffPeak, model: 'deepseek-flash', tokens: { ...emptyBuckets(), ...million() } }),
    );
    expect(peak?.total).toBe((off?.total ?? 0n) * 2n);
  });
});

describe('provider metadata', () => {
  it('publishes its list in both yuan and dollars', () => {
    // DeepSeek quotes the Chinese site in CNY and the international one in USD;
    // the two are separate published numbers, so both are kept.
    const currencies = new Set(deepseekPricing.models().flatMap((price) => price.periods.map((period) => period.currency)));
    expect([...currencies].sort()).toEqual(['CNY', 'USD']);
    for (const price of deepseekPricing.models()) {
      const cny = price.periods.filter((period) => period.currency === 'CNY');
      const usd = price.periods.filter((period) => period.currency === 'USD');
      // Every yuan period has a dollar counterpart covering the same window.
      expect(usd).toHaveLength(cny.length);
      for (const period of cny) {
        const twin = usd.find((entry) => entry.id === period.id);
        expect(twin?.from).toBe(period.from);
        expect(twin?.to).toBe(period.to);
      }
    }
  });

  it('falls back to Flash for unknown models', () => {
    expect(deepseekPricing.defaultModel).toBe('deepseek-flash');
  });

  it('offers an every-day window and a weekday window', () => {
    const [flash] = DEEPSEEK_PRICES;
    const early = flash?.periods.find((period) => period.id === '2026-08-17');
    const late = flash?.periods.find((period) => period.id === '2026-08-23');
    expect(early?.peakWindows.every((window) => window.weekdays === null)).toBe(true);
    expect(late?.peakWindows.every((window) => window.weekdays?.length === 5)).toBe(true);
  });
});
