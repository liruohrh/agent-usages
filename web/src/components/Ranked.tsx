/**
 * The ranking views: projects, agents, workspaces and sessions, all as the same
 * leaderboard.
 *
 * The rule this file exists for: a list of entities that carry ten figures is not
 * a table. Each row is a rank, a title, a bar whose length is the measure being
 * sorted on, the buckets that make up that bar as labelled chips (a stacked bar
 * alone hides every bucket the dominant one dwarfs — cache-hit input is usually
 * >99% of the tokens, so the other colours would be invisible), and the headline
 * number on the right. Clicking a row opens every bucket with its own money.
 */

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { createPortal } from 'react-dom';

import type { AgentTotals, CostTotals, ProjectSummary, TokenBuckets, WorkspaceNode } from '../types';
import { formatCost, formatInstant, formatShare, formatTokens, shortenPath } from '../format';
import { AgentBadge, Card, Chip } from './Bits';
import { BUCKETS, bucketDefinition, bucketMoney, tokenPieces } from './Metrics';
import { t as catalogue, useT } from '../i18n';

/** Everything a ranking row needs, whatever the entity is. */
export interface RankedEntry {
  /** Stable key (and React key). */
  key: string;
  /** The row's name. */
  title: string;
  /** Where the name goes, when it is clickable. */
  href?: string | undefined;
  /** Agent chips, for a project or a workspace. */
  badges?: ReactNode;
  /** A muted line after the title: the project it belongs to, or its path. */
  subtitle?: string | undefined;
  /** Counts shown next to the bar (sessions, subagents…). */
  counts?: string | undefined;
  tokens: TokenBuckets;
  cost: CostTotals;
  requests: number;
  lastUsage?: number | null | undefined;
  /** The rows this entry expands into, when it has children worth listing. */
  children?: ReactNode | undefined;
  /** Where a "open" link should point. */
  openLabel?: string | undefined;
}

/**
 * One way the list can be ordered.
 *
 * A measure only decides the order (and therefore the bar lengths); what a row
 * *shows* is always the same three columns — Q, the token total, and the money
 * with its share — so the numbers stay in the same place as the sort changes.
 */
/** The billed-bucket total, which is what `T` means everywhere else. */
export function billedTokens(tokens: TokenBuckets): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
}

/**
 * The smallest share a non-zero piece may have on a bar.
 *
 * Cache-hit input is usually more than 99% of a row's tokens, so an honest
 * proportional stack would leave every other piece at zero pixels wide.
 */
const MIN_SEGMENT = 0.012;

/**
 * What the bar means, said once, in the header.
 *
 * The bar is the row's *own* composition and nothing else: always the full width,
 * because size is what the numbers and the sort are for.
 */
const barRule = (): string => catalogue().board.barRule;

/** What this row is made of, as a full-width stack of its own tokens. */
function CompositionBar({
  tokens,
  cost,
  symbol,
}: {
  tokens: TokenBuckets;
  cost: CostTotals;
  symbol: string;
}): React.ReactElement {
  const total = billedTokens(tokens);
  const pieces = tokenPieces(tokens, cost).filter((piece) => piece.tokens > 0);
  const floors = pieces.length * MIN_SEGMENT;
  const scale = pieces.length === 0 ? 0 : 1 - floors;
  return (
    <span
      className="flex h-3.5 w-full overflow-hidden rounded-full bg-raised ring-1 ring-line ring-inset"
      title={catalogue().board.barTitle}
    >
      {pieces.map((piece) => {
        const share = total === 0 ? 0 : piece.tokens / total;
        return (
          <span
            key={piece.key}
            className="h-full"
            style={{ width: `${(MIN_SEGMENT + share * scale) * 100}%`, backgroundColor: piece.color }}
            title={catalogue().board.segment(
              piece.label,
              formatTokens(piece.tokens, true),
              formatShare(share),
              formatCost(piece.money, symbol),
            )}
          />
        );
      })}
    </span>
  );
}

/**
 * One colour per entry, keyed by the entry itself rather than by its rank in a
 * given chart: the same project keeps the same colour in every chart, so the eye
 * can follow it across metrics.
 */
const ENTRY_COLORS = ['#58a6ff', '#a78bfa', '#34d399', '#f59e0b', '#f472b6', '#22d3ee', '#84cc16', '#fb7185'];

/** How many entries a chart names before folding the rest into a total. */
const CHART_ROWS = 6;

/** One bar row of a metric chart. */
interface ValuedEntry {
  entry: RankedEntry;
  value: number;
}

/** The bar rows of one metric: shared by the small card and the full dialog. */
function MetricRows({
  valued,
  total,
  colors,
  format,
  symbol,
  metricKey,
  size = 'small',
}: {
  valued: readonly ValuedEntry[];
  total: number;
  colors: ReadonlyMap<string, string>;
  format: (value: number) => string;
  /** Needed only by the dialog's chip line: the money each bucket produced. */
  symbol: string;
  /** The metric being charted — left out of the chip line, it is the bar above. */
  metricKey: string;
  size?: 'small' | 'large';
}): React.ReactElement {
  const nameWidth = size === 'large' ? 'w-32 sm:w-48 lg:w-64' : 'w-36';
  const text = size === 'large' ? 'text-[12px]' : 'text-[11px]';
  return (
    <ul className={`${size === 'large' ? 'mt-3 space-y-2' : 'mt-2 space-y-1.5'}`}>
      {valued.length === 0 && <li className={`${text} text-faint`}>{catalogue().board.emptyMetric}</li>}
      {valued.map((item) => {
        const share = total === 0 ? 0 : item.value / total;
        // A non-zero slice that rounds to `0%` reads as "nothing"; say so instead.
        const percent = share > 0 && share < 0.0005 ? '<0.1%' : formatShare(share);
        return (
          <Fragment key={item.entry.key}>
          <li
            className="flex items-center gap-2"
            title={`${item.entry.title}：${format(item.value)}（${catalogue().board.metricShare(percent)}）`}
          >
            <span className={`${nameWidth} shrink-0 truncate ${text} text-muted`}>{item.entry.title}</span>
            <span className={`${size === 'large' ? 'h-3.5' : 'h-2.5'} min-w-0 flex-1 overflow-hidden rounded-full bg-raised`}>
              <span
                className="block h-full rounded-full"
                style={{ width: `${share * 100}%`, backgroundColor: colors.get(item.entry.key) ?? '#8b949e' }}
              />
            </span>
            <span className={`tnum w-20 shrink-0 text-right ${text} text-fg`}>{format(item.value)}</span>
            <span className={`tnum w-12 shrink-0 text-right ${text} text-faint`}>{percent}</span>
          </li>
          {size !== 'large' ? null : (
            // Under the name, indented: what else this entry is made of, the same
            // line a leaderboard row carries under its bar. The metric being
            // charted is left out — it is already the bar and the number above.
            <li className="mt-1 pl-5">
              <BucketChips entry={item.entry} symbol={symbol} omit={metricKey} />
            </li>
          )}
          </Fragment>
        );
      })}
    </ul>
  );
}

/** The full-size chart, over everything: a dialog, because the card is too small. */
function MetricDialog({
  metric,
  valued,
  total,
  colors,
  format,
  symbol,
  onClose,
}: {
  metric: SortMetric;
  valued: readonly ValuedEntry[];
  total: number;
  colors: ReadonlyMap<string, string>;
  format: (value: number) => string;
  symbol: string;
  onClose: () => void;
}): React.ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // The list behind is long; freezing it keeps the wheel inside the dialog.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 sm:p-8"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={catalogue().board.dialogLabel(metric.label)}
        data-metric-dialog={metric.key}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-fg">
              {catalogue().board.dialogTitle(metric.label, String(valued.length))}
            </h2>
            <p className="text-[11px] text-faint">{catalogue().board.dialogNote(metric.hint, format(total))}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded border border-line px-2.5 py-1 text-[12px] text-muted hover:text-fg"
          >
            {catalogue().board.close}
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          <MetricRows
            valued={valued}
            total={total}
            colors={colors}
            format={format}
            symbol={symbol}
            metricKey={metric.key}
            size="large"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * One metric, split across the list — the "who owns this total" view.
 *
 * A horizontal bar per entry, longest first, whose length is that entry's **share
 * of the metric's total**: a full bar means "all of it" in every chart, so the
 * charts stay comparable with each other. The card names the biggest few; the
 * rest are one click away in a dialog that lists **every** entry.
 */
function MetricChart({
  metric,
  entries,
  colors,
  symbol,
}: {
  metric: SortMetric;
  entries: readonly RankedEntry[];
  colors: ReadonlyMap<string, string>;
  symbol: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const valued = entries
    .map((entry) => ({ entry, value: metric.value(entry) }))
    .filter((item) => item.value > 0)
    .sort((left, right) => right.value - left.value);
  const total = valued.reduce((sum, item) => sum + item.value, 0);
  const asMoney = metric.key === 'cost';
  const format = (value: number): string => (asMoney ? formatCost(String(value), symbol) : formatTokens(value, true));
  const shown = valued.slice(0, CHART_ROWS);
  const folded = valued.length - shown.length;
  const rest = total - shown.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className="rounded-lg border border-line p-3" data-chart={metric.key}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium text-fg">{metric.label}</span>
        <span className="tnum shrink-0 text-[11px] text-faint" title={catalogue().board.metricTotal}>
          {format(total)}
        </span>
      </div>
      <MetricRows valued={shown} total={total} colors={colors} format={format} symbol={symbol} metricKey={metric.key} />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-faint">
          {folded > 0
            ? catalogue().board.folded(String(folded), format(rest))
            : catalogue().board.allListed(String(valued.length))}
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
        >
          {catalogue().board.showMore(String(valued.length))}
        </button>
      </div>
      {open && (
        <MetricDialog
          metric={metric}
          valued={valued}
          total={total}
          colors={colors}
          format={format}
          symbol={symbol}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** The analysis panel: one chart per metric, across every row of the list. */
function MetricCharts({
  entries,
  symbol,
  metrics,
}: {
  entries: readonly RankedEntry[];
  symbol: string;
  metrics: readonly SortMetric[];
}): React.ReactElement {
  // Colours follow the list's own order, so an entry keeps its colour whichever
  // metric is being charted.
  const colors = new Map(
    entries.map((entry, index) => [entry.key, ENTRY_COLORS[index % ENTRY_COLORS.length] ?? '#8b949e']),
  );
  return (
    <div className="mb-3 rounded-lg border border-line bg-panel/60 p-3">
      <p className="mb-3 text-[11px] leading-5 text-faint">
        {catalogue().board.chartsNote(CHART_ROWS)}
      </p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {metrics.map((metric) => (
          <MetricChart key={metric.key} metric={metric} entries={entries} colors={colors} symbol={symbol} />
        ))}
      </div>
    </div>
  );
}

/**
 * A figure the list can be ordered by.
 *
 * The same list drives two things: the sort dropdown in the header, and the
 * clickable chips under each bar (click `I/C` on any row to order the list by it).
 */
export interface SortMetric {
  key: string;
  label: string;
  hint: string;
  /** The comparable number. */
  value: (entry: RankedEntry) => number;
  /** Drawn only when at least one row has a non-zero value. */
  optional?: boolean;
}

/**
 * Every figure a row carries, in the order the chips show them.
 *
 * A function rather than a constant: two of the labels are words (`费用`, `最近`)
 * and the rest are definitions, so the list has to be built in the language of
 * the render that asks for it.
 * @returns the sortable metrics, in the CLI's order.
 */
export function sortMetrics(): SortMetric[] {
  const words = catalogue();
  const vocabulary = words.vocabulary;
  return [
    { key: 'requests', label: 'Q', hint: vocabulary.requests, value: (entry) => entry.requests },
    { key: 'input', label: 'I/M', hint: vocabulary.inputMiss, value: (entry) => entry.tokens.input },
    { key: 'cacheRead', label: 'I/C', hint: vocabulary.cacheRead, value: (entry) => entry.tokens.cacheRead },
    { key: 'cacheWrite', label: 'I/W', hint: vocabulary.cacheWrite, value: (entry) => entry.tokens.cacheWrite, optional: true },
    {
      key: 'output',
      label: 'O',
      hint: vocabulary.outputOnly,
      value: (entry) => Math.max(0, entry.tokens.output - entry.tokens.reasoning),
    },
    {
      key: 'reasoning',
      label: 'R',
      hint: vocabulary.reasoningHint,
      value: (entry) => entry.tokens.reasoning,
      optional: true,
    },
    { key: 'tokens', label: 'T', hint: vocabulary.tokens, value: (entry) => billedTokens(entry.tokens) },
    { key: 'cost', label: words.tables.seriesCost, hint: vocabulary.costHint, value: (entry) => Number(entry.cost.total) },
    { key: 'recent', label: words.session.bandRecentLabel, hint: vocabulary.recent, value: (entry) => entry.lastUsage ?? 0 },
  ];
}

/** The per-bucket table an expanded row shows: tokens, share and money. */
export function BucketDetail({
  tokens,
  cost,
  symbol,
  facts,
}: {
  tokens: TokenBuckets;
  cost: CostTotals;
  symbol: string;
  /** Extra lines for the right-hand column. */
  facts?: ReactNode;
}): React.ReactElement {
  const total = billedTokens(tokens);
  const money = bucketMoney(tokens, cost);
  const rows = BUCKETS.filter((bucket) => bucket.key !== 'reasoning' || tokens.reasoning > 0 || Number(money['reasoning']) > 0);
  return (
    <div className="grid grid-cols-1 gap-3 rounded-lg border border-line bg-panel p-3 lg:grid-cols-[1fr_16rem]">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="text-[11px] text-faint">
            <th className="pb-1 text-left font-medium">{catalogue().overview.buckets}</th>
            <th className="pb-1 text-right font-medium">{catalogue().overview.tokens}</th>
            <th className="pb-1 text-right font-medium" title={catalogue().vocabulary.shareOfTotal}>
              {catalogue().overview.shareOfTotal}
            </th>
            <th className="pb-1 text-right font-medium" title={catalogue().vocabulary.ownMoney} />
          </tr>
        </thead>
        <tbody>
          {rows.map((bucket) => (
            <tr key={bucket.key} className="border-t border-line">
              <td className="py-1">
                <span
                  className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle"
                  style={{ backgroundColor: bucket.color }}
                />
                <span className="tnum" title={bucketDefinition(bucket.key)}>
                  {bucket.short}
                </span>
              </td>
              <td className="tnum py-1 text-right">{formatTokens(tokens[bucket.key], true)}</td>
              <td className="tnum py-1 text-right text-muted">
                {total === 0 ? '—' : formatShare(tokens[bucket.key] / total)}
              </td>
              <td className="tnum py-1 text-right">{formatCost(money[bucket.key] ?? '0', symbol)}</td>
            </tr>
          ))}
          <tr className="border-t border-line font-medium">
            <td className="py-1">{catalogue().vocabulary.total}</td>
            <td className="tnum py-1 text-right">{formatTokens(total, true)}</td>
            <td className="py-1 text-right text-faint">100%</td>
            <td className="tnum py-1 text-right text-accent">{formatCost(cost.total, symbol)}</td>
          </tr>
        </tbody>
      </table>
      {facts !== undefined && <div className="space-y-1.5 text-[12px] text-muted">{facts}</div>}
    </div>
  );
}

/**
 * The leaderboard itself.
 *
 * One row per entry: a rank, the name, **one bar that is that row's own token
 * composition**, the figures under the bar as clickable chips, and three figures
 * pinned on the right (Q, total tokens, money) so the eye can run down a column.
 * Any metric orders the list — the dropdown in the header, or a click on that
 * metric's chip in any row.
 *
 * @param props - the entries, the sort default, and how to draw an expanded row.
 */
export function RankedList({
  entries,
  symbol,
  title,
  defaultSort = 'cost',
  emptyText,
  baseline,
  footnote,
  limit,
}: {
  entries: readonly RankedEntry[];
  symbol: string;
  title: string;
  defaultSort?: string;
  emptyText?: string;
  /** An extra control in the header (filters, toggles). */
  baseline?: ReactNode;
  footnote?: ReactNode;
  /** Draw only the first N rows. */
  limit?: number | undefined;
}): React.ReactElement {
  const t = useT();
  const [sortKey, setSortKey] = useState(defaultSort);
  const [desc, setDesc] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  /** The per-metric pies stay folded away until the reader asks for them. */
  const [analysis, setAnalysis] = useState(false);

  // A figure that is zero everywhere (no cache writes, no reasoning) is not worth
  // a chip; it appears as soon as one row has one.
  const metrics = sortMetrics().filter(
    (candidate) => candidate.optional !== true || entries.some((entry) => candidate.value(entry) > 0),
  );
  const metric = metrics.find((candidate) => candidate.key === sortKey) ?? metrics[0];

  const rows = useMemo(() => {
    if (metric === undefined) return [];
    const sorted = [...entries].sort((left, right) => (desc ? -1 : 1) * (metric.value(left) - metric.value(right)));
    return limit === undefined ? sorted : sorted.slice(0, limit);
  }, [entries, metric, desc, limit]);

  const totalCost = rows.reduce((sum, entry) => sum + Number(entry.cost.total), 0);
  const totalTokens = rows.reduce((sum, entry) => sum + billedTokens(entry.tokens), 0);
  const totalRequests = rows.reduce((sum, entry) => sum + entry.requests, 0);
  /** Right-hand columns: the three figures a reader scans down. */
  const grid = '1.5rem minmax(13rem, 1fr) 4.5rem 6rem 9rem';

  return (
    <Card
      title={`${title}（${rows.length}）`}
      actions={
        <>
          {baseline}
          <button
            type="button"
            onClick={() => setAnalysis((value) => !value)}
            className={`rounded border px-2 py-0.5 text-[11px] ${analysis ? 'border-accent/50 bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}
            title={t.board.chartsHint}
          >
            {analysis ? t.board.chartsOpen : t.board.charts}
          </button>
          <label className="flex items-center gap-1 text-[11px] text-muted">
            {t.board.sortBy}
            <select
              value={sortKey}
              onChange={(event) => {
                setSortKey(event.target.value);
                setDesc(true);
              }}
              className="rounded border border-line bg-panel px-1 py-0.5 text-[11px] text-fg"
            >
              {metrics.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setDesc((value) => !value)}
            className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
            title={desc ? t.board.descending : t.board.ascending}
          >
            {desc ? t.board.descendingShort : t.board.ascendingShort}
          </button>
        </>
      }
    >
      {rows.length === 0 || metric === undefined ? (
        <p className="py-8 text-center text-[13px] text-faint">{emptyText ?? t.board.empty}</p>
      ) : (
        <>
          {/* A chart of timestamps would be meaningless: the charts cover the
              figures that add up to something, not the recency. */}
          {analysis && (
            <MetricCharts
              entries={rows}
              symbol={symbol}
              metrics={metrics.filter((candidate) => candidate.key !== 'recent')}
            />
          )}
          <div className="mb-1 border-b border-line pb-2 text-[12px]">
            <div className="grid items-center gap-3" style={{ gridTemplateColumns: grid }} data-columns>
              <span />
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
                <span className="tnum text-fg">{t.board.total(formatCost(String(totalCost), symbol))}</span>
                <span>
                  T <span className="tnum text-fg">{formatTokens(totalTokens, true)}</span>
                </span>
                <span>
                  Q <span className="tnum text-fg">{formatTokens(totalRequests)}</span>
                </span>
                <span className="flex flex-wrap items-center gap-x-2.5">
                  {BUCKETS.map((bucket) => (
                    <span key={bucket.key} className="flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: bucket.color }} />
                      {bucket.short}
                    </span>
                  ))}
                </span>
              </span>
              <span className="text-right text-faint" title={t.vocabulary.requests}>
                Q
              </span>
              <span className="text-right text-faint" title={t.vocabulary.tokens}>
                T
              </span>
              {/* No heading over the money: every cell below starts with `¥`. */}
              <span
                className="text-right text-faint"
                title={t.vocabulary.cost}
                aria-label={t.tables.seriesCost}
              />
            </div>
            <p className="mt-1.5 text-[11px] leading-5 text-faint" title={barRule()}>
              {t.board.rowNote(metric.label, desc ? t.board.descendingWord : t.board.ascendingWord)}
            </p>
          </div>

          <ol className="divide-y divide-line">
            {rows.map((entry, index) => {
              const expanded = open === entry.key;
              return (
                <li key={entry.key}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setOpen(expanded ? null : entry.key)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') setOpen(expanded ? null : entry.key);
                    }}
                    className={`grid cursor-pointer items-center gap-3 px-1 py-2.5 hover:bg-raised ${expanded ? 'bg-raised' : ''}`}
                    style={{ gridTemplateColumns: grid }}
                  >
                    <span className="tnum text-right text-[11px] text-faint">{index + 1}</span>
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-2">
                        {entry.href === undefined ? (
                          <span className="cell-title text-[13px] text-fg" title={entry.title}>
                            {entry.title}
                          </span>
                        ) : (
                          <Link
                            to={entry.href}
                            onClick={(event) => event.stopPropagation()}
                            className="cell-title text-[13px] text-accent hover:underline"
                            title={entry.title}
                          >
                            {entry.title}
                          </Link>
                        )}
                        {entry.badges}
                        {entry.counts !== undefined && <Chip tone="muted">{entry.counts}</Chip>}
                        {entry.subtitle !== undefined && (
                          <span className="min-w-0 truncate text-[11px] text-faint" title={entry.subtitle}>
                            {entry.subtitle}
                          </span>
                        )}
                        {sortKey === 'recent' && entry.lastUsage != null && (
                          <span className="shrink-0 text-[11px] text-muted">{formatInstant(entry.lastUsage)}</span>
                        )}
                      </span>

                      {/* The bar: this row's own composition. */}
                      <span className="mt-1.5 block">
                        <CompositionBar tokens={entry.tokens} cost={entry.cost} symbol={symbol} />
                      </span>

                      {/* Then every bucket with the money it produced. */}
                      <span className="mt-1 block">
                        <BucketChips entry={entry} symbol={symbol} />
                      </span>
                    </span>

                    {/* The three figures to run down: requests, tokens, money. */}
                    <span className="tnum whitespace-nowrap text-right text-[13px] text-fg">
                      {formatTokens(entry.requests)}
                    </span>
                    <span className="tnum whitespace-nowrap text-right text-[13px] text-fg">
                      {formatTokens(billedTokens(entry.tokens), true)}
                    </span>
                    <span className="tnum whitespace-nowrap text-right text-[13px]">
                      <span className={sortKey === 'cost' ? 'font-medium text-accent' : 'text-fg'}>
                        {formatCost(entry.cost.total, symbol)}
                      </span>
                      {totalCost > 0 && (
                        <>
                          {' '}
                          <span className="text-[11px] text-faint">
                            {formatShare(Number(entry.cost.total) / totalCost)}
                          </span>
                        </>
                      )}
                    </span>
                  </div>
                  {expanded && (
                    <div className="px-1 pb-3">
                      {entry.children ?? <BucketDetail tokens={entry.tokens} cost={entry.cost} symbol={symbol} />}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {footnote !== undefined && <p className="mt-3 text-[11px] text-faint">{footnote}</p>}
        </>
      )}
    </Card>
  );
}

/** One figure beside the pie: a bucket, its tokens, and the money it produced. */
interface MetricChip {
  key: string;
  label: string;
  hint: string;
  value: string;
  extra?: string | undefined;
  money?: string | undefined;
  color?: string | undefined;
}

/**
 * The buckets a row is made of, in the CLI's order, each with its own money.
 *
 * Only the five pieces of the pie appear here: the totals (`T`, and the money) are
 * the figures pinned on the right, and cache money is the `I/C` line's money —
 * repeating them beside the chart would say the same number twice.
 */
function metricChips(entry: RankedEntry, symbol: string): MetricChip[] {
  // The share beside `I/C` is the CLI's hit rate, `I/C ÷ I/T` — a share of the
  // input, which is the figure the ratio is about.
  const inputTotal = entry.tokens.input + entry.tokens.cacheRead + entry.tokens.cacheWrite;
  const hit = inputTotal === 0 ? '' : formatShare(entry.tokens.cacheRead / inputTotal);
  return tokenPieces(entry.tokens, entry.cost)
    .filter((piece) => piece.tokens > 0)
    .map((piece) => ({
      key: piece.key,
      label: piece.short,
      hint: `${piece.label}：${formatTokens(piece.tokens, true)} tokens${
        piece.key === 'cacheRead' && hit.length > 0 ? catalogue().vocabulary.shareOfInput(hit) : ''
      } · ${formatCost(piece.money, symbol)}`,
      value: formatTokens(piece.tokens, true),
      ...(piece.key === 'cacheRead' && hit.length > 0 ? { extra: hit } : {}),
      money: formatCost(piece.money, symbol),
      color: piece.color,
    }));
}

/**
 * A row's buckets, each with the tokens it counted and the money it produced.
 *
 * The one line under a leaderboard row's bar, and — indented under the name — the
 * second line of a dialog row: the figures a reader compares across the list.
 * `omit` drops the metric the surrounding chart is already drawing, so a reader
 * never sees the same number twice on one row.
 */
function BucketChips({
  entry,
  symbol,
  omit,
}: {
  entry: RankedEntry;
  symbol: string;
  /** A {@link SortMetric} key to leave out, when the row already shows it. */
  omit?: string | undefined;
}): React.ReactElement {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
      {metricChips(entry, symbol)
        .filter((chip) => chip.key !== omit)
        .map((chip) => (
          <span key={chip.key} className="flex items-center gap-1 whitespace-nowrap text-[11px]" title={chip.hint}>
            {chip.color !== undefined && (
              <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: chip.color }} />
            )}
            <span className="text-faint">{chip.label}</span>
            <span className="tnum text-muted">{chip.value}</span>
            {chip.extra !== undefined && <span className="tnum text-faint">{chip.extra}</span>}
            {chip.money !== undefined && <span className="tnum text-fg">{chip.money}</span>}
          </span>
        ))}
    </span>
  );
}

/** The agents of a scope, as a ranking. */
export function AgentBoard({
  agents,
  symbol,
  title,
}: {
  agents: readonly AgentTotals[];
  symbol: string;
  title: string;
}): React.ReactElement {
  const t = useT();
  const entries: RankedEntry[] = agents.map((agent) => ({
    key: agent.id,
    title: agent.label,
    badges: <AgentBadge id={agent.id} />,
    subtitle: agent.source,
    counts: t.board.sessionCounts(String(agent.sessions), String(agent.subagentSessions)),
    tokens: agent.tokens,
    cost: agent.cost,
    requests: agent.requests,
    lastUsage: agent.lastUsage,
  }));
  return (
    <RankedList
      entries={entries}
      symbol={symbol}
      title={title}
      emptyText={t.board.noAgents}
      footnote={t.board.agentFootnote}
    />
  );
}

/** The projects of the machine, or the workspaces inside one project. */
export function ProjectBoard({
  projects,
  workspaces,
  symbol,
  title,
  openHref,
  limit,
  baseline,
}: {
  /** Set for the whole machine. */
  projects?: readonly ProjectSummary[] | undefined;
  /** Set inside one project: its directories, which rank the same way. */
  workspaces?: readonly WorkspaceNode[] | undefined;
  symbol: string;
  title: string;
  /** Builds the link for a project row (workspaces stay unlinked). */
  openHref?: (project: ProjectSummary) => string;
  /** How many rows to draw (the overview shows five). */
  limit?: number | undefined;
  /** Extra header control (the overview's "show all" link). */
  baseline?: ReactNode;
}): React.ReactElement {
  const t = useT();
  const entries: RankedEntry[] =
    projects !== undefined
      ? projects.map((project) => ({
          key: project.id,
          title: project.name,
          href: openHref?.(project),
          badges: (
            <span className="flex items-center gap-1">
              {project.agents.map((agent) => (
                <AgentBadge key={agent} id={agent} small />
              ))}
            </span>
          ),
          subtitle:
            project.kind === 'repo'
              ? t.board.repoSubtitle(String(project.workspaces.length))
              : project.workspaces[0],
          counts: t.board.sessionCountsProject(String(project.sessions), String(project.subagentSessions)),
          tokens: project.tokens,
          cost: project.cost,
          requests: project.requests,
          lastUsage: project.lastUsage,
          children: (
            <BucketDetail
              tokens={project.tokens}
              cost={project.cost}
              symbol={symbol}
              facts={
                <>
                  <div>
                    {t.tree.own}{' '}
                    <span className="tnum text-fg">{formatCost(project.own.cost.total, symbol)}</span>
                  </div>
                  <div>
                    {t.tree.spawned}{' '}
                    <span className="tnum text-fg">{formatCost(project.spawned.cost.total, symbol)}</span>
                  </div>
                  <div>{t.scope.workspaces(String(project.workspaces.length))}</div>
                  {project.workspaces.slice(0, 3).map((path) => (
                    <div key={path} className="truncate" title={path}>
                      {shortenPath(path, 40)}
                    </div>
                  ))}
                </>
              }
            />
          ),
        }))
      : (workspaces ?? []).map((workspace) => ({
          key: workspace.path,
          title: workspace.name,
          badges: (
            <span className="flex items-center gap-1">
              {workspace.agents.map((agent) => (
                <AgentBadge key={agent} id={agent} small />
              ))}
            </span>
          ),
          subtitle: workspace.path,
          counts: t.board.sessionCountsProject(String(workspace.sessionCount), String(workspace.subagentCount)),
          tokens: workspace.tokens,
          cost: workspace.cost,
          requests: workspace.requests,
          children: <BucketDetail tokens={workspace.tokens} cost={workspace.cost} symbol={symbol} />,
        }));

  return (
    <RankedList
      entries={entries}
      symbol={symbol}
      title={title}
      {...(limit === undefined ? {} : { limit })}
      {...(baseline === undefined ? {} : { baseline })}
      emptyText={t.board.noProjects}
      footnote={projects === undefined ? t.board.workspaceFootnote : t.board.projectFootnote}
    />
  );
}
