/**
 * The rate configuration file.
 *
 * `config/rates.json` is the seed: a rate table with a date and a source, plus
 * the list of online sources to try, in order, when a fresher table is wanted.
 * Keeping the sources in the file means a source that dies or moves can be
 * replaced by committing a file, not by shipping a release.
 *
 * Like the price list, this is human-edited data, so it is parsed with the path
 * of the offending field in every error.
 */

import { readFileSync } from 'node:fs';

import { parseDecimal } from '../core/money.ts';
import { ConfigError } from './pricing.ts';

/** Where the shipped rate configuration lives, relative to this module. */
const SHIPPED_PATH = new URL('../../config/rates.json', import.meta.url);

/** One online source of rates. */
export interface RateSourceConfig {
  /** Stable id, used in cache provenance. */
  id: string;
  /** Human-readable name. */
  label: string;
  /** Which parser to use. */
  kind: 'frankfurter' | 'er-api';
  /** URL to fetch. */
  url: string;
  /** How often the source publishes, for the update schedule. */
  publishes: string;
}

/** A parsed rate configuration. */
export interface RatesConfig {
  /** Schema version. */
  version: number;
  /** Last time a human touched the file, `YYYY-MM-DD`. */
  updatedAt: string;
  /** Currency every rate in the table is quoted against. */
  base: string;
  /** Where the shipped table came from. */
  source: string;
  /** `code → units per 1 base`, as exact decimals. */
  table: Readonly<Record<string, string>>;
  /** Sources to try, in order. */
  sources: RateSourceConfig[];
}

/** Read a value as a plain object. */
function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(path, `应为对象，收到 ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

/** Read a required string. */
function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(path, `应为非空字符串，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/** Read an ISO currency code. */
function code(value: unknown, path: string): string {
  const raw = text(value, path);
  if (!/^[A-Z]{3}$/.test(raw)) throw new ConfigError(path, `应为三位大写 ISO 代码，收到 ${JSON.stringify(raw)}`);
  return raw;
}

/**
 * Parse and validate a rate configuration.
 * @param value - the parsed JSON, or a string to parse.
 * @returns the configuration.
 * @throws {ConfigError} with the path to the first problem found.
 */
export function parseRatesConfig(value: unknown): RatesConfig {
  const document = object(typeof value === 'string' ? JSON.parse(value) : value, 'config/rates.json');
  const version = document['version'];
  if (version !== 1) throw new ConfigError('version', `只认识版本 1，收到 ${JSON.stringify(version)}`);
  const base = code(document['base'], 'base');
  const rawTable = object(document['table'], 'table');
  const table: Record<string, string> = {};
  for (const [key, entry] of Object.entries(rawTable)) {
    const currency = code(key, `table.${key}`);
    const rate = text(entry, `table.${key}`);
    try {
      parseDecimal(rate);
    } catch {
      throw new ConfigError(`table.${key}`, `不是十进制数：${JSON.stringify(rate)}`);
    }
    if (Number(rate) <= 0) throw new ConfigError(`table.${key}`, `汇率必须为正，收到 ${JSON.stringify(rate)}`);
    table[currency] = rate;
  }
  // The base is its own unit: without it, every cross-rate would divide by zero.
  if (table[base] === undefined) throw new ConfigError('table', `缺少基准币种 ${base} 的汇率（应为 "1"）`);
  if (Number(table[base]) !== 1) throw new ConfigError(`table.${base}`, `基准币种的汇率应为 "1"，收到 ${JSON.stringify(table[base])}`);

  const sources = (document['sources'] === undefined ? [] : (document['sources'] as unknown[])).map((entry, index) => {
    const node = object(entry, `sources[${index}]`);
    const kind = text(node['kind'], `sources[${index}].kind`);
    if (kind !== 'frankfurter' && kind !== 'er-api') {
      throw new ConfigError(`sources[${index}].kind`, `未知的汇率源类型 ${JSON.stringify(kind)}（可用：frankfurter / er-api）`);
    }
    const typedKind: RateSourceConfig['kind'] = kind;
    const url = text(node['url'], `sources[${index}].url`);
    if (!/^https:\/\//.test(url)) throw new ConfigError(`sources[${index}].url`, `应为 https URL，收到 ${JSON.stringify(url)}`);
    return {
      id: text(node['id'], `sources[${index}].id`),
      label: text(node['label'], `sources[${index}].label`),
      kind: typedKind,
      url,
      publishes: text(node['publishes'], `sources[${index}].publishes`),
    };
  });
  if (sources.length === 0) throw new ConfigError('sources', '至少需要一个汇率源');
  const ids = new Set(sources.map((source) => source.id));
  if (ids.size !== sources.length) throw new ConfigError('sources', '汇率源 id 不能重复');

  return {
    version,
    updatedAt: text(document['updatedAt'], 'updatedAt'),
    base,
    source: text(document['source'], 'source'),
    table,
    sources,
  };
}

/** The shipped rate configuration. */
export function shippedRates(): RatesConfig {
  return parseRatesConfig(readFileSync(SHIPPED_PATH, 'utf8'));
}

/** The shipped configuration's raw text, for provenance lines. */
export function shippedRatesText(): string {
  return readFileSync(SHIPPED_PATH, 'utf8');
}
