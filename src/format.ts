/**
 * Presentation layer: render reports as aligned terminal tables or stable JSON.
 *
 * Table layout accounts for East-Asian wide characters so Chinese titles do not
 * shear the columns. Cost rows are generated from the pricing provider's own
 * component list, so a vendor that bills something unusual still gets a labelled
 * line instead of an empty cell.
 */

import stringWidth from 'string-width';

import { tokenBreakdown, totalTokens } from './core/buckets.ts';
import type { CostTotals, TokenTotals } from './core/types.ts';
import type { PricingEngine, RateComponent } from './pricing/index.ts';
import type { SessionListResult, UsageResult } from './report.ts';

/**
 * Display width of a string, in terminal cells.
 *
 * Delegated to `string-width`, which implements the Unicode east-asian-width
 * table plus emoji and ANSI handling. A hand-rolled `codePoint > 0x2e80` test is
 * right for CJK and full-width punctuation but wrong for half-width katakana,
 * ZWJ emoji sequences, regional-indicator flags, variation selectors, and
 * combining marks — each of which would shear a column.
 */
function displayWidth(text: string): number {
  return stringWidth(text);
}

/** Grapheme segmentation, so clipping never splits an emoji or combining mark. */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The grapheme clusters of a string, in order. */
function graphemes(text: string): string[] {
  const parts: string[] = [];
  // `Intl.Segmenter.segment` yields the clusters; older inputs without it fall
  // back to code points, which is still better than code units.
  for (const segment of segmenter.segment(text)) parts.push(segment.segment);
  return parts;
}

/** Pad a string to a display width. */
function pad(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const fill = Math.max(0, width - displayWidth(text));
  return align === 'left' ? text + ' '.repeat(fill) : ' '.repeat(fill) + text;
}

/** Truncate to a display width, appending an ellipsis when cut. */
function clip(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  // Reserve one cell for the ellipsis, and cut on a grapheme boundary so an
  // emoji or a combining mark is never left half-written.
  let result = '';
  let used = 0;
  for (const grapheme of graphemes(text)) {
    const size = displayWidth(grapheme);
    if (used + size > width - 1) break;
    result += grapheme;
    used += size;
  }
  return `${result}…`;
}

/**
 * Width of the label column every `key  value` block pads to.
 *
 * Wide enough for the longest label this tool prints, so the values line up in
 * one column down the whole report.
 */
const LABEL_WIDTH = 18;

/**
 * Width the title column is clipped to.
 *
 * Titles are free-form and can be arbitrarily long, while the token columns
 * behind them are fixed. Clipping keeps a long title from pushing the numbers
 * off the screen.
 */
const TITLE_WIDTH = 32;

/**
 * Pad a label to the shared column.
 *
 * Measured in terminal cells, not characters: the labels mix ASCII and
 * full-width parentheses, and a full-width one is a single character occupying
 * two cells — so `padEnd` would leave exactly those rows short.
 */
function label(text: string): string {
  return pad(text, LABEL_WIDTH);
}

/** One `label  value` line of an aligned block. */
function labeled(text: string, value: string): string {
  return `${label(text)}  ${value}`;
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
  // Padded to the full column width, with no trailing trim: a right-aligned last
  // column (an amount) would otherwise leave the header one cell shorter than the
  // rows beneath it, which shows up as a ragged right edge.
  const renderRow = (row: readonly string[]): string =>
    row
      .map((cell, index) => pad(clip(cell, Math.max(widths[index] ?? 0, 3)), widths[index] ?? 0, aligns[index] ?? 'left'))
      .join('  ');
  const separator = widths.map((width) => '─'.repeat(width)).join('  ').trimEnd();
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
  // Trailing zeros carry no information, so drop them — one at a time, and never
  // below two decimals, so `8.8410` reads as `8.841` rather than as `8.84`
  // (which would look like a different rounding).
  let end = fraction.length;
  while (end > 2 && fraction[end - 1] === '0') end -= 1;
  return `${symbol}${grouped}.${fraction.slice(0, Math.max(end, 2))}`;
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
 * Render the cost decomposition per pricing component.
 *
 * The columns are deliberately not the token totals, and the block has no token
 * total: a component's token count answers "how many tokens were charged for
 * this item", which for some providers is a slice of a bucket and for others
 * spans two (`inputAndCacheWrite`). Adding those counts up would double-count
 * tokens, so only the money — which does add up — is totalled.
 *
 * Unit prices are not shown here either: a component billed across two tiers has
 * no single price, so the rate card lives in the band table.
 */
function costLines(
  cost: CostTotals,
  components: Map<string, { component: RateComponent; tokens: number }>,
  symbol: string,
  currency: string,
  currencyRate: number,
): string[] {
  const rows: string[][] = [];
  const seen = new Set<string>();
  for (const [id, info] of components) {
    const amount = amountForComponent(id, cost);
    if (amount === undefined) continue;
    seen.add(id);
    rows.push([basisLabelText(info.component), count(info.tokens), money(amount, symbol)]);
  }
  for (const [id, amount] of componentAmounts(cost)) {
    if (seen.has(id)) continue;
    rows.push([id, '—', money(amount, symbol)]);
  }
  const lines = [
    table(
      ['计费项', '计费 token', '金额'],
      rows,
      ['left', 'right', 'right'],
      ['费用合计', '', money(cost.total, symbol)],
    ),
  ];
  if (currencyRate !== 1) lines.push(`(按 1:${currencyRate} 折算为 ${currency}，原始计价货币见 price)`);
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

/**
 * Render the pricing bands as a table, one row per (period, tier).
 *
 * This is where unit prices belong. A report-wide "unit price" would be a
 * fiction whenever usage spans two tiers — cache hits charged partly at the
 * off-peak rate and partly at the peak rate have no single price — so the rate
 * card is shown per band, beside the amount that band actually produced.
 */
function bandTable(result: UsageResult, engine: PricingEngine, symbol: string): string[] {
  if (result.bands.length === 0) return [];
  const windows = new Map<string, string>();
  for (const price of engine.provider.models()) {
    for (const period of price.periods) {
      if (!windows.has(period.id)) windows.set(period.id, engine.describeWindow(period));
    }
  }
  const rows = result.bands.map((band) => {
    const rates = Object.entries(band.rates)
      .map(([id, rate]) => `${componentShortLabel(id)} ${rate}`)
      .join(' / ');
    return [
      band.periodId,
      TIER_LABELS[band.tier] ?? band.tier,
      count(band.requests),
      compact(band.inputTokens ?? 0),
      rates.length > 0 ? `${rates} 元/M` : '—',
      money(band.total, symbol),
    ];
  });
  const lines = [
    '计价区间:',
    table(
      ['区间', '时段', '请求', '输入', '单价', '金额'],
      rows,
      ['left', 'left', 'right', 'right', 'left', 'right'],
    ),
  ];
  // One footnote per period, not per band: a period usually contributes both an
  // off-peak and a peak row, and repeating its window twice reads as a bug.
  const footnotes = new Map<string, { label: string; note: string; window?: string }>();
  for (const band of result.bands) {
    const note = RESOLUTION_NOTES[band.resolution] ?? '';
    const window = windows.get(band.periodId);
    if (note === '' && window === undefined) continue;
    const existing = footnotes.get(band.periodId);
    // A period has one provenance; a fallback note is preferred over silence.
    if (existing !== undefined && (existing.note !== '' || note === '')) continue;
    footnotes.set(band.periodId, { label: band.periodLabel, note, ...(window === undefined ? {} : { window }) });
  }
  // The footnotes explain the period ids used above, so they sit left-aligned
  // under the table, separated by a blank line. They must not be indented: an
  // indented period id reads as a table row that drifted right, and there is no
  // column it could belong to.
  if (footnotes.size > 0) lines.push('');
  for (const [periodId, footnote] of footnotes) {
    const where = footnote.window === undefined ? '' : `（${footnote.window}）`;
    lines.push(`${periodId}${where}：${footnote.label}${footnote.note}`);
  }
  return lines;
}

/** A short, stable name for a pricing component id, for dense tables. */
function componentShortLabel(id: string): string {
  switch (id) {
    case 'input-hit':
      return '命中';
    case 'input-miss':
      return '未命中';
    case 'output':
      return '输出';
    case 'input-write':
      return '写入';
    default:
      return id;
  }
}

/**
 * The token figures every table reports, in one order.
 *
 * Each table used to pick its own three columns, which made the tables
 * incomparable: the `总量` block reports seven figures, so a reader could not
 * check a project's input total or its reasoning against it. Every table now
 * carries the same set.
 */
const TOKEN_HEADERS = ['未命中输入', '缓存命中', '输入合计', '输出(思考)', '输出(非思考)', '输出合计', 'Token 总计'] as const;

/** Token figures in {@link TOKEN_HEADERS} order, comma-compacted for table width. */
function tokenCells(tokens: TokenTotals): string[] {
  const parts = tokenBreakdown(tokens);
  return [
    compact(parts.inputMiss),
    compact(parts.inputHit),
    compact(parts.inputTotal),
    compact(parts.reasoning),
    compact(parts.outputOnly),
    compact(parts.outputTotal),
    compact(parts.total),
  ];
}

/** Right-alignment spec for a table that ends in the shared token columns. */
function tokenAligns(leading: number, trailing: number): ('left' | 'right')[] {
  return [
    ...Array.from({ length: leading }, (): 'left' => 'left'),
    ...TOKEN_HEADERS.map((): 'right' => 'right'),
    ...Array.from({ length: trailing }, (): 'right' => 'right'),
  ];
}

/** Render a per-model table. */
function modelTable(result: UsageResult, symbol: string): string {
  return table(
    ['模型', '请求', ...TOKEN_HEADERS, '费用'],
    result.models.map((model) => [
      model.model,
      count(model.requests),
      ...tokenCells(model.tokens),
      money(model.cost.total, symbol),
    ]),
    tokenAligns(1, 1),
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
          ['范围', '会话', '请求', ...TOKEN_HEADERS, '费用', '占比'],
          [
            ['主会话自身', count(own.sessions), count(own.requests), ...tokenCells(own.tokens), money(own.cost.total, symbol), share(own.cost.total, total.cost.total)],
            ['全部子代理', count(subagents.sessions), count(subagents.requests), ...tokenCells(subagents.tokens), money(subagents.cost.total, symbol), share(subagents.cost.total, total.cost.total)],
            ['总计', count(total.sessions), count(total.requests), ...tokenCells(total.tokens), money(total.cost.total, symbol), '100%'],
          ],
          tokenAligns(1, 2),
        ),
      ].join('\n'),
    );
  }

  sections.push(
    [
      '费用明细（单价见计价区间）:',
      ...costLines(result.cost, result.components, symbol, result.currency, result.currencyRate),
    ].join('\n'),
  );

  const bands = bandTable(result, engine, symbol);
  if (bands.length > 0) sections.push(bands.join('\n'));

  if (result.models.length > 0) sections.push(['模型明细:', modelTable(result, symbol)].join('\n'));

  if (result.dimension === 'project' || result.dimension === 'session') {
    sections.push(
      [
        '按项目:',
        table(
          ['项目', '会话', '子代理', '请求', ...TOKEN_HEADERS, '费用'],
          result.projects.map((project) => [
            project.name,
            count(project.activeSessions),
            project.subagentSessions > 0 ? count(project.subagentSessions) : '—',
            count(project.requests),
            ...tokenCells(project.tokens),
            money(project.cost.total, symbol),
          ]),
          tokenAligns(1, 1),
          [
            '合计',
            count(result.projects.reduce((total, project) => total + project.activeSessions, 0)),
            result.subagents.sessions > 0 ? count(result.subagents.sessions) : '—',
            count(result.requests),
            ...tokenCells(result.tokens),
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
          `${sub ? '  ' : ''}${clip(session.title ?? '(无标题)', TITLE_WIDTH)}`,
          sub ? '—' : session.subagentCount > 0 ? count(session.subagentCount) : '—',
          count(session.requests),
          ...tokenCells(session.tokens),
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
        count(result.requests),
        ...tokenCells(result.tokens),
        money(result.cost.total, symbol),
      ];
      sections.push(
        [
          '按会话（↳ 为子代理；会话 ID 见 --json 或 session list）:',
          table(['项目', '标题', '子代理', '请求', ...TOKEN_HEADERS, '费用'], rows, tokenAligns(2, 1), totals),
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
      labeled('Agent', agentLabel === undefined ? result.agent : `${result.agent}（${agentLabel}）`),
      labeled('数据目录', result.source),
      labeled('项目数', count(result.projects.length)),
      labeled('会话数', count(result.totalSessions)),
    ].join('\n'),
  );
  for (const project of result.projects) {
    sections.push(
      [
        `▸ ${project.name}  ${project.path}`,
        `  ${project.sessionCount === project.sessions.length ? `会话 ${count(project.sessions.length)}` : `会话 ${count(project.sessionCount)}（显示 ${count(project.sessions.length)} 行，子代理已并入父会话）`}　最近 ${dayLabel(project.lastUsage)}　最早 ${dayLabel(project.firstUsage)}`,
      ].join('\n'),
    );
    // A directory listing, not a cost report: token figures live in `usage`,
    // where they come with their own columns. Keeping them here as well only
    // made this table too wide to read.
    sections.push(
      table(
        ['会话 ID', '标题', '首次', '最近', '子代理', '请求'],
        project.sessions.map((session) => [
          `${session.nested ? '  ↳ ' : ''}${session.id}`,
          `${session.nested ? '  ' : ''}${session.title ?? '(无标题)'}`,
          dayLabel(session.firstUsage),
          dayLabel(session.lastUsage),
          session.subagentCount > 0 && !session.isSubagent ? count(session.subagentCount) : '—',
          count(session.requests),
        ]),
        ['left', 'left', 'left', 'left', 'right', 'right'],
        // A folded row already contains its subagents, so summing the rows would
        // count them twice; the total therefore comes from the sessions in scope.
        [
          '合计',
          '',
          dayLabel(project.firstUsage),
          dayLabel(project.lastUsage),
          '',
          count(project.sessions.reduce((total, session) => total + session.requests, 0)),
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
