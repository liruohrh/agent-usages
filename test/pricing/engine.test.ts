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
import type {
  InputTier,
  ModelPrice,
  PeakWindow,
  PricingProvider,
  RateComponent,
} from '../../src/pricing/index.ts';
import {
  CONTEXT_AT,
  CONTEXT_THRESHOLD,
  STUB_AT,
  contextProvider,
  perMillion,
  stubProvider,
  TEST_CURRENCY,
} from '../support/stub-pricing.ts';
import { buckets, record } from '../support/dataset.ts';

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

  it('leaves a model with no schedule unpriced, with no borrowed rate', () => {
    // There is no fallback: borrowing another model's price is a guess, and a
    // guess is worse than an unpriced record (which the report counts and names).
    expect(engine.resolve(record({ time: STUB_AT.early, model: 'unknown-model' }))).toBeUndefined();
    expect(engine.costOf(record({ time: STUB_AT.early, model: 'unknown-model' }))).toBeUndefined();
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

/** The instant the size-tier stubs' one period covers. */
const SIZE_AT = Date.parse('2026-03-01T00:00:00Z');

/** A flat card quoted per million tokens: miss, cache hit, output. */
function card(miss: string, hit: string, output: string): RateComponent[] {
  return [
    perMillion('input-miss', 'miss', 'input', miss),
    perMillion('input-hit', 'hit', 'cacheRead', hit),
    perMillion('output', 'out', 'output', output),
  ];
}

/**
 * A provider whose one model reprices the whole request by its own size.
 *
 * The bounds copy the two published shapes: OpenAI's `≤272K` / `>272K` (the low
 * band ends at the vendor's own 272,000, so exactly 272,000 stays cheap) and
 * Zhipu's `<32K` / `≥32K` (the low band ends at 31,999, because the page puts
 * exactly 32,000 in the high band).
 * @param tiers - the size bands, in file order.
 * @param windows - peak windows, when the tiers also carry peak cards.
 */
function sizeProvider(tiers: readonly InputTier[], windows: readonly PeakWindow[] = []): PricingProvider {
  const models: ModelPrice[] = [
    {
      model: 'size-model',
      aliases: ['size-model'],
      periods: [
        {
          id: '2026-01-01',
          label: 'size tiers',
          from: Date.parse('2026-01-01T00:00:00Z'),
          to: null,
          offPeak: [],
          peak: windows.length === 0 ? null : (tiers[0]?.peak ?? null),
          peakWindows: windows,
          inputTiers: tiers,
          utcOffset: 0,
          currency: TEST_CURRENCY.code,
          source: 'test',
          note: 'size tiers',
        },
      ],
    },
  ];
  return {
    id: 'stub-size',
    label: 'Stub Size Vendor',
    models: () => models,
    find: (model) => models.find((price) => price.aliases.includes(model.trim().toLowerCase())),
  };
}

/** OpenAI's shape: 1/2/4 below the bound, 10/20/40 above it. */
const SIZE_TIERS: readonly InputTier[] = [
  { label: '输入 ≤272K', upTo: 272_000, offPeak: card('1', '2', '4'), peak: null },
  { label: '输入 >272K', upTo: null, offPeak: card('10', '20', '40'), peak: null },
];

/** Zhipu's shape: the low band ends at 31,999 because `≥32K` starts the high one. */
const ZHIPU_TIERS: readonly InputTier[] = [
  { label: '输入 <32K', upTo: 31_999, offPeak: card('1', '2', '4'), peak: null },
  { label: '输入 ≥32K', upTo: null, offPeak: card('10', '20', '40'), peak: null },
];

/** GLM-4.7's three rows: two share the input bound and split on output length. */
const THREE_TIERS: readonly InputTier[] = [
  { label: '输入 <32K、输出 <0.2K', upTo: 31_999, outputUpTo: 199, offPeak: card('2', '0.4', '8'), peak: null },
  { label: '输入 <32K、输出 ≥0.2K', upTo: 31_999, offPeak: card('3', '0.6', '14'), peak: null },
  { label: '输入 ≥32K', upTo: null, offPeak: card('4', '0.8', '16'), peak: null },
];

describe('whole-request size tiers', () => {
  const size = createPricingEngine(sizeProvider(SIZE_TIERS));

  it('bills the whole request at the band it falls into, not just the excess', () => {
    // 300K input is a 300K bill at 10 ($3), not 272K at 1 plus 28K at 10 ($0.552).
    const cost = size.costOf(record({ time: SIZE_AT, model: 'size-model', tokens: buckets({ input: 300_000 }) }));
    expect(cost?.amounts.get('input-miss')).toBe(3_000_000_000n);
    // The graduated card that looks similar charges the same threshold quite
    // differently, which is why `aboveThreshold` could not express this rule.
    const graduated = chargeComponent(
      { ...perMillion('input-miss', 'miss', 'input', '1'), aboveThreshold: { tokens: 272_000, rate: '10' } },
      buckets({ input: 300_000 }),
    );
    expect(graduated.total).toBe(552_000_000n);
  });

  it('keeps a request below the bound on the low card', () => {
    const cost = size.costOf(record({ time: SIZE_AT, model: 'size-model', tokens: buckets({ input: 100_000 }) }));
    expect(cost?.amounts.get('input-miss')).toBe(100_000_000n);
  });

  it('puts exactly the bound in the low band, since the vendor wrote `>272K`', () => {
    const at = size.resolve(record({ time: SIZE_AT, model: 'size-model', tokens: buckets({ input: 272_000 }) }));
    const above = size.resolve(record({ time: SIZE_AT, model: 'size-model', tokens: buckets({ input: 272_001 }) }));
    expect(at?.inputTier?.index).toBe(0);
    expect(above?.inputTier?.index).toBe(1);
    // One token over the line reprices the whole request.
    expect(above?.components[0]?.rate).toBe('10');
  });

  it('puts exactly 32K in the high band, since the vendor wrote `≥32K`', () => {
    const zhipu = createPricingEngine(sizeProvider(ZHIPU_TIERS));
    const below = zhipu.resolve(record({ time: SIZE_AT, model: 'size-model', tokens: buckets({ input: 31_999 }) }));
    const at = zhipu.resolve(record({ time: SIZE_AT, model: 'size-model', tokens: buckets({ input: 32_000 }) }));
    expect(below?.inputTier?.index).toBe(0);
    expect(at?.inputTier?.index).toBe(1);
  });

  it('reports which band the record hit, and leaves it off untiered periods', () => {
    const hit = size.resolve(record({ time: SIZE_AT, model: 'size-model', tokens: buckets({ input: 300_000 }) }));
    expect(hit?.inputTier).toEqual({ index: 1, label: '输入 >272K', upTo: null, outputUpTo: null });
    // Absent, not `index: 0`: "no size bands here" must stay tellable apart from
    // "this request landed in the first band".
    expect(engine.resolve(record({ time: STUB_AT.early, model: 'flat-model' }))?.inputTier).toBeUndefined();
  });

  it('does not count cache reads towards the band', () => {
    // The band is chosen by the cache-miss input alone, so a mostly-cached 500K
    // prompt stays on the low card — the reading each note publishes.
    const mostlyCached = buckets({ input: 1_000, cacheRead: 500_000 });
    expect(size.resolve(record({ time: SIZE_AT, model: 'size-model', tokens: mostlyCached }))?.inputTier?.index).toBe(0);
  });

  it('picks the middle band of a three-band table by output length', () => {
    const three = createPricingEngine(sizeProvider(THREE_TIERS));
    const short = three.costOf(record({ time: SIZE_AT, model: 'size-model', tokens: buckets({ input: 10_000, output: 199 }) }));
    const longer = three.costOf(record({ time: SIZE_AT, model: 'size-model', tokens: buckets({ input: 10_000, output: 200 }) }));
    const wide = three.costOf(record({ time: SIZE_AT, model: 'size-model', tokens: buckets({ input: 32_000, output: 200 }) }));
    expect(short?.amounts.get('input-miss')).toBe(20_000_000n);
    expect(longer?.amounts.get('input-miss')).toBe(30_000_000n);
    // A 32K input takes the third band whatever the completion looks like.
    expect(wide?.amounts.get('input-miss')).toBe(128_000_000n);
  });

  it('applies the peak card of the band that matched', () => {
    // Peak pricing and size bands are independent: the clock picks a line inside
    // the card the size picked, which is the order the resolution reports.
    const windows = [{ fromHour: 9, toHour: 12, weekdays: null }];
    const tiered: readonly InputTier[] = [
      { label: '输入 ≤200K', upTo: 200_000, offPeak: card('1', '2', '4'), peak: card('2', '4', '8') },
      { label: '输入 >200K', upTo: null, offPeak: card('10', '20', '40'), peak: card('20', '40', '80') },
    ];
    const both = createPricingEngine(sizeProvider(tiered, windows));
    const resolved = both.resolve(record({ time: STUB_AT.earlyPeak, model: 'size-model', tokens: buckets({ input: 300_000 }) }));
    expect(resolved?.tier).toBe('peak');
    expect(resolved?.reason).toBe('peak-window');
    expect(resolved?.inputTier?.index).toBe(1);
    expect(resolved?.components[0]?.rate).toBe('20');
  });

  it('refuses to price a size the last band does not cover', () => {
    // Parsed price lists always end open, so this only reaches a hand-built
    // provider — and an unpriced record beats a silently zero-cost one.
    const bounded = createPricingEngine(sizeProvider([{ label: 'only', upTo: 1_000, offPeak: card('1', '2', '4'), peak: null }]));
    expect(bounded.resolve(record({ time: SIZE_AT, model: 'size-model', tokens: buckets({ input: 2_000 }) }))).toBeUndefined();
    expect(bounded.resolve(record({ time: SIZE_AT, model: 'size-model', tokens: buckets({ input: 1_000 }) }))?.inputTier?.index).toBe(0);
  });

  it('describes the bands, so a reader sees which ones exist', () => {
    const period = size.provider.models()[0]?.periods[0];
    expect(period).toBeDefined();
    expect(size.describeTiers(period!)).toBe('输入 ≤272K、输入 >272K');
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

describe('mixed cache-write TTL tiers', () => {
  /**
   * An anthropic-shaped write card: 6.25 per million for the default (5m) tier,
   * ×1.6 (the published 2 ÷ 1.25) for a one-hour write.
   */
  const write = (overrides: Partial<RateComponent> = {}): RateComponent => ({
    ...perMillion('input-write', 'write', 'cacheWrite', '6.25'),
    ttlMultipliers: { '1h': '1.6' },
    ...overrides,
  });

  it('charges each tier at its own price instead of the highest one', () => {
    // A request that wrote one million tokens into each tier: 1M × 6.25 for the
    // 5m write plus 1M × (6.25 × 1.6) for the 1h one.
    const charge = chargeComponent(
      write(),
      { ...emptyBuckets(), cacheWrite: 2_000_000 },
      { cacheWriteTtl: '1h', cacheWriteTiers: { '5m': 1_000_000, '1h': 1_000_000 } },
    );
    expect(charge.total).toBe(16_250_000_000n);
    expect(charge.baseTokens).toBe(2_000_000);
    expect(charge.excessTokens).toBe(0);
    // The report still labels the charge with the tier most of the write used.
    expect(charge.ttlTier).toBe('1h');
    expect(charge.ttlTokens).toBe(2_000_000);
    expect(charge.ttlMultiplier).toBe(1_600_000_000n);
  });

  it('bills the tokens no tier names at the reported tier, dropping none', () => {
    // 200k at 5m, 800k at 1h, and 200k the log left unattributed, billed at 1h:
    // 1.25 + 8 + 2 USD. Every token of the record is charged exactly once.
    const charge = chargeComponent(
      write(),
      { ...emptyBuckets(), cacheWrite: 1_200_000 },
      { cacheWriteTtl: '1h', cacheWriteTiers: { '5m': 200_000, '1h': 800_000 } },
    );
    expect(charge.total).toBe(11_250_000_000n);
    expect(charge.baseTokens + charge.excessTokens).toBe(1_200_000);
  });

  it('never charges more writes than the record billed', () => {
    // A log that over-attributes both tiers: the surplus is dropped, not billed.
    const charge = chargeComponent(
      write(),
      { ...emptyBuckets(), cacheWrite: 1_000_000 },
      { cacheWriteTtl: '1h', cacheWriteTiers: { '5m': 800_000, '1h': 800_000 } },
    );
    // 800k × 6.25 for the 5m tranche, then the 200k left over at the 1h rate.
    expect(charge.total).toBe(7_000_000_000n);
    expect(charge.baseTokens + charge.excessTokens).toBe(1_000_000);
  });

  it('crosses the long-context threshold once, not once per tier', () => {
    const card = write({ aboveThreshold: { tokens: 1_000_000, rate: '12.5' } });
    const charge = chargeComponent(
      card,
      { ...emptyBuckets(), cacheWrite: 1_500_000 },
      { cacheWriteTtl: '1h', cacheWriteTiers: { '5m': 500_000, '1h': 1_000_000 } },
    );
    // 500k × 6.25 + 500k × 10 + 500k × (12.5 × 1.6).
    expect(charge.total).toBe(18_125_000_000n);
    expect(charge.baseTokens).toBe(1_000_000);
    expect(charge.excessTokens).toBe(500_000);
    expect(charge.excessRate).toBe(20_000_000_000n);
    expect(charge.base + charge.excess).toBe(charge.total);
  });

  it('reports no single excess rate when two tiers bill the excess', () => {
    const card = write({ aboveThreshold: { tokens: 200_000, rate: '12.5' } });
    const charge = chargeComponent(
      card,
      { ...emptyBuckets(), cacheWrite: 1_500_000 },
      { cacheWriteTtl: '1h', cacheWriteTiers: { '5m': 500_000, '1h': 1_000_000 } },
    );
    // 200k × 6.25 + 300k × 12.5 + 1M × (12.5 × 1.6) = 1.25 + 3.75 + 20 USD.
    expect(charge.total).toBe(25_000_000_000n);
    expect(charge.baseTokens).toBe(200_000);
    expect(charge.excessTokens).toBe(1_300_000);
    expect(charge.excessRate).toBeNull();
    expect(charge.base + charge.excess).toBe(charge.total);
  });

  it('leaves a one-tier split exactly where the untiered charge was', () => {
    const tokens = { ...emptyBuckets(), cacheWrite: 1_000_000 };
    const plain = chargeComponent(write(), tokens, { cacheWriteTtl: '1h' });
    const single = chargeComponent(write(), tokens, { cacheWriteTtl: '1h', cacheWriteTiers: { '1h': 1_000_000 } });
    const empty = chargeComponent(write(), tokens, { cacheWriteTtl: '1h', cacheWriteTiers: {} });
    for (const charge of [single, empty]) {
      expect(charge.total).toBe(plain.total);
      expect(charge.baseTokens).toBe(plain.baseTokens);
      expect(charge.excessTokens).toBe(plain.excessTokens);
      expect(charge.ttlTier).toBe(plain.ttlTier);
      expect(charge.ttlTokens).toBe(plain.ttlTokens);
    }
  });

  it('carries a record’s split through costOf, and charges less than one tier would', () => {
    const tokens = { ...emptyBuckets(), cacheWrite: 300_000 };
    const split = contextEngine.costOf(
      record({
        time: CONTEXT_AT.any,
        model: 'context-model',
        tokens,
        cacheWriteTtl: '1h',
        cacheWriteTiers: { '5m': 100_000, '1h': 200_000 },
      }),
    );
    const oneTier = contextEngine.costOf(
      record({ time: CONTEXT_AT.any, model: 'context-model', tokens, cacheWriteTtl: '1h' }),
    );
    // 100k × 5 + 100k × 10 + 100k × 14, against 200k × 10 + 100k × 14 unsplit.
    expect(split?.amounts.get('input-write')).toBe(2_900_000_000n);
    expect(oneTier?.amounts.get('input-write')).toBe(3_400_000_000n);
    const charge = split?.charges?.get('input-write');
    expect(charge?.baseTokens).toBe(200_000);
    expect(charge?.excessTokens).toBe(100_000);
    expect(charge?.ttlTier).toBe('1h');
    expect(charge?.excessRate).toBe(14_000_000_000n);
  });
});
