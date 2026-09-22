/**
 * The pricing configuration file.
 *
 * Price lists live in `config/pricing.json` in this repository rather than in
 * TypeScript, so a vendor's new prices can go live by committing one file — no
 * release, no rebuild. The file is shipped with the tool as its default and can
 * be fetched at run time, which is why it is parsed defensively: it is data that
 * a human edits, so every problem is reported with the path to the field that
 * caused it.
 *
 * The schema mirrors the pricing contract one-to-one — nothing is inferred — so a
 * reader can diff the file against a vendor's page without knowing this code.
 */

import { readFileSync } from 'node:fs';

import { parseDecimal } from '../core/money.ts';
import { UserError, renderDiagnostic, type ErrorCode, type ErrorParams } from '../i18n/errors.ts';
import type { BillingBasis, ModelPrice, PeakWindow, PricePeriod, PricingProvider, RateComponent } from '../pricing/contract.ts';

/** Where the shipped configuration lives, relative to this module. */
const SHIPPED_PATH = new URL('../../config/pricing.json', import.meta.url);

/** A problem found while reading a configuration file. */
export class ConfigError<C extends ErrorCode = ErrorCode> extends UserError<C> {
  /** Dotted path to the offending field, e.g. `providers[0].models[1]`. */
  readonly path: string;

  constructor(path: string, code: C, params: ErrorParams<C>) {
    super(code, params);
    this.name = 'ConfigError';
    this.path = path;
  }

  /** `path: sentence` — the path first, so a reader can jump straight to the field. */
  override get message(): string {
    return `${this.path}: ${renderDiagnostic(this.code, this.params)}`;
  }
}

/** The bases a rate component may charge. */
const BASES: readonly BillingBasis[] = ['input', 'inputAndCacheWrite', 'cacheRead', 'cacheWrite', 'output'];

/** Read a value as a plain object. */
function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(path, 'configExpectsObject', { value: JSON.stringify(value) });
  }
  return value as Record<string, unknown>;
}

/** Read a value as an array. */
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ConfigError(path, 'configExpectsArray', { value: JSON.stringify(value) });
  return value;
}

/** Read a required string. */
function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(path, 'configNonEmptyString', { value: JSON.stringify(value) });
  }
  return value;
}

/** Read an optional string. */
function optionalText(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ConfigError(path, 'configStringOrNull', { value: JSON.stringify(value) });
  return value;
}

/** Read a required number. */
function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(path, 'configExpectsNumber', { value: JSON.stringify(value) });
  }
  return value;
}

/** Read a required boolean. */
function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ConfigError(path, 'configExpectsBoolean', { value: JSON.stringify(value) });
  return value;
}

/** An instant written as an ISO datetime, with the offset it carried. */
interface Stamped {
  /** Milliseconds since the Unix epoch. */
  instant: number;
  /** Minutes east of UTC the timestamp was written in. */
  utcOffset: number;
}

/**
 * Read an instant that must carry its own offset.
 *
 * The offset is not decoration: it is the only place a period says which clock
 * its peak hours are written in, which is why a bare local time is rejected.
 */
function stamped(value: unknown, path: string): Stamped {
  const raw = text(value, path);
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (match === null) {
    throw new ConfigError(path, 'configIsoWithOffset', { value: JSON.stringify(raw) });
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new ConfigError(path, 'configInvalidInstant', { value: JSON.stringify(raw) });
  const zone = match[1] as string;
  const utcOffset =
    zone === 'Z' ? 0 : (zone.startsWith('-') ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  if (Math.abs(utcOffset) > 14 * 60) throw new ConfigError(path, 'configOffsetTooLarge', { value: JSON.stringify(raw) });
  return { instant: parsed, utcOffset };
}

/** A rate component, as the vendor publishes it. */
function component(value: unknown, path: string): RateComponent {
  const node = object(value, path);
  const id = text(node['id'], `${path}.id`);
  const basis = text(node['basis'], `${path}.basis`);
  if (!BASES.includes(basis as BillingBasis)) {
    throw new ConfigError(`${path}.basis`, 'configUnknownBasis', { basis: JSON.stringify(basis), known: BASES.join(' / ') });
  }
  const rate = text(node['rate'], `${path}.rate`);
  try {
    parseDecimal(rate);
  } catch {
    throw new ConfigError(`${path}.rate`, 'configNotDecimal', { value: JSON.stringify(rate) });
  }
  const per = number(node['per'], `${path}.per`);
  if (!Number.isSafeInteger(per) || per <= 0) throw new ConfigError(`${path}.per`, 'configPositiveInteger', { value: String(per) });
  return { id, label: text(node['label'], `${path}.label`), basis: basis as BillingBasis, rate, per };
}

/** A peak window in the period's own timezone. */
function peakWindow(value: unknown, path: string): PeakWindow {
  const node = object(value, path);
  const fromHour = number(node['fromHour'], `${path}.fromHour`);
  const toHour = number(node['toHour'], `${path}.toHour`);
  if (fromHour < 0 || fromHour > 23 || toHour < 1 || toHour > 24 || toHour <= fromHour) {
    throw new ConfigError(path, 'configWindowHours', { from: fromHour, to: toHour });
  }
  const weekdays = node['weekdays'];
  if (weekdays === null || weekdays === undefined) return { fromHour, toHour, weekdays: null };
  const days = array(weekdays, `${path}.weekdays`).map((day, index) => {
    const value = number(day, `${path}.weekdays[${index}]`);
    if (!Number.isInteger(value) || value < 0 || value > 6) {
      throw new ConfigError(`${path}.weekdays[${index}]`, 'configWeekday', { value: String(value) });
    }
    return value;
  });
  return { fromHour, toHour, weekdays: days };
}

/** One price period. */
function period(value: unknown, path: string): PricePeriod {
  const node = object(value, path);
  const currency = text(node['currency'], `${path}.currency`);
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ConfigError(`${path}.currency`, 'configCurrencyCode', { value: JSON.stringify(currency) });
  }
  const peak = node['peak'] === null || node['peak'] === undefined ? null : array(node['peak'], `${path}.peak`).map((entry, index) => component(entry, `${path}.peak[${index}]`));
  const peakWindows = array(node['peakWindows'] ?? [], `${path}.peakWindows`).map((entry, index) => peakWindow(entry, `${path}.peakWindows[${index}]`));
  // A tiered period needs windows to decide the tier, and a flat one must not
  // carry them: otherwise a rate card would silently never apply.
  if (peak === null && peakWindows.length > 0) throw new ConfigError(`${path}.peakWindows`, 'configWindowsWithoutPeak', {});
  if (peak !== null && peakWindows.length === 0) throw new ConfigError(`${path}.peak`, 'configPeakWithoutWindows', {});
  const from = stamped(node['from'], `${path}.from`);
  const to = node['to'] === null || node['to'] === undefined ? null : stamped(node['to'], `${path}.to`);
  if (to !== null && to.instant <= from.instant) throw new ConfigError(`${path}.to`, 'configToNotAfterFrom', {});
  const source = text(node['source'], `${path}.source`);
  if (!/^https?:\/\//.test(source)) throw new ConfigError(`${path}.source`, 'configSourceUrl', { value: JSON.stringify(source) });
  return {
    id: text(node['id'], `${path}.id`),
    label: text(node['label'], `${path}.label`),
    from: from.instant,
    to: to === null ? null : to.instant,
    // The period's clock is the offset its own start carries.
    utcOffset: from.utcOffset,
    offPeak: array(node['offPeak'], `${path}.offPeak`).map((entry, index) => component(entry, `${path}.offPeak[${index}]`)),
    peak,
    peakWindows,
    currency,
    source,
    note: text(node['note'], `${path}.note`),
  };
}

/**
 * Check a model's periods are usable, whatever shape they arrived in.
 *
 * Shared by the file parser and by the user-override merge, so a merged history
 * is held to exactly the same rules as a published one — and so an override can
 * never be accepted by one path and rejected by the other.
 * @param entry - the model to check.
 * @param path - where it came from, for the error message.
 * @throws {ConfigError} on a duplicate id, a gap, an overlap, or a history that never ends.
 */
export function checkModelPeriods(entry: ModelPrice, path: string): void {
  const periods = entry.periods;
  if (periods.length === 0) throw new ConfigError(`${path}.periods`, 'configNeedsPeriod', {});
  // Ids are unique within a currency, not across them: the yuan and dollar lists
  // name the same windows with the same ids, and only one list is ever priced.
  const ids = new Set<string>();
  for (const entry of periods) {
    const key = `${entry.currency}/${entry.id}`;
    if (ids.has(key)) throw new ConfigError(`${path}.periods`, 'configDuplicatePeriodId', { key });
    ids.add(key);
  }
  // Each currency is its own history, so contiguity is checked per currency.
  for (const code of new Set(periods.map((entry) => entry.currency))) {
    const history = periods.filter((entry) => entry.currency === code);
    for (let index = 1; index < history.length; index += 1) {
      const previous = history[index - 1] as PricePeriod;
      const current = history[index] as PricePeriod;
      if (current.from < previous.from) {
        throw new ConfigError(`${path}.periods`, 'configPeriodsUnsorted', {
          currency: code,
          previous: previous.id,
          current: current.id,
        });
      }
      if (previous.to !== current.from) {
        throw new ConfigError(`${path}.periods`, 'configPeriodsDiscontinuous', {
          currency: code,
          previous: previous.id,
          previousTo: new Date(previous.to ?? 0).toISOString(),
          current: current.id,
          currentFrom: new Date(current.from).toISOString(),
        });
      }
    }
    const last = history[history.length - 1] as PricePeriod;
    if (last.to !== null) throw new ConfigError(`${path}.periods`, 'configNoOpenEnd', { currency: code, id: last.id });
  }
}

/**
 * Validate providers that were assembled in memory rather than parsed.
 * @param providers - the providers to check.
 * @throws {ConfigError} with the path of the first problem.
 */
export function validateProviders(providers: readonly ProviderConfig[]): void {
  if (providers.length === 0) throw new ConfigError('providers', 'configNeedsProvider', {});
  providers.forEach((entry, index) => {
    if (entry.models.length === 0) throw new ConfigError(`providers[${index}].models`, 'configNeedsModel', {});
    if (entry.defaultModel !== null && !entry.models.some((model) => model.model === entry.defaultModel)) {
      throw new ConfigError(`providers[${index}].defaultModel`, 'configDefaultModelMissing', { model: entry.defaultModel });
    }
    entry.models.forEach((model, at) => {
      checkModelPeriods(model, `providers[${index}].models[${at}]`);
    });
  });
}

/** One model's price history, parsed from a configuration file. */
function modelPrice(value: unknown, path: string): ModelPrice {
  const node = object(value, path);
  const aliases = array(node['aliases'] ?? [], `${path}.aliases`).map((alias, index) => text(alias, `${path}.aliases[${index}]`));
  const model = text(node['model'], `${path}.model`);
  const periods = array(node['periods'], `${path}.periods`).map((entry, index) => period(entry, `${path}.periods[${index}]`));
  const parsed: ModelPrice = { model, aliases: aliases.length > 0 ? aliases : [model], periods };
  checkModelPeriods(parsed, path);
  return parsed;
}

/** One pricing provider, as a config file describes it. */
export interface ProviderConfig {
  /** Provider id, e.g. `deepseek`. */
  id: string;
  /** Human-readable name. */
  label: string;
  /** Model used for records nothing else matches, or `null` to leave them unpriced. */
  defaultModel: string | null;
  /** Models with a published schedule. */
  models: ModelPrice[];
}

/** A parsed pricing configuration. */
export interface PricingConfig {
  /** Schema version. */
  version: number;
  /** Last time a human touched the file, `YYYY-MM-DD`. */
  updatedAt: string;
  /** Free-form note for whoever edits the file. */
  note: string | null;
  /** Every provider it lists. */
  providers: ProviderConfig[];
}

/**
 * Parse and validate a pricing configuration.
 * @param value - the parsed JSON, or a string to parse.
 * @returns the configuration, ready to become providers.
 * @throws {ConfigError} with the path to the first problem found.
 */
export function parsePricingConfig(value: unknown): PricingConfig {
  const document = object(typeof value === 'string' ? JSON.parse(value) : value, 'config/pricing.json');
  const version = number(document['version'], 'version');
  if (version !== 1) throw new ConfigError('version', 'configUnknownVersion', { version: String(version) });
  const providers = array(document['providers'], 'providers').map((entry, index) => {
    const node = object(entry, `providers[${index}]`);
    const models = array(node['models'], `providers[${index}].models`).map((model, at) =>
      modelPrice(model, `providers[${index}].models[${at}]`),
    );
    if (models.length === 0) throw new ConfigError(`providers[${index}].models`, 'configNeedsModel', {});
    const defaultModel = optionalText(node['defaultModel'], `providers[${index}].defaultModel`);
    if (defaultModel !== null && !models.some((entry) => entry.model === defaultModel)) {
      throw new ConfigError(`providers[${index}].defaultModel`, 'configDefaultModelMissing', { model: defaultModel });
    }
    return {
      id: text(node['id'], `providers[${index}].id`),
      label: text(node['label'], `providers[${index}].label`),
      defaultModel,
      models,
    };
  });
  if (providers.length === 0) throw new ConfigError('providers', 'configNeedsProvider', {});
  return { version, updatedAt: text(document['updatedAt'], 'updatedAt'), note: optionalText(document['note'], 'note'), providers };
}

/**
 * Turn one provider's configuration into a pricing provider.
 * @param entry - the provider as the file describes it.
 * @returns the provider, with its lookups.
 */
export function providerFromConfig(entry: ProviderConfig): PricingProvider {
  return {
    id: entry.id,
    label: entry.label,
    defaultModel: entry.defaultModel,
    models: () => entry.models,
    find: (model: string) => {
      const wanted = model.trim().toLowerCase();
      for (const price of entry.models) {
        if (price.aliases.some((alias) => alias.toLowerCase() === wanted)) return price;
      }
      return undefined;
    },
  };
}

/** Every provider the shipped configuration declares. */
export function shippedProviders(): PricingProvider[] {
  return parsePricingConfig(readFileSync(SHIPPED_PATH, 'utf8')).providers.map(providerFromConfig);
}

/** The raw text of the shipped configuration, for provenance lines. */
export function shippedPricingText(): string {
  return readFileSync(SHIPPED_PATH, 'utf8');
}

/** Fields a configuration file may carry that this version does not know. */
export function unknownKeys(value: unknown): string[] {
  const known = new Set(['version', 'updatedAt', 'note', 'providers']);
  if (typeof value !== 'object' || value === null) return [];
  return Object.keys(value).filter((key) => !known.has(key));
}

/** Whether a value looks like a boolean, used by the merge layer. */
export function asBoolean(value: unknown, path: string): boolean {
  return boolean(value, path);
}
