#!/usr/bin/env node
/**
 * `dsh-usage` command line interface.
 *
 * Two commands:
 *   - `usage`        — token consumption and cost, by all / project / session
 *   - `session list` — the project-and-session inventory, newest first
 *
 * Cost is computed from DeepSeek's published per-period, peak/off-peak rates;
 * see `pricing-data.ts` for the schedule and its sources.
 */

import { Command, InvalidArgumentError } from 'commander';

import { loadDataset, resolveDshHome } from './loader.ts';
import { PricingEngine } from './pricing.ts';
import { runQuery, listSessions, type UsageDimension, type UsageQuery } from './report.ts';
import { resolveRange } from './timerange.ts';
import {
  formatSessionList,
  formatUsageReport,
  sessionListToJson,
  usageToJson,
} from './format.ts';
import { DEFAULT_PRICING_MODEL, PRICING_CURRENCY } from './pricing-data.ts';
import type { UsageDataset } from './types.ts';

/** Exit codes used by this CLI. */
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_NO_DATA = 2;

/** Options shared by both commands. */
interface GlobalOptions {
  home?: string;
  json?: boolean;
}

/** Options accepted by `usage`. */
interface UsageOptions extends GlobalOptions {
  all?: boolean;
  project?: boolean;
  session?: boolean;
  subagents?: boolean;
  projectFilter?: string[];
  sessionFilter?: string[];
  today?: boolean;
  month?: boolean;
  year?: boolean;
  from?: string;
  to?: string;
  currency?: string;
  currencyRate?: string;
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
 * Merge a subcommand's options with the options of every ancestor command.
 *
 * commander does not copy an ancestor's options onto a subcommand, so a global
 * `--json` / `--home` placed before the command name would otherwise be
 * silently ignored. Values given closest to the leaf win.
 */
function withGlobals<T extends GlobalOptions>(command: Command, options: T): T {
  const chain: GlobalOptions[] = [];
  for (let current: Command | null = command.parent; current !== null; current = current.parent) {
    const parsed: unknown = current.opts();
    if (typeof parsed === 'object' && parsed !== null) chain.push(parsed as GlobalOptions);
  }
  const merged: GlobalOptions = {};
  for (const entry of chain) {
    if (entry.home !== undefined) merged.home = entry.home;
    if (entry.json !== undefined) merged.json = entry.json;
  }
  if (options.home !== undefined) merged.home = options.home;
  if (options.json !== undefined) merged.json = options.json;
  return { ...options, ...merged };
}

/** Pick the requested dimension from the mutually exclusive flags. */
function resolveDimension(options: UsageOptions): UsageDimension {
  const chosen = [
    options.all === true ? 'all' : undefined,
    options.project === true ? 'project' : undefined,
    options.session === true ? 'session' : undefined,
  ].filter((value): value is UsageDimension => value !== undefined);
  if (chosen.length > 1) {
    throw new Error('--all / --project / --session 只能指定一个');
  }
  return chosen[0] ?? 'all';
}

/** Load the dataset, mapping loader failures onto a friendly exit. */
async function loadOrExit(options: GlobalOptions): Promise<UsageDataset | undefined> {
  try {
    return await loadDataset(options.home === undefined ? {} : { home: options.home });
  } catch (error) {
    process.stderr.write(`dsh-usage: ${(error as Error).message}\n`);
    process.exitCode = EXIT_ERROR;
    return undefined;
  }
}

/** Emit JSON or text and set the exit code. */
function emit(payload: unknown, text: string, json: boolean, requests: number): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(text);
  }
  process.exitCode = requests === 0 ? EXIT_NO_DATA : EXIT_OK;
}

/** The `usage` command implementation. */
async function runUsage(spec: string | undefined, options: UsageOptions): Promise<void> {
  const dataset = await loadOrExit(options);
  if (dataset === undefined) return;

  let range;
  try {
    range = resolveRange({
      ...(spec === undefined ? {} : { spec }),
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.to === undefined ? {} : { to: options.to }),
      ...(options.today === true ? { preset: 'today' as const } : {}),
      ...(options.month === true ? { preset: 'month' as const } : {}),
      ...(options.year === true ? { preset: 'year' as const } : {}),
    });
  } catch (error) {
    process.stderr.write(`dsh-usage: ${(error as Error).message}\n`);
    process.exitCode = EXIT_ERROR;
    return;
  }

  let dimension: UsageDimension;
  try {
    dimension = resolveDimension(options);
  } catch (error) {
    process.stderr.write(`dsh-usage: ${(error as Error).message}\n`);
    process.exitCode = EXIT_ERROR;
    return;
  }

  const currencyRate = options.currencyRate === undefined ? 1 : Number(options.currencyRate);
  const query: UsageQuery = {
    dimension,
    range,
    currencyRate,
    currency: (options.currency ?? PRICING_CURRENCY).toUpperCase(),
    // Folded by default: a session's number is what the session cost in total.
    // `--subagents` splits it into the session's own usage plus one row per
    // subagent it spawned.
    includeSubagents: options.subagents !== true,
    ...(options.projectFilter === undefined ? {} : { projects: options.projectFilter }),
    ...(options.sessionFilter === undefined ? {} : { sessions: options.sessionFilter }),
  };

  const engine = new PricingEngine();
  const result = runQuery(dataset, query, engine);
  result.warnings.push(...ledgerDriftWarnings(dataset));

  if (query.currency !== PRICING_CURRENCY && options.currencyRate === undefined && !options.json) {
    result.warnings.push(
      `DeepSeek 以人民币计价；--currency ${query.currency} 未同时给出 --currency-rate，金额仍按 1:1 显示`,
    );
  }

  emit(usageToJson(result), formatUsageReport(result, engine), options.json === true, result.requests);
}

/**
 * Compare every session's ledger totals with the harness' own projection cache.
 *
 * The ledger is authoritative for billing, but a divergence means the harness
 * observed usage the ledger does not carry (a crashed write, say), which the
 * user should know about before trusting the number.
 */
function ledgerDriftWarnings(dataset: UsageDataset): string[] {
  const drifts: string[] = [];
  for (const session of dataset.sessions) {
    if (session.projectedTotals === null || session.entries.length === 0) continue;
    const ledger = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const entry of session.entries) {
      ledger.input += entry.tokens.input;
      ledger.output += entry.tokens.output;
      ledger.cacheRead += entry.tokens.cacheRead;
      ledger.cacheWrite += entry.tokens.cacheWrite;
    }
    const projected = session.projectedTotals;
    if (
      ledger.input !== projected.input ||
      ledger.output !== projected.output ||
      ledger.cacheRead !== projected.cacheRead ||
      ledger.cacheWrite !== projected.cacheWrite
    ) {
      drifts.push(
        `会话 ${session.sessionId} 账本与投影缓存不一致：未命中输入 ${ledger.input}/${projected.input}、输出 ${ledger.output}/${projected.output}、缓存命中 ${ledger.cacheRead}/${projected.cacheRead}`,
      );
    }
  }
  return drifts;
}

/** Options accepted by `session list`. */
interface SessionListOptions extends GlobalOptions {
  subagents?: boolean;
  projectFilter?: string[];
  sessionFilter?: string[];
}

/** The `session list` command implementation. */
async function runSessionList(options: SessionListOptions): Promise<void> {
  const dataset = await loadOrExit(options);
  if (dataset === undefined) return;
  const result = listSessions(dataset, {
    includeSubagents: options.subagents === true,
    ...(options.projectFilter === undefined ? {} : { projects: options.projectFilter }),
    ...(options.sessionFilter === undefined ? {} : { sessions: options.sessionFilter }),
  });
  emit(sessionListToJson(result), formatSessionList(result), options.json === true, result.totalSessions);
}

/** Print the price schedule the cost calculation uses. */
function runPrice(): void {
  const engine = new PricingEngine();
  const lines = ['DeepSeek 官方价格表（人民币 / 百万 tokens）'];
  for (const schedule of engine.schedules) {
    lines.push(`\n▸ ${schedule.model}`);
    if (schedule.aliases.length > 1) {
      lines.push(`  别名: ${schedule.aliases.filter((alias) => alias !== schedule.model).join('、')}`);
    }
    for (const period of schedule.periods) {
      lines.push(`  [${period.id}] ${period.label}`);
      lines.push(`    生效: ${engine.describeWindow(period)}`);
      lines.push(`    峰谷: ${engine.describePeakWindows(period)}`);
      const fmt = (card: { inputCacheHit: string; inputCacheMiss: string; output: string }): string =>
        `缓存命中 ${card.inputCacheHit} / 缓存未命中 ${card.inputCacheMiss} / 输出 ${card.output}`;
      lines.push(`    空闲时段: ${fmt(period.offPeak)}`);
      if (period.peak !== null) lines.push(`    高峰时段: ${fmt(period.peak)}`);
      lines.push(`    来源: ${period.source}`);
      lines.push(`    说明: ${period.note}`);
    }
  }
  lines.push(`\n默认价格模型（无对应价格表时使用）: ${DEFAULT_PRICING_MODEL}`);
  lines.push('说明: DeepSeek 不对缓存写入单独计费；推理 tokens 已计入输出，不另行计费。');
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** Build the commander program. */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('dsh-usage')
    .description('统计 DeepSeek Harness (DSH) 的 token 消耗与费用')
    .version('0.1.0')
    .option('--home <dir>', `DSH 主目录（默认 ${(() => {
      try {
        return resolveDshHome();
      } catch {
        return '~/.dsh';
      }
    })()}）`)
    .option('--json', '以 JSON 输出');

  const collect = (value: string, previous: string[] | undefined): string[] => [...(previous ?? []), value];

  program
    .command('usage', { isDefault: true })
    .description('计算 token 消耗与费用')
    .argument('[range]', '时间范围：today/month/year（可加偏移，如 month-1）或 "起始..结束"')
    .option('--all', '只输出全部维度的汇总（默认）')
    .option('--project', '按项目维度汇总')
    .option('--session', '按会话维度汇总（含每个项目下的会话明细）')
    .option('--subagents', '将子代理单独列出（默认并入其父会话）；需配合 --session 查看明细')
    .option('-p, --project-filter <selector>', '只统计指定项目：workspace id、项目名或路径（支持 * 通配；可重复指定）', collect)
    .option('-s, --session-filter <selector>', '只统计指定会话：会话 id 或唯一前缀（支持 * 通配；可重复指定）', collect)
    .option('--today', '时间范围：今天')
    .option('--month', '时间范围：本月')
    .option('--year', '时间范围：今年')
    .option('--from <time>', '起始时间（含），如 2026-09-01 或 2026-09-01T10:30')
    .option('--to <time>', '结束时间（不含），如 2026-09-10（含当天）')
    .option('--currency <code>', `显示货币（默认 ${PRICING_CURRENCY}）`)
    .option('--currency-rate <rate>', '1 CNY 折算为目标货币的汇率（默认 1）', parseRateOption)
    .allowExcessArguments(false)
    .action(async (range: string | undefined, options: UsageOptions, command: Command) => {
      await runUsage(range, withGlobals(command, options));
    });

  const sessionCommand = program.command('session').description('会话相关操作');

  sessionCommand
    .command('list')
    .description('列出所有项目与会话（项目按首个会话时间降序，会话按时间降序）')
    .option('--subagents', '将子代理单独列出（默认并入其父会话）')
    .option('-p, --project-filter <selector>', '只列出指定项目（可重复指定）', collect)
    .option('-s, --session-filter <selector>', '只列出指定会话（可重复指定）', collect)
    .option('--home <dir>', 'DSH 主目录')
    .option('--json', '以 JSON 输出')
    .action(async (options: SessionListOptions, command: Command) => {
      await runSessionList(withGlobals(command, options));
    });

  program
    .command('price')
    .description('显示内置的 DeepSeek 官方价格表与生效区间')
    .action(() => {
      runPrice();
    });

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
      if (code !== 0 && (error as Error).message.length > 0) {
        process.stderr.write(`${(error as Error).message}\n`);
      }
      process.exitCode = code;
      return;
    }
    process.stderr.write(`dsh-usage: ${(error as Error).message}\n`);
    process.exitCode = EXIT_ERROR;
  }
}

await main();
