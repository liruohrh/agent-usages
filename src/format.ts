/**
 * Presentation layer: render reports as a token tree or stable JSON.
 *
 * The renderer is deliberately dumb: everything it prints — the tokens, the
 * money per token figure, the bands with their rate cards, the labels — is
 * resolved by the report and pricing layers and handed over as data. Nothing
 * here reaches back into a pricing engine to explain a number, so a figure can
 * only be wrong once, in the layer that owns it.
 */

import stringWidth from 'string-width';

import { alignMoney, moneyBreakdown, type MoneyBreakdown } from './accounting.ts';
import { tokenBreakdown } from './core/buckets.ts';
import type { CostTotals, TokenTotals } from './core/types.ts';
import type {
  BandSummary,
  ModelBreakdown,
  ProjectReport,
  ScopeTotals,
  SessionListResult,
  SessionReport,
  UsageResult,
} from './report.ts';
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

/**
 * The metric vocabulary, and the billed component each token figure prices.
 *
 * One vocabulary everywhere: the metric line, the band's rate card and the model
 * lines all name a token figure the same way, so `I/C 0.02` is recognisably the
 * price of the `I/C 241.8M` printed above it.
 */
const COMPONENT_METRICS: Readonly<Record<string, string>> = {
  'input-miss': 'I/M',
  'input-hit': 'I/C',
  'input-write': 'I/W',
  output: 'O/T',
};

/** The unit a rate card is quoted in. */
function rateUnit(symbol: string): string {
  return symbol.length === 0 ? '每百万 token' : `${symbol} / 百万 token`;
}

/** A share of a whole, shown beside the figure it describes. */
function ratioSuffix(part: number, whole: number): string {
  // Nothing to compare when the figure is zero, and a bare `0%` beside a zero
  // only adds noise to an already long line.
  if (whole <= 0 || part <= 0) return '';
  return ` / ${((part / whole) * 100).toFixed(1)}%`;
}

/**
 * The metric line every node prints.
 *
 * Every token figure carries the money it produced, so a reader can look at the
 * input alone or the output alone instead of only at the total. The three prompt
 * buckets are billed one by one, so their money is exact; the completion is
 * billed as a whole, so `O` and `R` share it (`O + R = O/T`); and the aggregates
 * are sums of the figures beside them, never a second bill. `T` deliberately
 * carries no money of its own — the total at the end of the line is its money,
 * and printing both would say the same number twice. `I/W` appears only when a
 * provider actually wrote to the cache, since until then it is a column of
 * zeroes.
 */
function metricsLine(tokens: TokenTotals, amounts: MoneyBreakdown, requests: number, symbol: string): string {
  const counts = tokenBreakdown(tokens);
  const items = [`I/M ${compact(counts.inputMiss)} ${money(amounts.inputMiss, symbol)}`];
  if (counts.inputWrite > 0) items.push(`I/W ${compact(counts.inputWrite)} ${money(amounts.inputWrite, symbol)}`);
  items.push(`I/C ${compact(counts.inputHit)}${ratioSuffix(counts.inputHit, counts.inputTotal)} ${money(amounts.inputHit, symbol)}`);
  items.push(`I/T ${compact(counts.inputTotal)} ${money(amounts.inputTotal, symbol)}`);
  items.push(`O ${compact(counts.outputOnly)} ${money(amounts.outputOnly, symbol)}`);
  items.push(`R ${compact(counts.reasoning)}${ratioSuffix(counts.reasoning, counts.outputTotal)} ${money(amounts.reasoning, symbol)}`);
  items.push(`O/T ${compact(counts.outputTotal)} ${money(amounts.outputTotal, symbol)}`);
  items.push(`T ${compact(counts.total)}`);
  items.push(`Q ${count(requests)}`);
  // The headline total is the figure every level above and below agrees on: the
  // breakdown is aligned to it, never the other way round.
  items.push(money(amounts.total, symbol));
  return items.join(' · ');
}

/**
 * Render the pricing bands, one block each: where the rate came from, what it
 * billed, and what the rate card said.
 *
 * A block per band rather than a row per band because a band now carries a whole
 * metric line: the tokens it billed and the money they produced, in the same
 * vocabulary as the tree above. The model is named in the heading because one
 * session can span several models whose bands share a period and a tier — the
 * unit price alone was the only thing telling those rows apart.
 */
function bandBlocks(bands: readonly BandSummary[], symbol: string): string[] {
  if (bands.length === 0) return [];
  const lines = ['计价区间:'];
  for (const band of bands) {
    const note = RESOLUTION_NOTES[band.resolution] ?? '';
    const window = band.window.length === 0 ? '' : `（${band.window}）`;
    // The model names the requests carried, which are the ones the reader saw in
    // the tree above; a price schedule reached through an alias is an internal
    // detail and is only reported in `--json`.
    const named = band.models.length > 0 ? band.models.join('、') : band.model;
    lines.push(`▸ ${band.periodId} ${TIER_LABELS[band.tier] ?? band.tier} · ${named}`);
    lines.push(`  ${band.periodLabel}${window}${note}`);
    lines.push(`  ${metricsLine(band.tokens, moneyBreakdown(band.cost, band.tokens), band.requests, symbol)}`);
    const rates = band.components
      .map((component) => `${COMPONENT_METRICS[component.id] ?? component.label} ${component.rate}`)
      .join(' · ');
    if (rates.length > 0) lines.push(`  P（${rateUnit(symbol)}）: ${rates}`);
  }
  return lines;
}

/**
 * One line per model, for a node that billed under more than one.
 *
 * A node keeps exactly one metric line — the money across models is summed, and
 * it sums honestly because every rate was converted into the report's currency
 * before it was applied. This only says how that one line splits, which is what
 * tells a reader that the blended numbers came from two different price lists.
 */
function modelLines(
  models: readonly ModelBreakdown[],
  level: number,
  symbol: string,
  parentMoney: MoneyBreakdown,
): string[] {
  if (models.length <= 1) return [];
  // The model rows are parts of the node's line above them, so they are aligned
  // to it: a reader adding the rows must land on the number they were split from.
  const rows = alignMoney(
    parentMoney,
    models.map((model) => moneyBreakdown(model.cost, model.tokens)),
  );
  return models.map(
    (model, index) =>
      `${indent(level)}[${model.model}]  ${metricsLine(model.tokens, rows[index]!, model.requests, symbol)}`,
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
  /** Append the pricing bands: what each rate billed, and what it charged. */
  cost?: boolean | undefined;
  /** Expand every node that billed under more than one model. */
  models?: boolean | undefined;
  /** Pricing provider's display name, for the header. */
  pricingLabel?: string | undefined;
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

/** Width of the 总 / 自身 / 子代理 labels, in display cells. */
const SCOPE_LABEL_WIDTH = 6;

/** The 总 / 自身 / 子代理 lines of one node. */
function scopeLines(
  node: { own: ScopeTotals; spawned: ScopeTotals; total: ScopeTotals },
  level: number,
  symbol: string,
): string[] {
  const at = indent(level);
  const total = moneyBreakdown(node.total.cost, node.total.tokens);
  const [own, spawned] = alignMoney(total, [
    moneyBreakdown(node.own.cost, node.own.tokens),
    moneyBreakdown(node.spawned.cost, node.spawned.tokens),
  ]) as [MoneyBreakdown, MoneyBreakdown];
  const line = (name: string, totals: ScopeTotals, amounts: MoneyBreakdown): string =>
    `${at}${pad(name, SCOPE_LABEL_WIDTH)}  ${metricsLine(totals.tokens, amounts, totals.requests, symbol)}`;
  return [line('总', node.total, total), line('自身', node.own, own), line('子代理', node.spawned, spawned)];
}

/** One session and, recursively, everything it spawned. */
function sessionLines(
  session: SessionReport,
  childrenOf: ReadonlyMap<string, readonly SessionReport[]>,
  level: number,
  symbol: string,
  options: FormatOptions,
  parentDate: string | undefined,
  parentMoney: MoneyBreakdown | undefined,
): string[] {
  const children = childrenOf.get(session.id) ?? [];
  const badge = session.subagentCount > 0 ? `（${count(session.subagentCount)} 个子代理）` : '';
  const end = nodeDate(session.lastUsage, 'end');
  // The date is only worth repeating when it differs from the row above.
  const suffix = end === undefined || end === parentDate ? '' : ` ${end}`;
  const lines = [`${indent(level)}${clip(session.title ?? '(无标题)', TITLE_WIDTH)}${badge}${suffix}`];
  // This row is a part of the nearest line above it, so it is aligned to that
  // line's amount rather than rounded on its own.
  const own = moneyBreakdown(session.total.cost, session.total.tokens);
  const total = parentMoney === undefined ? own : alignMoney(parentMoney, [own])[0]!;
  // The split is worth printing only when there is something to split off; a
  // session with no subagents says everything in one line.
  const split = session.spawned.requests > 0 || children.length > 0;
  if (options.scope === true && split) {
    lines.push(...scopeLines(session, level + 1, symbol));
    if (options.models === true) lines.push(...modelLines(session.models, level + 1, symbol, total));
    if (options.expandSubagents === true) {
      const spawned = alignMoney(moneyBreakdown(session.total.cost, session.total.tokens), [
        moneyBreakdown(session.spawned.cost, session.spawned.tokens),
      ])[0]!;
      for (const child of children) lines.push(...sessionLines(child, childrenOf, level + 2, symbol, options, end, spawned));
    }
    return lines;
  }
  lines.push(`${indent(level + 1)}${metricsLine(session.total.tokens, total, session.total.requests, symbol)}`);
  if (options.models === true) lines.push(...modelLines(session.models, level + 1, symbol, total));
  if (options.expandSubagents === true) {
    for (const child of children) {
      lines.push(...sessionLines(child, childrenOf, level + 1, symbol, options, end, total));
    }
  }
  return lines;
}

/** One project's block: its name, its metrics, and its sessions. */
function projectLines(
  project: ProjectReport,
  symbol: string,
  options: FormatOptions,
  parentMoney: MoneyBreakdown | undefined,
): string[] {
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
  // A project whose whole tree is one session repeats that session's numbers, so
  // its own line is dropped — and then the sessions below are aligned straight to
  // the line above the project instead.
  const own = moneyBreakdown(project.total.cost, project.total.tokens);
  const shown = parentMoney === undefined || rows.length === 1 ? own : alignMoney(parentMoney, [own])[0]!;
  const split = project.spawned.requests > 0 || rows.some((row) => row.isSubagent);
  if (rows.length !== 1) {
    lines.push(
      options.scope === true && split
        ? [...scopeLines(project, 1, symbol)].join('\n')
        : `${indent(1)}${metricsLine(project.total.tokens, shown, project.total.requests, symbol)}`,
    );
    if (options.models === true) lines.push(...modelLines(project.models, 1, symbol, shown));
  }
  // Session rows are parts of whichever project line was printed, or of the
  // nearest line above it when this project collapsed.
  const rowMoney = alignMoney(
    rows.length === 1 ? (parentMoney ?? own) : shown,
    rows.map((row) => moneyBreakdown(row.total.cost, row.total.tokens)),
  );
  const byRow = new Map(rows.map((row, index) => [row.id, rowMoney[index]!]));
  for (const root of roots) {
    lines.push(...sessionLines(root, childrenOf, 1, symbol, options, projectStart, byRow.get(root.id)));
  }
  return lines;
}

/** Render one window: its heading, the root total, and the project tree. */
function renderSection(section: ReportSection, symbol: string, options: FormatOptions): string[] {
  const { result } = section;
  const span =
    result.firstUsage === null || result.lastUsage === null ? undefined : spanText(result.firstUsage, result.lastUsage);
  const lines = [span === undefined ? section.label : `${section.label} · ${span}`];
  // A project that billed nothing in range has no rows to show.
  const active = result.projects.filter((project) => (project.sessionReports ?? []).length > 0);
  // One project already prints exactly the report's own numbers, so the root
  // block would only repeat them.
  const rootMoney = moneyBreakdown(result.cost, result.tokens);
  if (active.length !== 1) {
    lines.push(
      options.scope === true && result.scopeBreakdown !== undefined
        ? [...scopeLines({ own: result.scopeBreakdown.own, spawned: result.scopeBreakdown.subagents, total: result.scopeBreakdown.total }, 1, symbol)].join('\n')
        : `${indent(1)}${metricsLine(result.tokens, rootMoney, result.requests, symbol)}`,
    );
    if (options.models === true) lines.push(...modelLines(result.models, 1, symbol, rootMoney));
  }
  // A single project prints exactly the root's numbers, so the projects are
  // aligned to the root line when it is shown and stand alone when it is not.
  const projectMoney = active.length === 1 ? [] : alignMoney(
    rootMoney,
    active.map((project) => moneyBreakdown(project.total.cost, project.total.tokens)),
  );
  for (const [index, project] of active.entries()) {
    lines.push('', ...projectLines(project, symbol, options, active.length === 1 ? rootMoney : projectMoney[index]));
  }
  if (options.cost === true) {
    const bands = bandBlocks(result.bands, symbol);
    if (bands.length > 0) lines.push('', ...bands);
  }
  if (result.warnings.length > 0) {
    lines.push('', '提示:', ...result.warnings.map((warning) => `  - ${warning}`));
  }
  return lines;
}

/**
 * Render a usage report for the terminal.
 * @param sections - one window, or several when the caller asked for them together.
 * @param symbol - currency symbol to print.
 * @param options - what to include beyond the default tree.
 * @returns the text to print.
 */
export function formatUsageReport(
  sections: readonly ReportSection[],
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
    `计价来源  ${options.pricingLabel ?? first.result.pricingProvider}（${first.result.currency}${first.result.currencyRate === 1 ? '' : `，1:${first.result.currencyRate}`}）`,
  ].join('\n');
  const blocks = [header];
  for (const section of sections) blocks.push(renderSection(section, symbol, options).join('\n'));
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
 * @returns a plain object with ISO timestamps beside every epoch value.
 */
function resultToJson(result: UsageResult): Record<string, unknown> {
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
    // The bands carry the whole rate card — rate, tokens charged, money — so a
    // separate component list would be the same data projected twice.
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
 * @returns the single window's object, or one object per window under `sections`.
 */
export function usageToJson(sections: readonly ReportSection[]): unknown {
  const [first] = sections;
  if (first === undefined) return {};
  if (sections.length === 1) return resultToJson(first.result);
  return {
    agent: first.result.agent,
    source: first.result.source,
    pricingProvider: first.result.pricingProvider,
    currency: first.result.currency,
    currencyRate: first.result.currencyRate,
    subagentMode: first.result.subagentMode,
    sections: sections.map((section) => ({ label: section.label, ...resultToJson(section.result) })),
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
