/**
 * What the agents' tool calls add up to.
 *
 * A record's `events` say which tools one request reached for
 * (`UsageEvent`, filled by the adapters); this module folds those events into
 * the two questions a reader actually asks — *which tools does this agent use,
 * and how do they turn out* — and nothing else. It prices nothing: a tool call
 * has no money of its own, and inventing a share of the request's cost would be
 * a number the logs do not contain.
 *
 * The one judgment this layer makes is the shape of `ok`: an event whose `ok` is
 * absent means the log never stated an outcome, so it is counted as
 * **unknown** — never folded into either success or failure. A tool that failed
 * silently and a tool that succeeded are different facts, and a report that
 * merges them cannot be used to answer "which tools keep breaking".
 *
 * Aggregation is by **agent** because that is the axis the logs distinguish:
 * `session.agent` is the adapter that read the session, so `claudecode`'s Bash
 * calls and `dsh`'s bash calls stay separate rows even though both spell the
 * same tool.
 */

import type { UsageDataset, UsageEvent } from '../core/types.ts';
import { inRange, type TimeRange } from './timerange.ts';

/** How many tool rows one agent shows when the caller does not say. */
export const DEFAULT_TOOL_TOP = 10;

/** How many session rows one agent shows when the caller does not say. */
export const DEFAULT_SESSION_LIMIT = 20;

/**
 * The three outcomes, kept apart.
 *
 * `unknown` is not an error state: it is every call whose log wrote no verdict
 * (Claude Code omits `is_error` on a successful non-Bash call, Codex never
 * states one for `function_call`), and it is the largest bucket in real data.
 */
export interface ToolOutcomes {
  /** Calls the log recorded as successful. */
  true: number;
  /** Calls the log recorded as failed. */
  false: number;
  /** Calls the log never judged either way. */
  unknown: number;
}

/** One tool's row inside an agent. */
export interface ToolRow {
  /** Tool name as the agent spelled it. */
  name: string;
  /** Calls of this tool. */
  calls: number;
  /** How those calls turned out. */
  ok: ToolOutcomes;
  /** Sum of the complete argument payloads, in bytes. */
  bytes: number;
  /** Share of this agent's calls, in percent with one decimal. */
  share: number;
}

/** One tool name with its count, for a session row's "most used" cell. */
export interface ToolCount {
  name: string;
  calls: number;
}

/** One session's share of an agent's tool calls. */
export interface SessionToolUsage {
  id: string;
  /** Session title, when the agent stored one. */
  title: string | null;
  calls: number;
  ok: ToolOutcomes;
  bytes: number;
  /** The session's tools, most used first. */
  tools: ToolCount[];
}

/** One agent's tool calls, aggregated. */
export interface AgentToolUsage {
  agent: string;
  calls: number;
  /** Requests in range, whether or not they called a tool. */
  records: number;
  /** Requests in range that carry at least one tool call. */
  recordsWithCalls: number;
  ok: ToolOutcomes;
  bytes: number;
  /** The most-used tools, largest first, cut to the requested depth. */
  tools: ToolRow[];
  /** Sessions with at least one call, largest first, cut to the requested depth. */
  sessions: SessionToolUsage[];
}

/** The whole run's totals, summed over every agent. */
export interface ToolTotals {
  calls: number;
  records: number;
  recordsWithCalls: number;
  ok: ToolOutcomes;
  bytes: number;
}

/** Everything {@link collectTools} produced. */
export interface ToolsReport {
  agents: AgentToolUsage[];
  totals: ToolTotals;
}

/** What to aggregate. */
export interface ToolsOptions {
  /** Only records inside this range; everything when absent. */
  range?: TimeRange | undefined;
  /** Tool rows per agent; `0` keeps every tool. */
  top?: number | undefined;
  /** Collect per-session rows at all (the `--by session` view). */
  sessions?: boolean | undefined;
  /** Session rows per agent; `0` keeps every session. */
  limit?: number | undefined;
}

/** A zeroed outcome counter. */
function noOutcomes(): ToolOutcomes {
  return { true: 0, false: 0, unknown: 0 };
}

/** Count one event's outcome — the absent verdict included. */
function tally(counts: ToolOutcomes, event: UsageEvent): void {
  if (event.ok === true) counts.true += 1;
  else if (event.ok === false) counts.false += 1;
  else counts.unknown += 1;
}

/** Add one outcome counter into another. */
function addOutcomes(into: ToolOutcomes, other: ToolOutcomes): void {
  into.true += other.true;
  into.false += other.false;
  into.unknown += other.unknown;
}

/**
 * A part of a whole, as a percentage with one decimal.
 *
 * The number is rounded **once**, here, and both renderers print it as it is:
 * the terminal's `89.2%` and the JSON's `share` are the same figure, so a script
 * cannot disagree with the line beside it.
 *
 * @param part - the count being described.
 * @param whole - the count it is a part of (0 yields 0 rather than NaN).
 * @returns the percentage, e.g. `89.2`.
 */
export function sharePercent(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

/** Keep the first `depth` rows; `0` means "all of them". */
function cut<T>(rows: readonly T[], depth: number): T[] {
  return depth <= 0 ? [...rows] : rows.slice(0, depth);
}

/** One session while its calls are being summed. */
interface SessionDraft {
  id: string;
  title: string | null;
  calls: number;
  ok: ToolOutcomes;
  bytes: number;
  tools: Map<string, number>;
}

/** One agent while its rows are being summed. */
interface AgentDraft {
  agent: string;
  calls: number;
  records: number;
  recordsWithCalls: number;
  ok: ToolOutcomes;
  bytes: number;
  tools: Map<string, { calls: number; ok: ToolOutcomes; bytes: number }>;
  sessions: Map<string, SessionDraft>;
}

/** One agent's draft, created on first sight. */
function draftOf(drafts: Map<string, AgentDraft>, agent: string): AgentDraft {
  const known = drafts.get(agent);
  if (known !== undefined) return known;
  const created: AgentDraft = {
    agent,
    calls: 0,
    records: 0,
    recordsWithCalls: 0,
    ok: noOutcomes(),
    bytes: 0,
    tools: new Map(),
    sessions: new Map(),
  };
  drafts.set(agent, created);
  return created;
}

/**
 * Fold every record's tool calls into per-agent rows.
 *
 * A record with no `events` is not a gap in the data: it is a request that
 * called no tool, so it counts towards `records` (the coverage denominator) and
 * never towards `calls`.
 *
 * @param dataset - the merged dataset to read (the adapters' own events).
 * @param options - range, row depths, and whether to collect sessions.
 * @returns the agent rows, largest first, and their totals.
 */
export function collectTools(dataset: UsageDataset, options: ToolsOptions = {}): ToolsReport {
  const { range } = options;
  const top = options.top ?? DEFAULT_TOOL_TOP;
  const limit = options.limit ?? DEFAULT_SESSION_LIMIT;
  const drafts = new Map<string, AgentDraft>();

  for (const session of dataset.sessions) {
    const agent = session.agent.length > 0 ? session.agent : dataset.agent;
    const draft = draftOf(drafts, agent);
    let sessionDraft: SessionDraft | undefined;
    for (const record of session.records) {
      if (range !== undefined && !inRange(record.time, range)) continue;
      draft.records += 1;
      const events = record.events;
      if (events === undefined || events.length === 0) continue;
      draft.recordsWithCalls += 1;
      for (const event of events) {
        draft.calls += 1;
        tally(draft.ok, event);
        draft.bytes += event.bytes ?? 0;
        const tool = draft.tools.get(event.name) ?? { calls: 0, ok: noOutcomes(), bytes: 0 };
        tool.calls += 1;
        tally(tool.ok, event);
        tool.bytes += event.bytes ?? 0;
        draft.tools.set(event.name, tool);
        // A session row is only fetched once the session is known to have a call:
        // a list of sessions that called nothing would be noise.
        if (options.sessions !== true) continue;
        if (sessionDraft === undefined) {
          const created: SessionDraft = {
            id: session.id,
            title: session.title,
            calls: 0,
            ok: noOutcomes(),
            bytes: 0,
            tools: new Map<string, number>(),
          };
          draft.sessions.set(session.id, created);
          sessionDraft = created;
        }
        sessionDraft.calls += 1;
        tally(sessionDraft.ok, event);
        sessionDraft.bytes += event.bytes ?? 0;
        sessionDraft.tools.set(event.name, (sessionDraft.tools.get(event.name) ?? 0) + 1);
      }
    }
  }

  const totals: ToolTotals = { calls: 0, records: 0, recordsWithCalls: 0, ok: noOutcomes(), bytes: 0 };
  const agents: AgentToolUsage[] = [];
  for (const draft of drafts.values()) {
    const tools: ToolRow[] = [...draft.tools.entries()]
      .map(([name, tool]) => ({
        name,
        calls: tool.calls,
        ok: tool.ok,
        bytes: tool.bytes,
        share: sharePercent(tool.calls, draft.calls),
      }))
      .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));
    const sessions: SessionToolUsage[] = [...draft.sessions.values()]
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        calls: entry.calls,
        ok: entry.ok,
        bytes: entry.bytes,
        tools: [...entry.tools.entries()]
          .map(([name, calls]) => ({ name, calls }))
          .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name)),
      }))
      .sort((left, right) => right.calls - left.calls || left.id.localeCompare(right.id));
    agents.push({
      agent: draft.agent,
      calls: draft.calls,
      records: draft.records,
      recordsWithCalls: draft.recordsWithCalls,
      ok: draft.ok,
      bytes: draft.bytes,
      tools: cut(tools, top),
      sessions: cut(sessions, limit),
    });
    totals.calls += draft.calls;
    totals.records += draft.records;
    totals.recordsWithCalls += draft.recordsWithCalls;
    totals.bytes += draft.bytes;
    addOutcomes(totals.ok, draft.ok);
  }
  agents.sort((left, right) => right.calls - left.calls || left.agent.localeCompare(right.agent));
  return { agents, totals };
}
