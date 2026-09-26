/**
 * The configuration a command actually runs on.
 *
 * Three layers, in order of authority: the user's own file, the freshest
 * configuration available (a fetched copy when there is one, otherwise the file
 * shipped with this build), and nothing else. Assembling them in one place means
 * every command sees the same prices and the same rates, and that a broken layer
 * degrades to the one below it instead of failing the run.
 */

import { UserError, renderDiagnostic, type Warning } from '../i18n/errors.ts';
import type { Language } from '../i18n/index.ts';
import { readHolidays, type HolidayCalendar } from './holidays.ts';
import type { ProjectGroup } from '../core/merge.ts';
import type { PricingProvider } from '../pricing/contract.ts';
import type { RateTable } from '../pricing/currency.ts';
import { mergeProviders, readUserConfig, type RateMode, type UpdateSettings } from './user.ts';
import { parsePricingConfig, providerFromConfig, shippedPricingText, validateProviders, type ProviderConfig } from './pricing.ts';
import { parseRatesConfig, shippedRatesText, type RatesConfig } from './rates.ts';
import { cachedConfigText, runUpdates, type UpdateKind } from './update.ts';

/** Everything a command needs from the configuration. */
export interface ResolvedConfig {
  /** Providers to price with, user overrides already merged in. */
  providers: PricingProvider[];
  /** Rates to convert with. */
  rateTable: RateTable;
  /** Sources available for a rate refresh, in order. */
  rateSources: RatesConfig['sources'];
  /** Language the user pinned, if any. */
  language: Language | undefined;
  /** Currency the user pinned, if any. */
  currency: string | undefined;
  /** How to convert, when the user pinned a mode. */
  rateMode: RateMode | undefined;
  /** Rate source the user prefers, if any. */
  rateSource: string | undefined;
  /** Projects the user declared, for the merge layer. */
  projects: ProjectGroup[];
  /** Which automatic updates are allowed. */
  updates: UpdateSettings;
  /** Anything worth showing about how the configuration was put together. */
  warnings: Warning[];
  /** The holiday calendar, when one could be read. */
  holidays: HolidayCalendar | undefined;
}

/** What the caller knows about the run. */
export interface ResolveOptions {
  /** Environment to resolve paths from. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Skip the network entirely (`--no-update`). */
  noUpdate?: boolean | undefined;
  /** Ignore the once-a-day rule (`update --force`). */
  force?: boolean | undefined;
  /** Injectable clock, for tests. */
  now?: Date | undefined;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch | undefined;
  /** Restrict which kinds may refresh; only `update` passes this. */
  kinds?: readonly UpdateKind[] | undefined;
}

/** Parse the price configuration from whichever layer is freshest. */
function pricingProviders(env: NodeJS.ProcessEnv, warnings: Warning[]): ProviderConfig[] {
  const cached = cachedConfigText('pricing', env);
  if (cached !== undefined) {
    try {
      return parsePricingConfig(cached).providers;
    } catch (error) {
      warnings.push(new UserError('cachedPricesUnusable', { reason: (error as Error).message }));
    }
  }
  return parsePricingConfig(shippedPricingText()).providers;
}

/** Parse the rate configuration from whichever layer is freshest. */
function ratesConfig(env: NodeJS.ProcessEnv, warnings: Warning[]): RatesConfig {
  const cached = cachedConfigText('rates', env);
  if (cached !== undefined) {
    try {
      return parseRatesConfig(cached);
    } catch (error) {
      warnings.push(new UserError('cachedRatesUnusable', { reason: (error as Error).message }));
    }
  }
  return parseRatesConfig(shippedRatesText());
}

/**
 * Assemble the configuration a command should use.
 *
 * Updating is best-effort and happens before reading, so a successful refresh is
 * visible to the very command that triggered it. A failure is silent here: the
 * fallback chain covers it, and `update` is where a user asks about it.
 * @param options - environment, network switches, injectable clock and fetch.
 * @returns the configuration, with the user's overrides merged in.
 */
export async function resolveConfig(options: ResolveOptions = {}): Promise<ResolvedConfig> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const warnings: Warning[] = [];
  const user = readUserConfig(env);
  warnings.push(...user.warnings);

  if (options.noUpdate !== true) {
    await runUpdates(user.config.updates, {
      env,
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
    });
  }

  const base = pricingProviders(env, warnings);
  const merged = user.config.pricing.length === 0 ? base : mergeProviders(base, user.config.pricing);
  let providers: ProviderConfig[];
  try {
    // Re-checking the merged result with the domain rules — not the file parser,
    // which expects ISO text where the merge works in instants — is what
    // guarantees an override cannot leave a hole or an overlap behind.
    validateProviders(merged);
    providers = merged;
  } catch (error) {
    warnings.push(new UserError('mergeFailed', { reason: (error as Error).message }));
    providers = base;
  }

  const rates = ratesConfig(env, warnings);
  const holidays = readHolidays(env, warnings);
  // A period that prices holidays needs a calendar that still covers the days it
  // is applied to. Falling back to the weekday rule is the only safe behaviour,
  // but it must be *said*: the alternative is a holiday silently billed at the
  // peak rate, which is money the user did not spend.
  if (holidays !== undefined) {
    for (const provider of providers) {
      for (const model of provider.models) {
        for (const period of model.periods) {
          if (period.holidayCalendar === undefined) continue;
          // A day of slack: this is a "go update the file" reminder, not a billing
          // decision, and the calendar's own zone is the vendor's, not UTC's.
          const covered = Date.parse(`${holidays.to}T00:00:00Z`) + 86_400_000;
          if ((period.to ?? now.getTime()) <= covered) continue;
          warnings.push(
            new UserError('holidaysNotCovering', { to: holidays.to, name: provider.label }),
          );
          break;
        }
      }
    }
  }
  return {
    providers: providers.map(providerFromConfig),
    holidays,
    rateTable: {
      base: rates.base,
      rates: rates.table,
      provenance: {
        source: renderDiagnostic('rateSourceBuiltin', { source: rates.source }),
        date: rates.updatedAt,
      },
    },
    rateSources: rates.sources,
    language: user.config.language,
    currency: user.config.currency,
    rateMode: user.config.rateMode,
    rateSource: user.config.rateSource,
    projects: user.config.projects,
    updates: user.config.updates,
    warnings,
  };
}
