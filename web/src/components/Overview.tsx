/**
 * The 概览 tab: the four headline figures, where the tokens and the money went,
 * the trend, and — for the whole machine — which projects spent it.
 *
 * Nothing here is a wall of numbers: the per-bucket detail lives in the 用量 tab,
 * and the project list is a short ranking rather than every column of every
 * project. The one long scroll from the terminal's report is deliberately gone.
 */

import { Link } from 'react-router-dom';

import type { Dashboard, ProjectSummary, TimeseriesBucket } from '../types';
import { formatCost, formatShare, formatTokens } from '../format';
import { AgentBadge, Card, Notice } from './Bits';
import { Composition, KpiRow } from './Metrics';
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
  const cacheHit = billed === 0 ? 0 : tokens.cacheRead / billed;
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
            label: '费用',
            value: formatCost(cost.total, symbol),
            hint: `${dashboard.currency} · ${dashboard.pricingLabel}`,
            tone: 'accent',
          },
          {
            label: '请求',
            value: formatTokens(requests),
            hint: `${sessions} 个会话（含 ${subagents} 个子代理）`,
            ...(unpriced > 0 ? { note: `未计价 ${unpriced}` } : {}),
          },
          {
            label: 'tokens（计费桶）',
            value: formatTokens(billed, true),
            hint: `思考 ${formatTokens(tokens.reasoning, true)}`,
            ...(tokens.cacheWrite > 0 ? { note: `缓存写入 ${formatTokens(tokens.cacheWrite, true)}` } : {}),
          },
          {
            label: '缓存命中率',
            value: formatShare(cacheHit),
            hint: `${formatTokens(tokens.cacheRead, true)} 来自缓存`,
            note: `${formatTokens(billed, true)} 计费桶`,
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
                      { key: 'requests', label: '请求' },
                      { key: 'tokens', label: 'tokens' },
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

      {project === null ? (
        <ProjectRanking dashboard={dashboard} symbol={symbol} />
      ) : (
        project.sessionReports.length > 0 && (
          <Card
            title="最近的会话"
            actions={
              <Link to="?view=sessions" className="text-[12px] text-accent hover:underline">
                全部会话
              </Link>
            }
          >
            <RecentSessions project={project} symbol={symbol} />
          </Card>
        )
      )}

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

/** The project ranking: a share bar per project, plus a short card each. */
function ProjectRanking({ dashboard, symbol }: { dashboard: Dashboard; symbol: string }): React.ReactElement {
  const rows = [...dashboard.projects]
    .sort((left, right) => Number(right.cost.total) - Number(left.cost.total))
    .slice(0, 8);
  const total = Number(dashboard.totals.cost.total);
  return (
    <Card title="项目花费">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          {rows.map((project) => {
            const share = total === 0 ? 0 : Number(project.cost.total) / total;
            return (
              <Link
                key={project.id}
                to={`/p/${encodeURIComponent(project.id)}`}
                className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 hover:bg-raised"
              >
                <span className="w-40 min-w-0 shrink-0 truncate text-[13px]" title={project.id}>
                  {project.name}
                </span>
                <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-raised">
                  <span className="block h-full rounded-full bg-accent" style={{ width: `${share * 100}%` }} />
                </span>
                <span className="tnum w-24 shrink-0 text-right text-[13px]">{formatCost(project.cost.total, symbol)}</span>
                <span className="tnum w-24 shrink-0 text-right text-[12px] text-faint">
                  {formatTokens(project.requests)} 请求
                </span>
              </Link>
            );
          })}
        </div>
        <div className="space-y-2">
          {rows.slice(0, 4).map((project) => (
            <div key={project.id} className="rounded-lg border border-line px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-[13px]" title={project.id}>
                  {project.name}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {project.agents.map((agent) => (
                    <AgentBadge key={agent} id={agent} small />
                  ))}
                </span>
              </div>
              <div className="mt-1 text-[12px] text-faint">
                {project.sessions} 会话（子代理 {project.subagentSessions}）·{' '}
                {formatTokens(
                  project.tokens.input + project.tokens.output + project.tokens.cacheRead + project.tokens.cacheWrite,
                  true,
                )}{' '}
                tokens
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

/** The newest few sessions of a project, as compact rows. */
function RecentSessions({ project, symbol }: { project: ProjectSummary; symbol: string }): React.ReactElement {
  const rows = [...project.sessionReports]
    .sort((left, right) => (right.lastUsage ?? 0) - (left.lastUsage ?? 0))
    .slice(0, 6);
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      {rows.map((session) => (
        <Link
          key={session.uid}
          to={`/s/${encodeURIComponent(session.uid)}`}
          className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 hover:bg-raised"
        >
          <span className="cell-title min-w-0 text-[13px]" title={session.title ?? session.id}>
            {session.title ?? `（无标题）${session.id.slice(0, 8)}`}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <AgentBadge id={session.agent} small />
            <span className="tnum text-[12px] text-muted">{formatCost(session.cost.total, symbol)}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}
