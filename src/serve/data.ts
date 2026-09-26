/**
 * The dashboard's data layer.
 *
 * One job: turn the four agents' on-disk state into the {@link Dashboard} the
 * HTTP layer hands out. It does that by reusing the modules the CLI already
 * trusts — the adapters (`src/agents/registry.ts`) read the data, the merge layer
 * (`src/core/merge.ts`) makes one dataset of several agents, and `runQuery`
 * (`src/report.ts`) prices it and builds the per-project / per-session rows — and
 * adds only what a browser needs on top: an explicit workspace level, usage over
 * time, and a session tree.
 *
 * Two modes:
 *
 * - **live** — scan every agent's data root on start (and on every `--refresh`),
 *   then answer requests from memory. Requests are cheap; the scan is not.
 * - **snapshot** — read one JSON file instead of touching any agent's data. The
 *   file is either this layer's own dump (`agent-usages serve --write-snapshot`)
 *   or the contract `usage --agent all --json` prints. The second has no
 *   per-record timestamps, so its time series comes out empty and a warning says
 *   so.
 *
 * Nothing here writes: the tool reports on agents, it never modifies them.
 *
 * ## Numbers add up
 *
 * Every level is a sum of the level below, and the levels below are the report's
 * own rows — never a second pricing pass:
 *
 * - a project's `agentTotals` are `ProjectReport.agentTotals`;
 * - a project's `models` / `bands` are its sessions' own model and band rows,
 *   summed over the sessions that *root* a delegation subtree (a subagent's
 *   usage is already inside its parent's row);
 * - the global totals are `UsageResult.agents` added up.
 *
 * The one exception is the time series, which is priced on its own (day, agent,
 * project) grid — there is no per-bucket money in the report to sum — and is
 * therefore stated at display precision like every other amount.
 *
 * ## One grouping, one answer
 *
 * Live mode hands every dataset to `mergeDatasets` (`src/core/merge.ts`) before
 * anything is priced or grouped: it is the same call the CLI makes, so the Web
 * platform and the CLI cannot file one session under two different projects. The
 * merge layer passes a lone dataset with no configured projects through
 * untouched and answers an empty dataset when no agent loaded, so this layer
 * always runs on exactly one dataset — it never re-groups projects itself, since
 * a second grouping implementation is a second answer to "where did this session
 * run", and one of the two would be wrong.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve as resolvePath, sep } from 'node:path';

import { AGENT_ADAPTERS, findAgent } from '../agents/registry.ts';
import type { AgentAdapter } from '../agents/contract.ts';
import { addCostTotals, costOf, zeroCostTotals } from '../accounting.ts';
import { resolveConfig } from '../config/resolve.ts';
import { mergeDatasets } from '../core/merge.ts';
import type { CostTotals, TokenBuckets, UsageDataset, UsageRecord } from '../core/types.ts';
import { renderDiagnostic, type Warning } from '../i18n/errors.ts';
import { language, t } from '../i18n/index.ts';
import {
  createPricingEngine,
  currencyOf,
  providerCurrencies,
  resolvePricingProvider,
  type PricingEngine,
} from '../pricing/index.ts';
import type { PricingProvider } from '../pricing/contract.ts';
import {
  runQuery,
  type AgentTotals as ReportAgentTotals,
  type BandSummary,
  type ModelBreakdown,
  type ProjectReport,
  type RateInfo,
  type RepoGroup,
  type SessionReport,
  type UsageResult,
} from '../report.ts';
import { inRange, resolveRange, type TimeRange } from '../timerange.ts';

import type {
  AgentTotals,
  BandComponentRow,
  BandRow,
  Dashboard,
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
  TimeseriesBucket,
  TokenBreakdown,
  WorkspaceNode,
} from './types.ts';

/** How far back hour buckets are kept: older usage only needs the day grid. */
const HOUR_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** The five token buckets, in the order every table prints them. */
const BUCKET_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const;

/** Which agents to read, and from where. */
export interface ScanOptions {
  /**
   * Agent selector: `all` (the default), one id, or a comma/space separated list
   * such as `dsh,pi`.
   */
  agent?: string | undefined;
  /** Explicit data root, passed to every adapter (`--home`). */
  home?: string | undefined;
  /** Path to a JSON snapshot to read instead of scanning (`--snapshot`). */
  snapshot?: string | undefined;
  /** Skip the lazy price/rate refresh; the server always does. */
  noUpdate?: boolean | undefined;
  /** Environment to resolve default roots from. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Injectable clock, for tests. */
  now?: Date | undefined;
}

/** What a caller may ask a loaded store for. */
export interface DashboardQuery {
  /** `today` / `week` / `month` / `all`, or an explicit `from..to`. */
  range?: string | undefined;
  /** Agent ids to keep; empty or absent keeps every loaded agent. */
  agents?: readonly string[] | undefined;
  /** Project ids to keep; empty or absent keeps every project. */
  projects?: readonly string[] | undefined;
  /** Case-insensitive substring matched against project names and workspace paths. */
  search?: string | undefined;
}

/** A loaded store: the scan, plus every question that can be asked of it. */
export interface DashboardStore {
  /** Where the numbers came from. */
  readonly mode: 'live' | 'snapshot';
  /** Human-readable description of the data root. */
  readonly source: string;
  /** When the data was last read (`Date.now()`). */
  readonly scannedAt: number;
  /** How long that read took, in milliseconds. */
  readonly scanMs: number;
  /** Agents that contributed data. */
  readonly loadedAgents: { id: string; label: string; source: string }[];
  /** Problems met while scanning. */
  readonly warnings: DashboardWarning[];
  /** ISO code the money is in. */
  readonly currency: string;
  /** Symbol printed beside amounts. */
  readonly currencySymbol: string;
  /** Pricing provider that supplied the rates. */
  readonly pricingProvider: string;
  /** Its display name. */
  readonly pricingLabel: string;
  /**
   * The dashboard for a query.
   * @param query - range, agent, project and search filters.
   * @returns the dashboard, filtered and re-totalled.
   * @throws {UserError} when the range spec cannot be parsed.
   */
  dashboard(query?: DashboardQuery): Dashboard;
  /**
   * Usage over time, one point per bucket, agents split out.
   * @param options - bucket size plus the same filters as {@link DashboardStore.dashboard}.
   * @returns bucket points in ascending time order.
   */
  timeseries(options: DashboardQuery & { bucket?: 'day' | 'hour' | undefined }): TimeseriesBucket[];
  /**
   * One session with its delegation tree.
   * @param id - session id, or `agent:id` when two agents used the same id.
   * @param options - range and agent filters.
   * @returns the detail, or `undefined` when no loaded dataset knows that id.
   */
  sessionDetail(id: string, options?: DashboardQuery): SessionDetail | undefined;
  /**
   * Re-read every agent's data.
   * @returns a report of what happened; the store keeps serving the old data on failure.
   */
  refresh(): Promise<RefreshReport>;
  /**
   * Write the current dashboard as the snapshot `--snapshot` reads back.
   * @param path - file to write.
   */
  writeSnapshot(path: string): Promise<void>;
}

/** One workspace while a project is being assembled. */
interface WorkspaceDraft {
  path: string;
  name: string;
  repo?: { name: string; root: string; kind: string; branch?: string | undefined } | undefined;
  agents: Set<string>;
  agentTotals: Map<string, AgentTotals>;
  sessions: SessionNode[];
  requests: number;
  tokens: TokenBuckets;
  cost: CostTotals;
  activeSessions: number;
  subagentCount: number;
  sessionCount: number;
}

/** One project while it is being assembled from whichever producer ran. */
interface ProjectDraft {
  id: string;
  name: string;
  kind: 'repo' | 'path';
  repo?: { name: string; root: string; kind: string } | undefined;
  agents: Set<string>;
  agentTotals: Map<string, AgentTotals>;
  workspaces: Map<string, WorkspaceDraft>;
  sessions: SessionNode[];
  reports: Map<string, SessionReport>;
  models: ModelRow[];
  bands: BandRow[];
  requests: number;
  tokens: TokenBuckets;
  cost: CostTotals;
  sessionCount: number;
  activeSessions: number;
  subagentSessions: number;
  firstUsage: number | null;
  lastUsage: number | null;
}

/** What one range's build collected from the raw records. */
interface RecordFacts {
  /** Per project id: un-priced records, sessions that billed, and the span. */
  projects: Map<string, { unpriced: number; active: Set<string>; first: number | null; last: number | null }>;
  /** Per `${agent}\u0000${projectId}`: un-priced records. */
  agentProject: Map<string, number>;
  /** Per agent: un-priced records, sessions that billed, and the span. */
  agents: Map<string, { unpriced: number; active: Set<string>; first: number | null; last: number | null }>;
  /** The two time grids, in sparse long form. */
  day: Map<string, PointGroup>;
  hour: Map<string, PointGroup>;
}

/** One grid cell: where it starts, and the records it covers. */
interface PointGroup {
  point: SeriesPoint;
  records: UsageRecord[];
}

/**
 * Per-session report rows the detail endpoint answers from, keyed by session uid.
 *
 * The dashboard payload deliberately does not carry per-session model and price
 * band tables (they would multiply its size for data a detail panel asks for one
 * session at a time). They are kept here instead, beside the dashboard object
 * they belong to, and a filtered dashboard inherits them.
 */
const detailIndex = new WeakMap<Dashboard, Map<string, SessionReport>>();

// ---------------------------------------------------------------------------
// Small arithmetic helpers. Money is an exact decimal string everywhere, so the
// only addition this layer does is the one the accounting module already owns.
// ---------------------------------------------------------------------------

/** The zero token vector. */
function emptyTokens(): TokenBuckets {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

/** Add two token vectors. */
function addTokens(left: TokenBuckets, right: TokenBuckets): TokenBuckets {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    reasoning: left.reasoning + right.reasoning,
  };
}

/** Add a list of token vectors. */
function sumTokensList(list: readonly TokenBuckets[]): TokenBuckets {
  return list.reduce(addTokens, emptyTokens());
}

/** Add a list of cost totals. */
function sumCosts(list: readonly CostTotals[]): CostTotals {
  return list.reduce(addCostTotals, zeroCostTotals());
}

/** Add two decimal amounts, exactly. */
function addAmounts(left: string, right: string): string {
  return addCostTotals(asCost({ total: left }), asCost({ total: right })).total;
}

/** Add a list of decimal amounts, exactly. */
function sumAmountsList(list: readonly string[]): string {
  return list.reduce(addAmounts, '0');
}

/** Copy the five buckets out of an unknown value, defaulting each to zero. */
function asTokens(value: unknown): TokenBuckets {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Partial<TokenBuckets>;
  return {
    input: numberOr0(source.input),
    output: numberOr0(source.output),
    cacheRead: numberOr0(source.cacheRead),
    cacheWrite: numberOr0(source.cacheWrite),
    reasoning: numberOr0(source.reasoning),
  };
}

/** Copy a cost total out of an unknown value, defaulting every amount to `0`. */
function asCost(value: unknown): CostTotals {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Partial<CostTotals>;
  const amount = (key: keyof CostTotals): string => {
    const raw = source[key];
    return typeof raw === 'string' && /^[+-]?\d+(\.\d+)?$/.test(raw) ? raw : '0';
  };
  return {
    cacheHitInputTokens: numberOr0(source.cacheHitInputTokens),
    cacheMissInputTokens: numberOr0(source.cacheMissInputTokens),
    outputTokens: numberOr0(source.outputTokens),
    cacheWriteTokens: numberOr0(source.cacheWriteTokens),
    cacheHitInputCost: amount('cacheHitInputCost'),
    cacheMissInputCost: amount('cacheMissInputCost'),
    outputCost: amount('outputCost'),
    cacheWriteInputCost: amount('cacheWriteInputCost'),
    reasoningCost: amount('reasoningCost'),
    total: amount('total'),
  };
}

/** A finite number, or zero. */
function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A finite number, or `null`. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A string, or `null`. */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** `min` over the non-null values. */
function minOrNull(values: readonly (number | null)[]): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (best === null || value < best) best = value;
  }
  return best;
}

/** `max` over the non-null values. */
function maxOrNull(values: readonly (number | null)[]): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

/**
 * The five buckets with their shares and their money.
 *
 * Shares are relative to the four **billed** buckets, which are disjoint. A
 * reasoning token is already inside `output` and is never billed beside it, so
 * its row reports a share of the whole rather than one that adds up with the
 * others — which is what the footnote under the chart says.
 * @param tokens - the token totals.
 * @param cost - the money those tokens produced.
 * @returns every bucket, always all five.
 */
export function tokenBreakdownOf(tokens: TokenBuckets, cost: CostTotals): TokenBreakdown {
  const billed = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  const money: Record<string, string> = {
    input: cost.cacheMissInputCost,
    output: cost.outputCost,
    cacheRead: cost.cacheHitInputCost,
    cacheWrite: cost.cacheWriteInputCost,
    reasoning: cost.reasoningCost,
  };
  const breakdown: TokenBreakdown = {};
  for (const key of BUCKET_KEYS) {
    const count = tokens[key];
    breakdown[key] = {
      tokens: count,
      share: billed === 0 ? 0 : count / billed,
      cost: money[key] ?? '0',
    };
  }
  return breakdown;
}

/**
 * Sum a scope's `自身` / `子代理` pair over the projects under it.
 *
 * @param projects - the projects to add up.
 * @returns the two figures, zeroed when there are none.
 */
function splitOfProjects(projects: readonly ProjectSummary[]): { own: ScopeFigures; spawned: ScopeFigures } {
  let own = emptyScope();
  let spawned = emptyScope();
  for (const project of projects) {
    own = addScopes(own, project.own);
    spawned = addScopes(spawned, project.spawned);
  }
  return { own, spawned };
}

/**
 * Sum per-agent figures into a scope total.
 *
 * `split` is the `自身` / `子代理` pair the CLI prints with `--subagent`: it cannot
 * be derived from the per-agent rows, which are not kept per delegation level, so
 * whoever knows the sessions passes it in.
 */
function totalsOf(
  agents: readonly AgentTotals[],
  counts: { projects: number; workspaces: number },
  split: { own: ScopeFigures; spawned: ScopeFigures } = { own: emptyScope(), spawned: emptyScope() },
): DashboardTotals {
  const tokens = sumTokensList(agents.map((agent) => agent.tokens));
  const cost = sumCosts(agents.map((agent) => agent.cost));
  return {
    sessions: agents.reduce((total, agent) => total + agent.sessions, 0),
    subagentSessions: agents.reduce((total, agent) => total + agent.subagentSessions, 0),
    activeSessions: agents.reduce((total, agent) => total + agent.activeSessions, 0),
    projects: counts.projects,
    workspaces: counts.workspaces,
    requests: agents.reduce((total, agent) => total + agent.requests, 0),
    unpriced: agents.reduce((total, agent) => total + agent.unpriced, 0),
    firstUsage: minOrNull(agents.map((agent) => agent.firstUsage)),
    lastUsage: maxOrNull(agents.map((agent) => agent.lastUsage)),
    tokens,
    tokenBreakdown: tokenBreakdownOf(tokens, cost),
    cost,
    own: split.own,
    spawned: split.spawned,
  };
}

/** Sum a list of agent figures, one entry per agent id. */
function mergeAgentTotals(list: readonly AgentTotals[]): AgentTotals[] {
  const merged = new Map<string, AgentTotals>();
  for (const totals of list) {
    const known = merged.get(totals.id);
    if (known === undefined) {
      merged.set(totals.id, { ...totals, tokens: { ...totals.tokens }, cost: { ...totals.cost } });
      continue;
    }
    known.sessions += totals.sessions;
    known.subagentSessions += totals.subagentSessions;
    known.activeSessions += totals.activeSessions;
    known.requests += totals.requests;
    known.unpriced += totals.unpriced;
    known.tokens = addTokens(known.tokens, totals.tokens);
    known.cost = addCostTotals(known.cost, totals.cost);
    known.firstUsage = minOrNull([known.firstUsage, totals.firstUsage]);
    known.lastUsage = maxOrNull([known.lastUsage, totals.lastUsage]);
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Copy a scope's figures for a session row. */
function scopeFigures(sessions: number, requests: number, tokens: TokenBuckets, cost: CostTotals): ScopeFigures {
  return { sessions, requests, tokens, cost };
}

/** Add two scopes, field by field. */
function addScopes(left: ScopeFigures, right: ScopeFigures): ScopeFigures {
  return {
    sessions: left.sessions + right.sessions,
    requests: left.requests + right.requests,
    tokens: addTokens(left.tokens, right.tokens),
    cost: addCostTotals(left.cost, right.cost),
  };
}

/** Nothing at all, the identity of {@link addScopes}. */
function emptyScope(): ScopeFigures {
  return { sessions: 0, requests: 0, tokens: emptyTokens(), cost: zeroCostTotals() };
}

/**
 * A scope's `自身` / `子代理` split, exactly what the CLI prints with `--subagent`.
 *
 * `自身` is the work each session did itself, summed over the sessions that
 * *root* a delegation subtree; `子代理` is what those same roots spawned. A
 * subagent whose parent is in this scope is skipped: its usage is already inside
 * that parent's `自身` (the parent's records are folded with its children's), so
 * counting it again would double the scope. A fork, and a subagent whose parent
 * is elsewhere, each speak for themselves.
 *
 * @param sessions - every session of the scope, subagents included.
 * @returns the two figures, with `Σ own + Σ spawned === Σ total`.
 */
function scopeSplitOf(sessions: readonly SessionNode[]): { own: ScopeFigures; spawned: ScopeFigures } {
  const ids = new Set(sessions.map((session) => session.id));
  let own = emptyScope();
  let spawned = emptyScope();
  for (const session of sessions) {
    if (session.isSubagent && session.parentId !== null && ids.has(session.parentId)) continue;
    own = addScopes(own, session.own);
    spawned = addScopes(spawned, session.spawned);
  }
  return { own, spawned };
}

/** A default agent row, before the record pass fills in the flags it can see. */
function agentTotalsOf(report: ReportAgentTotals, labels: AgentLabelSource): AgentTotals {
  const label = labels(report.agent);
  return {
    id: report.agent,
    label: label.label,
    source: label.source,
    sessions: report.sessions,
    subagentSessions: report.subagentSessions,
    activeSessions: 0,
    requests: report.requests,
    unpriced: 0,
    firstUsage: null,
    lastUsage: null,
    tokens: report.tokens,
    cost: report.cost,
  };
}

/** Looks up an agent's display name and data root. */
type AgentLabelSource = (id: string) => { label: string; source: string };

// ---------------------------------------------------------------------------
// Paths and identity
// ---------------------------------------------------------------------------

/**
 * A directory's identity for cross-agent grouping.
 *
 * `~` expands, trailing separators go away and the path is normalized, so two
 * agents that spell the same directory differently still meet. It is deliberately
 * *not* resolved through the filesystem: a deleted checkout must keep grouping
 * with the sessions that ran in it.
 * @param path - a directory path, as an agent recorded it.
 * @returns the grouping key (empty when there is no path at all).
 */
export function workspaceKey(path: string): string {
  let text = path.trim();
  if (text.length === 0) return '';
  if (text === '~') text = homedir();
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = resolvePath(homedir(), text.slice(2));
  text = resolvePath(text);
  while (text.length > 1 && text.endsWith(sep)) text = text.slice(0, -1);
  return text;
}

/** The last segment of a path, for display. */
function baseNameOf(path: string): string {
  const trimmed = workspaceKey(path);
  return basename(trimmed.length === 0 ? path : trimmed);
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/** Flatten a diagnostic into the JSON shape. */
export function flattenWarning(item: Warning): DashboardWarning {
  const params = (item as { params?: unknown }).params;
  return {
    code: String((item as { code?: unknown }).code ?? 'warning'),
    message: item.message,
    ...(typeof params === 'object' && params !== null ? { params: params as Record<string, unknown> } : {}),
  };
}

/**
 * Re-render one warning's sentence in the process's language.
 *
 * A scan happens once and its warnings are cached with it, but the page can ask
 * for another language per request: the sentence is written from the code and the
 * parameters again. A code this build has no message for keeps the sentence it
 * came with — a warning in the wrong language still beats no warning.
 * @param item - the warning, as stored.
 * @returns the warning with its message in the active language.
 */
export function localizeWarning(item: DashboardWarning): DashboardWarning {
  const messages = t().errors as unknown as Record<string, string | ((params: never) => string)>;
  const entry = messages[item.code];
  if (entry === undefined) return item;
  const rendered = typeof entry === 'function' ? entry((item.params ?? {}) as never) : entry;
  return rendered === item.message ? item : { ...item, message: rendered };
}

/**
 * The payload's prose in the active language: the warnings and the range label.
 *
 * Everything else in a dashboard is a number, an id or a vendor's own wording, so
 * this is the whole surface a language switch has to touch.
 * @param payload - any answer carrying those two fields.
 * @param rangeSpec - the `range` query the answer was built for.
 * @returns a copy with its sentences re-rendered.
 */
export function localizeDashboard<T extends { warnings: readonly DashboardWarning[]; rangeLabel: string }>(
  payload: T,
  rangeSpec: string | undefined,
): T {
  const spec = (rangeSpec ?? '').trim();
  return {
    ...payload,
    rangeLabel: resolveRange(spec.length === 0 ? {} : { spec }).label,
    warnings: payload.warnings.map(localizeWarning),
  };
}

/** Build a warning this layer owns (the adapters keep their own codes). */
function warning(code: string, message: string, params?: Record<string, unknown>): DashboardWarning {
  return { code, message, ...(params === undefined ? {} : { params }) };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Options {@link loadDashboard} accepts: a scan plus the query to answer. */
export interface DashboardOptions extends ScanOptions, DashboardQuery {}

/**
 * Read every agent's usage and return the dashboard for one query.
 *
 * This is the entry point a one-shot caller uses; a server that answers many
 * requests should call {@link openStore} once instead and ask the store per
 * request, so the expensive scan is not repeated.
 * @param options - what to scan and what to report.
 * @returns the dashboard.
 */
export async function loadDashboard(options: DashboardOptions = {}): Promise<Dashboard> {
  const store = await openStore(options);
  return store.dashboard(options);
}

/**
 * Scan the agents (or read a snapshot) and return a store over the result.
 * @param options - scan options; query options are ignored here.
 * @returns the store.
 */
export async function openStore(options: ScanOptions = {}): Promise<DashboardStore> {
  if (options.snapshot !== undefined) return openSnapshotStore(options.snapshot, options);
  return openLiveStore(options);
}

/** Parse `--agent` into the adapters to read. */
export function selectAdapters(selector: string | undefined): AgentAdapter[] {
  const text = (selector ?? 'all').trim();
  if (text.length === 0 || text.toLowerCase() === 'all') return [...AGENT_ADAPTERS];
  const ids = text.split(/[,\s]+/).filter((id) => id.length > 0);
  return ids.map((id) => {
    const adapter = findAgent(id);
    if (adapter === undefined) {
      const known = AGENT_ADAPTERS.map((candidate) => candidate.id).join('、');
      throw new Error(t().errors.unknownAgent({ id, known }));
    }
    return adapter;
  });
}

// ---------------------------------------------------------------------------
// Live store
// ---------------------------------------------------------------------------

/**
 * The dataset a live store holds before its first scan.
 *
 * `read()` is awaited before the store leaves {@link openLiveStore}, so nothing
 * ever serves this; it exists so the store's state has a total shape, and it
 * matches what `mergeDatasets([])` answers when no agent has data.
 * @returns an empty dataset with every field present.
 */
function emptyScanDataset(): UsageDataset {
  return {
    agent: '',
    agents: [],
    source: '',
    projects: [],
    sessions: [],
    stats: { filesRead: [], sessions: 0, records: 0 },
    warnings: [],
  };
}

/** A store that scans live data and caches one dashboard per range. */
async function openLiveStore(options: ScanOptions): Promise<DashboardStore> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const adapters = selectAdapters(options.agent);

  /** Read the configuration, and build everything that depends on it. */
  const resolveRuntime = async (): Promise<{
    config: Awaited<ReturnType<typeof resolveConfig>>;
    provider: PricingProvider;
    engine: PricingEngine;
    currency: string;
    symbol: string;
    context: { engine: PricingEngine; pricingProvider: string };
    rate: RateInfo;
  }> => {
    const config = await resolveConfig({ noUpdate: options.noUpdate ?? true, env, now });
    const provider = resolvePricingProvider(undefined, adapters[0]?.id, config.providers);
    const engine = createPricingEngine(provider);
    const currency = providerCurrencies(provider)[0] ?? 'USD';
    const symbol = currencyOf(currency).symbol;
    const context = { engine, pricingProvider: provider.id };
    const rate: RateInfo = {
      base: currency,
      display: currency,
      rate: '1',
      mode: 'latest',
      reason: 'fallback-base',
      source: provider.id,
      date: '',
    };
    return { config, provider, engine, currency, symbol, context, rate };
  };

  let { config, provider, engine, currency, symbol, context, rate } = await resolveRuntime();

  /**
   * Read the configuration again.
   *
   * The file changes while the server runs: the settings page writes it, and so
   * can the person who owns it. Every scan starts here, so `POST /api/refresh` is
   * also "pick up my edits" — currency, rate mode, rate source, price overrides
   * and project declarations all take effect on the next scan.
   */
  const reloadConfig = async (): Promise<void> => {
    ({ config, provider, engine, currency, symbol, context, rate } = await resolveRuntime());
    cache.clear();
  };
  const queryOf = (range: TimeRange) => ({
    dimension: 'session' as const,
    subagentMode: 'detail' as const,
    range,
    currency,
    rate,
  });

  /** Everything a scan leaves behind for the per-range builds. */
  interface Scan {
    /** The merged dataset: one project per place, every agent's sessions in it. */
    dataset: UsageDataset;
    /** Where the numbers came from, for the page footer. */
    sources: { id: string; label: string; source: string }[];
  }

  // `read()` runs before the store is handed out, so this placeholder is never
  // served; it mirrors what the merge layer returns for no datasets at all.
  let scan: Scan = { dataset: emptyScanDataset(), sources: [] };
  let scanWarnings: DashboardWarning[] = [];
  let scannedAt = Date.now();
  let scanMs = 0;
  const cache = new Map<string, Dashboard>();

  const labels: AgentLabelSource = (id) => {
    const known = scan.sources.find((entry) => entry.id === id);
    return { label: known?.label ?? id, source: known?.source ?? '' };
  };

  /** Read every selected adapter, degrading to a warning per failure. */
  const read = async (): Promise<void> => {
    const started = Date.now();
    await reloadConfig();
    const loaded: UsageDataset[] = [];
    const sources: { id: string; label: string; source: string }[] = [];
    const warnings: DashboardWarning[] = [...config.warnings.map(flattenWarning)];
    for (const adapter of adapters) {
      const source = options.home ?? adapter.defaultSource(env);
      if (source === null || source.trim().length === 0) {
        warnings.push(
          warning(
            'serveAgentNoRoot',
            renderDiagnostic('serveAgentNoRoot', { agent: adapter.label }),
            { agent: adapter.label },
          ),
        );
        continue;
      }
      try {
        if (!(await adapter.hasData(source))) {
          warnings.push(
            warning(
              'serveAgentNoData',
              renderDiagnostic('serveAgentNoData', { agent: adapter.label, source }),
              { agent: adapter.label, source },
            ),
          );
          continue;
        }
        const dataset = await adapter.load({
          ...(options.home === undefined ? {} : { home: options.home }),
          env,
          enrich: true,
        });
        // 每个 agent 单独跑一次查询只为取它自己的告警：合成之后，报告不再区分告警来自哪个 agent。
        const result = runQuery(dataset, queryOf(resolveRange({})), context);
        loaded.push(dataset);
        sources.push({ id: adapter.id, label: adapter.label, source: dataset.source });
        for (const item of result.warnings) {
          // "nothing billed" is a per-agent fact the dashboard states itself.
          if (item.code === 'noUsageInRange') continue;
          warnings.push(flattenWarning(item));
        }
      } catch (error) {
        warnings.push(
          warning(
            'serveAgentLoadFailed',
            renderDiagnostic('serveAgentLoadFailed', {
              agent: adapter.label,
              reason: (error as Error).message,
            }),
            { agent: adapter.label, reason: (error as Error).message },
          ),
        );
      }
    }

    // 实时模式只有这一条路：合并层把 N 份 dataset 合成一份（一份都没有时给空数据集）。
    // 它同时也是 CLI 用的那个函数，所以两个入口对"同一份数据属于哪个项目"只有一个答案。
    const dataset = await mergeDatasets(loaded, { projects: config.projects ?? [] });
    scan = { dataset, sources };
    scanWarnings = warnings;
    cache.clear();
    scanMs = Date.now() - started;
    scannedAt = Date.now();
  };

  /**
   * 一次只跑一个扫描：后来者搭上正在跑的那一个。
   *
   * `refresh()` 有两个互不知情的调用者——`--refresh` 定时器和 `POST /api/refresh`。
   * 一次全量扫描要几秒，定时器周期比它短时，逐个 tick 各起一次扫描会越堆越多，
   * 每个请求都排在它们后面，最后连手动重扫也不返回。共享同一个 promise 就没有这个问题。
   */
  let inFlight: Promise<void> | undefined;
  const scanOnce = (): Promise<void> => {
    if (inFlight === undefined) {
      inFlight = read().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };

  /**
   * Build (and memoize) the dashboard for one range spec.
   *
   * The language is part of the key because a dashboard is not only numbers: the
   * price-band windows are prose the pricing engine wrote while building it
   * (`… → 至今 (UTC+08:00)`). One cache entry per language, so a request in
   * English never inherits the Chinese one — the scan itself is still shared.
   */
  const build = (rangeSpec: string | undefined): Dashboard => {
    const key = `${(rangeSpec ?? '').trim()}\u0000${language()}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const spec = (rangeSpec ?? '').trim();
    const range = resolveRange(spec.length === 0 ? {} : { spec });
    const result = runQuery(scan.dataset, queryOf(range), context);
    const built = buildDashboard({
      datasets: [scan.dataset],
      mergedResult: result,
      range,
      engine,
      pricingProvider: provider.id,
      pricingLabel: provider.label,
      currency,
      currencySymbol: symbol,
      source: options.home ?? describeSources(scan.sources),
      sources: scan.sources,
      labels,
      scannedAt,
      scanMs,
      warnings: scanWarnings,
      now: Date.now(),
    });
    cache.set(key, built);
    return built;
  };

  // 首次扫描走同一条单飞路径：起服务时也可能已有别的调用者（例如并发的 refresh）。
  await scanOnce();

  const store: DashboardStore = {
    get mode() {
      return 'live' as const;
    },
    get source() {
      return options.home ?? describeSources(scan.sources);
    },
    get scannedAt() {
      return scannedAt;
    },
    get scanMs() {
      return scanMs;
    },
    get loadedAgents() {
      return scan.sources;
    },
    get warnings() {
      return scanWarnings;
    },
    currency,
    currencySymbol: symbol,
    pricingProvider: provider.id,
    pricingLabel: provider.label,
    dashboard(query = {}) {
      return filterDashboard(build(query.range), query);
    },
    timeseries(query = {}) {
      return aggregateTimeseries(store.dashboard(query), query.bucket ?? 'day');
    },
    sessionDetail(id, query = {}) {
      const dash = store.dashboard(query);
      const detail = detailFromDashboard(dash, id);
      if (detail !== undefined) return detail;
      return detailFromDatasets([scan.dataset], dash, id);
    },
    async refresh() {
      const started = Date.now();
      try {
        await scanOnce();
        return { ok: true, scannedAt, ms: Date.now() - started, agents: store.loadedAgents, warnings: scanWarnings };
      } catch (error) {
        return {
          ok: false,
          scannedAt,
          ms: Date.now() - started,
          agents: store.loadedAgents,
          warnings: scanWarnings,
          error: (error as Error).message,
        };
      }
    },
    async writeSnapshot(target) {
      await writeFile(target, `${JSON.stringify(store.dashboard(), null, 2)}\n`, 'utf8');
    },
  };
  return store;
}

/** Where the data actually came from, when no `--home` pinned it. */
function describeSources(sources: readonly { id: string; source: string }[]): string {
  if (sources.length === 0) return '（没有可读的 agent 数据）';
  if (sources.length === 1) return sources[0]?.source ?? '（没有可读的 agent 数据）';
  return sources.map((entry) => `${entry.id}: ${entry.source}`).join(' · ');
}

// ---------------------------------------------------------------------------
// Building the dashboard
// ---------------------------------------------------------------------------

/** Everything {@link buildDashboard} needs beyond the scan. */
interface BuildInput {
  /** The one merged dataset, for the record-level facts the report does not carry. */
  datasets: readonly UsageDataset[];
  /** The merged dataset's report for this range. */
  mergedResult: UsageResult;
  range: TimeRange;
  engine: PricingEngine;
  pricingProvider: string;
  pricingLabel: string;
  currency: string;
  currencySymbol: string;
  source: string;
  sources: { id: string; label: string; source: string }[];
  labels: AgentLabelSource;
  scannedAt: number;
  scanMs: number;
  warnings: readonly DashboardWarning[];
  now: number;
}

/** Fold the report into the dashboard shape for one range. */
function buildDashboard(input: BuildInput): Dashboard {
  const { engine } = input;
  const drafts = draftsFromResult(input.mergedResult, input.labels);
  const facts = collectFacts(input);
  for (const draft of drafts.projects) {
    const fact = facts.projects.get(draft.id);
    draft.activeSessions = fact?.active.size ?? draft.activeSessions;
    draft.firstUsage = fact?.first ?? draft.firstUsage;
    draft.lastUsage = fact?.last ?? draft.lastUsage;
    for (const totals of draft.agentTotals.values()) {
      const agentFact = facts.agents.get(totals.id);
      const projectFact = facts.agentProject.get(`${totals.id}\u0000${draft.id}`);
      totals.unpriced = projectFact ?? 0;
      totals.activeSessions = countActive(facts, totals.id, draft.id);
      totals.firstUsage = agentFact?.first ?? null;
      totals.lastUsage = agentFact?.last ?? null;
    }
  }
  const projects = drafts.projects
    .map((draft) => finishProject(draft))
    .sort((left, right) => (right.lastUsage ?? 0) - (left.lastUsage ?? 0) || left.name.localeCompare(right.name));

  // The global per-agent rows are the report's own, so the cards at the top and
  // the rows under them cannot disagree.
  const reportAgents = input.mergedResult.agents;
  const agentTotals = mergeAgentTotals(reportAgents.map((totals) => agentTotalsOf(totals, input.labels))).map(
    (totals) => {
      const fact = facts.agents.get(totals.id);
      return {
        ...totals,
        unpriced: fact?.unpriced ?? 0,
        activeSessions: fact?.active.size ?? 0,
        firstUsage: fact?.first ?? null,
        lastUsage: fact?.last ?? null,
      };
    },
  );

  const totals = totalsOf(
    agentTotals,
    {
      projects: projects.length,
      workspaces: projects.reduce((total, project) => total + project.workspaces.length, 0),
    },
    splitOfProjects(projects),
  );

  const dashboard: Dashboard = {
    generatedAt: Date.now(),
    mode: 'live',
    source: input.source,
    scannedAt: input.scannedAt,
    scanMs: input.scanMs,
    loadedAgents: input.sources,
    currency: input.currency,
    currencySymbol: input.currencySymbol,
    pricingProvider: input.pricingProvider,
    pricingLabel: input.pricingLabel,
    rangeLabel: input.range.label,
    rangeFrom: input.range.from,
    rangeTo: input.range.to,
    agents: agentTotals,
    totals,
    projects,
    repos: drafts.repos,
    timeseries: { day: pricePoints(facts.day, engine), hour: pricePoints(facts.hour, engine) },
    models: mergeModelRows(drafts.projects.flatMap((draft) => draft.models)),
    bands: mergeBandRows(drafts.projects.flatMap((draft) => draft.bands)),
    warnings: [...input.warnings],
  };
  detailIndex.set(dashboard, drafts.reports);
  return dashboard;
}

/** How many sessions of one agent billed inside one project. */
function countActive(facts: RecordFacts, agent: string, projectId: string): number {
  let count = 0;
  for (const sessionUid of facts.projects.get(projectId)?.active ?? []) {
    if (sessionUid.startsWith(`${agent}:`)) count += 1;
  }
  return count;
}

/** What the raw records say: un-priced counts, active sessions, spans, series. */
function collectFacts(input: BuildInput): RecordFacts {
  const facts: RecordFacts = {
    projects: new Map(),
    agentProject: new Map(),
    agents: new Map(),
    day: new Map(),
    hour: new Map(),
  };

  for (const dataset of input.datasets) {
    for (const project of dataset.projects) {
      // 合并数据集的项目 id 就是 dashboard 的项目 id——同一份数据只分过一次组。
      const projectId = project.id;
      for (const session of project.sessions) {
        const uid = `${session.agent}:${session.id}`;
        for (const record of session.records) {
          if (!inRange(record.time, input.range)) continue;
          const priced = input.engine.resolve(record) === undefined;
          const projectFact = facts.projects.get(projectId) ?? { unpriced: 0, active: new Set<string>(), first: null, last: null };
          if (priced) projectFact.unpriced += 1;
          projectFact.active.add(uid);
          projectFact.first = minOrNull([projectFact.first, record.time]);
          projectFact.last = maxOrNull([projectFact.last, record.time]);
          facts.projects.set(projectId, projectFact);

          const agentFact = facts.agents.get(session.agent) ?? { unpriced: 0, active: new Set<string>(), first: null, last: null };
          if (priced) agentFact.unpriced += 1;
          agentFact.active.add(uid);
          agentFact.first = minOrNull([agentFact.first, record.time]);
          agentFact.last = maxOrNull([agentFact.last, record.time]);
          facts.agents.set(session.agent, agentFact);

          if (priced) {
            const agentProjectKey = `${session.agent}\u0000${projectId}`;
            facts.agentProject.set(agentProjectKey, (facts.agentProject.get(agentProjectKey) ?? 0) + 1);
          }

          addPoint(facts.day, 'day', record, session.agent, projectId);
          if (input.now - record.time <= HOUR_WINDOW_MS) {
            addPoint(facts.hour, 'hour', record, session.agent, projectId);
          }
        }
      }
    }
  }
  return facts;
}

/** Accumulate the day/hour cells for one record. */
function addPoint(
  groups: Map<string, PointGroup>,
  bucket: 'day' | 'hour',
  record: UsageRecord,
  agent: string,
  projectId: string,
): void {
  const start = bucketStart(record.time, bucket);
  const key = `${start}\u0000${agent}\u0000${projectId}`;
  let entry = groups.get(key);
  if (entry === undefined) {
    entry = {
      point: { t: start, bucket, agent, projectId, requests: 0, tokens: emptyTokens(), cost: '0' },
      records: [],
    };
    groups.set(key, entry);
  }
  entry.point.requests += 1;
  entry.point.tokens = addTokens(entry.point.tokens, record.tokens);
  entry.records.push(record);
}

/**
 * Price each grid cell once.
 *
 * There is no per-bucket money in the report to sum, so this is the one place the
 * dashboard prices anything itself — and it does it per cell, at display
 * precision, the same way the report prices a session.
 */
function pricePoints(groups: Map<string, PointGroup>, engine: PricingEngine): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (const { point, records } of groups.values()) {
    point.cost = costOf(records, engine).totals.total;
    points.push(point);
  }
  points.sort(
    (left, right) =>
      left.t - right.t || left.agent.localeCompare(right.agent) || left.projectId.localeCompare(right.projectId),
  );
  return points;
}

/** The start of the local day/hour a record falls in. */
function bucketStart(time: number, bucket: 'day' | 'hour'): number {
  const date = new Date(time);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    bucket === 'hour' ? date.getHours() : 0,
    0,
    0,
    0,
  ).getTime();
}

// ---------------------------------------------------------------------------
// Producer: the merged report
// ---------------------------------------------------------------------------

/** The drafts one build folds into a dashboard. */
interface Drafts {
  projects: ProjectDraft[];
  repos: RepoNode[];
  reports: Map<string, SessionReport>;
}

/** Build the drafts from the merged report. */
function draftsFromResult(result: UsageResult, labels: AgentLabelSource): Drafts {
  const projects = result.projects.map((report) => {
    const draft = emptyDraft(report.id, report.name, report.kind === 'repo' ? 'repo' : 'path');
    draft.repo =
      report.repo === undefined ? undefined : { name: report.repo.name, root: report.repo.root, kind: report.repo.kind };
    for (const totals of report.agentTotals) {
      draft.agents.add(totals.agent);
      draft.agentTotals.set(totals.agent, agentTotalsOf(totals, labels));
    }
    draft.requests = report.requests;
    draft.tokens = report.tokens;
    draft.cost = report.cost;
    draft.sessionCount = report.sessions;
    draft.activeSessions = report.activeSessions;
    draft.subagentSessions = report.subagentSessions;
    draft.firstUsage = report.firstUsage;
    draft.lastUsage = report.lastUsage;

    // Model and price-band rows come from the sessions that *root* a delegation
    // subtree: a subagent's money is already inside its parent's row (the parent's
    // records are folded with its children's), so listing both would count it
    // twice. "Roots" is therefore narrow: only a session that is a subagent *and*
    // whose parent is in this report has its usage counted elsewhere. A subagent
    // whose parent is out of range, and a fork that carries a `parentId` without
    // being a descendant (the report bills it independently), each speak for
    // themselves — dropping them leaves the tables short of the totals they sit
    // under.
    const reported = new Set((report.sessionReports ?? []).map((session) => session.id));
    for (const session of report.sessionReports ?? []) {
      const node = sessionNode(session, draft.id, draft.name, report.path);
      draft.sessions.push(node);
      draft.reports.set(node.uid, session);
      const workspace = workspaceDraft(draft, node.workspace, report);
      workspace.sessions.push(node);
      const foldedIntoParent = session.isSubagent && session.parentId !== null && reported.has(session.parentId);
      if (foldedIntoParent) continue;
      for (const model of session.models) draft.models.push(modelRow(session.agent, draft.id, model));
      for (const band of session.bands) draft.bands.push(bandRow(session.agent, draft.id, band));
    }
    for (const workspace of draft.workspaces.values()) {
      workspace.requests = workspace.sessions.reduce((total, session) => total + session.requests, 0);
      workspace.tokens = sumTokensList(workspace.sessions.map((session) => session.tokens));
      workspace.cost = sumCosts(workspace.sessions.map((session) => session.cost));
      workspace.sessionCount = workspace.sessions.length;
      workspace.subagentCount = workspace.sessions.filter((session) => session.isSubagent).length;
      workspace.activeSessions = workspace.sessions.filter((session) => session.requests > 0).length;
      for (const session of workspace.sessions) workspace.agents.add(session.agent);
      for (const agent of workspace.agents) {
        const totals = draft.agentTotals.get(agent);
        if (totals !== undefined) workspace.agentTotals.set(agent, totals);
      }
    }
    return draft;
  });
  return { projects, repos: reposOf(result.repos, projects), reports: collectReports(projects) };
}

/** An empty draft with the shared defaults. */
function emptyDraft(id: string, name: string, kind: 'repo' | 'path'): ProjectDraft {
  return {
    id,
    name,
    kind,
    workspaces: new Map(),
    agents: new Set(),
    agentTotals: new Map(),
    sessions: [],
    reports: new Map(),
    models: [],
    bands: [],
    requests: 0,
    tokens: emptyTokens(),
    cost: zeroCostTotals(),
    sessionCount: 0,
    activeSessions: 0,
    subagentSessions: 0,
    firstUsage: null,
    lastUsage: null,
  };
}

/** Find or create the workspace a session ran in. */
function workspaceDraft(draft: ProjectDraft, workspacePath: string, report: ProjectReport): WorkspaceDraft {
  const key = workspaceKey(workspacePath).length > 0 ? workspaceKey(workspacePath) : draft.id;
  const existing = draft.workspaces.get(key);
  if (existing !== undefined) return existing;
  const created: WorkspaceDraft = {
    path: key.startsWith('repo:') || key.startsWith('path:') ? report.path : key,
    name: baseNameOf(key) || draft.name,
    repo:
      report.repo === undefined
        ? undefined
        : {
            name: report.repo.name,
            root: report.repo.root,
            kind: report.repo.kind,
            ...(report.repo.branch === undefined ? {} : { branch: report.repo.branch }),
          },
    agents: new Set(),
    agentTotals: new Map(),
    sessions: [],
    requests: 0,
    tokens: emptyTokens(),
    cost: zeroCostTotals(),
    activeSessions: 0,
    subagentCount: 0,
    sessionCount: 0,
  };
  draft.workspaces.set(key, created);
  return created;
}

/** Every session report of every draft, for the detail endpoint. */
function collectReports(projects: readonly ProjectDraft[]): Map<string, SessionReport> {
  const reports = new Map<string, SessionReport>();
  for (const project of projects) for (const [uid, report] of project.reports) reports.set(uid, report);
  return reports;
}

/** Repositories from the merged report's own groups. */
function reposOf(groups: readonly RepoGroup[], projects: readonly ProjectDraft[]): RepoNode[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  return groups.map((group) => {
    const members = group.projectIds.map((id) => byId.get(id)).filter((draft): draft is ProjectDraft => draft !== undefined);
    return {
      name: group.name,
      root: workspaceKey(group.root),
      projects: [...group.projectIds],
      agents: [...new Set(members.flatMap((draft) => [...draft.agents]))].sort(),
      sessions: group.sessions,
      requests: group.requests,
      tokens: group.tokens,
      cost: group.cost,
      agentTotals: mergeAgentTotals(members.flatMap((draft) => [...draft.agentTotals.values()])),
    };
  });
}

/** One session row, from the report the CLI's own session table is built from. */
function sessionNode(report: SessionReport, projectId: string, projectName: string, projectPath: string): SessionNode {
  return {
    uid: `${report.agent}:${report.id}`,
    id: report.id,
    agent: report.agent,
    projectId,
    projectName,
    workspace: report.cwd ?? projectPath,
    title: report.title,
    cwd: report.cwd,
    createdAt: report.createdAt,
    firstUsage: report.firstUsage,
    lastUsage: report.lastUsage,
    requests: report.requests,
    tokens: report.tokens,
    cost: report.cost,
    isSubagent: report.isSubagent,
    depth: 0,
    archived: report.archived,
    subagentCount: report.subagentCount,
    parentId: report.parentId,
    own: scopeFigures(1, report.own.requests, report.own.tokens, report.own.cost),
    spawned: scopeFigures(report.spawned.sessions, report.spawned.requests, report.spawned.tokens, report.spawned.cost),
    total: scopeFigures(report.total.sessions, report.total.requests, report.total.tokens, report.total.cost),
  };
}

/** Turn a draft into the row the API hands out. */
function finishProject(draft: ProjectDraft): ProjectSummary {
  const workspaces = [...draft.workspaces.values()]
    .map((workspace) => finishWorkspace(workspace))
    .sort((left, right) => right.requests - left.requests || left.name.localeCompare(right.name));
  const sessions = [...draft.sessions].sort(
    (left, right) => (right.lastUsage ?? 0) - (left.lastUsage ?? 0) || left.uid.localeCompare(right.uid),
  );
  // Delegation depth is not part of the report row (the report itself is a flat
  // list), so it is recomputed here from the parent links that are.
  const byUid = new Map(sessions.map((session) => [session.uid, session]));
  for (const session of sessions) {
    let depth = 0;
    let current = session;
    const seen = new Set<string>([session.uid]);
    while (current.parentId !== null) {
      const parent = byUid.get(`${current.agent}:${current.parentId}`);
      if (parent === undefined || seen.has(parent.uid)) break;
      seen.add(parent.uid);
      depth += 1;
      current = parent;
    }
    session.depth = depth;
  }
  return {
    id: draft.id,
    name: draft.name,
    kind: draft.kind,
    workspaces: workspaces.map((workspace) => workspace.path),
    agents: [...draft.agents].sort(),
    sessions: draft.sessionCount,
    subagentSessions: draft.subagentSessions,
    activeSessions: draft.activeSessions,
    requests: draft.requests,
    unpriced: [...draft.agentTotals.values()].reduce((total, totals) => total + totals.unpriced, 0),
    firstUsage: draft.firstUsage,
    lastUsage: draft.lastUsage,
    tokens: draft.tokens,
    tokenBreakdown: tokenBreakdownOf(draft.tokens, draft.cost),
    cost: draft.cost,
    agentTotals: [...draft.agentTotals.values()].sort((left, right) => left.id.localeCompare(right.id)),
    ...scopeSplitOf(sessions),
    workspaceNodes: workspaces,
    sessionReports: sessions,
    models: mergeModelRows(draft.models),
    bands: mergeBandRows(draft.bands),
    repo: draft.repo,
  };
}

/** Turn a workspace draft into its row. */
function finishWorkspace(draft: WorkspaceDraft): WorkspaceNode {
  return {
    path: draft.path,
    name: draft.name,
    agents: [...draft.agents].sort(),
    repo: draft.repo,
    sessionCount: draft.sessionCount,
    subagentCount: draft.subagentCount,
    activeSessions: draft.activeSessions,
    requests: draft.requests,
    tokens: draft.tokens,
    cost: draft.cost,
    agentTotals: [...draft.agentTotals.values()].sort((left, right) => left.id.localeCompare(right.id)),
    ...scopeSplitOf(draft.sessions),
    sessionReports: [...draft.sessions].sort(
      (left, right) => (right.lastUsage ?? 0) - (left.lastUsage ?? 0) || left.uid.localeCompare(right.uid),
    ),
  };
}

/** One model row. */
function modelRow(agent: string, projectId: string, model: ModelBreakdown): ModelRow {
  return { agent, projectId, model: model.model, requests: model.requests, tokens: model.tokens, cost: model.cost };
}

/** One price-band row, with the rate card that produced its money. */
function bandRow(agent: string, projectId: string, band: BandSummary): BandRow {
  const components = (band.components ?? []).map((component) => ({
    id: component.id,
    label: component.label,
    rate: component.rate,
    per: component.per,
    tokens: component.tokens,
    amount: component.amount,
    ...(component.excess === undefined ? {} : { excess: { ...component.excess } }),
    ...(component.ttl === undefined
      ? {}
      : { ttl: { tier: component.ttl.tier, multiplier: component.ttl.multiplier, tokens: component.ttl.tokens } }),
  }));
  return {
    agent,
    projectId,
    model: band.model,
    periodId: band.periodId,
    periodLabel: band.periodLabel,
    window: band.window,
    tier: band.tier,
    resolution: band.resolution,
    requests: band.requests,
    tokens: band.tokens ?? emptyTokens(),
    cost: band.cost,
    components,
  };
}

// ---------------------------------------------------------------------------
// Filtering, series aggregation, session detail
// ---------------------------------------------------------------------------

/**
 * One row per (agent, project, model), which is what the model table shows.
 *
 * A session bills the same model many times over its life and every root session
 * contributes its own row, so the collected list repeats: the UI then draws
 * identical rows — and, because the row key *is* this triple, duplicate React
 * keys, which is how a scope switch leaves stale rows behind. The figures are
 * added, never re-derived, so the rows still sum to the project's own totals.
 *
 * @param rows - the per-session rows.
 * @returns one row per (agent, project, model), in first-seen order.
 */
function mergeModelRows(rows: readonly ModelRow[]): ModelRow[] {
  const merged = new Map<string, ModelRow>();
  for (const row of rows) {
    const key = `${row.agent}\u0000${row.projectId}\u0000${row.model}`;
    const known = merged.get(key);
    if (known === undefined) {
      merged.set(key, { ...row, tokens: { ...row.tokens }, cost: { ...row.cost } });
      continue;
    }
    known.requests += row.requests;
    known.tokens = addTokens(known.tokens, row.tokens);
    known.cost = addCostTotals(known.cost, row.cost);
  }
  return [...merged.values()];
}

/** Fold one band's rate card into another's: same components, added quantities. */
function mergeBandComponents(known: BandComponentRow[], incoming: readonly BandComponentRow[]): void {
  const byId = new Map(known.map((component) => [component.id, component]));
  for (const component of incoming) {
    const existing = byId.get(component.id);
    if (existing === undefined) {
      const copy: BandComponentRow = {
        ...component,
        ...(component.excess === undefined ? {} : { excess: { ...component.excess } }),
        ...(component.ttl === undefined ? {} : { ttl: { ...component.ttl } }),
      };
      known.push(copy);
      byId.set(copy.id, copy);
      continue;
    }
    existing.tokens += component.tokens;
    existing.amount = addAmounts(existing.amount, component.amount);
    if (existing.excess !== undefined && component.excess !== undefined) {
      existing.excess.tokens += component.excess.tokens;
      existing.excess.amount = addAmounts(existing.excess.amount, component.excess.amount);
    }
    if (existing.ttl !== undefined && component.ttl !== undefined) existing.ttl.tokens += component.ttl.tokens;
  }
}

/**
 * One row per (agent, project, model, price band) — the band table's contract,
 * the same rule as {@link mergeModelRows} one level finer.
 *
 * @param rows - the per-session rows.
 * @returns one row per band, in first-seen order.
 */
function mergeBandRows(rows: readonly BandRow[]): BandRow[] {
  const merged = new Map<string, BandRow>();
  for (const row of rows) {
    const key = [row.agent, row.projectId, row.model, row.periodId, row.tier].join('\u0000');
    const known = merged.get(key);
    if (known === undefined) {
      const copy: BandRow = { ...row, tokens: { ...row.tokens }, cost: { ...row.cost }, components: [] };
      mergeBandComponents(copy.components, row.components);
      merged.set(key, copy);
      continue;
    }
    known.requests += row.requests;
    known.tokens = addTokens(known.tokens, row.tokens);
    known.cost = addCostTotals(known.cost, row.cost);
    mergeBandComponents(known.components, row.components);
  }
  return [...merged.values()];
}

/**
 * One project, narrowed to the agents a query asked for.
 *
 * A project groups *every* agent that has worked in that directory, so filtering
 * by agent cannot stop at "does this project use one of them": the projects that
 * survive must also drop the rows of the agents that were filtered out, or the
 * panels would show — and sum — usage the totals already exclude. Every figure
 * is re-added from the per-agent figures that remain; nothing is re-derived from
 * the raw records.
 *
 * @param project - the project to narrow.
 * @param agents - the agent ids to keep.
 * @returns a new project, or `undefined` when no agent is left.
 */
function narrowProject(project: ProjectSummary, agents: ReadonlySet<string>): ProjectSummary | undefined {
  const agentTotals = project.agentTotals.filter((totals) => agents.has(totals.id));
  if (agentTotals.length === 0) return undefined;
  const sessions = project.sessionReports.filter((session) => agents.has(session.agent));
  const figures = totalsOf(agentTotals, { projects: 1, workspaces: project.workspaces.length });
  const workspaceNodes = project.workspaceNodes
    .map((workspace) => {
      const kept = workspace.agentTotals.filter((totals) => agents.has(totals.id));
      const workspaceFigures = totalsOf(kept, { projects: 1, workspaces: 1 });
      const keptSessions = workspace.sessionReports.filter((session) => agents.has(session.agent));
      return {
        ...workspace,
        agents: kept.map((totals) => totals.id),
        agentTotals: kept,
        ...scopeSplitOf(keptSessions),
        sessionReports: keptSessions,
        sessionCount: workspaceFigures.sessions,
        subagentCount: workspaceFigures.subagentSessions,
        activeSessions: workspaceFigures.activeSessions,
        requests: workspaceFigures.requests,
        tokens: workspaceFigures.tokens,
        cost: workspaceFigures.cost,
      };
    })
    .filter((workspace) => workspace.agentTotals.length > 0);
  return {
    ...project,
    ...figures,
    // `figures.workspaces` is a count; this project's own `workspaces` is the list
    // of directories the tree renders.
    workspaces: project.workspaces,
    id: project.id,
    name: project.name,
    kind: project.kind,
    agents: agentTotals.map((totals) => totals.id),
    agentTotals,
    ...scopeSplitOf(sessions),
    workspaceNodes,
    sessionReports: sessions,
    models: project.models.filter((row) => agents.has(row.agent)),
    bands: project.bands.filter((row) => agents.has(row.agent)),
  };
}

/**
 * Narrow a dashboard to a query, re-totalling from the rows that survive.
 *
 * Every figure is a sum of per-project rows, so dropping a project is an
 * addition the rows themselves can do — the totals never disagree with what is
 * shown. Narrowing the agents inside a project is the same rule one level down
 * (see {@link narrowProject}).
 * @param dashboard - the unfiltered dashboard.
 * @param query - agent / project / search filters.
 * @returns a new dashboard.
 */
export function filterDashboard(dashboard: Dashboard, query: DashboardQuery = {}): Dashboard {
  const agents = new Set((query.agents ?? []).filter((id) => id.length > 0));
  const projectIds = new Set((query.projects ?? []).filter((id) => id.length > 0));
  const search = (query.search ?? '').trim().toLowerCase();
  const keepProject = (project: ProjectSummary): boolean => {
    if (projectIds.size > 0 && !projectIds.has(project.id)) return false;
    if (agents.size > 0 && !project.agents.some((agent) => agents.has(agent))) return false;
    if (search.length === 0) return true;
    if (project.name.toLowerCase().includes(search)) return true;
    return project.workspaces.some((workspace) => workspace.toLowerCase().includes(search));
  };
  const projects = dashboard.projects
    .filter(keepProject)
    .map((project) => (agents.size === 0 ? project : narrowProject(project, agents)))
    .filter((project): project is ProjectSummary => project !== undefined);
  const keptIds = new Set(projects.map((project) => project.id));
  const agentTotals = mergeAgentTotals(
    projects.flatMap((project) => project.agentTotals.filter((totals) => agents.size === 0 || agents.has(totals.id))),
  );
  const totals = totalsOf(
    agentTotals,
    {
      projects: projects.length,
      workspaces: projects.reduce((total, project) => total + project.workspaces.length, 0),
    },
    splitOfProjects(projects),
  );
  const filtered: Dashboard = {
    ...dashboard,
    generatedAt: Date.now(),
    agents: agentTotals,
    totals,
    projects,
    repos: dashboard.repos
      .filter((repo) => repo.projects.some((id) => keptIds.has(id)))
      .map((repo) => {
        const kept = repo.agentTotals.filter((totals) => agents.size === 0 || agents.has(totals.id));
        return { ...repo, agentTotals: kept, agents: kept.map((totals) => totals.id) };
      }),
    timeseries: {
      day: dashboard.timeseries.day.filter(
        (point) => keptIds.has(point.projectId) && (agents.size === 0 || agents.has(point.agent)),
      ),
      hour: dashboard.timeseries.hour.filter(
        (point) => keptIds.has(point.projectId) && (agents.size === 0 || agents.has(point.agent)),
      ),
    },
    models: dashboard.models.filter((row) => keptIds.has(row.projectId) && (agents.size === 0 || agents.has(row.agent))),
    bands: dashboard.bands.filter((row) => keptIds.has(row.projectId) && (agents.size === 0 || agents.has(row.agent))),
  };
  const index = detailIndex.get(dashboard);
  if (index !== undefined) detailIndex.set(filtered, index);
  return filtered;
}

/**
 * The dashboard with nothing selected.
 *
 * `filterDashboard` reads an empty agent list as "no filter", which is what the
 * HTTP layer wants (no `?agent=` means every agent). A caller that narrowed the
 * server itself — `serve --snapshot … --agent pi` — has the opposite problem: an
 * intersection that ends up empty must answer with *nothing*, or the response
 * would hand back exactly the agents the flag excluded.
 *
 * @param dashboard - the dashboard the query was made against.
 * @returns a dashboard whose every figure is zero.
 */
function emptyDashboard(dashboard: Dashboard): Dashboard {
  return {
    ...dashboard,
    generatedAt: Date.now(),
    agents: [],
    totals: totalsOf([], { projects: 0, workspaces: 0 }),
    projects: [],
    repos: [],
    timeseries: { day: [], hour: [] },
    models: [],
    bands: [],
  };
}

/** Fold the sparse long-form series into one point per bucket. */
export function aggregateTimeseries(dashboard: Dashboard, bucket: 'day' | 'hour'): TimeseriesBucket[] {
  const points = bucket === 'hour' ? dashboard.timeseries.hour : dashboard.timeseries.day;
  const groups = new Map<number, SeriesPoint[]>();
  for (const point of points) {
    const entry = groups.get(point.t);
    if (entry === undefined) groups.set(point.t, [point]);
    else entry.push(point);
  }
  const out: TimeseriesBucket[] = [];
  for (const [t, rows] of groups) {
    const byAgent: TimeseriesBucket['byAgent'] = {};
    for (const row of rows) {
      const known = byAgent[row.agent] ?? { requests: 0, tokens: emptyTokens(), cost: '0' };
      known.requests += row.requests;
      known.tokens = addTokens(known.tokens, row.tokens);
      known.cost = addAmounts(known.cost, row.cost);
      byAgent[row.agent] = known;
    }
    const date = localDate(t);
    out.push({
      t,
      date,
      label: bucket === 'hour' ? `${date} ${String(new Date(t).getHours()).padStart(2, '0')}:00` : date,
      requests: rows.reduce((total, row) => total + row.requests, 0),
      tokens: sumTokensList(rows.map((row) => row.tokens)),
      cost: sumAmountsList(rows.map((row) => row.cost)),
      byAgent,
    });
  }
  out.sort((left, right) => left.t - right.t);
  return out;
}

/** `YYYY-MM-DD` on the local clock. */
function localDate(time: number): string {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * One session's detail, from an already-built dashboard.
 * @param dashboard - the dashboard to search.
 * @param id - session id, or `agent:id`.
 * @returns the detail, or `undefined` when no project holds that session.
 */
export function detailFromDashboard(dashboard: Dashboard, id: string): SessionDetail | undefined {
  const wanted = id.trim();
  if (wanted.length === 0) return undefined;
  for (const project of dashboard.projects) {
    const found = findSession(project.sessionReports, wanted);
    if (found !== undefined) return buildDetail(dashboard, project, found);
  }
  return undefined;
}

/** Find a session by `agent:id` or by bare id, preferring the qualified form. */
function findSession(sessions: readonly SessionNode[], wanted: string): SessionNode | undefined {
  if (wanted.includes(':')) {
    const direct = sessions.find((session) => session.uid === wanted);
    if (direct !== undefined) return direct;
  }
  return sessions.find((session) => session.id === wanted);
}

/** Assemble a session detail, including every descendant that billed in range. */
function buildDetail(dashboard: Dashboard, project: ProjectSummary, session: SessionNode): SessionDetail {
  const byUid = new Map(project.sessionReports.map((node) => [node.uid, node]));
  const childrenOf = new Map<string, SessionNode[]>();
  for (const node of project.sessionReports) {
    if (node.parentId === null) continue;
    const parentUid = `${node.agent}:${node.parentId}`;
    const list = childrenOf.get(parentUid) ?? [];
    list.push(node);
    childrenOf.set(parentUid, list);
  }
  const treeOf = (node: SessionNode, seen: Set<string>): SessionTreeNode => {
    seen.add(node.uid);
    const children = (childrenOf.get(node.uid) ?? [])
      .filter((child) => !seen.has(child.uid))
      .sort((left, right) => (left.lastUsage ?? 0) - (right.lastUsage ?? 0) || left.uid.localeCompare(right.uid))
      .map((child) => treeOf(child, seen));
    return {
      uid: node.uid,
      id: node.id,
      agent: node.agent,
      title: node.title,
      isSubagent: node.isSubagent,
      depth: node.depth,
      requests: node.own.requests,
      tokens: node.own.tokens,
      cost: node.own.cost,
      children,
    };
  };
  const ancestors: { id: string; agent: string; title: string | null }[] = [];
  let current = session;
  const seen = new Set<string>([session.uid]);
  while (current.parentId !== null) {
    const parent = byUid.get(`${current.agent}:${current.parentId}`);
    if (parent === undefined || seen.has(parent.uid)) break;
    seen.add(parent.uid);
    ancestors.push({ id: parent.id, agent: parent.agent, title: parent.title });
    current = parent;
  }
  // The session's own model and price-band rows come from the report that was
  // built for it (kept out of the payload, see {@link detailIndex}).
  const report = detailIndex.get(dashboard)?.get(session.uid);
  const models =
    report === undefined
      ? dashboard.models.filter((row) => row.projectId === project.id && row.agent === session.agent)
      : mergeModelRows(report.models.map((model) => modelRow(session.agent, project.id, model)));
  const bands =
    report === undefined
      ? dashboard.bands.filter((row) => row.projectId === project.id && row.agent === session.agent)
      : mergeBandRows(report.bands.map((band) => bandRow(session.agent, project.id, band)));
  return { session, models, bands, ancestors, tree: treeOf(session, new Set()) };
}

/**
 * A session whose usage fell outside the range still exists: rebuild its tree
 * from the loaded datasets, with zero figures.
 *
 * This is what makes the tree complete rather than merely "everything that spent
 * something in range": clicking a parent still shows the subagent that did not
 * bill this week.
 */
function detailFromDatasets(
  datasets: readonly UsageDataset[],
  dashboard: Dashboard,
  id: string,
): SessionDetail | undefined {
  const wanted = id.trim();
  for (const dataset of datasets) {
    for (const session of dataset.sessions) {
      const agent = session.agent.length > 0 ? session.agent : dataset.agent;
      const uid = `${agent}:${session.id}`;
      if (uid !== wanted && session.id !== wanted) continue;
      const projectId = projectIdOfDatasetSession(dataset, session);
      const found = dashboard.projects.find((project) => project.id === projectId);
      const node: SessionNode = {
        uid,
        id: session.id,
        agent,
        projectId,
        projectName: found?.name ?? dataset.source,
        workspace: session.cwd ?? '',
        title: session.title,
        cwd: session.cwd,
        createdAt: session.createdAt,
        firstUsage: null,
        lastUsage: null,
        requests: 0,
        tokens: emptyTokens(),
        cost: zeroCostTotals(),
        isSubagent: session.isSubagent,
        depth: session.depth,
        archived: session.archived,
        subagentCount: session.childIds.length,
        parentId: session.parentId,
        own: scopeFigures(1, 0, emptyTokens(), zeroCostTotals()),
        spawned: scopeFigures(0, 0, emptyTokens(), zeroCostTotals()),
        total: scopeFigures(1, 0, emptyTokens(), zeroCostTotals()),
      };
      const placeholder: ProjectSummary = {
        id: projectId,
        name: node.projectName,
        kind: 'path',
        workspaces: [],
        agents: [agent],
        own: emptyScope(),
        spawned: emptyScope(),
        sessions: 0,
        subagentSessions: 0,
        activeSessions: 0,
        requests: 0,
        unpriced: 0,
        firstUsage: null,
        lastUsage: null,
        tokens: emptyTokens(),
        tokenBreakdown: tokenBreakdownOf(emptyTokens(), zeroCostTotals()),
        cost: zeroCostTotals(),
        agentTotals: [],
        workspaceNodes: [],
        sessionReports: [],
        models: [],
        bands: [],
      };
      const detail = buildDetail(dashboard, found ?? placeholder, node);
      detail.tree = treeFromDataset(dataset, session.id);
      return detail;
    }
  }
  return undefined;
}

/** Rebuild a delegation tree straight from a dataset, with zero money. */
function treeFromDataset(dataset: UsageDataset, rootId: string): SessionTreeNode {
  const byId = new Map(dataset.sessions.map((session) => [session.id, session]));
  const seen = new Set<string>();
  const walk = (sessionId: string): SessionTreeNode => {
    const session = byId.get(sessionId);
    const children = (session?.childIds ?? [])
      .filter((id) => byId.has(id) && !seen.has(id))
      .map((id) => {
        seen.add(id);
        return walk(id);
      });
    return {
      uid: `${dataset.agent}:${sessionId}`,
      id: sessionId,
      agent: session?.agent ?? dataset.agent,
      title: session?.title ?? null,
      isSubagent: session?.isSubagent ?? true,
      depth: session?.depth ?? 0,
      requests: session?.records.length ?? 0,
      tokens: sumTokensList((session?.records ?? []).map((record) => record.tokens)),
      cost: zeroCostTotals(),
      children,
    };
  };
  seen.add(rootId);
  return walk(rootId);
}

/**
 * Which dashboard project a dataset session belongs to.
 *
 * The live store only ever holds the merged dataset, and the merge layer keys
 * projects exactly as the dashboard does, so a dataset project id is a dashboard
 * id. A session whose project cannot be found falls back to its own directory.
 */
function projectIdOfDatasetSession(dataset: UsageDataset, session: { id: string; cwd: string | null }): string {
  for (const project of dataset.projects) {
    if (project.sessions.some((candidate) => candidate.id === session.id)) return project.id;
  }
  const key = workspaceKey(session.cwd ?? '');
  return key.length > 0 ? `path:${key}` : `id:${session.id}`;
}

// ---------------------------------------------------------------------------
// Snapshot store
// ---------------------------------------------------------------------------

/** A store over one JSON file. */
async function openSnapshotStore(path: string, options: ScanOptions): Promise<DashboardStore> {
  const text = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(text);
  const snapshot = normalizeSnapshot(parsed, path);
  // `--agent` still means something with a snapshot: the file holds every agent it
  // was written with, and the flag says which of them the dashboard is about.
  // An unknown id is an error here too (via `selectAdapters`), not a flag quietly
  // ignored — the same rule the live mode follows.
  const selector = (options.agent ?? '').trim();
  const agents =
    selector.length === 0 || selector.toLowerCase() === 'all'
      ? undefined
      : selectAdapters(selector).map((adapter) => adapter.id);

  /** The agents a request asks for, narrowed to the ones `--agent` allowed. */
  const narrow = (requested: readonly string[] | undefined): string[] | undefined => {
    if (agents === undefined) return requested === undefined ? undefined : [...requested];
    if (requested === undefined || requested.length === 0) return agents;
    return requested.filter((id) => agents.includes(id));
  };

  // The file's own provenance block also names every agent it was written with;
  // with `--agent` narrowing, both the store and the payload must agree on which
  // ones are actually being served, or the header would count agents the figures
  // no longer include.
  const loadedAgents =
    agents === undefined ? snapshot.loadedAgents : snapshot.loadedAgents.filter((entry) => agents.includes(entry.id));

  const store: DashboardStore = {
    mode: 'snapshot',
    source: path,
    scannedAt: snapshot.scannedAt,
    scanMs: 0,
    loadedAgents,
    warnings: snapshot.warnings,
    currency: snapshot.currency,
    currencySymbol: snapshot.currencySymbol,
    pricingProvider: snapshot.pricingProvider,
    pricingLabel: snapshot.pricingLabel,
    dashboard(query = {}) {
      const range = resolveRange(query.range === undefined ? {} : { spec: query.range });
      const built: Dashboard = {
        ...snapshot,
        loadedAgents,
        rangeLabel: range.label,
        rangeFrom: range.from,
        rangeTo: range.to,
      };
      const narrowed = narrow(query.agents);
      // `filterDashboard` reads "no agents" as "no filter", so an intersection
      // that came out empty (`--agent pi` with `?agent=dsh`) is answered with an
      // empty dashboard instead — otherwise the whole file would go out.
      if (narrowed !== undefined && narrowed.length === 0) return emptyDashboard(built);
      return filterDashboard(built, narrowed === undefined ? query : { ...query, agents: narrowed });
    },
    timeseries(query = {}) {
      return aggregateTimeseries(store.dashboard(query), query.bucket ?? 'day');
    },
    sessionDetail(id, query = {}) {
      return detailFromDashboard(store.dashboard(query), id);
    },
    async refresh() {
      return {
        ok: false,
        scannedAt: Date.now(),
        ms: 0,
        agents: store.loadedAgents,
        warnings: [
          warning('snapshotReadOnly', renderDiagnostic('snapshotReadOnly', { path: options.snapshot ?? path }), {
            path: options.snapshot ?? path,
          }),
        ],
        error: 'snapshot',
      };
    },
    async writeSnapshot(target) {
      await writeFile(target, `${JSON.stringify(store.dashboard(), null, 2)}\n`, 'utf8');
    },
  };
  return store;
}

/**
 * Read a snapshot file into a dashboard.
 *
 * Two layouts are accepted: this layer's own dump (recognised by a `timeseries`
 * object) and the contract `usage --agent all --json` report. The second has no
 * per-record timestamps, so its time series is empty and a warning says so.
 * @param parsed - the parsed JSON.
 * @param path - where it came from, for the warning text.
 * @returns a dashboard with every field present.
 */
export function normalizeSnapshot(parsed: unknown, path: string): Dashboard {
  const root = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const warnings: DashboardWarning[] = Array.isArray(root['warnings'])
    ? (root['warnings'] as unknown[]).map((item) => {
        const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
        return warning(
          String(entry['code'] ?? 'warning'),
          String(entry['message'] ?? entry['code'] ?? ''),
          entry['params'] as Record<string, unknown> | undefined,
        );
      })
    : [];

  const hasSeries = typeof root['timeseries'] === 'object' && root['timeseries'] !== null;
  if (!hasSeries) {
    warnings.push(
      warning('snapshotNoTimeseries', renderDiagnostic('snapshotNoTimeseries', { path }), { path }),
    );
  }

  const rawProjects = Array.isArray(root['projects']) ? (root['projects'] as unknown[]) : [];
  const projects = rawProjects.map((item) => normalizeProject(item));
  const rawAgents = Array.isArray(root['agents']) ? (root['agents'] as unknown[]) : [];
  const agentTotals = rawAgents.map((item) => normalizeAgentTotals(item));
  const loadedAgents = Array.isArray(root['loadedAgents'])
    ? (root['loadedAgents'] as unknown[]).map((item) => {
        const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
        return {
          id: String(entry['id'] ?? ''),
          label: String(entry['label'] ?? entry['id'] ?? ''),
          source: String(entry['source'] ?? ''),
        };
      })
    : agentTotals.map((totals) => ({ id: totals.id, label: totals.label, source: totals.source }));

  const timeseriesRoot = (
    typeof root['timeseries'] === 'object' && root['timeseries'] !== null ? root['timeseries'] : {}
  ) as Record<string, unknown>;
  const series = (value: unknown, bucket: 'day' | 'hour'): SeriesPoint[] =>
    Array.isArray(value)
      ? (value as unknown[])
          .map((item) => {
            const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
            const t = numberOr0(entry['t']);
            if (t === 0) return undefined;
            return {
              t,
              bucket,
              agent: String(entry['agent'] ?? ''),
              projectId: String(entry['projectId'] ?? ''),
              requests: numberOr0(entry['requests']),
              tokens: asTokens(entry['tokens']),
              cost: asCost({ total: entry['cost'] }).total,
            } satisfies SeriesPoint;
          })
          .filter((point): point is SeriesPoint => point !== undefined)
      : [];

  const currency = typeof root['currency'] === 'string' ? root['currency'] : 'USD';
  const snapshot: Dashboard = {
    generatedAt: numberOr0(root['generatedAt']) || Date.now(),
    mode: 'snapshot',
    source: typeof root['source'] === 'string' ? root['source'] : path,
    scannedAt: numberOr0(root['scannedAt']) || numberOr0(root['generatedAt']) || Date.now(),
    scanMs: numberOr0(root['scanMs']),
    loadedAgents,
    currency,
    currencySymbol: typeof root['currencySymbol'] === 'string' ? root['currencySymbol'] : currencyOf(currency).symbol,
    pricingProvider: typeof root['pricingProvider'] === 'string' ? root['pricingProvider'] : 'snapshot',
    pricingLabel: typeof root['pricingLabel'] === 'string' ? root['pricingLabel'] : 'snapshot',
    rangeLabel: typeof root['rangeLabel'] === 'string' ? root['rangeLabel'] : t().range.all,
    rangeFrom: numberOrNull(root['rangeFrom']),
    rangeTo: numberOrNull(root['rangeTo']),
    agents: agentTotals,
    totals: totalsOf(
      agentTotals,
      {
        projects: projects.length,
        workspaces: projects.reduce((total, project) => total + project.workspaces.length, 0),
      },
      splitOfProjects(projects),
    ),
    projects,
    repos: Array.isArray(root['repos']) ? (root['repos'] as unknown[]).map((item) => normalizeRepo(item)) : [],
    timeseries: { day: series(timeseriesRoot['day'], 'day'), hour: series(timeseriesRoot['hour'], 'hour') },
    // The global lists are the projects' rows added up, exactly as in live mode,
    // so a snapshot cannot disagree with its own projects. A file whose projects
    // are missing still gets what its root lists say (merged, since a row per
    // session would give the tables duplicate keys).
    models: mergeModelRows(
      projects.length > 0
        ? projects.flatMap((project) => project.models)
        : Array.isArray(root['models'])
          ? (root['models'] as unknown[]).map((item) => normalizeModelRow(item))
          : [],
    ),
    bands: mergeBandRows(
      projects.length > 0
        ? projects.flatMap((project) => project.bands)
        : Array.isArray(root['bands'])
          ? (root['bands'] as unknown[]).map((item) => normalizeBandRow(item))
          : [],
    ),
    warnings,
  };
  const reports = new Map<string, SessionReport>();
  for (const project of projects) {
    for (const session of project.sessionReports) {
      reports.set(session.uid, sessionReportFromNode(session));
    }
  }
  detailIndex.set(snapshot, reports);
  return snapshot;
}

/** A minimal report row for a snapshot session, so the detail panel has a shape. */
function sessionReportFromNode(node: SessionNode): SessionReport {
  return {
    id: node.id,
    agent: node.agent,
    title: node.title,
    cwd: node.cwd,
    projectName: node.projectName,
    projectId: node.projectId,
    createdAt: node.createdAt,
    firstUsage: node.firstUsage,
    lastUsage: node.lastUsage,
    isSubagent: node.isSubagent,
    archived: node.archived,
    subagentCount: node.subagentCount,
    parentId: node.parentId,
    requests: node.requests,
    tokens: node.tokens,
    cost: node.cost,
    own: node.own,
    spawned: node.spawned,
    total: node.total,
    bands: [],
    models: [],
  };
}

/** Fill in one project row from a snapshot. */
function normalizeProject(value: unknown): ProjectSummary {
  const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const tokens = asTokens(entry['tokens']);
  const cost = asCost(entry['cost']);
  const workspaces = Array.isArray(entry['workspaces'])
    ? (entry['workspaces'] as unknown[]).map((item) => String(item))
    : entry['path'] === undefined
      ? []
      : [String(entry['path'])];
  const agents = Array.isArray(entry['agents']) ? (entry['agents'] as unknown[]).map((item) => String(item)) : [];
  const id = String(entry['id'] ?? `path:${workspaces[0] ?? ''}`);
  const name = String(entry['name'] ?? workspaces[0] ?? '');
  const sessions = Array.isArray(entry['sessionReports'])
    ? (entry['sessionReports'] as unknown[]).map((item) => normalizeSessionNode(item, id, name))
    : [];
  const sessionCount = numberOr0(entry['sessions']) || sessions.length;
  const agentTotals = Array.isArray(entry['agentTotals'])
    ? (entry['agentTotals'] as unknown[]).map((item) => normalizeAgentTotals(item))
    : [];
  const workspaceNodes = Array.isArray(entry['workspaceNodes'])
    ? (entry['workspaceNodes'] as unknown[]).map((item) => normalizeWorkspace(item, sessions))
    : workspaces.map((path) => ({
        path,
        name: baseNameOf(path),
        agents,
        ...scopeSplitOf(sessions),
        sessionCount,
        subagentCount: numberOr0(entry['subagentSessions']),
        activeSessions: numberOr0(entry['activeSessions']),
        requests: numberOr0(entry['requests']),
        tokens,
        cost,
        agentTotals,
        sessionReports: [...sessions],
      }));
  return {
    id,
    name,
    kind: entry['kind'] === 'repo' || entry['repo'] !== undefined ? 'repo' : 'path',
    workspaces,
    agents,
    sessions: sessionCount,
    subagentSessions: numberOr0(entry['subagentSessions']),
    activeSessions: numberOr0(entry['activeSessions']),
    requests: numberOr0(entry['requests']),
    unpriced: numberOr0(entry['unpriced']),
    firstUsage: numberOrNull(entry['firstUsage']),
    lastUsage: numberOrNull(entry['lastUsage']),
    tokens,
    tokenBreakdown: tokenBreakdownOf(tokens, cost),
    cost,
    agentTotals,
    // Older snapshots (and report JSON) have no split: derive it from the session
    // rows they do carry, so the CLI's `自身` / `子代理` line is always available.
    ...normalizeSplit(entry, sessions),
    workspaceNodes,
    sessionReports: sessions,
    // Snapshots are read as-is, but a snapshot written before the rows were
    // merged (or a report JSON) can still carry one row per session: merging on
    // the way in keeps the tables' keys unique either way.
    models: Array.isArray(entry['models'])
      ? mergeModelRows((entry['models'] as unknown[]).map((item) => normalizeModelRow(item)))
      : [],
    bands: Array.isArray(entry['bands'])
      ? mergeBandRows((entry['bands'] as unknown[]).map((item) => normalizeBandRow(item)))
      : [],
    repo: entry['repo'] === undefined ? undefined : normalizeRepoInfo(entry['repo']),
  };
}

/**
 * A snapshot row's `自身` / `子代理` pair.
 *
 * Snapshots written by `--write-snapshot` carry it; an older file or a report
 * JSON does not, and then it is derived from the session rows that file does
 * carry — the same rule {@link scopeSplitOf} applies when the data comes from a
 * live scan.
 *
 * @param entry - the snapshot row.
 * @param sessions - its session rows.
 * @returns the pair.
 */
function normalizeSplit(
  entry: Record<string, unknown>,
  sessions: readonly SessionNode[],
): { own: ScopeFigures; spawned: ScopeFigures } {
  const own = normalizeScopeFigures(entry['own']);
  const spawned = normalizeScopeFigures(entry['spawned']);
  if (own !== undefined && spawned !== undefined) return { own, spawned };
  return scopeSplitOf(sessions);
}

/** Read one `自身` / `子代理` block, or `undefined` when the row has none. */
function normalizeScopeFigures(value: unknown): ScopeFigures | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  return {
    sessions: numberOr0(entry['sessions']),
    requests: numberOr0(entry['requests']),
    tokens: asTokens(entry['tokens']),
    cost: asCost(entry['cost']),
  };
}

/** Fill in one workspace row from a snapshot. */
function normalizeWorkspace(value: unknown, fallbackSessions: readonly SessionNode[]): WorkspaceNode {
  const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const path = String(entry['path'] ?? '');
  const sessions = Array.isArray(entry['sessionReports'])
    ? (entry['sessionReports'] as unknown[]).map((item) => normalizeSessionNode(item, '', ''))
    : fallbackSessions;
  return {
    path,
    ...normalizeSplit(entry, sessions),
    name: String(entry['name'] ?? baseNameOf(path)),
    agents: Array.isArray(entry['agents']) ? (entry['agents'] as unknown[]).map((item) => String(item)) : [],
    repo: entry['repo'] === undefined ? undefined : normalizeRepoInfo(entry['repo']),
    sessionCount: numberOr0(entry['sessionCount']),
    subagentCount: numberOr0(entry['subagentCount']),
    activeSessions: numberOr0(entry['activeSessions']),
    requests: numberOr0(entry['requests']),
    tokens: asTokens(entry['tokens']),
    cost: asCost(entry['cost']),
    agentTotals: Array.isArray(entry['agentTotals'])
      ? (entry['agentTotals'] as unknown[]).map((item) => normalizeAgentTotals(item))
      : [],
    sessionReports: [...sessions],
  };
}

/** Fill in one session row from a snapshot. */
function normalizeSessionNode(value: unknown, projectId: string, projectName: string): SessionNode {
  const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const agent = String(entry['agent'] ?? '');
  const id = String(entry['id'] ?? '');
  const tokens = asTokens(entry['tokens']);
  const cost = asCost(entry['cost']);
  const own = (typeof entry['own'] === 'object' && entry['own'] !== null ? entry['own'] : {}) as Record<string, unknown>;
  const spawned = (typeof entry['spawned'] === 'object' && entry['spawned'] !== null
    ? entry['spawned']
    : {}) as Record<string, unknown>;
  const total = (typeof entry['total'] === 'object' && entry['total'] !== null
    ? entry['total']
    : {}) as Record<string, unknown>;
  const requests = numberOr0(entry['requests']);
  return {
    uid: typeof entry['uid'] === 'string' ? entry['uid'] : `${agent}:${id}`,
    id,
    agent,
    projectId: String(entry['projectId'] ?? projectId),
    projectName: String(entry['projectName'] ?? projectName),
    workspace: String(entry['workspace'] ?? entry['cwd'] ?? ''),
    title: stringOrNull(entry['title']),
    cwd: stringOrNull(entry['cwd']),
    createdAt: numberOrNull(entry['createdAt']),
    firstUsage: numberOrNull(entry['firstUsage']),
    lastUsage: numberOrNull(entry['lastUsage']),
    requests,
    tokens,
    cost,
    isSubagent: entry['isSubagent'] === true,
    depth: numberOr0(entry['depth']),
    archived: entry['archived'] === true,
    subagentCount: numberOr0(entry['subagentCount']),
    parentId: stringOrNull(entry['parentId']),
    own: scopeFigures(
      numberOr0(own['sessions']) || 1,
      numberOr0(own['requests']) || requests,
      own['tokens'] === undefined ? tokens : asTokens(own['tokens']),
      own['cost'] === undefined ? cost : asCost(own['cost']),
    ),
    spawned: scopeFigures(
      numberOr0(spawned['sessions']),
      numberOr0(spawned['requests']),
      asTokens(spawned['tokens']),
      asCost(spawned['cost']),
    ),
    total: scopeFigures(
      numberOr0(total['sessions']) || 1,
      numberOr0(total['requests']) || requests,
      total['tokens'] === undefined ? tokens : asTokens(total['tokens']),
      total['cost'] === undefined ? cost : asCost(total['cost']),
    ),
  };
}

/** Fill in one agent total from a snapshot. */
function normalizeAgentTotals(value: unknown): AgentTotals {
  const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    id: String(entry['id'] ?? entry['agent'] ?? ''),
    label: String(entry['label'] ?? entry['id'] ?? entry['agent'] ?? ''),
    source: String(entry['source'] ?? ''),
    sessions: numberOr0(entry['sessions']),
    subagentSessions: numberOr0(entry['subagentSessions']),
    activeSessions: numberOr0(entry['activeSessions']),
    requests: numberOr0(entry['requests']),
    unpriced: numberOr0(entry['unpriced']),
    firstUsage: numberOrNull(entry['firstUsage']),
    lastUsage: numberOrNull(entry['lastUsage']),
    tokens: asTokens(entry['tokens']),
    cost: asCost(entry['cost']),
  };
}

/** Fill in one model row from a snapshot. */
function normalizeModelRow(value: unknown): ModelRow {
  const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    agent: String(entry['agent'] ?? ''),
    projectId: String(entry['projectId'] ?? ''),
    model: String(entry['model'] ?? ''),
    requests: numberOr0(entry['requests']),
    tokens: asTokens(entry['tokens']),
    cost: asCost(entry['cost']),
  };
}

/** Fill in one price band from a snapshot. */
function normalizeBandRow(value: unknown): BandRow {
  const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const components = Array.isArray(entry['components'])
    ? (entry['components'] as unknown[]).map((item) => {
        const component = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
        return {
          id: String(component['id'] ?? ''),
          label: String(component['label'] ?? component['id'] ?? ''),
          rate: String(component['rate'] ?? '0'),
          per: numberOr0(component['per']) || 1,
          tokens: numberOr0(component['tokens']),
          amount: String(component['amount'] ?? '0'),
          ...(component['excess'] === undefined
            ? {}
            : { excess: component['excess'] as { tokens: number; rate: string; amount: string } }),
          ...(component['ttl'] === undefined
            ? {}
            : { ttl: component['ttl'] as { tier: string; multiplier: string; tokens: number } }),
        };
      })
    : [];
  return {
    agent: String(entry['agent'] ?? ''),
    projectId: String(entry['projectId'] ?? ''),
    model: String(entry['model'] ?? ''),
    periodId: String(entry['periodId'] ?? ''),
    periodLabel: String(entry['periodLabel'] ?? entry['periodId'] ?? ''),
    window: String(entry['window'] ?? ''),
    tier: String(entry['tier'] ?? ''),
    resolution: String(entry['resolution'] ?? ''),
    requests: numberOr0(entry['requests']),
    tokens: asTokens(entry['tokens']),
    cost: asCost(entry['cost']),
    components,
  };
}

/** A repository row from a snapshot. */
function normalizeRepo(value: unknown): RepoNode {
  const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    name: String(entry['name'] ?? ''),
    root: String(entry['root'] ?? ''),
    projects: Array.isArray(entry['projects'])
      ? (entry['projects'] as unknown[]).map((item) =>
          typeof item === 'string' ? item : String((item as Record<string, unknown>)['id'] ?? ''),
        )
      : [],
    agents: Array.isArray(entry['agents']) ? (entry['agents'] as unknown[]).map((item) => String(item)) : [],
    sessions: numberOr0(entry['sessions']),
    requests: numberOr0(entry['requests']),
    tokens: asTokens(entry['tokens']),
    cost: asCost(entry['cost']),
    agentTotals: Array.isArray(entry['agentTotals'])
      ? (entry['agentTotals'] as unknown[]).map((item) => normalizeAgentTotals(item))
      : [],
  };
}

/** Repository facts, defensively copied. */
function normalizeRepoInfo(value: unknown): { name: string; root: string; kind: string; branch?: string | undefined } {
  const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    name: String(entry['name'] ?? ''),
    root: String(entry['root'] ?? ''),
    kind: String(entry['kind'] ?? 'main'),
    ...(typeof entry['branch'] === 'string' ? { branch: entry['branch'] } : {}),
  };
}
