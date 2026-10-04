/**
 * The dual-currency view: the display currency as the headline, the price list's
 * own currency beside it.
 *
 * Three things have to hold, and all three are pinned here with synthetic
 * vendors: the aggregates stay single-currency (a total that mixed ¥ and $ would
 * be a number nobody could check), the per-(table, currency) subtotals add up to
 * that total exactly, and a row keeps both readings of the *same* records — never
 * a second pricing pass against a list the run did not use.
 */

import { describe, expect, it } from 'vitest';

import { costOf, type OriginalPricing } from '../../src/report/accounting.ts';
import {
  createPricingEngine,
  createRoutingEngine,
  type PricePeriod,
  type PricingEngine,
  type PricingProvider,
} from '../../src/pricing/index.ts';
import { emptyBuckets } from '../../src/core/buckets.ts';
import { record } from '../support/dataset.ts';
import { perMillion } from '../support/stub-pricing.ts';

const AT = Date.parse('2026-03-01T00:00:00Z');
const BEFORE = Date.parse('2026-02-01T00:00:00Z');

/** A provider whose one model costs `input` per million of every bucket. */
function provider(id: string, label: string, model: string, periods: readonly PricePeriod[]): PricingProvider {
  const models = [{ model, aliases: [model], periods }];
  return {
    id,
    label,
    models: () => models,
    find: (wanted) => models.find((price) => price.aliases.includes(wanted.trim().toLowerCase())),
  };
}

/** A period in one currency, charging `rate` per million input tokens. */
function period(id: string, from: number, currency: string, rate: string, to: number | null = null): PricePeriod {
  return {
    id,
    label: `${currency} ${rate}`,
    from,
    to,
    offPeak: [perMillion('input-miss', 'miss', 'input', rate)],
    peak: null,
    peakWindows: [],
    utcOffset: 0,
    currency,
    source: 'test',
    note: 'test',
  };
}

/** The table each period belongs to, for the original channel's lookup. */
function tableOf(tables: readonly PricingProvider[]): (period: PricePeriod) => { id: string; label: string } | undefined {
  const owners = new Map<PricePeriod, { id: string; label: string }>();
  for (const table of tables) for (const price of table.models()) for (const entry of price.periods) owners.set(entry, { id: table.id, label: table.label });
  return (entry) => owners.get(entry);
}

/**
 * A two-vendor world displayed in USD.
 *
 * `alpha` publishes USD only; `beta` publishes CNY and USD — two lists for one
 * model, as DeepSeek does — and the run reads the CNY one, so beta's records are
 * the interesting ones: their original currency is CNY while the display is USD.
 */
function world(): {
  tables: [PricingProvider, PricingProvider];
  display: PricingEngine;
  original: OriginalPricing;
} {
  const alpha = provider('alpha', 'Alpha', 'alpha-1', [period('2026-01-01', BEFORE, 'USD', '10')]);
  const beta = provider('beta', 'Beta', 'beta-1', [
    period('2026-01-01', BEFORE, 'CNY', '7'),
    period('2026-01-01', BEFORE, 'USD', '1'),
  ]);
  const tables: [PricingProvider, PricingProvider] = [alpha, beta];
  // The display engine bills at the published rates times the run's rate; the
  // original engine is the very same tables, unconverted.
  const rate = '0.15';
  const scaledModels = beta.models().map((price) => ({
    ...price,
    periods: price.periods.map((entry) => ({
      ...entry,
      offPeak: entry.offPeak.map((component) => ({
        ...component,
        rate: String(Number(component.rate) * Number(rate)),
      })),
    })),
  }));
  const scaled: PricingProvider = {
    id: beta.id,
    label: beta.label,
    models: () => scaledModels,
    find: (wanted: string) => scaledModels.find((price) => price.aliases.includes(wanted.trim().toLowerCase())),
  };
  return {
    tables,
    // Both views route over the same tables; only beta's list is converted.
    display: createRoutingEngine(tables, {
      engineFor: (table) => createPricingEngine(table === beta ? scaled : table),
    }),
    original: {
      engine: createRoutingEngine(tables, { engineFor: (table) => createPricingEngine(table) }),
      tableOf: tableOf(tables),
      currency: 'USD',
      rates: new Map([['beta\u0000CNY', rate]]),
    },
  };
}

/** One record of `model` with `input` prompt tokens. */
function usage(model: string, input: number, time: number = AT) {
  return record({ time, model, tokens: { ...emptyBuckets(), input } });
}

describe('the per-price-list view', () => {
  it('leaves the display aggregates exactly as they were', () => {
    const { display, original } = world();
    const records = [usage('alpha-1', 1_000_000), usage('beta-1', 1_000_000)];
    const withOriginal = costOf(records, display, 1, original);
    const without = costOf(records, display);
    // A second view is a view: the money the report totals has one value.
    expect(withOriginal.totals).toEqual(without.totals);
    expect(withOriginal.totals.total).toBe('11.0500');
    expect(without.subtotals).toEqual([]);
  });

  it('groups by (table, currency) and converts each subtotal once', () => {
    const { display, original } = world();
    const cost = costOf([usage('alpha-1', 1_000_000), usage('beta-1', 1_000_000)], display, 1, original);
    expect(cost.subtotals.map((row) => [row.table, row.currency, row.original, row.display])).toEqual([
      ['alpha', 'USD', '10.0000', '10.0000'],
      ['beta', 'CNY', '7.0000', '1.0500'],
    ]);
    const summed = cost.subtotals.reduce((sum, row) => sum + Number(row.money.display.amount), 0);
    expect(summed.toFixed(4)).toBe(cost.totals.total);
    // Each row says the same money twice, in the two currencies.
    for (const row of cost.subtotals) {
      expect(row.money.original.amount).toBe(row.original);
      expect(row.money.display.amount).toBe(row.display);
    }
  });

  it('splits one table across the currencies its own lists are quoted in', () => {
    // The same vendor's model priced from a CNY list first and a USD list later:
    // grouping by table alone would add ¥ to $ and call it a subtotal.
    const beta = provider('beta', 'Beta', 'beta-1', [
      period('2026-01-01', BEFORE, 'CNY', '7', AT),
      period('2026-02-01', AT, 'USD', '1'),
    ]);
    const original: OriginalPricing = {
      engine: createPricingEngine(beta),
      tableOf: tableOf([beta]),
      // Displayed in CNY too, so nothing converts and the two columns agree —
      // this test is about the grouping, not the rate.
      currency: 'CNY',
    };
    const cost = costOf(
      [usage('beta-1', 1_000_000, BEFORE), usage('beta-1', 1_000_000, AT)],
      createPricingEngine(beta),
      1,
      original,
    );
    expect(cost.subtotals.map((row) => [row.currency, row.original, row.display])).toEqual([
      ['CNY', '7.0000', '7.0000'],
      ['USD', '1.0000', '1.0000'],
    ]);
  });

  it('keeps both readings of a band, and the band in both currencies', () => {
    const { display, original } = world();
    const cost = costOf([usage('beta-1', 1_000_000)], display, 1, original);
    const band = cost.breakdown[0];
    expect(band?.money).toEqual({
      original: { currency: 'CNY', amount: '7.0000' },
      display: { currency: 'USD', amount: '1.0500' },
    });
    expect(band?.original?.amounts['input-miss']).toBe('7.0000');
    expect(band?.total).toBe('1.0500');
  });

  it('carries the reading the report does not print beside the one it does', () => {
    const { display, original } = world();
    const cost = costOf([usage('beta-1', 1_000_000)], display, 1, original);
    const row = cost.subtotals[0];
    // The displayed figure is the sum of the same rounded bands the total is.
    expect(row?.display).toBe('1.0500');
    // The published sum converts once to the same number here, and the per-record
    // reading is carried even when it agrees: nothing is hidden behind rounding.
    expect(row?.converted).toBe('1.0500');
    expect(row?.perRecord).toBe('1.0500');
  });

  it('sums the subtotal block when the pricing is grouped per session', () => {
    // The report prices one session at a time and adds the rounded results, so
    // the block has to be built the same way or it would not reconcile.
    const { display, original } = world();
    const sets = [[usage('alpha-1', 333_333)], [usage('beta-1', 666_666)]];
    const summaries = sets.map((records) => costOf(records, display, 1, original));
    const merged = summaries.reduce((total, summary) => {
      const subtotals = [...(total?.subtotals ?? []), ...summary.subtotals];
      return { subtotals };
    }, undefined as { subtotals: typeof summaries[number]['subtotals'] } | undefined);
    expect(merged?.subtotals.map((row) => row.table)).toEqual(['alpha', 'beta']);
  });
});
