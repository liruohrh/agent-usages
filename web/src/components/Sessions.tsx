/**
 * The session comparison, as a leaderboard instead of a wide table.
 *
 * A session carries ten figures, and a thirteen-column table is not how a reader
 * compares them: the eye cannot subtract `9.7亿` from `4.6亿` across rows. Here
 * each session is one row with a composition bar whose *length* is the measure
 * being sorted on and whose *segments* are the buckets — so "which session, and
 * where did it go" is answered by shape, and the exact numbers are one click away
 * (an expanding detail, or the table view for anyone who prefers columns).
 *
 * Sorting is a segmented control: 花费 / tokens / 缓存金额 / 请求 / 最后使用, with a
 * direction toggle. Rank numbers make the order obvious at a glance.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import type { SessionNode } from '../types';
import { formatCost, formatInstant, formatShare, formatTokens, shortenPath } from '../format';
import { AgentBadge, Card, Chip } from './Bits';
import { BUCKETS, bucketMoney } from './Metrics';
import { SessionTable } from './Tables';

/** What the leaderboard can be ordered by. */
type Measure = 'cost' | 'tokens' | 'cacheCost' | 'requests' | 'lastUsage';

/** The measures, in the order the buttons show them. */
const MEASURES: { key: Measure; label: string; hint: string }[] = [
  { key: 'cost', label: '花费', hint: '按这个会话的总费用' },
  { key: 'tokens', label: 'tokens', hint: '按计费桶 token 总数' },
  { key: 'cacheCost', label: '缓存金额', hint: '按缓存命中这条计费项的钱' },
  { key: 'requests', label: '请求', hint: '按请求数' },
  { key: 'lastUsage', label: '最近', hint: '按最后一次计费时间' },
];

/** The billed-bucket total, which is what `T` means everywhere else. */
function billed(tokens: SessionNode['tokens']): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
}

/** The value a measure sorts and draws on. */
function valueOf(session: SessionNode, measure: Measure): number {
  switch (measure) {
    case 'cost':
      return Number(session.cost.total);
    case 'tokens':
      return billed(session.tokens);
    case 'cacheCost':
      return Number(session.cost.cacheHitInputCost);
    case 'requests':
      return session.requests;
    case 'lastUsage':
      return session.lastUsage ?? 0;
  }
}

/** How a row's headline number reads, per measure. */
function headline(session: SessionNode, measure: Measure, symbol: string): string {
  switch (measure) {
    case 'tokens':
      return `${formatTokens(billed(session.tokens), true)} tokens`;
    case 'cacheCost':
      return `${formatCost(session.cost.cacheHitInputCost, symbol)} 缓存`;
    case 'requests':
      return `${formatTokens(session.requests)} 请求`;
    case 'lastUsage':
      return formatInstant(session.lastUsage);
    case 'cost':
      return formatCost(session.cost.total, symbol);
  }
}

/**
 * Every session, ranked by the measure the reader picked.
 *
 * @param props - the sessions to rank, the currency symbol and the scope flags.
 */
export function SessionLeaderboard({
  sessions,
  symbol,
  showProject = false,
  limit = 500,
  title = '会话',
}: {
  sessions: readonly SessionNode[];
  symbol: string;
  /** Name the project on each row: set when the rows come from every project. */
  showProject?: boolean;
  /** How many rows to draw. */
  limit?: number;
  title?: string;
}): React.ReactElement {
  const [measure, setMeasure] = useState<Measure>('cost');
  const [desc, setDesc] = useState(true);
  const [flat, setFlat] = useState(false);
  const [view, setView] = useState<'bars' | 'table'>('bars');
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => {
    const ids = new Set(sessions.map((session) => session.id));
    const kept = flat
      ? [...sessions]
      : sessions.filter((session) => !(session.isSubagent && session.parentId !== null && ids.has(session.parentId)));
    return kept
      .sort((left, right) => (desc ? -1 : 1) * (valueOf(left, measure) - valueOf(right, measure)))
      .slice(0, limit);
  }, [sessions, flat, measure, desc, limit]);

  const totalCost = rows.reduce((sum, session) => sum + Number(session.cost.total), 0);
  const max = rows.reduce((highest, session) => Math.max(highest, valueOf(session, measure)), 0);
  const totalTokens = rows.reduce((sum, session) => sum + billed(session.tokens), 0);
  const totalRequests = rows.reduce((sum, session) => sum + session.requests, 0);

  return (
    <Card
      title={`${title}（${rows.length}）`}
      actions={
        <>
          <div className="flex overflow-hidden rounded border border-line">
            {MEASURES.map((option) => (
              <button
                key={option.key}
                type="button"
                title={option.hint}
                onClick={() => setMeasure(option.key)}
                className={`px-2 py-0.5 text-[11px] ${measure === option.key ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}
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
          <button
            type="button"
            onClick={() => setView((value) => (value === 'bars' ? 'table' : 'bars'))}
            className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
            title="切换排行榜 / 表格"
          >
            {view === 'bars' ? '表格视图' : '排行榜'}
          </button>
          <button
            type="button"
            onClick={() => setFlat((value) => !value)}
            className={`rounded border px-2 py-0.5 text-[11px] ${flat ? 'border-accent/50 bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}
            title="把子代理也单独列出（默认并入其父会话）"
          >
            {flat ? '含子代理' : '合并子代理'}
          </button>
        </>
      }
    >
      {view === 'table' ? (
        <SessionTable sessions={sessions} symbol={symbol} showProject={showProject} limit={limit} title={title} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-faint">当前范围没有会话。</p>
      ) : (
        <>
          {/* The baseline for every comparison below. */}
          <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line pb-3 text-[12px] text-faint">
            <span>
              合计 <span className="tnum text-fg">{formatCost(String(totalCost), symbol)}</span>
            </span>
            <span>
              <span className="tnum text-fg">{formatTokens(totalTokens, true)}</span> tokens
            </span>
            <span>
              <span className="tnum text-fg">{formatTokens(totalRequests)}</span> 请求
            </span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {BUCKETS.filter((bucket) => bucket.key !== 'reasoning').map((bucket) => (
                <span key={bucket.key} className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: bucket.color }} />
                  {bucket.short}
                </span>
              ))}
              <span className="text-faint">（条形按占比着色，长度 = 当前排序指标）</span>
            </span>
          </div>

          <ol className="divide-y divide-line">
            {rows.map((session, index) => {
              const expanded = open === session.uid;
              const drawn = max === 0 ? 0 : valueOf(session, measure) / max;
              const buckets = BUCKETS.filter(
                (bucket) =>
                  bucket.key !== 'reasoning' &&
                  !(bucket.key === 'cacheWrite' && session.tokens.cacheWrite === 0) &&
                  !(bucket.key === 'input' && session.tokens.input === 0),
              );
              const perBucket = billed(session.tokens);
              return (
                <li key={session.uid}>
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : session.uid)}
                    className={`flex w-full items-center gap-3 px-1 py-2.5 text-left hover:bg-raised ${expanded ? 'bg-raised' : ''}`}
                  >
                    <span className="tnum w-6 shrink-0 text-right text-[11px] text-faint">{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="cell-title text-[13px] text-fg" title={session.title ?? session.id}>
                          {session.title ?? `（无标题）${session.id.slice(0, 8)}`}
                        </span>
                        <AgentBadge id={session.agent} small />
                        {session.subagentCount > 0 && <Chip tone="muted">{session.subagentCount} 子</Chip>}
                        {showProject && (
                          <span className="min-w-0 truncate text-[11px] text-faint" title={session.projectName}>
                            {session.projectName}
                          </span>
                        )}
                        {!showProject && (
                          <span className="min-w-0 truncate text-[11px] text-faint" title={session.workspace}>
                            {shortenPath(session.workspace, 32)}
                          </span>
                        )}
                      </span>
                      <span className="mt-1.5 flex items-center gap-3">
                        <span className="flex h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-raised">
                          {buckets.map((bucket) => {
                            const share = perBucket === 0 ? 0 : session.tokens[bucket.key] / perBucket;
                            if (share <= 0) return null;
                            const money = bucketMoney(session.tokens, session.cost)[bucket.key] ?? '0';
                            return (
                              <span
                                key={bucket.key}
                                className="h-full"
                                style={{
                                  width: `${share * 100 * drawn}%`,
                                  backgroundColor: bucket.color,
                                  opacity: 0.55 + 0.45 * drawn,
                                }}
                                title={`${bucket.short} ${bucket.label}：${formatTokens(session.tokens[bucket.key], true)} tokens（${formatShare(share)}）· ${formatCost(money, symbol)}`}
                              />
                            );
                          })}
                        </span>
                        <span className="tnum w-[15rem] shrink-0 text-right text-[11px] text-faint">
                          <span title="请求数">Q {formatTokens(session.requests)}</span>
                          <span className="mx-1">·</span>
                          <span title="缓存命中输入">缓存 {formatTokens(session.tokens.cacheRead, true)}</span>
                          <span className="mx-1">·</span>
                          <span title="缓存命中率">
                            {perBucket === 0 ? '—' : formatShare(session.tokens.cacheRead / perBucket)}
                          </span>
                        </span>
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className={`tnum block text-[14px] ${measure === 'cost' ? 'font-medium text-accent' : 'text-fg'}`}>
                        {headline(session, measure, symbol)}
                      </span>
                      <span className="tnum block text-[11px] text-faint">
                        {measure === 'cost'
                          ? `T ${formatTokens(billed(session.tokens), true)}`
                          : formatCost(session.cost.total, symbol)}
                        {totalCost > 0 && measure === 'cost' && ` · ${formatShare(Number(session.cost.total) / totalCost)}`}
                      </span>
                    </span>
                  </button>

                  {expanded && (
                    <div className="mb-3 grid grid-cols-1 gap-3 rounded-lg border border-line bg-panel p-3 lg:grid-cols-[1fr_16rem]">
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
                          {BUCKETS.filter(
                            (bucket) =>
                              bucket.key !== 'reasoning' ||
                              session.tokens.reasoning > 0 ||
                              Number(session.cost.reasoningCost) > 0,
                          ).map((bucket) => {
                            const share = perBucket === 0 ? 0 : session.tokens[bucket.key] / perBucket;
                            const money = bucketMoney(session.tokens, session.cost)[bucket.key] ?? '0';
                            return (
                              <tr key={bucket.key} className="border-t border-line">
                                <td className="py-1">
                                  <span
                                    className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle"
                                    style={{ backgroundColor: bucket.color }}
                                  />
                                  {bucket.label}
                                  <span className="ml-1 text-[10px] text-faint">{bucket.short}</span>
                                </td>
                                <td className="tnum py-1 text-right">{formatTokens(session.tokens[bucket.key], true)}</td>
                                <td className="tnum py-1 text-right text-muted">{formatShare(share)}</td>
                                <td className="tnum py-1 text-right">{formatCost(money, symbol)}</td>
                              </tr>
                            );
                          })}
                          <tr className="border-t border-line font-medium">
                            <td className="py-1">合计</td>
                            <td className="tnum py-1 text-right">{formatTokens(perBucket, true)}</td>
                            <td className="py-1 text-right text-faint">100%</td>
                            <td className="tnum py-1 text-right text-accent">{formatCost(session.cost.total, symbol)}</td>
                          </tr>
                        </tbody>
                      </table>
                      <div className="space-y-1.5 text-[12px] text-muted">
                        <div>
                          首次 <span className="text-fg">{formatInstant(session.firstUsage)}</span>
                        </div>
                        <div>
                          最后 <span className="text-fg">{formatInstant(session.lastUsage)}</span>
                        </div>
                        <div>
                          自身 <span className="tnum text-fg">{formatCost(session.own.cost.total, symbol)}</span> · 子代理{' '}
                          <span className="tnum text-fg">{formatCost(session.spawned.cost.total, symbol)}</span>
                        </div>
                        <div>
                          缓存命中金额 <span className="tnum text-fg">{formatCost(session.cost.cacheHitInputCost, symbol)}</span>
                        </div>
                        <Link
                          to={`/s/${encodeURIComponent(session.uid)}`}
                          className="inline-block text-accent hover:underline"
                        >
                          打开会话详情 →
                        </Link>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-[11px] text-faint">
            共 {rows.length} 个会话（{flat ? '含子代理，行之间会重复计算' : '每行是一个委派子树的根：自身 + 它派生的全部'}）；
            点一行展开该会话的全部计费桶与金额。
          </p>
        </>
      )}
    </Card>
  );
}
