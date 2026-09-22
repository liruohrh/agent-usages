/**
 * Money-breakdown tests.
 *
 * The report prints one amount per token figure, so the arithmetic that splits a
 * bill has to be defensible: the three prompt buckets are billed one by one, the
 * completion is split between `O` and `R`, and the aggregates are sums — never a
 * second bill. Every one of those is pinned here, because a line that does not
 * add up is worse than a line with fewer numbers on it.
 */

import { describe, expect, it } from 'vitest';

import { costOf, moneyBreakdown } from '../../src/accounting.ts';
import type { CostTotals, TokenBuckets, UsageRecord } from '../../src/core/types.ts';
import { createPricingEngine } from '../../src/pricing/index.ts';
import { record } from '../support/dataset.ts';
import { CONTEXT_AT, STUB_AT, contextProvider, stubProvider } from '../support/stub-pricing.ts';

/** A cost total with only what a test sets. */
function cost(overrides: Partial<CostTotals> = {}): CostTotals {
  return {
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheHitInputCost: '0.0000',
    cacheMissInputCost: '0.0000',
    outputCost: '0.0000',
    cacheWriteInputCost: '0.0000',
    reasoningCost: '0.0000',
    total: '0.0000',
    ...overrides,
  };
}

/** Scaled 1e-4 units, so a test can add amounts without floating point. */
function units(amount: string): number {
  return Math.round(Number(amount) * 10_000);
}

const TOKENS: TokenBuckets = { input: 556, cacheRead: 241_809_280, cacheWrite: 0, output: 621_549, reasoning: 58_000 };

describe('moneyBreakdown', () => {
  it('bills the prompt buckets one by one and totals them', () => {
    const money = moneyBreakdown(
      cost({ cacheMissInputCost: '0.6094', cacheHitInputCost: '5.3886', outputCost: '2.5373', total: '8.5353' }),
      TOKENS,
    );
    expect(money.inputMiss).toBe('0.6094');
    expect(money.inputHit).toBe('5.3886');
    expect(money.inputWrite).toBe('0.0000');
    expect(units(money.inputTotal)).toBe(units(money.inputMiss) + units(money.inputHit) + units(money.inputWrite));
    expect(money.inputTotal).toBe('5.9980');
  });

  it('takes the reasoning slice out of the completion bill, never beside it', () => {
    const money = moneyBreakdown(
      cost({ outputCost: '2.5373', reasoningCost: '0.2374', total: '2.5373' }),
      TOKENS,
    );
    expect(money.outputTotal).toBe('2.5373');
    expect(money.reasoning).toBe('0.2374');
    expect(money.outputOnly).toBe('2.2999');
    expect(units(money.outputOnly) + units(money.reasoning)).toBe(units(money.outputTotal));
  });

  it('makes the whole line add up: I/T + O/T is the total', () => {
    const money = moneyBreakdown(
      cost({ cacheMissInputCost: '0.6094', cacheHitInputCost: '5.3886', outputCost: '2.5373', total: '8.5353' }),
      TOKENS,
    );
    expect(units(money.inputTotal) + units(money.outputTotal)).toBe(units(money.total));
    expect(money.total).toBe('8.5353');
  });

  it('keeps a cache write on its own line instead of hiding it in I/T', () => {
    const money = moneyBreakdown(
      cost({ cacheMissInputCost: '1.0000', cacheWriteInputCost: '4.0000', total: '5.0000' }),
      { ...TOKENS, cacheWrite: 1_000_000 },
    );
    expect(money.inputWrite).toBe('4.0000');
    expect(money.inputTotal).toBe('5.0000');
  });

  it('reports zero everywhere when nothing was billed', () => {
    const money = moneyBreakdown(cost(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    expect(Object.values(money).every((amount) => amount === '0.0000')).toBe(true);
  });

  it('gives the completion to O when no token was reasoning', () => {
    const money = moneyBreakdown(
      cost({ outputCost: '1.2345', total: '1.2345' }),
      { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    );
    expect(money.outputOnly).toBe('1.2345');
    expect(money.reasoning).toBe('0.0000');
  });
});

describe('reasoning cost', () => {
  const engine = createPricingEngine(stubProvider());

  it('is allocated where the output rate is known, not from the combined tokens', () => {
    // The same model, one request off-peak (2/M) without thinking and one at
    // peak (4/M) that is all thinking. Splitting the combined bill two-to-one —
    // which is what the token share says — would hand money to the cheap hour.
    const plain = record({
      time: STUB_AT.early,
      model: 'tiered-model',
      tokens: { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    });
    const thinking = record({
      time: STUB_AT.earlyPeak,
      model: 'tiered-model',
      tokens: { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 1_000_000 },
    });
    const summary = costOf([plain, thinking], engine);
    const money = moneyBreakdown(summary.totals!, {
      input: 0,
      output: 2_000_000,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 1_000_000,
    });
    expect(summary.breakdown).toHaveLength(2);
    expect(summary.breakdown[0]!.reasoningCost).toBe('0.0000');
    // The peak request's whole output bill belongs to its reasoning.
    expect(summary.breakdown[1]!.reasoningCost).toBe(summary.breakdown[1]!.amounts['output']);
    expect(money.reasoning).toBe(summary.breakdown[1]!.amounts['output']);
    expect(money.outputOnly).toBe(summary.breakdown[0]!.amounts['output']);
    // A combined-token split would have said half of 6, not all of 4.
    expect(Number(money.reasoning)).toBeGreaterThan(3);
  });
});

describe('tranche accounting', () => {
  const engine = createPricingEngine(contextProvider());

  it('folds a long-context tranche into the component it belongs to', () => {
    const tokens: TokenBuckets = { input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    const summary = costOf([record({ time: CONTEXT_AT.any, model: 'context-model', tokens })], engine);
    // 0.2 at the published rate plus 0.2 above the threshold, all of it input.
    expect(summary.totals.cacheMissInputCost).toBe('0.4000');
    expect(summary.totals.cacheHitInputCost).toBe('0.0000');
    expect(summary.totals.total).toBe('0.4000');
    // The tranche is a part of the component's amount, so it never inflates the
    // line a reader checks against the total.
    expect(summary.breakdown[0]!.charges?.['input-miss']?.excessAmount).toBe('0.2000');
    expect(summary.breakdown[0]!.amounts['input-miss']).toBe('0.4000');
    const money = moneyBreakdown(summary.totals, tokens);
    expect(money.inputMiss).toBe('0.4000');
    expect(money.total).toBe(summary.totals.total);
  });

  it('carries a cache-write TTL through to the write component', () => {
    const tokens: TokenBuckets = { input: 0, output: 0, cacheRead: 0, cacheWrite: 250_000, reasoning: 0 };
    const plain = costOf([record({ time: CONTEXT_AT.any, model: 'context-model', tokens })], engine);
    const long = costOf(
      [record({ time: CONTEXT_AT.any, model: 'context-model', tokens, cacheWriteTtl: '1h' })],
      engine,
    );
    // 200k at 5 plus 50k at 7, then the same card at twice the rate for 1h.
    expect(plain.breakdown[0]!.amounts['input-write']).toBe('1.3500');
    expect(long.breakdown[0]!.amounts['input-write']).toBe('2.7000');
    expect(long.breakdown[0]!.charges?.['input-write']?.ttlTier).toBe('1h');
    expect(long.breakdown[0]!.charges?.['input-write']?.ttlMultiplier).toBe('2');
    // The write bill is still one component: the total is not the tranche twice.
    expect(long.totals.cacheWriteInputCost).toBe('2.7000');
    expect(long.totals.total).toBe('2.7000');
    // Same tokens without a TTL: the tranche stands, the multiplier does not.
    expect(plain.breakdown[0]!.charges?.['input-write']?.ttlTier).toBeNull();
    expect(plain.breakdown[0]!.charges?.['input-write']?.excessAmount).toBe('0.3500');
  });
});
