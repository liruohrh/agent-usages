/**
 * User-configuration tests.
 *
 * The merge is the part worth pinning: a user overrides one price window, and
 * everything else must survive untouched — the vendor's other periods, their
 * notes, their sources, and the open end of the timeline.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePricingConfig, providerFromConfig, shippedProviders } from '../../src/config/pricing.ts';
import { readFileSync } from 'node:fs';
import { mergePeriods, mergeProviders, readUserConfig, updateUserConfig, validateUserPatch } from '../../src/config/user.ts';
import { userConfigPath as userConfigPathOf } from '../../src/config/paths.ts';
import type { BillingBasis, PricePeriod, RateComponent } from '../../src/pricing/contract.ts';
import { createPricingEngine } from '../../src/pricing/index.ts';
import { record } from '../support/dataset.ts';

/** A temporary config directory with an optional config.json in it. */
function withConfig(document: unknown | undefined): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'agent-usages-user-'));
  const configDir = join(dir, 'agent-usages');
  mkdirSync(configDir, { recursive: true });
  if (document !== undefined) {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(document), 'utf8');
  }
  return { ...process.env, XDG_CONFIG_HOME: dir };
}

/** The shipped provider entry, for merging against. */
function shippedConfig() {
  return parsePricingConfig(readFileSync(new URL('../../config/pricing.json', import.meta.url), 'utf8'));
}

/** The yuan history of the Flash model, which the assertions are written for. */
function flashPeriods() {
  return shippedProviders()[0]!.find('deepseek-flash')!.periods.filter((period) => period.currency === 'CNY');
}

/** A user period that replaces one window with its own price, in domain shape. */
function overridePeriod(from: string, to: string | null, rate: string): PricePeriod {
  const component = (id: string, label: string, basis: BillingBasis, value: string): RateComponent => ({
    id,
    label,
    basis,
    rate: value,
    per: 1_000_000,
  });
  return {
    id: 'user-price',
    label: '用户自定义价',
    from: Date.parse(from),
    to: to === null ? null : Date.parse(to),
    utcOffset: 480,
    currency: 'CNY',
    offPeak: [
      component('input-hit', '缓存命中输入', 'cacheRead', rate),
      component('input-miss', '缓存未命中输入', 'inputAndCacheWrite', '1'),
      component('output', '输出', 'output', '2'),
    ],
    peak: null,
    peakWindows: [],
    source: 'https://example.com/user',
    note: '用户配置',
  };
}

/** The same period as the configuration file would spell it: ISO text, not instants. */
function overridePeriodText(from: string, to: string | null, rate: string): Record<string, unknown> {
  return { ...overridePeriod(from, to, rate), from, to };
}

describe('readUserConfig', () => {
  it('falls back to the defaults when there is no file', () => {
    const { config, warnings } = readUserConfig(withConfig(undefined));
    expect(warnings).toEqual([]);
    expect(config.pricing).toEqual([]);
    expect(config.updates).toEqual({ pricing: true, rates: false });
    expect(config.currency).toBeUndefined();
  });

  it('reads currency, switches and price overrides', () => {
    const { config, warnings } = readUserConfig(
      withConfig({
        version: 1,
        currency: 'usd',
        rateSource: 'er-api',
        updates: { rates: true, pricing: false },
        pricing: {
          version: 1,
          updatedAt: '2026-09-21',
          providers: [
            {
              id: 'deepseek',
              label: 'DeepSeek',
              defaultModel: 'deepseek-flash',
              models: [
                {
                  model: 'deepseek-flash',
                  aliases: ['deepseek-flash'],
                  periods: [overridePeriodText('2026-09-10T12:00:00+08:00', null, '0.01')],
                },
              ],
            },
          ],
        },
      }),
    );
    expect(warnings).toEqual([]);
    expect(config.currency).toBe('USD');
    expect(config.rateSource).toBe('er-api');
    expect(config.updates).toEqual({ pricing: false, rates: true });
    expect(config.pricing[0]?.models[0]?.periods[0]?.offPeak[0]?.rate).toBe('0.01');
  });

  it('warns and ignores a broken file instead of failing the command', () => {
    const { config, warnings } = readUserConfig(withConfig({ version: 1, currency: 'dollars' }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/忽略用户配置.*currency/);
    expect(config.currency).toBeUndefined();
    expect(config.updates).toEqual({ pricing: true, rates: false });
  });

  it('warns about a file that is not JSON at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-usages-user-'));
    mkdirSync(join(dir, 'agent-usages'), { recursive: true });
    writeFileSync(join(dir, 'agent-usages', 'config.json'), '{oops', 'utf8');
    const { warnings } = readUserConfig({ ...process.env, XDG_CONFIG_HOME: dir });
    expect(warnings[0]?.message).toMatch(/不是合法 JSON/);
  });

  it('reads configured projects, expanding ~ and making paths absolute', () => {
    const env = withConfig({
      version: 1,
      projects: [{ name: 'Memolink', paths: ['~/ws/apps/Memolink', '/abs/other'] }],
    });
    const { config, warnings } = readUserConfig(env);
    expect(warnings).toEqual([]);
    expect(config.projects).toEqual([
      { name: 'Memolink', paths: [join(env['HOME'] as string, 'ws/apps/Memolink'), '/abs/other'] },
    ]);
  });

  it('rejects a project without a name, and reports which entry it was', () => {
    const { config, warnings } = readUserConfig(
      withConfig({ version: 1, projects: [{ name: 'ok', paths: ['/tmp/a'] }, { paths: ['/tmp/b'] }] }),
    );
    expect(config.projects).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/projects\[1\]\.name/);
    expect(warnings[0]?.message).toMatch(/项目名/);
  });

  it('rejects a project whose paths are missing, empty, or not strings', () => {
    for (const entry of [{ name: 'x' }, { name: 'x', paths: [] }, { name: 'x', paths: ['/tmp/a', 42] }]) {
      const { config, warnings } = readUserConfig(withConfig({ version: 1, projects: [entry] }));
      expect(config.projects).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toMatch(/projects\[0\]\.paths/);
    }
  });

  it('rejects a projects section that is not an array at all', () => {
    const { warnings } = readUserConfig(withConfig({ version: 1, projects: { name: 'x' } }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/projects: 应为数组/);
  });
});

describe('mergePeriods', () => {
  it('gives the user their window and the vendor everything else', () => {
    const base = flashPeriods();
    const merged = mergePeriods(base, [overridePeriod('2026-09-01T00:00:00+08:00', '2026-09-15T00:00:00+08:00', '0.01')]);
    const inUserWindow = merged.find((period) => period.from === Date.parse('2026-09-01T00:00:00+08:00'));
    expect(inUserWindow?.offPeak[0]?.rate).toBe('0.01');
    // The vendor's own period still covers everything after the user's window.
    const after = merged.find((period) => period.label.includes('V4.1-Flash'));
    expect(after?.to).toBeNull();
    // And the timeline is still contiguous.
    for (let index = 1; index < merged.length; index += 1) {
      expect(merged[index]?.from).toBe(merged[index - 1]?.to);
    }
  });

  it('cuts the vendor period the user window falls inside, keeping the rest', () => {
    const base = flashPeriods();
    const merged = mergePeriods(base, [overridePeriod('2026-05-01T00:00:00+08:00', '2026-06-01T00:00:00+08:00', '0.5')]);
    const cut = merged.filter((period) => period.id.startsWith('2026-04-26'));
    expect(cut.length).toBeGreaterThan(0);
    for (const period of cut) {
      // A cut piece is a fragment, not the published period.
      expect(period.note).toMatch(/合并出的片段/);
      expect(period.id).toContain('#');
    }
    const pieces = merged.filter((period) => period.label === '用户自定义价');
    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.from).toBe(Date.parse('2026-05-01T00:00:00+08:00'));
    expect(pieces[0]?.to).toBe(Date.parse('2026-06-01T00:00:00+08:00'));
  });

  it('keeps a period that already matches the window whole', () => {
    const base = flashPeriods();
    const target = base[0]!;
    const replacement = { ...overridePeriod('2026-01-01T00:00:00+08:00', '2026-04-24T00:00:00+08:00', '9'), id: 'mine' };
    const merged = mergePeriods(base, [replacement]);
    const replaced = merged.find((period) => period.from === target.from);
    expect(replaced?.id).toBe('mine');
    expect(replaced?.to).toBe(target.to);
  });

  it('extends the timeline when the user prices an earlier window', () => {
    const base = flashPeriods();
    const merged = mergePeriods(base, [overridePeriod('2025-01-01T00:00:00+08:00', '2026-01-01T00:00:00+08:00', '7')]);
    expect(merged[0]?.from).toBe(Date.parse('2025-01-01T00:00:00+08:00'));
    expect(merged[0]?.to).toBe(Date.parse('2026-01-01T00:00:00+08:00'));
    expect(merged[1]?.from).toBe(Date.parse('2026-01-01T00:00:00+08:00'));
    // The vendor's last period still runs to the end of time.
    expect(merged[merged.length - 1]?.to).toBeNull();
  });

  it('leaves the base alone when the user overrides nothing', () => {
    const base = flashPeriods();
    expect(mergePeriods(base, [])).toEqual([...base]);
  });
});

describe('mergeProviders', () => {
  it('merges into the named model without touching the other', () => {
    const base = shippedConfig().providers;
    const overrides = [
      {
        id: 'deepseek',
        label: 'DeepSeek',
        defaultModel: 'deepseek-flash',
        models: [
          {
            model: 'deepseek-flash',
            aliases: ['my-flash'],
            periods: [overridePeriod('2026-09-10T12:00:00+08:00', null, '0.01')],
          },
        ],
      },
    ];
    const merged = mergeProviders(base, overrides);
    const flash = merged[0]!.models.find((model) => model.model === 'deepseek-flash')!;
    expect(flash.aliases).toContain('my-flash');
    expect(flash.aliases).toContain('deepseek-chat');
    expect(merged[0]!.models.find((model) => model.model === 'deepseek-v4-pro')!.periods).toEqual(
      base[0]!.models.find((model) => model.model === 'deepseek-v4-pro')!.periods,
    );
  });

  it('prices an overridden window through the engine', () => {
    const base = shippedConfig().providers;
    const merged = mergeProviders(base, [
      {
        id: 'deepseek',
        label: 'DeepSeek',
        defaultModel: 'deepseek-flash',
        models: [
          {
            model: 'deepseek-flash',
            aliases: ['deepseek-flash'],
            periods: [overridePeriod('2026-09-01T00:00:00+08:00', '2026-09-15T00:00:00+08:00', '0.01')],
          },
        ],
      },
    ]);
    const engine = createPricingEngine(providerFromConfig(merged[0]!));
    const at = (time: string) =>
      engine.resolve(record({ time: Date.parse(time), model: 'deepseek-flash' }))?.period.offPeak[0]?.rate;
    expect(at('2026-09-05T00:00:00+08:00')).toBe('0.01');
    // Outside the user's window the vendor's published price still applies.
    expect(at('2026-09-20T00:00:00+08:00')).toBe('0.02');
  });
});

describe('updateUserConfig', () => {
  it('sets the one key and leaves every other setting alone', () => {
    const env = withConfig({ projects: [{ name: 'demo', paths: ['/tmp/demo'] }], rateMode: 'historical' });
    const written = updateUserConfig({ language: 'en' }, env);
    expect(written.path.endsWith(join('agent-usages', 'config.json'))).toBe(true);

    const after = JSON.parse(readFileSync(written.path, 'utf8')) as Record<string, unknown>;
    expect(after['language']).toBe('en');
    // A language switch must never cost the user their project groups.
    expect(after['projects']).toEqual([{ name: 'demo', paths: ['/tmp/demo'] }]);
    expect(after['rateMode']).toBe('historical');
    expect(readUserConfig(env).config.language).toBe('en');
  });

  it('creates the file and its directory when there is none', () => {
    const env = withConfig(undefined);
    const written = updateUserConfig({ language: 'zh' }, env);
    expect(JSON.parse(readFileSync(written.path, 'utf8'))).toEqual({ language: 'zh' });
  });

  it('refuses to overwrite a file it cannot parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-usages-user-'));
    const configDir = join(dir, 'agent-usages');
    mkdirSync(configDir, { recursive: true });
    const path = join(configDir, 'config.json');
    writeFileSync(path, '{ this is not json', 'utf8');
    expect(() => updateUserConfig({ language: 'en' }, { ...process.env, XDG_CONFIG_HOME: dir })).toThrow(/不是合法 JSON/);
    // The broken file is still there, exactly as the user typed it.
    expect(readFileSync(path, 'utf8')).toBe('{ this is not json');
  });

  it('refuses a file whose root is not an object', () => {
    const env = withConfig([1, 2, 3]);
    expect(() => updateUserConfig({ language: 'en' }, env)).toThrow(/not a JSON object/);
  });
});

describe('validateUserPatch', () => {
  const env = { ...process.env, HOME: '/home/tester' };

  it('accepts what the file readers accept', () => {
    expect(() =>
      validateUserPatch(
        {
          currency: 'cny',
          rateMode: 'historical',
          rateSource: 'ecb',
          updates: { rates: true },
          projects: [{ name: 'demo', paths: ['~/ws/demo', '/abs/other'] }],
        },
        env,
      ),
    ).not.toThrow();
  });

  it('names the field it rejected, the way the file reader would', () => {
    // The types stop a caller at compile time; these cast past them, because a
    // JSON body arrives as `unknown` whatever the types say.
    const loose = (patch: Record<string, unknown>): (() => void) => () => validateUserPatch(patch, env);
    expect(loose({ currency: 'yuan' })).toThrow(/currency: /);
    expect(loose({ rateMode: 'sometimes' })).toThrow(/rateMode: /);
    expect(loose({ updates: { pricing: 'yes' } })).toThrow(/updates\.pricing: /);
    expect(loose({ projects: [{ name: 'demo', paths: [] }] })).toThrow(/projects\[0\]\.paths: /);
  });

  it('reads a null as "remove the key"', () => {
    const env2 = withConfig({ currency: 'USD', rateSource: 'ecb', language: 'zh' });
    expect(() => validateUserPatch({ currency: null, rateSource: null }, env2)).not.toThrow();
    updateUserConfig({ currency: null, rateSource: null }, env2);
    const after = JSON.parse(readFileSync(userConfigPathOf(env2), 'utf8')) as Record<string, unknown>;
    expect(after).toEqual({ language: 'zh' });
  });

  it('checks only the keys it was given', () => {
    // A file whose `projects` is broken must still accept a language change: the
    // readers are per key, exactly as they are for the file.
    expect(() => validateUserPatch({ language: 'en' }, env)).not.toThrow();
  });
});
