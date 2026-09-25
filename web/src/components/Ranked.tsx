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

import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { AgentTotals, CostTotals, ProjectSummary, TokenBuckets, WorkspaceNode } from '../types';
import { formatCost, formatInstant, formatShare, formatTokens, shortenPath } from '../format';
import { AgentBadge, Card, Chip } from './Bits';
import { BUCKETS, bucketMoney, tokenPieces } from './Metrics';

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
const BAR_RULE =
  '条 = 这一行自己的 token 构成：按五个互不重叠的计费项切开（I/M、I/C、I/W、O、R），整条 = 这一行的 100%。某项为 0 时不画；某段不足 1.2% 时保留 1.2% 以便看清。排序用右上角的下拉。';

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
      title="这一行的 token 构成（整条 = 本行 100%）"
    >
      {pieces.map((piece) => {
        const share = total === 0 ? 0 : piece.tokens / total;
        return (
          <span
            key={piece.key}
            className="h-full"
            style={{ width: `${(MIN_SEGMENT + share * scale) * 100}%`, backgroundColor: piece.color }}
            title={`${piece.short} ${piece.label}：${formatTokens(piece.tokens, true)} tokens（占本行 ${formatShare(share)}）· ${formatCost(piece.money, symbol)}`}
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

/**
 * One metric, split across the list — the "who owns this total" view.
 *
 * A horizontal bar per entry, longest first, whose length is that entry's **share
 * of the metric's total**: a full bar means "all of it" in every chart, so the
 * charts stay comparable with each other. The row bars answer "what is this entry
 * made of"; these answer "where does this figure come from".
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
  const valued = entries
    .map((entry) => ({ entry, value: metric.value(entry) }))
    .filter((item) => item.value > 0)
    .sort((left, right) => right.value - left.value);
  const total = valued.reduce((sum, item) => sum + item.value, 0);
  const asMoney = metric.key === 'cost';
  const format = (value: number): string => (asMoney ? formatCost(String(value), symbol) : formatTokens(value, true));
  const shown = valued.slice(0, CHART_ROWS);

  return (
    <div className="rounded-lg border border-line p-3" data-chart={metric.key}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium text-fg">{metric.label}</span>
        <span className="tnum shrink-0 text-[11px] text-faint" title="这个指标的合计">
          {format(total)}
        </span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {shown.length === 0 && <li className="text-[11px] text-faint">这个指标全是 0。</li>}
        {shown.map((item) => {
          const share = total === 0 ? 0 : item.value / total;
          return (
            <li
              key={item.entry.key}
              className="flex items-center gap-2"
              title={`${item.entry.title}：${format(item.value)}（占该指标的 ${formatShare(share)}）`}
            >
              <span className="w-36 shrink-0 truncate text-[11px] text-muted">{item.entry.title}</span>
              <span className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-raised">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${share * 100}%`, backgroundColor: colors.get(item.entry.key) ?? '#8b949e' }}
                />
              </span>
              <span className="tnum w-16 shrink-0 text-right text-[11px] text-fg">{format(item.value)}</span>
              <span className="tnum w-10 shrink-0 text-right text-[11px] text-faint">{formatShare(share)}</span>
            </li>
          );
        })}
      </ul>
      {valued.length > shown.length && (
        <p className="mt-1.5 text-[11px] text-faint">
          其余 {valued.length - shown.length} 项合计 {format(total - shown.reduce((sum, item) => sum + item.value, 0))}
        </p>
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
        每个指标一张横向柱状图：把这个指标在列表所有条目上的值加起来，看「这个总数是谁贡献的」。条长 =
        该条目占这个指标总量的比例（每张图都是「占满 = 全部」），右边是数值与占比；只列前 {CHART_ROWS} 项，
        其余在下面给合计。想知道单个条目自己的构成，看每行的条。
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

/** Every figure a row carries, in the order the chips show them. */
export const SORT_METRICS: SortMetric[] = [
  { key: 'requests', label: 'Q', hint: '请求数', value: (entry) => entry.requests },
  { key: 'input', label: 'I/M', hint: '未命中缓存的输入', value: (entry) => entry.tokens.input },
  { key: 'cacheRead', label: 'I/C', hint: '缓存命中输入', value: (entry) => entry.tokens.cacheRead },
  { key: 'cacheWrite', label: 'I/W', hint: '缓存写入输入', value: (entry) => entry.tokens.cacheWrite, optional: true },
  {
    key: 'output',
    label: 'O',
    hint: '输出（不含思考）',
    value: (entry) => Math.max(0, entry.tokens.output - entry.tokens.reasoning),
  },
  { key: 'reasoning', label: 'R', hint: '思考（输出的一部分，O 里已扣除）', value: (entry) => entry.tokens.reasoning, optional: true },
  { key: 'tokens', label: '总 token', hint: '计费桶 token 合计', value: (entry) => billedTokens(entry.tokens) },
  { key: 'cost', label: '费用', hint: '总费用（缓存命中的钱＝I/C 那一项的钱，不单列）', value: (entry) => Number(entry.cost.total) },
  { key: 'recent', label: '最近', hint: '最后一次计费时间', value: (entry) => entry.lastUsage ?? 0 },
];

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
            <th className="pb-1 text-left font-medium">计费桶</th>
            <th className="pb-1 text-right font-medium">tokens</th>
            <th className="pb-1 text-right font-medium">占比</th>
            <th className="pb-1 text-right font-medium">费用</th>
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
                <span title={bucket.key === 'reasoning' ? '思考是输出的一部分；输出按整笔计价，这里把它拆开看' : bucket.label}>
                  {bucket.key === 'output' ? '输出（不含思考）' : bucket.key === 'reasoning' ? '思考' : bucket.label}
                </span>
                <span className="ml-1 text-[10px] text-faint">{bucket.short}</span>
              </td>
              <td className="tnum py-1 text-right">{formatTokens(tokens[bucket.key], true)}</td>
              <td className="tnum py-1 text-right text-muted">
                {total === 0 ? '—' : formatShare(tokens[bucket.key] / total)}
              </td>
              <td className="tnum py-1 text-right">{formatCost(money[bucket.key] ?? '0', symbol)}</td>
            </tr>
          ))}
          <tr className="border-t border-line font-medium">
            <td className="py-1">合计</td>
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
  emptyText = '当前范围没有数据。',
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
  const [sortKey, setSortKey] = useState(defaultSort);
  const [desc, setDesc] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  /** The per-metric pies stay folded away until the reader asks for them. */
  const [analysis, setAnalysis] = useState(false);

  // A figure that is zero everywhere (no cache writes, no reasoning) is not worth
  // a chip; it appears as soon as one row has one.
  const metrics = SORT_METRICS.filter((metric) => metric.optional !== true || entries.some((entry) => metric.value(entry) > 0));
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
            title="每个指标一张横向柱状图：这个总数是谁贡献的"
          >
            {analysis ? '收起图表' : '图表分析'}
          </button>
          <label className="flex items-center gap-1 text-[11px] text-muted">
            排序
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
            title={desc ? '从多到少' : '从少到多'}
          >
            {desc ? '降序 ↓' : '升序 ↑'}
          </button>
        </>
      }
    >
      {rows.length === 0 || metric === undefined ? (
        <p className="py-8 text-center text-[13px] text-faint">{emptyText}</p>
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
            <div className="grid items-center gap-3" style={{ gridTemplateColumns: grid }}>
              <span />
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
                <span>
                  合计 <span className="tnum text-fg">{formatCost(String(totalCost), symbol)}</span>
                </span>
                <span>
                  <span className="tnum text-fg">{formatTokens(totalTokens, true)}</span> tokens
                </span>
                <span>
                  <span className="tnum text-fg">{formatTokens(totalRequests)}</span> 请求
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
              <span className="text-right text-faint" title="请求数">
                Q
              </span>
              <span className="text-right text-faint" title="计费桶 token 合计">
                总 token
              </span>
              <span className="text-right text-faint" title="总费用，后面的小字是占本列表合计的比例">
                费用
              </span>
            </div>
            <p className="mt-1.5 text-[11px] leading-5 text-faint" title={BAR_RULE}>
              条 = 这一行自己的 token 构成（整条 100%，<span className="text-muted">不表示大小</span>——大小看右边的数字）；
              条下是五个计费桶各自的 tokens 与费用。排序用「排序」下拉，当前是「{metric.label}
              {desc ? '降序' : '升序'}」；点一行展开这一行的全部计费桶。
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
                      <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
                        {metricChips(entry, symbol).map((chip) => (
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
 * Only the five pieces of the pie appear here: the totals (`总 token`, `费用`) are
 * the figures pinned on the right, and cache money is the `I/C` line's money —
 * repeating them beside the chart would say the same number twice.
 */
function metricChips(entry: RankedEntry, symbol: string): MetricChip[] {
  const total = billedTokens(entry.tokens);
  return tokenPieces(entry.tokens, entry.cost)
    .filter((piece) => piece.tokens > 0)
    .map((piece) => ({
      key: piece.key,
      label: piece.short,
      hint: `${piece.label}：${formatTokens(piece.tokens, true)} tokens · ${formatCost(piece.money, symbol)}`,
      value: formatTokens(piece.tokens, true),
      ...(piece.key === 'cacheRead' && total > 0 ? { extra: formatShare(piece.tokens / total) } : {}),
      money: formatCost(piece.money, symbol),
      color: piece.color,
    }));
}

/** The agents of a scope, as a ranking. */
export function AgentBoard({
  agents,
  symbol,
  title = 'agent',
}: {
  agents: readonly AgentTotals[];
  symbol: string;
  title?: string;
}): React.ReactElement {
  const entries: RankedEntry[] = agents.map((agent) => ({
    key: agent.id,
    title: agent.label,
    badges: <AgentBadge id={agent.id} />,
    subtitle: agent.source,
    counts: `${agent.sessions} 会话 · ${agent.subagentSessions} 子代理`,
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
      emptyText="当前范围没有被读到的 agent。"
      footnote="点一行展开这个 agent 的每个计费桶；费用都是它自己产生的。"
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
          subtitle: project.kind === 'repo' ? `git 仓库 · ${project.workspaces.length} 个工作区` : project.workspaces[0],
          counts: `${project.sessions} 会话（子 ${project.subagentSessions}）`,
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
                    自身 <span className="tnum text-fg">{formatCost(project.own.cost.total, symbol)}</span>
                  </div>
                  <div>
                    子代理 <span className="tnum text-fg">{formatCost(project.spawned.cost.total, symbol)}</span>
                  </div>
                  <div>{project.workspaces.length} 个工作区</div>
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
          counts: `${workspace.sessionCount} 会话（子 ${workspace.subagentCount}）`,
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
      emptyText="当前范围没有项目。"
      footnote={
        projects === undefined
          ? '点一行展开这个工作区的每个计费桶；费用都是它自己产生的。'
          : '点一行展开这个项目的每个计费桶；点名字进入项目页。'
      }
    />
  );
}
