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

import { MONEY_SCALE_DIGITS, divideDecimal, formatDecimal, multiplyDecimal, parseDecimal, trimDecimal } from '../core/money.ts';
import type { PricingProvider, RateComponent } from './contract.ts';

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
 * The table shipped with the tool.
 *
 * A seed, not a source of truth: it exists so a first run with no cache and no
 * network still converts, and it says what it is so nobody mistakes it for live
 * data. Values are the rates published on {@link SEED_DATE}.
 */
export const SEED_DATE = '2026-09-21';
export const SEED_RATES: Readonly<Record<string, string>> = {
  USD: '1',
  CNY: '6.70471',
  EUR: '0.871295',
  JPY: '156.919',
  GBP: '0.747411',
  HKD: '7.84518',
  TWD: '31.8065',
  KRW: '1386.02',
  SGD: '1.27661',
  AUD: '1.40460',
  CAD: '1.39932',
  CHF: '0.823021',
  INR: '96.0370',
  BRL: '5.13800',
  RUB: '84.2616',
  THB: '33.3407',
  MYR: '4.08041',
  IDR: '17790.5',
  VND: '25994.9',
  PHP: '62.8882',
  NZD: '1.74839',
  SEK: '9.83639',
  NOK: '9.41271',
  DKK: '6.51623',
  PLN: '3.80245',
  CZK: '21.2017',
  HUF: '317.534',
  TRY: '48.7945',
  ILS: '3.03239',
  MXN: '17.2279',
  ZAR: '16.2590',
  AED: '3.67250',
  SAR: '3.75000',
};

/** The shipped table, as a {@link RateTable}. */
export function seedTable(): RateTable {
  return {
    base: 'USD',
    rates: SEED_RATES,
    provenance: { source: '内置种子汇率 exchangerate-api.com', date: SEED_DATE },
  };
}

/** Currency metadata, falling back to the code itself as its symbol. */
export function currencyOf(code: string): CurrencyInfo {
  const upper = code.trim().toUpperCase();
  return KNOWN[upper] ?? { code: upper, symbol: `${upper} `, name: upper };
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

/** What the user asked to see, and what it costs to show it. */
export interface DisplayChoice {
  /** Currency to print, or `null` when the user gave a rate but no currency. */
  currency: CurrencyInfo | null;
  /** Units of the display currency per 1 unit of the base currency. */
  rate: string;
  /** Where the rate came from; `手工指定` when the user supplied it. */
  provenance: RateProvenance;
}

/**
 * How the display currency was chosen, for the provenance line.
 *
 * - `flag` — the user named a currency (with or without a rate);
 * - `manual-rate` — the user gave only a rate, so nothing is named;
 * - `locale` — the user's language picked it;
 * - `locale-default` — the language had no opinion, so USD did;
 * - `fallback-base` — nothing could be converted, so prices stay as published.
 */
export type DisplayReason = 'flag' | 'manual-rate' | 'locale' | 'locale-default' | 'fallback-base';

/** A resolved display choice plus why it was made. */
export interface DisplayResolution extends DisplayChoice {
  /** Why this currency was picked. */
  reason: DisplayReason;
  /** Currency the prices are written in. */
  base: string;
}

/** What the caller knows about the user's choice. */
export interface DisplayInput {
  /** Currency the prices are written in. */
  base: string;
  /** `--currency`, if given. */
  currencyFlag?: string | undefined;
  /** `--currency-rate`, if given. */
  rateFlag?: string | undefined;
  /** The user's locale, e.g. `zh-CN`. */
  locale?: string | undefined;
  /** The rate table to use; the shipped seed table by default. */
  table?: RateTable | undefined;
}

/**
 * Work out what currency to display and at what rate.
 *
 * `--currency` alone uses the rate table, `--currency-rate` alone converts without
 * naming a currency at all, and neither means "whatever the user's locale says" —
 * falling back to USD, then to the currency the prices are already in.
 * @param input - the user's flags and the machine's locale.
 * @returns the currency, the rate, and where the rate came from.
 * @throws when a rate table lacks one of the currencies involved.
 */
export function resolveDisplay(input: DisplayInput): DisplayResolution {
  const table = input.table ?? seedTable();
  const manual = input.rateFlag === undefined ? undefined : trimDecimal(input.rateFlag.trim());
  if (manual !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(manual) || Number(manual) <= 0) {
      throw new Error(`汇率必须是正的十进制数，收到 ${JSON.stringify(input.rateFlag)}`);
    }
    const currency = input.currencyFlag === undefined ? null : currencyOf(input.currencyFlag);
    return {
      base: input.base,
      currency,
      rate: manual,
      provenance: { source: '手工指定', date: new Date().toISOString().slice(0, 10) },
      reason: currency === null ? 'manual-rate' : 'flag',
    };
  }

  if (input.currencyFlag !== undefined) {
    const currency = currencyOf(input.currencyFlag);
    return {
      base: input.base,
      currency,
      rate: rateFrom(table, input.base, currency.code),
      provenance: table.provenance,
      reason: 'flag',
    };
  }

  const fromLocale = input.locale === undefined ? undefined : localeCurrency(input.locale);
  const wanted = fromLocale ?? 'USD';
  if (wanted !== input.base && table.rates[wanted] !== undefined) {
    return {
      base: input.base,
      currency: currencyOf(wanted),
      rate: rateFrom(table, input.base, wanted),
      provenance: table.provenance,
      reason: fromLocale === undefined ? 'locale-default' : 'locale',
    };
  }
  const base = currencyOf(input.base);
  return { base: input.base, currency: base, rate: '1', provenance: { source: '同种货币', date: SEED_DATE }, reason: 'fallback-base' };
}

/**
 * Rewrite a provider's rates into another currency.
 *
 * The rates themselves are converted, so every amount *and* every unit price the
 * report prints is already in the display currency — there is no second place
 * where money could be converted differently.
 * @param provider - the vendor's price list.
 * @param target - currency to price in.
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
      offPeak: period.offPeak.map(convert),
      peak: period.peak === null ? null : period.peak.map(convert),
    })),
  }));
  return {
    ...provider,
    currency: { code: target.code, symbol: target.symbol },
    models: () => models,
    find: (model: string) => {
      const wanted = model.trim().toLowerCase();
      return models.find((price) => price.aliases.some((alias) => alias.toLowerCase() === wanted));
    },
  };
}

/** Digits the arithmetic scale keeps; re-exported for callers reasoning about rates. */
export const RATE_DIGITS = MONEY_SCALE_DIGITS;

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
