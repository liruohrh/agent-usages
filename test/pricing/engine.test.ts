/**
 * Vendor-neutral pricing engine tests.
 *
 * Everything here runs against the synthetic provider, so a pass means the
 * engine's period selection, tiering, and component arithmetic work for *any*
 * vendor — not just the one this build happens to ship.
 */

import { describe, expect, it } from 'vitest';

import { emptyBuckets } from '../../src/core/buckets.ts';
import { bareModelName, chargeComponent, createPricingEngine, isPeak, zoneTime } from '../../src/pricing/index.ts';
import type { RateComponent } from '../../src/pricing/index.ts';
import {
  CONTEXT_AT,
  CONTEXT_THRESHOLD,
  STUB_AT,
  contextProvider,
  perMillion,
  stubProvider,
  TEST_CURRENCY,
} from '../support/stub-pricing.ts';
import { record } from '../support/dataset.ts';

const engine = createPricingEngine(stubProvider());
const contextEngine = createPricingEngine(contextProvider());

/** A component with a long-context tranche and, optionally, TTL multipliers. */
function tiered(overrides: Partial<RateComponent> = {}): RateComponent {
  return {
    ...perMillion('input-miss', 'miss', 'input', '1'),
    aboveThreshold: { tokens: 200_000, rate: '3' },
    ...overrides,
  };
}

describe('model resolution', () => {
  it('strips a provider-qualified label', () => {
    expect(bareModelName('vendor / model-name')).toBe('model-name');
    expect(bareModelName('model-name')).toBe('model-name');
  });

  it('resolves canonical ids and aliases', () => {
    expect(engine.provider.find('flat-model')?.model).toBe('flat-model');
    expect(engine.provider.find('flat-alias')?.model).toBe('flat-model');
    expect(engine.provider.find('FLAT-MODEL')?.model).toBe('flat-model');
    expect(engine.provider.find('nope')).toBeUndefined();
  });

  it('quotes every period in the stub currency', () => {
    const periods = engine.provider.models().flatMap((price) => price.periods);
    expect(periods.length).toBeGreaterThan(0);
    for (const period of periods) expect(period.currency).toBe(TEST_CURRENCY.code);
  });
});

describe('period selection', () => {
  it('picks the period containing the instant', () => {
    expect(engine.resolve(record({ time: STUB_AT.early, model: 'tiered-model' }))?.period.id).toBe('2026-01-01');
    expect(engine.resolve(record({ time: STUB_AT.late, model: 'tiered-model' }))?.period.id).toBe('2026-06-01');
  });

  it('falls back to the earliest LATER period when none covers the instant', () => {
    const resolved = engine.resolve(record({ time: STUB_AT.beforeAll, model: 'tiered-model' }));
    expect(resolved?.period.id).toBe('2026-01-01');
    expect(resolved?.resolution).toBe('fallback-later');
  });

  it('falls back to the latest EARLIER period when nothing follows', () => {
    // A bounded schedule is needed to reach this branch: while the final period
    // is open-ended it covers every later instant.
    const bounded = createPricingEngine({
      ...stubProvider(),
      models: () => [
        {
          model: 'bounded',
          aliases: ['bounded'],
          periods: [
            {
              id: 'first',
              label: 'first',
              from: Date.parse('2026-01-01T00:00:00Z'),
              to: Date.parse('2026-02-01T00:00:00Z'),
              offPeak: [perMillion('output', 'out', 'output', '1')],
              peak: null,
              peakWindows: [],
              utcOffset: 0,
              currency: TEST_CURRENCY.code,
              source: 'test',
              note: '',
            },
          ],
        },
      ],
      find: (model) => (model === 'bounded' ? bounded.provider.models()[0] : undefined),
    });
    const resolved = bounded.resolve(record({ time: Date.parse('2026-05-01T00:00:00Z'), model: 'bounded' }));
    expect(resolved?.period.id).toBe('first');
    expect(resolved?.resolution).toBe('fallback-earlier');
  });

  it('uses the default model for an unknown model, and says so', () => {
    const resolved = engine.resolve(record({ time: STUB_AT.early, model: 'unknown-model' }));
    expect(resolved?.model).toBe('flat-model');
    expect(resolved?.resolution).toBe('fallback-default');
  });

  it('returns undefined when there is no fallback either', () => {
    const strict = createPricingEngine({ ...stubProvider(), defaultModel: null });
    expect(strict.resolve(record({ time: STUB_AT.early, model: 'unknown-model' }))).toBeUndefined();
    expect(strict.costOf(record({ time: STUB_AT.early, model: 'unknown-model' }))).toBeUndefined();
  });
});

describe('tier selection', () => {
  it('opens a window inclusively and closes it exclusively', () => {
    expect(isPeak(STUB_AT.earlyOffPeak, [{ fromHour: 9, toHour: 12, weekdays: null }], 0)).toBe(false);
    expect(isPeak(STUB_AT.earlyPeak, [{ fromHour: 9, toHour: 12, weekdays: null }], 0)).toBe(true);
    expect(isPeak(STUB_AT.earlyJustAfterPeak, [{ fromHour: 9, toHour: 12, weekdays: null }], 0)).toBe(false);
  });

  it('honours a null weekday list as every day', () => {
    // 2026-03-01 is a Sunday.
    expect(zoneTime(STUB_AT.earlyPeakSunday, 0).weekday).toBe(0);
    expect(isPeak(STUB_AT.earlyPeakSunday, [{ fromHour: 9, toHour: 12, weekdays: null }], 0)).toBe(true);
  });

  it('restricts a window to listed weekdays', () => {
    const weekdaysOnly = [{ fromHour: 9, toHour: 12, weekdays: [1, 2, 3, 4, 5] }];
    expect(isPeak(STUB_AT.earlyPeakSunday, weekdaysOnly, 0)).toBe(false);
    expect(isPeak(Date.parse('2026-03-02T09:00:00Z'), weekdaysOnly, 0)).toBe(true);
  });

  it('resolves the tier inside the period and reports it', () => {
    expect(engine.resolve(record({ time: STUB_AT.earlyPeak, model: 'tiered-model' }))?.tier).toBe('peak');
    expect(engine.resolve(record({ time: STUB_AT.earlyOffPeak, model: 'tiered-model' }))?.tier).toBe('off-peak');
    expect(engine.resolve(record({ time: STUB_AT.late, model: 'tiered-model' }))?.tier).toBe('flat');
    expect(engine.resolve(record({ time: STUB_AT.early, model: 'flat-model' }))?.tier).toBe('flat');
  });

  it('evaluates windows on the period clock, not the machine clock', () => {
    // The stub's window is written in UTC; 09:00 UTC is 17:00 in Shanghai.
    expect(isPeak(STUB_AT.earlyPeak, [{ fromHour: 9, toHour: 12, weekdays: null }], 0)).toBe(true);
    expect(isPeak(STUB_AT.earlyPeak, [{ fromHour: 9, toHour: 12, weekdays: null }], 480)).toBe(false);
  });
});

describe('component arithmetic', () => {
  it('charges each component against its own bucket', () => {
    // 1M of each bucket at 1/10/20/5 per million == 1 + 10 + 20 + 5.
    const cost = engine.costOf(
      record({
        time: STUB_AT.early,
        model: 'flat-model',
        tokens: { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, reasoning: 0 },
      }),
    );
    expect(cost?.amounts.get('input-hit')).toBe(1_000_000_000n);
    expect(cost?.amounts.get('input-miss')).toBe(10_000_000_000n);
    expect(cost?.amounts.get('output')).toBe(20_000_000_000n);
    expect(cost?.amounts.get('input-write')).toBe(5_000_000_000n);
    expect(cost?.total).toBe(36_000_000_000n);
  });

  it('bills cache writes separately when the vendor does', () => {
    const cost = engine.costOf(
      record({ time: STUB_AT.early, model: 'flat-model', tokens: { ...emptyBuckets(), cacheWrite: 2_000_000 } }),
    );
    expect(cost?.amounts.get('input-write')).toBe(10_000_000_000n);
    // Nothing else was charged: the miss component only bills `input`.
    expect(cost?.amounts.get('input-miss')).toBe(0n);
  });

  it('never charges reasoning on top of output', () => {
    const withReasoning = engine.costOf(
      record({ time: STUB_AT.early, model: 'flat-model', tokens: { ...emptyBuckets(), output: 1_000_000, reasoning: 900_000 } }),
    );
    const without = engine.costOf(
      record({ time: STUB_AT.early, model: 'flat-model', tokens: { ...emptyBuckets(), output: 1_000_000 } }),
    );
    expect(withReasoning?.total).toBe(without?.total);
  });

  it('applies the tier that was selected', () => {
    const peak = engine.costOf(record({ time: STUB_AT.earlyPeak, model: 'tiered-model', tokens: { ...emptyBuckets(), input: 1_000_000 } }));
    const off = engine.costOf(record({ time: STUB_AT.earlyOffPeak, model: 'tiered-model', tokens: { ...emptyBuckets(), input: 1_000_000 } }));
    expect(peak?.total).toBe(2_000_000_000n);
    expect(off?.total).toBe(1_000_000_000n);
  });

  it('ignores a bucket no component bills', () => {
    const cost = engine.costOf(record({ time: STUB_AT.early, model: 'tiered-model', tokens: { ...emptyBuckets(), cacheRead: 5_000_000 } }));
    expect(cost?.total).toBe(0n);
  });
});

describe('descriptions', () => {
  it('describes windows on the period clock', () => {
    const period = engine.provider.models()[0]?.periods[0];
    expect(period).toBeDefined();
    expect(engine.describeWindow(period!)).toContain('(UTC+00:00)');
    expect(engine.describeWindow(period!)).toContain('至今');
  });

  it('describes every-day and weekday-only tiers differently', () => {
    const tiered = engine.provider.models()[1]?.periods[0];
    expect(engine.describeTiers(tiered!)).toContain('每天');
  });

  it('describes a flat period as untiered', () => {
    const flat = engine.provider.models()[0]?.periods[0];
    expect(engine.describeTiers(flat!)).toContain('不分峰谷');
  });
});

describe('long-context tranches', () => {
  it('charges the excess at the higher rate and the rest at the published one', () => {
    // 200k x 1 + 100k x 3, per million: 0.2 + 0.3.
    const charge = chargeComponent(tiered(), { ...emptyBuckets(), input: 300_000 });
    expect(charge.baseTokens).toBe(200_000);
    expect(charge.excessTokens).toBe(100_000);
    expect(charge.base).toBe(200_000_000n);
    expect(charge.excess).toBe(300_000_000n);
    expect(charge.excessRate).toBe(3_000_000_000n);
    expect(charge.total).toBe(500_000_000n);
  });

  it('bills the whole quantity at the base rate at, and below, the threshold', () => {
    const atThreshold = chargeComponent(tiered(), { ...emptyBuckets(), input: 200_000 });
    expect(atThreshold.excessTokens).toBe(0);
    expect(atThreshold.excessRate).toBeNull();
    expect(atThreshold.excess).toBe(0n);
    expect(atThreshold.base).toBe(200_000_000n);
    expect(atThreshold.total).toBe(atThreshold.base);

    const below = chargeComponent(tiered(), { ...emptyBuckets(), input: 199_999 });
    expect(below.excessTokens).toBe(0);
    expect(below.base).toBe(199_999_000n);
    expect(below.total).toBe(below.base);
  });

  it('never produces a negative tranche, and charges nothing for no tokens', () => {
    const none = chargeComponent(tiered(), emptyBuckets());
    expect(none.total).toBe(0n);
    expect(none.baseTokens).toBe(0);
    expect(none.excessTokens).toBe(0);
    expect(none.excessRate).toBeNull();

    // A threshold larger than the quantity is simply never reached.
    const tiny = chargeComponent(tiered({ aboveThreshold: { tokens: 10, rate: '3' } }), {
      ...emptyBuckets(),
      input: 4,
    });
    expect(tiny.excessTokens).toBe(0);
    expect(tiny.baseTokens).toBe(4);
  });

  it('adds the tranches exactly, so the record total is the sum of its components', () => {
    const cost = contextEngine.costOf(
      record({
        time: CONTEXT_AT.any,
        model: 'context-model',
        tokens: { ...emptyBuckets(), input: 300_000, cacheWrite: 100_000 },
      }),
    );
    expect(cost).toBeDefined();
    let summed = 0n;
    for (const amount of cost!.amounts.values()) summed += amount;
    expect(cost!.total).toBe(summed);
    // 0.2 + 0.2 for the input, 0.5 for the write, and no rounding anywhere.
    expect(cost!.amounts.get('input-miss')).toBe(400_000_000n);
    expect(cost!.amounts.get('input-write')).toBe(500_000_000n);
    expect(cost!.total).toBe(900_000_000n);
    const miss = cost!.charges?.get('input-miss');
    expect((miss?.base ?? 0n) + (miss?.excess ?? 0n)).toBe(miss?.total);
    // The write stayed under the threshold, so only the input carries a tranche.
    expect(cost!.charges?.has('input-write')).toBe(false);
  });

  it('keeps a card without a threshold on the untiered path', () => {
    const plain = perMillion('input-miss', 'miss', 'input', '4');
    const charge = chargeComponent(plain, { ...emptyBuckets(), input: 700_000 });
    expect(charge.total).toBe(charge.base);
    expect(charge.excessTokens).toBe(0);
    expect(charge.excessRate).toBeNull();
    expect(charge.base).toBe(2_800_000_000n);
  });

  it('reports no tranche when the quantity stayed under the threshold', () => {
    const cost = contextEngine.costOf(
      record({ time: CONTEXT_AT.any, model: 'context-model', tokens: { ...emptyBuckets(), input: CONTEXT_THRESHOLD } }),
    );
    expect(cost?.charges).toBeUndefined();
  });
});

describe('cache-write TTL multipliers', () => {
  it('multiplies a 1h write and leaves a default write at the published rate', () => {
    const write: RateComponent = {
      ...perMillion('input-write', 'write', 'cacheWrite', '5'),
      ttlMultipliers: { '1h': '2' },
    };
    const long = chargeComponent(write, { ...emptyBuckets(), cacheWrite: 1_000_000 }, { cacheWriteTtl: '1h' });
    expect(long.total).toBe(10_000_000_000n);
    expect(long.ttlTier).toBe('1h');
    expect(long.ttlMultiplier).toBe(2_000_000_000n);
    expect(long.ttlTokens).toBe(1_000_000);

    // A record that names no TTL is billed at the card's own (5m) rate.
    const short = chargeComponent(write, { ...emptyBuckets(), cacheWrite: 1_000_000 });
    expect(short.total).toBe(5_000_000_000n);
    expect(short.ttlTier).toBeNull();
    expect(short.ttlMultiplier).toBe(1_000_000_000n);
  });

  it('bills a tier the card does not price at the published rate', () => {
    // No multipliers at all: even a 1h record is billed at the card's own rate.
    const bare = perMillion('input-write', 'write', 'cacheWrite', '5');
    expect(chargeComponent(bare, { ...emptyBuckets(), cacheWrite: 1_000_000 }, { cacheWriteTtl: '1h' }).total).toBe(
      5_000_000_000n,
    );
    // A card that prices 1h only: a 5m record keeps the base rate.
    const longOnly: RateComponent = { ...bare, ttlMultipliers: { '1h': '2' } };
    expect(chargeComponent(longOnly, { ...emptyBuckets(), cacheWrite: 1_000_000 }, { cacheWriteTtl: '5m' }).total).toBe(
      5_000_000_000n,
    );
  });

  it('scales both tranches of a cache write, and says so in the detail', () => {
    const cost = contextEngine.costOf(
      record({
        time: CONTEXT_AT.any,
        model: 'context-model',
        tokens: { ...emptyBuckets(), cacheWrite: 300_000 },
        cacheWriteTtl: '1h',
      }),
    );
    // 200k x (5 x 2) + 100k x (7 x 2), per million.
    expect(cost?.amounts.get('input-write')).toBe(3_400_000_000n);
    const charge = cost?.charges?.get('input-write');
    expect(charge?.ttlTier).toBe('1h');
    expect(charge?.ttlMultiplier).toBe(2_000_000_000n);
    expect(charge?.ttlTokens).toBe(300_000);
    expect(charge?.excessTokens).toBe(100_000);
    expect((charge?.base ?? 0n) + (charge?.excess ?? 0n)).toBe(charge?.total);
  });

  it('ignores a TTL on a component that bills no cache writes', () => {
    const input: RateComponent = { ...perMillion('input-miss', 'miss', 'input', '1'), ttlMultipliers: { '1h': '2' } };
    const charge = chargeComponent(input, { ...emptyBuckets(), input: 1_000_000 }, { cacheWriteTtl: '1h' });
    expect(charge.total).toBe(1_000_000_000n);
    expect(charge.ttlTier).toBeNull();
    expect(charge.ttlMultiplier).toBe(1_000_000_000n);
  });

  it('exposes no charge detail when no tier changed the money', () => {
    const cost = contextEngine.costOf(
      record({
        time: CONTEXT_AT.any,
        model: 'context-model',
        tokens: { ...emptyBuckets(), cacheWrite: 100_000 },
        cacheWriteTtl: '5m',
      }),
    );
    expect(cost?.charges).toBeUndefined();
  });
});
