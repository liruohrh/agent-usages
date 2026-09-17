/**
 * Query layer: filter a loaded dataset and aggregate it into the three
 * dimensions the CLI reports — everything, per project, and per session.
 *
 * A usage record is billed by its **own** timestamp, so one session can
 * legitimately contribute to two pricing periods. Aggregates therefore carry a
 * per-period breakdown rather than a single blended rate.
 */

import type { PricingEngine } from './pricing.ts';
import { emptyBuckets, firstUsageOf, lastUsageOf } from './loader.ts';
import { COST_DIGITS, computeReport, displayCost, reconcile, type ExactCost, type UsageReport } from './accounting.ts';
import { formatDecimal, parseDecimal } from './money.ts';
import { inRange, type TimeRange } from './timerange.ts';
import type { ProjectRecord, SessionRecord, UsageDataset, UsageEntry } from './types.ts';

/** Which aggregation the user asked for. */
export type UsageDimension = 'all' | 'project' | 'session';

/** Filters applied before aggregation. */
export interface UsageQuery {
  /** Selected dimension. */
  dimension: UsageDimension;
  /**
   * Whether a session's total should include the usage of the subagents it
   * spawned.
   *
   * `true` (the default) answers "what did this session cost me", folding every
   * subagent request into the session that spawned it. `false` reports the
   * session's own requests and each subagent as separate rows.
   */
  includeSubagents?: boolean;
  /** Project selectors: workspace id, project name, workspace path, or a `*` glob. */
  projects?: readonly string[];
  /** Session selectors: session id, or any unambiguous id prefix. */
  sessions?: readonly string[];
  /** Half-open time range applied to each usage record's own timestamp. */
  range: TimeRange;
  /** Units of the target currency per 1 CNY. */
  currencyRate: number;
  /** Target currency code, e.g. `CNY` or `USD`. */
  currency: string;
}

/** Per-model token and cost figures for one usage record group. */
export interface ModelBreakdown {
  model: string;
  requests: number;
  tokens: import('./types.ts').TokenTotals;
  cost: import('./types.ts').CostTotals;
}

/** One project's aggregate. */
export interface ProjectReport {
  workspaceId: string;
  name: string;
  path: string;
  /** Sessions in scope: top-level sessions when subagents are folded in, every session otherwise. */
  sessions: number;
  activeSessions: number;
  /** Subagent sessions in scope. */
  subagentSessions: number;
  requests: number;
  firstUsage: number | null;
  lastUsage: number | null;
  tokens: import('./types.ts').TokenTotals;
  cost: import('./types.ts').CostTotals;
  bands: import('./types.ts').PricingBandSummary[];
  models: ModelBreakdown[];
  /** Present only in the `session` dimension, where each project lists its sessions. */
  sessionReports?: SessionReport[];
}

/** One session's aggregate. */
export interface SessionReport {
  sessionId: string;
  title: string | null;
  cwd: string | null;
  projectName: string;
  workspaceId: string | null;
  createdAt: number | null;
  firstUsage: number | null;
  lastUsage: number | null;
  /** Whether this row is a subagent session rather than a session a human started. */
  isSubagent: boolean;
  /** For a top-level row: how many subagents were folded into it. */
  subagentCount: number;
  /** For a subagent row: the session that spawned it. */
  parentSessionId: string | null;
  requests: number;
  tokens: import('./types.ts').TokenTotals;
  cost: import('./types.ts').CostTotals;
  bands: import('./types.ts').PricingBandSummary[];
  models: ModelBreakdown[];
  /** Set when the ledger disagrees with the harness' own projection totals. */
  warning?: string;
}

/** How subagent sessions were treated in a report. */
export interface SubagentScope {
  /**
   * `true` when subagent sessions are listed separately, `false` when their
   * usage is folded into the session that spawned them.
   */
  split: boolean;
  /** How many subagent sessions were in scope. */
  rows: number;
  /** Sessions in scope that spawned at least one subagent. */
  parents: number;
  /** Token totals attributable to subagent sessions alone. */
  tokens: import('./types.ts').TokenTotals;
  /** Cost attributable to subagent sessions alone, in the display currency. */
  cost: import('./types.ts').CostTotals;
  /** Number of billed requests made by subagent sessions. */
  requests: number;
}

/** The complete answer to a {@link UsageQuery}. */
export interface UsageResult {
  dimension: UsageDimension;
  range: TimeRange;
  currency: string;
  currencyRate: number;
  /** How subagents were treated, and what they contributed on their own. */
  subagents: SubagentScope;
  requests: number;
  tokens: import('./types.ts').TokenTotals;
  cost: import('./types.ts').CostTotals;
  bands: import('./types.ts').PricingBandSummary[];
  models: ModelBreakdown[];
  projects: ProjectReport[];
  warnings: string[];
}

/** Glob matching where `*` matches any run of characters and `?` matches one. */
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('')
    .map((character) => {
      if (character === '*') return '.*';
      if (character === '?') return '.';
      return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`, 'i');
}

/** Whether any selector matches a candidate, treating selectors as globs. */
function matchesAny(candidate: string, selectors: readonly string[]): boolean {
  const lower = candidate.toLowerCase();
  return selectors.some((selector) => {
    const trimmed = selector.trim();
    if (trimmed.length === 0) return false;
    return globToRegExp(trimmed).test(lower);
  });
}

/** Every spelling of a project a selector may refer to. */
function projectKeys(project: ProjectRecord): string[] {
  const keys = [project.workspaceId, project.name, project.path];
  if (project.path.length > 0) {
    const base = project.path.split(/[\\/]/).filter((part) => part.length > 0).pop();
    if (base !== undefined) keys.push(base);
  }
  return keys.filter((key) => key.length > 0);
}

/**
 * Every spelling of a session a selector may refer to.
 *
 * DSH writes ids with a `session-` prefix in the UI and on disk, while the
 * ledger keys its rows by the bare UUID, so both spellings must match.
 */
function sessionKeys(session: SessionRecord): string[] {
  const bare = session.sessionId.replace(/^session-/, '');
  return session.sessionId === bare ? [bare, `session-${bare}`] : [session.sessionId, bare];
}

/** Resolve session selectors to concrete session ids, rejecting ambiguity. */
export function resolveSessionSelectors(
  sessions: readonly SessionRecord[],
  selectors: readonly string[],
): { ids: Set<string>; errors: string[] } {
  const ids = new Set<string>();
  const errors: string[] = [];
  for (const selector of selectors) {
    const trimmed = selector.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.includes('*') || trimmed.includes('?')) {
      const matched = sessions.filter((session) => matchesAny(session.sessionId, [trimmed]) || matchesAny(`session-${session.sessionId}`, [trimmed]));
      if (matched.length === 0) errors.push(`没有会话匹配 "${trimmed}"`);
      for (const session of matched) ids.add(session.sessionId);
      continue;
    }
    const exact = sessions.find((session) => sessionKeys(session).some((key) => key.toLowerCase() === trimmed.toLowerCase()));
    if (exact !== undefined) {
      ids.add(exact.sessionId);
      continue;
    }
    // Accept any unambiguous prefix so users can paste a short id.
    const byPrefix = sessions.filter((session) => sessionKeys(session).some((key) => key.toLowerCase().startsWith(trimmed.toLowerCase())));
    if (byPrefix.length === 0) {
      errors.push(`找不到会话 "${trimmed}"`);
    } else if (byPrefix.length > 1) {
      errors.push(`会话 "${trimmed}" 有 ${byPrefix.length} 个候选，请提供更长的前缀：${byPrefix.slice(0, 5).map((session) => session.sessionId).join('、')}`);
    } else {
      ids.add((byPrefix[0] as SessionRecord).sessionId);
    }
  }
  return { ids, errors };
}

/**
 * Expand a set of session ids with every session they transitively spawned.
 *
 * Session selection follows delegation: naming a session a human started means
 * "that session and its subagents". A subagent is still selectable on its own,
 * in which case only it (and anything *it* spawned) is in scope.
 * @param dataset - the loaded dataset.
 * @param ids - the directly selected session ids.
 * @returns the selected ids plus all their descendants.
 */
export function collectDescendantIds(dataset: UsageDataset, sessionId: string): Set<string> {
  const expanded = expandWithDescendants(dataset, new Set([sessionId]));
  // The seed itself is not a descendant.
  expanded.delete(sessionId);
  return expanded;
}

/**
 * Expand a set of session ids with every session they transitively spawned.
 *
 * Session selection follows delegation: naming a session a human started means
 * "that session and its subagents". A subagent is still selectable on its own,
 * in which case only it (and anything *it* spawned) is in scope.
 * @param dataset - the loaded dataset.
 * @param ids - the directly selected session ids.
 * @returns the selected ids plus all their descendants.
 */
export function expandWithDescendants(dataset: UsageDataset, ids: ReadonlySet<string>): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const session of dataset.sessions) {
    if (session.parentSessionId === null) continue;
    const bucket = byParent.get(session.parentSessionId);
    if (bucket === undefined) byParent.set(session.parentSessionId, [session.sessionId]);
    else bucket.push(session.sessionId);
  }
  const expanded = new Set(ids);
  const queue = [...ids];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const child of byParent.get(current) ?? []) {
      if (expanded.has(child)) continue;
      expanded.add(child);
      queue.push(child);
    }
  }
  return expanded;
}

/** Resolve project selectors to concrete workspace keys, rejecting ambiguity. */
export function resolveProjectSelectors(
  projects: readonly ProjectRecord[],
  selectors: readonly string[],
): { keys: Set<string>; errors: string[] } {
  const keys = new Set<string>();
  const errors: string[] = [];
  for (const selector of selectors) {
    const trimmed = selector.trim();
    if (trimmed.length === 0) continue;
    const matched = projects.filter((project) => matchesAny(project.workspaceId, [trimmed]) || projectKeys(project).some((key) => matchesAny(key, [trimmed])));
    if (matched.length === 0) errors.push(`没有项目匹配 "${trimmed}"`);
    for (const project of matched) keys.add(project.workspaceId);
  }
  return { keys, errors };
}

/** Filter one session's usage records to the requested time range. */
function filterEntries(entries: readonly UsageEntry[], range: TimeRange): UsageEntry[] {
  if (range.from === null && range.to === null) return [...entries];
  return entries.filter((entry) => inRange(entry.time, range));
}

/** Build the per-model breakdown for a set of usage records. */
function modelsOf(entries: readonly UsageEntry[], engine: PricingEngine, currencyRate: number): ModelBreakdown[] {
  const byModel = new Map<string, UsageEntry[]>();
  for (const entry of entries) {
    const bucket = byModel.get(entry.model);
    if (bucket === undefined) byModel.set(entry.model, [entry]);
    else bucket.push(entry);
  }
  const breakdown: ModelBreakdown[] = [];
  for (const [model, entries] of byModel) {
    const report = computeReport(entries, engine, currencyRate);
    breakdown.push({ model, requests: report.requests, tokens: report.tokens, cost: report.cost });
  }
  breakdown.sort(
    (left, right) =>
      parseDecimal(right.cost.total) === parseDecimal(left.cost.total)
        ? left.model.localeCompare(right.model)
        : parseDecimal(right.cost.total) > parseDecimal(left.cost.total)
          ? 1
          : -1,
  );
  return breakdown;
}

/** Turn one session plus its filtered records into a report row. */
function sessionReport(
  session: SessionRecord,
  entries: UsageEntry[],
  projectName: string,
  engine: PricingEngine,
  currencyRate: number,
  subagents: { includeSubagents: boolean; subagentCount: number },
): SessionReport {
  const report = computeReport(entries, engine, currencyRate);
  const row: SessionReport = {
    sessionId: session.sessionId,
    title: session.title,
    cwd: session.cwd,
    projectName,
    workspaceId: session.workspaceId,
    createdAt: session.createdAt,
    firstUsage: entries.length === 0 ? null : (entries[0] as UsageEntry).time,
    lastUsage: entries.length === 0 ? null : (entries[entries.length - 1] as UsageEntry).time,
    isSubagent: session.isSubagent,
    subagentCount: subagents.subagentCount,
    parentSessionId: session.parentSessionId,
    requests: report.requests,
    tokens: report.tokens,
    cost: report.cost,
    bands: report.bands,
    models: modelsOf(entries, engine, currencyRate),
  };
  if (session.projectedTotals !== null && entries.length === session.entries.length) {
    const warning = reconcile(sumTokensOf(entries), session.projectedTotals);
    if (warning !== undefined) row.warning = warning;
  }
  return row;
}

/** Sum provider buckets without constructing a cost report. */
function sumTokensOf(entries: readonly UsageEntry[]): import('./types.ts').TokenTotals {
  const totals = emptyBuckets();
  for (const entry of entries) {
    totals.input += entry.tokens.input;
    totals.output += entry.tokens.output;
    totals.cacheRead += entry.tokens.cacheRead;
    totals.cacheWrite += entry.tokens.cacheWrite;
    totals.reasoning += entry.tokens.reasoning;
  }
  return totals;
}

/**
 * Merge a list of reports into one.
 *
 * Cost is summed from the reports' **exact** components and rounded once here,
 * never from their already-rounded display values: otherwise each merged report
 * contributes its own rounding remainder, and the same grand total would come
 * out differently depending on how the usage was grouped (folded vs. split,
 * one project vs. many).
 */
function mergeReports(reports: readonly UsageReport[]): UsageReport {
  const tokens = emptyBuckets();
  let requests = 0;
  let cacheHitInputTokens = 0;
  let cacheMissInputTokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  const exactCost: ExactCost = { cacheHitInputCost: 0n, cacheMissInputCost: 0n, outputCost: 0n };
  const bands = new Map<string, import('./types.ts').PricingBandSummary>();
  for (const report of reports) {
    requests += report.requests;
    tokens.input += report.tokens.input;
    tokens.output += report.tokens.output;
    tokens.cacheRead += report.tokens.cacheRead;
    tokens.cacheWrite += report.tokens.cacheWrite;
    tokens.reasoning += report.tokens.reasoning;
    cacheHitInputTokens += report.cost.cacheHitInputTokens;
    cacheMissInputTokens += report.cost.cacheMissInputTokens;
    outputTokens += report.cost.outputTokens;
    cacheWriteTokens += report.cost.cacheWriteTokens;
    exactCost.cacheHitInputCost += report.exactCost.cacheHitInputCost;
    exactCost.cacheMissInputCost += report.exactCost.cacheMissInputCost;
    exactCost.outputCost += report.exactCost.outputCost;
    for (const band of report.bands) {
      const key = `${band.periodId}\u0000${band.band}\u0000${band.resolution}`;
      const existing = bands.get(key);
      if (existing === undefined) bands.set(key, { ...band });
      else existing.requests += band.requests;
    }
  }
  return {
    requests,
    tokens,
    exactCost,
    bands: [...bands.values()].sort(
      (left, right) => right.periodId.localeCompare(left.periodId) || left.band.localeCompare(right.band),
    ),
    cost: displayCost(exactCost, tokens),
  };
}

/**
 * Run a query against a dataset.
 * @param dataset - the loaded dataset.
 * @param query - dimension, filters, range, and currency.
 * @param engine - the pricing engine; a default engine is created when omitted.
 * @returns the aggregated result, including any selector errors as warnings.
 */
export function runQuery(
  dataset: UsageDataset,
  query: UsageQuery,
  engine: PricingEngine,
): UsageResult {
  const warnings = [...dataset.warnings];
  const projectSelection = query.projects === undefined || query.projects.length === 0
    ? undefined
    : resolveProjectSelectors(dataset.projects, query.projects);
  const sessionSelection = query.sessions === undefined || query.sessions.length === 0
    ? undefined
    : resolveSessionSelectors(dataset.sessions, query.sessions);
  for (const error of projectSelection?.errors ?? []) warnings.push(error);
  for (const error of sessionSelection?.errors ?? []) warnings.push(error);

  const selectedProjects = dataset.projects.filter((project) => projectSelection === undefined || projectSelection.keys.has(project.workspaceId));

  const includeSubagents = query.includeSubagents ?? true;
  // Selecting a session selects its whole delegation subtree: asking about a
  // session a human started naturally means "and everything it spawned".
  const selectedSessionIds = sessionSelection === undefined
    ? undefined
    : expandWithDescendants(dataset, sessionSelection.ids);

  // Every session the filters select, with its own records already narrowed to
  // the time range. A usage record must pass every active filter: time, project,
  // and session. This set is a superset of the reported rows — whether a
  // subagent becomes a row of its own or folds into an ancestor is a reporting
  // decision made below, not a reason to drop it from the data.
  const inScope: { session: SessionRecord; entries: UsageEntry[] }[] = [];
  const inScopeByProject = new Map<string, { session: SessionRecord; entries: UsageEntry[] }[]>();
  for (const project of selectedProjects) {
    const rows: { session: SessionRecord; entries: UsageEntry[] }[] = [];
    for (const session of project.sessions) {
      if (selectedSessionIds !== undefined && !selectedSessionIds.has(session.sessionId)) continue;
      const row = { session, entries: filterEntries(session.entries, query.range) };
      rows.push(row);
      inScope.push(row);
    }
    inScopeByProject.set(project.workspaceId, rows);
  }

  // Scope for the grand total and the project rows. In folded mode a top-level
  // session's records become its own plus every descendant's, so the row the
  // user reads already equals the total they are shown; in split mode each
  // session stands alone.
  const scopedByProject = new Map<string, { session: SessionRecord; entries: UsageEntry[] }[]>();
  const scoped: { session: SessionRecord; entries: UsageEntry[] }[] = [];
  for (const project of selectedProjects) {
    const own = inScopeByProject.get(project.workspaceId) ?? [];
    const ownById = new Map(own.map((row) => [row.session.sessionId, row]));
    const rows: { session: SessionRecord; entries: UsageEntry[] }[] = [];
    for (const row of own) {
      const parentInScope =
        row.session.parentSessionId !== null && ownById.has(row.session.parentSessionId);
      if (includeSubagents) {
        // Folded: a subagent is represented by its ancestor, so only the top of
        // each subtree becomes a row — and that row carries the whole subtree.
        if (row.session.isSubagent && parentInScope) continue;
        const merged: UsageEntry[] = [...row.entries];
        for (const id of collectDescendantIds(dataset, row.session.sessionId)) {
          const child = ownById.get(id);
          if (child !== undefined) merged.push(...child.entries);
        }
        merged.sort((left, right) => (left.time === right.time ? left.seq - right.seq : left.time - right.time));
        rows.push({ session: row.session, entries: merged });
        continue;
      }
      // Split: every session stands alone. A subagent is a row here, so its
      // records must not also be merged into the ancestor's row — that is what
      // keeps the two modes' totals identical.
      rows.push({ session: row.session, entries: [...row.entries] });
    }
    scopedByProject.set(project.workspaceId, rows);
    scoped.push(...rows);
  }

  const projectRows: ProjectReport[] = [];
  for (const project of selectedProjects) {
    const sessionRows: SessionReport[] = [];
    const ownRows = scopedByProject.get(project.workspaceId) ?? [];
    // Session counts describe what is in scope, including subagents that were
    // folded into an ancestor's row rather than listed separately.
    const projectScope = inScopeByProject.get(project.workspaceId) ?? [];
    for (const { session, entries } of ownRows) {
      if (query.dimension === 'session' && entries.length > 0) {
        sessionRows.push(
          sessionReport(session, entries, project.name, engine, query.currencyRate, {
            includeSubagents,
            // In folded mode the row stands for the whole subtree, so the count
            // is every descendant; in split mode nothing is folded.
            subagentCount: includeSubagents ? collectDescendantIds(dataset, session.sessionId).size : 0,
          }),
        );
      }
    }
    sessionRows.sort(
      (left, right) => (right.lastUsage ?? 0) - (left.lastUsage ?? 0) || left.sessionId.localeCompare(right.sessionId),
    );
    const reports = ownRows.map(({ entries }) => computeReport(entries, engine, query.currencyRate));
    const merged = mergeReports(reports);
    const activeRows = ownRows.filter(({ entries }) => entries.length > 0);
    const row: ProjectReport = {
      workspaceId: project.workspaceId,
      name: project.name,
      path: project.path,
      sessions: includeSubagents ? ownRows.length : projectScope.length,
      activeSessions: includeSubagents ? activeRows.length : projectScope.filter(({ entries }) => entries.length > 0).length,
      // How many subagent sessions this project's report covers. Subagents have
      // no subagents of their own in this dataset, so this is just the number of
      // subagent sessions in scope.
      subagentSessions: projectScope.filter(({ session }) => session.isSubagent).length,
      requests: merged.requests,
      firstUsage: minOf(activeRows, ({ session }) => firstUsageOf(session)),
      lastUsage: maxOf(activeRows, ({ session }) => lastUsageOf(session)),
      tokens: merged.tokens,
      cost: merged.cost,
      bands: merged.bands,
      models: modelsOf(
        ownRows.flatMap(({ entries }) => entries),
        engine,
        query.currencyRate,
      ),
    };
    if (query.dimension === 'session') row.sessionReports = sessionRows;
    projectRows.push(row);
  }

  // The grand total and the per-model breakdown are computed from the in-scope
  // records in one pass. Deriving them from the reported rows instead would make
  // the headline number depend on how those rows were grouped — the same usage
  // must total the same whether subagents are folded or split.
  const allEntries: UsageEntry[] = [];
  for (const { entries } of scoped) allEntries.push(...entries);
  allEntries.sort((left, right) => (left.time === right.time ? left.seq - right.seq : left.time - right.time));
  const mergedAll = computeReport(allEntries, engine, query.currencyRate);
  // Subagent contribution is reported in both modes: folded in by default
  // (already part of the totals above), or as the separate rows themselves.
  // Subagent totals always describe the subagent sessions themselves, whether
  // or not their usage was folded into an ancestor's reported row.
  const subagentSessions = inScope.filter(({ session }) => session.isSubagent);
  const subagentMerged = mergeReports(
    subagentSessions.map(({ entries }) => computeReport(entries, engine, query.currencyRate)),
  );
  const parents = new Set<string>();
  for (const { session } of inScope) {
    if (session.parentSessionId !== null) parents.add(session.parentSessionId);
  }

  const result: UsageResult = {
    dimension: query.dimension,
    range: query.range,
    currency: query.currency,
    currencyRate: query.currencyRate,
    subagents: {
      split: !includeSubagents,
      rows: subagentSessions.length,
      parents: parents.size,
      tokens: subagentMerged.tokens,
      cost: subagentMerged.cost,
      requests: subagentMerged.requests,
    },
    requests: mergedAll.requests,
    tokens: mergedAll.tokens,
    cost: mergedAll.cost,
    bands: mergedAll.bands,
    models: modelsOf(allEntries, engine, query.currencyRate),
    projects: projectRows,
    warnings,
  };
  if (result.requests === 0) {
    warnings.push('当前筛选条件下没有任何用量记录');
  }
  return result;
}

/** Smallest non-null value produced by `pick`, or `null`. */
function minOf<T>(items: readonly T[], pick: (item: T) => number | null): number | null {
  let best: number | null = null;
  for (const item of items) {
    const value = pick(item);
    if (value === null || !Number.isFinite(value)) continue;
    if (best === null || value < best) best = value;
  }
  return best;
}

/** Largest non-null value produced by `pick`, or `null`. */
function maxOf<T>(items: readonly T[], pick: (item: T) => number | null): number | null {
  let best: number | null = null;
  for (const item of items) {
    const value = pick(item);
    if (value === null || !Number.isFinite(value)) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

/** Build the `session list` inventory: projects first, newest activity first. */
export interface SessionListEntry {
  sessionId: string;
  title: string | null;
  workspaceId: string | null;
  projectName: string;
  cwd: string | null;
  createdAt: number | null;
  firstUsage: number | null;
  lastUsage: number | null;
  requests: number;
  tokens: import('./types.ts').TokenTotals;
  /** Whether this session is a subagent. */
  isSubagent: boolean;
  /** Delegation depth: 0 for a session a human started. */
  delegationDepth: number;
  /** The session that spawned this one, for a subagent. */
  parentSessionId: string | null;
  /** How many subagents this session spawned (0 for a subagent). */
  subagentCount: number;
  /** Requests and tokens of this session's subagents, when they are listed separately. */
  subagentRequests: number;
  /** Whether this row was expanded from its parent rather than listed at top level. */
  nested: boolean;
}

/** A project plus its sessions, ordered for the `session list` command. */
export interface SessionListProject {
  workspaceId: string;
  name: string;
  path: string;
  firstUsage: number | null;
  lastUsage: number | null;
  sessions: SessionListEntry[];
}

/** The `session list` inventory. */
export interface SessionListResult {
  projects: SessionListProject[];
  totalSessions: number;
  warnings: string[];
}

/**
 * Inventory every project and session, newest first.
 *
 * Ordering is by first session time descending for projects and by session time
 * descending within a project, as requested. "Session time" is the first billed
 * request when the ledger has one and the session's creation time otherwise.
 * @param dataset - the loaded dataset.
 * @param filters - optional project and session selectors.
 * @returns the ordered inventory.
 */
export function listSessions(
  dataset: UsageDataset,
  filters: {
    projects?: readonly string[];
    sessions?: readonly string[];
    /** List subagents separately (true) or fold them into their parent's row (false, the default). */
    includeSubagents?: boolean;
  } = {},
): SessionListResult {
  const includeSubagents = filters.includeSubagents ?? false;
  const warnings = [...dataset.warnings];
  const projectSelection = filters.projects === undefined || filters.projects.length === 0
    ? undefined
    : resolveProjectSelectors(dataset.projects, filters.projects);
  const sessionSelection = filters.sessions === undefined || filters.sessions.length === 0
    ? undefined
    : resolveSessionSelectors(dataset.sessions, filters.sessions);
  for (const error of projectSelection?.errors ?? []) warnings.push(error);
  for (const error of sessionSelection?.errors ?? []) warnings.push(error);

  const selected = sessionSelection === undefined
    ? undefined
    : expandWithDescendants(dataset, sessionSelection.ids);

  const projects: SessionListProject[] = [];
  let totalSessions = 0;
  for (const project of dataset.projects) {
    if (projectSelection !== undefined && !projectSelection.keys.has(project.workspaceId)) continue;
    const rows: SessionListEntry[] = [];
    for (const session of project.sessions) {
      if (selected !== undefined && !selected.has(session.sessionId)) continue;
      const first = session.entries.length > 0 ? firstUsageOf(session) : null;
      const last = session.entries.length > 0 ? lastUsageOf(session) : null;
      const subagentEntries = session.subagentIds.reduce((total, id) => {
        const child = dataset.sessions.find((candidate) => candidate.sessionId === id);
        return total + (child?.entries.length ?? 0);
      }, 0);
      rows.push({
        sessionId: session.sessionId,
        title: session.title,
        workspaceId: session.workspaceId,
        projectName: project.name,
        cwd: session.cwd,
        createdAt: session.createdAt,
        firstUsage: first,
        lastUsage: last,
        requests: session.entries.length,
        tokens: sumTokensOf(session.entries),
        isSubagent: session.isSubagent,
        delegationDepth: session.delegationDepth,
        parentSessionId: session.parentSessionId,
        subagentCount: session.subagentIds.length,
        subagentRequests: subagentEntries,
        nested: false,
      });
    }
    if (rows.length === 0) continue;

    // Default: a top-level session stands for itself **and** its subagents, so
    // its row already carries the combined token total and the subagent count.
    // A subagent is only listed on its own when the user asks for it.
    const own = includeSubagents ? rows : rows.filter((row) => !row.isSubagent);
    const listed = own.map((row) => {
      if (includeSubagents || row.subagentCount === 0) return row;
      const children = rows.filter((candidate) => candidate.parentSessionId === row.sessionId);
      if (children.length === 0) return row;
      return {
        ...row,
        requests: row.requests + children.reduce((total, child) => total + child.requests, 0),
        tokens: mergeTokenTotals(row.tokens, children.map((child) => child.tokens)),
        firstUsage: minOf([row, ...children], (entry) => entry.firstUsage),
        lastUsage: maxOf([row, ...children], (entry) => entry.lastUsage),
      };
    });
    if (listed.length === 0) continue;

    // Order the top-level rows newest first, then hang each session's subagents
    // directly beneath it. Subagents are never re-sorted into the top level, so
    // a child appears exactly once.
    const topLevel = listed
      .filter((row) => !row.isSubagent)
      .sort((left, right) => sortInstantOf(right) - sortInstantOf(left) || left.sessionId.localeCompare(right.sessionId));
    const ordered: SessionListEntry[] = [];
    for (const row of topLevel) {
      ordered.push(row);
      if (!includeSubagents) continue;
      const children = rows
        .filter((candidate) => candidate.parentSessionId === row.sessionId)
        .sort((left, right) => sortInstantOf(right) - sortInstantOf(left) || left.sessionId.localeCompare(right.sessionId));
      for (const child of children) ordered.push({ ...child, nested: true });
    }
    // A subagent whose parent was filtered out still gets a row of its own.
    const orphaned = listed.filter(
      (row) => row.isSubagent && !ordered.some((entry) => entry.sessionId === row.sessionId),
    );
    ordered.push(...orphaned);

    totalSessions += listed.length;
    projects.push({
      workspaceId: project.workspaceId,
      name: project.name,
      path: project.path,
      firstUsage: minOf(listed, (session) => session.firstUsage),
      lastUsage: maxOf(listed, (session) => session.lastUsage),
      sessions: ordered,
    });
  }
  projects.sort((left, right) => projectSortInstant(right) - projectSortInstant(left) || left.name.localeCompare(right.name));
  return { projects, totalSessions, warnings };
}

/** Add two token totals together. */
function mergeTokenTotals(base: import('./types.ts').TokenTotals, extras: readonly import('./types.ts').TokenTotals[]): import('./types.ts').TokenTotals {
  const merged = { ...base };
  for (const extra of extras) {
    merged.input += extra.input;
    merged.output += extra.output;
    merged.cacheRead += extra.cacheRead;
    merged.cacheWrite += extra.cacheWrite;
    merged.reasoning += extra.reasoning;
  }
  return merged;
}

/** Sort key for a session row: first billed request, else creation time. */
function sortInstantOf(session: SessionListEntry): number {
  if (session.firstUsage !== null) return session.firstUsage;
  if (session.createdAt !== null) return session.createdAt;
  return Number.NEGATIVE_INFINITY;
}

/** Sort key for a project row: its newest session. */
function projectSortInstant(project: SessionListProject): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const session of project.sessions) {
    const instant = sortInstantOf(session);
    if (instant > best) best = instant;
  }
  return best;
}
