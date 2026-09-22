/**
 * The pricing registry.
 *
 * Vendors are data, not code: every provider comes from `config/pricing.json`,
 * which ships with the tool and can be fetched at run time. Adding a vendor is a
 * matter of adding an entry there — the CLI, the accounting layer and the reports
 * pick it up automatically and `price --provider` starts listing it.
 */

import { UserError } from '../i18n/errors.ts';
import { shippedProviders } from '../config/pricing.ts';
import type { PricingProvider } from './contract.ts';

/** Every pricing provider this build knows about, in display order. */
export const PRICING_PROVIDERS: readonly PricingProvider[] = shippedProviders();

/** Provider used when the user does not name one. */
export const DEFAULT_PRICING_PROVIDER = PRICING_PROVIDERS[0]?.id ?? 'deepseek';

/**
 * Look up a pricing provider.
 * @param id - provider id, matched case-insensitively.
 * @returns the provider, or `undefined` when this build has no such vendor.
 */
export function findPricingProvider(id: string, providers: readonly PricingProvider[] = PRICING_PROVIDERS): PricingProvider | undefined {
  const wanted = id.trim().toLowerCase();
  return providers.find((provider) => provider.id.toLowerCase() === wanted);
}

/**
 * Look up a pricing provider, failing loudly.
 * @param id - provider id.
 * @returns the provider.
 * @throws when the id is unknown, listing what is available.
 */
export function requirePricingProvider(id: string, providers: readonly PricingProvider[] = PRICING_PROVIDERS): PricingProvider {
  const provider = findPricingProvider(id, providers);
  if (provider === undefined) {
    const known = providers.map((candidate) => candidate.id).join('、');
    throw new UserError('unknownProvider', { id, known });
  }
  return provider;
}

/**
 * Choose a pricing provider for a dataset.
 *
 * The dataset records which agent produced it, and providers may declare which
 * agents they are the natural default for. Until a second provider exists this
 * simply resolves to the built-in default, but the seam is here so that adding
 * one does not require touching call sites.
 * @param requested - an explicit `--provider` value, when given.
 * @param agent - the agent id the dataset came from, when known.
 * @returns the provider to price with.
 */
export function resolvePricingProvider(
  requested: string | undefined,
  agent?: string,
  providers: readonly PricingProvider[] = PRICING_PROVIDERS,
): PricingProvider {
  if (requested !== undefined) return requirePricingProvider(requested, providers);
  void agent;
  return requirePricingProvider(providers[0]?.id ?? DEFAULT_PRICING_PROVIDER, providers);
}
