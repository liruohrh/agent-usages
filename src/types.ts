/**
 * Core data model for DSH token-usage accounting.
 *
 * Semantics of the four token buckets are taken verbatim from the harness
 * itself (`@deepseek-ai/dsh-token-meter`, `usageTokens()`): the buckets are
 * **disjoint**, so a request's prompt size is
 * `input + cacheRead + cacheWrite`, and `reasoning` is already contained in
 * `output` (never billed separately).
 */

/** Which provider usage buckets one billed request reported. */
export interface TokenBuckets {
  /** Prompt tokens that missed the context cache (billed at the cache-miss rate). */
  input: number;
  /** Completion tokens, including reasoning tokens. */
  output: number;
  /** Prompt tokens served from the context cache (billed at the cache-hit rate). */
  cacheRead: number;
  /** Prompt tokens written to the context cache. */
  cacheWrite: number;
  /** Reasoning tokens, already included in {@link TokenBuckets.output}. */
  reasoning: number;
}

/** A single provider-reported usage record (one request / one step). */
export interface UsageEntry {
  /** Stable ledger key, e.g. `<sessionId>:step:1:2`. */
  key: string;
  /** Session-log sequence number the record was observed at. */
  seq: number;
  /** Milliseconds since the Unix epoch, in UTC. */
  time: number;
  /** Provider-reported model identity, e.g. `deepseek-official / deepseek-v4-flash`. */
  modelId: string;
  /** Canonical model the provider routed the request to, e.g. `deepseek-v4-flash`. */
  model: string;
  /** Turn number inside the session. */
  turn: number;
  /** Step number inside the turn. */
  step: number;
  /** Raw provider usage buckets. */
  tokens: TokenBuckets;
}

/** A DSH workspace (called a "project" by this CLI) plus its sessions. */
export interface ProjectRecord {
  /** DSH workspace id, or a synthetic `path:<cwd>` key for sessions with no workspace. */
  workspaceId: string;
  /** Workspace display title (`workspace.json` title, else the cwd basename). */
  name: string;
  /** Absolute workspace path. */
  path: string;
  /** Sessions belonging to this project, ordered by first usage ascending. */
  sessions: SessionRecord[];
}

/** All ledger usage of one DSH session. */
export interface SessionRecord {
  /** Session id (a UUID, sometimes prefixed with `session-`). */
  sessionId: string;
  /** Owning workspace id, or `null` when the session has no workspace. */
  workspaceId: string | null;
  /** Session title from the projection cache, when known. */
  title: string | null;
  /** Working directory the session was started in, when known. */
  cwd: string | null;
  /** Session creation time from the projection cache, when known. */
  createdAt: number | null;
  /** Every usage record of the session, ordered by `time` ascending. */
  entries: UsageEntry[];
  /** Session token totals reported by the harness projection cache, for cross-checking. */
  projectedTotals: TokenBuckets | null;
  /**
   * Id of the session that spawned this one, or `null` when this session is
   * top-level. Recovered from the session log's header — the ledger and the
   * projection cache do not record delegation.
   */
  parentSessionId: string | null;
  /**
   * How deep in the delegation tree this session sits: `0` for a session a human
   * started, `≥1` for a subagent.
   */
  delegationDepth: number;
  /** Whether this session is a subagent, i.e. it was spawned by another session. */
  isSubagent: boolean;
  /** Ids of the subagents this session spawned, in stable order. */
  subagentIds: string[];
  /**
   * Whether {@link parentSessionId} names a session present in the dataset.
   * A subagent whose parent is unknown is still a subagent, but cannot be folded
   * into a parent that is not there.
   */
  parentKnown: boolean;
}

/** Everything the loader recovered from the DSH home directory. */
export interface UsageDataset {
  /** Resolved DSH home directory. */
  home: string;
  /** Ledger shard files that were read. */
  shardFiles: string[];
  /** Every project, keyed by workspace id, ordered by name. */
  projects: ProjectRecord[];
  /** Every session, keyed by session id. */
  sessions: SessionRecord[];
  /** Load diagnostics worth surfacing to the user. */
  warnings: string[];
}

/** Aggregated token totals. */
export type TokenTotals = TokenBuckets;

/**
 * Cost of a set of usage records, accumulated in the ledger currency (CNY).
 *
 * Every amount is an exact decimal string, not a float: currency has no
 * business being approximated, and a string keeps JSON round-trips lossless.
 * Render one with `formatDecimal`-style padding, or pass it straight through.
 */
export interface CostTotals {
  /** Cache-hit input tokens billed. */
  cacheHitInputTokens: number;
  /** Cache-miss input tokens billed. */
  cacheMissInputTokens: number;
  /** Output tokens billed. */
  outputTokens: number;
  /** Cache-write tokens; DeepSeek bills these at the cache-miss rate. */
  cacheWriteTokens: number;
  /** Cost of cache-hit input tokens, in the display currency. */
  cacheHitInputCost: string;
  /** Cost of cache-miss input tokens, in the display currency. */
  cacheMissInputCost: string;
  /** Cost of output tokens, in the display currency. */
  outputCost: string;
  /** Total cost, in the display currency. */
  total: string;
}

/** One pricing band a group of usage records was billed under. */
export interface PricingBandSummary {
  /** Pricing period id, e.g. `2026-09-10`. */
  periodId: string;
  /** Human-readable period label. */
  periodLabel: string;
  /** Billing band inside the period, e.g. `off-peak` / `peak` / `flat`. */
  band: string;
  /** How the period was selected: exact match, or a documented fallback. */
  resolution: PricingResolution;
  /** Number of usage records billed under this band. */
  requests: number;
}

/** How a pricing period was selected for a usage record. */
export type PricingResolution =
  /** The record's timestamp fell inside this period's validity window. */
  | 'exact'
  /** No period covered the timestamp; the earliest later period was used. */
  | 'fallback-later'
  /** No period covered or followed the timestamp; the latest earlier period was used. */
  | 'fallback-earlier'
  /** No period is defined for this model at all; the dataset default was used. */
  | 'fallback-default';
