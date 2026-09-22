/**
 * HTML layer: render an already-computed report as one self-contained document.
 *
 * The same division of labour as the text renderer: every figure — the money,
 * the bands, the model rows, the labels — was resolved by the report and pricing
 * layers, and this file only lays it out. Nothing here prices anything, so the
 * two renderers cannot disagree about what a number means.
 *
 * The document is deliberately one file with no dependencies: the stylesheet is
 * inlined, the only graphic is a `<rect>`-only SVG, and no script is emitted at
 * all. It opens from a filesystem, survives being mailed, and needs no network.
 */

import { tokenBreakdown, type TokenBreakdown } from './core/buckets.ts';
import type { TokenTotals } from './core/types.ts';
import {
  bandTitle,
  bandWindow,
  compact,
  count,
  dayLabel,
  money,
  provenanceOf,
  spanText,
  type ReportSection,
} from './format.ts';
import { language, t } from './i18n/index.ts';
import type { Warning } from './i18n/errors.ts';
import { displayRate } from './pricing/index.ts';
import type { BandSummary, ModelBreakdown, ProjectReport, ScopeTotals, SessionReport, UsageResult } from './report.ts';

/** What the HTML renderer prints beyond the default report. */
export interface HtmlOptions {
  /** Agent display name, shown beside its id. */
  agentLabel?: string | undefined;
  /** Pricing provider's display name, for the provenance line. */
  pricingLabel?: string | undefined;
  /** Currency symbol to print; empty when the caller named no currency. */
  symbol?: string | undefined;
  /** Print each node's 总 / 自身 / 子代理 split. */
  scope?: boolean | undefined;
}

/**
 * The five disjoint billed buckets, in the order every table shows them.
 *
 * The same identifiers the text report prints: they are the metric vocabulary,
 * not prose, so both languages and both renderers spell them identically.
 */
const BUCKETS: readonly string[] = ['I/M', 'I/C', 'I/W', 'O', 'R'];

/** The five bucket values, in the same order as {@link BUCKETS}. */
function bucketValues(counts: TokenBreakdown): number[] {
  return [counts.inputMiss, counts.inputHit, counts.inputWrite, counts.outputOnly, counts.reasoning];
}

/**
 * Escape a string for an HTML text node or a quoted attribute value.
 *
 * Every piece of data in a report is user data — a session title may contain
 * `<`, `&`, an emoji, or a fragment of markup — so nothing reaches the document
 * without passing through here.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The five disjoint bucket cells of one token row. */
function bucketCells(tokens: TokenTotals): string {
  return bucketValues(tokenBreakdown(tokens))
    .map((value) => `<td class="num">${escapeHtml(compact(value))}</td>`)
    .join('');
}

/** The columns every token table closes with: `T`, requests and money. */
function sumCells(tokens: TokenTotals, requests: number, amount: string, symbol: string): string {
  return [compact(tokenBreakdown(tokens).total), count(requests), money(amount, symbol)]
    .map((value) => `<td class="num">${escapeHtml(value)}</td>`)
    .join('');
}

/**
 * The `<thead>` row every token table shares.
 * @param first - heading of the leading name column.
 * @param trailing - extra `<th>` cells after `金额`, already escaped.
 */
function tokenHead(first: string, trailing: readonly string[] = []): string {
  const labels = t();
  const head = [
    `<th>${escapeHtml(first)}</th>`,
    ...BUCKETS.map((label) => `<th class="num">${escapeHtml(label)}</th>`),
    '<th class="num">T</th>',
    `<th class="num">${escapeHtml(labels.list.requests)}</th>`,
    `<th class="num">${escapeHtml(labels.html.amount)}</th>`,
    ...trailing,
  ].join('');
  return `<thead><tr>${head}</tr></thead>`;
}

/** The two date headings a session table carries after its figures. */
function dateHead(): string[] {
  const labels = t();
  return [labels.list.firstUsage, labels.list.lastUsage].map((label) => `<th class="date">${escapeHtml(label)}</th>`);
}

/** A token table, scrollable so a narrow window never shears the columns. */
function tokenTable(first: string, rows: string, trailing: readonly string[] = []): string {
  return `<div class="scroll"><table>${tokenHead(first, trailing)}<tbody>${rows}</tbody></table></div>`;
}

/** One node's headline figures: the five buckets, their total, requests, money. */
function stats(tokens: TokenTotals, requests: number, amount: string, symbol: string): string {
  const labels = t();
  const counts = tokenBreakdown(tokens);
  const values = bucketValues(counts);
  const items: readonly (readonly [string, string])[] = [
    ...BUCKETS.map((label, index) => [label, compact(values[index] ?? 0)] as const),
    ['T', compact(counts.total)],
    [labels.list.requests, count(requests)],
    [labels.html.amount, money(amount, symbol)],
  ];
  const cells = items
    .map(
      ([label, value]) =>
        `<div class="stat"><span class="stat-label">${escapeHtml(label)}</span><span class="stat-value">${escapeHtml(value)}</span></div>`,
    )
    .join('');
  return `<div class="stats">${cells}</div>`;
}

/**
 * A node's per-model rows, folded.
 *
 * A node that billed under one model says nothing the rows above it do not, so
 * the table appears only when there is something to split — the same rule the
 * text report follows.
 */
function modelTable(models: readonly ModelBreakdown[], symbol: string): string {
  if (models.length <= 1) return '';
  const rows = models
    .map(
      (model) =>
        `<tr><td>${escapeHtml(model.model)}</td>${bucketCells(model.tokens)}${sumCells(
          model.tokens,
          model.requests,
          model.cost.total,
          symbol,
        )}</tr>`,
    )
    .join('');
  const summary = `<summary>${escapeHtml(t().html.models)}</summary>`;
  return `<details class="fold">${summary}${tokenTable(t().html.model, rows)}</details>`;
}

/** A horizontal bar per project, normalized to the largest total. */
function projectChart(projects: readonly ProjectReport[]): string {
  if (projects.length === 0) return '';
  const totals = projects.map((project) => tokenBreakdown(project.total.tokens).total);
  const max = totals.reduce((largest, value) => Math.max(largest, value), 0);
  const rows = projects
    .map((project, index) => {
      const value = totals[index] ?? 0;
      // A project that billed anything keeps a visible bar: a width rounded to
      // zero would read as "nothing billed", which is a different statement.
      const width = max <= 0 ? 0 : Math.max(value > 0 ? 1 : 0, (value / max) * 100);
      const label = `${project.name}: ${compact(value)}`;
      return (
        `<div class="bar-row"><span class="bar-label">${escapeHtml(project.name)}</span>` +
        `<svg class="bar" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label)}">` +
        '<rect class="track" x="0" y="0" width="100" height="10"/>' +
        `<rect x="0" y="0" width="${width.toFixed(2)}" height="10"/>` +
        `</svg><span class="bar-value">${escapeHtml(compact(value))}</span></div>`
      );
    })
    .join('');
  return `<figure class="chart"><figcaption>${escapeHtml(t().html.chart)}</figcaption>${rows}</figure>`;
}

/**
 * One session's rows.
 *
 * The leading row is the session's whole subtree — the figure the text tree
 * prints — and the scope split, when asked for, follows as indented rows, so
 * `自身 + 子代理 = 总` stays visible in the table rather than only in the tree.
 */
function sessionRows(session: SessionReport, options: HtmlOptions): string[] {
  const symbol = options.symbol ?? '';
  const labels = t();
  const split = options.scope === true && (session.spawned.requests > 0 || session.subagentCount > 0);
  const badges =
    (session.archived ? `<span class="badge">${escapeHtml(labels.tree.archived)}</span>` : '') +
    (session.subagentCount > 0
      ? `<span class="badge">${escapeHtml(labels.tree.subagents(count(session.subagentCount)))}</span>`
      : '') +
    (split ? `<span class="badge">${escapeHtml(labels.scope.total)}</span>` : '');
  const name = `${session.isSubagent ? '<span class="nested">↳</span>' : ''}${escapeHtml(
    session.title ?? labels.tree.untitled,
  )}${badges}`;
  const dates =
    `<td class="date">${escapeHtml(dayLabel(session.firstUsage))}</td>` +
    `<td class="date">${escapeHtml(dayLabel(session.lastUsage))}</td>`;
  const rows = [
    `<tr><td class="name${session.isSubagent ? ' subagent' : ''}">${name}</td>${bucketCells(
      session.total.tokens,
    )}${sumCells(
      session.total.tokens,
      session.total.requests,
      session.total.cost.total,
      symbol,
    )}${dates}</tr>`,
  ];
  if (split) {
    const scopes: readonly (readonly [string, ScopeTotals])[] = [
      [labels.scope.own, session.own],
      [labels.scope.spawned, session.spawned],
    ];
    for (const [label, scope] of scopes) {
      rows.push(
        `<tr class="scope"><td class="name sub">${escapeHtml(label)}</td>${bucketCells(
          scope.tokens,
        )}${sumCells(scope.tokens, scope.requests, scope.cost.total, symbol)}<td class="date"></td><td class="date"></td></tr>`,
      );
    }
  }
  return rows;
}

/**
 * Session rows in display order: a session a human started, then what it spawned.
 *
 * The report orders rows by recency, which is what a list wants; a table that
 * marks subagents with `↳` has to put each one under its parent instead, or the
 * marker points at a session that is somewhere else on the page. A subagent
 * whose parent was filtered out keeps its own place at the top level.
 */
function orderedSessions(rows: readonly SessionReport[]): SessionReport[] {
  const known = new Set(rows.map((row) => row.id));
  const childrenOf = new Map<string, SessionReport[]>();
  for (const row of rows) {
    if (row.parentId === null) continue;
    const bucket = childrenOf.get(row.parentId);
    if (bucket === undefined) childrenOf.set(row.parentId, [row]);
    else bucket.push(row);
  }
  const ordered: SessionReport[] = [];
  const visit = (row: SessionReport): void => {
    ordered.push(row);
    for (const child of childrenOf.get(row.id) ?? []) visit(child);
  };
  for (const row of rows) {
    if (row.parentId !== null && known.has(row.parentId)) continue;
    visit(row);
  }
  return ordered;
}

/** One project's card: its heading, its own figures, its sessions and models. */
function projectCard(project: ProjectReport, options: HtmlOptions): string {
  const symbol = options.symbol ?? '';
  const labels = t();
  const rows = project.sessionReports ?? [];
  const repo = project.repo === undefined ? '' : ` · ${escapeHtml(project.repo.name)}`;
  const meta = labels.html.meta(count(project.sessions), dayLabel(project.firstUsage), dayLabel(project.lastUsage));
  const blocks = [
    '<article class="card project">',
    `<h3>${escapeHtml(project.name)}</h3>`,
    `<p class="meta"><code>${escapeHtml(project.path)}</code>${repo} · ${escapeHtml(meta)}</p>`,
    stats(project.total.tokens, project.total.requests, project.total.cost.total, symbol),
    modelTable(project.models, symbol),
  ];
  if (rows.length > 0) {
    const body = orderedSessions(rows).flatMap((session) => sessionRows(session, options)).join('');
    blocks.push(tokenTable(labels.html.session, body, dateHead()));
  }
  blocks.push('</article>');
  return blocks.join('\n');
}

/**
 * The pricing bands, folded away.
 *
 * Every band carries its own rate card, so the table explains a number without
 * reaching back into the pricing engine — which is exactly what a report filed
 * away months ago needs.
 */
function bandTable(bands: readonly BandSummary[], symbol: string, historical: boolean): string {
  if (bands.length === 0) return '';
  const labels = t();
  const unit = historical ? labels.rate.vendorCard : labels.rate.perMillion(symbol);
  const rows = bands
    .map((band) => {
      const rates = band.components
        .map((component) => `${escapeHtml(component.label)} ${escapeHtml(displayRate(component.rate))}`)
        .join(' · ');
      return (
        `<tr><td>${escapeHtml(bandTitle(band))}</td><td class="wrap">${escapeHtml(bandWindow(band))}</td>` +
        bucketCells(band.tokens) +
        sumCells(band.tokens, band.requests, band.cost.total, symbol) +
        `<td class="rates">${rates}</td></tr>`
      );
    })
    .join('');
  const head = [
    `<th>${escapeHtml(labels.html.band)}</th>`,
    `<th>${escapeHtml(labels.html.window)}</th>`,
    ...BUCKETS.map((label) => `<th class="num">${escapeHtml(label)}</th>`),
    '<th class="num">T</th>',
    `<th class="num">${escapeHtml(labels.list.requests)}</th>`,
    `<th class="num">${escapeHtml(labels.html.amount)}</th>`,
    `<th>${escapeHtml(labels.html.unitPrice)}（${escapeHtml(unit)}）</th>`,
  ].join('');
  const table = `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  return `<details class="fold"><summary>${escapeHtml(labels.html.bands)}</summary>${table}</details>`;
}

/** Non-fatal problems worth showing, under their own heading. */
function warningList(warnings: readonly Warning[]): string {
  if (warnings.length === 0) return '';
  const items = warnings.map((warning) => `<li>${escapeHtml(warning.message)}</li>`).join('');
  return `<section class="card warnings"><h3>${escapeHtml(t().html.tips)}</h3><ul>${items}</ul></section>`;
}

/**
 * Projects worth a card.
 *
 * A project that billed nothing in range has no rows to show. In a report
 * without session rows (the `all` and `project` dimensions) a project is worth a
 * card exactly when it billed something.
 */
function activeProjects(result: UsageResult): ProjectReport[] {
  return result.projects.filter((project) =>
    project.sessionReports === undefined ? project.requests > 0 : project.sessionReports.length > 0,
  );
}

/** The fixed `label  value` lines above a report, as a definition list. */
function headerFacts(sections: readonly ReportSection[], options: HtmlOptions): string {
  const labels = t();
  const [first] = sections;
  if (first === undefined) return '';
  const { result } = first;
  const provenance = provenanceOf(result, options.pricingLabel);
  const agent =
    options.agentLabel === undefined ? result.agent : labels.header.agentName(result.agent, options.agentLabel);
  const range = sections.length === 1 ? first.range.label : sections.map((section) => section.label).join(' / ');
  const facts: (readonly [string, string])[] = [
    [labels.header.title, agent],
    [labels.header.dataDir, result.source],
    [sections.length === 1 ? labels.header.range : labels.header.windows, range],
    [labels.header.pricing, provenance.source],
  ];
  if (provenance.rate !== undefined) facts.push([labels.header.rate, provenance.rate]);
  const cells = facts
    .map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join('');
  return `<dl class="facts">${cells}</dl>`;
}

/** One window: its heading, the headline totals, and the project tree. */
function windowBlock(section: ReportSection, options: HtmlOptions): string {
  const { result } = section;
  const symbol = options.symbol ?? '';
  const span =
    result.firstUsage === null || result.lastUsage === null ? undefined : spanText(result.firstUsage, result.lastUsage);
  const heading = span === undefined ? section.label : `${section.label} · ${span}`;
  const projects = activeProjects(result);
  const headline = stats(result.tokens, result.requests, result.cost.total, symbol);
  const models = modelTable(result.models, symbol);
  return [
    '<section class="window">',
    `<h2>${escapeHtml(heading)}</h2>`,
    `<div class="card totals">${headline}${models}</div>`,
    projectChart(projects),
    ...projects.map((project) => projectCard(project, options)),
    bandTable(result.bands, symbol, result.rateInfo.mode === 'historical'),
    warningList(result.warnings),
    '</section>',
  ].join('\n');
}

/**
 * The document's stylesheet.
 *
 * Inlined on purpose: a report that linked a stylesheet would break the moment
 * it left the machine it was written on. `prefers-color-scheme` is honoured
 * because a browser will render this at night as often as by day.
 */
const STYLE = `
:root {
  color-scheme: light dark;
  --fg: #1f2328; --muted: #656d76; --bg: #f6f7f9; --card: #ffffff;
  --line: #d8dee4; --accent: #2f6feb; --track: #eaeef2;
}
@media (prefers-color-scheme: dark) {
  :root { --fg: #e6edf3; --muted: #9198a1; --bg: #0d1117; --card: #161b22;
          --line: #30363d; --accent: #4493f8; --track: #21262d; }
}
* { box-sizing: border-box; }
body {
  margin: 0 auto; padding: 24px 20px 48px; max-width: 1200px;
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--fg); background: var(--bg);
}
h1 { margin: 0 0 12px; font-size: 20px; }
h2 { margin: 0 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); font-size: 17px; }
h3 { margin: 0 0 6px; font-size: 15px; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 0 0 22px; font-size: 13px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.window { margin: 0 0 28px; }
.card { margin: 0 0 14px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
.meta { margin: 0 0 6px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.stats { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 6px 0 4px; }
.stat { display: flex; flex-direction: column; min-width: 58px; }
.stat-label { color: var(--muted); font-size: 11px; }
.stat-value { font-variant-numeric: tabular-nums; font-weight: 600; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 5px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 600; white-space: nowrap; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.name { min-width: 180px; }
td.date, th.date, td.rates, td.wrap { white-space: nowrap; }
td.rates, td.wrap { color: var(--muted); font-size: 12px; }
tr.scope td { color: var(--muted); }
td.name.subagent { padding-left: 24px; }
.nested { margin-right: 4px; color: var(--muted); }
.sub { display: block; color: var(--muted); font-size: 11px; }
.badge { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 999px; background: var(--track); color: var(--muted); font-size: 11px; font-weight: 400; }
.chart { margin: 0 0 14px; }
figcaption { margin-bottom: 6px; color: var(--muted); font-size: 12px; }
.bar-row { display: grid; grid-template-columns: minmax(80px, 200px) 1fr 56px; align-items: center; gap: 8px; margin-bottom: 3px; font-size: 12px; }
.bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar { display: block; width: 100%; height: 10px; }
.bar rect { fill: var(--accent); }
.bar rect.track { fill: var(--track); }
.bar-value { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
.fold { margin-top: 10px; }
summary { color: var(--muted); cursor: pointer; font-size: 13px; }
.warnings ul { margin: 0; padding-left: 20px; }
`.trim();

/**
 * Render a usage report as one self-contained HTML document.
 *
 * Pure string building: no template engine, no dependency, no script. Amounts
 * and token counts are the report layer's own figures, formatted with the same
 * rules the text report uses, so the two outputs agree digit for digit.
 *
 * @param sections - one window, or several when the caller asked for them together.
 * @param options - display name, currency symbol, and whether to show the scope split.
 * @returns the complete document, starting at `<!doctype html>`.
 */
export function renderHtmlReport(sections: readonly ReportSection[], options: HtmlOptions = {}): string {
  const labels = t();
  const [first] = sections;
  const title = first === undefined ? labels.app.usage : `${labels.app.usage} · ${first.result.agent}`;
  return [
    '<!doctype html>',
    `<html lang="${language()}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    `<header><h1>${escapeHtml(labels.app.usage)}</h1>${headerFacts(sections, options)}</header>`,
    `<main>${sections.map((section) => windowBlock(section, options)).join('\n')}</main>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
