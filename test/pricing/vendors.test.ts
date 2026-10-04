/**
 * The four vendors whose rates come from their own pricing pages, as shipped.
 *
 * OpenAI, Anthropic, Moonshot and Zhipu are transcribed from the vendors' own
 * pages (fetched 2026-10-04) and cross-checked against LiteLLM/OpenRouter: every
 * rate below is pinned against the vendor's row, so a mistyped digit or a silent
 * fallback to an aggregator fails here rather than in a user's report.
 *
 * Moonshot and Zhipu quote two currencies — a Chinese list in yuan and an
 * international one in dollars — so like DeepSeek they carry both over the same
 * windows and the reader's currency picks one. Neither list is a conversion of
 * the other, and the assertions below pin each one to its own page.
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
import type { InputTier, PricePeriod, PricingProvider, RateComponent } from '../../src/pricing/index.ts';
import { convertProvider, createPricingEngine, currencyOf, selectCurrency } from '../../src/pricing/index.ts';
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

/** Every period of one model of one provider. */
function periods(id: string, model: string): readonly PricePeriod[] {
  const entry = provider(id).models.find((price) => price.model === model);
  if (entry === undefined) throw new Error(`${id} has no model ${model}`);
  return entry.periods;
}

/** The first period of one model, which is the list the file publishes first. */
function period(id: string, model: string): PricePeriod {
  const first = periods(id, model)[0];
  if (first === undefined) throw new Error(`${id}/${model} has no period`);
  return first;
}

/** One model's period in a named currency. */
function periodIn(id: string, model: string, currency: string): PricePeriod {
  const found = periods(id, model).find((entry) => entry.currency === currency);
  if (found === undefined) throw new Error(`${id}/${model} has no ${currency} period`);
  return found;
}

/**
 * The card a period publishes for the smallest request.
 *
 * A period with whole-request size bands keeps its rates inside them — the bands
 * *are* the rate card — so "the model's rates" means the first band's for those
 * models. That is the row a vendor page prints first, and the one these
 * assertions pinned before the bands existed.
 * @param entry - the period to read.
 * @returns its first band's card, or its own when it has no bands.
 */
function smallestBand(entry: PricePeriod): readonly RateComponent[] {
  return entry.inputTiers?.[0]?.offPeak ?? entry.offPeak;
}

/** One component of one model's card in a currency, by component id. */
function componentIn(id: string, model: string, currency: string, wanted: string) {
  const found = smallestBand(periodIn(id, model, currency)).find((entry) => entry.id === wanted);
  if (found === undefined) throw new Error(`${id}/${model} ${currency} has no ${wanted} component`);
  return found;
}

/** One component of one model's first card, by component id. */
function component(id: string, model: string, wanted: string) {
  const found = smallestBand(period(id, model)).find((entry) => entry.id === wanted);
  if (found === undefined) throw new Error(`${id}/${model} has no ${wanted} component`);
  return found;
}

/** One component's published rate, on the model's first list. */
function rate(id: string, model: string, part: string): string {
  return component(id, model, part).rate;
}

/** One component's published rate, in a named currency. */
function rateIn(id: string, model: string, currency: string, part: string): string {
  return componentIn(id, model, currency, part).rate;
}

/** The component ids of a model's card, in file order. */
function components(id: string, model: string): string[] {
  return smallestBand(period(id, model)).map((entry) => entry.id);
}

/** One model's whole-request size bands in a currency, which must have them. */
function tiersIn(id: string, model: string, currency: string): readonly InputTier[] {
  const found = periodIn(id, model, currency).inputTiers;
  if (found === undefined) throw new Error(`${id}/${model} ${currency} has no inputTiers`);
  return found;
}

/** The rates of one band, in component order. */
function bandRates(id: string, model: string, currency: string, band: number): string[] {
  const found = tiersIn(id, model, currency)[band];
  if (found === undefined) throw new Error(`${id}/${model} ${currency} has no band ${band}`);
  return found.offPeak.map((entry) => entry.rate);
}

/** The four vendors added on top of DeepSeek. */
const ADDED = ['openai', 'anthropic', 'moonshot', 'zhipu'] as const;

/**
 * Each vendor's own page, per currency.
 *
 * A vendor that quotes two currencies publishes two lists: the Chinese site in
 * yuan and the international site in dollars. They are separate published
 * numbers, so each period names the page it was copied from.
 */
const VENDOR_PAGE: Record<(typeof ADDED)[number], Partial<Record<'CNY' | 'USD', string>>> = {
  openai: { USD: 'https://developers.openai.com/api/docs/pricing' },
  anthropic: { USD: 'https://platform.claude.com/docs/en/about-claude/pricing' },
  moonshot: {
    CNY: 'https://platform.kimi.com/docs/pricing/chat',
    USD: 'https://platform.kimi.ai/docs/pricing/chat',
  },
  zhipu: {
    CNY: 'https://docs.bigmodel.cn/cn/guide/start/pricing',
    USD: 'https://docs.z.ai/guides/overview/pricing',
  },
};

/** An instant the real usage falls inside, so every card resolves exactly. */
const AT = Date.parse('2026-09-30T12:00:00Z');

describe('the shipped vendor list', () => {
  it('keeps DeepSeek first and appends the four vendors', () => {
    expect(CONFIG.providers.map((entry) => entry.id)).toEqual(['deepseek', ...ADDED]);
    expect(CONFIG.version).toBe(1);
  });

  it('carries no default model, so an unknown model is never guessed at', () => {
    // Prices are routed per record; a record whose model no table lists is
    // unpriced, not billed at some other model's rate.
    for (const id of ['deepseek', ...ADDED] as const) {
      expect(Object.keys(provider(id))).not.toContain('defaultModel');
    }
  });
});

describe('provenance', () => {
  it('points every period at the vendor page for its own currency, with the fetch date', () => {
    for (const id of ADDED) {
      for (const model of provider(id).models) {
        for (const entry of model.periods) {
          // Every row is on a vendor page now: a price nobody publishes is not
          // carried at all, and the record that names it is reported unpriced.
          expect(entry.source).toBe(VENDOR_PAGE[id][entry.currency as 'CNY' | 'USD']);
          expect(entry.note).toContain('抓取于 2026-10-04');
          expect(entry.note).toContain(entry.source.replace('https://', ''));
        }
      }
    }
  });

  it('gives every period an open-ended window with no peak rule', () => {
    for (const id of ADDED) {
      for (const model of provider(id).models) {
        for (const entry of model.periods) {
          // One snapshot per published list: the vendor page shows current prices only.
          expect(entry.to).toBeNull();
          expect(entry.peak).toBeNull();
          expect(entry.peakWindows).toEqual([]);
        }
      }
    }
  });

  it('carries only models a vendor page publishes', () => {
    // The three rows that only a community price list had (gpt-5.6, kimi-k2.5,
    // glm-5-code) were removed rather than shipped on a second-hand number: their
    // records are unpriced now.
    for (const [id, model] of [
      ['openai', 'gpt-5.6'],
      ['moonshot', 'kimi-k2.5'],
      ['zhipu', 'glm-5-code'],
    ] as const) {
      expect(provider(id).models.some((price) => price.model === model)).toBe(false);
    }
  });

  it('publishes the yuan and dollar lists side by side, window for window', () => {
    // The DeepSeek pattern: the same model carries one list per published
    // currency over identical windows, and the reader's currency picks one.
    for (const id of ['moonshot', 'zhipu'] as const) {
      for (const model of provider(id).models) {
        expect(model.periods.map((entry) => entry.currency)).toEqual(['CNY', 'USD']);
        const cny = periodIn(id, model.model, 'CNY');
        const usd = periodIn(id, model.model, 'USD');
        expect(usd.from).toBe(cny.from);
        expect(usd.to).toBe(cny.to);
        expect(usd.id).toBe(cny.id);
        expect(cny.note).toContain('CNY');
        expect(usd.note).toContain('USD');
        expect(usd.source).not.toBe(cny.source);
      }
    }
  });

  it('records the dollar list as its own numbers, not a conversion', () => {
    // GLM-5.3 is ¥8 / ¥28 / ¥2 and $1.4 / $4.4 / $0.26; Kimi K3 is ¥20 / ¥100 / ¥2
    // and $3 / $15 / $0.30. Each is what its own page prints.
    expect(rateIn('zhipu', 'glm-5.3', 'CNY', 'output')).toBe('28');
    expect(rateIn('zhipu', 'glm-5.3', 'USD', 'output')).toBe('4.4');
    expect(rateIn('zhipu', 'glm-5.3', 'USD', 'input-hit')).toBe('0.26');
    expect(rateIn('zhipu', 'glm-5', 'USD', 'input-miss')).toBe('1');
    expect(rateIn('moonshot', 'kimi-k3', 'CNY', 'output')).toBe('100');
    expect(rateIn('moonshot', 'kimi-k3', 'USD', 'output')).toBe('15');
    expect(rateIn('moonshot', 'kimi-k3', 'USD', 'input-write')).toBe('3');
    expect(rateIn('moonshot', 'kimi-k3', 'USD', 'input-hit')).toBe('0.3');
    expect(rateIn('moonshot', 'kimi-k2.7-code', 'USD', 'input-miss')).toBe('0.95');
    expect(rateIn('moonshot', 'kimi-k2.7-code-highspeed', 'USD', 'output')).toBe('8.00');
  });

  it('lets the currency the reader wants pick the list', () => {
    // `selectCurrency` keeps one list per model before the engine ever sees it,
    // which is what makes `--currency USD` show the international prices and
    // `--currency CNY` the Chinese ones — and an unquoted currency fall back to
    // the dollar list rather than to a mixture.
    const cases: [string, string, string][] = [
      ['zhipu', 'USD', 'USD'],
      ['zhipu', 'CNY', 'CNY'],
      ['zhipu', 'EUR', 'USD'],
      ['moonshot', 'CNY', 'CNY'],
      ['moonshot', 'EUR', 'USD'],
    ];
    for (const [id, wanted, expected] of cases) {
      const picked = selectCurrency(lookup(id), wanted);
      for (const model of picked.provider.models()) {
        expect([...new Set(model.periods.map((entry) => entry.currency))]).toEqual([expected]);
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
      }
    }
  });

  it('writes rates as decimal strings, never floats', () => {
    for (const id of ADDED) {
      for (const model of provider(id).models) {
        for (const entry of model.periods) {
          const cards = [entry.offPeak, ...(entry.inputTiers ?? []).flatMap((band) => [band.offPeak, band.peak ?? []])];
          for (const part of cards.flat()) {
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
    for (const model of ['gpt-5.5', 'gpt-5.3-codex']) {
      expect(components('openai', model)).toEqual(['input-miss', 'input-hit', 'output']);
    }
  });

  it('bills Kimi cache writes only on K3, and folds them into the miss price on K2', () => {
    // K3 publishes write columns; the K2 table does not, and the vendor's billing
    // formula is miss input + hit + output + cache storage, so writes are input.
    expect(components('moonshot', 'kimi-k3')).toEqual(['input-miss', 'input-hit', 'input-write', 'output']);
    expect(component('moonshot', 'kimi-k3', 'input-write').ttlMultipliers).toEqual({ '1h': '2' });
    // Both published lists carry the same write tier, so the basis does not
    // depend on which currency the reader asked for.
    expect(componentIn('moonshot', 'kimi-k3', 'USD', 'input-write').ttlMultipliers).toEqual({ '1h': '2' });
    for (const model of ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6']) {
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
    // graduated tranche is a different rule, so none of these cards carries one —
    // including the bands those whole-request tables are transcribed into.
    for (const id of ADDED) {
      for (const model of provider(id).models) {
        for (const entry of model.periods) {
          const cards = [entry.offPeak, ...(entry.inputTiers ?? []).flatMap((band) => [band.offPeak, band.peak ?? []])];
          for (const component of cards.flat()) {
            expect(component.aboveThreshold).toBeUndefined();
          }
        }
      }
    }
  });
});

describe('whole-request size tiers', () => {
  it('transcribes OpenAI\'s long-context row as a second whole-request band', () => {
    // The standard row is 4 / 0.4 / 5 / 20 and the >272K row 8 / 0.8 / 10 / 30;
    // the second reprices the whole request, so it is a band and not a tranche.
    expect(tiersIn('openai', 'gpt-5.6-sol', 'USD').map((band) => band.upTo)).toEqual([272_000, null]);
    expect(bandRates('openai', 'gpt-5.6-sol', 'USD', 0)).toEqual(['4', '0.4', '5', '20']);
    expect(bandRates('openai', 'gpt-5.6-sol', 'USD', 1)).toEqual(['8', '0.8', '10', '30']);
    // No other OpenAI row on the page has a second price for length.
    for (const model of provider('openai').models) {
      if (model.model === 'gpt-5.6-sol') continue;
      for (const entry of model.periods) expect(entry.inputTiers).toBeUndefined();
    }
  });

  it('bands the three Zhipu rows the Chinese page bands, and only those', () => {
    // GLM-5.1 6/24/1.3 → 8/28/2 and GLM-5 4/18/1 → 6/22/1.5, both entered at ≥32K.
    expect(tiersIn('zhipu', 'glm-5.1', 'CNY').map((band) => band.upTo)).toEqual([31_999, null]);
    expect(bandRates('zhipu', 'glm-5.1', 'CNY', 1)).toEqual(['8', '2', '28']);
    expect(bandRates('zhipu', 'glm-5', 'CNY', 1)).toEqual(['6', '1.5', '22']);
    // GLM-5.3 / 5.2 / 5.3-flash rows carry one price, so they stay single-card.
    for (const model of ['glm-5.3', 'glm-5.2', 'glm-5.3-flash']) {
      for (const entry of periods('zhipu', model)) expect(entry.inputTiers).toBeUndefined();
    }
  });

  it('transcribes GLM-4.7\'s three rows, output bound included', () => {
    const bands = tiersIn('zhipu', 'glm-4.7', 'CNY');
    expect(bands.map((band) => [band.upTo, band.outputUpTo ?? null])).toEqual([
      [31_999, 199],
      [31_999, null],
      [null, null],
    ]);
    expect([0, 1, 2].map((band) => bandRates('zhipu', 'glm-4.7', 'CNY', band))).toEqual([
      ['2', '0.4', '8'],
      ['3', '0.6', '14'],
      ['4', '0.8', '16'],
    ]);
  });

  it('keeps the dollar lists single-card, as Z.ai publishes them', () => {
    // The international table has no length bands, so `--currency USD` must not
    // inherit the Chinese site's tiers.
    for (const model of ['glm-5.1', 'glm-5', 'glm-4.7']) {
      expect(periodIn('zhipu', model, 'USD').inputTiers).toBeUndefined();
      expect(periodIn('zhipu', model, 'CNY').inputTiers).toBeDefined();
    }
  });

  it('splits the bands exactly where each vendor page does', () => {
    const zhipu = createPricingEngine(lookup('zhipu'));
    const bandOf = (input: number): number | undefined =>
      zhipu.resolve(record({ time: AT, model: 'glm-5', tokens: { ...emptyBuckets(), input } }))?.inputTier?.index;
    // The Chinese page puts exactly 32,000 in the ≥32K band.
    expect(bandOf(31_999)).toBe(0);
    expect(bandOf(32_000)).toBe(1);
    // OpenAI's page says >272K, so the bound itself stays on the standard card.
    const openai = createPricingEngine(lookup('openai'));
    const openaiBand = (input: number): number | undefined =>
      openai.resolve(record({ time: AT, model: 'gpt-5.6-sol', tokens: { ...emptyBuckets(), input } }))?.inputTier?.index;
    expect(openaiBand(272_000)).toBe(0);
    expect(openaiBand(272_001)).toBe(1);
  });

  it('reprices a whole request through the shipped CNY card', () => {
    const engine = createPricingEngine(lookup('zhipu'));
    const cost = (input: number): bigint | undefined =>
      engine.costOf(record({ time: AT, model: 'glm-5', tokens: { ...emptyBuckets(), input, output: 1_000 } }))?.total;
    // ≥32K: 32,000 × ¥6/M + 1,000 × ¥22/M, the whole request on the long card.
    expect(cost(32_000)).toBe(214_000_000n);
    // One token below the line the same request is much cheaper — and it is the
    // whole quantity that moved, not the 1 token over it.
    expect(cost(31_999)).toBe(145_996_000n);
  });

  it('converts a band\'s rates with the rest of the card', () => {
    // `convertProvider` rewrites published rates into the display currency. A
    // band's card is a rate card, so leaving it behind would bill the long band
    // in the vendor's own currency: $8 / $0.8 / 7 → ¥56 / ¥5.6.
    const cny = createPricingEngine(convertProvider(lookup('openai'), currencyOf('CNY'), '7'));
    const long = cny.resolve(record({ time: AT, model: 'gpt-5.6-sol', tokens: { ...emptyBuckets(), input: 300_000 } }));
    expect(long?.components.map((entry) => entry.rate)).toEqual(['56', '5.6', '70', '210']);
    const short = cny.resolve(record({ time: AT, model: 'gpt-5.6-sol', tokens: { ...emptyBuckets(), input: 1_000 } }));
    expect(short?.components.map((entry) => entry.rate)).toEqual(['28', '2.8', '35', '140']);
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

  it('prices the same request out of either published list', () => {
    // The reader's currency chooses the list before the engine runs, so the same
    // record costs ¥142 on the Chinese list and $21.30 on the international one
    // for Kimi K3, and ¥8 / $1.40 for one million GLM-5.3 cache writes.
    const kimiCny = createPricingEngine(selectCurrency(lookup('moonshot'), 'CNY').provider);
    const kimiUsd = createPricingEngine(selectCurrency(lookup('moonshot'), 'USD').provider);
    const kimiTokens = { ...emptyBuckets(), input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 };
    expect(kimiCny.costOf(record({ time: AT, model: 'kimi-k3', tokens: kimiTokens }))?.total).toBe(142_000_000_000n);
    expect(kimiUsd.costOf(record({ time: AT, model: 'kimi-k3', tokens: kimiTokens }))?.total).toBe(21_300_000_000n);

    const glmCny = createPricingEngine(selectCurrency(lookup('zhipu'), 'CNY').provider);
    const glmUsd = createPricingEngine(selectCurrency(lookup('zhipu'), 'USD').provider);
    const write = { ...emptyBuckets(), cacheWrite: 1_000_000 };
    expect(glmCny.costOf(record({ time: AT, model: 'glm-5.3', tokens: write }))?.total).toBe(8_000_000_000n);
    expect(glmUsd.costOf(record({ time: AT, model: 'glm-5.3', tokens: write }))?.total).toBe(1_400_000_000n);
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

describe('size-band validation', () => {
  /** A minimal document whose one period carries the given bands and extras. */
  function documentWith(inputTiers: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      updatedAt: '2026-10-04',
      note: null,
      providers: [
        {
          id: 'p',
          label: 'P',
          models: [
            {
              model: 'm',
              aliases: ['m'],
              periods: [
                {
                  id: 'snap',
                  label: 'snap',
                  from: '2026-01-01T00:00:00Z',
                  to: null,
                  currency: 'USD',
                  offPeak: [],
                  inputTiers,
                  source: 'https://example.com/pricing',
                  note: 'test',
                  ...extra,
                },
              ],
            },
          ],
        },
      ],
    };
  }

  /** One band, as the file writes it. */
  function band(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      label: 'band',
      upTo: null,
      offPeak: [{ id: 'input-miss', label: 'miss', basis: 'input', rate: '1', per: 1_000_000 }],
      ...overrides,
    };
  }

  it('reads the bands the two vendors publish, and refuses an empty list', () => {
    const config = parsePricingConfig(
      documentWith([band({ label: '输入 <32K', upTo: 31_999 }), band({ label: '输入 ≥32K' })]),
    );
    expect(config.providers[0]?.models[0]?.periods[0]?.inputTiers?.map((tier) => tier.upTo)).toEqual([31_999, null]);
    // Not a silent no-op: an empty list would leave the period with no rates.
    expect(() => parsePricingConfig(documentWith([]))).toThrow(/inputTiers 至少要写一档/);
    // Both bounds are positive integers, and `upTo` is required.
    expect(() => parsePricingConfig(documentWith([band({ upTo: 'all' })]))).toThrow(/应为数字/);
    expect(() => parsePricingConfig(documentWith([band({ upTo: 0 })]))).toThrow(/应为正整数/);
    expect(() => parsePricingConfig(documentWith([{ label: 'band', offPeak: [] }]))).toThrow(/缺少字段 upTo/);
  });

  it('insists the last band is open and no band is shadowed', () => {
    // Open bands cover every larger request, so only the last one may be open.
    expect(() => parsePricingConfig(documentWith([band({ upTo: 1_000 })]))).toThrow(/最后一档必须是开区间/);
    expect(() =>
      parsePricingConfig(documentWith([band({ upTo: null }), band({ upTo: 1_000 })])),
    ).toThrow(/最后一档必须是开区间/);
    // Ascending bounds are the ordinary partition, and the open band closes it.
    const ascending = [band({ upTo: 1_000 }), band({ upTo: 32_000 }), band()];
    expect(parsePricingConfig(documentWith(ascending)).providers[0]?.models[0]?.periods[0]?.inputTiers).toHaveLength(3);
    // A band an earlier one already covers entirely could never match. With the
    // open band pinned last, that is a shared input bound whose output bound does
    // not widen — GLM-4.7's three rows are the live case in the other direction.
    const shared = [band({ upTo: 31_999, outputUpTo: 199 }), band({ upTo: 31_999 }), band()];
    expect(parsePricingConfig(documentWith(shared)).providers[0]?.models[0]?.periods[0]?.inputTiers).toHaveLength(3);
    expect(() =>
      parsePricingConfig(
        documentWith([band({ upTo: 31_999 }), band({ upTo: 31_999, outputUpTo: 199 }), band()]),
      ),
    ).toThrow(/分档要按上界升序/);
  });

  it('replaces the period card and keeps the peak rule consistent', () => {
    const component = band().offPeak as unknown[];
    // The bands are the rate card, so the period must not carry a second one.
    expect(() =>
      parsePricingConfig(documentWith([band()], { offPeak: component })),
    ).toThrow(/写了 inputTiers 就不能再写 offPeak\/peak/);
    // The windows stay period-level (they are the clock rule) and each band
    // answers them with its own peak card, so a band without one is an error…
    const windows = [{ fromHour: 9, toHour: 12, weekdays: null }];
    expect(() => parsePricingConfig(documentWith([band()], { peakWindows: windows }))).toThrow(
      /档位的 peak 要和区间的 peakWindows 一致/,
    );
    // …and a band with a peak card but no windows is too.
    expect(() => parsePricingConfig(documentWith([band({ peak: component })]))).toThrow(
      /档位的 peak 要和区间的 peakWindows 一致/,
    );
    const both = documentWith([band({ peak: component })], { peakWindows: windows });
    expect(parsePricingConfig(both).providers[0]?.models[0]?.periods[0]?.inputTiers?.[0]?.peak).toHaveLength(1);
  });
});
