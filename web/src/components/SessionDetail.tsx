/**
 * One session, its own/spawned/total split, and the delegation tree under it.
 *
 * The tree is the point of this panel: a session that spawned six subagents reads
 * as one node with six children, each with its own requests and money, and the
 * parent's `总` line is exactly `自身 + 子代理`.
 */

import { Link } from 'react-router-dom';

import type { SessionDetail as Detail, SessionTreeNode } from '../types';
import { formatCost, formatInstant, formatTokens, shortenPath } from '../format';
import { AgentBadge, Card, Chip, Notice, Stat } from './Bits';
import { BandTable, ModelTable } from './Tables';

/** The session detail panel. */
export function SessionDetailPanel({
  detail,
  symbol,
  loading,
  error,
}: {
  detail: Detail | null;
  symbol: string;
  loading: boolean;
  error: string | null;
}): React.ReactElement {
  if (error !== null) {
    return (
      <Notice tone="bad" title="读不到这个会话">
        {error}
      </Notice>
    );
  }
  if (detail === null) {
    return <Notice title={loading ? '加载中…' : '选择一个会话'}>从左侧项目树里点一个会话（或子代理）看细节。</Notice>;
  }
  const session = detail.session;
  const title = session.title ?? `（无标题会话 ${session.id.slice(0, 8)}）`;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="cell-title max-w-full text-lg font-semibold" title={title}>
            {title}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
            <AgentBadge id={session.agent} />
            <Chip tone={session.isSubagent ? 'muted' : 'accent'}>{session.isSubagent ? '子代理' : '主会话'}</Chip>
            {session.archived && <Chip tone="muted">已归档</Chip>}
            <span className="truncate" title={session.cwd ?? session.workspace}>
              {shortenPath(session.cwd ?? session.workspace, 60)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-faint">
            <span>项目 {session.projectName}</span>
            <span>创建 {formatInstant(session.createdAt)}</span>
            <span>
              首末消耗 {formatInstant(session.firstUsage)} → {formatInstant(session.lastUsage)}
            </span>
            <span className="truncate" title={session.id}>
              id {session.id}
            </span>
          </div>
          {detail.ancestors.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-faint">
              <span>上级：</span>
              {[...detail.ancestors].reverse().map((ancestor) => (
                <Link
                  key={`${ancestor.agent}:${ancestor.id}`}
                  to={`/s/${encodeURIComponent(`${ancestor.agent}:${ancestor.id}`)}`}
                  className="max-w-[220px] truncate rounded border border-line px-1.5 py-0.5 text-muted hover:text-fg"
                  title={ancestor.title ?? ancestor.id}
                >
                  {ancestor.title ?? ancestor.id.slice(0, 10)}
                </Link>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => window.history.back()}
          className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
        >
          返回
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="自身" value={formatCost(session.own.cost.total, symbol)} hint={`${formatTokens(session.own.requests)} 次请求`} />
        <Stat
          label={`子代理（${session.spawned.sessions}）`}
          value={formatCost(session.spawned.cost.total, symbol)}
          hint={`${formatTokens(session.spawned.requests)} 次请求`}
        />
        <Stat label="总计" value={formatCost(session.total.cost.total, symbol)} tone="accent" hint={`${formatTokens(session.total.requests)} 次请求`} />
        <Stat
          label="tokens"
          value={formatTokens(session.own.tokens.input + session.own.tokens.output + session.own.tokens.cacheRead + session.own.tokens.cacheWrite, true)}
          hint={`思考 ${formatTokens(session.own.tokens.reasoning, true)}`}
        />
      </div>

      {detail.tree.children.length > 0 && (
        <Card title={`委派树（${detail.tree.children.length} 个直接子代理）`}>
          <div className="space-y-0.5">
            <TreeRow node={detail.tree} symbol={symbol} isRoot />
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <ModelTable models={detail.models} symbol={symbol} title="本会话模型明细" />
        <BandTable bands={detail.bands} symbol={symbol} title="本会话计价区间" />
      </div>
    </div>
  );
}

/** One node of the delegation tree, recursively. */
function TreeRow({
  node,
  symbol,
  isRoot = false,
}: {
  node: SessionTreeNode;
  symbol: string;
  isRoot?: boolean;
}): React.ReactElement {
  const title = node.title ?? `（无标题）${node.id.slice(0, 8)}`;
  return (
    <div>
      <div className={`flex items-start gap-2 rounded px-2 py-1 ${isRoot ? 'bg-raised' : 'hover:bg-raised'}`}>
        <button type="button" className="mt-0.5 w-3 shrink-0 text-[10px] text-faint" aria-hidden>
          {node.children.length > 0 ? '▾' : '·'}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="cell-title text-[12px]" title={title}>
              {title}
            </span>
            {!isRoot && <AgentBadge id={node.agent} small />}
          </div>
          <div className="tnum mt-0.5 text-[11px] text-faint">
            {formatTokens(node.requests)} req · {formatTokens(node.tokens.input + node.tokens.output + node.tokens.cacheRead + node.tokens.cacheWrite, true)} tok
          </div>
        </div>
        <span className="tnum shrink-0 text-[11px]">{formatCost(node.cost.total, symbol)}</span>
      </div>
      {node.children.length > 0 && (
        <div className="ml-4 border-l border-line pl-1">
          {node.children.map((child) => (
            <TreeRow key={child.uid} node={child} symbol={symbol} />
          ))}
        </div>
      )}
    </div>
  );
}
