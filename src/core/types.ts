/**
 * The agent-neutral domain model.
 *
 * Every number this tool reports starts as a {@link UsageRecord}: one billed
 * request, carrying the tokens the provider counted and the instant it happened.
 * Records are grouped into {@link SessionRecord}s and those into
 * {@link ProjectRecord}s. Nothing here mentions a specific agent or vendor —
 * an *agent adapter* produces this shape, and a *pricing adapter* turns it into
 * money.
 *
 * Cost is deliberately absent from this module: the same usage is worth
 * different amounts under different price lists, so pricing is applied later and
 * can be recomputed at any time from the records alone.
 */

import type { Warning } from '../i18n/errors.ts';

/**
 * Tokens a provider counted for one request.
 *
 * The four billed buckets are **disjoint**: a request's prompt size is
 * `input + cacheRead + cacheWrite`. `reasoning` is reported for transparency but
 * is already contained in `output` and is never billed beside it — that
 * convention comes from DeepSeek's API and is restated by every adapter that
 * reuses this shape.
 */
export interface TokenBuckets {
  /** Prompt tokens that missed the context cache. */
  input: number;
  /** Completion tokens, including reasoning tokens. */
  output: number;
  /** Prompt tokens served from the context cache. */
  cacheRead: number;
  /** Prompt tokens written to the context cache. */
  cacheWrite: number;
  /** Reasoning tokens, already included in {@link TokenBuckets.output}. */
  reasoning: number;
}

/** One billed request. */
export interface UsageRecord {
  /** Adapter-stable identifier for the record, unique within its session. */
  id: string;
  /** Milliseconds since the Unix epoch, in UTC. */
  time: number;
  /** Model actually served the request, as the agent reported it. */
  model: string;
  /** Provider-reported label, e.g. `deepseek-official / deepseek-v4-flash`. */
  modelLabel: string;
  /** Tokens the provider counted. */
  tokens: TokenBuckets;
  /** Sequence number inside the agent's own log, when it has one. */
  seq?: number | undefined;
  /** Turn number, when the agent tracks turns. */
  turn?: number | undefined;
  /** Step number inside the turn, when the agent tracks steps. */
  step?: number | undefined;
}

/** One session: a conversation, or a subagent spawned from one. */
export interface SessionRecord {
  /** Session identifier. */
  id: string;
  /** Human-readable title, when the agent stores one. */
  title: string | null;
  /** Working directory the session ran in, when known. */
  cwd: string | null;
  /** Session creation time, when known. */
  createdAt: number | null;
  /** Every billed request, ordered by {@link UsageRecord.time} ascending. */
  records: UsageRecord[];
  /** Id of the session that spawned this one, or `null` for a top-level session. */
  parentId: string | null;
  /** Nesting depth: `0` for a session a human started, `≥1` for a subagent. */
  depth: number;
  /** Whether this session was spawned by another session. */
  isSubagent: boolean;
  /** Ids of the sessions this one spawned. */
  childIds: string[];
  /** Whether {@link SessionRecord.parentId} names a session present in the dataset. */
  parentKnown: boolean;
  /** Adapter-specific extras, passed through to JSON output untouched. */
  extra?: Readonly<Record<string, unknown>> | undefined;
}

/** One project: a group of sessions the agent considers one workspace. */
export interface ProjectRecord {
  /** Stable project key (a workspace id, or the agent's own grouping key). */
  id: string;
  /** Display name. */
  name: string;
  /** Filesystem path, when the project maps to a directory. */
  path: string;
  /** Sessions belonging to this project, in the adapter's order. */
  sessions: SessionRecord[];
}

/** Everything an agent adapter recovered from its on-disk state. */
export interface UsageDataset {
  /** Agent id the dataset came from, e.g. `dsh`. */
  agent: string;
  /** Root the data was read from (a home directory, a cache directory, …). */
  source: string;
  /** Which model each session's records were attributed to, for diagnostics. */
  projects: ProjectRecord[];
  /** Every session in the dataset, including those not in a project. */
  sessions: SessionRecord[];
  /** Counters of what the adapter read, for diagnostics. */
  stats: DatasetStats;
  /** Non-fatal problems worth surfacing to the user. */
  warnings: Warning[];
}

/** What an adapter read, and where it read it from. */
export interface DatasetStats {
  /** Files the adapter parsed. */
  filesRead: string[];
  /** Sessions found. */
  sessions: number;
  /** Requests found. */
  records: number;
}

/** Aggregated token counts. */
export type TokenTotals = TokenBuckets;

/**
 * Money charged for a set of records.
 *
 * Amounts are exact decimal strings, not floats: currency has no business being
 * approximated, and a string survives a JSON round-trip unchanged. The
 * `*Tokens` counters say which quantities produced each amount, so a reader can
 * verify the arithmetic against the published rates.
 */
export interface CostTotals {
  /** Cache-hit input tokens billed. */
  cacheHitInputTokens: number;
  /** Cache-miss input tokens billed. */
  cacheMissInputTokens: number;
  /** Output tokens billed. */
  outputTokens: number;
  /** Cache-write tokens billed. */
  cacheWriteTokens: number;
  /** Amount charged for cache-hit input tokens. */
  cacheHitInputCost: string;
  /** Amount charged for cache-miss input tokens. */
  cacheMissInputCost: string;
  /** Amount charged for output tokens. */
  outputCost: string;
  /** Amount charged for cache-write tokens. */
  cacheWriteInputCost: string;
  /**
   * Part of {@link CostTotals.outputCost} attributable to reasoning tokens.
   *
   * Allocated where the output rate was known — per model, period and tier — and
   * never billed beside the output: it is a slice of it.
   */
  reasoningCost: string;
  /** Sum of every component above. */
  total: string;
}
