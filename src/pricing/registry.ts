/**
 * The pricing registry.
 *
 * Vendors are data, not code: every provider comes from `config/pricing.json`,
 * which ships with the tool and can be fetched at run time. Adding a vendor is a
 * matter of adding an entry there — the CLI, the accounting layer and the reports
 * pick it up automatically, `price --provider` starts listing it, and a record
 * naming one of its models is priced by it without any call site changing.
 *
 * Which table a *record* is priced with is {@link createRoutingEngine}'s job: the
 * model in the record decides, not the agent that wrote the log, because an agent
 * is a harness rather than a vendor.
 */

import { UserError } from '../i18n/errors.ts';
import { shippedProviders } from './catalog.ts';
import type { PricingProvider } from './contract.ts';

/** Every pricing provider this build knows about, in display order. */
export const PRICING_PROVIDERS: readonly PricingProvider[] = shippedProviders();

/** Provider used when nothing else names one (`price` without `--provider`). */
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
 * The engine that prices each record with the table that knows its model.
 *
 * Re-exported here because handing out pricing engines is what this module is for;
 * the implementation and its options live in `routing.ts`.
 */
export { createRoutingEngine, isRoutingEngine, type RoutingEngine, type RoutingOptions } from './routing.ts';
