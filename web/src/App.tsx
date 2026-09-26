/**
 * The dashboard shell.
 *
 * Layout: a filter bar on top, the project tree on the left, the selected scope on
 * the right. The route decides the scope — `/` is everything, `/p/:id` is one
 * project, `/s/:uid` is one session — so a view is shareable and the browser's
 * back button works.
 *
 * Data flow: filters and route go into `/api/dashboard` (the server filters and
 * re-totals) and `/api/timeseries` (the server aggregates the bucket grid). Both
 * are refetched together, which keeps every number on screen describing the same
 * query.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useMatch, useNavigate } from 'react-router-dom';

import {
  fetchDashboard,
  fetchSession,
  fetchSettings,
  fetchTimeseries,
  refresh as refreshApi,
  setApiLanguage,
  type Filters as ApiFilters,
} from './api';
import type { Dashboard, Language, SessionDetail, TimeseriesBucket } from './types';
import { LanguageProvider, useT } from './i18n';
import { Filters, type FilterState } from './components/Filters';
import { ProjectTree } from './components/Tree';
import { ScopeView } from './components/ScopeView';
import { SessionDetailPanel } from './components/SessionDetail';
import type { SeriesMetric } from './charts';
import { Notice } from './components/Bits';
import { Settings } from './components/Settings';

/** Decode a route parameter, leaving it alone when it is not percent-encoded. */
function decodeParam(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The dashboard, once the page knows what language to speak.
 *
 * The settings answer decides it — the file the CLI reads, so the page opens in
 * whatever the terminal would print — and nothing is drawn until it lands: one
 * round trip to a service on this machine, and no flash of the wrong language.
 */
export function App(): React.ReactElement {
  const [language, setLanguage] = useState<Language | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchSettings(controller.signal)
      .then((settings) => {
        setApiLanguage(settings.language);
        setLanguage(settings.language);
      })
      // A page that cannot read the settings still works: the server's own
      // language is what an unqualified request already gets.
      .catch(() => setLanguage('zh'));
    return () => controller.abort();
  }, []);

  if (language === null) return <div className="h-full bg-bg" />;
  return (
    <LanguageProvider language={language}>
      <Dashboard language={language} onLanguage={setLanguage} />
    </LanguageProvider>
  );
}

/** The shell: filters, tree, and the scope the route selects. */
function Dashboard({
  language,
  onLanguage,
}: {
  language: Language;
  onLanguage: (next: Language) => void;
}): React.ReactElement {
  const t = useT();
  const navigate = useNavigate();
  // `useParams` only sees the params of a matched route *below* it, and the tree
  // lives above `<Routes>`: `useMatch` answers the same question from anywhere.
  const projectMatch = useMatch('/p/:id');
  const sessionMatch = useMatch('/s/:uid');

  const [filters, setFilters] = useState<FilterState>({ range: 'all', agents: [], search: '' });
  const [bucket, setBucket] = useState<'day' | 'hour'>('day');
  const [metric, setMetric] = useState<SeriesMetric>('cost');
  // `?theme=light` is the documented way to check the other palette (and to take
  // a screenshot of it): the class on <html> is the only switch.
  const [dark, setDark] = useState(() => new URLSearchParams(window.location.search).get('theme') !== 'light');
  const [sidebar, setSidebar] = useState(false);
  /** Bumped after a settings write, so the numbers behind the page are re-read. */
  const [configTick, setConfigTick] = useState(0);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [points, setPoints] = useState<TimeseriesBucket[]>([]);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);

  const selectedProjectId = decodeParam(projectMatch?.params.id);
  const selectedUid = decodeParam(sessionMatch?.params.uid);

  const apiFilters: ApiFilters = useMemo(
    () => ({ range: filters.range, agents: filters.agents, projects: [], search: filters.search }),
    [filters],
  );

  // The dashboard and the series are one query: fetch them together, abort the
  // previous pair when the filters change again before it lands.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void Promise.all([
      fetchDashboard(apiFilters, controller.signal),
      fetchTimeseries(apiFilters, bucket, controller.signal),
    ])
      .then(([nextDashboard, series]) => {
        setDashboard(nextDashboard);
        setPoints(series.points);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError((cause as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [apiFilters, bucket, tick, configTick]);

  // The session panel follows the route.
  useEffect(() => {
    if (selectedUid === null) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    fetchSession(selectedUid, apiFilters, controller.signal)
      .then((answer) => {
        setDetail(answer.detail);
        setDetailError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setDetail(null);
        setDetailError((cause as Error).message);
      });
    return () => controller.abort();
  }, [selectedUid, apiFilters, tick, configTick]);

  // The theme is one class on <html>, which is where index.css switches colours.
  useEffect(() => {
    document.documentElement.classList.toggle('light', !dark);
  }, [dark]);

  const project = useMemo(
    () => dashboard?.projects.find((candidate) => candidate.id === selectedProjectId) ?? null,
    [dashboard, selectedProjectId],
  );

  const onRefresh = useCallback((): void => {
    setRefreshing(true);
    void refreshApi()
      .then(() => setTick((value) => value + 1))
      .catch((cause: unknown) => setError((cause as Error).message))
      .finally(() => setRefreshing(false));
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg text-fg">
      <Filters
        dashboard={dashboard}
        language={language}
        onLanguage={onLanguage}
        filters={filters}
        onChange={setFilters}
        onRefresh={onRefresh}
        refreshing={refreshing}
        dark={dark}
        onToggleTheme={() => setDark((value) => !value)}
        onToggleSidebar={() => setSidebar((open) => !open)}
        onOpenSettings={() => navigate('/settings')}
      />

      <div className="flex min-h-0 flex-1">
        <aside
          className={`${sidebar ? 'absolute inset-y-0 left-0 z-30 w-80 border-r border-line bg-panel shadow-xl' : 'hidden'} min-h-0 shrink-0 lg:relative lg:block lg:w-[340px] lg:border-r lg:border-line lg:bg-panel/60`}
        >
          {dashboard === null ? (
            <p className="px-3 py-4 text-[12px] text-faint">{t.app.loading}</p>
          ) : (
            <ProjectTree
              dashboard={dashboard}
              symbol={dashboard.currencySymbol}
              selectedProjectId={selectedProjectId}
              selectedSessionUid={selectedUid}
              onSelectProject={(id) => {
                setSidebar(false);
                navigate(id === null ? '/' : `/p/${encodeURIComponent(id)}`);
              }}
              onSelectSession={(uid) => {
                setSidebar(false);
                navigate(`/s/${encodeURIComponent(uid)}`);
              }}
            />
          )}
        </aside>

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3">
          {error !== null && (
            <div className="mb-3">
              <Notice tone="bad" title={t.app.requestFailed}>
                {error}
              </Notice>
            </div>
          )}
          <Routes>
            <Route
              path="/"
              element={
                dashboard === null ? (
                  <Notice title={t.app.loading}>{t.app.loadingHint}</Notice>
                ) : (
                  <ScopeView
                    dashboard={dashboard}
                    project={null}
                    points={points}
                    bucket={bucket}
                    metric={metric}
                    onBucket={setBucket}
                    onMetric={setMetric}
                    symbol={dashboard.currencySymbol}
                    dark={dark}
                    loading={loading}
                  />
                )
              }
            />
            <Route
              path="/p/:id"
              element={
                dashboard === null ? (
                  <Notice title={t.app.loading}>{t.app.loadingHint}</Notice>
                ) : project === null ? (
                  <Notice tone="warn" title={t.app.noProject}>
                    {t.app.noProjectHint}
                  </Notice>
                ) : (
                  <ScopeView
                    dashboard={dashboard}
                    project={project}
                    points={points}
                    bucket={bucket}
                    metric={metric}
                    onBucket={setBucket}
                    onMetric={setMetric}
                    symbol={dashboard.currencySymbol}
                    dark={dark}
                    loading={loading}
                  />
                )
              }
            />
            <Route
              path="/settings"
              element={
                <Settings
                  dashboard={dashboard}
                  onLanguage={onLanguage}
                  onSaved={() => setConfigTick((value) => value + 1)}
                />
              }
            />
            <Route
              path="/s/:uid"
              element={
                <SessionDetailPanel detail={detail} symbol={dashboard?.currencySymbol ?? ''} loading={loading} error={detailError} />
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
