/**
 * The configuration a command actually runs on.
 *
 * Three layers, in order of authority: the user's own file, the freshest
 * configuration available (a fetched copy when there is one, otherwise the file
 * shipped with this build), and nothing else. Assembling them in one place means
 * every command sees the same prices and the same rates, and that a broken layer
 * degrades to the one below it instead of failing the run.
 */

import type { PricingProvider } from '../pricing/contract.ts';
import type { RateTable } from '../pricing/currency.ts';
import { mergeProviders, readUserConfig, type UpdateSettings } from './user.ts';
import { parsePricingConfig, providerFromConfig, shippedPricingText, validateProviders, type ProviderConfig } from './pricing.ts';
import { parseRatesConfig, shippedRatesText, type RatesConfig } from './rates.ts';
import { cachedConfigText, runUpdates, type UpdateKind } from './update.ts';

/** Everything a command needs from the configuration. */
export interface ResolvedConfig {
  /** Providers to price with, user overrides already merged in. */
  providers: PricingProvider[];
  /** Rates to convert with. */
  rateTable: RateTable;
  /** Sources available for a rate refresh, in order. */
  rateSources: RatesConfig['sources'];
  /** Currency the user pinned, if any. */
  currency: string | undefined;
  /** Rate source the user prefers, if any. */
  rateSource: string | undefined;
  /** Which automatic updates are allowed. */
  updates: UpdateSettings;
  /** Anything worth showing about how the configuration was put together. */
  warnings: string[];
}

/** What the caller knows about the run. */
export interface ResolveOptions {
  /** Environment to resolve paths from. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Skip the network entirely (`--no-update`). */
  noUpdate?: boolean | undefined;
  /** Ignore the once-a-day rule (`update --force`). */
  force?: boolean | undefined;
  /** Injectable clock, for tests. */
  now?: Date | undefined;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch | undefined;
  /** Restrict which kinds may refresh; only `update` passes this. */
  kinds?: readonly UpdateKind[] | undefined;
}

/** Parse the price configuration from whichever layer is freshest. */
function pricingProviders(env: NodeJS.ProcessEnv, warnings: string[]): ProviderConfig[] {
  const cached = cachedConfigText('pricing', env);
  if (cached !== undefined) {
    try {
      return parsePricingConfig(cached).providers;
    } catch (error) {
      warnings.push(`已缓存的价目表不可用，改用随包版本：${(error as Error).message}`);
    }
  }
  return parsePricingConfig(shippedPricingText()).providers;
}

/** Parse the rate configuration from whichever layer is freshest. */
function ratesConfig(env: NodeJS.ProcessEnv, warnings: string[]): RatesConfig {
  const cached = cachedConfigText('rates', env);
  if (cached !== undefined) {
    try {
      return parseRatesConfig(cached);
    } catch (error) {
      warnings.push(`已缓存的汇率表不可用，改用随包版本：${(error as Error).message}`);
    }
  }
  return parseRatesConfig(shippedRatesText());
}

/**
 * Assemble the configuration a command should use.
 *
 * Updating is best-effort and happens before reading, so a successful refresh is
 * visible to the very command that triggered it. A failure is silent here: the
 * fallback chain covers it, and `update` is where a user asks about it.
 * @param options - environment, network switches, injectable clock and fetch.
 * @returns the configuration, with the user's overrides merged in.
 */
export async function resolveConfig(options: ResolveOptions = {}): Promise<ResolvedConfig> {
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const user = readUserConfig(env);
  warnings.push(...user.warnings);

  if (options.noUpdate !== true) {
    await runUpdates(user.config.updates, {
      env,
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
    });
  }

  const base = pricingProviders(env, warnings);
  const merged = user.config.pricing.length === 0 ? base : mergeProviders(base, user.config.pricing);
  let providers: ProviderConfig[];
  try {
    // Re-checking the merged result with the domain rules — not the file parser,
    // which expects ISO text where the merge works in instants — is what
    // guarantees an override cannot leave a hole or an overlap behind.
    validateProviders(merged);
    providers = merged;
  } catch (error) {
    warnings.push(`用户价格配置与默认表合并失败，改用默认表：${(error as Error).message}`);
    providers = base;
  }

  const rates = ratesConfig(env, warnings);
  return {
    providers: providers.map(providerFromConfig),
    rateTable: {
      base: rates.base,
      rates: rates.table,
      provenance: { source: `内置汇率表 ${rates.source}`, date: rates.updatedAt },
    },
    rateSources: rates.sources,
    currency: user.config.currency,
    rateSource: user.config.rateSource,
    updates: user.config.updates,
    warnings,
  };
}
