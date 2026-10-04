/**
 * Routing: which price table a record is priced with.
 *
 * A record names the model that served it, and that — not the agent that wrote the
 * log — is what decides the vendor. The cases below pin the whole contract: the
 * first table in configuration order that knows the model wins, an unknown model
 * stays unpriced instead of borrowing a rate, and `--provider` pins one table for
 * the whole run.
 */

import { describe, expect, it } from 'vitest';

import { createPricingEngine } from '../../src/pricing/engine.ts';
import type { PricePeriod, PricingProvider } from '../../src/pricing/index.ts';
import type { UsageRecord } from '../../src/core/types.ts';
import { createRoutingEngine, isRoutingEngine } from '../../src/pricing/registry.ts';
import { record } from '../support/dataset.ts';

/** One flat period, so two tables are told apart by their output rate. */
function period(id: string, rate: string, label: string): PricePeriod {
  return {
    id,
    label,
    from: Date.parse('2026-01-01T00:00:00Z'),
    to: null,
    utcOffset: 0,
    currency: 'USD',
    offPeak: [{ id: 'output', label: 'output', basis: 'output', rate, per: 1_000_000 }],
    peak: null,
    peakWindows: [],
    source: `https://example.invalid/${id}`,
    note: id,
  };
}

/** A table with one model per name, priced at `rate` per million output tokens. */
function table(id: string, label: string, models: string[], rate: string): PricingProvider {
  const prices = models.map((model, index) => ({
    model,
    aliases: [model, `${id}/${model}`],
    periods: [period(`${id}-${index}`, rate, `${label} ${model}`)],
  }));
  return {
    id,
    label,
    models: () => prices,
    find: (model: string) => {
      const wanted = model.trim().toLowerCase();
      return prices.find((price) => price.aliases.some((alias) => alias.toLowerCase() === wanted));
    },
  };
}

/** Table A knows alpha, table B knows beta, and both know shared. */
const TABLE_A = table('alpha-vendor', 'Alpha Vendor', ['alpha-model', 'shared-model'], '10');
const TABLE_B = table('beta-vendor', 'Beta Vendor', ['beta-model', 'shared-model'], '20');

/** A record for one model, one million output tokens. */
function at(model: string): UsageRecord {
  return record({
    time: Date.parse('2026-03-01T00:00:00Z'),
    model,
    tokens: { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  });
}

describe('createRoutingEngine', () => {
  it('prices each model with the table that knows it', () => {
    const engine = createRoutingEngine([TABLE_A, TABLE_B]);
    expect(engine.resolve(at('alpha-model'))?.period.source).toBe('https://example.invalid/alpha-vendor-0');
    expect(engine.resolve(at('beta-model'))?.period.source).toBe('https://example.invalid/beta-vendor-0');
    // One million output tokens at each table's own rate.
    expect(engine.costOf(at('alpha-model'))?.total).toBe(10_000_000_000n);
    expect(engine.costOf(at('beta-model'))?.total).toBe(20_000_000_000n);
  });

  it('takes the first table in configuration order when two know a model', () => {
    // Configuration order is the priority, so which table wins is data, not code.
    const forward = createRoutingEngine([TABLE_A, TABLE_B]);
    const backward = createRoutingEngine([TABLE_B, TABLE_A]);
    expect(forward.costOf(at('shared-model'))?.total).toBe(10_000_000_000n);
    expect(backward.costOf(at('shared-model'))?.total).toBe(20_000_000_000n);
  });

  it('leaves a model no table knows unpriced instead of borrowing a rate', () => {
    const engine = createRoutingEngine([TABLE_A, TABLE_B]);
    expect(engine.resolve(at('nobody-knows-this'))).toBeUndefined();
    expect(engine.costOf(at('nobody-knows-this'))).toBeUndefined();
  });

  it('resolves the aliases and qualified labels its tables publish', () => {
    const engine = createRoutingEngine([TABLE_A, TABLE_B]);
    expect(engine.resolve(at('beta-vendor/beta-model'))?.model).toBe('beta-model');
    expect(engine.resolve(at('  SHARED-MODEL '))?.model).toBe('shared-model');
  });

  it('reports the tables it drew on, in configuration order', () => {
    const engine = createRoutingEngine([TABLE_A, TABLE_B]);
    expect(isRoutingEngine(engine)).toBe(true);
    expect(engine.tables().map((entry) => entry.id)).toEqual(['alpha-vendor', 'beta-vendor']);
    expect(engine.tablesUsed()).toEqual([]);
    engine.costOf(at('beta-model'));
    engine.costOf(at('alpha-model'));
    engine.costOf(at('nobody-knows-this'));
    expect(engine.tablesUsed().map((entry) => entry.id)).toEqual(['alpha-vendor', 'beta-vendor']);
  });

  it("delegates a period's prose to the table that published it", () => {
    const engine = createRoutingEngine([TABLE_A, TABLE_B]);
    const alpha = TABLE_A.find('alpha-model')!.periods[0]!;
    const beta = TABLE_B.find('beta-model')!.periods[0]!;
    expect(engine.describeWindow(alpha)).toBe(createPricingEngine(TABLE_A).describeWindow(alpha));
    expect(engine.describeWindow(beta)).toBe(createPricingEngine(TABLE_B).describeWindow(beta));
    expect(engine.describeTiers(beta)).toBe(createPricingEngine(TABLE_B).describeTiers(beta));
    expect(engine.quantityOf(beta.offPeak[0]!, { input: 0, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 })).toBe(5);
    expect(engine.describeBasis('output')).toBe(createPricingEngine(TABLE_A).describeBasis('output'));
  });
});

describe('a pinned table', () => {
  it('prices every record with it, whatever the model names', () => {
    const engine = createRoutingEngine([TABLE_A, TABLE_B], { pinned: TABLE_B });
    expect(engine.pinned).toBe(true);
    expect(engine.provider.id).toBe('beta-vendor');
    // Alpha's model is unknown to the pinned table, and stays unpriced: there is no
    // fallback to another model's rate.
    expect(engine.costOf(at('alpha-model'))).toBeUndefined();
    expect(engine.costOf(at('beta-model'))?.total).toBe(20_000_000_000n);
    expect(engine.tablesUsed().map((entry) => entry.id)).toEqual(['beta-vendor']);
  });

  it('names the pinned table even when nothing was priced', () => {
    const engine = createRoutingEngine([TABLE_A, TABLE_B], { pinned: TABLE_B });
    expect(engine.costOf(at('alpha-model'))).toBeUndefined();
    expect(engine.tablesUsed().map((entry) => entry.id)).toEqual(['beta-vendor']);
  });

  it('keeps a routed engine distinguishable from a single-table one', () => {
    const plain = createPricingEngine(TABLE_A);
    expect(isRoutingEngine(plain)).toBe(false);
    expect(isRoutingEngine(createRoutingEngine([TABLE_A]))).toBe(true);
  });
});
