/**
 * The pricing registry.
 *
 * Vendors are data, not code: every provider comes from `config/pricing.json`,
 * which ships with the tool and can be fetched at run time. Adding a vendor is a
 * matter of adding an entry there — the CLI, the accounting layer and the reports
 * pick it up automatically and `price --provider` starts listing it.
 */

import { UserError, type Warning } from '../i18n/errors.ts';
import { shippedProviders } from './catalog.ts';
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
  // The two axes meet here: the dataset says which agent produced the usage, and a
  // provider declares which agents it is the natural default for. A single-agent run
  // gets that vendor's rates; anything else keeps the first provider, and
  // {@link mixedAgentPricingWarning} says so rather than quietly billing one vendor's
  // rates for another's tokens.
  const wanted = agent?.trim().toLowerCase() ?? '';
  const claimed =
    wanted.length === 0
      ? undefined
      : providers.find((provider) => (provider.defaultFor ?? []).some((id) => id.trim().toLowerCase() === wanted));
  if (claimed !== undefined) return claimed;
  return requirePricingProvider(providers[0]?.id ?? DEFAULT_PRICING_PROVIDER, providers);
}

/**
 * A warning when one run mixes agents but prices them all with one rate card.
 *
 * Vendors publish different rates, so `dsh + codex + claude` costed with the
 * DeepSeek table is not "the cost": the token lines are still right, the money is
 * one vendor's opinion. This says which table was used and how to split the run —
 * a warning rather than an error, because a merged run is a legitimate question.
 * @param agents - the agent ids in the dataset, in display order.
 * @param provider - the provider the run ended up using.
 * @param requested - the explicit `--provider`, when the caller named one.
 * @returns the warning, or `undefined` when there is nothing to say.
 */
export function mixedAgentPricingWarning(
  agents: readonly string[],
  provider: PricingProvider,
  requested: string | undefined,
): Warning | undefined {
  if (requested !== undefined || agents.length <= 1) return undefined;
  return new UserError('pricingMixedAgents', { agents: agents.join(', '), provider: provider.label });
}
