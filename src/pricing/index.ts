/**
 * Pricing: the second extension axis.
 *
 * - `contract.ts` — what a pricing provider must implement.
 * - `engine.ts`   — the vendor-neutral period/tier resolution and arithmetic.
 * - `registry.ts` — which providers this build ships.
 * - `currency.ts` — display currency, exchange-rate tables, and converting a
 *   provider's published rates into the currency the report is shown in.
 * - `../config/`  — the vendor price lists and the rate table, as data.
 */

export * from './contract.ts';
export {
  chooseDisplay,
  currencyOf,
  convertProvider,
  displayRate,
  localeCurrency,
  providerCurrencies,
  rateFor,
  rateFrom,
  seedDate,
  seedTable,
  shippedRateConfig,
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
  chargeComponent,
  counterForBasis,
  createPricingEngine,
  formatInstant,
  isPeak,
  parseRate,
  zoneTime,
  type ChargeContext,
  type ZoneTime,
} from './engine.ts';
export {
  DEFAULT_PRICING_PROVIDER,
  PRICING_PROVIDERS,
  findPricingProvider,
  requirePricingProvider,
  resolvePricingProvider,
} from './registry.ts';
