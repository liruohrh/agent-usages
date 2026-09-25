/**
 * The 用量 tab: the numbers, but laid out as tables with columns.
 *
 * Layers, top to bottom: the scope's own `总 / 自身 / 子代理` line, the same three
 * lines with every single figure behind a disclosure, the per-agent split, and
 * the token breakdown. This is where the terminal report's detail lives now — as
 * columns a reader can scan, sort by eye and copy, instead of a run-on line.
 */

import type { Dashboard, ProjectSummary, TimeseriesBucket } from '../types';
import { AgentTable, TokenTable } from './Tables';
import { MetricDetailTable, ScopeSplitTable } from './Metrics';
import { AgentBadge, Card } from './Bits';
import type { SeriesMetric } from '../charts';

/** The usage panel. */
export function UsageTab({
  dashboard,
  project,
  symbol,
}: {
  dashboard: Dashboard;
  project: ProjectSummary | null;
  symbol: string;
  points: readonly TimeseriesBucket[];
  bucket: 'day' | 'hour';
  metric: SeriesMetric;
  onBucket: (bucket: 'day' | 'hour') => void;
  onMetric: (metric: SeriesMetric) => void;
  dark: boolean;
  loading: boolean;
}): React.ReactElement {
  const figures =
    project === null
      ? { total: dashboard.totals, own: dashboard.totals.own, spawned: dashboard.totals.spawned }
      : { total: project, own: project.own, spawned: project.spawned };
  const agents = project === null ? dashboard.agents : project.agentTotals;
  const tokenBreakdown = project === null ? dashboard.totals.tokenBreakdown : project.tokenBreakdown;

  return (
    <div className="space-y-4">
      <ScopeSplitTable
        total={{ requests: figures.total.requests, tokens: figures.total.tokens, cost: figures.total.cost }}
        own={{ requests: figures.own.requests, tokens: figures.own.tokens, cost: figures.own.cost }}
        spawned={{ requests: figures.spawned.requests, tokens: figures.spawned.tokens, cost: figures.spawned.cost }}
        symbol={symbol}
      />

      <MetricDetailTable
        total={{ requests: figures.total.requests, tokens: figures.total.tokens, cost: figures.total.cost }}
        own={{ requests: figures.own.requests, tokens: figures.own.tokens, cost: figures.own.cost }}
        spawned={{ requests: figures.spawned.requests, tokens: figures.spawned.tokens, cost: figures.spawned.cost }}
        symbol={symbol}
      />

      <AgentTable agents={agents} symbol={symbol} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <TokenTable breakdown={tokenBreakdown} symbol={symbol} />
        <Card title="数据来源">
          <ul className="space-y-2">
            {dashboard.loadedAgents.map((agent) => (
              <li key={agent.id} className="flex items-center gap-2">
                <AgentBadge id={agent.id} small />
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={agent.source}>
                  {agent.label} · {agent.source}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3 text-[11px] text-faint">
            <span>
              计价来源 {dashboard.pricingLabel}（{dashboard.pricingProvider}）· {dashboard.currency}
            </span>
            <span>扫描 {dashboard.scanMs} ms</span>
            <span className="min-w-0 truncate" title={dashboard.source}>
              数据根 {dashboard.source}
            </span>
          </div>
        </Card>
      </div>
    </div>
  );
}
