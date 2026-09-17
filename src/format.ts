/**
 * Presentation layer: render {@link UsageResult} and {@link SessionListResult}
 * as either aligned terminal tables or stable JSON.
 *
 * Table layout accounts for East-Asian wide characters so Chinese titles do not
 * shear the columns.
 */

import type { SessionListResult, UsageResult, ModelBreakdown } from './report.ts';
import { formatInstant, PricingEngine } from './pricing.ts';
import type { PricingPeriod } from './pricing-data.ts';
import { formatDecimal, toNumber } from './money.ts';
import type { CostTotals, TokenTotals } from './types.ts';

/** Currency symbols for the codes this CLI is likely to see. */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  CNY: '¥',
  RMB: '¥',
  USD: '$',
  EUR: '€',
  JPY: '¥',
  GBP: '£',
  HKD: 'HK$',
};

/**
 * Render an amount with its currency symbol and thousands separators.
 *
 * The caller passes the exact decimal string the accounting layer produced, so
 * the rendered figure matches the JSON figure digit for digit.
 */
function money(amount: string, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
  const [whole = '0', fraction = ''] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decimals = fraction.padEnd(2, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${symbol}${grouped}.${decimals}`;
}

/** Render an integer with thousands separators. */
function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** Compact a large token count for dense columns. */
function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`;
  return `${(value / 1_000_000_000).toFixed(2)}B`;
}

/** Display width of a string, counting East-Asian wide characters as two cells. */
function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

/** Whether a code point occupies two terminal cells. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** Pad a string to a display width, accounting for wide characters. */
function pad(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const current = displayWidth(text);
  const fill = Math.max(0, width - current);
  return align === 'left' ? text + ' '.repeat(fill) : ' '.repeat(fill) + text;
}

/** Truncate to a display width, appending an ellipsis when cut. */
function clip(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let result = '';
  let used = 0;
  for (const character of text) {
    const size = displayWidth(character);
    if (used + size > width - 1) break;
    result += character;
    used += size;
  }
  return `${result}…`;
}

/** Render a column-aligned table. */
function table(headers: readonly string[], rows: readonly (readonly string[])[], aligns: readonly ('left' | 'right')[]): string {
  const widths = headers.map((header, index) => {
    let width = displayWidth(header);
    for (const row of rows) {
      const cell = row[index] ?? '';
      width = Math.max(width, displayWidth(cell));
    }
    return width;
  });
  const renderRow = (row: readonly string[]): string =>
    row
      .map((cell, index) => pad(clip(cell, Math.max(widths[index] ?? 0, 3)), widths[index] ?? 0, aligns[index] ?? 'left'))
      .join('  ')
      .trimEnd();
  const separator = widths.map((width) => '─'.repeat(width)).join('  ');
  return [renderRow(headers), separator, ...rows.map(renderRow)].join('\n');
}

/** Invert `formatInstant` for the day boundary; used for `YYYY-MM-DD` labels. */
function dayLabel(instant: number | null, timeZone?: string): string {
  if (instant === null || !Number.isFinite(instant)) return '—';
  if (timeZone === undefined) {
    const date = new Date(instant);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  return formatInstant(instant, timeZone).slice(0, 10);
}

/** Render the token/cost summary block shared by every report. */
function summaryLines(
  requests: number,
  tokens: TokenTotals,
  cost: CostTotals,
  currency: string,
  rate: number,
  indent = '',
): string[] {
  const billedInput = cost.cacheMissInputTokens;
  const lines = [
    `${indent}请求数        ${count(requests)}`,
    `${indent}输入(缓存未命中) ${count(tokens.input)}${tokens.cacheWrite > 0 ? `  (另有缓存写入 ${count(tokens.cacheWrite)})` : ''}`,
    `${indent}输入(缓存命中)   ${count(tokens.cacheRead)}`,
    `${indent}输出          ${count(tokens.output)}${tokens.reasoning > 0 ? `  (含推理 ${count(tokens.reasoning)})` : ''}`,
    `${indent}计费输入合计    ${count(billedInput)}`,
    `${indent}Token 总计     ${count(tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite)}`,
    `${indent}费用          ${money(cost.total, currency)}` +
      (rate === 1 ? '' : `  (按 1 CNY = ${rate} ${currency} 折算)`),
  ];
  return lines;
}

/** Render a per-model breakdown table. */
function modelTable(models: readonly ModelBreakdown[], currency: string): string {
  const rows = models.map((model) => [
    model.model,
    count(model.requests),
    compact(model.tokens.input),
    compact(model.tokens.cacheRead),
    compact(model.tokens.output),
    money(model.cost.total, currency),
  ]);
  return table(
    ['模型', '请求', '未命中输入', '缓存命中', '输出', '费用'],
    rows,
    ['left', 'right', 'right', 'right', 'right', 'right'],
  );
}

/**
 * Render the pricing-period breakdown.
 *
 * A band summary carries only a period id, so the period is located across
 * every schedule — a project billed on `deepseek-v4-pro` must show its own
 * validity window rather than the Flash one.
 */
function bandLines(bands: UsageResult['bands'], engine: PricingEngine): string[] {
  if (bands.length === 0) return [];
  const byId = new Map<string, PricingPeriod>();
  for (const schedule of engine.schedules) {
    for (const period of schedule.periods) {
      if (!byId.has(period.id)) byId.set(period.id, period);
    }
  }
  const lines = ['计价区间:'];
  for (const band of bands) {
    const period = byId.get(band.periodId);
    const window = period === undefined ? '' : `（${engine.describeWindow(period)}）`;
    const note = RESOLUTION_NOTES[band.resolution] ?? '';
    lines.push(`  - ${band.periodLabel} / ${bandName(band.band)}：${count(band.requests)} 次请求${window}${note}`);
  }
  return lines;
}

/** Chinese label for a band. */
function bandName(band: string): string {
  if (band === 'peak') return '高峰时段';
  if (band === 'off-peak') return '空闲时段';
  return '统一价格';
}

/** Explanation shown when a period had to be chosen by fallback. */
const RESOLUTION_NOTES: Readonly<Record<string, string>> = {
  exact: '',
  'fallback-later': ' ← 该时间早于本区间，按其后第一个区间的价格计算',
  'fallback-earlier': ' ← 该时间晚于本区间，按最后一个已知区间的价格计算',
  'fallback-default': ' ← 该模型无价格表，按默认模型价格计算',
};

/**
 * Render a usage result for the terminal.
 * @param result - the aggregated result.
 * @param engine - pricing engine used for period descriptions.
 * @returns the text to print.
 */
export function formatUsageReport(result: UsageResult, engine: PricingEngine): string {
  const sections: string[] = [];
  sections.push(
    [
      'DSH Token 用量统计',
      `维度      ${DIMENSION_LABELS[result.dimension]}`,
      `时间范围  ${result.range.label}`,
      `计价货币  ${result.currency}${result.currencyRate === 1 ? '' : `（1 CNY = ${result.currencyRate} ${result.currency}）`}`,
    ].join('\n'),
  );

  const scopeLines: string[] = [];
  if (result.subagents !== undefined) {
    if (result.subagents.split) {
      scopeLines.push(
        `会话口径  不含子代理（${count(result.subagents.rows)} 个子代理会话单独列出，父会话为其自身用量）`,
      );
    } else {
      scopeLines.push(
        result.subagents.rows > 0
          ? `会话口径  含子代理（${count(result.subagents.rows)} 个子代理会话已并入其父会话，另计 ${money(result.subagents.cost.total, result.currency)}）`
          : '会话口径  含子代理',
      );
    }
  }
  sections.push(
    ['总量:', ...scopeLines, ...summaryLines(result.requests, result.tokens, result.cost, result.currency, result.currencyRate)].join('\n'),
  );

  const bands = bandLines(result.bands, engine);
  if (bands.length > 0) sections.push(bands.join('\n'));

  if (result.models.length > 0) {
    sections.push(['模型明细:', modelTable(result.models, result.currency)].join('\n'));
  }

  if (result.dimension === 'project' || result.dimension === 'session') {
    const rows = result.projects.map((project) => [
      project.name,
      project.path,
      count(project.activeSessions),
      project.subagentSessions > 0 ? count(project.subagentSessions) : '—',
      count(project.requests),
      compact(project.tokens.input),
      compact(project.tokens.cacheRead),
      compact(project.tokens.output),
      money(project.cost.total, result.currency),
    ]);
    sections.push(
      [
        '按项目:',
        table(
          ['项目', '路径', '会话', '子代理', '请求', '未命中输入', '缓存命中', '输出', '费用'],
          rows,
          ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
        ),
      ].join('\n'),
    );
  }

  if (result.dimension === 'session') {
    const rows: string[][] = [];
    for (const project of result.projects) {
      for (const session of project.sessionReports ?? []) {
        const isSub = session.isSubagent;
        rows.push([
          // Subagent rows are prefixed so the tree is readable in a flat table.
          `${isSub ? '  ↳ ' : ''}${project.name}`,
          `${isSub ? '  ' : ''}${session.title ?? '(无标题)'}`,
          session.sessionId,
          isSub ? '—' : session.subagentCount > 0 ? count(session.subagentCount) : '—',
          count(session.requests),
          compact(session.tokens.input),
          compact(session.tokens.cacheRead),
          compact(session.tokens.output),
          money(session.cost.total, result.currency),
        ]);
      }
    }
    if (rows.length > 0) {
      sections.push(
        [
          '按会话（↳ 为子代理）:',
          table(
            ['项目', '标题', '会话 ID', '子代理', '请求', '未命中输入', '缓存命中', '输出', '费用'],
            rows,
            ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
          ),
        ].join('\n'),
      );
    }
  }

  if (result.warnings.length > 0) {
    sections.push(['提示:', ...result.warnings.map((warning) => `  - ${warning}`)].join('\n'));
  }
  return `${sections.join('\n\n')}\n`;
}

const DIMENSION_LABELS: Readonly<Record<string, string>> = {
  all: '全部',
  project: '按项目',
  session: '按会话',
};

/**
 * Render the session inventory for the terminal.
 * @param result - the inventory.
 * @returns the text to print.
 */
export function formatSessionList(result: SessionListResult): string {
  const sections: string[] = [];
  sections.push(['DSH 会话列表', `项目数 ${count(result.projects.length)}　会话数 ${count(result.totalSessions)}`].join('\n'));
  for (const project of result.projects) {
    sections.push(
      [
        `▸ ${project.name}  ${project.path}`,
        `  会话 ${count(project.sessions.length)}　最近 ${dayLabel(project.lastUsage)}　最早 ${dayLabel(project.firstUsage)}`,
      ].join('\n'),
    );
    const rows = project.sessions.map((session) => [
      `${session.nested ? '  ↳ ' : ''}${session.sessionId}`,
      `${session.nested ? '  ' : ''}${session.title ?? '(无标题)'}`,
      dayLabel(session.firstUsage),
      dayLabel(session.lastUsage),
      session.subagentCount > 0 && !session.isSubagent ? count(session.subagentCount) : '—',
      count(session.requests),
      compact(session.tokens.input + session.tokens.cacheRead + session.tokens.cacheWrite),
      compact(session.tokens.output),
    ]);
    sections.push(
      table(
        ['会话 ID', '标题', '首次', '最近', '子代理', '请求', '输入', '输出'],
        rows,
        ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right'],
      ),
    );
  }
  if (result.warnings.length > 0) {
    sections.push(['提示:', ...result.warnings.map((warning) => `  - ${warning}`)].join('\n'));
  }
  return `${sections.join('\n\n')}\n`;
}

/**
 * Serialise a usage result as JSON-ready data.
 * @param result - the aggregated result.
 * @returns a plain object with ISO timestamps added alongside epoch numbers.
 */
export function usageToJson(result: UsageResult): unknown {
  const iso = (instant: number | null): string | null => (instant === null || !Number.isFinite(instant) ? null : new Date(instant).toISOString());
  return {
    dimension: result.dimension,
    range: {
      label: result.range.label,
      from: result.range.from,
      to: result.range.to,
      fromIso: iso(result.range.from),
      toIso: iso(result.range.to),
    },
    currency: result.currency,
    currencyRate: result.currencyRate,
    subagents: result.subagents,
    totals: {
      requests: result.requests,
      tokens: result.tokens,
      cost: result.cost,
    },
    pricingBands: result.bands,
    models: result.models,
    projects: result.projects.map((project) => ({
      workspaceId: project.workspaceId,
      name: project.name,
      path: project.path,
      sessions: project.sessions,
      activeSessions: project.activeSessions,
      subagentSessions: project.subagentSessions,
      requests: project.requests,
      firstUsage: project.firstUsage,
      firstUsageIso: iso(project.firstUsage),
      lastUsage: project.lastUsage,
      lastUsageIso: iso(project.lastUsage),
      tokens: project.tokens,
      cost: project.cost,
      pricingBands: project.bands,
      models: project.models,
      ...(project.sessionReports === undefined
        ? {}
        : {
            sessionReports: project.sessionReports.map((session) => ({
              sessionId: session.sessionId,
              title: session.title,
              projectName: session.projectName,
              workspaceId: session.workspaceId,
              cwd: session.cwd,
              createdAt: session.createdAt,
              createdAtIso: iso(session.createdAt),
              firstUsage: session.firstUsage,
              firstUsageIso: iso(session.firstUsage),
              lastUsage: session.lastUsage,
              lastUsageIso: iso(session.lastUsage),
              isSubagent: session.isSubagent,
              subagentCount: session.subagentCount,
              parentSessionId: session.parentSessionId,
              requests: session.requests,
              tokens: session.tokens,
              cost: session.cost,
              pricingBands: session.bands,
              models: session.models,
              ...(session.warning === undefined ? {} : { warning: session.warning }),
            })),
          }),
    })),
    warnings: result.warnings,
  };
}

/**
 * Serialise the session inventory as JSON-ready data.
 * @param result - the inventory.
 * @returns a plain object with ISO timestamps added alongside epoch numbers.
 */
export function sessionListToJson(result: SessionListResult): unknown {
  const iso = (instant: number | null): string | null => (instant === null || !Number.isFinite(instant) ? null : new Date(instant).toISOString());
  return {
    totalProjects: result.projects.length,
    totalSessions: result.totalSessions,
    projects: result.projects.map((project) => ({
      workspaceId: project.workspaceId,
      name: project.name,
      path: project.path,
      firstUsage: project.firstUsage,
      firstUsageIso: iso(project.firstUsage),
      lastUsage: project.lastUsage,
      lastUsageIso: iso(project.lastUsage),
      sessions: project.sessions.map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        workspaceId: session.workspaceId,
        projectName: session.projectName,
        cwd: session.cwd,
        createdAt: session.createdAt,
        createdAtIso: iso(session.createdAt),
        firstUsage: session.firstUsage,
        firstUsageIso: iso(session.firstUsage),
        lastUsage: session.lastUsage,
        lastUsageIso: iso(session.lastUsage),
        requests: session.requests,
        tokens: session.tokens,
        isSubagent: session.isSubagent,
        delegationDepth: session.delegationDepth,
        parentSessionId: session.parentSessionId,
        subagentCount: session.subagentCount,
        subagentRequests: session.subagentRequests,
        nested: session.nested,
      })),
    })),
    warnings: result.warnings,
  };
}
