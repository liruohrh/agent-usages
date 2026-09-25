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
export interface RankedColumn {
  key: string;
  label: string;
  hint: string;
  /** The comparable number. */
  value: (entry: RankedEntry) => number;
  /** What the cell shows. */
  render: (entry: RankedEntry, symbol: string) => ReactNode;
  /** Column width in the row grid. */
  width: string;
  /** Drawn only when at least one row has a non-zero value. */
  optional?: boolean;
}

/** The billed-bucket total, which is what `T` means everywhere else. */
export function billedTokens(tokens: TokenBuckets): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
}

/**
 * The columns every entity shares, in the order they are drawn.
 *
 * Every one of them is sortable: the figures a ranking is compared on are Q, each
 * bucket, the token total, the cache money and the money — and the reader picks
 * which one orders the list by clicking its header.
 */
export const COMMON_COLUMNS: RankedColumn[] = [
  {
    key: 'requests',
    label: 'Q',
    hint: '请求数',
    width: '4.5rem',
    value: (entry) => entry.requests,
    render: (entry) => formatTokens(entry.requests),
  },
  {
    key: 'input',
    label: 'I/M',
    hint: '未命中缓存的输入',
    width: '5rem',
    value: (entry) => entry.tokens.input,
    render: (entry) => formatTokens(entry.tokens.input, true),
  },
  {
    key: 'cacheRead',
    label: 'I/C',
    hint: '缓存命中输入（tokens），括号里是它在本行的占比',
    width: '6.5rem',
    value: (entry) => entry.tokens.cacheRead,
    render: (entry) => (
      <>
        {formatTokens(entry.tokens.cacheRead, true)}
        {billedTokens(entry.tokens) > 0 && (
          <span className="ml-1 text-[11px] text-faint">
            {formatShare(entry.tokens.cacheRead / billedTokens(entry.tokens))}
          </span>
        )}
      </>
    ),
  },
  {
    key: 'cacheWrite',
    label: 'I/W',
    hint: '缓存写入输入',
    width: '5rem',
    optional: true,
    value: (entry) => entry.tokens.cacheWrite,
    render: (entry) => formatTokens(entry.tokens.cacheWrite, true),
  },
  {
    key: 'output',
    label: 'O',
    hint: '输出（不含思考）',
    width: '5rem',
    value: (entry) => Math.max(0, entry.tokens.output - entry.tokens.reasoning),
    render: (entry) => formatTokens(Math.max(0, entry.tokens.output - entry.tokens.reasoning), true),
  },
  {
    key: 'reasoning',
    label: 'R',
    hint: '思考（输出的一部分，O 里已扣除）',
    width: '4.5rem',
    optional: true,
    value: (entry) => entry.tokens.reasoning,
    render: (entry) => formatTokens(entry.tokens.reasoning, true),
  },
  {
    key: 'tokens',
    label: '总 token',
    hint: '计费桶 token 合计 = I/M + I/C + I/W + O + R',
    width: '6rem',
    value: (entry) => billedTokens(entry.tokens),
    render: (entry) => formatTokens(billedTokens(entry.tokens), true),
  },
  {
    key: 'cacheCost',
    label: '缓存金额',
    hint: '缓存命中这条计费项花掉的钱',
    width: '6.5rem',
    value: (entry) => Number(entry.cost.cacheHitInputCost),
    render: (entry, symbol) => formatCost(entry.cost.cacheHitInputCost, symbol),
  },
  {
    key: 'cost',
    label: '费用',
    hint: '总费用，后面小字是占本列表合计的比例',
    width: '9rem',
    value: (entry) => Number(entry.cost.total),
    render: (entry, symbol) => <>{formatCost(entry.cost.total, symbol)}</>,
  },
];

/**
 * What this row is made of: its own tokens, bucket by bucket.
 *
 * Always the full width, because the question here is composition, not size —
 * mixing the two in one bar is what made the old one unreadable (a segment was
 * `share × length`, a number that means nothing). Every non-zero bucket keeps at
 * least {@link MIN_SEGMENT} of the width, so a bucket worth 0.2% is still visible
 * rather than crushed to nothing by the 99.5% next to it.
 */
const MIN_SEGMENT = 0.012;

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
  // Five disjoint pieces: cache write and reasoning show up whenever the provider
  // reported them (`O` is output without reasoning, so nothing is counted twice).
  const pieces = tokenPieces(tokens, cost).filter((piece) => piece.tokens > 0);
  const floors = pieces.length * MIN_SEGMENT;
  const scale = pieces.length === 0 ? 0 : 1 - floors;
  return (
    <span className="flex h-3 w-full overflow-hidden rounded-full bg-raised" title="这一行的 token 构成（整条 = 本行 100%）">
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
 * What the bar means, said once, in the header.
 *
 * It is the row's *own* composition and nothing else: always the full width,
 * because size is what the numbers and the sort are for. Drawing size and
 * composition in one bar made every segment the product of two unrelated things.
 */
const BAR_RULE =
  '每行的条就是这一行自己：把它的 token 按计费桶切开（I/M、I/C、I/W、O、R，互不重叠），整条 = 这一行的 100%。它不表示大小——大小看右边的数字与排序。某项为 0 时不画；某段不足 1.2% 时保留 1.2% 以便看清。';

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
 * The leaderboard itself: one row per entry, an order picked by clicking a column
 * header, and a bar per row that shows only that row's own composition.
 *
 * @param props - the entries, the columns, and how to draw an expanded row.
 */
export function RankedList({
  entries,
  symbol,
  title,
  columns = COMMON_COLUMNS,
  defaultSort = 'cost',
  emptyText = '当前范围没有数据。',
  baseline,
  footnote,
  limit,
}: {
  entries: readonly RankedEntry[];
  symbol: string;
  title: string;
  columns?: readonly RankedColumn[];
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

  // A column whose value is zero everywhere (no cache writes, no reasoning) is a
  // column of dashes: it appears as soon as one row has one.
  const shown = columns.filter(
    (column) => column.optional !== true || entries.some((entry) => column.value(entry) > 0),
  );
  const sortColumn = shown.find((column) => column.key === sortKey) ?? shown[0];

  const rows = useMemo(() => {
    if (sortColumn === undefined) return [];
    const sorted = [...entries].sort(
      (left, right) => (desc ? -1 : 1) * (sortColumn.value(left) - sortColumn.value(right)),
    );
    return limit === undefined ? sorted : sorted.slice(0, limit);
  }, [entries, sortColumn, desc, limit]);

  const totalCost = rows.reduce((sum, entry) => sum + Number(entry.cost.total), 0);
  const totalRequests = rows.reduce((sum, entry) => sum + entry.requests, 0);
  const totalTokens = rows.reduce((sum, entry) => sum + billedTokens(entry.tokens), 0);
  const grid = `1.5rem minmax(14rem, 1fr) ${shown.map((column) => column.width).join(' ')}`;

  /** Sort by a column, flipping the direction when it is already the sort. */
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
      {rows.length === 0 || sortColumn === undefined ? (
        <p className="py-8 text-center text-[13px] text-faint">{emptyText}</p>
      ) : (
        <>
          {/* The baseline, then the sortable headers. */}
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
                <span className="flex flex-wrap items-center gap-x-3">
                  {BUCKETS.map((piece) => (
                    <span key={piece.key} className="flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: piece.color }} />
                      {piece.short}
                    </span>
                  ))}
                </span>
              </span>
              {shown.map((column) => (
                <button
                  key={column.key}
                  type="button"
                  onClick={() => sortBy(column.key)}
                  title={`${column.hint}（点击排序）`}
                  className={`whitespace-nowrap text-right hover:text-fg ${
                    column.key === sortKey ? 'font-medium text-accent' : 'text-faint'
                  }`}
                >
                  {column.label} <span className="text-[9px]">{column.key === sortKey ? (desc ? '▼' : '▲') : '↕'}</span>
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-5 text-faint" title={BAR_RULE}>
              条 = 这一行自己的 token 构成（整条 100%，<span className="text-muted">不表示大小</span>）；
              每个指标都能排序：<span className="text-muted">点表头</span>升/降序。大小看数字。
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
                      <span className="mt-1.5 block">
                        <CompositionBar tokens={entry.tokens} cost={entry.cost} symbol={symbol} />
                      </span>
                    </span>
                    {shown.map((column) => (
                      <span
                        key={column.key}
                        className={`tnum whitespace-nowrap text-right text-[13px] ${
                          column.key === sortKey ? 'font-medium text-accent' : 'text-fg'
                        }`}
                      >
                        {column.render(entry, symbol)}
                      </span>
                    ))}
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
