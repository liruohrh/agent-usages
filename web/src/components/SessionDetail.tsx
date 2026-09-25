/**
 * One session, its own/spawned/total split, and the delegation tree under it.
 *
 * The tree is the point of this panel: a session that spawned six subagents reads
 * as one node with six children, each with its own requests and money, and the
 * parent's `总` line is exactly `自身 + 子代理`.
 */

import { Link } from 'react-router-dom';

import type { SessionDetail as Detail, SessionTreeNode } from '../types';
import { formatCost, formatInstant, formatShare, formatTokens, shortenPath } from '../format';
import { AgentBadge, Card, Chip, Notice } from './Bits';
import { Composition, KpiRow, MetricDetailTable, ScopeSplitTable } from './Metrics';
import { useT } from '../i18n';
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
  const t = useT();
  if (error !== null) {
    return (
      <Notice tone="bad" title={t.session.notFound}>
        {error}
      </Notice>
    );
  }
  if (detail === null) {
    return <Notice title={loading ? t.app.loading : t.session.pick}>{t.session.pickHint}</Notice>;
  }
  const session = detail.session;
  const title = session.title ?? t.session.untitledNamed(session.id.slice(0, 8));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="cell-title max-w-full text-lg font-semibold" title={title}>
            {title}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
            <AgentBadge id={session.agent} />
            <Chip tone={session.isSubagent ? 'muted' : 'accent'}>
              {session.isSubagent ? t.session.subagentNode : t.session.main}
            </Chip>
            {session.archived && <Chip tone="muted">{t.session.archived}</Chip>}
            <span className="truncate" title={session.cwd ?? session.workspace}>
              {shortenPath(session.cwd ?? session.workspace, 60)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-faint">
            <span>{t.session.project(session.projectName)}</span>
            <span>{t.session.created(formatInstant(session.createdAt))}</span>
            <span>
              {t.session.span(formatInstant(session.firstUsage), formatInstant(session.lastUsage))}
            </span>
            <span className="truncate" title={session.id}>
              id {session.id}
            </span>
          </div>
          {detail.ancestors.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-faint">
              <span>{t.session.parent}</span>
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
          {t.session.back}
        </button>
      </div>

      <KpiRow
        items={[
          {
            title: t.session.moneyTitle,
            value: formatCost(session.total.cost.total, symbol),
            hint: t.session.requestsHint(
              formatCost(session.own.cost.total, symbol),
              formatCost(session.spawned.cost.total, symbol),
            ),
            tone: 'accent',
          },
          {
            label: 'Q',
            title: t.session.requestTitle,
            value: formatTokens(session.total.requests),
            hint: t.session.requestsHint(
              formatTokens(session.own.requests),
              formatTokens(session.spawned.requests),
            ),
          },
          {
            label: 'T',
            title: t.session.tokensTitle,
            value: formatTokens(session.total.tokens.input + session.total.tokens.output + session.total.tokens.cacheRead + session.total.tokens.cacheWrite, true),
            ...(session.total.tokens.reasoning > 0
              ? { hint: t.kpi.reasoning(formatTokens(session.total.tokens.reasoning, true)) }
              : {}),
          },
          {
            label: t.session.spawnedLabel,
            value: String(session.spawned.sessions),
            hint:
              session.spawned.sessions === 0
                ? t.session.noSpawned
                : t.session.spawnedShare(
                    formatShare(
                      Number(session.total.cost.total) === 0
                        ? 0
                        : Number(session.spawned.cost.total) / Number(session.total.cost.total),
                    ),
                  ),
          },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Composition tokens={session.total.tokens} cost={session.total.cost} symbol={symbol} />
        <div className="space-y-4">
          <ScopeSplitTable
            total={{ requests: session.total.requests, tokens: session.total.tokens, cost: session.total.cost }}
            own={{ requests: session.own.requests, tokens: session.own.tokens, cost: session.own.cost }}
            spawned={{ requests: session.spawned.requests, tokens: session.spawned.tokens, cost: session.spawned.cost }}
            symbol={symbol}
          />
          <MetricDetailTable
            total={{ requests: session.total.requests, tokens: session.total.tokens, cost: session.total.cost }}
            own={{ requests: session.own.requests, tokens: session.own.tokens, cost: session.own.cost }}
            spawned={{ requests: session.spawned.requests, tokens: session.spawned.tokens, cost: session.spawned.cost }}
            symbol={symbol}
          />
        </div>
      </div>

      {detail.tree.children.length > 0 && (
        <Card title={t.session.delegation(String(detail.tree.children.length))}>
          <div className="space-y-0.5">
            <TreeRow node={detail.tree} symbol={symbol} isRoot />
          </div>
        </Card>
      )}

      {/* Stacked like the project overview: six and seven columns side by side
          do not fit half a window, and a squeezed table is worse than a taller page. */}
      <div className="space-y-3">
        <ModelTable models={detail.models} symbol={symbol} title={t.session.models} />
        <BandTable bands={detail.bands} symbol={symbol} title={t.session.bands} />
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
  const t = useT();
  const title = node.title ?? t.session.untitled(node.id.slice(0, 8));
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
            Q {formatTokens(node.requests)} · T{' '}
            {formatTokens(node.tokens.input + node.tokens.output + node.tokens.cacheRead + node.tokens.cacheWrite, true)}
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
