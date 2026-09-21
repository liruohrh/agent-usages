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
import { resolveRange, type RangePreset } from './timerange.ts';
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
}

/** Options accepted by `usage`. */
interface UsageOptions extends GlobalOptions {
  subagent?: boolean;
  subagents?: boolean;
  today?: boolean;
  week?: boolean;
  windows?: boolean;
  cost?: boolean;
  models?: boolean;
  projectFilter?: string[];
  sessionFilter?: string[];
  month?: boolean;
  year?: boolean;
  from?: string;
  to?: string;
  currency?: string;
  currencyRate?: string;
  noEnrich?: boolean;
}

/** A dataset plus everything needed to price and describe it. */
interface Loaded {
  dataset: UsageDataset;
  adapter: AgentAdapter;
  engine: PricingEngine;
  currency: string;
  symbol: string;
}

/** Parse a non-negative float for `--currency-rate`. */
function parseRateOption(value: string): string {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new InvalidArgumentError(`汇率必须是非负数字，收到 ${JSON.stringify(value)}`);
  }
  return value;
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
  }
  if (options.agent !== undefined) merged.agent = options.agent;
  if (options.home !== undefined) merged.home = options.home;
  if (options.provider !== undefined) merged.provider = options.provider;
  if (options.json !== undefined) merged.json = options.json;
  return { ...options, ...merged };
}

/** Resolve the agent, read its data, and build a pricing engine for it. */
async function loadOrExit(options: GlobalOptions): Promise<Loaded | undefined> {
  try {
    const adapter = await resolveAgent(options.agent, options.home);
    const dataset = await adapter.load({
      ...(options.home === undefined ? {} : { home: options.home }),
      enrich: true,
    });
    const provider = resolvePricingProvider(options.provider, adapter.id);
    const engine = createPricingEngine(provider);
    return {
      dataset,
      adapter,
      engine,
      currency: provider.currency.code,
      symbol: provider.currency.symbol,
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

/** The presets `--windows` expands, in display order. */
const WINDOW_PRESETS: readonly { label: string; preset: RangePreset }[] = [
  { label: '今日', preset: 'today' },
  { label: '本周', preset: 'week' },
  { label: '本月', preset: 'month' },
  { label: '今年', preset: 'year' },
];

/** The `usage` command implementation. */
async function runUsage(spec: string | undefined, options: UsageOptions): Promise<void> {
  const loaded = await loadOrExit(options);
  if (loaded === undefined) return;
  const { dataset, engine, currency, symbol } = loaded;

  const presetCount = [options.today, options.week, options.month, options.year].filter(Boolean).length;
  if (presetCount > 1) {
    process.stderr.write('agent-usages: --today / --week / --month / --year 只能指定一个\n');
    process.exitCode = EXIT_ERROR;
    return;
  }
  const preset: RangePreset | undefined =
    options.today === true ? 'today' : options.week === true ? 'week' : options.month === true ? 'month' : options.year === true ? 'year' : undefined;
  if (options.windows === true && preset !== undefined) {
    process.stderr.write('agent-usages: --windows 已经包含四个时间窗口，不能再指定 --today/--week/--month/--year\n');
    process.exitCode = EXIT_ERROR;
    return;
  }
  if (options.windows === true && (spec !== undefined || options.from !== undefined || options.to !== undefined)) {
    process.stderr.write('agent-usages: --windows 不能与位置参数或 --from/--to 同时使用\n');
    process.exitCode = EXIT_ERROR;
    return;
  }

  let ranges: { label: string; range: ReturnType<typeof resolveRange> }[];
  try {
    ranges = options.windows === true
      ? [
          { label: '总', range: resolveRange({}) },
          ...WINDOW_PRESETS.map((window) => ({ label: window.label, range: resolveRange({ preset: window.preset }) })),
        ]
      : [
          (() => {
            const range = resolveRange({
              ...(spec === undefined ? {} : { spec }),
              ...(options.from === undefined ? {} : { from: options.from }),
              ...(options.to === undefined ? {} : { to: options.to }),
              ...(preset === undefined ? {} : { preset }),
            });
            return { label: range.from === null && range.to === null ? '总' : range.label, range };
          })(),
        ];
  } catch (error) {
    process.stderr.write(`agent-usages: ${(error as Error).message}\n`);
    process.exitCode = EXIT_ERROR;
    return;
  }

  const currencyRate = options.currencyRate === undefined ? 1 : Number(options.currencyRate);
  const selectedCurrency = (options.currency ?? currency).toUpperCase();
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
      currencyRate,
      // The provider's own currency unless the user renamed it; `--currency-rate`
      // is what actually converts, so a mismatched label is warned about below.
      currency: selectedCurrency,
      subagentMode,
      ...(options.projectFilter === undefined ? {} : { projects: options.projectFilter }),
      ...(options.sessionFilter === undefined ? {} : { sessions: options.sessionFilter }),
    };
    const result = runQuery(dataset, query, { engine, pricingProvider: engine.provider.id });
    if (selectedCurrency !== currency && options.currencyRate === undefined && !options.json) {
      result.warnings.push(
        `${engine.provider.label} 以 ${currency} 计价；--currency ${selectedCurrency} 未同时给出 --currency-rate，金额仍按 1:1 显示`,
      );
    }
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
  const loaded = await loadOrExit(options);
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
}

/** The `price` command implementation. */
function runPrice(options: PriceOptions): void {
  const providers = options.all === true
    ? PRICING_PROVIDERS
    : [resolvePricingProvider(options.provider)];
  const lines: string[] = [];
  for (const provider of providers) {
    const engine = createPricingEngine(provider);
    lines.push(`▸ ${provider.label}（${provider.id}，${provider.currency.code} / 百万 tokens）`);
    lines.push(`  默认价格模型: ${provider.defaultModel ?? '（无，未知模型不计价）'}`);
    for (const price of provider.models()) {
      lines.push(`\n  ${price.model}`);
      if (price.aliases.length > 1) {
        lines.push(`    别名: ${price.aliases.filter((alias) => alias !== price.model).join('、')}`);
      }
      for (const period of price.periods) {
        lines.push(`    [${period.id}] ${period.label}`);
        lines.push(`      生效: ${engine.describeWindow(period)}`);
        lines.push(`      峰谷: ${engine.describeTiers(period)}`);
        const render = (components: readonly { label: string; rate: string; per: number }[]): string =>
          components.map((component) => `${component.label} ${component.rate}`).join(' / ') + ' 元';
        lines.push(`      空闲: ${render(period.offPeak)}`);
        if (period.peak !== null) lines.push(`      高峰: ${render(period.peak)}`);
        lines.push(`      来源: ${period.source}`);
        lines.push(`      说明: ${period.note}`);
      }
    }
    lines.push('');
  }
  lines.push('说明: 价格单位为「元 / 百万 tokens」；推理 token 已计入输出，不另行计费。');
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** The `agents` command implementation. */
function runAgents(options: GlobalOptions): void {
  const lines = ['支持的 agent（--agent）:'];
  for (const adapter of AGENT_ADAPTERS) {
    const source = adapter.defaultSource(process.env) ?? '（无法自动确定）';
    lines.push(`  ▸ ${adapter.id}  ${adapter.label}`);
    lines.push(`      默认数据目录: ${source}`);
    if (adapter.envVars.length > 0) lines.push(`      环境变量: ${adapter.envVars.join('、')}`);
    for (const note of adapter.notes()) lines.push(`      · ${note}`);
  }
  lines.push('');
  lines.push('支持的计价来源（--provider）:');
  for (const provider of PRICING_PROVIDERS) {
    lines.push(`  ▸ ${provider.id}  ${provider.label}（${provider.currency.code}）`);
    lines.push(`      模型: ${provider.models().map((price) => price.model).join('、')}`);
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
            currency: provider.currency,
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
    .option('--agent <id>', 'agent 类型（默认自动探测；见 `agents`）')
    .option('--home <dir>', 'agent 的数据目录（默认用该 agent 的环境变量或标准位置）')
    .option('--provider <id>', '计价来源（默认按 agent 选择；见 `agents`）')
    .option('--json', '以 JSON 输出');
}

/** Build the commander program. */
export function buildProgram(): Command {
  const collect = (value: string, previous: string[] | undefined): string[] => [...(previous ?? []), value];

  const program = new Command();
  program
    .name('agent-usages')
    .description('统计 coding agent 的 token 消耗与费用')
    .version('0.2.0');
  commonOptions(program);

  commonOptions(
    program
      .command('usage', { isDefault: true })
      .description('计算 token 消耗与费用')
      .argument('[range]', '时间范围：today/week/month/year（可加偏移，如 month-1）或 "起始..结束"')
      .option('--subagent', '每个项目与会话额外拆成 总 / 自身 / 子代理')
      .option('--subagents', '在 --subagent 之外，把每个子代理也单独列出')
      .option('--windows', '同时输出 总 / 今日 / 本周 / 本月 / 今年')
      .option('--cost', '附上费用明细与计价区间（单价）')
      .option('--models', '附上按模型的明细')
      .option('-p, --project-filter <selector>', '只统计指定项目：id、名称或路径（支持 * 通配；可重复）', collect)
      .option('-s, --session-filter <selector>', '只统计指定会话：id、唯一前缀或标题（标题需完全一致，忽略前后空格；支持 * 通配；可重复）', collect)
      .option('--today', '时间范围：今天')
      .option('--week', '时间范围：本周（周一开始）')
      .option('--month', '时间范围：本月')
      .option('--year', '时间范围：今年')
      .option('--from <time>', '起始时间（含），如 2026-09-01 或 2026-09-01T10:30')
      .option('--to <time>', '结束时间，日期形式含当天')
      .option('--currency <code>', '显示货币（默认取计价来源的货币）')
      .option('--currency-rate <rate>', '1 单位计价货币折算为目标货币的汇率（默认 1）', parseRateOption),
  )
    .allowExcessArguments(false)
    .action(async (range: string | undefined, options: UsageOptions, command: Command) => {
      await runUsage(range, withGlobals(command, options));
    });

  const sessionCommand = commonOptions(program.command('session').description('会话相关操作'));
  commonOptions(
    sessionCommand
      .command('list')
      .description('列出所有项目与会话（项目按首个会话时间降序，会话按时间降序）')
      .option('--subagents', '将子代理单独列出（默认并入其父会话）')
      .option('-p, --project-filter <selector>', '只列出指定项目（可重复）', collect)
      .option('-s, --session-filter <selector>', '只列出指定会话：id、唯一前缀或标题（标题需完全一致，忽略前后空格；可重复）', collect),
  ).action(async (options: SessionListOptions, command: Command) => {
    await runSessionList(withGlobals(command, options));
  });

  commonOptions(
    program
      .command('price')
      .description('显示内置价格表与生效区间（不读取任何数据）')
      .option('--all', '列出全部计价来源'),
  ).action((options: PriceOptions, command: Command) => {
    runPrice(withGlobals(command, options));
  });

  commonOptions(program.command('agents').description('列出支持的 agent 与计价来源')).action(
    (options: GlobalOptions, command: Command) => {
      runAgents(withGlobals(command, options));
    },
  );

  return program;
}

/** Run the CLI. */
async function main(): Promise<void> {
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
