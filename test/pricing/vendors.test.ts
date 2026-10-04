/**
 * The four vendors whose rates come from their own pricing pages, as shipped.
 *
 * OpenAI, Anthropic, Moonshot and Zhipu are transcribed from the vendors' own
 * pages (fetched 2026-10-04) and cross-checked against LiteLLM/OpenRouter: every
 * rate below is pinned against the vendor's row, so a mistyped digit or a silent
 * fallback to an aggregator fails here rather than in a user's report. Moonshot
 * and Zhipu publish yuan only, so their rows are `CNY` and are not converted.
 *
 * The bases matter as much as the numbers: Anthropic bills cache writes on their
 * own basis with a 1-hour multiplier, OpenAI bills them only where its table has
 * a number, Moonshot's K3 bills them by TTL, and reasoning tokens are part of the
 * output price for all four.
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

/** One component of one model's card, by component id. */
function component(id: string, model: string, wanted: string) {
  const found = period(id, model).offPeak.find((entry) => entry.id === wanted);
  if (found === undefined) throw new Error(`${id}/${model} has no ${wanted} component`);
  return found;
}

/** One component's published rate. */
function rate(id: string, model: string, part: string): string {
  return component(id, model, part).rate;
}

/** The component ids of a model's card, in file order. */
function components(id: string, model: string): string[] {
  return period(id, model).offPeak.map((entry) => entry.id);
}

/** The four vendors added on top of DeepSeek. */
const ADDED = ['openai', 'anthropic', 'moonshot', 'zhipu'] as const;

/** Each vendor's own page, which is where its rows come from. */
const VENDOR_PAGE: Record<(typeof ADDED)[number], string> = {
  openai: 'https://developers.openai.com/api/docs/pricing',
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
  moonshot: 'https://platform.kimi.com/docs/pricing/chat',
  zhipu: 'https://docs.bigmodel.cn/cn/guide/start/pricing',
};

/** The aggregator URL the few uncovered rows still point at. */
const LITELLM = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** Rows no vendor page lists, which therefore keep their aggregator provenance. */
const AGGREGATOR_ROWS: [string, string][] = [
  ['openai', 'gpt-5.6'],
  ['moonshot', 'kimi-k2.5'],
  ['zhipu', 'glm-5-code'],
];

/** Whether a row comes from the vendor's own page or from the aggregator. */
function fromVendor(id: string, model: string): boolean {
  return !AGGREGATOR_ROWS.some(([providerId, name]) => providerId === id && name === model);
}

/** An instant the real usage falls inside, so every card resolves exactly. */
const AT = Date.parse('2026-09-30T12:00:00Z');

describe('the shipped vendor list', () => {
  it('keeps DeepSeek first and appends the four vendors', () => {
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

describe('provenance', () => {
  it('points every vendor-sourced period at its vendor page, with the fetch date', () => {
    for (const id of ADDED) {
      for (const model of provider(id).models) {
        if (!fromVendor(id, model.model)) continue;
        const entry = period(id, model.model);
        expect(entry.source).toBe(VENDOR_PAGE[id]);
        expect(entry.note).toContain('抓取于 2026-10-04');
        expect(entry.note).toContain(VENDOR_PAGE[id].replace('https://', ''));
        // One open-ended period per model: the vendor page lists current prices only.
        expect(entry.to).toBeNull();
        expect(entry.peak).toBeNull();
        expect(entry.peakWindows).toEqual([]);
      }
    }
  });

  it('keeps the aggregator URL only for rows the vendor pages do not list', () => {
    // The vendor pages have no row for these three, so they stay on LiteLLM and
    // the note says so rather than pretending the vendor published them.
    for (const [id, model] of AGGREGATOR_ROWS) {
      const entry = period(id, model);
      expect(entry.source).toBe(LITELLM);
      expect(entry.note).toContain('聚合源');
      expect(entry.note).toContain('厂商页');
    }
  });

  it('publishes yuan for the vendors whose pages are yuan-only', () => {
    // Moonshot and Zhipu publish CNY; converting would invent a number.
    for (const id of ['moonshot', 'zhipu'] as const) {
      for (const model of provider(id).models) {
        const entry = period(id, model.model);
        const vendorRow = fromVendor(id, model.model);
        expect(entry.currency).toBe(vendorRow ? 'CNY' : 'USD');
        if (vendorRow) expect(entry.note).toContain('CNY');
      }
    }
    for (const id of ['openai', 'anthropic'] as const) {
      for (const model of provider(id).models) expect(period(id, model.model).currency).toBe('USD');
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
      }
    }
  });

  it('writes rates as decimal strings, never floats', () => {
    for (const id of ADDED) {
      for (const model of provider(id).models) {
        for (const entry of model.periods) {
          for (const part of entry.offPeak) {
            expect(typeof part.rate).toBe('string');
            expect(part.per).toBe(1_000_000);
          }
        }
      }
    }
  });
});

describe('published rates', () => {
  it('matches OpenAI\'s own table ($/M tokens) for the models codex reports', () => {
    // developers.openai.com/api/docs/pricing, standard tier, fetched 2026-10-04.
    // gpt-5.6-sol: input 4, cached 0.4, cache write 5, output 20. This is the row
    // that settles the LiteLLM-vs-OpenRouter dispute (OpenRouter says 2/10).
    expect([
      rate('openai', 'gpt-5.6-sol', 'input-miss'),
      rate('openai', 'gpt-5.6-sol', 'input-hit'),
      rate('openai', 'gpt-5.6-sol', 'input-write'),
      rate('openai', 'gpt-5.6-sol', 'output'),
    ]).toEqual(['4', '0.4', '5', '20']);
    // gpt-6.1-sol: 2 / 0.1 / 2.5 / 10; gpt-6-astra: 10 / 1 / 12.5 / 50.
    expect(rate('openai', 'gpt-6.1-sol', 'input-write')).toBe('2.5');
    expect(rate('openai', 'gpt-6.1-sol', 'output')).toBe('10');
    expect(rate('openai', 'gpt-6-astra', 'input-hit')).toBe('1');
    // gpt-5.5: 5 / 0.5 / - / 30 — the vendor writes `-` for cache writes.
    expect(components('openai', 'gpt-5.5')).toEqual(['input-miss', 'input-hit', 'output']);
    expect(rate('openai', 'gpt-5.5', 'output')).toBe('30');
    // gpt-5.3-codex (specialized models, Codex row): 1.75 / 0.175 / 14.
    expect(rate('openai', 'gpt-5.3-codex', 'input-miss')).toBe('1.75');
    expect(rate('openai', 'gpt-5.3-codex', 'output')).toBe('14');
  });

  it('matches Anthropic\'s own table ($/M tokens)', () => {
    // platform.claude.com/docs/en/about-claude/pricing, fetched 2026-10-04:
    // Claude Opus 5 is 5 / 25 with 0.50 cache hits and 6.25 five-minute writes.
    expect([
      rate('anthropic', 'claude-opus-5', 'input-miss'),
      rate('anthropic', 'claude-opus-5', 'input-hit'),
      rate('anthropic', 'claude-opus-5', 'input-write'),
      rate('anthropic', 'claude-opus-5', 'output'),
    ]).toEqual(['5', '0.50', '6.25', '25']);
    // Claude Opus 5.5 is the cheaper 4 / 20 row with 0.05x cache hits.
    expect(rate('anthropic', 'claude-opus-5-5', 'input-hit')).toBe('0.20');
    expect(rate('anthropic', 'claude-opus-5-5', 'input-write')).toBe('5');
    // Claude Haiku 4.5: 1 / 5 with 1.25 five-minute writes.
    expect(rate('anthropic', 'claude-haiku-4-5', 'input-hit')).toBe('0.10');
    expect(rate('anthropic', 'claude-haiku-4-5', 'input-write')).toBe('1.25');
    // Claude Sonnet 4.6, added with this pass: 3 / 15 with 3.75 writes.
    expect(rate('anthropic', 'claude-sonnet-4-6', 'input-write')).toBe('3.75');
    expect(rate('anthropic', 'claude-opus-4-6', 'output')).toBe('25');
  });

  it('matches Kimi\'s own table (¥/M tokens)', () => {
    // platform.kimi.com/docs/pricing/chat, fetched 2026-10-04. K3 is the row with
    // the cache-write columns: 5m 20, 1h 40, hit 2, miss 20, output 100.
    expect([
      rate('moonshot', 'kimi-k3', 'input-write'),
      rate('moonshot', 'kimi-k3', 'input-hit'),
      rate('moonshot', 'kimi-k3', 'input-miss'),
      rate('moonshot', 'kimi-k3', 'output'),
    ]).toEqual(['20', '2', '20', '100']);
    // K2 table: kimi-k2.7-code 6.50 / 1.30 / 27.00, kimi-k2.6 6.50 / 1.10 / 27.00.
    expect(rate('moonshot', 'kimi-k2.7-code', 'input-miss')).toBe('6.50');
    expect(rate('moonshot', 'kimi-k2.7-code', 'input-hit')).toBe('1.30');
    expect(rate('moonshot', 'kimi-k2.6', 'output')).toBe('27.00');
    expect(rate('moonshot', 'kimi-k2.7-code-highspeed', 'output')).toBe('54.00');
  });

  it('matches Zhipu\'s own table (¥/M tokens)', () => {
    // docs.bigmodel.cn/cn/guide/start/pricing, fetched 2026-10-04. GLM-5.3 and
    // GLM-5.2 are flat: 8 / 28 with a 2 yuan cache hit.
    expect([
      rate('zhipu', 'glm-5.3', 'input-miss'),
      rate('zhipu', 'glm-5.3', 'input-hit'),
      rate('zhipu', 'glm-5.3', 'output'),
    ]).toEqual(['8', '2', '28']);
    expect(rate('zhipu', 'glm-5.2', 'output')).toBe('28');
    // GLM-5.3-Flash: 0.8 / 2.8 with a 0.23 hit.
    expect(rate('zhipu', 'glm-5.3-flash', 'input-miss')).toBe('0.8');
    // The tiered models carry the vendor's first published tier, and say so.
    expect(rate('zhipu', 'glm-5.1', 'input-miss')).toBe('6');
    expect(rate('zhipu', 'glm-5', 'output')).toBe('18');
    expect(period('zhipu', 'glm-5.1').note).toContain('输入长度 ≥32K');
    expect(period('zhipu', 'glm-4.7').note).toContain('输出 ≥0.2K');
  });
});

describe('billing bases', () => {
  it('gives Anthropic cache reads and cache writes their own components', () => {
    for (const model of provider('anthropic').models) {
      expect(components('anthropic', model.model)).toEqual(['input-miss', 'input-hit', 'input-write', 'output']);
      expect(period('anthropic', model.model).offPeak.map((entry) => entry.basis)).toEqual([
        'input',
        'cacheRead',
        'cacheWrite',
        'output',
      ]);
    }
  });

  it('prices the 1-hour cache write Anthropic publishes as a TTL multiplier', () => {
    // 1h writes are 2x input and 5m writes are 1.25x input on every model, so the
    // multiplier is a constant 1.6 — a published number, not a derived guess.
    for (const model of provider('anthropic').models) {
      const write = component('anthropic', model.model, 'input-write');
      expect(write.ttlMultipliers).toEqual({ '1h': '1.6' });
    }
    expect(component('anthropic', 'claude-opus-5', 'input-write').ttlMultipliers?.['1h']).toBe('1.6');
  });

  it('bills OpenAI cache writes only where its table has a number', () => {
    // The vendor's Cache writes column is a price for gpt-5.6 and newer, and `-`
    // for gpt-5.5 and for the specialized-models table.
    for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(components('openai', model)).toEqual(['input-miss', 'input-hit', 'input-write', 'output']);
    }
    for (const model of ['gpt-5.5', 'gpt-5.3-codex', 'gpt-5.6']) {
      expect(components('openai', model)).toEqual(['input-miss', 'input-hit', 'output']);
    }
  });

  it('bills Kimi cache writes only on K3, and folds them into the miss price on K2', () => {
    // K3 publishes write columns; the K2 table does not, and the vendor's billing
    // formula is miss input + hit + output + cache storage, so writes are input.
    expect(components('moonshot', 'kimi-k3')).toEqual(['input-miss', 'input-hit', 'input-write', 'output']);
    expect(component('moonshot', 'kimi-k3', 'input-write').ttlMultipliers).toEqual({ '1h': '2' });
    for (const model of ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2.5']) {
      expect(components('moonshot', model)).toEqual(['input-miss', 'input-hit', 'output']);
      expect(component('moonshot', model, 'input-miss').basis).toBe('inputAndCacheWrite');
    }
  });

  it('folds Zhipu cache writes into the miss price, since storage is the only cache charge', () => {
    for (const model of provider('zhipu').models) {
      expect(components('zhipu', model.model)).toEqual(['input-miss', 'input-hit', 'output']);
      expect(component('zhipu', model.model, 'input-miss').basis).toBe('inputAndCacheWrite');
    }
  });

  it('adds no threshold the vendors did not publish as a graduated tranche', () => {
    // OpenAI's >272K tier and Zhipu's >=32K tier reprice the whole request; a
    // graduated tranche is a different rule, so none of these cards carries one.
    for (const id of ADDED) {
      for (const model of provider(id).models) {
        for (const entry of period(id, model.model).offPeak) {
          expect(entry.aboveThreshold).toBeUndefined();
        }
      }
    }
  });
});

describe('cost of a request', () => {
  it('bills OpenAI reads and writes, and never reasoning twice', () => {
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
    // A cache write now has a line of its own: 1M at the vendor's $2.5 write price.
    const writeOnly = engine.costOf(
      record({ time: AT, model: 'gpt-6.1-sol', tokens: { ...emptyBuckets(), cacheWrite: 1_000_000 } }),
    );
    expect(writeOnly?.total).toBe(2_500_000_000n);
    // On gpt-5.5 the vendor writes `-`, so a write is free there.
    const legacyWrite = engine.costOf(
      record({ time: AT, model: 'gpt-5.5', tokens: { ...emptyBuckets(), cacheWrite: 1_000_000 } }),
    );
    expect(legacyWrite?.total).toBe(0n);
  });

  it('bills all four Anthropic line items, at both write TTLs', () => {
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
    // A one-hour write is $10/MTok, exactly 1.6x the five-minute price.
    const hourly = engine.costOf(
      record({
        time: AT,
        model: 'claude-opus-5',
        tokens: { ...emptyBuckets(), cacheWrite: 1_000_000 },
        cacheWriteTtl: '1h',
      }),
    );
    expect(hourly?.amounts.get('input-write')).toBe(10_000_000_000n);
  });

  it('bills Kimi in yuan, with the K3 write TTL', () => {
    const engine = createPricingEngine(lookup('moonshot'));
    // 1M of each at ¥20 miss / ¥2 hit / ¥20 write / ¥100 output = ¥142.
    const cost = engine.costOf(
      record({
        time: AT,
        model: 'kimi-k3',
        tokens: { ...emptyBuckets(), input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 },
      }),
    );
    expect(cost?.total).toBe(142_000_000_000n);
    const hourly = engine.costOf(
      record({ time: AT, model: 'kimi-k3', tokens: { ...emptyBuckets(), cacheWrite: 1_000_000 }, cacheWriteTtl: '1h' }),
    );
    expect(hourly?.total).toBe(40_000_000_000n);
    // A K2 write is billed at the cache-miss price: ¥6.50 for one million.
    const k2 = engine.costOf(
      record({ time: AT, model: 'kimi-k2.7-code', tokens: { ...emptyBuckets(), cacheWrite: 1_000_000 } }),
    );
    expect(k2?.total).toBe(6_500_000_000n);
  });

  it('bills Zhipu cache writes at the miss price', () => {
    const engine = createPricingEngine(lookup('zhipu'));
    const cost = engine.costOf(
      record({ time: AT, model: 'glm-5.3', tokens: { ...emptyBuckets(), cacheWrite: 1_000_000 } }),
    );
    expect(cost?.total).toBe(8_000_000_000n);
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
    expect(lookup('anthropic').find('claude-sonnet-4-6')?.model).toBe('claude-sonnet-4-6');
    expect(lookup('openai').find('openai/gpt-5.5')?.model).toBe('gpt-5.5');
    expect(lookup('openai').find('gpt-5.3-codex')?.model).toBe('gpt-5.3-codex');
    expect(lookup('moonshot').find('moonshot/kimi-k3')?.model).toBe('kimi-k3');
    expect(lookup('zhipu').find('zai/glm-5.3')?.model).toBe('glm-5.3');
  });

  it('knows nothing about ids no source prices', () => {
    expect(lookup('openai').find('codex-auto-review')).toBeUndefined();
    expect(lookup('anthropic').find('claude-nonexistent-9')).toBeUndefined();
  });
});
