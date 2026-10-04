/**
 * Pricing: the second extension axis.
 *
 * - `contract.ts` — what a pricing provider must implement.
 * - `engine.ts`   — the vendor-neutral period/tier resolution and arithmetic.
 * - `routing.ts`  — one engine over many tables: the record's model picks the table.
 * - `registry.ts` — which providers this build ships, and the engine to price with.
 * - `currency.ts` — display currency, exchange-rate tables, and converting a
 *   provider's published rates into the currency the report is shown in.
 * - `catalog.ts`  — the vendor price lists: shipped, cached, user-overridden.
 * - `rates.ts`    — the shipped exchange-rate table.
 *
 * The price lists are *data* (`config/pricing.json`, `config/rates.json`): a
 * vendor's new prices go live by committing one file, and this layer reads them.
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
  PRICING_PROVIDERS,
  createRoutingEngine,
  findPricingProvider,
  isRoutingEngine,
  requirePricingProvider,
  type RoutingEngine,
  type RoutingOptions,
} from './registry.ts';
