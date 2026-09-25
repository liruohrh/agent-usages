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
 * because size is what the numbers and the sort are for. Drawing size and
 * composition in one bar made every segment the product of two unrelated things.
 */
const BAR_RULE =
  '条 = 这一行自己的 token 构成：按五个互不重叠的计费项切开（I/M、I/C、I/W、O、R），整条 = 这一行的 100%。某项为 0 时不画；某段不足 1.2% 时保留 1.2% 以便看清。条下的每个数字都能点，点谁按谁排序。';

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
      className="flex h-4 w-full overflow-hidden rounded-full bg-raised ring-1 ring-line ring-inset"
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
  {
    key: 'cacheCost',
    label: '缓存金额',
    hint: '缓存命中这条计费项花掉的钱',
    value: (entry) => Number(entry.cost.cacheHitInputCost),
  },
  { key: 'cost', label: '费用', hint: '总费用', value: (entry) => Number(entry.cost.total) },
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
            <th className="pb-1 text-right font-medium">金额</th>
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

  const sortBy = (key: string): void => {
    if (key === sortKey) setDesc((value) => !value);
    else {
      setSortKey(key);
      setDesc(true);
    }
  };

  return (
    <Card
      title={`${title}（${rows.length}）`}
      actions={
        <>
          {baseline}
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
              条 = 这一行自己的 token 构成（整条 100%，<span className="text-muted">不表示大小</span>，大小看数字）；
              条下每个指标都能点，点谁按谁排序，当前排序是「{metric.label} {desc ? '降序' : '升序'}」。
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

                      {/* The bar: this row's own composition, and nothing else. */}
                      <span className="mt-1.5 block">
                        <CompositionBar tokens={entry.tokens} cost={entry.cost} symbol={symbol} />
                      </span>

                      {/* Every figure, under the bar; click one to order by it. */}
                      <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                        {metricChips(entry, symbol).map((chip) => (
                          <button
                            key={chip.key}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              sortBy(chip.key);
                            }}
                            title={chip.hint}
                            className={`flex items-center gap-1 whitespace-nowrap rounded px-1 text-[11px] hover:bg-raised ${
                              chip.key === sortKey ? 'bg-accent-soft text-accent' : ''
                            }`}
                          >
                            {chip.color !== undefined && (
                              <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: chip.color }} />
                            )}
                            <span className={chip.key === sortKey ? '' : 'text-faint'}>{chip.label}</span>
                            <span className={`tnum ${chip.key === sortKey ? 'text-accent' : 'text-muted'}`}>{chip.value}</span>
                            {chip.extra !== undefined && <span className="tnum text-faint">{chip.extra}</span>}
                            {chip.key === sortKey && <span className="text-[9px]">{desc ? '▼' : '▲'}</span>}
                          </button>
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

/** One clickable figure under a bar. */
interface MetricChip {
  key: string;
  label: string;
  hint: string;
  value: string;
  extra?: string | undefined;
  color?: string | undefined;
}

/**
 * The figures under a row's bar, in the CLI's order.
 *
 * The five buckets the bar is made of come first (each with the colour it is drawn
 * in), then the totals; `I/C` carries its share, `费用` carries its share of the
 * list. Zero-valued pieces are left out — the bar does not draw them either.
 */
function metricChips(entry: RankedEntry, symbol: string): MetricChip[] {
  const total = billedTokens(entry.tokens);
  const chips: MetricChip[] = tokenPieces(entry.tokens, entry.cost)
    .filter((piece) => piece.tokens > 0)
    .map((piece) => ({
      key: piece.key,
      label: piece.short,
      hint: `${piece.label}：${formatTokens(piece.tokens, true)} tokens · ${formatCost(piece.money, symbol)}（点击按它排序）`,
      value: formatTokens(piece.tokens, true),
      ...(piece.key === 'cacheRead' && total > 0 ? { extra: formatShare(piece.tokens / total) } : {}),
      color: piece.color,
    }));
  chips.push(
    {
      key: 'tokens',
      label: '总 token',
      hint: '计费桶 token 合计（点击按它排序）',
      value: formatTokens(total, true),
    },
    {
      key: 'cacheCost',
      label: '缓存金额',
      hint: '缓存命中这条计费项花掉的钱（点击按它排序）',
      value: formatCost(entry.cost.cacheHitInputCost, symbol),
    },
    {
      key: 'cost',
      label: '费用',
      hint: '总费用（点击按它排序）',
      value: formatCost(entry.cost.total, symbol),
    },
  );
  return chips;
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
      footnote="点一行展开这个 agent 的每个计费桶；金额都是它自己产生的。"
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
          ? '点一行展开这个工作区的每个计费桶；金额都是它自己产生的。'
          : '点一行展开这个项目的每个计费桶；点名字进入项目页。'
      }
    />
  );
}
