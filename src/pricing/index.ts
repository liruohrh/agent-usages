/**
 * Pricing: the second extension axis.
 *
 * - `contract.ts` — what a pricing provider must implement.
 * - `engine.ts`   — the vendor-neutral period/tier resolution and arithmetic.
 * - `registry.ts` — which providers this build ships.
 * - `currency.ts` — display currency, exchange-rate tables, and converting a
 *   provider's published rates into the currency the report is shown in.
 * - `vendors/`    — one module per vendor's published price list.
 */

export * from './contract.ts';
export {
  SEED_DATE,
  SEED_RATES,
  chooseDisplay,
  currencyOf,
  convertProvider,
  displayRate,
  localeCurrency,
  providerCurrencies,
  rateFor,
  rateFrom,
  seedTable,
  selectCurrency,
  type CurrencyInfo,
  type DisplayChoice,
  type DisplayInput,
  type DisplayReason,
  type DisplayResolution,
  type RateProvenance,
  type RateTable,
} from './currency.ts';
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
