/**
 * The top bar: time range, agent multi-select, project search, refresh, theme.
 *
 * Filters are lifted to the app, which refetches `/api/dashboard` (and
 * `/api/timeseries`) whenever they change — the server filters and re-totals, so
 * the numbers on screen always describe exactly the rows that are shown.
 */

import { useEffect, useRef, useState } from 'react';

import type { Dashboard, RangeKey } from '../types';
import { agentColor, agentLabel, formatAgo, formatCost } from '../format';

/** The range presets, in the order the buttons appear. */
const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'today', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'all', label: '全部' },
];

/** Everything the user can change about what is being shown. */
export interface FilterState {
  range: RangeKey;
  agents: string[];
  search: string;
}

/** The toolbar. */
export function Filters({
  dashboard,
  filters,
  onChange,
  onRefresh,
  refreshing,
  dark,
  onToggleTheme,
  onToggleSidebar,
}: {
  dashboard: Dashboard | null;
  filters: FilterState;
  onChange: (next: FilterState) => void;
  onRefresh: () => void;
  refreshing: boolean;
  dark: boolean;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
}): React.ReactElement {
  const [agentMenu, setAgentMenu] = useState(false);
  const menuHost = useRef<HTMLDivElement | null>(null);

  // A click anywhere else closes the agent menu.
  useEffect(() => {
    if (!agentMenu) return;
    const close = (event: MouseEvent): void => {
      if (menuHost.current !== null && !menuHost.current.contains(event.target as Node)) setAgentMenu(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [agentMenu]);

  const loaded = dashboard?.loadedAgents ?? [];
  const toggleAgent = (id: string): void => {
    const next = filters.agents.includes(id)
      ? filters.agents.filter((candidate) => candidate !== id)
      : [...filters.agents, id];
    onChange({ ...filters, agents: next });
  };

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
      <button
        type="button"
        onClick={onToggleSidebar}
        className="rounded border border-line px-2 py-0.5 text-[12px] text-muted hover:text-fg lg:hidden"
        aria-label="切换项目树"
      >
        ☰
      </button>
      <div className="flex items-center gap-1.5">
        <span className="text-[13px] font-semibold">agent-usages</span>
        <span className="text-[11px] text-faint">本地用量分析</span>
      </div>

      <div className="flex overflow-hidden rounded border border-line">
        {RANGES.map((range) => (
          <button
            key={range.key}
            type="button"
            onClick={() => onChange({ ...filters, range: range.key })}
            className={`px-2 py-0.5 text-[11px] ${
              filters.range === range.key ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'
            }`}
          >
            {range.label}
          </button>
        ))}
      </div>

      <div className="relative" ref={menuHost}>
        <button
          type="button"
          onClick={() => setAgentMenu((open) => !open)}
          className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
        >
          agent：{filters.agents.length === 0 ? '全部' : filters.agents.map(agentLabel).join('、')} ▾
        </button>
        {agentMenu && (
          <div className="absolute left-0 top-full z-20 mt-1 w-52 rounded-lg border border-line bg-panel p-1 shadow-lg">
            <button
              type="button"
              onClick={() => onChange({ ...filters, agents: [] })}
              className={`block w-full rounded px-2 py-1 text-left text-[12px] hover:bg-raised ${
                filters.agents.length === 0 ? 'text-accent' : 'text-muted'
              }`}
            >
              全部 agent
            </button>
            {loaded.map((agent) => (
              <label
                key={agent.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[12px] hover:bg-raised"
                title={agent.source}
              >
                <input
                  type="checkbox"
                  checked={filters.agents.includes(agent.id)}
                  onChange={() => toggleAgent(agent.id)}
                  className="accent-[var(--accent)]"
                />
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: agentColor(agent.id) }} />
                <span className="truncate">{agent.label}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <input
        type="search"
        value={filters.search}
        onChange={(event) => onChange({ ...filters, search: event.target.value })}
        placeholder="搜索项目 / 路径"
        className="w-40 rounded border border-line bg-raised px-2 py-0.5 text-[12px] text-fg placeholder:text-faint focus:border-accent focus:outline-none sm:w-52"
      />

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {dashboard !== null && (
          <span className="hidden text-[11px] text-faint sm:inline">
            {dashboard.mode === 'snapshot' ? '离线快照' : `扫描于 ${formatAgo(dashboard.scannedAt)}`} ·{' '}
            {dashboard.loadedAgents.length} 个 agent · {formatCost(dashboard.totals.cost.total, dashboard.currencySymbol)} ·{' '}
            {dashboard.rangeLabel}
          </span>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg disabled:opacity-50"
          title="POST /api/refresh：重新扫描各 agent 的数据目录"
        >
          {refreshing ? '重扫中…' : '重新扫描'}
        </button>
        <button
          type="button"
          onClick={onToggleTheme}
          className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
          title="切换明暗主题"
        >
          {dark ? '☾' : '☀'}
        </button>
      </div>
    </header>
  );
}
