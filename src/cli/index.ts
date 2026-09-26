#!/usr/bin/env node
/**
 * `agent-usages` — usage and cost reporting for coding agents.
 *
 * Five commands:
 *   - `usage`        — token consumption and cost, by all / project / session
 *   - `session list` — the project-and-session inventory, newest first
 *   - `price`        — the price list the cost calculation uses
 *   - `agents`       — which agents and pricing sources this build supports
 *   - `serve`        — the local web analysis platform over the same data
 *
 * The tool is deliberately two-axis: `--agent` picks where usage is read from,
 * `--provider` picks whose price list turns it into money. Neither axis knows
 * about the other, so adding a vendor or an agent is a module plus a registry
 * entry.
 */

import { Command, InvalidArgumentError } from 'commander';

import { AGENT_ADAPTERS, detectAgents, requireAgent, type AgentAdapter } from '../agents/index.ts';
import {
  PRICING_PROVIDERS,
  createPricingEngine,
  resolvePricingProvider,
  type PricingEngine,
  type RateComponent,
} from '../pricing/index.ts';
import { listSessions, runQuery, type SessionListFilters, type UsageDimension, type UsageQuery } from '../report/index.ts';
import { resolveRange } from '../report/timerange.ts';
import { resolveLanguage, setLanguage, t } from '../i18n/index.ts';
import { openInBrowser } from '../serve/open.ts';
import { renderDiagnostic, UserError, type Warning } from '../i18n/errors.ts';
import { mergeDatasets } from '../core/merge.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveConfig, type ResolvedConfig } from '../config/resolve.ts';
import { loadRateSeries, rateOn, type LoadedRateSeries } from '../config/series.ts';
import type { RateMode } from '../config/user.ts';
import { cachedConfigText, runUpdates, type UpdateKind } from '../config/update.ts';
import { parsePricingConfig, shippedPricingText } from '../pricing/catalog.ts';
import { parseRatesConfig, shippedRatesText } from '../pricing/rates.ts';
import { parseHolidaysConfig, shippedHolidaysText } from '../config/holidays.ts';
import { readUserConfig } from '../config/user.ts';
import { userConfigPath } from '../config/paths.ts';
import {
  chooseDisplay,
  convertProvider,
  currencyOf,
  providerCurrencies,
  rateFor,
  selectCurrency,
  type DisplayResolution,
} from '../pricing/currency.ts';
import { formatSessionList, formatUsageReport, sessionListToJson, usageToJson, type ReportSection } from '../render/format.ts';
import { renderHtmlReport } from '../render/html.ts';
import type { UsageDataset } from '../core/types.ts';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_NO_DATA = 2;

/** Options shared by every command. */
interface GlobalOptions {
  /** Agents to read: every occurrence of `--agent`, each already split on commas. */
  agent?: string[];
  home?: string;
  provider?: string;
  json?: boolean;
  /** Commander turns `--no-update` into `update: false`; absence means updates are allowed. */
  update?: boolean;
}

/** Options accepted by `usage`. */
interface UsageOptions extends GlobalOptions {
  subagent?: boolean;
  subagents?: boolean;
  cost?: boolean;
  models?: boolean;
  projectFilter?: string[];
  sessionFilter?: string[];
  repoFilter?: string[];
  range?: string;
  currency?: string;
  currencyRate?: string;
  rateMode?: string;
  noEnrich?: boolean;
  /** `--html <path>` writes a file; `--html` or `--html -` writes to stdout. */
  html?: string | boolean;
  /** `--open`: write the report somewhere the browser can read it, and show it. */
  open?: boolean;
}

/** Options accepted by `serve`. */
interface ServeOptions extends GlobalOptions {
  port?: number;
  host?: string;
  open?: boolean;
  refresh?: number;
  /** `--dev [target]`: `true` for the default Vite address, or the target itself. */
  dev?: boolean | string;
  devTarget?: string;
  snapshot?: string;
  quiet?: boolean;
  /** Write one snapshot and exit instead of listening. */
  writeSnapshot?: string;
}

/** A dataset plus everything needed to price and describe it. */
interface Loaded {
  /** Every agent's data, merged into one dataset. */
  dataset: UsageDataset;
  /** The adapters that were read, in selection order. */
  adapters: AgentAdapter[];
  engine: PricingEngine;
  /** Currency to print amounts in, and where that choice came from. */
  display: DisplayResolution;
  /** Symbol to print, empty when the user named no currency. */
  symbol: string;
  /** Anything the configuration layer wants the user to know. */
  warnings: Warning[];
}

/** Validate `--currency-rate`: a positive decimal, taken literally. */
function parseRateOption(value: string): string {
  if (!/^\d+(\.\d+)?$/.test(value.trim()) || Number(value) <= 0) {
    throw new InvalidArgumentError(renderDiagnostic('rateNotPositiveDecimal', { value: JSON.stringify(value) }));
  }
  return value.trim();
}

/**
 * Validate `--port`: 0 is legal, because it asks the OS for a free port.
 *
 * @param value - whatever followed the flag.
 * @returns the port number.
 */
function parsePortOption(value: string): number {
  const port = Number(value.trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidArgumentError(renderDiagnostic('servePortNotInteger', { value: JSON.stringify(value) }));
  }
  return port;
}

/** Validate `--refresh`: seconds between rescans, where 0 switches them off. */
function parseRefreshOption(value: string): number {
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new InvalidArgumentError(renderDiagnostic('serveRefreshNotSeconds', { value: JSON.stringify(value) }));
  }
  return seconds;
}

/**
 * Merge a subcommand's options with those of every ancestor command.
 *
 * commander does not copy an ancestor's options onto a subcommand, so a global
 * `--json` / `--home` / `--agent` placed before the command name would otherwise
 * be silently ignored. Values given closest to the leaf win.
 */
function withGlobals<T extends GlobalOptions>(command: Command, options: T): T {
  const chain: GlobalOptions[] = [];
  for (let current: Command | null = command.parent; current !== null; current = current.parent) {
    const parsed: unknown = current.opts();
    if (typeof parsed === 'object' && parsed !== null) chain.push(parsed as GlobalOptions);
  }
  const merged: GlobalOptions = {};
  for (const entry of chain) {
    if (entry.agent !== undefined) merged.agent = entry.agent;
    if (entry.home !== undefined) merged.home = entry.home;
    if (entry.provider !== undefined) merged.provider = entry.provider;
    if (entry.json !== undefined) merged.json = entry.json;
    // A negated flag defaults to `true`, so only an explicit `false` means the
    // user asked for it — otherwise an ancestor's default would clobber the
    // leaf's own `--no-update`.
    if (entry.update === false) merged.update = false;
  }
  if (options.agent !== undefined) merged.agent = options.agent;
  if (options.home !== undefined) merged.home = options.home;
  if (options.provider !== undefined) merged.provider = options.provider;
  if (options.json !== undefined) merged.json = options.json;
  if (options.update === false) merged.update = false;
  return { ...options, ...merged };
}

/**
 * The adapters a run should read.
 *
 * No `--agent` means every agent: the report answers "what did this machine
 * spend", and an agent that is not installed contributes nothing rather than
 * failing the run. Naming agents narrows it, and an explicitly named agent that
 * has no data is still an error — the user asked for that agent specifically.
 *
 * @param requested - every `--agent` value given, already comma-split.
 * @param home - an explicit data root, when given.
 * @returns the adapters to load, in selection order.
 * @throws {UserError} when an explicitly named agent is not one this build knows.
 */
async function selectAgents(requested: readonly string[] | undefined, home: string | undefined): Promise<AgentAdapter[]> {
  const wanted = (requested ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
  const everything = wanted.length === 0 || wanted.some((id) => id.toLowerCase() === 'all');
  if (everything) return detectAgents(home);
  const chosen: AgentAdapter[] = [];
  for (const id of wanted) {
    const adapter = requireAgent(id);
    // `--agent dsh --agent dsh` reads one agent once, not twice.
    if (!chosen.includes(adapter)) chosen.push(adapter);
  }
  return chosen;
}

/** How the report header names the agents a run read. */
function agentLabelOf(adapters: readonly AgentAdapter[]): string {
  return adapters.map((adapter) => adapter.label).join(' · ');
}

/** Resolve the agents, read their data, merge it, and build a pricing engine. */
async function loadOrExit(
  options: GlobalOptions & Pick<UsageOptions, 'currency' | 'currencyRate' | 'rateMode'>,
  config: ResolvedConfig,
): Promise<Loaded | undefined> {
  try {
    const adapters = await selectAgents(options.agent, options.home);
    if (adapters.length === 0) {
      const known = AGENT_ADAPTERS.map((adapter) => adapter.id).join('、');
      throw new Error(
        renderDiagnostic('noUsageData', { home: options.home ?? t().errors.defaultLocation, known }),
      );
    }
    const datasets = await Promise.all(
      adapters.map((adapter) =>
        adapter.load({
          ...(options.home === undefined ? {} : { home: options.home }),
          enrich: true,
        }),
      ),
    );
    // Every agent's projects become one project per place: the same directory
    // read by two agents is one row, a repository's worktrees are one row, and
    // the configuration can group what the filesystem cannot.
    const dataset = await mergeDatasets(datasets, config.projects.length === 0 ? {} : { projects: config.projects });
    const provider = resolvePricingProvider(options.provider, dataset.agent, config.providers);
    // The vendor's rates are rewritten into the display currency here, once, so
    // every amount and every unit price downstream is already in it.
    const published = providerCurrencies(provider);
    const choice = chooseDisplay({
      published,
      // The user's own file is the middle layer: a flag still wins over it.
      ...(options.currency !== undefined ? { currencyFlag: options.currency } : config.currency !== undefined ? { currencyFlag: config.currency } : {}),
      ...(options.currencyRate === undefined ? {} : { rateFlag: options.currencyRate }),
      ...(systemLocaleFromEnv() === undefined ? {} : { locale: systemLocaleFromEnv() }),
    });
    // One published list per model, in the currency the report will speak; the
    // rates are then converted — so a list published in the reader's currency is
    // used exactly as published, and anything else is converted from the list
    // that was.
    const selected = selectCurrency(provider, choice.baseWanted);
    const base = selected.currencies[0] ?? choice.baseWanted;
    const { rate, provenance } = rateFor({
      base,
      target: choice.currency?.code ?? null,
      manualRate: choice.manualRate,
      table: config.rateTable,
    });
    const mode: RateMode = options.rateMode === 'historical' || (options.rateMode === undefined && config.rateMode === 'historical')
      ? 'historical'
      : 'latest';
    // Historical mode cannot rewrite the rates once — each record needs the rate
    // of its own date — so the engine converts each record instead, and the price
    // list keeps the numbers the vendor published.
    let series: LoadedRateSeries | undefined;
    if (mode === 'historical' && choice.currency !== null && choice.manualRate === null) {
      series = await loadRateSeries({
        base,
        target: choice.currency.code,
        from: null,
        to: null,
        offline: options.update === false,
      });
    }
    const display: DisplayResolution = {
      currency: choice.currency,
      base,
      rate,
      provenance,
      reason: choice.reason,
      mode: series === undefined ? 'latest' : 'historical',
      ...(series === undefined ? {} : { series: series.detail }),
    };
    const engine = createPricingEngine(
      series === undefined
        ? convertProvider(selected.provider, choice.currency ?? { code: '', symbol: '', name: '' }, rate)
        : selected.provider,
      {
        ...(series === undefined ? {} : { convertAt: (instant: number) => rateOn(series as LoadedRateSeries, instant) }),
        ...(config.holidays === undefined ? {} : { holidays: config.holidays }),
      },
    );
    return {
      dataset,
      adapters,
      engine,
      display,
      symbol: display.currency?.symbol ?? '',
      warnings: config.warnings,
    };
  } catch (error) {
    process.stderr.write(`agent-usages: ${(error as Error).message}\n`);
    process.exitCode = EXIT_ERROR;
    return undefined;
  }
}

/** Emit JSON or text and set the exit code. */
function emit(payload: unknown, text: string, json: boolean, requests: number): void {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(text);
  process.exitCode = requests === 0 ? EXIT_NO_DATA : EXIT_OK;
}

/** The provenance of one report, for the header of whichever renderer prints it. */
interface ReportHeadings {
  /** Symbol amounts are printed with. */
  symbol: string;
  /** Agent display name. */
  agentLabel: string;
  /** Pricing provider's display name. */
  pricingLabel: string;
  /** Whether to print the 总 / 自身 / 子代理 split. */
  scope: boolean;
}

/** Render the HTML document both the file and the stdout paths emit. */
function htmlReport(sections: readonly ReportSection[], headings: ReportHeadings): string {
  return renderHtmlReport(sections, {
    agentLabel: headings.agentLabel,
    pricingLabel: headings.pricingLabel,
    symbol: headings.symbol,
    scope: headings.scope,
  });
}

/**
 * Write the HTML report and say where it went.
 *
 * A file the user asked for is the command's output, so a write failure is the
 * command's failure — the exit code says so rather than leaving a stale file
 * behind a zero.
 */
async function writeHtmlReport(
  path: string,
  sections: readonly ReportSection[],
  headings: ReportHeadings,
  json: boolean,
  requests: number,
): Promise<void> {
  const document = htmlReport(sections, headings);
  try {
    await writeFile(path, document, 'utf8');
  } catch (error) {
    // The reason has to name the path: `EACCES` alone does not say which file
    // could not be written, and the path is the one thing the user just typed.
    process.stderr.write(`agent-usages: ${t().html.writeFailed(path, (error as Error).message)}\n`);
    process.exitCode = EXIT_ERROR;
    return;
  }
  // Beside JSON the notice goes to stderr, so a script's stdout stays parseable.
  const notice = `${t().html.written(path)}\n`;
  if (json) {
    process.stderr.write(notice);
    process.stdout.write(`${JSON.stringify(usageToJson(sections), null, 2)}\n`);
  } else {
    process.stdout.write(notice);
  }
  process.exitCode = requests === 0 ? EXIT_NO_DATA : EXIT_OK;
}

/** The `usage` command implementation. */
async function runUsage(options: UsageOptions): Promise<void> {
  const config = await resolveConfig(options.update === false ? { noUpdate: true } : {});
  const loaded = await loadOrExit(options, config);
  if (loaded === undefined) return;
  const { dataset, engine, display, symbol } = loaded;

  let range: ReturnType<typeof resolveRange>;
  try {
    range = resolveRange(options.range === undefined ? {} : { spec: options.range });
  } catch (error) {
    process.stderr.write(`agent-usages: ${(error as Error).message}\n`);
    process.exitCode = EXIT_ERROR;
    return;
  }
  const ranges = [{ label: range.from === null && range.to === null ? t().scope.total : range.label, range }];

  const rate: UsageQuery['rate'] = {
    base: display.base,
    display: display.currency?.code ?? null,
    rate: display.rate,
    mode: display.mode,
    ...(display.series === undefined ? {} : { series: display.series }),
    reason: display.reason,
    source: display.provenance.source,
    date: display.provenance.date,
  };
  // `--subagents` implies the by-scope breakdown, because listing every subagent
  // without saying what they add up to would be less informative than the default.
  const subagentMode = options.subagents === true ? 'detail' : options.subagent === true ? 'subagents' : 'total';
  const sections: ReportSection[] = [];
  let requests = 0;
  for (const { label, range } of ranges) {
    const query: UsageQuery = {
      // The tree always needs session rows: it is what the renderer walks.
      dimension: 'session',
      range,
      currency: display.currency?.code ?? null,
      rate,
      subagentMode,
      ...(options.projectFilter === undefined ? {} : { projects: options.projectFilter }),
      ...(options.sessionFilter === undefined ? {} : { sessions: options.sessionFilter }),
      ...(options.repoFilter === undefined ? {} : { repos: options.repoFilter }),
    };
    const result = runQuery(dataset, query, { engine, pricingProvider: engine.provider.id });
    // Configuration problems belong where the other warnings are shown.
    result.warnings.push(...loaded.warnings);
    sections.push({ label, range, result });
    requests += result.requests;
  }

  // A written file replaces the text report: printing the tree as well would bury
  // the one line that says where it went. `--json` keeps its stream, because a
  // script asked for a machine-readable answer rather than a rendering.
  if (options.html !== undefined || options.open === true) {
    const headings: ReportHeadings = {
      symbol,
      agentLabel: agentLabelOf(loaded.adapters),
      pricingLabel: engine.provider.label,
      scope: subagentMode !== 'total',
    };
    // `--open` is "show me the report now": it writes the same document
    // somewhere the browser can read — the path `--html` named, or a file of
    // its own under the system's temporary directory, overwritten per day so
    // repeated runs do not litter.
    const tempPath = join(
      tmpdir(),
      `agent-usages-usage-${new Date().toISOString().slice(0, 10)}.html`,
    );
    if (options.open === true && (options.html === undefined || options.html === true || options.html === '-')) {
      await writeHtmlReport(tempPath, sections, headings, options.json === true, requests);
      if (process.exitCode !== EXIT_ERROR) await openInBrowser(tempPath);
      return;
    }
    // `--html` with no value, or `--html -`, is the pipeline spelling: the
    // document goes to stdout so it can be piped or redirected.
    const toStdout = options.html === true || options.html === '-';
    if (toStdout && options.json !== true) {
      process.stdout.write(htmlReport(sections, headings));
      process.exitCode = requests === 0 ? EXIT_NO_DATA : EXIT_OK;
      return;
    }
    if (toStdout) {
      // Both asked for stdout, and a script that passed `--json` must keep
      // receiving JSON: the rendering is skipped and the user is told why.
      process.stderr.write(`agent-usages: ${t().html.stdoutTakenByJson}\n`);
    } else {
      await writeHtmlReport(String(options.html), sections, headings, options.json === true, requests);
      if (options.open === true && process.exitCode !== EXIT_ERROR) await openInBrowser(String(options.html));
      return;
    }
  }

  emit(
    usageToJson(sections),
    formatUsageReport(sections, symbol, {
      agentLabel: agentLabelOf(loaded.adapters),
      pricingLabel: engine.provider.label,
      scope: subagentMode !== 'total',
      expandSubagents: subagentMode === 'detail',
      cost: options.cost === true,
      models: options.models === true,
    }),
    options.json === true,
    requests,
  );
}

/** Options accepted by `session list`. */
interface SessionListOptions extends GlobalOptions {
  subagent?: boolean;
  subagents?: boolean;
  projectFilter?: string[];
  sessionFilter?: string[];
  repoFilter?: string[];
}

/** The `session list` command implementation. */
async function runSessionList(options: SessionListOptions): Promise<void> {
  const config = await resolveConfig(options.update === false ? { noUpdate: true } : {});
  const loaded = await loadOrExit(options, config);
  if (loaded === undefined) return;
  const filters: SessionListFilters = {
    includeSubagents: options.subagents === true,
    ...(options.projectFilter === undefined ? {} : { projects: options.projectFilter }),
    ...(options.sessionFilter === undefined ? {} : { sessions: options.sessionFilter }),
    ...(options.repoFilter === undefined ? {} : { repos: options.repoFilter }),
  };
  const result = listSessions(loaded.dataset, filters);
  emit(
    sessionListToJson(result),
    formatSessionList(result, agentLabelOf(loaded.adapters)),
    options.json === true,
    result.totalSessions,
  );
}

/** Options accepted by `price`. */
interface PriceOptions extends GlobalOptions {
  all?: boolean;
  currency?: string;
  current?: boolean;
}

/** The `price` command implementation. */
function runPrice(options: PriceOptions, config: ResolvedConfig): void {
  const providers = options.all === true
    ? config.providers
    : [resolvePricingProvider(options.provider, undefined, config.providers)];
  const wanted = options.currency === undefined ? undefined : options.currency.trim().toUpperCase();
  const now = Date.now();
  const lines: string[] = [];
  for (const provider of providers) {
    const engine = createPricingEngine(provider, config.holidays === undefined ? {} : { holidays: config.holidays });
    const currencies = providerCurrencies(provider);
    const listed = currencies.filter((code) => wanted === undefined || code === wanted);
    if (listed.length === 0) {
      lines.push(t().price.missing(provider.label, provider.id, wanted ?? ''));
      lines.push('');
      continue;
    }
    lines.push(t().price.provider(provider.label, provider.id, listed.join(' / ')));
    lines.push(`  ${t().price.defaultModel}: ${provider.defaultModel ?? t().price.noDefaultModel}`);
    for (const price of provider.models()) {
      // A currency filter narrows the list; `--current` narrows it to the period
      // in effect now, which is what a price question is usually about.
      const shown = price.periods.filter(
        (period) =>
          (wanted === undefined || period.currency === wanted) &&
          (options.current !== true || (period.from <= now && (period.to === null || now < period.to))),
      );
      if (shown.length === 0) continue;
      lines.push(`\n  ${price.model}`);
      if (price.aliases.length > 1) {
        lines.push(`    ${t().price.aliases}: ${price.aliases.filter((alias) => alias !== price.model).join(t().period.listJoin)}`);
      }
      for (const period of shown) {
        lines.push(`    [${period.id}] ${period.label}（${period.currency}）`);
        lines.push(`      ${t().price.window}: ${engine.describeWindow(period)}`);
        lines.push(`      ${t().price.tiers}: ${engine.describeTiers(period)}`);
        const render = (components: readonly RateComponent[]): string =>
          components
            .map((component) => {
              // The card shows what the engine will actually charge: a tranche or
              // a TTL multiplier is part of the price, not a footnote.
              const notes: string[] = [];
              for (const [tier, multiplier] of Object.entries(component.ttlMultipliers ?? {})) {
                notes.push(t().rate.ttlMultiplier(tier, multiplier as string));
              }
              if (component.aboveThreshold !== undefined) {
                notes.push(
                  t().rate.overThreshold(String(component.aboveThreshold.tokens), component.aboveThreshold.rate),
                );
              }
              const note = notes.length === 0 ? '' : `（${notes.join(', ')}）`;
              return `${component.label} ${component.rate}${note}`;
            })
            .join(' / ') + ` ${currencyOf(period.currency).symbol}`;
        lines.push(`      ${t().price.offPeak}: ${render(period.offPeak)}`);
        if (period.peak !== null) lines.push(`      ${t().price.peak}: ${render(period.peak)}`);
        lines.push(`      ${t().price.source}: ${period.source}`);
        lines.push(`      ${t().price.note}: ${period.note}`);
      }
    }
    lines.push('');
  }
  lines.push(t().price.footnote);
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** Which kinds an `update` argument selects. */
function updateKinds(target: string): UpdateKind[] {
  const wanted = target.trim().toLowerCase();
  if (wanted === 'all' || wanted === '') return ['pricing', 'rates'];
  if (wanted === 'prices' || wanted === 'pricing' || wanted === '价格' || wanted === '价格表') return ['pricing'];
  if (wanted === 'rates' || wanted === 'rate' || wanted === '汇率') return ['rates'];
  throw new Error(t().update.unknownTarget(target));
}

/**
 * The `update` command implementation.
 *
 * Unlike the silent refresh a report does, this one reports what happened — it
 * is the command a user runs when they want to know.
 */
async function runUpdate(target: string, options: { force?: boolean; writeConfig?: boolean }): Promise<void> {
  let kinds: UpdateKind[];
  try {
    kinds = updateKinds(target);
  } catch (error) {
    process.stderr.write(`agent-usages: ${(error as Error).message}\n`);
    process.exitCode = EXIT_ERROR;
    return;
  }
  const outcomes = await runUpdates({ pricing: true, rates: true }, {
    kinds,
    ...(options.force === true ? { force: true } : {}),
  });
  for (const outcome of outcomes) {
    const label = outcome.kind === 'pricing' ? t().update.pricing : t().update.rates;
    process.stdout.write(`${label}  ${outcome.detail}\n`);
  }
  if (options.writeConfig === true && kinds.includes('rates')) {
    process.stdout.write(`${writeRatesToRepo()}\n`);
  }
  if (outcomes.every((outcome) => outcome.status === 'failed')) process.exitCode = EXIT_ERROR;
}

/**
 * Write the cached rate table back into the repository's configuration.
 *
 * The point is review: the fetched table lands in `config/rates.json` with the
 * sources and note the file already carries, and a human decides whether to
 * commit it.
 * @returns a line describing what was written.
 */
function writeRatesToRepo(): string {
  const cached = cachedConfigText('rates');
  if (cached === undefined) return t().update.noRatesToWrite;
  const current = JSON.parse(readFileSync(new URL('../config/rates.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  const fetched = JSON.parse(cached) as Record<string, unknown>;
  const before = (current['table'] ?? {}) as Record<string, string>;
  const after = (fetched['table'] ?? {}) as Record<string, string>;
  // A source may quote fewer currencies than the file already knows; keeping the
  // ones it omits is better than dropping them, and the count is reported so it
  // is never silent.
  const table: Record<string, string> = { ...before, ...after };
  const kept = Object.keys(table).filter((code) => after[code] === undefined).length;
  const document = {
    ...current,
    updatedAt: fetched['updatedAt'],
    base: fetched['base'],
    source: fetched['source'],
    table,
  };
  const path = fileURLToPath(new URL('../config/rates.json', import.meta.url));
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  const held = kept === 0 ? '' : t().update.heldCurrencies(kept);
  return t().update.wroteBack(path, String(Object.keys(after).length), String(fetched['updatedAt']), held);
}

/** The `check-config` command implementation. */
function runCheckConfig(json: boolean): void {
  const results: { file: string; ok: boolean; detail: string }[] = [];
  for (const [file, parse] of [
    ['config/pricing.json', (): unknown => parsePricingConfig(shippedPricingText())],
    ['config/rates.json', (): unknown => parseRatesConfig(shippedRatesText())],
    ['config/holidays.json', (): unknown => parseHolidaysConfig(JSON.parse(shippedHolidaysText()))],
  ] as const) {
    try {
      parse();
      results.push({ file, ok: true, detail: t().check.passed });
    } catch (error) {
      results.push({ file, ok: false, detail: (error as Error).message });
    }
  }
  const user = readUserConfig();
  for (const warning of user.warnings) results.push({ file: userConfigPath(), ok: false, detail: warning.message });
  if (json) {
    process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  } else {
    for (const result of results) process.stdout.write(`${result.ok ? '✓' : '✗'} ${result.file}  ${result.detail}\n`);
  }
  if (results.some((result) => !result.ok)) process.exitCode = EXIT_ERROR;
}

/** The `agents` command implementation. */
function runAgents(options: GlobalOptions): void {
  const lines = [t().agents.header];
  for (const adapter of AGENT_ADAPTERS) {
    const source = adapter.defaultSource(process.env) ?? t().agents.unknownSource;
    lines.push(`  ▸ ${adapter.id}  ${adapter.label}`);
    lines.push(`      ${t().agents.defaultSource}: ${source}`);
    if (adapter.envVars.length > 0) lines.push(`      ${t().agents.envVars}: ${adapter.envVars.join(t().period.listJoin)}`);
    for (const note of adapter.notes()) lines.push(`      · ${note}`);
  }
  lines.push('');
  lines.push(t().agents.providers);
  for (const provider of PRICING_PROVIDERS) {
    lines.push(`  ▸ ${provider.id}  ${provider.label}（${providerCurrencies(provider).join(' / ')}）`);
    lines.push(`      ${t().agents.models}: ${provider.models().map((price) => price.model).join(t().period.listJoin)}`);
  }
  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          agents: AGENT_ADAPTERS.map((adapter) => ({
            id: adapter.id,
            label: adapter.label,
            sessionNoun: adapter.sessionNoun,
            envVars: adapter.envVars,
            defaultSource: adapter.defaultSource(process.env),
            notes: adapter.notes(),
          })),
          pricingProviders: PRICING_PROVIDERS.map((provider) => ({
            id: provider.id,
            label: provider.label,
            currencies: providerCurrencies(provider),
            defaultModel: provider.defaultModel,
            models: provider.models().map((price) => ({
              model: price.model,
              aliases: price.aliases,
              periods: price.periods.length,
            })),
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * The `serve` command implementation.
 *
 * The web stack is imported here rather than at the top of the file: `usage` is
 * the command that runs on every shell prompt, and it should not pay to load
 * Express for a report it never serves.
 *
 * @param options - the command line, already merged with the global options.
 */
async function runServe(options: ServeOptions): Promise<void> {
  // `--provider` and `--json` are program-level options, so commander accepts
  // them before the subcommand name. A platform that quietly ignored them would
  // answer with a different price list or a different rendering than the one
  // asked for, so they are refused instead.
  if (options.provider !== undefined) throw new UserError('serveOptionUnsupported', { option: '--provider' });
  if (options.json === true) throw new UserError('serveOptionUnsupported', { option: '--json' });

  const { openStore, startServer } = await import('../serve/index.ts');
  const scan = {
    ...(options.agent === undefined ? {} : { agent: options.agent.join(',') }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
    // Unlike the library default, the command follows the CLI's convention: the
    // price list and the rates are refreshed when they are stale, unless the run
    // says `--no-update`.
    noUpdate: options.update === false,
  };

  if (options.writeSnapshot !== undefined) {
    const store = await openStore(scan);
    const dashboard = store.dashboard();
    await store.writeSnapshot(options.writeSnapshot);
    process.stdout.write(
      `${t().serve.snapshotWritten(
        options.writeSnapshot,
        String(dashboard.projects.length),
        String(dashboard.totals.requests),
      )}\n`,
    );
    return;
  }

  // `--dev-target` says where the proxy should point, which only means anything
  // in dev mode; passing it turns `--dev` on rather than being silently ignored.
  const devTarget = typeof options.dev === 'string' ? options.dev : options.devTarget;
  const dev = (options.dev !== undefined && options.dev !== false) || devTarget !== undefined;
  // The front end is looked for in the repo's `web/dist`; the variable lets a
  // packaged install — or a test — point somewhere else, and it has to work
  // through this entry point as well as through `node src/serve/main.ts`.
  const webRoot = process.env['AGENT_USAGES_WEB_DIST'];
  const running = await startServer({
    ...scan,
    port: options.port ?? 7788,
    host: options.host ?? '127.0.0.1',
    open: options.open === true,
    quiet: options.quiet === true,
    dev,
    ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
    ...(devTarget === undefined ? {} : { devTarget }),
    ...(webRoot === undefined ? {} : { webRoot }),
  });

  // Ctrl-C is how a server is normally stopped. Waiting for it is the whole
  // point of the command; closing the listener first lets a request in flight
  // finish rather than dropping it.
  await new Promise<void>((resolvePromise) => {
    const stop = (): void => resolvePromise();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await running.close();
}

/**
 * Accumulate a repeatable option, splitting commas.
 *
 * `--agent dsh,codex` and `--agent dsh --agent codex` mean the same thing; both
 * spellings exist because one is convenient to type and the other to generate.
 */
function collectList(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), ...value.split(',')];
}

/** Register the options every command shares. */
function commonOptions(command: Command): Command {
  return command
    .option('--agent <id>', t().help.agent, collectList)
    .option('--home <dir>', t().help.home)
    .option('--provider <id>', t().help.provider)
    .option('--json', t().help.json)
    .option('--no-update', t().help.noUpdate);
}

/** Build the commander program. */
export function buildProgram(): Command {
  const collect = (value: string, previous: string[] | undefined): string[] => [...(previous ?? []), value];

  const program = new Command();
  program
    .name('agent-usages')
    .description(t().help.program)
    .version('0.0.2');
  commonOptions(program);

  commonOptions(
    program
      .command('usage', { isDefault: true })
      .description(t().help.usage)
      .option('--range <spec>', t().help.range)
      .option('--subagent', t().help.subagent)
      .option('--subagents', t().help.subagents)
      .option('--cost', t().help.cost)
      .option('--models', t().help.models)
      .option('--html [path]', t().help.html)
      .option('--open', t().help.usageOpen)
      .option('-p, --project-filter <selector>', t().help.projectFilter, collect)
      .option('-s, --session-filter <selector>', t().help.sessionFilter, collect)
      .option('-r, --repo-filter <selector>', t().help.repoFilter, collect)
      .option('--currency <code>', t().help.currency)
      .option('--currency-rate <rate>', t().help.currencyRate, parseRateOption)
      .option('--rate-mode <mode>', t().help.rateMode),
  )
    .allowExcessArguments(false)
    .action(async (options: UsageOptions, command: Command) => {
      await runUsage(withGlobals(command, options));
    });

  program
    .command('update')
    .description(t().help.update)
    .argument('[target]', t().help.updateTarget, 'all')
    .option('--force', t().help.updateForce)
    .option('--write-config', t().help.updateWrite)
    .action(async (target: string, options: { force?: boolean; writeConfig?: boolean }) => {
      await runUpdate(target, options);
    });

  program
    .command('check-config')
    .description(t().help.checkConfig)
    .option('--json', t().help.json)
    .action((options: { json?: boolean }, command: Command) => {
      runCheckConfig(withGlobals(command, options).json === true);
    });

  const sessionCommand = commonOptions(program.command('session').description(t().help.sessionCommand));
  commonOptions(
    sessionCommand
      .command('list')
      .description(t().help.sessionList)
      .option('--subagents', t().help.sessionListSubagents)
      .option('-p, --project-filter <selector>', t().help.sessionListProjectFilter, collect)
      .option('-s, --session-filter <selector>', t().help.sessionListSessionFilter, collect)
      .option('-r, --repo-filter <selector>', t().help.sessionListRepoFilter, collect),
  ).action(async (options: SessionListOptions, command: Command) => {
    await runSessionList(withGlobals(command, options));
  });

  commonOptions(
    program
      .command('price')
      .description(t().help.price)
      .option('--all', t().help.priceAll)
      .option('--currency <code>', t().help.priceCurrency)
      .option('--current', t().help.priceCurrent),
  ).action(async (options: PriceOptions, command: Command) => {
    runPrice(withGlobals(command, options), await resolveConfig({ noUpdate: true }));
  });

  commonOptions(program.command('agents').description(t().help.agents)).action(
    (options: GlobalOptions, command: Command) => {
      runAgents(withGlobals(command, options));
    },
  );

  // `serve` takes the options that decide *what* is read plus its own hosting
  // ones; `--json` and `--provider` describe a rendering and a price list, which
  // a running platform does not have, so they are deliberately not accepted.
  program
    .command('serve')
    .description(t().help.serve)
    .option('--agent <id>', t().help.agent, collectList)
    .option('--home <dir>', t().help.home)
    .option('--no-update', t().help.noUpdate)
    .option('-p, --port <port>', t().help.servePort, parsePortOption)
    .option('--host <address>', t().help.serveHost)
    .option('--open', t().help.serveOpen)
    .option('--refresh <seconds>', t().help.serveRefresh, parseRefreshOption)
    .option('--snapshot <file>', t().help.serveSnapshot)
    .option('--dev [target]', t().help.serveDev)
    .option('--dev-target <url>', t().help.serveDevTarget)
    .option('-q, --quiet', t().help.serveQuiet)
    .option('--write-snapshot <file>', t().help.serveWriteSnapshot)
    .action(async (options: ServeOptions, command: Command) => {
      await runServe(withGlobals(command, options));
    });

  return program;
}

/**
 * The locale the machine reports.
 *
 * `Intl` already reflects `LANG`/`LC_ALL`, so it is asked first; the environment
 * is only a fallback for runtimes that cannot resolve one.
 */
function systemLocaleFromEnv(): string | undefined {
  const fromEnv = (process.env['LC_ALL'] ?? process.env['LC_MESSAGES'] ?? process.env['LANG'])?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    // `C` and `POSIX` are the user saying they have no locale, not a claim to be
    // English — and `Intl` would answer with its own default, so it is not asked.
    return /^(c|posix)$/i.test(fromEnv) ? undefined : fromEnv;
  }
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    if (resolved.length > 0) return resolved;
  } catch {
    // No locale available at all.
  }
  return undefined;
}

/** Run the CLI. */
async function main(): Promise<void> {
  // The language is settled before the program is built: commander renders help
  // text while parsing, and half a report in one language is worse than none.
  setLanguage(resolveLanguage(readUserConfig().config.language, systemLocaleFromEnv()));
  const program = buildProgram();
  program.exitOverride();
  try {
    // `ui` is the short spelling users reach for: the same command with the
    // browser step turned on. Rewriting argv keeps one definition of `serve`
    // (and its options) instead of a second, drifting copy under another name.
    const argv = [...process.argv];
    if (argv[2] === 'ui') argv.splice(2, 1, 'serve', '--open');
    await program.parseAsync(argv);
  } catch (error) {
    // commander throws for --help/--version and for parse failures alike.
    const code = (error as { exitCode?: number }).exitCode;
    if (typeof code === 'number') {
      if (code !== 0 && (error as Error).message.length > 0) process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = code;
      return;
    }
    process.stderr.write(`agent-usages: ${(error as Error).message}\n`);
    process.exitCode = EXIT_ERROR;
  }
}

await main();
