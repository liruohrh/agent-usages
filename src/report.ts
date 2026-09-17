/**
 * Query layer: filter a loaded dataset and aggregate it into the dimensions the
 * CLI reports — everything, per project, and per session.
 *
 * A record is billed by its **own** timestamp, so one session can legitimately
 * contribute to two price periods and two tiers. Aggregates therefore carry a
 * per-band breakdown rather than a single blended rate, and the grand total is
 * computed in one pass over the in-scope records so it always equals the sum of
 * the rows displayed beside it.
 */

import { emptyBuckets } from './core/buckets.ts';
import type { CostTotals, ProjectRecord, SessionRecord, TokenTotals, UsageDataset, UsageRecord } from './core/types.ts';
import { costOf, costOfGrouped, type ComponentUsage, type CostSummary } from './accounting.ts';
import type { PricingEngine } from './pricing/index.ts';
import { inRange, type TimeRange } from './timerange.ts';

/** Which aggregation the user asked for. */
export type UsageDimension = 'all' | 'project' | 'session';

/**
 * How subagent sessions are presented.
 *
 * The three values are cumulative: `subagents` adds the by-scope breakdown,
 * `detail` additionally splits every subagent into its own row.
 */
export type SubagentMode = 'total' | 'subagents' | 'detail';

/** Filters applied before aggregation. */
export interface UsageQuery {
  /** Selected dimension. */
  dimension: UsageDimension;
  /**
   * How to treat the sessions another session spawned.
   *
   * - `total` (the default) — one number per session, subagents folded in. This
   *   answers "what did this session cost me".
   * - `subagents` — also break the result down by scope: the sessions a human
   *   started, all subagents together, and the two combined.
   * - `detail` — additionally give every subagent its own row.
   */
  subagentMode?: SubagentMode | undefined;
  /** Project selectors: project id, name, path, or a `*` glob. */
  projects?: readonly string[] | undefined;
  /** Session selectors: session id, or any unambiguous id prefix. */
  sessions?: readonly string[] | undefined;
  /** Half-open time range applied to each record's own timestamp. */
  range: TimeRange;
  /** Units of the target currency per 1 unit of the provider's currency. */
  currencyRate: number;
  /** Target currency code, for display. */
  currency: string;
}

/** Per-model token and cost figures. */
export interface ModelBreakdown {
  /** Model billed. */
  model: string;
  /** Requests billed under it. */
  requests: number;
  /** Token totals. */
  tokens: TokenTotals;
  /** Cost totals. */
  cost: CostTotals;
}

/** One (period, tier) group of cost, with the rates that produced it. */
export interface BandSummary {
  /** Price period the rate came from. */
  periodId: string;
  /** Period label. */
  periodLabel: string;
  /** Tier within the period. */
  tier: 'peak' | 'off-peak' | 'flat';
  /** How the period was selected. */
  resolution: 'exact' | 'fallback-later' | 'fallback-earlier' | 'fallback-default';
  /** Requests billed under this band. */
  requests: number;
  /** Amount charged under this band. */
  total: string;
  /**
   * Amount per pricing component, keyed by component id.
   *
   * Carried per band so a reader can see that, for example, cache hits were
   * partly charged at the off-peak rate and partly at the peak rate — a single
   * "unit price" for the whole report would be a fiction.
   */
  amounts: Readonly<Record<string, string>>;
  /** Rates charged in this band, keyed by component id. */
  rates: Readonly<Record<string, string>>;
  /** Prompt tokens billed in this band: cache misses + hits + writes. */
  inputTokens: number;
}

/** One session's aggregate. */
export interface SessionReport {
  /** Session id. */
  id: string;
  /** Session title, when known. */
  title: string | null;
  /** Working directory, when known. */
  cwd: string | null;
  /** Owning project's display name. */
  projectName: string;
  /** Owning project id. */
  projectId: string;
  /** Session creation time. */
  createdAt: number | null;
  /** First billed request inside the selected range. */
  firstUsage: number | null;
  /** Last billed request inside the selected range. */
  lastUsage: number | null;
  /** Whether this row is a subagent session. */
  isSubagent: boolean;
  /** For a top-level row: how many subagent sessions it stands for. */
  subagentCount: number;
  /** For a subagent row: the session that spawned it. */
  parentId: string | null;
  /** Requests billed. */
  requests: number;
  /** Token totals. */
  tokens: TokenTotals;
  /** Cost totals. */
  cost: CostTotals;
  /**
   * This session's own requests, never folded with anything it spawned.
   *
   * `own` + `spawned` is the whole picture; the row's {@link requests} is that
   * sum when subagents are folded into it and just `own` when they are listed
   * separately.
   */
  own: ScopeTotals;
  /** Everything this session spawned, folded or not. */
  spawned: ScopeTotals;
  /** `own` + `spawned`, summed at full precision. */
  total: ScopeTotals;
  /** Which bands contributed. */
  bands: BandSummary[];
  /** Per-model figures. */
  models: ModelBreakdown[];
  /** Set when the adapter's own totals disagree with the records. */
  warning?: string | undefined;
}

/** One project's aggregate. */
export interface ProjectReport {
  /** Project id. */
  id: string;
  /** Project display name. */
  name: string;
  /** Project path. */
  path: string;
  /** Sessions represented by this row's number. */
  sessions: number;
  /** Sessions that billed at least one request in range. */
  activeSessions: number;
  /** Subagent sessions covered. */
  subagentSessions: number;
  /** Requests billed. */
  requests: number;
  /** First billed request in range. */
  firstUsage: number | null;
  /** Last billed request in range. */
  lastUsage: number | null;
  /** Token totals. */
  tokens: TokenTotals;
  /** Cost totals. */
  cost: CostTotals;
  /** Requests from sessions a human started, excluding every subagent. */
  own: ScopeTotals;
  /** Requests from every subagent under this project. */
  spawned: ScopeTotals;
  /** `own` + `spawned`, summed at full precision. */
  total: ScopeTotals;
  /** Which bands contributed. */
  bands: BandSummary[];
  /** Per-model figures. */
  models: ModelBreakdown[];
  /** Present only in the `session` dimension. */
  sessionReports?: SessionReport[] | undefined;
}

/** One or more sessions plus everything they spawned, aggregated. */
export interface ScopeTotals {
  /** Sessions counted. */
  sessions: number;
  /** Requests billed. */
  requests: number;
  /** Token totals. */
  tokens: TokenTotals;
  /** Cost totals. */
  cost: CostTotals;
}

/**
 * The same usage seen three ways: sessions a human started, every subagent
 * together, and the two combined. `own` + `subagents` === `total`.
 */
export interface ScopeBreakdown {
  /** Sessions that no other session spawned. */
  own: ScopeTotals;
  /** Every subagent session, whether or not its parent is in scope. */
  subagents: ScopeTotals;
  /** Everything in scope. */
  total: ScopeTotals;
}

/** The complete answer to a {@link UsageQuery}. */
export interface UsageResult {
  /** Agent the data came from. */
  agent: string;
  /** Data root that was read. */
  source: string;
  /** Which aggregation produced this report. */
  dimension: UsageDimension;
  /** Time range applied. */
  range: TimeRange;
  /** Display currency. */
  currency: string;
  /** Units of the display currency per 1 unit of the pricing currency. */
  currencyRate: number;
  /** Pricing provider that supplied the rates. */
  pricingProvider: string;
  /** How subagents were treated. */
  subagentMode: SubagentMode;
  /** How many subagent sessions were in scope, and how many sessions spawned them. */
  subagents: { sessions: number; parents: number };
  /**
   * Usage split by scope. Present when the query asked for it
   * ({@link UsageQuery.subagentMode} is `subagents` or `detail`).
   */
  scopeBreakdown?: ScopeBreakdown | undefined;
  /** Requests billed. */
  requests: number;
  /** First billed request in range, or `null` when nothing billed. */
  firstUsage: number | null;
  /** Last billed request in range, or `null` when nothing billed. */
  lastUsage: number | null;
  /** Records nothing could price. */
  unpriced: number;
  /** Token totals. */
  tokens: TokenTotals;
  /** Cost totals. */
  cost: CostTotals;
  /** Which bands contributed. */
  bands: BandSummary[];
  /** Tokens charged per pricing component, keyed by component id. */
  components: Map<string, ComponentUsage>;
  /** Per-model figures. */
  models: ModelBreakdown[];
  /** Per-project rows. */
  projects: ProjectReport[];
  /** Non-fatal problems worth showing. */
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
  return selectors.some((selector) => {
    const trimmed = selector.trim();
    return trimmed.length > 0 && globToRegExp(trimmed).test(candidate);
  });
}

/** Every spelling of a project a selector may refer to. */
function projectKeys(project: ProjectRecord): string[] {
  const keys = [project.id, project.name, project.path];
  if (project.path.length > 0) {
    const base = project.path.split(/[\\/]/).filter((part) => part.length > 0).pop();
    if (base !== undefined) keys.push(base);
  }
  return keys.filter((key) => key.length > 0);
}

/**
 * Every spelling of a session's **id**.
 *
 * Agents commonly prefix ids (`session-<uuid>`) in their UI while keying records
 * by the bare id, so both spellings must match. A partial id is accepted too,
 * which is why id spellings are kept separate from titles: `abc` should find the
 * session whose id starts with `abc`, but must not match a *title* that happens
 * to start with it.
 */
function sessionIdKeys(session: SessionRecord): string[] {
  const bare = session.id.replace(/^session-/, '');
  return session.id === bare ? [bare, `session-${bare}`] : [session.id, bare];
}

/**
 * Every string an **exact** selector may equal.
 *
 * A session is addressable by id or by its title, because titles are how a human
 * refers to a session and ids are how a script does. Titles are trimmed on both
 * sides and may legitimately repeat, in which case every match is selected.
 * Whitespace-only titles are treated as absent so a stray space cannot match
 * several untitled sessions at once.
 */
function sessionExactKeys(session: SessionRecord): string[] {
  const keys = sessionIdKeys(session);
  const title = session.title?.trim() ?? '';
  return title.length > 0 ? [...keys, title] : keys;
}

/** Expand a set of session ids with every session they transitively spawned. */
export function expandWithDescendants(dataset: UsageDataset, ids: ReadonlySet<string>): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const session of dataset.sessions) {
    if (session.parentId === null) continue;
    const bucket = byParent.get(session.parentId);
    if (bucket === undefined) byParent.set(session.parentId, [session.id]);
    else bucket.push(session.id);
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

/** Every descendant of a session, excluding the session itself. */
export function collectDescendantIds(dataset: UsageDataset, sessionId: string): Set<string> {
  const expanded = expandWithDescendants(dataset, new Set([sessionId]));
  expanded.delete(sessionId);
  return expanded;
}

/** Resolve session selectors to concrete ids, rejecting ambiguity. */
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
      const matched = sessions.filter((session) =>
        [...sessionIdKeys(session), ...(session.title === null ? [] : [session.title.trim()])]
          .filter((key) => key.length > 0)
          .some((key) => matchesAny(key, [trimmed])),
      );
      if (matched.length === 0) errors.push(`没有会话匹配 "${trimmed}"`);
      for (const session of matched) ids.add(session.id);
      continue;
    }
    // Exact match by id or by title. Both are tried at once so that a selector
    // matching one session's id and another's title selects both, rather than
    // silently dropping whichever was found second.
    const lowered = trimmed.toLowerCase();
    const exact = sessions.filter((session) => sessionExactKeys(session).some((key) => key.toLowerCase() === lowered));
    if (exact.length > 0) {
      for (const session of exact) ids.add(session.id);
      continue;
    }
    // Accept any unambiguous id prefix so users can paste a short id.
    const byPrefix = sessions.filter((session) =>
      sessionIdKeys(session).some((key) => key.toLowerCase().startsWith(lowered)),
    );
    if (byPrefix.length === 0) {
      errors.push(`找不到会话 "${trimmed}"`);
    } else if (byPrefix.length > 1) {
      errors.push(
        `会话 "${trimmed}" 有 ${byPrefix.length} 个候选，请提供更长的前缀：${byPrefix.slice(0, 5).map((session) => session.id).join('、')}`,
      );
    } else {
      ids.add((byPrefix[0] as SessionRecord).id);
    }
  }
  return { ids, errors };
}

/** Resolve project selectors to concrete project ids, rejecting ambiguity. */
export function resolveProjectSelectors(
  projects: readonly ProjectRecord[],
  selectors: readonly string[],
): { keys: Set<string>; errors: string[] } {
  const keys = new Set<string>();
  const errors: string[] = [];
  for (const selector of selectors) {
    const trimmed = selector.trim();
    if (trimmed.length === 0) continue;
    const matched = projects.filter((project) => projectKeys(project).some((key) => matchesAny(key, [trimmed])));
    if (matched.length === 0) errors.push(`没有项目匹配 "${trimmed}"`);
    for (const project of matched) keys.add(project.id);
  }
  return { keys, errors };
}

/** Narrow records to the requested time range. */
function inRangeRecords(records: readonly UsageRecord[], range: TimeRange): UsageRecord[] {
  if (range.from === null && range.to === null) return [...records];
  return records.filter((record) => inRange(record.time, range));
}

/** Group records by model and price each group. */
function modelsOf(records: readonly UsageRecord[], engine: PricingEngine, currencyRate: number): ModelBreakdown[] {
  const byModel = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const bucket = byModel.get(record.model);
    if (bucket === undefined) byModel.set(record.model, [record]);
    else bucket.push(record);
  }
  const breakdown: ModelBreakdown[] = [];
  for (const [model, group] of byModel) {
    const summary = costOf(group, engine, currencyRate);
    breakdown.push({
      model,
      requests: summary.priced + summary.unpriced,
      tokens: summary.totals === undefined ? emptyBuckets() : sumOf(group),
      cost: summary.totals,
    });
  }
  breakdown.sort((left, right) => {
    const leftTotal = Number(left.cost.total);
    const rightTotal = Number(right.cost.total);
    return rightTotal - leftTotal || left.model.localeCompare(right.model);
  });
  return breakdown;
}

/** Sum buckets without pricing them. */
function sumOf(records: readonly UsageRecord[]): TokenTotals {
  const totals = emptyBuckets();
  for (const record of records) {
    totals.input += record.tokens.input;
    totals.output += record.tokens.output;
    totals.cacheRead += record.tokens.cacheRead;
    totals.cacheWrite += record.tokens.cacheWrite;
    totals.reasoning += record.tokens.reasoning;
  }
  return totals;
}

/** Turn a cost summary's breakdown into the report's band rows. */
function bandsOf(summary: CostSummary, engine: PricingEngine, records: readonly UsageRecord[]): BandSummary[] {
  // Rates are per (model, period, tier), so the rate for a band is taken from
  // any record billed in it — the engine is the only place that knows.
  const ratesByBand = new Map<string, Record<string, string>>();
  const inputTokensByBand = new Map<string, number>();
  for (const record of records) {
    const resolved = engine.resolve(record);
    if (resolved === undefined) continue;
    const key = `${resolved.model}\u0000${resolved.period.id}\u0000${resolved.tier}`;
    // The prompt side of the request, which is what the rate card prices.
    inputTokensByBand.set(
      key,
      (inputTokensByBand.get(key) ?? 0) + record.tokens.input + record.tokens.cacheRead + record.tokens.cacheWrite,
    );
    if (ratesByBand.has(key)) continue;
    const rates: Record<string, string> = {};
    for (const component of resolved.components) rates[component.id] = component.rate;
    ratesByBand.set(key, rates);
  }
  return summary.breakdown.map((band) => ({
    periodId: band.periodId,
    periodLabel: band.periodLabel,
    tier: band.tier,
    resolution: band.resolution,
    requests: band.requests,
    total: band.total,
    amounts: band.amounts,
    rates: ratesByBand.get(`${band.model}\u0000${band.periodId}\u0000${band.tier}`) ?? {},
    inputTokens: inputTokensByBand.get(`${band.model}\u0000${band.periodId}\u0000${band.tier}`) ?? 0,
  }));
}

/** Build one session's report row from its records. */
function sessionReport(
  session: SessionRecord,
  records: UsageRecord[],
  ownRecords: UsageRecord[],
  spawnedRecords: UsageRecord[],
  spawnedSessions: number,
  project: ProjectRecord,
  engine: PricingEngine,
  currencyRate: number,
  subagentCount: number,
  warning: string | undefined,
): SessionReport {
  const summary = costOf(records, engine, currencyRate);
  const row: SessionReport = {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    projectName: project.name,
    projectId: project.id,
    createdAt: session.createdAt,
    firstUsage: records[0]?.time ?? null,
    lastUsage: records[records.length - 1]?.time ?? null,
    isSubagent: session.isSubagent,
    subagentCount,
    parentId: session.parentId,
    requests: records.length,
    tokens: summary.totals === undefined ? emptyBuckets() : sumOf(records),
    cost: summary.totals,
    own: totalsOf(ownRecords, 1, engine, currencyRate),
    spawned: totalsOf(spawnedRecords, spawnedSessions, engine, currencyRate),
    total: totalsOf([...ownRecords, ...spawnedRecords], 1 + spawnedSessions, engine, currencyRate),
    bands: bandsOf(summary, engine, records),
    models: modelsOf(records, engine, currencyRate),
  };
  if (warning !== undefined) row.warning = warning;
  return row;
}

/** Aggregate a record set (and how many sessions produced it) into a scope row. */
function totalsOf(
  records: readonly UsageRecord[],
  sessions: number,
  engine: PricingEngine,
  currencyRate: number,
): ScopeTotals {
  const summary = costOf(records as UsageRecord[], engine, currencyRate);
  return {
    sessions,
    requests: summary.priced + summary.unpriced,
    tokens: sumOf(records as UsageRecord[]),
    cost: summary.totals,
  };
}

/** Aggregate a set of in-scope sessions into one scope row. */
function scopeTotals(
  entries: readonly ScopedSession[],
  engine: PricingEngine,
  currencyRate: number,
): ScopeTotals {
  const records = entries.flatMap((entry) => entry.records);
  const summary = costOf(records, engine, currencyRate);
  return {
    sessions: entries.length,
    requests: summary.priced + summary.unpriced,
    tokens: sumOf(records),
    cost: summary.totals,
  };
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

/** A session together with the records that survived filtering. */
interface ScopedSession {
  session: SessionRecord;
  records: UsageRecord[];
}

/** Options for {@link runQuery} beyond the query itself. */
export interface ReportContext {
  /** Pricing engine supplying rates. */
  engine: PricingEngine;
  /** Provider id, reported back for provenance. */
  pricingProvider: string;
}

/**
 * Run a query against a dataset.
 * @param dataset - the loaded dataset.
 * @param query - dimension, filters, range, and currency.
 * @param context - pricing engine and its provider id.
 * @returns the aggregated result, including selector errors as warnings.
 */
export function runQuery(dataset: UsageDataset, query: UsageQuery, context: ReportContext): UsageResult {
  const { engine } = context;
  const warnings = [...dataset.warnings];
  const projectSelection = query.projects === undefined || query.projects.length === 0
    ? undefined
    : resolveProjectSelectors(dataset.projects, query.projects);
  const sessionSelection = query.sessions === undefined || query.sessions.length === 0
    ? undefined
    : resolveSessionSelectors(dataset.sessions, query.sessions);
  for (const error of projectSelection?.errors ?? []) warnings.push(error);
  for (const error of sessionSelection?.errors ?? []) warnings.push(error);

  const mode = query.subagentMode ?? 'total';
  // `detail` implies the by-scope breakdown: it is the same question asked with
  // more rows, so the summary above it would otherwise contradict itself.
  const wantsBreakdown = mode !== 'total';
  // `detail` shows every subagent on its own; `total` and `subagents` report one
  // row per session a human started, with subagents folded into it.
  const splitRows = mode === 'detail';
  const selectedProjects = dataset.projects.filter(
    (project) => projectSelection === undefined || projectSelection.keys.has(project.id),
  );
  // Selecting a session selects its whole delegation subtree: asking about a
  // session a human started naturally means "and everything it spawned".
  const selectedSessionIds = sessionSelection === undefined
    ? undefined
    : expandWithDescendants(dataset, sessionSelection.ids);

  // Every session in scope, with its records narrowed to the time range. This is
  // a superset of the reported rows: whether a subagent becomes a row of its own
  // or folds into an ancestor is a reporting decision, not a reason to drop it.
  const inScope: ScopedSession[] = [];
  const inScopeByProject = new Map<string, ScopedSession[]>();
  for (const project of selectedProjects) {
    const rows: ScopedSession[] = [];
    for (const session of project.sessions) {
      if (selectedSessionIds !== undefined && !selectedSessionIds.has(session.id)) continue;
      const row: ScopedSession = { session, records: inRangeRecords(session.records, query.range) };
      rows.push(row);
      inScope.push(row);
    }
    inScopeByProject.set(project.id, rows);
  }

  // Which sessions get a row of their own, and what each row covers.
  const scopedByProject = new Map<string, ScopedSession[]>();
  const scoped: ScopedSession[] = [];
  for (const project of selectedProjects) {
    const own = inScopeByProject.get(project.id) ?? [];
    const ownById = new Map(own.map((row) => [row.session.id, row]));
    const rows: ScopedSession[] = [];
    for (const row of own) {
      if (!splitRows) {
        // Folded: only the top of each subtree gets a row, and it carries the
        // whole subtree.
        const parentInScope = row.session.parentId !== null && ownById.has(row.session.parentId);
        if (row.session.isSubagent && parentInScope) continue;
        const records = [...row.records];
        for (const id of collectDescendantIds(dataset, row.session.id)) {
          const child = ownById.get(id);
          if (child !== undefined) records.push(...child.records);
        }
        records.sort((left, right) => (left.time === right.time ? (left.seq ?? 0) - (right.seq ?? 0) : left.time - right.time));
        rows.push({ session: row.session, records });
        continue;
      }
      // Detail: every session stands alone, so a subagent's records are not also
      // merged into an ancestor's row — that keeps both modes' totals identical.
      rows.push({ session: row.session, records: [...row.records] });
    }
    scopedByProject.set(project.id, rows);
    scoped.push(...rows);
  }

  const projectRows: ProjectReport[] = [];
  for (const project of selectedProjects) {
    const ownRows = scopedByProject.get(project.id) ?? [];
    const projectScope = inScopeByProject.get(project.id) ?? [];
    const rowById = new Map(projectScope.map((entry) => [entry.session.id, entry]));
    // One pricing pass per project, merged at full precision.
    const summary = costOfGrouped(ownRows.map((row) => row.records), engine, query.currencyRate);
    const activeRows = ownRows.filter((row) => row.records.length > 0);
    const projectRecords = ownRows.flatMap((row) => row.records);
    const topLevelScope = projectScope.filter((entry) => !entry.session.isSubagent);
    const subagentScope = projectScope.filter((entry) => entry.session.isSubagent);
    const row: ProjectReport = {
      id: project.id,
      name: project.name,
      path: project.path,
      sessions: splitRows ? projectScope.length : ownRows.length,
      activeSessions: splitRows
        ? projectScope.filter((entry) => entry.records.length > 0).length
        : activeRows.length,
      subagentSessions: subagentScope.length,
      requests: summary.priced + summary.unpriced,
      firstUsage: minOf(activeRows, (entry) => entry.records[0]?.time ?? null),
      lastUsage: maxOf(activeRows, (entry) => entry.records[entry.records.length - 1]?.time ?? null),
      tokens: sumOf(projectRecords),
      cost: summary.totals,
      own: totalsOf(topLevelScope.flatMap((entry) => entry.records), topLevelScope.length, engine, query.currencyRate),
      spawned: totalsOf(subagentScope.flatMap((entry) => entry.records), subagentScope.length, engine, query.currencyRate),
      total: totalsOf(projectScope.flatMap((entry) => entry.records), projectScope.length, engine, query.currencyRate),
      bands: bandsOf(summary, engine, projectRecords),
      models: modelsOf(projectRecords, engine, query.currencyRate),
    };
    if (query.dimension === 'session') {
      const sessionRows: SessionReport[] = [];
      for (const { session, records } of ownRows) {
        if (records.length === 0) continue;
        const warning = adapterWarning(session, records);
        // A row's own records are never its folded ones: the split has to stay
        // exact in both modes so `自身 + 子代理` always explains the node.
        const ownRecords = rowById.get(session.id)?.records ?? records;
        const descendantIds = collectDescendantIds(dataset, session.id);
        const spawnedRecords = [...descendantIds].flatMap((id) => rowById.get(id)?.records ?? []);
        sessionRows.push(
          sessionReport(
            session,
            records,
            ownRecords,
            spawnedRecords,
            descendantIds.size,
            project,
            engine,
            query.currencyRate,
            splitRows ? 0 : descendantIds.size,
            warning,
          ),
        );
      }
      sessionRows.sort(
        (left, right) => (right.lastUsage ?? 0) - (left.lastUsage ?? 0) || left.id.localeCompare(right.id),
      );
      row.sessionReports = sessionRows;
    }
    projectRows.push(row);
  }

  // The headline total is computed in one pass over the in-scope records.
  // Deriving it from the reported rows instead would make the number depend on
  // how those rows were grouped — the same usage must total the same whether
  // subagents are folded or split.
  const allRecords: UsageRecord[] = [];
  for (const { records } of scoped) allRecords.push(...records);
  allRecords.sort((left, right) => (left.time === right.time ? (left.seq ?? 0) - (right.seq ?? 0) : left.time - right.time));
  const mergedAll = costOf(allRecords, engine, query.currencyRate);

  // The by-scope breakdown always describes the records themselves — the sessions
  // a human started, every subagent, and the two together — so it stays true
  // whether or not those records were folded into a parent's reported row.
  const ownSessions = inScope.filter((entry) => !entry.session.isSubagent);
  const subagentSessions = inScope.filter((entry) => entry.session.isSubagent);
  const parents = new Set<string>();
  for (const { session } of inScope) {
    if (session.parentId !== null) parents.add(session.parentId);
  }
  const scopeBreakdown = wantsBreakdown
    ? {
        own: scopeTotals(ownSessions, engine, query.currencyRate),
        subagents: scopeTotals(subagentSessions, engine, query.currencyRate),
        total: scopeTotals(inScope, engine, query.currencyRate),
      }
    : undefined;

  const result: UsageResult = {
    agent: dataset.agent,
    source: dataset.source,
    dimension: query.dimension,
    range: query.range,
    currency: query.currency,
    currencyRate: query.currencyRate,
    pricingProvider: context.pricingProvider,
    subagentMode: mode,
    subagents: { sessions: subagentSessions.length, parents: parents.size },
    ...(scopeBreakdown === undefined ? {} : { scopeBreakdown }),
    requests: mergedAll.priced + mergedAll.unpriced,
    firstUsage: allRecords[0]?.time ?? null,
    lastUsage: allRecords[allRecords.length - 1]?.time ?? null,
    unpriced: mergedAll.unpriced,
    tokens: sumOf(allRecords),
    cost: mergedAll.totals,
    bands: bandsOf(mergedAll, engine, allRecords),
    components: mergedAll.components,
    models: modelsOf(allRecords, engine, query.currencyRate),
    projects: projectRows,
    warnings,
  };
  if (result.requests === 0) warnings.push('当前筛选条件下没有任何用量记录');
  if (result.unpriced > 0) {
    warnings.push(`有 ${result.unpriced} 条记录没有可用价格，未计入费用（可用 \`price\` 查看已收录的模型）`);
  }
  return result;
}

/**
 * Compare a session's records against the adapter's own totals, when it kept some.
 * @param session - the session.
 * @param records - the records that were billed.
 * @returns a warning, or `undefined` when there is nothing to compare or they agree.
 */
function adapterWarning(session: SessionRecord, records: readonly UsageRecord[]): string | undefined {
  const projected = session.extra?.['projectedTotals'];
  if (!isBuckets(projected) || records.length !== session.records.length) return undefined;
  const totals = sumOf(records);
  const diffs: string[] = [];
  const compare = (label: string, left: number, right: number): void => {
    if (left !== right) diffs.push(`${label} 日志 ${left} vs 投影缓存 ${right}`);
  };
  compare('未命中输入', totals.input, projected.input);
  compare('输出', totals.output, projected.output);
  compare('缓存命中输入', totals.cacheRead, projected.cacheRead);
  compare('缓存写入', totals.cacheWrite, projected.cacheWrite);
  return diffs.length === 0 ? undefined : `会话用量与投影缓存不一致：${diffs.join('；')}`;
}

/** Narrow an `unknown` to a token bucket set. */
function isBuckets(value: unknown): value is TokenTotals {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return ['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => typeof candidate[key] === 'number');
}

/** One session row in the `session list` inventory. */
export interface SessionListEntry {
  /** Session id. */
  id: string;
  /** Session title. */
  title: string | null;
  /** Owning project id. */
  projectId: string;
  /** Owning project name. */
  projectName: string;
  /** Working directory. */
  cwd: string | null;
  /** Session creation time. */
  createdAt: number | null;
  /** First billed request. */
  firstUsage: number | null;
  /** Last billed request. */
  lastUsage: number | null;
  /** Requests billed. */
  requests: number;
  /** Token totals. */
  tokens: TokenTotals;
  /** Whether this session is a subagent. */
  isSubagent: boolean;
  /** Delegation depth. */
  depth: number;
  /** The session that spawned this one. */
  parentId: string | null;
  /** How many subagents this session spawned. */
  subagentCount: number;
  /** Requests made by this session's subagents. */
  subagentRequests: number;
  /** Whether this row was nested under its parent rather than listed at top level. */
  nested: boolean;
}

/** A project plus its sessions, ordered for the `session list` command. */
export interface SessionListProject {
  /** Project id. */
  id: string;
  /** Project display name. */
  name: string;
  /** Project path. */
  path: string;
  /** Earliest session time. */
  firstUsage: number | null;
  /** Latest session time. */
  lastUsage: number | null;
  /**
   * Display rows, newest first, with each subagent nested beneath its parent.
   * A folded row stands for its whole subtree, so this can be shorter than
   * {@link SessionListProject.sessionCount}.
   */
  sessions: SessionListEntry[];
  /** Sessions in scope, counting subagents that were folded into a parent row. */
  sessionCount: number;
}

/** The `session list` inventory. */
export interface SessionListResult {
  /** Agent the data came from. */
  agent: string;
  /** Data root that was read. */
  source: string;
  /** Projects, newest activity first. */
  projects: SessionListProject[];
  /** Sessions listed. */
  totalSessions: number;
  /** Non-fatal problems worth showing. */
  warnings: string[];
}

/** Filters accepted by {@link listSessions}. */
export interface SessionListFilters {
  /** Project selectors. */
  projects?: readonly string[] | undefined;
  /** Session selectors. */
  sessions?: readonly string[] | undefined;
  /** List subagents separately (`true`) or fold them into their parent (`false`, default). */
  includeSubagents?: boolean | undefined;
}

/** Sort key for a session row: first billed request, else creation time. */
function sortInstantOf(session: SessionListEntry): number {
  if (session.firstUsage !== null) return session.firstUsage;
  if (session.createdAt !== null) return session.createdAt;
  return Number.NEGATIVE_INFINITY;
}

/**
 * Inventory every project and session, newest first.
 *
 * Ordering is by first session time descending for projects and by session time
 * descending within a project. "Session time" is the first billed request when
 * there is one and the session's creation time otherwise.
 *
 * A session is listed exactly once. A subagent is nested beneath its parent when
 * that parent is also in scope, and stands on its own when it is not — so a
 * subagent named directly, or reached through a filter, never disappears.
 * @param dataset - the loaded dataset.
 * @param filters - optional project and session selectors, and subagent handling.
 * @returns the ordered inventory.
 */
export function listSessions(dataset: UsageDataset, filters: SessionListFilters = {}): SessionListResult {
  const warnings = [...dataset.warnings];
  const includeSubagents = filters.includeSubagents ?? false;
  const projectSelection = filters.projects === undefined || filters.projects.length === 0
    ? undefined
    : resolveProjectSelectors(dataset.projects, filters.projects);
  const sessionSelection = filters.sessions === undefined || filters.sessions.length === 0
    ? undefined
    : resolveSessionSelectors(dataset.sessions, filters.sessions);
  for (const error of projectSelection?.errors ?? []) warnings.push(error);
  for (const error of sessionSelection?.errors ?? []) warnings.push(error);

  const selected = sessionSelection === undefined ? undefined : expandWithDescendants(dataset, sessionSelection.ids);
  const projects: SessionListProject[] = [];
  let totalSessions = 0;

  for (const project of dataset.projects) {
    if (projectSelection !== undefined && !projectSelection.keys.has(project.id)) continue;

    // Every session in scope, with its tokens already summed.
    const all = new Map<string, SessionListEntry>();
    for (const session of project.sessions) {
      if (selected !== undefined && !selected.has(session.id)) continue;
      all.set(session.id, toListEntry(session, project, dataset));
    }
    if (all.size === 0) continue;

    // A subagent whose parent is also in scope is nested under it; one whose
    // parent is absent (named directly, or filtered out) stands on its own.
    const hasParentInScope = (entry: SessionListEntry): boolean =>
      entry.parentId !== null && all.has(entry.parentId);

    // A "root" is a session with no parent in scope: a top-level session, or a
    // subagent whose parent was named away.
    const allEntries = [...all.values()];
    const roots = allEntries.filter((entry) => !hasParentInScope(entry));
    const byInstantDescending = (left: SessionListEntry, right: SessionListEntry): number =>
      sortInstantOf(right) - sortInstantOf(left) || left.id.localeCompare(right.id);

    // Folded: each root's row stands for its whole subtree, so nothing is also
    // listed separately. Split: every session keeps its own row, nested beneath
    // whichever ancestor is in scope (its direct parent, or the nearest one
    // still present).
    const listed = includeSubagents ? allEntries : roots.map((entry) => foldSubtree(entry, all));
    const ordered: SessionListEntry[] = [];
    for (const root of roots.sort(byInstantDescending)) {
      ordered.push(includeSubagents ? root : (listed.find((entry) => entry.id === root.id) ?? root));
      // Split mode gives every descendant its own row, nested under the root it
      // was reached through. Folded mode gives the root alone a row, because
      // that row already carries the subtree; a descendant whose intermediate
      // ancestor is out of scope is a root itself and is emitted above.
      if (!includeSubagents) continue;
      for (const descendant of descendantsOfList(all, root.id).sort(byInstantDescending)) {
        ordered.push({ ...descendant, nested: true });
      }
    }

    // Sessions in scope, which is what the number means in both modes: folded
    // rows hide their subagents from the table, but they are still sessions.
    totalSessions += allEntries.length;
    projects.push({
      id: project.id,
      name: project.name,
      path: project.path,
      firstUsage: minOf(ordered, (entry) => entry.firstUsage),
      lastUsage: maxOf(ordered, (entry) => entry.lastUsage),
      sessions: ordered,
      sessionCount: allEntries.length,
    });
  }

  projects.sort((left, right) => projectSortInstant(right) - projectSortInstant(left) || left.name.localeCompare(right.name));
  return { agent: dataset.agent, source: dataset.source, projects, totalSessions, warnings };
}

/** Build one list row from a session. */
function toListEntry(session: SessionRecord, project: ProjectRecord, dataset: UsageDataset): SessionListEntry {
  const subagentRequests = session.childIds.reduce((total, id) => {
    const child = dataset.sessions.find((candidate) => candidate.id === id);
    return total + (child?.records.length ?? 0);
  }, 0);
  return {
    id: session.id,
    title: session.title,
    projectId: project.id,
    projectName: project.name,
    cwd: session.cwd,
    createdAt: session.createdAt,
    firstUsage: session.records[0]?.time ?? null,
    lastUsage: session.records[session.records.length - 1]?.time ?? null,
    requests: session.records.length,
    tokens: sumOf(session.records),
    isSubagent: session.isSubagent,
    depth: session.depth,
    parentId: session.parentId,
    subagentCount: session.childIds.length,
    subagentRequests,
    nested: false,
  };
}

/**
 * Every descendant of a session, depth-first, within a set of rows.
 * @param all - the rows in scope, keyed by id.
 * @param id - the ancestor's id.
 * @returns the descendants, excluding the ancestor itself.
 */
function descendantsOfList(all: ReadonlyMap<string, SessionListEntry>, id: string): SessionListEntry[] {
  const found: SessionListEntry[] = [];
  const queue = [id];
  const seen = new Set([id]);
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const entry of all.values()) {
      if (entry.parentId !== current || seen.has(entry.id)) continue;
      seen.add(entry.id);
      found.push(entry);
      queue.push(entry.id);
    }
  }
  return found;
}

/** Fold a session's whole subtree into its row: requests, tokens, and time span. */
function foldSubtree(root: SessionListEntry, all: ReadonlyMap<string, SessionListEntry>): SessionListEntry {
  const descendants = descendantsOfList(all, root.id);
  if (descendants.length === 0) return root;
  const tokens = { ...root.tokens };
  let requests = root.requests;
  for (const descendant of descendants) {
    requests += descendant.requests;
    tokens.input += descendant.tokens.input;
    tokens.output += descendant.tokens.output;
    tokens.cacheRead += descendant.tokens.cacheRead;
    tokens.cacheWrite += descendant.tokens.cacheWrite;
    tokens.reasoning += descendant.tokens.reasoning;
  }
  return {
    ...root,
    requests,
    tokens,
    subagentCount: descendants.length,
    firstUsage: minOf([root, ...descendants], (entry) => entry.firstUsage),
    lastUsage: maxOf([root, ...descendants], (entry) => entry.lastUsage),
  };
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
