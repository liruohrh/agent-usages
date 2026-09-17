/**
 * A synthetic pricing provider.
 *
 * The point of these tests is that the engine is *vendor-neutral*: this provider
 * uses a different currency, a different peak timezone, an every-day window, and
 * bills cache writes as their own component. If the engine only worked for one
 * vendor's shape, it would fail here.
 */

import type { PricingProvider, RateComponent } from '../../src/pricing/index.ts';

/** A made-up currency, so a mistake cannot be misread as a real price. */
export const TEST_CURRENCY = { code: 'XTS', symbol: '¤' };

/** A per-million rate component. */
export function perMillion(id: string, label: string, basis: RateComponent['basis'], rate: string): RateComponent {
  return { id, label, basis, rate, per: 1_000_000 };
}

/** Period boundaries used by the stub, as UTC instants. */
export const STUB_AT = {
  /** Just inside the first tiered period. */
  early: Date.parse('2026-03-01T00:00:00Z'),
  /** 2026-03-01 09:00:00 UTC — inside the peak window. */
  earlyPeak: Date.parse('2026-03-01T09:00:00Z'),
  /** 2026-03-01 08:59:59 UTC — one second before the peak window. */
  earlyOffPeak: Date.parse('2026-03-01T08:59:59Z'),
  /** 2026-03-01 12:00:00 UTC — the peak window has closed. */
  earlyJustAfterPeak: Date.parse('2026-03-01T12:00:00Z'),
  /** 2026-03-01 09:00:00 UTC on a Sunday: the stub's window covers every day. */
  earlyPeakSunday: Date.parse('2026-03-01T09:00:00Z'),
  /** Inside the second tiered period. */
  late: Date.parse('2026-07-01T00:00:00Z'),
  /** Before any period. */
  beforeAll: Date.parse('2025-06-01T00:00:00Z'),
} as const;

/** A provider covering a flat model, a tiered model, and an unknown model. */
export function stubProvider(): PricingProvider {
  const models = [
    {
      model: 'flat-model',
      aliases: ['flat-model', 'flat-alias'],
      periods: [
        {
          id: '2026-01-01',
          label: 'flat period',
          from: Date.parse('2026-01-01T00:00:00Z'),
          to: null,
          offPeak: [
            perMillion('input-hit', 'hit', 'cacheRead', '1'),
            perMillion('input-miss', 'miss', 'input', '10'),
            perMillion('output', 'out', 'output', '20'),
            perMillion('input-write', 'write', 'cacheWrite', '5'),
          ],
          peak: null,
          peakWindows: [],
          timezone: 'UTC',
          source: 'test',
          note: 'flat',
        },
      ],
    },
    {
      model: 'tiered-model',
      aliases: ['tiered-model'],
      periods: [
        {
          id: '2026-01-01',
          label: 'tiered, early',
          from: Date.parse('2026-01-01T00:00:00Z'),
          to: Date.parse('2026-06-01T00:00:00Z'),
          offPeak: [perMillion('input-miss', 'miss', 'input', '1'), perMillion('output', 'out', 'output', '2')],
          peak: [perMillion('input-miss', 'miss', 'input', '2'), perMillion('output', 'out', 'output', '4')],
          peakWindows: [{ fromHour: 9, toHour: 12, weekdays: null }],
          timezone: 'UTC',
          source: 'test',
          note: 'tiered early',
        },
        {
          id: '2026-06-01',
          label: 'tiered, late',
          from: Date.parse('2026-06-01T00:00:00Z'),
          to: null,
          offPeak: [perMillion('input-miss', 'miss', 'input', '3'), perMillion('output', 'out', 'output', '6')],
          peak: null,
          peakWindows: [],
          timezone: 'UTC',
          source: 'test',
          note: 'tiered late, flat',
        },
      ],
    },
  ] as const;

  return {
    id: 'stub',
    label: 'Stub Vendor',
    currency: TEST_CURRENCY,
    defaultModel: 'flat-model',
    models: () => models,
    find: (model) => {
      const wanted = model.trim().toLowerCase();
      return models.find((price) => price.aliases.some((alias) => alias.toLowerCase() === wanted));
    },
  };
}
