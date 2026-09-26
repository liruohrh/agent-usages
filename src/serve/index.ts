/**
 * The Web analysis platform's entry point.
 *
 * `src/cli/index.ts` wires `agent-usages serve` to {@link startServer} with nothing but
 * this module, which keeps the CLI file free of server details:
 *
 * ```ts
 * import { startServer } from './serve/index.ts';
 * const running = await startServer({ port: options.port, host: options.host });
 * ```
 *
 * The data layer ({@link loadDashboard} / {@link openStore}) is exported too: a
 * caller that wants the dashboard without a server — a report generator, a test —
 * can have it directly.
 */

export { startServer, createApp, defaultWebRoot } from './server.ts';
export type { ServeOptions, RunningServer } from './server.ts';
export { loadDashboard, openStore, selectAdapters, filterDashboard, aggregateTimeseries, workspaceKey } from './data.ts';
export type { DashboardOptions, DashboardQuery, DashboardStore, ScanOptions } from './data.ts';
export type {
  AgentTotals,
  BandComponentRow,
  BandRow,
  Dashboard,
  DashboardMeta,
  DashboardTotals,
  DashboardWarning,
  ModelRow,
  ProjectSummary,
  RefreshReport,
  RepoNode,
  ScopeFigures,
  SeriesPoint,
  SessionDetail,
  SessionNode,
  SessionTreeNode,
  Timeseries,
  TimeseriesBucket,
  TokenBreakdown,
  WorkspaceNode,
} from './types.ts';
