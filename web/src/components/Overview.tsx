/**
 * The 概览 tab: the four headline figures, where the tokens and the money went,
 * the trend, and — for the whole machine — which projects spent it.
 *
 * Nothing here is a wall of numbers: the per-bucket detail lives in the 用量 tab,
 * and the project list is a short ranking rather than every column of every
 * project. The one long scroll from the terminal's report is deliberately gone.
 */

import { Link } from 'react-router-dom';

import type { Dashboard, ProjectSummary, SessionNode, TimeseriesBucket } from '../types';
import { formatCost, formatShare, formatTokens } from '../format';
import { Card, Notice } from './Bits';
import { Composition, KpiRow } from './Metrics';
import { localeTag, useLanguage, useT } from '../i18n';
import { SessionLeaderboard } from './Sessions';
import { ProjectBoard } from './Ranked';
import { EChart, timeseriesOption, type SeriesMetric } from '../charts';

/** The overview panel. */
export function Overview({
  dashboard,
  project,
  points,
  bucket,
  metric,
  onBucket,
  onMetric,
  symbol,
  dark,
}: {
  dashboard: Dashboard;
  project: ProjectSummary | null;
  points: readonly TimeseriesBucket[];
  bucket: 'day' | 'hour';
  metric: SeriesMetric;
  onBucket: (bucket: 'day' | 'hour') => void;
  onMetric: (metric: SeriesMetric) => void;
  symbol: string;
  dark: boolean;
  loading: boolean;
}): React.ReactElement {
  const t = useT();
  const locale = localeTag(useLanguage());
  const tokens = project === null ? dashboard.totals.tokens : project.tokens;
  const cost = project === null ? dashboard.totals.cost : project.cost;
  const requests = project === null ? dashboard.totals.requests : project.requests;
  const sessions = project === null ? dashboard.totals.sessions : project.sessions;
  const subagents = project === null ? dashboard.totals.subagentSessions : project.subagentSessions;
  const agents = project === null ? dashboard.agents : project.agentTotals;
  const billed = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
  // The hit rate is a share of the *input* (`I/C ÷ I/T`), which is the ratio the
  // CLI prints beside `I/C` — not a share of everything that was billed.
  const inputTotal = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const cacheHit = inputTotal === 0 ? 0 : tokens.cacheRead / inputTotal;
  const unpriced = project === null ? dashboard.totals.unpriced : project.unpriced;
  const firstUsage = project === null ? dashboard.totals.firstUsage : project.firstUsage;
  const lastUsage = project === null ? dashboard.totals.lastUsage : project.lastUsage;
  const day = (instant: number | null): string =>
    instant === null ? '—' : new Date(instant).toLocaleDateString(locale);

  return (
    <div className="space-y-4">
      {/* Four figures, in the order a reader asks for them: what it cost, how
          many tokens, how much of that came from the cache, how many requests.
          The cards say one thing each — the buckets and their money are the
          composition card below, so repeating them here would say it twice. */}
      <KpiRow
        items={[
          {
            // No label: `¥135.0531` says what it is. The definition stays on hover.
            title: t.kpi.money,
            value: formatCost(cost.total, symbol),
            hint: `${dashboard.currency} · ${dashboard.pricingLabel}`,
            tone: 'accent',
          },
          {
            label: 'T',
            title: t.kpi.tokens,
            value: formatTokens(billed, true),
          },
          {
            label: t.kpi.hitRate,
            title: t.kpi.hitRateHint,
            value: formatShare(cacheHit),
          },
          {
            label: 'Q',
            title: t.kpi.requests,
            value: formatTokens(requests),
            hint: t.kpi.requestsHint(String(sessions), String(subagents)),
            ...(unpriced > 0 ? { note: t.kpi.unpriced(String(unpriced)) } : {}),
          },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-1">
          <Composition tokens={tokens} cost={cost} symbol={symbol} />
        </div>
        <div className="xl:col-span-2">
          <Card
            title={t.overview.series}
            actions={
              <>
                <div className="flex overflow-hidden rounded border border-line">
                  {(['day', 'hour'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => onBucket(option)}
                      className={`px-2.5 py-1 text-[12px] ${bucket === option ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}
                    >
                      {option === 'day' ? t.overview.byDay : t.overview.byHour}
                    </button>
                  ))}
                </div>
                <div className="flex overflow-hidden rounded border border-line">
                  {(
                    [
                      { key: 'cost', label: t.tables.seriesCost },
                      { key: 'requests', label: t.tables.seriesRequests },
                      { key: 'tokens', label: t.tables.seriesTokens },
                    ] as const
                  ).map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => onMetric(option.key)}
                      className={`px-2.5 py-1 text-[12px] ${metric === option.key ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </>
            }
          >
            {points.length === 0 ? (
              <p className="py-10 text-center text-[13px] text-faint">
                {bucket === 'hour' ? t.overview.emptyHour : t.overview.empty}
              </p>
            ) : (
              <EChart option={timeseriesOption(points, agents, metric, symbol, dark)} height={300} />
            )}
            <p className="mt-2 text-[11px] text-faint">
              {t.overview.seriesNote(day(firstUsage), day(lastUsage))}
              {bucket === 'hour' && t.overview.seriesHourNote}
            </p>
          </Card>
        </div>
      </div>

      {/* Two compact rankings, the same rows the 项目 / 会话 tabs draw, five deep:
          which projects spent it, and which sessions inside them. */}
      {project === null && (
        <ProjectBoard
          projects={dashboard.projects}
          symbol={symbol}
          title={t.overview.topProjects}
          limit={5}
          baseline={
            <Link to="?view=projects" className="px-1 text-[11px] text-accent hover:underline">
              {t.overview.allRanked(String(dashboard.projects.length))}
            </Link>
          }
          openHref={(entry) => `/p/${encodeURIComponent(entry.id)}`}
        />
      )}

      <TopSessions
        sessions={project === null ? dashboard.projects.flatMap((entry) => entry.sessionReports) : project.sessionReports}
        symbol={symbol}
        showProject={project === null}
        scopeName={project === null ? null : project.name}
      />

      {dashboard.warnings.length > 0 && (
        <Notice tone="warn" title={t.overview.warnings(String(dashboard.warnings.length))}>
          <ul className="list-disc space-y-0.5 pl-4">
            {dashboard.warnings.slice(0, 4).map((item) => (
              <li key={`${item.code}:${item.message.slice(0, 24)}`}>{item.message}</li>
            ))}
          </ul>
        </Notice>
      )}
    </div>
  );
}

/** The dearest sessions of the scope, the same rows the 会话 tab draws. */
function TopSessions({
  sessions,
  symbol,
  showProject,
  scopeName,
}: {
  sessions: readonly SessionNode[];
  symbol: string;
  showProject: boolean;
  scopeName: string | null;
}): React.ReactElement {
  const t = useT();
  const ids = new Set(sessions.map((session) => session.id));
  const roots = sessions.filter(
    (session) => !(session.isSubagent && session.parentId !== null && ids.has(session.parentId)),
  );
  const dearest = [...roots].sort((left, right) => Number(right.cost.total) - Number(left.cost.total));
  return (
    <SessionLeaderboard
      sessions={dearest}
      symbol={symbol}
      showProject={showProject}
      limit={5}
      title={scopeName === null ? t.overview.topSessions : t.overview.topSessionsNamed(scopeName)}
      baseline={
        <Link to="?view=sessions" className="px-1 text-[11px] text-accent hover:underline">
          {t.overview.allRanked(String(roots.length))}
        </Link>
      }
    />
  );
}
