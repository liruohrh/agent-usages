/**
 * Provider resolution, now that there is more than one vendor.
 *
 * Two axes meet here: a dataset knows which *agent* produced its records, and a
 * provider declares which agents it is the natural default for. The order is
 * pinned below — explicit flag, then the claiming provider, then the first one —
 * plus the warning that keeps a mixed run from reading as one vendor's total.
 */

import { describe, expect, it } from 'vitest';

import { parsePricingConfig, providerFromConfig, type ProviderConfig } from '../../src/pricing/catalog.ts';
import type { PricingProvider } from '../../src/pricing/contract.ts';
import { mixedAgentPricingWarning, resolvePricingProvider } from '../../src/pricing/registry.ts';

/** A flat rate card: these vendors publish one price, not a peak/off-peak pair. */
const PERIOD = {
  id: '2026-01-01',
  label: 'flat',
  from: '2026-01-01T00:00:00Z',
  to: null,
  currency: 'USD',
  offPeak: [{ id: 'input-miss', label: 'input', basis: 'input', rate: '1', per: 1000000 }],
  source: 'https://example.invalid/pricing',
  note: 'fixture',
};

/** Three providers, each claiming the agent it belongs to. */
const DOCUMENT = {
  version: 1,
  updatedAt: '2026-10-04',
  providers: [
    {
      id: 'deepseek',
      label: 'DeepSeek',
      defaultModel: 'deepseek-flash',
      defaultFor: ['dsh'],
      models: [{ model: 'deepseek-flash', aliases: [], periods: [PERIOD] }],
    },
    {
      id: 'openai',
      label: 'OpenAI',
      defaultModel: 'gpt-5.5',
      defaultFor: ['codex'],
      models: [{ model: 'gpt-5.5', aliases: [], periods: [PERIOD] }],
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      defaultModel: null,
      defaultFor: ['claude'],
      models: [{ model: 'claude-opus-5', aliases: [], periods: [PERIOD] }],
    },
  ],
};

const CONFIG = parsePricingConfig(DOCUMENT);
const PROVIDERS: readonly PricingProvider[] = CONFIG.providers.map(providerFromConfig);

describe('resolvePricingProvider', () => {
  it('prices a single-agent dataset with the vendor that claims it', () => {
    expect(resolvePricingProvider(undefined, 'codex', PROVIDERS).id).toBe('openai');
    expect(resolvePricingProvider(undefined, 'claude', PROVIDERS).id).toBe('anthropic');
    expect(resolvePricingProvider(undefined, 'dsh', PROVIDERS).id).toBe('deepseek');
  });

  it('is not case- or space-sensitive about the agent id', () => {
    expect(resolvePricingProvider(undefined, '  CODEX ', PROVIDERS).id).toBe('openai');
  });

  it('keeps the first provider for an agent nobody claims', () => {
    // `pi` runs any vendor's models, so there is no natural default — and the
    // first provider is what the tool used before vendors had a say.
    expect(resolvePricingProvider(undefined, 'pi', PROVIDERS).id).toBe('deepseek');
    expect(resolvePricingProvider(undefined, 'all', PROVIDERS).id).toBe('deepseek');
    expect(resolvePricingProvider(undefined, undefined, PROVIDERS).id).toBe('deepseek');
  });

  it('lets an explicit --provider win over the agent', () => {
    expect(resolvePricingProvider('anthropic', 'codex', PROVIDERS).id).toBe('anthropic');
    expect(resolvePricingProvider('openai', undefined, PROVIDERS).id).toBe('openai');
  });

  it('still fails loudly on an unknown provider id', () => {
    expect(() => resolvePricingProvider('nope', 'codex', PROVIDERS)).toThrow(/未知的计价来源|unknown pricing provider/);
  });
});

describe('mixedAgentPricingWarning', () => {
  const deepseek = PROVIDERS[0]!;

  it('speaks up when several agents share one rate card', () => {
    const warning = mixedAgentPricingWarning(['claude', 'codex'], deepseek, undefined);
    expect(warning?.code).toBe('pricingMixedAgents');
    expect(warning?.message).toContain('DeepSeek');
  });

  it('stays quiet for a single agent, an empty run, or an explicit provider', () => {
    expect(mixedAgentPricingWarning(['codex'], deepseek, undefined)).toBeUndefined();
    expect(mixedAgentPricingWarning([], deepseek, undefined)).toBeUndefined();
    expect(mixedAgentPricingWarning(['claude', 'codex'], deepseek, 'deepseek')).toBeUndefined();
  });
});

describe('defaultFor in the configuration file', () => {
  it('parses, and is empty when the file says nothing', () => {
    expect(CONFIG.providers.map((provider) => provider.defaultFor)).toEqual([['dsh'], ['codex'], ['claude']]);
    const bare = parsePricingConfig({
      version: 1,
      updatedAt: '2026-10-04',
      providers: [{ id: 'solo', label: 'Solo', defaultModel: null, models: [{ model: 'm', aliases: [], periods: [PERIOD] }] }],
    });
    expect(bare.providers[0]!.defaultFor).toEqual([]);
    const solo: readonly PricingProvider[] = bare.providers.map(providerFromConfig);
    expect(resolvePricingProvider(undefined, 'codex', solo).id).toBe('solo');
  });

  it('rejects a value that is not a list of agent ids', () => {
    const withDefaultFor = (defaultFor: unknown): ProviderConfig[] =>
      parsePricingConfig({
        version: 1,
        updatedAt: '2026-10-04',
        providers: [
          { id: 'solo', label: 'Solo', defaultModel: null, defaultFor, models: [{ model: 'm', aliases: [], periods: [PERIOD] }] },
        ],
      }).providers;
    expect(() => withDefaultFor('codex')).toThrow(/defaultFor/);
    expect(() => withDefaultFor([''])).toThrow(/defaultFor\[0\]/);
  });
});
