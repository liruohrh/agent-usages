/**
 * The top bar: time range, agent multi-select, project search, refresh, theme.
 *
 * Filters are lifted to the app, which refetches `/api/dashboard` (and
 * `/api/timeseries`) whenever they change — the server filters and re-totals, so
 * the numbers on screen always describe exactly the rows that are shown.
 */

import { useEffect, useRef, useState } from 'react';

import type { Dashboard, Language, RangeKey } from '../types';
import { agentColor, agentLabel, formatAgo, formatCost } from '../format';
import { saveLanguage } from '../api';
import { useT } from '../i18n';

/** The range presets, in the order the buttons appear. */
const RANGES: RangeKey[] = ['today', 'week', 'month', 'all'];

/** Everything the user can change about what is being shown. */
export interface FilterState {
  range: RangeKey;
  agents: string[];
  search: string;
}

/** The toolbar. */
export function Filters({
  dashboard,
  language,
  onLanguage,
  filters,
  onChange,
  onRefresh,
  refreshing,
  dark,
  onToggleTheme,
  onToggleSidebar,
  onOpenSettings,
}: {
  dashboard: Dashboard | null;
  language: Language;
  onLanguage: (next: Language) => void;
  filters: FilterState;
  onChange: (next: FilterState) => void;
  onRefresh: () => void;
  refreshing: boolean;
  dark: boolean;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
}): React.ReactElement {
  const t = useT();
  const [agentMenu, setAgentMenu] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
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

  /**
   * Switch the page over, and write the same value into the configuration file.
   *
   * The page follows the click immediately: the write only decides what the next
   * run (of the CLI, or of this server) starts from. A write that fails says so
   * and leaves the language as it was — the setting is the point, not the click.
   */
  const switchLanguage = (next: Language): void => {
    if (next === language || saving) return;
    setSaving(true);
    setFailed(null);
    saveLanguage(next)
      .then(() => onLanguage(next))
      .catch((cause: unknown) => setFailed((cause as Error).message))
      .finally(() => setSaving(false));
  };
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
        aria-label={t.app.sidebar}
      >
        ☰
      </button>
      <div className="flex items-center gap-1.5">
        <span className="text-[13px] font-semibold">agent-usages</span>
        <span className="text-[11px] text-faint">{t.filters.tagline}</span>
      </div>

      <div className="flex overflow-hidden rounded border border-line">
        {RANGES.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange({ ...filters, range: key })}
            className={`px-2 py-0.5 text-[11px] ${
              filters.range === key ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'
            }`}
          >
            {t.range[key]}
          </button>
        ))}
      </div>

      <div className="relative" ref={menuHost}>
        <button
          type="button"
          onClick={() => setAgentMenu((open) => !open)}
          className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
        >
          {t.filters.agentButton(
            filters.agents.length === 0 ? t.filters.all : filters.agents.map(agentLabel).join('、'),
          )}
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
              {t.filters.allAgents}
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
        placeholder={t.filters.search}
        className="w-40 rounded border border-line bg-raised px-2 py-0.5 text-[12px] text-fg placeholder:text-faint focus:border-accent focus:outline-none sm:w-52"
      />

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {dashboard !== null && (
          <span className="hidden text-[11px] text-faint sm:inline">
            {t.filters.summary(
              String(dashboard.loadedAgents.length),
              formatCost(dashboard.totals.cost.total, dashboard.currencySymbol),
              dashboard.rangeLabel,
            )}{' '}
            · {dashboard.mode === 'snapshot' ? t.filters.snapshot : t.filters.scanned(formatAgo(dashboard.scannedAt))}
          </span>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg disabled:opacity-50"
          title={t.filters.rescanHint}
        >
          {refreshing ? t.filters.rescanning : t.filters.rescan}
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
          title={t.settings.openHint}
          aria-label={t.settings.open}
        >
          ⚙
        </button>
        <button
          type="button"
          onClick={onToggleTheme}
          className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
          title={t.filters.theme}
        >
          {dark ? '☾' : '☀'}
        </button>

        {/* The switch writes the configuration file the CLI reads, so the page
            and the terminal end up in the same language. */}
        <div className="flex overflow-hidden rounded border border-line" title={t.filters.languageHint}>
          {(['zh', 'en'] as const).map((option) => (
            <button
              key={option}
              type="button"
              disabled={saving}
              onClick={() => switchLanguage(option)}
              className={`px-2 py-0.5 text-[11px] disabled:opacity-50 ${
                language === option ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'
              }`}
            >
              {option === 'zh' ? '中文' : 'EN'}
            </button>
          ))}
        </div>
      </div>
      {failed !== null && (
        <div className="w-full text-[11px] text-bad" title={failed}>
          {failed}
        </div>
      )}
    </header>
  );
}
