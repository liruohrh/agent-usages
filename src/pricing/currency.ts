/**
 * Display currency and exchange rates.
 *
 * A vendor's price list is written in the vendor's own currency, and that is what
 * a price table must keep saying: `price` prints the published numbers, and the
 * report converts them once, up front. Conversion therefore rewrites the *rates*
 * rather than the totals — every amount and every unit price downstream is in the
 * same currency, and nothing has to be converted twice.
 *
 * Rates are expressed against one common base (USD), so any pair converts through
 * it: `base → target` is `usd[target] / usd[base]`. That keeps the table small and
 * lets a provider quote in any currency it likes.
 */

import { shippedRates, type RatesConfig } from '../config/rates.ts';
import { MONEY_SCALE_DIGITS, divideDecimal, formatDecimal, multiplyDecimal, parseDecimal, trimDecimal } from '../core/money.ts';
import type { PricePeriod, PricingProvider, RateComponent } from './contract.ts';

/** A currency this tool can display. */
export interface CurrencyInfo {
  /** ISO code. */
  code: string;
  /** Symbol to print in front of amounts. */
  symbol: string;
  /** English name, for provenance lines. */
  name: string;
}

/** The currencies worth knowing a symbol for; anything else prints its code. */
const KNOWN: Readonly<Record<string, CurrencyInfo>> = {
  CNY: { code: 'CNY', symbol: '¥', name: 'Chinese yuan' },
  USD: { code: 'USD', symbol: '$', name: 'US dollar' },
  EUR: { code: 'EUR', symbol: '€', name: 'Euro' },
  JPY: { code: 'JPY', symbol: '¥', name: 'Japanese yen' },
  GBP: { code: 'GBP', symbol: '£', name: 'Pound sterling' },
  HKD: { code: 'HKD', symbol: 'HK$', name: 'Hong Kong dollar' },
  TWD: { code: 'TWD', symbol: 'NT$', name: 'New Taiwan dollar' },
  KRW: { code: 'KRW', symbol: '₩', name: 'South Korean won' },
  SGD: { code: 'SGD', symbol: 'S$', name: 'Singapore dollar' },
  AUD: { code: 'AUD', symbol: 'A$', name: 'Australian dollar' },
  CAD: { code: 'CAD', symbol: 'C$', name: 'Canadian dollar' },
  CHF: { code: 'CHF', symbol: 'CHF ', name: 'Swiss franc' },
  INR: { code: 'INR', symbol: '₹', name: 'Indian rupee' },
  BRL: { code: 'BRL', symbol: 'R$', name: 'Brazilian real' },
  RUB: { code: 'RUB', symbol: '₽', name: 'Russian ruble' },
  THB: { code: 'THB', symbol: '฿', name: 'Thai baht' },
  MYR: { code: 'MYR', symbol: 'RM', name: 'Malaysian ringgit' },
  IDR: { code: 'IDR', symbol: 'Rp', name: 'Indonesian rupiah' },
  VND: { code: 'VND', symbol: '₫', name: 'Vietnamese dong' },
  PHP: { code: 'PHP', symbol: '₱', name: 'Philippine peso' },
  NZD: { code: 'NZD', symbol: 'NZ$', name: 'New Zealand dollar' },
  SEK: { code: 'SEK', symbol: 'kr', name: 'Swedish krona' },
  NOK: { code: 'NOK', symbol: 'kr', name: 'Norwegian krone' },
  DKK: { code: 'DKK', symbol: 'kr', name: 'Danish krone' },
  PLN: { code: 'PLN', symbol: 'zł', name: 'Polish złoty' },
  CZK: { code: 'CZK', symbol: 'Kč', name: 'Czech koruna' },
  HUF: { code: 'HUF', symbol: 'Ft', name: 'Hungarian forint' },
  TRY: { code: 'TRY', symbol: '₺', name: 'Turkish lira' },
  ILS: { code: 'ILS', symbol: '₪', name: 'Israeli new shekel' },
  MXN: { code: 'MXN', symbol: 'MX$', name: 'Mexican peso' },
  ZAR: { code: 'ZAR', symbol: 'R', name: 'South African rand' },
  AED: { code: 'AED', symbol: 'د.إ', name: 'UAE dirham' },
  SAR: { code: 'SAR', symbol: '﷼', name: 'Saudi riyal' },
};

/**
 * The currency behind a locale, when we have an opinion.
 *
 * Language first, then a region override where the language alone would mislead
 * (`en-GB` is not the dollar, `zh-TW` is not the yuan).
 * @param locale - a BCP-47 tag, e.g. `zh-CN` or `en-GB`.
 * @returns an ISO code, or `undefined` when nothing fits.
 */
export function localeCurrency(locale: string): string | undefined {
  const parts = locale.replace('_', '-').split('-');
  const language = (parts[0] ?? '').toLowerCase();
  // The region is the second subtag, not "the first short one" — the language
  // subtag itself is two letters, so `en-GB` would otherwise read as region `EN`.
  const region = /^([A-Za-z]{2}|\d{3})$/.test(parts[1] ?? '') ? (parts[1] ?? '').toUpperCase() : '';
  const byRegion: Readonly<Record<string, string>> = {
    'zh-TW': 'TWD',
    'zh-HK': 'HKD',
    'zh-MO': 'HKD',
    'zh-SG': 'SGD',
    'en-GB': 'GBP',
    'en-AU': 'AUD',
    'en-CA': 'CAD',
    'en-NZ': 'NZD',
    'en-IN': 'INR',
    'en-SG': 'SGD',
    'pt-BR': 'BRL',
    'fr-CA': 'CAD',
    'es-MX': 'MXN',
  };
  if (region.length > 0 && byRegion[`${language}-${region}`] !== undefined) return byRegion[`${language}-${region}`];
  const byLanguage: Readonly<Record<string, string>> = {
    zh: 'CNY',
    en: 'USD',
    ja: 'JPY',
    ko: 'KRW',
    de: 'EUR',
    fr: 'EUR',
    es: 'EUR',
    it: 'EUR',
    nl: 'EUR',
    pt: 'EUR',
    el: 'EUR',
    fi: 'EUR',
    ga: 'EUR',
    ru: 'RUB',
    pl: 'PLN',
    sv: 'SEK',
    da: 'DKK',
    nb: 'NOK',
    nn: 'NOK',
    cs: 'CZK',
    hu: 'HUF',
    tr: 'TRY',
    th: 'THB',
    vi: 'VND',
    id: 'IDR',
    ms: 'MYR',
    hi: 'INR',
    he: 'ILS',
    ar: 'AED',
    uk: 'RUB',
  };
  return byLanguage[language];
}

/** Where a rate came from and when it was published. */
export interface RateProvenance {
  /** Human-readable source, e.g. `内置种子汇率`. */
  source: string;
  /** Publication date, `YYYY-MM-DD`. */
  date: string;
}

/** A table of rates, all expressed against one base currency. */
export interface RateTable {
  /** Currency every rate in {@link rates} is quoted against. */
  base: string;
  /** `code → units of that currency per 1 base`. */
  rates: Readonly<Record<string, string>>;
  /** Where the table came from. */
  provenance: RateProvenance;
}

/**
 * The rate configuration shipped with the tool.
 *
 * Read once and cached: it is a file on disk, and every call site wants the same
 * table. The cache is what the update layer replaces when it has something newer.
 */
let shippedConfig: RatesConfig | undefined;

/** The shipped rate configuration. */
export function shippedRateConfig(): RatesConfig {
  shippedConfig ??= shippedRates();
  return shippedConfig;
}

/** The date the shipped table was captured, `YYYY-MM-DD`. */
export function seedDate(): string {
  return shippedRateConfig().updatedAt;
}

/** The shipped table, as a {@link RateTable}. */
export function seedTable(): RateTable {
  const config = shippedRateConfig();
  return {
    base: config.base,
    rates: config.table,
    provenance: { source: `内置汇率表 ${config.source}`, date: config.updatedAt },
  };
}

/**
 * Currency metadata.
 *
 * The symbol is the tool's own business, not the price file's: known currencies
 * get the symbol people expect, and an unknown one is marked `!$` so a missing
 * entry is visible in the output rather than silently plausible.
 * @param code - ISO code.
 * @returns the currency, with a symbol to print.
 */
export function currencyOf(code: string): CurrencyInfo {
  const upper = code.trim().toUpperCase();
  return KNOWN[upper] ?? { code: upper, symbol: '!$', name: upper };
}

/**
 * The rate that turns one currency into another through the table's base.
 * @param table - a table all of whose rates share {@link RateTable.base}.
 * @param base - currency the prices are written in.
 * @param target - currency to display.
 * @returns units of `target` per 1 unit of `base`.
 * @throws when either currency is missing from the table.
 */
export function rateFrom(table: RateTable, base: string, target: string): string {
  if (base === target) return '1';
  const from = table.rates[base];
  const to = table.rates[target];
  if (from === undefined || to === undefined) {
    throw new Error(`汇率表（${table.base} 基准）里没有 ${from === undefined ? base : target} 的汇率`);
  }
  return trimDecimal(divideDecimal(to, from));
}

/** The currency to display, before any rate is worked out. */
export interface DisplayChoice {
  /** Currency to print, or `null` when the user gave a rate but no currency. */
  currency: CurrencyInfo | null;
  /** The rate the user typed, when they typed one. */
  manualRate: string | null;
  /** Why this currency was chosen. */
  reason: DisplayReason;
  /**
   * Which published list to price from.
   *
   * Normally the list the reader's currency belongs to, so nothing is converted.
   * A manual rate is different: it converts *from* whatever list the reader
   * would otherwise have seen, so the base stays the locale's list and the rate
   * carries it to the wanted currency.
   */
  baseWanted: string;
}

/**
 * How the display currency was chosen, for the provenance line.
 *
 * - `flag` — the user named a currency (with or without a rate);
 * - `manual-rate` — the user gave only a rate, so nothing is named;
 * - `locale` — the user's language picked a currency the price list publishes;
 * - `locale-default` — the language had no publishable opinion, so USD did.
 */
export type DisplayReason = 'flag' | 'manual-rate' | 'locale' | 'locale-default' | 'fallback-base';

/** What the caller knows about the user's choice. */
export interface DisplayInput {
  /** Currencies the price list publishes, in the order it publishes them. */
  published: readonly string[];
  /** `--currency`, if given. */
  currencyFlag?: string | undefined;
  /** `--currency-rate`, if given. */
  rateFlag?: string | undefined;
  /** The user's locale, e.g. `zh-CN`. */
  locale?: string | undefined;
}

/**
 * Pick the currency to display.
 *
 * The user's flag wins, then their language — but only when the price list
 * actually publishes that currency, because a published list is exact and a
 * conversion is not. When neither fits, dollars are the documented fallback.
 * @param input - the user's flags and the machine's locale.
 * @returns the currency, the manual rate if any, and why.
 * @throws when `--currency-rate` is not a positive decimal.
 */
export function chooseDisplay(input: DisplayInput): DisplayChoice {
  const fromLocale = input.locale === undefined ? undefined : localeCurrency(input.locale);
  const localeList = fromLocale !== undefined && input.published.includes(fromLocale) ? fromLocale : undefined;
  const dollarList = input.published.includes('USD') ? 'USD' : undefined;
  const firstList = input.published[0];
  const fallback = localeList ?? dollarList ?? firstList ?? 'USD';

  if (input.rateFlag !== undefined) {
    const manual = trimDecimal(input.rateFlag.trim());
    if (!/^\d+(\.\d+)?$/.test(manual) || Number(manual) <= 0) {
      throw new Error(`汇率必须是正的十进制数，收到 ${JSON.stringify(input.rateFlag)}`);
    }
    return {
      currency: input.currencyFlag === undefined ? null : currencyOf(input.currencyFlag),
      manualRate: manual,
      reason: input.currencyFlag === undefined ? 'manual-rate' : 'flag',
      // Convert from the list the reader would have seen without the flag.
      baseWanted: fallback,
    };
  }
  if (input.currencyFlag !== undefined) {
    const wanted = currencyOf(input.currencyFlag);
    return {
      currency: wanted,
      manualRate: null,
      reason: 'flag',
      baseWanted: input.published.includes(wanted.code) ? wanted.code : fallback,
    };
  }
  if (localeList !== undefined) {
    return { currency: currencyOf(localeList), manualRate: null, reason: 'locale', baseWanted: localeList };
  }
  if (firstList === undefined) {
    // Nothing is published at all: there is nothing to show, so show nothing.
    return { currency: null, manualRate: null, reason: 'fallback-base', baseWanted: 'USD' };
  }
  return {
    currency: currencyOf(fallback),
    manualRate: null,
    reason: 'locale-default',
    baseWanted: fallback,
  };
}

/** A resolved display currency, plus the rate that reaches it. */
export interface DisplayResolution {
  /** Currency to print, or `null` when the user gave a rate but no currency. */
  currency: CurrencyInfo | null;
  /** Currency the price list is written in. */
  base: string;
  /** Units of the display currency per 1 unit of the base currency. */
  rate: string;
  /** Where the rate came from. */
  provenance: RateProvenance;
  /** Why this currency was picked. */
  reason: DisplayReason;
}

/**
 * Work out the rate that turns the published currency into the display one.
 * @param input - the base currency, the wanted one, a manual rate, and a table.
 * @returns the rate and where it came from.
 * @throws when the table lacks one of the currencies involved.
 */
export function rateFor(input: {
  base: string;
  target: string | null;
  manualRate?: string | null | undefined;
  table?: RateTable | undefined;
}): { rate: string; provenance: RateProvenance } {
  const table = input.table ?? seedTable();
  if (input.manualRate !== undefined && input.manualRate !== null) {
    return { rate: input.manualRate, provenance: { source: '手工指定', date: new Date().toISOString().slice(0, 10) } };
  }
  if (input.target === null || input.target === input.base) {
    return { rate: '1', provenance: { source: '厂商发布价，未折算', date: table.provenance.date } };
  }
  return { rate: rateFrom(table, input.base, input.target), provenance: table.provenance };
}


/**
 * The currencies a provider publishes, in the order they appear.
 *
 * A vendor's list is written once per currency; this is what the CLI means when
 * it says which currencies a provider quotes.
 * @param provider - the price list.
 * @returns distinct ISO codes, in period order.
 */
export function providerCurrencies(provider: PricingProvider): string[] {
  const seen: string[] = [];
  for (const model of provider.models()) {
    for (const period of model.periods) {
      if (!seen.includes(period.currency)) seen.push(period.currency);
    }
  }
  return seen;
}

/**
 * Keep one currency's periods per model.
 *
 * A model may publish parallel periods for several currencies covering the same
 * windows; pricing uses one list per model, chosen by the reader's currency. The
 * fallback order is the one the tool documents: the wanted currency, then USD,
 * then whatever the model published first.
 * @param provider - the full price list.
 * @param wanted - currency the report will be shown in.
 * @returns a provider carrying one list per model, and the currencies it kept.
 */
export function selectCurrency(
  provider: PricingProvider,
  wanted: string,
): { provider: PricingProvider; currencies: string[] } {
  const picked = new Map<string, string>();
  const models = provider.models().map((price) => {
    const published = [...new Set(price.periods.map((period) => period.currency))];
    const chosen = published.includes(wanted) ? wanted : published.includes('USD') ? 'USD' : (published[0] ?? wanted);
    picked.set(price.model, chosen);
    return { ...price, periods: price.periods.filter((period) => period.currency === chosen) };
  });
  return {
    provider: {
      ...provider,
      models: () => models,
      find: (model: string) => {
        const wantedName = model.trim().toLowerCase();
        return models.find((price) => price.aliases.some((alias) => alias.toLowerCase() === wantedName));
      },
    },
    currencies: [...new Set([...picked.values()])],
  };
}

/**
 * Rewrite a provider's rates into another currency.
 *
 * The rates themselves are converted, so every amount *and* every unit price the
 * report prints is already in the display currency — there is no second place
 * where money could be converted differently.
 * @param provider - the vendor's price list.
 * @param target - currency to price in; an empty code means "do not name one".
 * @param rate - units of `target` per 1 unit of the provider's currency.
 * @returns a provider quoting the same prices in `target`.
 */
export function convertProvider(provider: PricingProvider, target: CurrencyInfo, rate: string): PricingProvider {
  const convert = (component: RateComponent): RateComponent =>
    rate === '1' ? component : { ...component, rate: trimDecimal(multiplyDecimal(component.rate, rate)) };
  const models = provider.models().map((price) => ({
    ...price,
    periods: price.periods.map((period) => ({
      ...period,
      currency: target.code,
      offPeak: period.offPeak.map(convert),
      peak: period.peak === null ? null : period.peak.map(convert),
    })),
  }));
  return {
    ...provider,
    models: () => models,
    find: (model: string) => {
      const wanted = model.trim().toLowerCase();
      return models.find((price) => price.aliases.some((alias) => alias.toLowerCase() === wanted));
    },
  };
}

/**
 * A rate as a reader wants to see it: six decimals, no trailing zeros.
 *
 * The arithmetic keeps nine digits, but printing all of them suggests a precision
 * the published rate never had.
 * @param rate - the exact rate.
 * @returns the rate, trimmed for display.
 */
export function displayRate(rate: string): string {
  const [whole = '0', fraction = ''] = formatDecimal(parseDecimal(rate), 6).split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed.length === 0 ? whole : `${whole}.${trimmed}`;
}

/** Digits the arithmetic scale keeps; re-exported for callers reasoning about rates. */
export const RATE_DIGITS = MONEY_SCALE_DIGITS;
