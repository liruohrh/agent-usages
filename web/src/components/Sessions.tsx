/**
 * The session ranking: the same leaderboard as projects and agents, with the two
 * measures that only sessions have (cache money) and the two controls that only
 * sessions need (fold subagents, switch to the column view).
 */

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { SessionNode } from '../types';
import { formatCost, formatInstant, formatShare, formatTokens, shortenPath } from '../format';
import { AgentBadge } from './Bits';
import { BucketDetail, billedTokens, COMMON_MEASURES, RankedList, type Measure, type RankedEntry } from './Ranked';
import { SessionTable } from './Tables';

/** The measures a session can be ranked by. */
const SESSION_MEASURES: Measure[] = [
  COMMON_MEASURES[0] as Measure,
  COMMON_MEASURES[1] as Measure,
  {
    key: 'cacheCost',
    label: '缓存金额',
    hint: '按缓存命中这条计费项的钱',
    value: (entry) => Number(entry.cost.cacheHitInputCost),
    format: (entry, symbol) => `${formatCost(entry.cost.cacheHitInputCost, symbol)} 缓存`,
    secondary: (entry, symbol) => formatCost(entry.cost.total, symbol),
  },
  COMMON_MEASURES[2] as Measure,
  COMMON_MEASURES[3] as Measure,
];

/** The session ranking panel. */
export function SessionLeaderboard({
  sessions,
  symbol,
  showProject = false,
  limit,
  title = '会话',
  baseline,
}: {
  sessions: readonly SessionNode[];
  symbol: string;
  showProject?: boolean;
  limit?: number | undefined;
  title?: string;
  /** Extra header control (the overview's "show all" link). */
  baseline?: ReactNode;
}): React.ReactElement {
  const [flat, setFlat] = useState(false);
  const [view, setView] = useState<'bars' | 'table'>('bars');
  const ids = new Set(sessions.map((session) => session.id));
  const rows = flat
    ? [...sessions]
    : sessions.filter((session) => !(session.isSubagent && session.parentId !== null && ids.has(session.parentId)));

  if (view === 'table') {
    return (
      <SessionTable
        sessions={sessions}
        symbol={symbol}
        showProject={showProject}
        title={title}
        {...(limit === undefined ? {} : { limit })}
      />
    );
  }

  const entries: RankedEntry[] = rows.map((session) => ({
    key: session.uid,
    title: session.title ?? `（无标题）${session.id.slice(0, 8)}`,
    href: `/s/${encodeURIComponent(session.uid)}`,
    badges: <AgentBadge id={session.agent} small />,
    subtitle: showProject ? session.projectName : shortenPath(session.workspace, 34),
    ...(session.subagentCount > 0 ? { counts: `${session.subagentCount} 子` } : {}),
    tokens: session.tokens,
    cost: session.cost,
    requests: session.requests,
    lastUsage: session.lastUsage,
    children: (
      <BucketDetail
        tokens={session.tokens}
        cost={session.cost}
        symbol={symbol}
        facts={
          <>
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
            <div>请求 <span className="tnum text-fg">{formatTokens(session.requests)}</span></div>
            <Link to={`/s/${encodeURIComponent(session.uid)}`} className="inline-block text-accent hover:underline">
              打开会话详情 →
            </Link>
          </>
        }
      />
    ),
  }));

  return (
    <RankedList
      entries={entries}
      symbol={symbol}
      title={title}
      measures={SESSION_MEASURES}
      {...(limit === undefined ? {} : { limit })}
      baseline={
        <>
          {baseline}
          <button
            type="button"
            onClick={() => setView('table')}
            className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
            title="切换排行榜 / 表格"
          >
            表格视图
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
      footnote={
        <>
          {flat
            ? '含子代理：子代理行与父行会重复计算同一笔用量。'
            : '每行是一个委派子树的根（自身 + 它派生的全部）。'}
          {' '}
          点一行展开该会话的全部计费桶与金额；条形长度 = 当前排序指标，颜色 = 计费桶
          （占比很小时也保留一点可见宽度，具体数值见每行的色块标签）。
          {rows.length > 0 && (
            <>
              {' '}
              合计 {formatCost(String(rows.reduce((sum, session) => sum + Number(session.cost.total), 0)), symbol)}
              ，缓存命中占{' '}
              {formatShare(
                rows.reduce((sum, session) => sum + session.tokens.cacheRead, 0) /
                  Math.max(
                    1,
                    rows.reduce((sum, session) => sum + billedTokens(session.tokens), 0),
                  ),
              )}
              。
            </>
          )}
        </>
      }
    />
  );
}
