/**
 * The session ranking: the same leaderboard as projects and agents, with the two
 * controls only sessions need (fold subagents, switch to the column view).
 *
 * Every figure is a sortable column, and each row's bar is that session's own
 * token make-up — see `RankedList` for why size and composition are separate.
 */

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { SessionNode } from '../types';
import { formatCost, formatInstant, formatShare, formatTokens, shortenPath } from '../format';
import { AgentBadge } from './Bits';
import { BucketDetail, RankedList, type RankedEntry } from './Ranked';
import { SessionTable } from './Tables';
import { useT } from '../i18n';

/** The session ranking panel. */
export function SessionLeaderboard({
  sessions,
  symbol,
  showProject = false,
  limit,
  title,
  baseline,
}: {
  sessions: readonly SessionNode[];
  symbol: string;
  showProject?: boolean;
  limit?: number | undefined;
  title: string;
  /** Extra header control (the overview's "show all" link). */
  baseline?: ReactNode;
}): React.ReactElement {
  const t = useT();
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
    title: session.title ?? t.session.untitled(session.id.slice(0, 8)),
    href: `/s/${encodeURIComponent(session.uid)}`,
    badges: <AgentBadge id={session.agent} small />,
    subtitle: showProject ? session.projectName : shortenPath(session.workspace, 34),
    ...(session.subagentCount > 0 ? { counts: t.board.subagentsChip(String(session.subagentCount)) } : {}),
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
              {t.session.first} <span className="text-fg">{formatInstant(session.firstUsage)}</span>
            </div>
            <div>
              {t.session.last} <span className="text-fg">{formatInstant(session.lastUsage)}</span>
            </div>
            <div>
              {t.session.own}{' '}
              <span className="tnum text-fg">{formatCost(session.own.cost.total, symbol)}</span> ·{' '}
              {t.session.spawned}{' '}
              <span className="tnum text-fg">{formatCost(session.spawned.cost.total, symbol)}</span>
            </div>
            <div>
              Q <span className="tnum text-fg">{formatTokens(session.requests)}</span>
            </div>
            <Link to={`/s/${encodeURIComponent(session.uid)}`} className="inline-block text-accent hover:underline">
              {t.session.open}
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
      {...(limit === undefined ? {} : { limit })}
      baseline={
        <>
          {baseline}
          <button
            type="button"
            onClick={() => setView('table')}
            className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
            title={t.session.tableHint}
          >
            {t.session.table}
          </button>
          <button
            type="button"
            onClick={() => setFlat((value) => !value)}
            className={`rounded border px-2 py-0.5 text-[11px] ${flat ? 'border-accent/50 bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}
            title={t.session.flatHint}
          >
            {flat ? t.session.flat : t.session.fold}
          </button>
        </>
      }
      footnote={
        <>
          {flat ? t.session.flatNote : t.session.foldedNote} {t.session.rowNote}
          {rows.length > 0 && (
            <>
              {' '}
              {t.session.share(
                formatCost(String(rows.reduce((sum, session) => sum + Number(session.cost.total), 0)), symbol),
                formatShare(
                  rows.reduce((sum, session) => sum + session.tokens.cacheRead, 0) /
                    Math.max(
                      1,
                      rows.reduce(
                        (sum, session) =>
                          sum + session.tokens.input + session.tokens.cacheRead + session.tokens.cacheWrite,
                        0,
                      ),
                    ),
                ),
              )}
            </>
          )}
        </>
      }
    />
  );
}
