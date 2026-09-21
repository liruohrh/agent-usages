/**
 * Vendor-neutral pricing engine tests.
 *
 * Everything here runs against the synthetic provider, so a pass means the
 * engine's period selection, tiering, and component arithmetic work for *any*
 * vendor — not just the one this build happens to ship.
 */

import { describe, expect, it } from 'vitest';

import { emptyBuckets } from '../../src/core/buckets.ts';
import { bareModelName, createPricingEngine, isPeak, zoneTime } from '../../src/pricing/index.ts';
import { STUB_AT, perMillion, stubProvider, TEST_CURRENCY } from '../support/stub-pricing.ts';
import { record } from '../support/dataset.ts';

const engine = createPricingEngine(stubProvider());

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
    for (const period of periods) expect(period.currency).toEqual(TEST_CURRENCY);
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
              timezone: 'UTC',
              currency: TEST_CURRENCY,
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
    expect(isPeak(STUB_AT.earlyOffPeak, [{ fromHour: 9, toHour: 12, weekdays: null }], 'UTC')).toBe(false);
    expect(isPeak(STUB_AT.earlyPeak, [{ fromHour: 9, toHour: 12, weekdays: null }], 'UTC')).toBe(true);
    expect(isPeak(STUB_AT.earlyJustAfterPeak, [{ fromHour: 9, toHour: 12, weekdays: null }], 'UTC')).toBe(false);
  });

  it('honours a null weekday list as every day', () => {
    // 2026-03-01 is a Sunday.
    expect(zoneTime(STUB_AT.earlyPeakSunday, 'UTC').weekday).toBe(0);
    expect(isPeak(STUB_AT.earlyPeakSunday, [{ fromHour: 9, toHour: 12, weekdays: null }], 'UTC')).toBe(true);
  });

  it('restricts a window to listed weekdays', () => {
    const weekdaysOnly = [{ fromHour: 9, toHour: 12, weekdays: [1, 2, 3, 4, 5] }];
    expect(isPeak(STUB_AT.earlyPeakSunday, weekdaysOnly, 'UTC')).toBe(false);
    expect(isPeak(Date.parse('2026-03-02T09:00:00Z'), weekdaysOnly, 'UTC')).toBe(true);
  });

  it('resolves the tier inside the period and reports it', () => {
    expect(engine.resolve(record({ time: STUB_AT.earlyPeak, model: 'tiered-model' }))?.tier).toBe('peak');
    expect(engine.resolve(record({ time: STUB_AT.earlyOffPeak, model: 'tiered-model' }))?.tier).toBe('off-peak');
    expect(engine.resolve(record({ time: STUB_AT.late, model: 'tiered-model' }))?.tier).toBe('flat');
    expect(engine.resolve(record({ time: STUB_AT.early, model: 'flat-model' }))?.tier).toBe('flat');
  });

  it('evaluates windows in the period timezone, not the machine zone', () => {
    // The stub's window is UTC; 09:00 UTC is not 09:00 in Shanghai.
    expect(isPeak(STUB_AT.earlyPeak, [{ fromHour: 9, toHour: 12, weekdays: null }], 'UTC')).toBe(true);
    expect(isPeak(STUB_AT.earlyPeak, [{ fromHour: 9, toHour: 12, weekdays: null }], 'Asia/Shanghai')).toBe(false);
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
  it('describes windows in the period timezone', () => {
    const period = engine.provider.models()[0]?.periods[0];
    expect(period).toBeDefined();
    expect(engine.describeWindow(period!)).toContain('(UTC)');
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
