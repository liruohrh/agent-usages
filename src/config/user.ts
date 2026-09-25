/**
 * The user's own configuration, merged over the shipped defaults.
 *
 * The file is entirely optional and only ever holds *overrides*: what it does not
 * mention comes from `config/pricing.json` as shipped or fetched. Merging is by
 * time, not by whole table — a user period wins for the window it covers, and the
 * default list keeps every other window — so overriding one price never silently
 * drops the rest of the vendor's history.
 */

import { UserError, type Warning } from '../i18n/errors.ts';
import { t } from '../i18n/index.ts';
import { LANGUAGES, type Language } from '../i18n/index.ts';
import type { ProjectGroup } from '../core/merge.ts';
import type { PricePeriod } from '../pricing/contract.ts';
import { ConfigError, parsePricingConfig, type ProviderConfig } from './pricing.ts';
import { userConfigPath } from './paths.ts';
import { readJson } from './store.ts';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** One update switch. */
export interface UpdateSettings {
  /** Refresh the vendor price list automatically. */
  pricing: boolean;
  /** Refresh exchange rates automatically. */
  rates: boolean;
}

/** How amounts are converted to the display currency. */
export type RateMode = 'latest' | 'historical';

/** What a user's configuration file may say. */
export interface UserConfig {
  /** Language to speak, instead of the one the machine's locale implies. */
  language: Language | undefined;
  /** Display currency to use instead of the locale's. */
  currency: string | undefined;
  /** Whether to convert at one current rate or at each record's own date's rate. */
  rateMode: RateMode | undefined;
  /** Which resources may refresh themselves. */
  updates: UpdateSettings;
  /** Preferred rate source id, checked before the shipped order. */
  rateSource: string | undefined;
  /** Project overrides: which directories are one project. */
  projects: ProjectGroup[];
  /** Price overrides, in the shipped file's own shape. */
  pricing: ProviderConfig[];
}

/** The defaults a file starts from: prices refresh, rates do not. */
export const DEFAULT_UPDATES: UpdateSettings = { pricing: true, rates: false };

/** A user configuration plus anything worth telling the user about it. */
export interface LoadedUserConfig {
  /** What was read, with defaults filled in. */
  config: UserConfig;
  /** Problems found while reading the file. */
  warnings: Warning[];
}

/** The empty configuration: everything comes from the shipped files. */
function emptyConfig(): UserConfig {
  return {
    language: undefined,
    currency: undefined,
    rateMode: undefined,
    updates: { ...DEFAULT_UPDATES },
    rateSource: undefined,
    projects: [],
    pricing: [],
  };
}

/** Narrow an unknown JSON value to a record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Expand a leading `~` to the user's home directory.
 *
 * A configuration file is written once and read on machines with different
 * home directories, so `~/ws/app` has to mean *this* user's home, not the one
 * of whoever wrote the file. Only a leading `~` or `~/` is expanded; `~user`
 * and an embedded `~` are left alone, as shells do.
 * @param path - the configured path.
 * @param env - environment to resolve the home directory from.
 * @returns the path with `~` expanded.
 */
function expandHome(path: string, env: NodeJS.ProcessEnv): string {
  if (path === '~') return env['HOME'] ?? homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(env['HOME'] ?? homedir(), path.slice(2));
  return path;
}

/**
 * Read the `projects` section, rejecting anything malformed.
 *
 * The shape is `[{ name, paths: [...] }]`; each path is made absolute here, so
 * the merge layer never has to resolve anything relative to an unknown cwd. An
 * invalid entry is an error rather than a silent skip: a project the user
 * believes is configured but is not would quietly show up as several rows.
 * @param value - the raw `projects` value from the file.
 * @param env - environment for `~` expansion.
 * @returns the configured groups, in file order.
 * @throws {ConfigError} when the section is not an array of `{name, paths}`.
 */
function projectGroups(value: unknown, env: NodeJS.ProcessEnv): ProjectGroup[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError('projects', 'configExpectsArray', { value: JSON.stringify(value) });
  }
  return value.map((entry, index) => {
    const at = `projects[${index}]`;
    const record = asRecord(entry);
    if (record === undefined) {
      throw new ConfigError(at, 'configExpectsObject', { value: JSON.stringify(entry) });
    }
    const name = record['name'];
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ConfigError(`${at}.name`, 'configProjectName', { value: JSON.stringify(name ?? null) });
    }
    const paths = record['paths'];
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new ConfigError(`${at}.paths`, 'configProjectPaths', { value: JSON.stringify(paths ?? null) });
    }
    return {
      name: name.trim(),
      paths: paths.map((item, position) => {
        if (typeof item !== 'string' || item.trim().length === 0) {
          throw new ConfigError(`${at}.paths[${position}]`, 'configProjectPath', { value: JSON.stringify(item ?? null) });
        }
        return resolve(expandHome(item.trim(), env));
      }),
    };
  });
}

/** Read a language name, rejecting anything this build cannot speak. */
function languageSetting(value: unknown, path: string): Language | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)) return value as Language;
  throw new ConfigError(path, 'configUnknownLanguage', { known: LANGUAGES.join(' / '), value: JSON.stringify(value) });
}

/** Read a rate mode, rejecting anything else. */
function rateMode(value: unknown, path: string): RateMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'latest' || value === 'historical') return value;
  throw new ConfigError(path, 'configUnknownRateMode', { value: JSON.stringify(value) });
}

/** Read a boolean setting, rejecting anything else. */
function setting(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ConfigError(path, 'configExpectsBoolean', { value: JSON.stringify(value) });
  return value;
}

/**
 * Read the user's configuration file.
 *
 * Never throws: a file that is missing is the normal case, and a file that is
 * broken is reported as a warning and ignored, because a typo in an optional
 * override must not stop a report.
 * @param env - environment to resolve the path from.
 * @returns the configuration and any warnings about it.
 */
export function readUserConfig(env: NodeJS.ProcessEnv = process.env): LoadedUserConfig {
  const path = userConfigPath(env);
  const { value, failure } = readJson<unknown>(path);
  const warnings: Warning[] = [];
  if (failure !== undefined) {
    return {
      config: emptyConfig(),
      warnings: [new UserError('configIgnored', { path: failure.path, reason: failure.reason })],
    };
  }
  if (value === undefined) return { config: emptyConfig(), warnings: [] };
  try {
    const node = value as Record<string, unknown>;
    const version = node['version'] ?? 1;
    if (version !== 1) throw new ConfigError('version', 'configUnknownVersion', { version: JSON.stringify(version) });
    const updates = (node['updates'] ?? {}) as Record<string, unknown>;
    const currency = node['currency'];
    const rateSource = node['rateSource'];
    const pricing = node['pricing'] === undefined ? [] : parsePricingConfig(node['pricing']).providers;
    return {
      config: {
        language: languageSetting(node['language'], 'language'),
        rateMode: rateMode(node['rateMode'], 'rateMode'),
        currency:
          currency === undefined
            ? undefined
            : typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency.trim())
              ? currency.trim().toUpperCase()
              : (() => {
                  throw new ConfigError('currency', 'configCurrencyCode', { value: JSON.stringify(currency) });
                })(),
        updates: {
          pricing: setting(updates['pricing'], 'updates.pricing', DEFAULT_UPDATES.pricing),
          rates: setting(updates['rates'], 'updates.rates', DEFAULT_UPDATES.rates),
        },
        rateSource:
          rateSource === undefined
            ? undefined
            : typeof rateSource === 'string' && rateSource.trim().length > 0
              ? rateSource.trim()
              : (() => {
                  throw new ConfigError('rateSource', 'configRateSourceId', { value: JSON.stringify(rateSource) });
                })(),
        projects: projectGroups(node['projects'], env),
        pricing,
      },
      warnings,
    };
  } catch (error) {
    warnings.push(new UserError('configIgnored', { path, reason: (error as Error).message }));
    return { config: emptyConfig(), warnings };
  }
}

/**
 * Merge one price list over another by time.
 *
 * The union of both lists' boundaries is walked interval by interval; the
 * override wins wherever it covers an interval, the default keeps the rest. A
 * period that survives whole keeps its id, note and source; a period that had to
 * be cut gets a derived id so a reader can tell it apart from the published one.
 * @param base - the shipped or fetched list.
 * @param override - the user's list.
 * @returns the merged list, in ascending order per currency.
 */
export function mergePeriods(base: readonly PricePeriod[], override: readonly PricePeriod[]): PricePeriod[] {
  if (override.length === 0) return [...base];
  // A vendor's histories for different currencies cover the same windows, so they
  // are merged one currency at a time: tiling both at once would let the yuan
  // list answer for the dollar list's windows and drop it entirely.
  const codes = [...new Set([...base.map((period) => period.currency), ...override.map((period) => period.currency)])];
  const merged: PricePeriod[] = [];
  for (const code of codes) {
    const baseList = base.filter((period) => period.currency === code);
    const overrideList = override.filter((period) => period.currency === code);
    if (overrideList.length === 0) {
      merged.push(...baseList);
      continue;
    }
    if (baseList.length === 0) {
      merged.push(...overrideList);
      continue;
    }
    merged.push(...tile(baseList, overrideList));
  }
  return merged;
}

/**
 * Lay one history over another, interval by interval.
 *
 * Boundaries are unioned, each interval is awarded to whichever list covers it
 * (the override first), and periods that survive whole keep their identity.
 */
function tile(base: readonly PricePeriod[], override: readonly PricePeriod[]): PricePeriod[] {
  const bounds = new Set<number>();
  for (const period of [...base, ...override]) {
    bounds.add(period.from);
    if (period.to !== null) bounds.add(period.to);
  }
  const points = [...bounds].sort((left, right) => left - right);
  const covers = (list: readonly PricePeriod[], at: number): PricePeriod | undefined =>
    list.find((period) => period.from <= at && (period.to === null || at < period.to));
  const merged: PricePeriod[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const from = points[index] as number;
    const next: number | undefined = points[index + 1];
    const chosen = covers(override, from) ?? covers(base, from);
    if (chosen === undefined) continue;
    if (next === undefined) {
      // Nothing else bounds the timeline here: a period that runs to the end
      // keeps running — whole if it started here, a fragment otherwise — and a
      // bounded one simply stops where it stops.
      if (chosen.to !== null) continue;
      merged.push(
        chosen.from === from
          ? { ...chosen }
          : { ...chosen, id: `${chosen.id}#${from}`, from, to: null, note: `${chosen.note}${t().errors.mergedFragment}` },
      );
      continue;
    }
    if (next <= from) continue;
    const whole = chosen.from === from && chosen.to === next;
    merged.push(
      whole
        ? { ...chosen }
        : { ...chosen, id: `${chosen.id}#${from}`, from, to: next, note: `${chosen.note}${t().errors.mergedFragment}` },
    );
  }
  return merged;
}

/**
 * Merge the user's providers over the shipped ones.
 * @param base - providers from the shipped or fetched configuration.
 * @param overrides - providers from the user's file.
 * @returns the merged providers, with the user's windows taking precedence.
 * @throws {ConfigError} when only the user's own entry is malformed; the caller
 *   validates the result again, so overlaps cannot survive this function.
 */
export function mergeProviders(base: readonly ProviderConfig[], overrides: readonly ProviderConfig[]): ProviderConfig[] {
  const merged = base.map((provider) => ({ ...provider, models: [...provider.models] }));
  for (const override of overrides) {
    const existing = merged.find((provider) => provider.id === override.id);
    if (existing === undefined) {
      merged.push(override);
      continue;
    }
    if (override.defaultModel !== null) existing.defaultModel = override.defaultModel;
    for (const model of override.models) {
      const known = existing.models.find((candidate) => candidate.model === model.model);
      if (known === undefined) {
        existing.models.push(model);
        continue;
      }
      existing.models = existing.models.map((candidate) =>
        candidate.model === model.model
          ? {
              ...candidate,
              aliases: [...new Set([...candidate.aliases, ...model.aliases])],
              periods: mergePeriods(candidate.periods, model.periods),
            }
          : candidate,
      );
    }
  }
  return merged;
}
