/**
 * The four vendors whose rates come from an aggregator, as shipped.
 *
 * OpenAI, Anthropic, Moonshot and Zhipu have no reachable pricing page in this
 * environment, so their numbers are transcribed from LiteLLM's machine-readable
 * price list and cross-checked against OpenRouter where that site lists the same
 * model. Every rate below is pinned against the value in that source, so a
 * mistyped digit fails here rather than in a user's report; every period must
 * name its source and say what it is (a snapshot, not a verified history).
 *
 * These vendors are also the ones where the *basis* matters: Anthropic charges
 * cache reads and cache writes as their own line items, OpenAI charges only for
 * reads, and reasoning tokens are part of the output price for all four.
 */

import { describe, expect, it } from 'vitest';

import { emptyBuckets } from '../../src/core/buckets.ts';
import {
  parsePricingConfig,
  providerFromConfig,
  shippedPricingText,
  type ProviderConfig,
} from '../../src/pricing/catalog.ts';
import type { PricePeriod, PricingProvider } from '../../src/pricing/index.ts';
import { createPricingEngine } from '../../src/pricing/index.ts';
import { record } from '../support/dataset.ts';

/** The shipped file, parsed once. */
const CONFIG = parsePricingConfig(shippedPricingText());

/** The same providers with their model lookups, which is what the engine takes. */
const ENGINES: ReadonlyMap<string, PricingProvider> = new Map(
  CONFIG.providers.map((entry): [string, PricingProvider] => [entry.id, providerFromConfig(entry)]),
);

/** One provider of the shipped file, by id. */
function provider(id: string): ProviderConfig {
  const found = CONFIG.providers.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`config/pricing.json has no provider ${id}`);
  return found;
}

/** The priceable form of one provider, for engine assertions. */
function lookup(id: string): PricingProvider {
  const found = ENGINES.get(id);
  if (found === undefined) throw new Error(`config/pricing.json has no provider ${id}`);
  return found;
}

/** The single period of one model of one provider. */
function period(id: string, model: string): PricePeriod {
  const entry = provider(id).models.find((price) => price.model === model);
  if (entry === undefined) throw new Error(`${id} has no model ${model}`);
  const first = entry.periods[0];
  if (first === undefined) throw new Error(`${id}/${model} has no period`);
  return first;
}

/** One component's published rate, by component id. */
function rate(id: string, model: string, component: string): string {
  const found = period(id, model).offPeak.find((entry) => entry.id === component);
  if (found === undefined) throw new Error(`${id}/${model} has no ${component} component`);
  return found.rate;
}

/** The component ids of a model's card, in file order. */
function components(id: string, model: string): string[] {
  return period(id, model).offPeak.map((entry) => entry.id);
}

/** The four vendors added on top of DeepSeek. */
const ADDED = ['openai', 'anthropic', 'moonshot', 'zhipu'] as const;

/** An instant the real usage falls inside, so every card resolves exactly. */
const AT = Date.parse('2026-09-30T12:00:00Z');

describe('the shipped vendor list', () => {
  it('keeps DeepSeek first and appends the four aggregator-sourced vendors', () => {
    expect(CONFIG.providers.map((entry) => entry.id)).toEqual(['deepseek', ...ADDED]);
    expect(CONFIG.version).toBe(1);
  });

  it('leaves unknown models unpriced for the new vendors', () => {
    // A default model would borrow one model's price for another's tokens, which
    // is a guess; `null` reports those records as unpriced instead. DeepSeek's own
    // default predates that rule and stays as it is.
    expect(provider('deepseek').defaultModel).toBe('deepseek-flash');
    for (const id of ADDED) expect(provider(id).defaultModel).toBeNull();
  });

  it('names the agent each vendor is the natural default for', () => {
    expect(provider('deepseek').defaultFor).toEqual(['dsh']);
    expect(provider('openai').defaultFor).toEqual(['codex']);
    expect(provider('anthropic').defaultFor).toEqual(['claude']);
    // Kimi and GLM have no agent of their own; `--provider` is how they are picked.
    expect(provider('moonshot').defaultFor).toEqual([]);
    expect(provider('zhipu').defaultFor).toEqual([]);
  });
});

describe('every added period', () => {
  it('is a flat USD snapshot with a source and a note', () => {
    for (const id of ADDED) {
      for (const model of provider(id).models) {
        for (const entry of model.periods) {
          expect(entry.currency).toBe('USD');
          // One open-ended period per model: the source records no effective date.
          expect(entry.to).toBeNull();
          expect(entry.peak).toBeNull();
          expect(entry.peakWindows).toEqual([]);
          expect(entry.source).toMatch(/^https:\/\/raw\.githubusercontent\.com\/BerriAI\/litellm\//);
          expect(entry.note).toContain('LiteLLM');
          // The vendor's own page could not be reached, and the note has to say so.
          expect(entry.note).toContain('未与厂商定价页核对');
        }
      }
    }
  });

  it('resolves to a flat tier through the engine, at the rates the file lists', () => {
    for (const id of ADDED) {
      for (const model of provider(id).models) {
        const resolved = createPricingEngine(lookup(id)).resolve(record({ time: AT, model: model.model }));
        expect(resolved?.tier).toBe('flat');
        expect(resolved?.resolution).toBe('exact');
        expect(resolved?.model).toBe(model.model);
        expect(resolved?.period.source).toBe(period(id, model.model).source);
        expect(resolved?.period.currency).toBe('USD');
      }
    }
  });

  it('writes rates as decimal strings, never floats', () => {
    for (const id of ADDED) {
      for (const model of provider(id).models) {
        for (const entry of model.periods) {
          for (const component of entry.offPeak) {
            expect(typeof component.rate).toBe('string');
            expect(component.per).toBe(1_000_000);
          }
        }
      }
    }
  });
});

describe('published rates', () => {
  it('prices the OpenAI models codex reports, per LiteLLM($/M tokens)', () => {
    // LiteLLM `gpt-6.1-sol`: 2 / 10 input/output, 0.1 cache read.
    expect([rate('openai', 'gpt-6.1-sol', 'input-miss'), rate('openai', 'gpt-6.1-sol', 'input-hit'), rate('openai', 'gpt-6.1-sol', 'output')]).toEqual(['2', '0.1', '10']);
    // LiteLLM `gpt-6-astra`: 10 / 50, 1 cache read.
    expect([rate('openai', 'gpt-6-astra', 'input-miss'), rate('openai', 'gpt-6-astra', 'input-hit'), rate('openai', 'gpt-6-astra', 'output')]).toEqual(['10', '1', '50']);
    // LiteLLM `gpt-5.5`: 5 / 30, 0.5 cache read.
    expect([rate('openai', 'gpt-5.5', 'input-miss'), rate('openai', 'gpt-5.5', 'input-hit'), rate('openai', 'gpt-5.5', 'output')]).toEqual(['5', '0.5', '30']);
  });

  it('prices the Anthropic models Claude Code reports, per LiteLLM($/M tokens)', () => {
    // LiteLLM `claude-opus-5`: 5 / 25, cache read 0.5, cache write 6.25.
    expect([
      rate('anthropic', 'claude-opus-5', 'input-miss'),
      rate('anthropic', 'claude-opus-5', 'input-hit'),
      rate('anthropic', 'claude-opus-5', 'input-write'),
      rate('anthropic', 'claude-opus-5', 'output'),
    ]).toEqual(['5', '0.5', '6.25', '25']);
    // LiteLLM `claude-opus-4-8`: the same published numbers.
    expect(rate('anthropic', 'claude-opus-4-8', 'input-write')).toBe('6.25');
    // LiteLLM `claude-haiku-4-5`: 1 / 5, cache read 0.1, cache write 1.25.
    expect(rate('anthropic', 'claude-haiku-4-5', 'input-write')).toBe('1.25');
    expect(rate('anthropic', 'claude-haiku-4-5', 'output')).toBe('5');
  });

  it('prices Kimi per LiteLLM `moonshot/*` ($/M tokens)', () => {
    // LiteLLM `moonshot/kimi-k3`: 3 / 15, cache read 0.3.
    expect([rate('moonshot', 'kimi-k3', 'input-miss'), rate('moonshot', 'kimi-k3', 'input-hit'), rate('moonshot', 'kimi-k3', 'output')]).toEqual(['3', '0.3', '15']);
    // LiteLLM `moonshot/kimi-k2.5`: 0.6 / 3, cache read 0.1.
    expect(rate('moonshot', 'kimi-k2.5', 'input-miss')).toBe('0.6');
    expect(rate('moonshot', 'kimi-k2.5', 'output')).toBe('3');
  });

  it('prices GLM per LiteLLM `zai/*` ($/M tokens)', () => {
    // LiteLLM `zai/glm-5.3`: 1.4 / 4.4, cache read 0.26.
    expect([rate('zhipu', 'glm-5.3', 'input-miss'), rate('zhipu', 'glm-5.3', 'input-hit'), rate('zhipu', 'glm-5.3', 'output')]).toEqual(['1.4', '0.26', '4.4']);
    // LiteLLM `zai/glm-5.3-flash`: 0.15 / 0.5, cache read 0.03.
    expect(rate('zhipu', 'glm-5.3-flash', 'input-miss')).toBe('0.15');
    expect(rate('zhipu', 'glm-5.3-flash', 'output')).toBe('0.5');
  });
});

describe('billing bases', () => {
  it('gives Anthropic cache reads and cache writes their own components', () => {
    for (const model of provider('anthropic').models) {
      expect(components('anthropic', model.model)).toEqual(['input-miss', 'input-hit', 'input-write', 'output']);
      const bases = period('anthropic', model.model).offPeak.map((entry) => entry.basis);
      expect(bases).toEqual(['input', 'cacheRead', 'cacheWrite', 'output']);
    }
  });

  it('never invents a cache-write charge for OpenAI', () => {
    // OpenAI bills cached reads at a discount and cache writes at nothing, so the
    // card has three components and no `cacheWrite` basis.
    for (const model of provider('openai').models) {
      expect(components('openai', model.model)).toEqual(['input-miss', 'input-hit', 'output']);
      expect(period('openai', model.model).offPeak.map((entry) => entry.basis)).toEqual(['input', 'cacheRead', 'output']);
    }
  });

  it('omits cache writes where the sources publish no positive price', () => {
    // Moonshot's cache-write field is null and Z.ai's is 0 in LiteLLM; neither
    // table has a number to charge, so neither card carries a `cacheWrite` line.
    for (const id of ['moonshot', 'zhipu'] as const) {
      for (const model of provider(id).models) {
        expect(components(id, model.model)).toEqual(['input-miss', 'input-hit', 'output']);
      }
    }
  });

  it('adds no threshold or TTL multiplier the sources did not give', () => {
    for (const id of ADDED) {
      for (const model of provider(id).models) {
        for (const entry of period(id, model.model).offPeak) {
          expect(entry.aboveThreshold).toBeUndefined();
          expect(entry.ttlMultipliers).toBeUndefined();
        }
      }
    }
  });
});

describe('cost of a request', () => {
  it('bills OpenAI reads but not writes, and never reasoning twice', () => {
    const engine = createPricingEngine(lookup('openai'));
    // 1M input + 1M cache read + 1M output at 2 / 0.1 / 10 = $12.10.
    const cost = engine.costOf(
      record({ time: AT, model: 'gpt-6.1-sol', tokens: { ...emptyBuckets(), input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 } }),
    );
    expect(cost?.amounts.get('input-miss')).toBe(2_000_000_000n);
    expect(cost?.amounts.get('input-hit')).toBe(100_000_000n);
    expect(cost?.amounts.get('output')).toBe(10_000_000_000n);
    expect(cost?.total).toBe(12_100_000_000n);
    // Reasoning is reported inside output, so the same request with reasoning
    // tokens costs exactly the same.
    const withReasoning = engine.costOf(
      record({
        time: AT,
        model: 'gpt-6.1-sol',
        tokens: { ...emptyBuckets(), input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000, reasoning: 750_000 },
      }),
    );
    expect(withReasoning?.total).toBe(cost?.total);
    // A cache write adds nothing: OpenAI has no line item for it.
    const writeOnly = engine.costOf(
      record({ time: AT, model: 'gpt-6.1-sol', tokens: { ...emptyBuckets(), cacheWrite: 1_000_000 } }),
    );
    expect(writeOnly?.total).toBe(0n);
  });

  it('bills all four Anthropic line items', () => {
    const engine = createPricingEngine(lookup('anthropic'));
    // 1M of each at 5 / 0.5 / 6.25 / 25 = $36.75.
    const cost = engine.costOf(
      record({
        time: AT,
        model: 'claude-opus-5',
        tokens: { ...emptyBuckets(), input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 },
      }),
    );
    expect(cost?.amounts.get('input-miss')).toBe(5_000_000_000n);
    expect(cost?.amounts.get('input-hit')).toBe(500_000_000n);
    expect(cost?.amounts.get('input-write')).toBe(6_250_000_000n);
    expect(cost?.amounts.get('output')).toBe(25_000_000_000n);
    expect(cost?.total).toBe(36_750_000_000n);
  });

  it('leaves a model the sources do not cover unpriced', () => {
    // `codex-auto-review` is a Codex-internal reviewer id: it appears only in the
    // session's turn configuration, no source prices it, and `defaultModel: null`
    // means the tool says "unpriced" instead of borrowing another model's rate.
    const engine = createPricingEngine(lookup('openai'));
    expect(engine.costOf(record({ time: AT, model: 'codex-auto-review' }))).toBeUndefined();
    expect(engine.resolve(record({ time: AT, model: 'codex-auto-review' }))).toBeUndefined();
  });
});

describe('model aliases', () => {
  it('routes the names the agents report onto the same card', () => {
    // Claude Code marks the 1M-context beta with a `[1m]` suffix on the model id.
    expect(lookup('anthropic').find('claude-opus-5[1m]')?.model).toBe('claude-opus-5');
    expect(lookup('anthropic').find('  Claude-Opus-4-8 ')?.model).toBe('claude-opus-4-8');
    expect(lookup('openai').find('openai/gpt-5.5')?.model).toBe('gpt-5.5');
    expect(lookup('moonshot').find('moonshot/kimi-k3')?.model).toBe('kimi-k3');
    expect(lookup('zhipu').find('zai/glm-5.3')?.model).toBe('glm-5.3');
  });

  it('knows nothing about ids no source prices', () => {
    expect(lookup('openai').find('codex-auto-review')).toBeUndefined();
    expect(lookup('anthropic').find('claude-nonexistent-9')).toBeUndefined();
  });
});
