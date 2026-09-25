/**
 * The right panel when nothing is selected: the overview of the current scope.
 *
 * "Scope" is one project or every project — the component does not care, it reads
 * the dashboard the server already filtered. From top to bottom: the headline
 * numbers, the per-agent table, the two share charts, the time series, then the
 * model and price-band detail.
 */

import { useMemo } from 'react';
import type { Dashboard, ProjectSummary, TimeseriesBucket } from '../types';
import {
  formatCost,
  formatInstant,
  formatShare,
  formatTokens,
} from '../format';
import { AgentBadge, Card, Chip, MetricSplit, Notice, Stat } from './Bits';
import { AgentTable, BandTable, ModelTable, SessionTable, TokenTable } from './Tables';
import { agentShareOption, EChart, projectBarOption, timeseriesOption, tokenDonutOption, type SeriesMetric } from '../charts';

/** The scope overview. */
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
  loading,
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
  const totals = project === null ? dashboard.totals : null;
  const cost = project === null ? dashboard.totals.cost.total : project.cost.total;
  const requests = project === null ? dashboard.totals.requests : project.requests;
  const tokens = project === null ? dashboard.totals.tokens : project.tokens;
  const sessions = project === null ? dashboard.totals.sessions : project.sessions;
  const subagents = project === null ? dashboard.totals.subagentSessions : project.subagentSessions;
  const agents = project === null ? dashboard.agents : project.agentTotals;
  const models = project === null ? dashboard.models : project.models;
  const bands = project === null ? dashboard.bands : project.bands;
  const billedTokens = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

  const projectRows = useMemo(
    () =>
      [...dashboard.projects]
        .sort((left, right) => Number(right.cost.total) - Number(left.cost.total))
        .slice(0, 8)
        .map((entry) => ({
          name: entry.name,
          value: Number(entry.cost.total),
          extra: `${entry.agents.join('·')}｜${formatTokens(entry.requests)} 次请求｜${formatCost(entry.cost.total, symbol)}`,
        })),
    [dashboard.projects, symbol],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="cell-title max-w-full text-lg font-semibold" title={project?.name ?? '全部项目'}>
              {project?.name ?? '全部项目'}
            </h1>
            {project !== null && <Chip tone={project.kind === 'repo' ? 'accent' : 'muted'}>{project.kind === 'repo' ? 'git 仓库' : '目录'}</Chip>}
            {project !== null && project.repo !== undefined && (
              <Chip tone="muted" title={project.repo.root}>
                {project.repo.name}
              </Chip>
            )}
            {loading && <span className="text-[11px] text-faint">加载中…</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
            {agents.map((agent) => (
              <AgentBadge key={agent.id} id={agent.id} small />
            ))}
            <span>
              {project === null
                ? `${dashboard.totals.projects} 个项目 · ${dashboard.totals.workspaces} 个工作区`
                : `${project.workspaces.length} 个工作区`}
            </span>
            <span>
              数据 {formatInstant(dashboard.rangeFrom ?? dashboard.totals.firstUsage)} →{' '}
              {formatInstant(dashboard.rangeTo ?? dashboard.totals.lastUsage)}
            </span>
            <span>
              {dashboard.mode === 'snapshot' ? '离线快照' : '实时扫描'} · {dashboard.rangeLabel} · 扫描于{' '}
              {formatInstant(dashboard.scannedAt)}（{dashboard.scanMs} ms）
            </span>
          </div>
          {project !== null && (
            <div className="mt-1 flex flex-wrap gap-1">
              {project.workspaces.map((workspace) => (
                <span key={workspace} className="max-w-full truncate text-[11px] text-faint" title={workspace}>
                  {workspace}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="会话（子代理）" value={`${sessions}（${subagents}）`} hint={`活跃 ${project === null ? dashboard.totals.activeSessions : project.activeSessions}`} />
        <Stat label="请求" value={formatTokens(requests)} hint={`未计价 ${project === null ? dashboard.totals.unpriced : project.unpriced}`} />
        <Stat label="tokens（计费桶）" value={formatTokens(billedTokens, true)} hint={`思考 ${formatTokens(tokens.reasoning, true)}`} />
        <Stat label="费用" value={formatCost(cost, symbol)} tone="accent" hint={`${dashboard.currency} · ${dashboard.pricingLabel}`} />
        <Stat label="缓存读取占比" value={formatShare(billedTokens === 0 ? 0 : tokens.cacheRead / billedTokens)} hint={`缓存写入 ${formatTokens(tokens.cacheWrite, true)}`} />
        <Stat
          label="项目占比"
          value={project === null ? '100%' : formatShare(Number(project.cost.total) / Math.max(Number(dashboard.totals.cost.total), 1e-9))}
          hint={project === null ? '全部项目' : `全部 ${formatCost(dashboard.totals.cost.total, symbol)}`}
        />
      </div>

      {/* The CLI prints 总 / 自身 / 子代理 for every node; this is that block. */}
      <Card title="指标（总 / 自身 / 子代理）">
        <MetricSplit
          total={{
            tokens,
            cost: project === null ? dashboard.totals.cost : project.cost,
            requests,
          }}
          own={{
            tokens: (project === null ? dashboard.totals.own : project.own).tokens,
            cost: (project === null ? dashboard.totals.own : project.own).cost,
            requests: (project === null ? dashboard.totals.own : project.own).requests,
          }}
          spawned={{
            tokens: (project === null ? dashboard.totals.spawned : project.spawned).tokens,
            cost: (project === null ? dashboard.totals.spawned : project.spawned).cost,
            requests: (project === null ? dashboard.totals.spawned : project.spawned).requests,
          }}
          symbol={symbol}
        />
        <p className="mt-2 text-[11px] text-faint">
          与 CLI 的 <code>usage --subagent</code> 同一口径：自身 + 子代理 = 总；每项后面的金额是该项自己产生的钱。
        </p>
      </Card>

      {totals !== null && dashboard.warnings.length > 0 && (
        <Notice tone="warn" title={`${dashboard.warnings.length} 条提示`}>
          <ul className="list-disc space-y-0.5 pl-4">
            {dashboard.warnings.slice(0, 4).map((item) => (
              <li key={`${item.code}:${item.message.slice(0, 24)}`}>{item.message}</li>
            ))}
          </ul>
        </Notice>
      )}

      <AgentTable agents={agents} symbol={symbol} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="agent 费用占比">
          {agents.length === 0 ? (
            <p className="py-8 text-center text-[12px] text-faint">没有数据。</p>
          ) : (
            <EChart option={agentShareOption(agents, symbol, dark)} height={230} />
          )}
        </Card>
        <div className="space-y-3">
          <Card title="token 五桶占比">
            <EChart option={tokenDonutOption(tokens, dark)} height={190} />
            <p className="mt-1 text-[11px] text-faint">只画四个计费桶；思考 token 已含在输出里，图中不重复计。</p>
          </Card>
          <TokenTable breakdown={project === null ? dashboard.totals.tokenBreakdown : project.tokenBreakdown} symbol={symbol} />
          {project === null && projectRows.length > 0 && (
            <Card title="项目费用排行">
              <EChart option={projectBarOption(projectRows, symbol, dark)} height={140} />
            </Card>
          )}
        </div>
      </div>

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
                  className={`px-2 py-0.5 text-[11px] ${bucket === option ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}
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
                  className={`px-2 py-0.5 text-[11px] ${metric === option.key ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </>
        }
      >
        {points.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-faint">
            {bucket === 'hour' ? '最近 14 天没有消耗（小时粒度只保留 14 天）。' : '当前范围没有消耗。'}
          </p>
        ) : (
          <EChart option={timeseriesOption(points, agents, metric, symbol, dark)} height={260} />
        )}
        <p className="mt-1 text-[11px] text-faint">
          按 (时间桶 × agent × 项目) 分别计价后相加，与总计的差异在小数点后第 4 位以内。
          {bucket === 'hour' && ' 小时粒度只覆盖最近 14 天。'}
        </p>
      </Card>

      {/* Stacked, not side by side: both tables carry six or seven columns, and
          two of them abreast is what forced a horizontal scrollbar. */}
      <div className="space-y-3">
        <ModelTable models={models} symbol={symbol} />
        <BandTable bands={bands} symbol={symbol} />
      </div>

      {project !== null && project.sessionReports.length > 0 && (
        <SessionTable sessions={project.sessionReports} symbol={symbol} />
      )}

      {totals !== null && (
        <Card title="数据来源">
          <ul className="space-y-1 text-[11px] text-muted">
            {dashboard.loadedAgents.map((agent) => (
              <li key={agent.id} className="flex items-center gap-2">
                <AgentBadge id={agent.id} small />
                <span className="truncate" title={agent.source}>
                  {agent.label} · {agent.source}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-faint">
            <span>
              计价来源 {dashboard.pricingLabel}（{dashboard.pricingProvider}），货币 {dashboard.currency}
            </span>
            <span>· 扫描 {dashboard.scanMs} ms</span>
            <span>· 数据根 {dashboard.source}</span>
          </div>
        </Card>
      )}
    </div>
  );
}
