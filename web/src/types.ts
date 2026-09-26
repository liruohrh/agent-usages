/**
 * The API contract, mirrored from `src/serve/types.ts`.
 *
 * The server is the authority; this file exists so the browser can be typed
 * without importing server code (the front end is a separate package with no
 * access to `src/`). It is kept deliberately narrow — only the fields the
 * dashboard reads — so a server-side addition never breaks the build.
 */

export interface TokenBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface CostTotals {
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheHitInputCost: string;
  cacheMissInputCost: string;
  outputCost: string;
  cacheWriteInputCost: string;
  reasoningCost: string;
  total: string;
}

export interface TokenBucketShare {
  tokens: number;
  share: number;
  cost: string;
}

export type TokenBreakdown = Record<string, TokenBucketShare>;

export interface AgentTotals {
  id: string;
  label: string;
  source: string;
  sessions: number;
  subagentSessions: number;
  activeSessions: number;
  requests: number;
  unpriced: number;
  firstUsage: number | null;
  lastUsage: number | null;
  tokens: TokenBuckets;
  cost: CostTotals;
}

export interface DashboardTotals {
  sessions: number;
  subagentSessions: number;
  activeSessions: number;
  projects: number;
  workspaces: number;
  requests: number;
  unpriced: number;
  firstUsage: number | null;
  lastUsage: number | null;
  tokens: TokenBuckets;
  tokenBreakdown: TokenBreakdown;
  cost: CostTotals;
  /** The scope's own work (the CLI's `自身` line). */
  own: ScopeFigures;
  /** What those same roots spawned, folded (the CLI's `子代理` line). */
  spawned: ScopeFigures;
}

export interface ScopeFigures {
  sessions: number;
  requests: number;
  tokens: TokenBuckets;
  cost: CostTotals;
}

export interface SessionNode {
  uid: string;
  id: string;
  agent: string;
  projectId: string;
  projectName: string;
  workspace: string;
  title: string | null;
  cwd: string | null;
  createdAt: number | null;
  firstUsage: number | null;
  lastUsage: number | null;
  requests: number;
  tokens: TokenBuckets;
  cost: CostTotals;
  isSubagent: boolean;
  depth: number;
  archived: boolean;
  subagentCount: number;
  parentId: string | null;
  own: ScopeFigures;
  spawned: ScopeFigures;
  total: ScopeFigures;
}

export interface WorkspaceNode {
  path: string;
  name: string;
  agents: string[];
  repo?: { name: string; root: string; kind: string; branch?: string | undefined } | undefined;
  sessionCount: number;
  subagentCount: number;
  activeSessions: number;
  requests: number;
  tokens: TokenBuckets;
  cost: CostTotals;
  agentTotals: AgentTotals[];
  /** The workspace's own work (the CLI's `自身` line). */
  own: ScopeFigures;
  /** What those same roots spawned, folded (the CLI's `子代理` line). */
  spawned: ScopeFigures;
  sessionReports: SessionNode[];
}

export interface ModelRow {
  agent: string;
  projectId: string;
  model: string;
  requests: number;
  tokens: TokenBuckets;
  cost: CostTotals;
}

export interface BandComponentRow {
  id: string;
  label: string;
  rate: string;
  per: number;
  tokens: number;
  amount: string;
  excess?: { tokens: number; rate: string; amount: string } | undefined;
  ttl?: { tier: string; multiplier: string; tokens: number } | undefined;
}

export interface BandRow {
  agent: string;
  projectId: string;
  model: string;
  periodId: string;
  periodLabel: string;
  window: string;
  tier: string;
  resolution: string;
  requests: number;
  tokens: TokenBuckets;
  cost: CostTotals;
  components: BandComponentRow[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  kind: 'repo' | 'path';
  workspaces: string[];
  agents: string[];
  sessions: number;
  subagentSessions: number;
  activeSessions: number;
  requests: number;
  unpriced: number;
  firstUsage: number | null;
  lastUsage: number | null;
  tokens: TokenBuckets;
  tokenBreakdown: TokenBreakdown;
  cost: CostTotals;
  agentTotals: AgentTotals[];
  /** The project's own work (the CLI's `自身` line). */
  own: ScopeFigures;
  /** What those same roots spawned, folded (the CLI's `子代理` line). */
  spawned: ScopeFigures;
  workspaceNodes: WorkspaceNode[];
  sessionReports: SessionNode[];
  models: ModelRow[];
  bands: BandRow[];
  repo?: { name: string; root: string; kind: string } | undefined;
}

export interface RepoNode {
  name: string;
  root: string;
  projects: string[];
  agents: string[];
  sessions: number;
  requests: number;
  tokens: TokenBuckets;
  cost: CostTotals;
  agentTotals: AgentTotals[];
}

export interface SeriesPoint {
  t: number;
  bucket: 'day' | 'hour';
  agent: string;
  projectId: string;
  requests: number;
  tokens: TokenBuckets;
  cost: string;
}

export interface TimeseriesBucket {
  t: number;
  date: string;
  label: string;
  requests: number;
  tokens: TokenBuckets;
  cost: string;
  byAgent: Record<string, { requests: number; tokens: TokenBuckets; cost: string }>;
}

export interface DashboardWarning {
  code: string;
  message: string;
  params?: Record<string, unknown>;
}

/** The languages this build ships; the page can be switched between them. */
export type Language = 'zh' | 'en';

/** `GET`/`PUT /api/settings`: the language, and where it is remembered. */
export interface SettingsPayload {
  /** The language in effect for this answer. */
  language: Language;
  /** The language written in the configuration file, if any. */
  configured: Language | null;
  /** The file a `PUT` writes to. */
  path: string;
  /** Every language this build speaks. */
  languages: Language[];
}

/** A `GET /api/config` answer: the file the settings page edits. */
export interface ConfigPayload {
  /** The file the page reads and writes. */
  path: string;
  /** Whether the file exists yet. */
  exists: boolean;
  /** The file's own JSON — what the page edits, so `~` stays `~`. */
  document: Record<string, unknown>;
  /** The same file after the readers, for showing what the tool took from it. */
  config: {
    language: Language | null;
    currency: string | null;
    rateMode: 'latest' | 'historical' | null;
    rateSource: string | null;
    updates: { pricing: boolean; rates: boolean };
    projects: { name: string; paths: string[] }[];
    pricingProviders: string[];
  };
  /** Problems found while reading it. */
  warnings: { code: string; message: string; params?: Record<string, unknown> }[];
}

/** The keys `PUT /api/config` accepts. */
export interface ConfigPatch {
  projects?: { name: string; paths: string[] }[];
  currency?: string;
  rateMode?: 'latest' | 'historical';
  rateSource?: string;
  updates?: { pricing: boolean; rates: boolean };
}

/** A `PUT /api/config` answer: the file after the write, plus how the rescan went. */
export interface ConfigSaved extends ConfigPayload {
  refresh: RefreshReport;
}

export interface DashboardMeta {
  generatedAt: number;
  mode: 'live' | 'snapshot';
  source: string;
  scannedAt: number;
  scanMs: number;
  loadedAgents: { id: string; label: string; source: string }[];
  currency: string;
  currencySymbol: string;
  pricingProvider: string;
  pricingLabel: string;
  rangeLabel: string;
  rangeFrom: number | null;
  rangeTo: number | null;
}

export interface Dashboard extends DashboardMeta {
  agents: AgentTotals[];
  totals: DashboardTotals;
  projects: ProjectSummary[];
  repos: RepoNode[];
  timeseries: { day: SeriesPoint[]; hour: SeriesPoint[] };
  models: ModelRow[];
  bands: BandRow[];
  warnings: DashboardWarning[];
}

export interface SessionTreeNode {
  uid: string;
  id: string;
  agent: string;
  title: string | null;
  isSubagent: boolean;
  depth: number;
  requests: number;
  tokens: TokenBuckets;
  cost: CostTotals;
  children: SessionTreeNode[];
}

export interface SessionDetail {
  session: SessionNode;
  models: ModelRow[];
  bands: BandRow[];
  ancestors: { id: string; agent: string; title: string | null }[];
  tree: SessionTreeNode;
}

export interface RefreshReport {
  ok: boolean;
  scannedAt: number;
  ms: number;
  agents: { id: string; label: string; source: string }[];
  warnings: DashboardWarning[];
  error?: string;
}

/** Which time range the dashboard is showing. */
export type RangeKey = 'today' | 'week' | 'month' | 'all';

/** Which grid the time series is drawn on. */
export type BucketKey = 'day' | 'hour';
