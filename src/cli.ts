#!/usr/bin/env node
/**
 * `agent-usages` — usage and cost reporting for coding agents.
 *
 * Four commands:
 *   - `usage`        — token consumption and cost, by all / project / session
 *   - `session list` — the project-and-session inventory, newest first
 *   - `price`        — the price list the cost calculation uses
 *   - `agents`       — which agents and pricing sources this build supports
 *
 * The tool is deliberately two-axis: `--agent` picks where usage is read from,
 * `--provider` picks whose price list turns it into money. Neither axis knows
 * about the other, so adding a vendor or an agent is a module plus a registry
 * entry.
 */

import { Command, InvalidArgumentError } from 'commander';

import { AGENT_ADAPTERS, resolveAgent, type AgentAdapter } from './agents/index.ts';
import {
  PRICING_PROVIDERS,
  createPricingEngine,
  resolvePricingProvider,
  type PricingEngine,
} from './pricing/index.ts';
import { listSessions, runQuery, type SessionListFilters, type UsageDimension, type UsageQuery } from './report.ts';
import { resolveRange } from './timerange.ts';
import { resolveLanguage, setLanguage, t } from './i18n/index.ts';
import { renderDiagnostic, type Warning } from './i18n/errors.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveConfig, type ResolvedConfig } from './config/resolve.ts';
import { loadRateSeries, rateOn, type LoadedRateSeries } from './config/series.ts';
import type { RateMode } from './config/user.ts';
import { cachedConfigText, runUpdates, type UpdateKind } from './config/update.ts';
import { parsePricingConfig, shippedPricingText } from './config/pricing.ts';
import { parseRatesConfig, shippedRatesText } from './config/rates.ts';
import { readUserConfig } from './config/user.ts';
import { userConfigPath } from './config/paths.ts';
import {
  chooseDisplay,
  convertProvider,
  currencyOf,
  providerCurrencies,
  rateFor,
  selectCurrency,
  type DisplayResolution,
} from './pricing/currency.ts';
import { formatSessionList, formatUsageReport, sessionListToJson, usageToJson, type ReportSection } from './format.ts';
import type { UsageDataset } from './core/types.ts';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_NO_DATA = 2;

/** Options shared by every command. */
interface GlobalOptions {
  agent?: string;
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
  range?: string;
  currency?: string;
  currencyRate?: string;
  rateMode?: string;
  noEnrich?: boolean;
}

/** A dataset plus everything needed to price and describe it. */
interface Loaded {
  dataset: UsageDataset;
  adapter: AgentAdapter;
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
    throw new InvalidArgumentError(`汇率必须是正的十进制数，收到 ${JSON.stringify(value)}`);
  }
  return value.trim();
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

/** Resolve the agent, read its data, and build a pricing engine for it. */
async function loadOrExit(
  options: GlobalOptions & Pick<UsageOptions, 'currency' | 'currencyRate' | 'rateMode'>,
  config: ResolvedConfig,
): Promise<Loaded | undefined> {
  try {
    const adapter = await resolveAgent(options.agent, options.home);
    const dataset = await adapter.load({
      ...(options.home === undefined ? {} : { home: options.home }),
      enrich: true,
    });
    const provider = resolvePricingProvider(options.provider, adapter.id, config.providers);
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
      series === undefined ? {} : { convertAt: (instant: number) => rateOn(series as LoadedRateSeries, instant) },
    );
    return {
      dataset,
      adapter,
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
    };
    const result = runQuery(dataset, query, { engine, pricingProvider: engine.provider.id });
    // Configuration problems belong where the other warnings are shown.
    result.warnings.push(...loaded.warnings);
    sections.push({ label, range, result });
    requests += result.requests;
  }

  emit(
    usageToJson(sections),
    formatUsageReport(sections, symbol, {
      agentLabel: loaded.adapter.label,
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
  };
  const result = listSessions(loaded.dataset, filters);
  emit(
    sessionListToJson(result),
    formatSessionList(result, loaded.adapter.label),
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
    const engine = createPricingEngine(provider);
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
        const render = (components: readonly { label: string; rate: string; per: number }[]): string =>
          components.map((component) => `${component.label} ${component.rate}`).join(' / ') + ` ${currencyOf(period.currency).symbol}`;
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

/** Register the options every command shares. */
function commonOptions(command: Command): Command {
  return command
    .option('--agent <id>', t().help.agent)
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
    .version('0.2.0');
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
      .option('-p, --project-filter <selector>', t().help.projectFilter, collect)
      .option('-s, --session-filter <selector>', t().help.sessionFilter, collect)
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
      .option('-p, --project-filter <selector>', '只列出指定项目（可重复）', collect)
      .option('-s, --session-filter <selector>', '只列出指定会话：id、唯一前缀或标题（标题需完全一致，忽略前后空格；可重复）', collect),
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
    await program.parseAsync(process.argv);
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
