/**
 * The dashboard contract.
 *
 * Everything the Web platform exchanges is JSON in these shapes: the data layer
 * ({@link file://./data.ts}) produces them, the HTTP layer (`server.ts`) hands
 * them out unchanged, and `web/src/types.ts` mirrors them for the browser.
 *
 * The vocabulary is deliberately the one `agent-usages usage --agent all --json`
 * uses — `agents`, `totals`, `projects[].agentTotals`, `projects[].sessionReports`
 * — so a snapshot written by that command can be served by this server without
 * translation (see `readSnapshot` in `data.ts`).
 *
 * Money stays what the rest of the tool makes it: exact decimal **strings**, never
 * floats, so a total is the sum of the rows above it down to the last digit.
 */

import type { CostTotals, TokenBuckets } from '../core/types.ts';

export type { CostTotals, TokenBuckets };

/** A non-fatal problem, flattened for JSON (`UserError` carries a getter). */
export interface DashboardWarning {
  /** Diagnostic code, branchable by a script. */
  code: string;
  /** The sentence, already rendered in the active language. */
  message: string;
  /** Whatever the code needed to say it. */
  params?: Record<string, unknown>;
}

/** One agent's figures inside a scope (global, a project, a workspace). */
export interface AgentTotals {
  /** Adapter id: `dsh` / `pi` / `claude` / `codex`. */
  id: string;
  /** Display name. */
  label: string;
  /** Root the agent's data was read from. */
  source: string;
  /** Sessions counted, subagents included. */
  sessions: number;
  /** Of {@link AgentTotals.sessions}, how many are subagents. */
  subagentSessions: number;
  /** Sessions that billed at least one request in range. */
  activeSessions: number;
  /** Requests billed. */
  requests: number;
  /** Records no price list could price. */
  unpriced: number;
  /** First billed request in range, or `null`. */
  firstUsage: number | null;
  /** Last billed request in range, or `null`. */
  lastUsage: number | null;
  /** Token totals. */
  tokens: TokenBuckets;
  /** Cost totals, as display-precision decimal strings. */
  cost: CostTotals;
}

/** One token bucket's share of a scope: the count, its slice, and its money. */
export interface TokenBucketShare {
  /** Tokens in this bucket. */
  tokens: number;
  /** Fraction of all tokens in the scope, `0…1`. */
  share: number;
  /** Money this bucket's tokens cost, as a decimal string. */
  cost: string;
}

/**
 * The five buckets by name, with shares.
 *
 * Always present, always keyed `input` / `output` / `cacheRead` / `cacheWrite` /
 * `reasoning`, so the dashboard's donut does not have to re-derive the split.
 */
export type TokenBreakdown = Record<string, TokenBucketShare>;

/** The whole scope: every project, every agent, everything in range. */
export interface DashboardTotals {
  /** Sessions counted. */
  sessions: number;
  /** Of {@link DashboardTotals.sessions}, how many are subagents. */
  subagentSessions: number;
  /** Sessions that billed at least one request. */
  activeSessions: number;
  /** Projects with at least one session. */
  projects: number;
  /** Workspaces (distinct directories) across those projects. */
  workspaces: number;
  /** Requests billed. */
  requests: number;
  /** Records nothing could price. */
  unpriced: number;
  /** First billed request in range. */
  firstUsage: number | null;
  /** Last billed request in range. */
  lastUsage: number | null;
  /** Token totals. */
  tokens: TokenBuckets;
  /** The same tokens, bucket by bucket, with shares and money. */
  tokenBreakdown: TokenBreakdown;
  /** Cost totals. */
  cost: CostTotals;
  /** The scope's own work, summed the way `ProjectSummary.own` is. */
  own: ScopeFigures;
  /** What those same roots spawned, folded. */
  spawned: ScopeFigures;
}

/** One session (or subagent) as the tree and the tables show it. */
export interface SessionNode {
  /**
   * Identity of the row: `${agent}:${id}`.
   *
   * Two agents can write the same session id, so every lookup the UI does — the
   * tree, the detail panel — keys on this rather than on {@link SessionNode.id}.
   */
  uid: string;
  /** Session id, as the agent wrote it. */
  id: string;
  /** Which agent this session belongs to. */
  agent: string;
  /** Owning project id. */
  projectId: string;
  /** Owning project name. */
  projectName: string;
  /** Workspace directory this session ran in. */
  workspace: string;
  /** Session title, when the agent stores one. */
  title: string | null;
  /** Working directory, when known. */
  cwd: string | null;
  /** Session creation time. */
  createdAt: number | null;
  /** First billed request in range. */
  firstUsage: number | null;
  /** Last billed request in range. */
  lastUsage: number | null;
  /** Requests this row stands for. */
  requests: number;
  /** Token totals. */
  tokens: TokenBuckets;
  /** Cost totals. */
  cost: CostTotals;
  /** Whether this row is a subagent session. */
  isSubagent: boolean;
  /** Delegation depth: `0` for a session a human started. */
  depth: number;
  /** Whether the agent archived it. */
  archived: boolean;
  /** For a top-level row: how many subagents it stands for. */
  subagentCount: number;
  /** For a subagent row: the session that spawned it. */
  parentId: string | null;
  /** This session's own work, never folded with what it spawned. */
  own: ScopeFigures;
  /** Everything it spawned. */
  spawned: ScopeFigures;
  /** `own + spawned`. */
  total: ScopeFigures;
}

/** Requests, tokens and money for one scope. */
export interface ScopeFigures {
  /** Sessions counted. */
  sessions: number;
  /** Requests billed. */
  requests: number;
  /** Token totals. */
  tokens: TokenBuckets;
  /** Cost totals. */
  cost: CostTotals;
}

/** One directory inside a project. */
export interface WorkspaceNode {
  /** Absolute path. */
  path: string;
  /** Directory name. */
  name: string;
  /** Agents that used this workspace. */
  agents: string[];
  /** Git facts, when the directory is inside a repository. */
  repo?: { name: string; root: string; kind: string; branch?: string | undefined };
  /** Sessions under it. */
  sessionCount: number;
  /** Of those, subagents. */
  subagentCount: number;
  /** Sessions that billed at least one request. */
  activeSessions: number;
  /** Requests billed. */
  requests: number;
  /** Token totals. */
  tokens: TokenBuckets;
  /** Cost totals. */
  cost: CostTotals;
  /** The same figures per agent. */
  agentTotals: AgentTotals[];
  /** The workspace's own work, the way the CLI's `自身` line reads it. */
  own: ScopeFigures;
  /** What those same roots spawned, folded. */
  spawned: ScopeFigures;
  /** Every session of this workspace, newest first. */
  sessionReports: SessionNode[];
}

/** One project: a repository, or a bare directory no repository claims. */
export interface ProjectSummary {
  /** Stable id (`repo:<root>` or `path:<path>`). */
  id: string;
  /** Display name: the repository's, or the directory's. */
  name: string;
  /** How the project was identified. */
  kind: 'repo' | 'path';
  /** Every directory that belongs to it. */
  workspaces: string[];
  /** Every agent seen in it. */
  agents: string[];
  /** Sessions counted. */
  sessions: number;
  /** Of those, subagents. */
  subagentSessions: number;
  /** Sessions that billed at least one request. */
  activeSessions: number;
  /** Requests billed. */
  requests: number;
  /** Records nothing could price. */
  unpriced: number;
  /** First billed request in range. */
  firstUsage: number | null;
  /** Last billed request in range. */
  lastUsage: number | null;
  /** Token totals. */
  tokens: TokenBuckets;
  /** The same tokens, bucket by bucket. */
  tokenBreakdown: TokenBreakdown;
  /** Cost totals: the sum of {@link ProjectSummary.agentTotals}. */
  cost: CostTotals;
  /** Per-agent figures. Σ over agents === this project's own totals. */
  agentTotals: AgentTotals[];
  /** The project's own work, the way the CLI's `自身` line reads it. */
  own: ScopeFigures;
  /** What those same roots spawned, folded. */
  spawned: ScopeFigures;
  /** Per-workspace breakdown, the tree's middle level. */
  workspaceNodes: WorkspaceNode[];
  /** Every session, subagents included, newest first. */
  sessionReports: SessionNode[];
  /** Per-model figures. */
  models: ModelRow[];
  /** Per (model, price period, tier) figures. */
  bands: BandRow[];
  /** Git repository this project is, when it is one. */
  repo?: { name: string; root: string; kind: string } | undefined;
}

/** One model's figures inside a scope. */
export interface ModelRow {
  /** Agent the model was billed by. */
  agent: string;
  /** Project id the usage belongs to. */
  projectId: string;
  /** Model as reported, verbatim. */
  model: string;
  /** Requests priced under it. */
  requests: number;
  /** Token totals. */
  tokens: TokenBuckets;
  /** Cost totals. */
  cost: CostTotals;
}

/** One billed item inside a band: the published rate and what it charged. */
export interface BandComponentRow {
  /** Component id from the price list, e.g. `input-miss`. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Published rate, per {@link BandComponentRow.per} tokens. */
  rate: string;
  /** Tokens one `rate` unit covers. */
  per: number;
  /** Tokens this component charged. */
  tokens: number;
  /** Money produced, as a decimal string. */
  amount: string;
  /** Long-context tranche, when one moved money. */
  excess?: { tokens: number; rate: string; amount: string } | undefined;
  /** Cache-write TTL tier, when one scaled the rate. */
  ttl?: { tier: string; multiplier: string; tokens: number } | undefined;
}

/** One (model, price period, tier) group: the "计价区间" table's rows. */
export interface BandRow {
  /** Agent the band was billed by. */
  agent: string;
  /** Project id the band belongs to. */
  projectId: string;
  /** Model billed. */
  model: string;
  /** Period id (conventionally its effective date). */
  periodId: string;
  /** Period label. */
  periodLabel: string;
  /** When the period is in effect, as the provider describes it. */
  window: string;
  /** Tier within the period. */
  tier: string;
  /** How the period was selected: exact, or which fallback. */
  resolution: string;
  /** Requests billed under this band. */
  requests: number;
  /** Token totals. */
  tokens: TokenBuckets;
  /** Cost totals. */
  cost: CostTotals;
  /** The rate card that produced the money. */
  components: BandComponentRow[];
}

/** One repository, rolled up across the projects it owns. */
export interface RepoNode {
  /** Repository display name. */
  name: string;
  /** Absolute path of the main working tree. */
  root: string;
  /** Ids of the projects inside it. */
  projects: string[];
  /** Every agent seen in it. */
  agents: string[];
  /** Sessions counted. */
  sessions: number;
  /** Requests billed. */
  requests: number;
  /** Token totals. */
  tokens: TokenBuckets;
  /** Cost totals. */
  cost: CostTotals;
  /** Per-agent figures. */
  agentTotals: AgentTotals[];
}

/** One (bucket, agent, project) cell of the usage over time. */
export interface SeriesPoint {
  /** Bucket start, milliseconds since the Unix epoch, on the local clock. */
  t: number;
  /** Which grid the point sits on. */
  bucket: 'day' | 'hour';
  /** Agent that billed it. */
  agent: string;
  /** Project it belongs to. */
  projectId: string;
  /** Requests billed in the bucket. */
  requests: number;
  /** Token totals for the bucket. */
  tokens: TokenBuckets;
  /** Money for the bucket, as a decimal string. */
  cost: string;
}

/** Usage over time, on both grids, in sparse long form. */
export interface Timeseries {
  /** One point per (day, agent, project) that billed anything. */
  day: SeriesPoint[];
  /** One point per (hour, agent, project), for the recent window only. */
  hour: SeriesPoint[];
}

/** Everything `GET /api/summary` and the dashboard payload carry about the run. */
export interface DashboardMeta {
  /** Generated at, milliseconds since the Unix epoch. */
  generatedAt: number;
  /** Where the numbers came from. */
  mode: 'live' | 'snapshot';
  /** Human-readable description of the data root. */
  source: string;
  /** When the data was last read. */
  scannedAt: number;
  /** How long that read took. */
  scanMs: number;
  /** Agents that contributed data, in adapter order. */
  loadedAgents: { id: string; label: string; source: string }[];
  /** ISO code the money is in. */
  currency: string;
  /** Symbol printed beside amounts. */
  currencySymbol: string;
  /** Pricing provider that supplied the rates. */
  pricingProvider: string;
  /** Its display name. */
  pricingLabel: string;
  /** Range applied, as one label. */
  rangeLabel: string;
  /** Inclusive lower bound, or `null` for "from the beginning". */
  rangeFrom: number | null;
  /** Exclusive upper bound, or `null` for "up to now". */
  rangeTo: number | null;
}

/** The whole dashboard: what `/api/summary` returns, plus the row detail. */
export interface Dashboard extends DashboardMeta {
  /** Per-agent figures, in adapter order. Σ over agents === {@link Dashboard.totals}. */
  agents: AgentTotals[];
  /** Every agent's figures added up. */
  totals: DashboardTotals;
  /** Projects, newest activity first. */
  projects: ProjectSummary[];
  /** Repositories, for the grouping the CLI also reports. */
  repos: RepoNode[];
  /** Usage over time. */
  timeseries: Timeseries;
  /** Every model seen, per agent and project. */
  models: ModelRow[];
  /** Every price band seen, per agent and project. */
  bands: BandRow[];
  /** Non-fatal problems, from the adapters or from the scan itself. */
  warnings: DashboardWarning[];
}

/** The `agents` array the contract puts at the top level, minus per-project scopes. */
export type AgentSummary = AgentTotals;

/** A `GET /api/sessions/:id` answer: one session and everything under it. */
export interface SessionDetail {
  /** The session itself, with its own/spawned/total split. */
  session: SessionNode;
  /** The same figures, per model. */
  models: ModelRow[];
  /** The same figures, per price band. */
  bands: BandRow[];
  /** Ancestors, nearest parent first, so a UI can offer a way back up. */
  ancestors: { id: string; agent: string; title: string | null }[];
  /** The delegation tree rooted at this session (itself included). */
  tree: SessionTreeNode;
}

/** One node of the delegation tree. */
export interface SessionTreeNode {
  /** Identity of the row: `${agent}:${id}`. */
  uid: string;
  /** Session id. */
  id: string;
  /** Agent it belongs to. */
  agent: string;
  /** Title, when known. */
  title: string | null;
  /** Whether it is a subagent. */
  isSubagent: boolean;
  /** Delegation depth relative to the dataset root. */
  depth: number;
  /** Requests it billed on its own. */
  requests: number;
  /** Its own tokens. */
  tokens: TokenBuckets;
  /** Its own cost. */
  cost: CostTotals;
  /** Sessions it spawned. */
  children: SessionTreeNode[];
}

/** A `GET /api/timeseries` answer: one point per bucket, agents split out. */
export interface TimeseriesBucket {
  /** Bucket start, milliseconds since the Unix epoch. */
  t: number;
  /** `YYYY-MM-DD` on the local clock. */
  date: string;
  /** `YYYY-MM-DD HH:00` for hour buckets, `YYYY-MM-DD` for day buckets. */
  label: string;
  /** Requests in the bucket. */
  requests: number;
  /** Token totals in the bucket. */
  tokens: TokenBuckets;
  /** Money in the bucket, as a decimal string. */
  cost: string;
  /** The same, per agent id. */
  byAgent: Record<string, { requests: number; tokens: TokenBuckets; cost: string }>;
}

/** A `POST /api/refresh` answer. */
export interface RefreshReport {
  /** Whether the rescan completed without throwing. */
  ok: boolean;
  /** When it finished. */
  scannedAt: number;
  /** How long it took. */
  ms: number;
  /** Agents that contributed data afterwards. */
  agents: { id: string; label: string; source: string }[];
  /** Problems met while rescanning. */
  warnings: DashboardWarning[];
  /** The error, when `ok` is `false`. */
  error?: string;
}
