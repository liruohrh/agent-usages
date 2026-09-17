/**
 * Presentation layer: render reports as aligned terminal tables or stable JSON.
 *
 * Table layout accounts for East-Asian wide characters so Chinese titles do not
 * shear the columns. Cost rows are generated from the pricing provider's own
 * component list, so a vendor that bills something unusual still gets a labelled
 * line instead of an empty cell.
 */

import { tokenBreakdown, totalTokens } from './core/buckets.ts';
import type { CostTotals, TokenTotals } from './core/types.ts';
import type { PricingEngine, RateComponent } from './pricing/index.ts';
import type { SessionListResult, UsageResult } from './report.ts';

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

/** Pad a string to a display width. */
function pad(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const fill = Math.max(0, width - displayWidth(text));
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
function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  aligns: readonly ('left' | 'right')[],
  totals?: readonly string[] | undefined,
): string {
  const widths = headers.map((header, index) => {
    let width = displayWidth(header);
    for (const row of rows) width = Math.max(width, displayWidth(row[index] ?? ''));
    // A totals row can be wider than every row above it (a summed number is the
    // largest of its column), so it participates in sizing.
    if (totals !== undefined) width = Math.max(width, displayWidth(totals[index] ?? ''));
    return width;
  });
  const renderRow = (row: readonly string[]): string =>
    row.map((cell, index) => pad(clip(cell, Math.max(widths[index] ?? 0, 3)), widths[index] ?? 0, aligns[index] ?? 'left')).join('  ').trimEnd();
  const separator = widths.map((width) => '─'.repeat(width)).join('  ');
  const lines = [renderRow(headers), separator, ...rows.map(renderRow)];
  // A total over a single row says nothing the row does not, so it is shown
  // only when it actually adds up several rows.
  if (totals !== undefined && rows.length > 1) lines.push(separator, renderRow(totals));
  return lines.join('\n');
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

/**
 * A scope's share of a total, as a rounded percentage.
 *
 * Computed from the exact decimal strings rather than from floats, so a share of
 * a very small total does not come out as `NaN` or a negative zero.
 */
function share(part: string, whole: string): string {
  const numerator = Number(part);
  const denominator = Number(whole);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return '—';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/** Render an exact decimal amount with a currency symbol. */
function money(amount: string, symbol: string): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${symbol}${grouped}.${fraction.padEnd(2, '0').replace(/0+$/, '').padEnd(2, '0')}`;
}

/** `YYYY-MM-DD` in local time, for dense columns. */
function dayLabel(instant: number | null): string {
  if (instant === null || !Number.isFinite(instant)) return '—';
  const date = new Date(instant);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** ISO timestamp, or `null`. */
function iso(instant: number | null): string | null {
  return instant === null || !Number.isFinite(instant) ? null : new Date(instant).toISOString();
}

const TIER_LABELS: Readonly<Record<string, string>> = {
  peak: '高峰时段',
  'off-peak': '空闲时段',
  flat: '统一价格',
};

/** Explanation shown when a period had to be chosen by fallback. */
const RESOLUTION_NOTES: Readonly<Record<string, string>> = {
  exact: '',
  'fallback-later': ' ← 该时间早于本区间，按其后第一个区间的价格计算',
  'fallback-earlier': ' ← 该时间晚于本区间，按最后一个已知区间的价格计算',
  'fallback-default': ' ← 该模型无价格表，按默认模型价格计算',
};

/** How a provider's billing basis reads in a breakdown. */
function basisLabel(engine: PricingEngine, component: RateComponent): string {
  return component.label.length > 0 ? component.label : engine.describeBasis(component.basis);
}

/** Render the token totals block. */
function tokenLines(requests: number, tokens: TokenTotals): string[] {
  const parts = tokenBreakdown(tokens);
  const lines = [
    `请求数              ${count(requests)}`,
    `输入(缓存未命中)    ${count(parts.inputMiss)}`,
    `输入(缓存命中)      ${count(parts.inputHit)}`,
  ];
  if (parts.inputWrite > 0) lines.push(`输入(缓存写入)      ${count(parts.inputWrite)}`);
  lines.push(`输入合计            ${count(parts.inputTotal)}`);
  // Reasoning is reported inside the completion count, so it is shown as a part
  // of the output rather than beside it; `输出合计` is that completion count.
  lines.push(`输出(思考)          ${count(parts.reasoning)}`);
  lines.push(`输出(非思考)        ${count(parts.outputOnly)}`);
  lines.push(`输出合计            ${count(parts.outputTotal)}`);
  lines.push(`Token 总计          ${count(parts.total)}`);
  return lines;
}

/**
 * Render one line per pricing component.
 *
 * The component list is the provider's, not this tool's, so a vendor that bills
 * a bucket nobody else does still gets a labelled line.
 */
function costLines(
  cost: CostTotals,
  components: Map<string, { component: RateComponent; tokens: number }>,
  symbol: string,
  currency: string,
  currencyRate: number,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const [id, info] of components) {
    const amount = amountForComponent(id, cost);
    if (amount === undefined) continue;
    seen.add(id);
    lines.push(`  ${clip(basisLabelText(info.component), 18).padEnd(18)} ${count(info.tokens)} tokens → ${money(amount, symbol)}`);
  }
  for (const [id, amount] of componentAmounts(cost)) {
    if (seen.has(id)) continue;
    lines.push(`  ${clip(id, 18).padEnd(18)} → ${money(amount, symbol)}`);
  }
  lines.push(
    `  ${'费用合计'.padEnd(18)} ${money(cost.total, symbol)}${currencyRate === 1 ? '' : `　(按 1:${currencyRate} 折算为 ${currency}，原始计价货币见 price)`}`,
  );
  return lines;
}

/** Component label without engine access, for the fallback path. */
function basisLabelText(component: RateComponent): string {
  return component.label.length > 0 ? component.label : component.id;
}

/** The amount for a known component id. */
function amountForComponent(id: string, cost: CostTotals): string | undefined {
  switch (id) {
    case 'input-hit':
      return cost.cacheHitInputCost;
    case 'input-miss':
      return cost.cacheMissInputCost;
    case 'output':
      return cost.outputCost;
    case 'input-write':
      return cost.cacheWriteInputCost;
    default:
      return undefined;
  }
}

/** Every component amount a cost total carries. */
function componentAmounts(cost: CostTotals): [string, string][] {
  return [
    ['input-hit', cost.cacheHitInputCost],
    ['input-miss', cost.cacheMissInputCost],
    ['output', cost.outputCost],
    ...(cost.cacheWriteInputCost === '0.0000' ? [] : ([['input-write', cost.cacheWriteInputCost]] as [string, string][])),
  ];
}

/** Render the pricing-band breakdown. */
function bandLines(result: UsageResult, engine: PricingEngine): string[] {
  if (result.bands.length === 0) return [];
  const byId = new Map<string, { window: string }>();
  for (const price of engine.provider.models()) {
    for (const period of price.periods) {
      if (!byId.has(period.id)) byId.set(period.id, { window: engine.describeWindow(period) });
    }
  }
  const lines = ['计价区间:'];
  for (const band of result.bands) {
    const window = byId.get(band.periodId);
    const where = window === undefined ? '' : `（${window.window}）`;
    lines.push(
      `  - ${band.periodLabel} / ${TIER_LABELS[band.tier] ?? band.tier}：${count(band.requests)} 次请求${where}${RESOLUTION_NOTES[band.resolution] ?? ''}`,
    );
  }
  return lines;
}

/** Render a per-model table. */
function modelTable(result: UsageResult, symbol: string): string {
  return table(
    ['模型', '请求', '未命中输入', '缓存命中', '输出', '费用'],
    result.models.map((model) => [
      model.model,
      count(model.requests),
      compact(model.tokens.input),
      compact(model.tokens.cacheRead),
      compact(model.tokens.output),
      money(model.cost.total, symbol),
    ]),
    ['left', 'right', 'right', 'right', 'right', 'right'],
  );
}

/**
 * Render a usage result for the terminal.
 * @param result - the aggregated result.
 * @param engine - pricing engine, for period descriptions and component labels.
 * @param symbol - currency symbol to print.
 * @returns the text to print.
 */
export function formatUsageReport(
  result: UsageResult,
  engine: PricingEngine,
  symbol: string,
  agentLabel?: string,
): string {
  const sections: string[] = [];
  sections.push(
    [
      'Agent 用量统计',
      `Agent     ${agentLabel === undefined ? result.agent : `${result.agent}（${agentLabel}）`}`,
      `数据目录  ${result.source}`,
      `维度      ${DIMENSION_LABELS[result.dimension] ?? result.dimension}`,
      `时间范围  ${result.range.label}`,
      `计价来源  ${engine.provider.label}（${result.currency}${result.currencyRate === 1 ? '' : `，1:${result.currencyRate}`}）`,
    ].join('\n'),
  );

  const scope: string[] = [];
  if (result.subagentMode === 'detail') {
    scope.push(`会话口径  每个子代理单独一行（${count(result.subagents.sessions)} 个子代理会话；父会话行为其自身用量）`);
  } else if (result.subagents.sessions > 0) {
    scope.push(
      `会话口径  含子代理（${count(result.subagents.sessions)} 个子代理会话已并入其父会话，由 ${count(result.subagents.parents)} 个会话派生）`,
    );
  } else {
    scope.push('会话口径  含子代理');
  }
  sections.push(['总量:', ...scope, ...tokenLines(result.requests, result.tokens)].join('\n'));

  // The three scopes answer the question the single total cannot: how much of it
  // came from subagents at all.
  if (result.scopeBreakdown !== undefined) {
    const { own, subagents, total } = result.scopeBreakdown;
    sections.push(
      [
        '按范围:',
        table(
          ['范围', '会话', '请求', '输入合计', '输出合计', '费用', '占比'],
          [
            ['主会话自身', count(own.sessions), count(own.requests), compact(tokenBreakdown(own.tokens).inputTotal), compact(tokenBreakdown(own.tokens).outputTotal), money(own.cost.total, symbol), share(own.cost.total, total.cost.total)],
            ['全部子代理', count(subagents.sessions), count(subagents.requests), compact(tokenBreakdown(subagents.tokens).inputTotal), compact(tokenBreakdown(subagents.tokens).outputTotal), money(subagents.cost.total, symbol), share(subagents.cost.total, total.cost.total)],
            ['总计', count(total.sessions), count(total.requests), compact(tokenBreakdown(total.tokens).inputTotal), compact(tokenBreakdown(total.tokens).outputTotal), money(total.cost.total, symbol), '100%'],
          ],
          ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
        ),
      ].join('\n'),
    );
  }

  sections.push(
    ['费用明细:', ...costLines(result.cost, result.components, symbol, result.currency, result.currencyRate)].join('\n'),
  );

  const bands = bandLines(result, engine);
  if (bands.length > 0) sections.push(bands.join('\n'));

  if (result.models.length > 0) sections.push(['模型明细:', modelTable(result, symbol)].join('\n'));

  if (result.dimension === 'project' || result.dimension === 'session') {
    sections.push(
      [
        '按项目:',
        table(
          ['项目', '路径', '会话', '子代理', '请求', '未命中输入', '缓存命中', '输出', '费用'],
          result.projects.map((project) => [
            project.name,
            project.path,
            count(project.activeSessions),
            project.subagentSessions > 0 ? count(project.subagentSessions) : '—',
            count(project.requests),
            compact(project.tokens.input),
            compact(project.tokens.cacheRead),
            compact(project.tokens.output),
            money(project.cost.total, symbol),
          ]),
          ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
          // The total is the report's own grand total, so this row is also the
          // check that the rows above add up to it.
          [
            '合计',
            '',
            count(result.projects.reduce((total, project) => total + project.activeSessions, 0)),
            result.subagents.sessions > 0 ? count(result.subagents.sessions) : '—',
            count(result.requests),
            compact(result.tokens.input),
            compact(result.tokens.cacheRead),
            compact(result.tokens.output),
            money(result.cost.total, symbol),
          ],
        ),
      ].join('\n'),
    );
  }

  if (result.dimension === 'session') {
    const rows: string[][] = [];
    for (const project of result.projects) {
      for (const session of project.sessionReports ?? []) {
        const sub = session.isSubagent;
        rows.push([
          `${sub ? '  ↳ ' : ''}${project.name}`,
          `${sub ? '  ' : ''}${session.title ?? '(无标题)'}`,
          session.id,
          sub ? '—' : session.subagentCount > 0 ? count(session.subagentCount) : '—',
          count(session.requests),
          compact(session.tokens.input),
          compact(session.tokens.cacheRead),
          compact(session.tokens.output),
          money(session.cost.total, symbol),
        ]);
      }
    }
    if (rows.length > 0) {
      // Totals come from the report rather than from the rendered rows: the rows
      // are rounded for display and may fold subagents into a parent, so summing
      // them would under-report the true total.
      const totals: string[] = [
        '合计',
        '',
        '',
        '',
        count(result.requests),
        compact(result.tokens.input),
        compact(result.tokens.cacheRead),
        compact(result.tokens.output),
        money(result.cost.total, symbol),
      ];
      sections.push(
        [
          '按会话（↳ 为子代理）:',
          table(
            ['项目', '标题', '会话 ID', '子代理', '请求', '未命中输入', '缓存命中', '输出', '费用'],
            rows,
            ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
            totals,
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
export function formatSessionList(result: SessionListResult, agentLabel?: string): string {
  const sections: string[] = [];
  sections.push(
    [
      'Agent 会话列表',
      `Agent     ${agentLabel === undefined ? result.agent : `${result.agent}（${agentLabel}）`}`,
      `数据目录  ${result.source}`,
      `项目数 ${count(result.projects.length)}　会话数 ${count(result.totalSessions)}`,
    ].join('\n'),
  );
  for (const project of result.projects) {
    sections.push(
      [
        `▸ ${project.name}  ${project.path}`,
        `  ${project.sessionCount === project.sessions.length ? `会话 ${count(project.sessions.length)}` : `会话 ${count(project.sessionCount)}（显示 ${count(project.sessions.length)} 行，子代理已并入父会话）`}　最近 ${dayLabel(project.lastUsage)}　最早 ${dayLabel(project.firstUsage)}`,
      ].join('\n'),
    );
    sections.push(
      table(
        ['会话 ID', '标题', '首次', '最近', '子代理', '请求', '输入', '输出'],
        project.sessions.map((session) => [
          `${session.nested ? '  ↳ ' : ''}${session.id}`,
          `${session.nested ? '  ' : ''}${session.title ?? '(无标题)'}`,
          dayLabel(session.firstUsage),
          dayLabel(session.lastUsage),
          session.subagentCount > 0 && !session.isSubagent ? count(session.subagentCount) : '—',
          count(session.requests),
          compact(totalTokens(session.tokens) - session.tokens.output),
          compact(session.tokens.output),
        ]),
        ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right'],
        // A folded row already contains its subagents, so summing the rows would
        // count them twice; the total therefore comes from the sessions in scope.
        [
          '合计',
          '',
          dayLabel(project.firstUsage),
          dayLabel(project.lastUsage),
          '',
          count(project.sessions.reduce((total, session) => total + session.requests, 0)),
          compact(project.sessions.reduce((total, session) => total + totalTokens(session.tokens) - session.tokens.output, 0)),
          compact(project.sessions.reduce((total, session) => total + session.tokens.output, 0)),
        ],
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
 * @param engine - pricing engine, for component labels.
 * @returns a plain object with ISO timestamps beside every epoch value.
 */
export function usageToJson(result: UsageResult, engine: PricingEngine): unknown {
  return {
    agent: result.agent,
    source: result.source,
    pricingProvider: result.pricingProvider,
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
    subagentMode: result.subagentMode,
    subagents: {
      sessions: result.subagents.sessions,
      parents: result.subagents.parents,
    },
    ...(result.scopeBreakdown === undefined
      ? {}
      : {
          scopeBreakdown: {
            own: scopeToJson(result.scopeBreakdown.own),
            subagents: scopeToJson(result.scopeBreakdown.subagents),
            total: scopeToJson(result.scopeBreakdown.total),
          },
        }),
    totals: {
      requests: result.requests,
      unpriced: result.unpriced,
      tokens: result.tokens,
      // The reader-facing roll-up: the four raw buckets are disjoint, so the
      // totals are sums of them and are easy to get wrong by hand.
      tokenBreakdown: tokenBreakdown(result.tokens),
      cost: result.cost,
    },
    costComponents: [...result.components].map(([id, info]) => ({
      id,
      label: basisLabel(engine, info.component),
      basis: info.component.basis,
      rate: info.component.rate,
      per: info.component.per,
      tokens: info.tokens,
      amount: amountForComponent(id, result.cost) ?? result.cost.total,
    })),
    pricingBands: result.bands,
    models: result.models,
    projects: result.projects.map((project) => ({
      id: project.id,
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
              id: session.id,
              title: session.title,
              projectId: session.projectId,
              projectName: session.projectName,
              cwd: session.cwd,
              createdAt: session.createdAt,
              createdAtIso: iso(session.createdAt),
              firstUsage: session.firstUsage,
              firstUsageIso: iso(session.firstUsage),
              lastUsage: session.lastUsage,
              lastUsageIso: iso(session.lastUsage),
              isSubagent: session.isSubagent,
              subagentCount: session.subagentCount,
              parentId: session.parentId,
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

/** One scope row as JSON, with the token roll-up included. */
function scopeToJson(scope: import('./report.ts').ScopeTotals): Record<string, unknown> {
  return {
    sessions: scope.sessions,
    requests: scope.requests,
    tokens: scope.tokens,
    tokenBreakdown: tokenBreakdown(scope.tokens),
    cost: scope.cost,
  };
}

/**
 * Serialise the session inventory as JSON-ready data.
 * @param result - the inventory.
 * @returns a plain object with ISO timestamps beside every epoch value.
 */
export function sessionListToJson(result: SessionListResult): unknown {
  return {
    agent: result.agent,
    source: result.source,
    totalProjects: result.projects.length,
    totalSessions: result.totalSessions,
    projects: result.projects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      sessionCount: project.sessionCount,
      listRows: project.sessions.length,
      firstUsage: project.firstUsage,
      firstUsageIso: iso(project.firstUsage),
      lastUsage: project.lastUsage,
      lastUsageIso: iso(project.lastUsage),
      sessions: project.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        projectId: session.projectId,
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
        depth: session.depth,
        parentId: session.parentId,
        subagentCount: session.subagentCount,
        subagentRequests: session.subagentRequests,
        nested: session.nested,
      })),
    })),
    warnings: result.warnings,
  };
}
