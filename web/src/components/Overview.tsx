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
    instant === null ? '—' : new Date(instant).toLocaleDateString('zh-CN');

  return (
    <div className="space-y-4">
      <KpiRow
        items={[
          {
            // No label: `¥135.0531` says what it is. The definition stays on hover.
            title: '当前范围的总费用',
            value: formatCost(cost.total, symbol),
            hint: `${dashboard.currency} · ${dashboard.pricingLabel}`,
            tone: 'accent',
          },
          {
            label: 'Q',
            title: '请求数',
            value: formatTokens(requests),
            hint: `${sessions} 个会话（含 ${subagents} 个子代理）`,
            ...(unpriced > 0 ? { note: `未计价 ${unpriced}` } : {}),
          },
          {
            label: 'T',
            title: '计费桶 token 合计 = I/T + O/T',
            value: formatTokens(billed, true),
            ...(tokens.reasoning > 0 ? { hint: `R ${formatTokens(tokens.reasoning, true)}` } : {}),
            ...(tokens.cacheWrite > 0 ? { note: `I/W ${formatTokens(tokens.cacheWrite, true)}` } : {}),
          },
          {
            label: 'I/C 占比',
            title: '缓存命中输入 ÷ 输入合计（I/C ÷ I/T）',
            value: formatShare(cacheHit),
            hint: `I/C ${formatTokens(tokens.cacheRead, true)}`,
            note: `I/T ${formatTokens(inputTotal, true)}`,
          },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-1">
          <Composition tokens={tokens} cost={cost} symbol={symbol} />
        </div>
        <div className="xl:col-span-2">
          <Card
            title="时间序列"
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
                      {option === 'day' ? '按天' : '按小时'}
                    </button>
                  ))}
                </div>
                <div className="flex overflow-hidden rounded border border-line">
                  {(
                    [
                      { key: 'cost', label: '费用' },
                      { key: 'requests', label: 'Q' },
                      { key: 'tokens', label: 'T' },
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
                {bucket === 'hour' ? '最近 14 天没有消耗（小时粒度只保留 14 天）。' : '当前范围没有消耗。'}
              </p>
            ) : (
              <EChart option={timeseriesOption(points, agents, metric, symbol, dark)} height={300} />
            )}
            <p className="mt-2 text-[11px] text-faint">
              数据 {day(firstUsage)} 起 到 {day(lastUsage)} · 按 (时间桶 × agent × 项目) 分别计价后相加
              {bucket === 'hour' && ' · 小时粒度只覆盖最近 14 天'}
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
          title="项目（前五）"
          limit={5}
          baseline={
            <Link to="?view=projects" className="px-1 text-[11px] text-accent hover:underline">
              全部 {dashboard.projects.length} 个（可排序）→
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
        <Notice tone="warn" title={`${dashboard.warnings.length} 条提示`}>
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
      title={scopeName === null ? '会话（前五）' : `会话（前五）· ${scopeName}`}
      baseline={
        <Link to="?view=sessions" className="px-1 text-[11px] text-accent hover:underline">
          全部 {roots.length} 个（可排序）→
        </Link>
      }
    />
  );
}
