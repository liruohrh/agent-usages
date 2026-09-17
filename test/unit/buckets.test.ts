/**
 * Derived token roll-up.
 *
 * The four adapter buckets are disjoint, and reasoning is a *subset* of output.
 * Both facts are easy to get backwards by hand, so the derivation is pinned here.
 */

import { describe, expect, it } from 'vitest';

import { addBuckets, emptyBuckets, tokenBreakdown, totalTokens } from '../../src/core/buckets.ts';

describe('tokenBreakdown', () => {
  it('adds the three disjoint prompt buckets into one input total', () => {
    const parts = tokenBreakdown({ ...emptyBuckets(), input: 1, cacheRead: 2, cacheWrite: 3 });
    expect(parts.inputMiss).toBe(1);
    expect(parts.inputHit).toBe(2);
    expect(parts.inputWrite).toBe(3);
    expect(parts.inputTotal).toBe(6);
  });

  it('splits output into reasoning and non-reasoning that add back up', () => {
    const parts = tokenBreakdown({ ...emptyBuckets(), output: 100, reasoning: 40 });
    expect(parts.reasoning).toBe(40);
    expect(parts.outputOnly).toBe(60);
    expect(parts.outputTotal).toBe(100);
    expect(parts.outputOnly + parts.reasoning).toBe(parts.outputTotal);
  });

  it('never counts reasoning on top of the provider completion count', () => {
    // Reasoning is reported inside `output`, so the output total is `output`.
    const withReasoning = tokenBreakdown({ ...emptyBuckets(), output: 100, reasoning: 40 });
    const without = tokenBreakdown({ ...emptyBuckets(), output: 100 });
    expect(withReasoning.outputTotal).toBe(without.outputTotal);
  });

  it('clamps reasoning that exceeds output rather than producing a negative part', () => {
    // No adapter should do this, but a derived figure must never go negative.
    const parts = tokenBreakdown({ ...emptyBuckets(), output: 10, reasoning: 25 });
    expect(parts.reasoning).toBe(10);
    expect(parts.outputOnly).toBe(0);
    expect(parts.outputTotal).toBe(10);
  });

  it('totals the input and output sides', () => {
    const parts = tokenBreakdown({ input: 10, output: 30, cacheRead: 20, cacheWrite: 5, reasoning: 12 });
    expect(parts.inputTotal).toBe(35);
    expect(parts.outputTotal).toBe(30);
    expect(parts.total).toBe(65);
  });

  it('treats a zero breakdown as all zeroes', () => {
    const parts = tokenBreakdown(emptyBuckets());
    expect(parts.total).toBe(0);
    expect(Object.values(parts).every((value) => value === 0)).toBe(true);
  });

  it('uses only the four disjoint buckets for the grand total', () => {
    const buckets = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 2 };
    // `totalTokens` and the breakdown must agree: reasoning is inside output.
    expect(totalTokens(buckets)).toBe(10);
    expect(tokenBreakdown(buckets).total).toBe(10);
  });
});

describe('addBuckets', () => {
  it('sums every counter without mutating the base', () => {
    const base = emptyBuckets();
    const merged = addBuckets(base, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 2 });
    expect(merged).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 2 });
    expect(base).toEqual(emptyBuckets());
  });
});
