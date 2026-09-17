/**
 * Pricing: the second extension axis.
 *
 * - `contract.ts` — what a pricing provider must implement.
 * - `engine.ts`   — the vendor-neutral period/tier resolution and arithmetic.
 * - `registry.ts` — which providers this build ships.
 * - `vendors/`    — one module per vendor's published price list.
 */

export * from './contract.ts';
export {
  bareModelName,
  basisQuantity,
  charge,
  counterForBasis,
  createPricingEngine,
  formatInstant,
  isPeak,
  parseRate,
  zoneTime,
  type ZoneTime,
} from './engine.ts';
export {
  DEFAULT_PRICING_PROVIDER,
  PRICING_PROVIDERS,
  findPricingProvider,
  requirePricingProvider,
  resolvePricingProvider,
} from './registry.ts';
