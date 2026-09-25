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
import { BUCKETS, bucketMoney } from './Metrics';

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
export interface Measure {
  key: string;
  label: string;
  hint: string;
  /** The comparable value. */
  value: (entry: RankedEntry) => number;
  /** Which column the current sort is on: `requests`, `tokens`, `cost` or none. */
  column?: 'requests' | 'tokens' | 'cost';
}

/** The billed-bucket total, which is what `T` means everywhere else. */
export function billedTokens(tokens: TokenBuckets): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
}

/** The measures every entity shares: money, tokens, requests, recency. */
export const COMMON_MEASURES: Measure[] = [
  { key: 'cost', label: '花费', hint: '按总费用', value: (entry) => Number(entry.cost.total), column: 'cost' },
  { key: 'tokens', label: 'tokens', hint: '按计费桶 token 总数', value: (entry) => billedTokens(entry.tokens), column: 'tokens' },
  { key: 'requests', label: '请求', hint: '按请求数', value: (entry) => entry.requests, column: 'requests' },
  { key: 'recent', label: '最近', hint: '按最后一次计费时间', value: (entry) => entry.lastUsage ?? 0 },
];

/**
 * The row grid: rank, the bar block, then the three figures — same template for
 * the header and every row, so the numbers line up down the column.
 */
const ROW_GRID = 'grid grid-cols-[1.5rem_minmax(0,1fr)_4.5rem_6rem_9rem] gap-3';

/**
 * A stacked composition bar that stays readable when one bucket dominates.
 *
 * Each non-zero bucket keeps at least {@link MIN_SEGMENT} of the width, so a
 * bucket worth 0.2% of the tokens is still a visible sliver instead of nothing —
 * the honest reading ("cache-hit input is almost all of it") is carried by the
 * chips beside the bar, not by a bar that looks monochrome.
 */
const MIN_SEGMENT = 0.012;

/** The buckets a row actually used, in display order. */
function usedBuckets(tokens: TokenBuckets): typeof BUCKETS {
  return BUCKETS.filter((bucket) => tokens[bucket.key] > 0);
}

/** The composition bar plus the chips that name every bucket it drew. */
function CompositionBar({
  tokens,
  cost,
  symbol,
  weight,
}: {
  tokens: TokenBuckets;
  cost: CostTotals;
  symbol: string;
  /** How long the whole bar is, 0…1, relative to the biggest row. */
  weight: number;
}): React.ReactElement {
  const total = billedTokens(tokens);
  const used = usedBuckets(tokens);
  // A bucket that is present but tiny keeps a visible sliver; the rest share what
  // is left, so the bar still adds up to the row's weight.
  const floors = used.length * MIN_SEGMENT;
  const scale = weight <= floors ? MIN_SEGMENT : (weight - floors) / (1 - floors);
  const money = bucketMoney(tokens, cost);
  return (
    <span className="flex h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-raised">
      {used.map((bucket) => {
        const share = total === 0 ? 0 : tokens[bucket.key] / total;
        const width = MIN_SEGMENT + share * scale * (1 - floors);
        return (
          <span
            key={bucket.key}
            className="h-full"
            style={{ width: `${width * 100}%`, backgroundColor: bucket.color }}
            title={`${bucket.short} ${bucket.label}：${formatTokens(tokens[bucket.key], true)} tokens（${formatShare(share)}）· ${formatCost(money[bucket.key] ?? '0', symbol)}`}
          />
        );
      })}
    </span>
  );
}

/**
 * The chips under a bar: the four billed buckets, each with its value.
 *
 * The cache-hit share goes right after `I/C` (it is a property of that bucket),
 * and reasoning is left out on purpose — it is part of output, so a fifth chip
 * would read as a fifth billable bucket. It has a row of its own in the expanded
 * detail.
 */
function BucketChips({ tokens }: { tokens: TokenBuckets }): React.ReactElement {
  const total = billedTokens(tokens);
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
      {BUCKETS.filter((bucket) => bucket.key !== 'reasoning' && tokens[bucket.key] > 0).map((bucket) => (
        <span key={bucket.key} className="flex items-center gap-1 whitespace-nowrap">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: bucket.color }} />
          <span className="text-faint" title={bucket.label}>
            {bucket.short}
          </span>
          <span className="tnum text-muted">{formatTokens(tokens[bucket.key], true)}</span>
          {bucket.key === 'cacheRead' && total > 0 && (
            <span className="tnum text-faint" title="缓存命中占全部计费桶的比例">
              {formatShare(tokens.cacheRead / total)}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

/**
 * How the bar is drawn, in one sentence — a picture that cannot be explained is a
 * picture that cannot be trusted.
 *
 * Note what the length is *not*: it is not the row's share of the totals. It is
 * the row's value on the current measure divided by the largest row's, so the
 * biggest entry fills the column and the rest are read against it. The share of
 * the totals is the small percentage beside the money.
 */
const BAR_RULE =
  '条长 = 这一行的「当前排序指标」÷ 列表里最大那一行的同一个指标（最大的那行占满）；不是占合计的比例——占合计的比例写在费用后面的小字里。分段 = 这一行自己的四个计费桶构成（I/M、I/C、I/W、O，按 token 占比），每段不足 1.2% 时保留 1.2%。';

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
 * The leaderboard itself: one row per entry, ranked by the chosen measure.
 *
 * @param props - the entries, the measures, and how to draw an expanded row.
 */
export function RankedList({
  entries,
  symbol,
  title,
  measures = COMMON_MEASURES,
  defaultMeasure,
  emptyText = '当前范围没有数据。',
  baseline,
  footnote,
  limit,
}: {
  entries: readonly RankedEntry[];
  symbol: string;
  title: string;
  measures?: readonly Measure[];
  defaultMeasure?: string | undefined;
  emptyText?: string;
  /** An extra control in the header (filters, toggles). */
  baseline?: ReactNode;
  footnote?: ReactNode;
  /** Draw only the first N rows. */
  limit?: number | undefined;
}): React.ReactElement {
  const [measureKey, setMeasureKey] = useState(defaultMeasure ?? measures[0]?.key ?? 'cost');
  const [desc, setDesc] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const measure = measures.find((entry) => entry.key === measureKey) ?? measures[0];

  const rows = useMemo(() => {
    if (measure === undefined) return [];
    const sorted = [...entries].sort((left, right) => (desc ? -1 : 1) * (measure.value(left) - measure.value(right)));
    return limit === undefined ? sorted : sorted.slice(0, limit);
  }, [entries, measure, desc, limit]);

  const max = rows.reduce((highest, entry) => (measure === undefined ? 0 : Math.max(highest, measure.value(entry))), 0);
  const totalCost = rows.reduce((sum, entry) => sum + Number(entry.cost.total), 0);

  return (
    <Card
      title={`${title}（${rows.length}）`}
      actions={
        <>
          {baseline}
          <div className="flex overflow-hidden rounded border border-line">
            {measures.map((option) => (
              <button
                key={option.key}
                type="button"
                title={option.hint}
                onClick={() => setMeasureKey(option.key)}
                className={`px-2 py-0.5 text-[11px] ${measureKey === option.key ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}
              >
                {option.label}
              </button>
            ))}
          </div>
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
      {rows.length === 0 || measure === undefined ? (
        <p className="py-8 text-center text-[13px] text-faint">{emptyText}</p>
      ) : (
        <>
          {/* The baseline, and the labels for the three columns every row ends with. */}
          <div className="mb-1 border-b border-line pb-2 text-[12px] text-faint">
            <div className={`${ROW_GRID} items-center`}>
              <span />
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                  合计 <span className="tnum text-fg">{formatCost(String(totalCost), symbol)}</span>
                </span>
                <span>
                  <span className="tnum text-fg">
                    {formatTokens(rows.reduce((sum, entry) => sum + billedTokens(entry.tokens), 0), true)}
                  </span>{' '}
                  tokens
                </span>
                <span>
                  <span className="tnum text-fg">{formatTokens(rows.reduce((sum, entry) => sum + entry.requests, 0))}</span> 请求
                </span>
                <span className="flex flex-wrap items-center gap-x-3">
                  {BUCKETS.filter((bucket) => bucket.key !== 'reasoning').map((bucket) => (
                    <span key={bucket.key} className="flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: bucket.color }} />
                      {bucket.short}
                    </span>
                  ))}
                  <span className="text-[11px] text-faint" title={BAR_RULE}>
                    ⓘ 条的算法
                  </span>
                </span>
              </span>
              <span className={`text-right ${measure.column === 'requests' ? 'text-accent' : ''}`} title="请求数">
                Q
              </span>
              <span className={`text-right ${measure.column === 'tokens' ? 'text-accent' : ''}`} title="计费桶 token 合计">
                总 token
              </span>
              <span className={`text-right ${measure.column === 'cost' ? 'text-accent' : ''}`} title="费用，后面的小字是占本列表合计的比例">
                费用
              </span>
            </div>
          </div>

          <ol className="divide-y divide-line">
            {rows.map((entry, index) => {
              const expanded = open === entry.key;
              const weight = max === 0 ? 0 : measure.value(entry) / max;
              return (
                <li key={entry.key}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setOpen(expanded ? null : entry.key)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') setOpen(expanded ? null : entry.key);
                    }}
                    className={`${ROW_GRID} cursor-pointer items-center px-1 py-2.5 hover:bg-raised ${expanded ? 'bg-raised' : ''}`}
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
                        {/* Sorted by recency, the date has to be visible. */}
                        {measure.key === 'recent' && entry.lastUsage != null && (
                          <span className="shrink-0 text-[11px] text-muted">{formatInstant(entry.lastUsage)}</span>
                        )}
                      </span>
                      <span className="mt-1.5 flex items-center gap-3">
                        <CompositionBar tokens={entry.tokens} cost={entry.cost} symbol={symbol} weight={weight} />
                      </span>
                      <span className="mt-1 block">
                        <BucketChips tokens={entry.tokens} />
                      </span>
                    </span>
                    <span className={`tnum text-right text-[13px] ${measure.column === 'requests' ? 'font-medium text-accent' : 'text-fg'}`}>
                      {formatTokens(entry.requests)}
                    </span>
                    <span className={`tnum text-right text-[13px] ${measure.column === 'tokens' ? 'font-medium text-accent' : 'text-fg'}`}>
                      {formatTokens(billedTokens(entry.tokens), true)}
                    </span>
                    <span className="tnum text-right text-[13px]">
                      <span className={measure.column === 'cost' ? 'font-medium text-accent' : 'text-fg'}>
                        {formatCost(entry.cost.total, symbol)}
                      </span>
                      {totalCost > 0 && (
                        <span className="ml-1.5 text-[11px] text-faint">
                          {formatShare(Number(entry.cost.total) / totalCost)}
                        </span>
                      )}
                    </span>
                  </div>
                  {expanded && (
                    <div className="px-1 pb-3">
                      {entry.children ?? (
                        <BucketDetail tokens={entry.tokens} cost={entry.cost} symbol={symbol} />
                      )}
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
