/**
 * Presentation layer: render reports as aligned terminal tables or stable JSON.
 *
 * Table layout accounts for East-Asian wide characters so Chinese titles do not
 * shear the columns. Cost rows are generated from the pricing provider's own
 * component list, so a vendor that bills something unusual still gets a labelled
 * line instead of an empty cell.
 */

import stringWidth from 'string-width';

import { tokenBreakdown } from './core/buckets.ts';
import type { CostTotals, TokenTotals } from './core/types.ts';
import type { PricingEngine, RateComponent } from './pricing/index.ts';
import type { ProjectReport, ScopeTotals, SessionListResult, SessionReport, UsageResult } from './report.ts';
import type { TimeRange } from './timerange.ts';

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
      ['计费项', '计费 token', symbol],
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
      ['区间', '时段', '请求', 'I/T', '单价', symbol],
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
 * The token figures every table reports, in one order and one vocabulary.
 *
 * Each table used to pick its own three columns, which made the tables
 * incomparable: the `总量` block reports seven figures, so a reader could not
 * check a project's input total or its reasoning against it. Every table now
 * carries the same set — abbreviated, because seven spelled-out headers push a
 * table past the terminal width:
 *
 * `I` 未命中输入 · `I/C` 缓存命中 · `I/T` 输入合计 ·
 * `O` 输出(非思考) · `R` 输出(思考) · `O/T` 输出合计 · `T` Token 总计
 */
const TOKEN_HEADERS = ['I', 'I/C', 'I/T', 'O', 'R', 'O/T', 'T'] as const;

/** Token figures in {@link TOKEN_HEADERS} order, comma-compacted for table width. */
function tokenCells(tokens: TokenTotals): string[] {
  const parts = tokenBreakdown(tokens);
  return [
    compact(parts.inputMiss),
    compact(parts.inputHit),
    compact(parts.inputTotal),
    compact(parts.outputOnly),
    compact(parts.reasoning),
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
    ['M', '请求', ...TOKEN_HEADERS, symbol],
    result.models.map((model) => [
      model.model,
      count(model.requests),
      ...tokenCells(model.tokens),
      money(model.cost.total, symbol),
    ]),
    tokenAligns(1, 1),
  );
}

/** One time window of a report: its heading, its range, and its data. */
export interface ReportSection {
  /** Heading shown for the window (`总`, `今日`, `本周`, …). */
  label: string;
  /** The range this section covers. */
  range: TimeRange;
  /** The aggregate for that range. */
  result: UsageResult;
}

/** What the terminal renderer prints beyond the default tree. */
export interface FormatOptions {
  /** Agent display name, shown beside its id. */
  agentLabel?: string | undefined;
  /** Print each node's 总 / 自身 / 子代理 split. */
  scope?: boolean | undefined;
  /** List every subagent under its session's 子代理 line. */
  expandSubagents?: boolean | undefined;
  /** Append the per-component cost table and the pricing bands. */
  cost?: boolean | undefined;
  /** Append the per-model table. */
  models?: boolean | undefined;
}

/** Two-digit zero pad. */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD` in the machine's local zone. */
function dayText(instant: number): string {
  const date = new Date(instant);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * The effective span of a window, terse.
 *
 * The span is derived from the billed requests, not from the nominal bounds, so
 * a half-open `to` never shows up as the next day. Only a span inside one day
 * carries hours: `2026-07-01 8h~23h`, or `2026-07-01 8h ~` when the whole span
 * sits inside a single hour.
 */
function spanText(from: number, to: number): string {
  const start = new Date(from);
  const end = new Date(to);
  const sameDay =
    start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth() && start.getDate() === end.getDate();
  if (sameDay) {
    const first = start.getHours();
    const last = end.getHours();
    return first === last ? `${dayText(from)} ${first}h ~` : `${dayText(from)} ${first}h~${last}h`;
  }
  const sameMonth = start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth();
  return sameMonth ? `${dayText(from)} ~ ${pad2(end.getDate())}` : `${dayText(from)} ~ ${dayText(to)}`;
}

/** The date a node labels itself with, or `undefined` when it has none. */
function nodeDate(instant: number | null, kind: 'start' | 'end'): string | undefined {
  const at = kind === 'start' ? instant : instant;
  return at === null ? undefined : dayText(at);
}

/** Indentation of one tree level. */
function indent(level: number): string {
  return '  '.repeat(level);
}

/**
 * The metric line every node prints.
 *
 * Terse by design — `I/C` is cache-read input, `R` reasoning, `Q` requests — so
 * the seven token figures, the request count, and the money fit one line without
 * a table's fixed columns and their width limit.
 */
function metricsLine(tokens: TokenTotals, requests: number, cost: string, symbol: string): string {
  const parts = tokenBreakdown(tokens);
  return [
    `I ${compact(parts.inputMiss)}`,
    `I/C ${compact(parts.inputHit)}`,
    `I/T ${compact(parts.inputTotal)}`,
    `O ${compact(parts.outputOnly)}`,
    `R ${compact(parts.reasoning)}`,
    `O/T ${compact(parts.outputTotal)}`,
    `T ${compact(parts.total)}`,
    `Q ${count(requests)}`,
    money(cost, symbol),
  ].join(' · ');
}

/** Width of the 总 / 自身 / 子代理 labels, in display cells. */
const SCOPE_LABEL_WIDTH = 6;

/** The 总 / 自身 / 子代理 lines of one node. */
function scopeLines(
  node: { own: ScopeTotals; spawned: ScopeTotals; total: ScopeTotals },
  level: number,
  symbol: string,
): string[] {
  const at = indent(level);
  const line = (name: string, totals: ScopeTotals): string =>
    `${at}${pad(name, SCOPE_LABEL_WIDTH)}  ${metricsLine(totals.tokens, totals.requests, totals.cost.total, symbol)}`;
  return [line('总', node.total), line('自身', node.own), line('子代理', node.spawned)];
}

/** One session and, recursively, everything it spawned. */
function sessionLines(
  session: SessionReport,
  childrenOf: ReadonlyMap<string, readonly SessionReport[]>,
  level: number,
  symbol: string,
  options: FormatOptions,
  parentDate: string | undefined,
): string[] {
  const children = childrenOf.get(session.id) ?? [];
  const badge = session.subagentCount > 0 ? `（${count(session.subagentCount)} 个子代理）` : '';
  const end = nodeDate(session.lastUsage, 'end');
  // The date is only worth repeating when it differs from the row above.
  const suffix = end === undefined || end === parentDate ? '' : ` ${end}`;
  const lines = [`${indent(level)}${clip(session.title ?? '(无标题)', TITLE_WIDTH)}${badge}${suffix}`];
  const metric = (totals: ScopeTotals): string =>
    `${indent(level + 1)}${metricsLine(totals.tokens, totals.requests, totals.cost.total, symbol)}`;
  // The split is worth printing only when there is something to split off; a
  // session with no subagents says everything in one line.
  const split = session.spawned.requests > 0 || children.length > 0;
  if (options.scope === true && split) {
    lines.push(...scopeLines(session, level + 1, symbol));
    if (options.expandSubagents === true) {
      for (const child of children) lines.push(...sessionLines(child, childrenOf, level + 2, symbol, options, end));
    }
    return lines;
  }
  lines.push(metric(session.total));
  if (options.expandSubagents === true) {
    for (const child of children) lines.push(...sessionLines(child, childrenOf, level + 1, symbol, options, end));
  }
  return lines;
}

/** One project's block: its name, its metrics, and its sessions. */
function projectLines(project: ProjectReport, symbol: string, options: FormatOptions): string[] {
  const rows = project.sessionReports ?? [];
  const known = new Set(rows.map((row) => row.id));
  const roots = rows.filter((row) => row.parentId === null || !known.has(row.parentId));
  const childrenOf = new Map<string, SessionReport[]>();
  for (const row of rows) {
    if (row.parentId === null) continue;
    const bucket = childrenOf.get(row.parentId);
    if (bucket === undefined) childrenOf.set(row.parentId, [row]);
    else bucket.push(row);
  }
  const projectStart = project.firstUsage === null ? undefined : dayText(project.firstUsage);
  const lines = [projectStart === undefined ? project.name : `${project.name} ${projectStart}`];
  // A project whose whole tree is one session repeats that session's numbers,
  // so its own line is dropped; a session whose only children it already lists
  // collapses the same way.
  const split = project.spawned.requests > 0 || rows.some((row) => row.isSubagent);
  if (rows.length !== 1) {
    lines.push(
      options.scope === true && split
        ? [...scopeLines(project, 1, symbol)].join('\n')
        : `${indent(1)}${metricsLine(project.total.tokens, project.total.requests, project.total.cost.total, symbol)}`,
    );
  }
  for (const root of roots) lines.push(...sessionLines(root, childrenOf, 1, symbol, options, projectStart));
  return lines;
}

/** Render one window: its heading, the root total, and the project tree. */
function renderSection(section: ReportSection, engine: PricingEngine, symbol: string, options: FormatOptions): string[] {
  const { result } = section;
  const span =
    result.firstUsage === null || result.lastUsage === null ? undefined : spanText(result.firstUsage, result.lastUsage);
  const lines = [span === undefined ? section.label : `${section.label} · ${span}`];
  // A project that billed nothing in range has no rows to show.
  const active = result.projects.filter((project) => (project.sessionReports ?? []).length > 0);
  // One project already prints exactly the report's own numbers, so the root
  // block would only repeat them.
  if (active.length !== 1) {
    lines.push(
      options.scope === true && result.scopeBreakdown !== undefined
        ? [...scopeLines({ own: result.scopeBreakdown.own, spawned: result.scopeBreakdown.subagents, total: result.scopeBreakdown.total }, 1, symbol)].join('\n')
        : `${indent(1)}${metricsLine(result.tokens, result.requests, result.cost.total, symbol)}`,
    );
  }
  for (const project of active) {
    lines.push('', ...projectLines(project, symbol, options));
  }
  if (options.cost === true) {
    lines.push('', '费用明细（单价见计价区间）:', ...costLines(result.cost, result.components, symbol, result.currency, result.currencyRate));
    const bands = bandTable(result, engine, symbol);
    if (bands.length > 0) lines.push('', ...bands);
  }
  if (options.models === true && result.models.length > 0) {
    lines.push('', '模型明细:', modelTable(result, symbol));
  }
  if (result.warnings.length > 0) {
    lines.push('', '提示:', ...result.warnings.map((warning) => `  - ${warning}`));
  }
  return lines;
}

/**
 * Render a usage report for the terminal.
 * @param sections - one window, or several when the caller asked for them together.
 * @param engine - pricing engine, for period descriptions and component labels.
 * @param symbol - currency symbol to print.
 * @param options - what to include beyond the default tree.
 * @returns the text to print.
 */
export function formatUsageReport(
  sections: readonly ReportSection[],
  engine: PricingEngine,
  symbol: string,
  options: FormatOptions = {},
): string {
  const [first] = sections;
  if (first === undefined) return '';
  const header = [
    'Agent 用量统计',
    `Agent     ${options.agentLabel === undefined ? first.result.agent : `${first.result.agent}（${options.agentLabel}）`}`,
    `数据目录  ${first.result.source}`,
    sections.length === 1
      ? `时间范围  ${first.range.label}`
      : `时间窗口  ${sections.map((section) => section.label).join(' / ')}`,
    `计价来源  ${engine.provider.label}（${first.result.currency}${first.result.currencyRate === 1 ? '' : `，1:${first.result.currencyRate}`}）`,
  ].join('\n');
  const blocks = [header];
  for (const section of sections) blocks.push(renderSection(section, engine, symbol, options).join('\n'));
  return `${blocks.join('\n\n')}\n`;
}

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
function resultToJson(result: UsageResult, engine: PricingEngine): Record<string, unknown> {
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
      own: scopeToJson(project.own),
      spawned: scopeToJson(project.spawned),
      nodeTotal: scopeToJson(project.total),
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
              own: scopeToJson(session.own),
              spawned: scopeToJson(session.spawned),
              nodeTotal: scopeToJson(session.total),
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
 * Serialise one report window as JSON-ready data.
 * @param sections - the windows that were rendered.
 * @param engine - pricing engine, for component labels.
 * @returns the single window's object, or one object per window under `sections`.
 */
export function usageToJson(sections: readonly ReportSection[], engine: PricingEngine): unknown {
  const [first] = sections;
  if (first === undefined) return {};
  if (sections.length === 1) return resultToJson(first.result, engine);
  return {
    agent: first.result.agent,
    source: first.result.source,
    pricingProvider: first.result.pricingProvider,
    currency: first.result.currency,
    currencyRate: first.result.currencyRate,
    subagentMode: first.result.subagentMode,
    sections: sections.map((section) => ({ label: section.label, ...resultToJson(section.result, engine) })),
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
