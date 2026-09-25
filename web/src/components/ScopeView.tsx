/**
 * One scope — everything, or one project — as a set of tabs.
 *
 * The old layout stacked every card into one long scroll, which is what made the
 * page feel crowded: the four figures a reader wants first sat at the same visual
 * weight as the price-band detail. Now a tab answers one question, and the URL
 * carries it (`?view=usage`), so a link can point at a section.
 *
 * 概览   费用、Q、T、I/C 占比，加上构成与时序
 * 项目   项目（或一个项目里的工作区）排行榜：同一套条形 + 展开全部计费桶
 * agent  被读到的 agent 排行榜，同样可排序、可展开
 * 会话   会话排行榜（可切换含子代理，或切表格视图）
 * 用量   总 / 自身 / 子代理，按 agent 分列，token 五桶，完整指标
 * 模型与计价   模型明细与计价区间明细
 */

import { useNavigate, useSearchParams } from 'react-router-dom';

import type { Dashboard, ProjectSummary, TimeseriesBucket } from '../types';
import { Overview } from './Overview';
import { UsageTab } from './Usage';
import { BandTable, ModelTable } from './Tables';
import { SessionLeaderboard } from './Sessions';
import { AgentBoard, ProjectBoard } from './Ranked';
import type { SeriesMetric } from '../charts';

/** The tabs, in reading order. */
const TABS = [
  { key: 'overview', label: '概览' },
  { key: 'projects', label: '项目' },
  { key: 'agents', label: 'agent' },
  { key: 'sessions', label: '会话' },
  { key: 'usage', label: '用量' },
  { key: 'models', label: '模型与计价' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

/** Everything the tabs need, in one prop bag. */
export interface ScopeProps {
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
}

/** The tab bar plus the selected panel. */
export function ScopeView(props: ScopeProps): React.ReactElement {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const raw = params.get('view');
  const active: TabKey = TABS.some((tab) => tab.key === raw) ? (raw as TabKey) : 'overview';

  const select = (key: TabKey): void => {
    const next = new URLSearchParams(params);
    if (key === 'overview') next.delete('view');
    else next.set('view', key);
    setParams(next, { replace: true });
  };

  const { dashboard, project, symbol } = props;
  const scopeName = project === null ? '全部项目' : project.name;
  const sessions = project === null ? dashboard.projects.flatMap((entry) => entry.sessionReports) : project.sessionReports;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="cell-title max-w-full text-[18px] font-semibold" title={scopeName}>
            {scopeName}
          </h1>
          {project !== null && (
            <span className="text-[12px] text-faint">
              {project.kind === 'repo' ? 'git 仓库' : '目录'} · {project.workspaces.length} 个工作区
            </span>
          )}
          {project === null && (
            <span className="text-[12px] text-faint">
              {dashboard.totals.projects} 个项目 · {dashboard.totals.workspaces} 个工作区
            </span>
          )}
          {props.loading && <span className="text-[12px] text-faint">加载中…</span>}
        </div>
        {project !== null && (
          <button
            type="button"
            onClick={() => navigate('/')}
            className="rounded border border-line px-2.5 py-1 text-[12px] text-muted hover:text-fg"
          >
            回到全部项目
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-line pb-px">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => select(tab.key)}
            className={`-mb-px rounded-t border-b-2 px-3 py-2 text-[13px] ${
              active === tab.key
                ? 'border-accent font-medium text-fg'
                : 'border-transparent text-muted hover:text-fg'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {active === 'overview' && <Overview {...props} />}
      {active === 'projects' &&
        (project === null ? (
          <ProjectBoard
            projects={dashboard.projects}
            symbol={symbol}
            title="项目"
            openHref={(entry) => `/p/${encodeURIComponent(entry.id)}`}
          />
        ) : (
          <ProjectBoard workspaces={project.workspaceNodes} symbol={symbol} title={`工作区 · ${project.name}`} />
        ))}
      {active === 'agents' && (
        <AgentBoard
          agents={project === null ? dashboard.agents : project.agentTotals}
          symbol={symbol}
          title={project === null ? 'agent（全部项目）' : `agent · ${project.name}`}
        />
      )}
      {active === 'usage' && <UsageTab {...props} />}
      {active === 'models' && (
        <div className="space-y-4">
          <ModelTable models={project === null ? dashboard.models : project.models} symbol={symbol} />
          <BandTable bands={project === null ? dashboard.bands : project.bands} symbol={symbol} />
        </div>
      )}
      {active === 'sessions' && (
        <SessionLeaderboard
          sessions={sessions}
          symbol={symbol}
          title={project === null ? '会话' : `会话（${project.name}）`}
          showProject={project === null}
        />
      )}
    </div>
  );
}
