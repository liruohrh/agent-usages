/**
 * Tool-call events: the one piece of extraction every adapter shares.
 *
 * A record's tokens say what a request *cost*; its `events` say what the agent
 * *did* — which tools it reached for, on what, and whether the agent recorded a
 * failure. The four logs spell that out differently (Claude Code nests
 * `tool_use` blocks in an assistant entry, Codex writes one `response_item` per
 * call, DSH and pi put blocks in the message content), so each adapter finds its
 * own calls and this module turns them into the neutral shape.
 *
 * Two rules live here rather than in four places:
 *
 * - `detail` is a bounded excerpt while `bytes` is the size of the whole
 *   payload, so a trimmed excerpt is still honest about how much there was;
 * - a record with no tool call keeps `events` **undefined**, never `[]`, because
 *   "the log recorded no call" and "this adapter found none" must stay
 *   distinguishable downstream.
 */

import type { UsageEvent, UsageRecord } from '../core/types.ts';

/**
 * Longest argument excerpt kept, in characters.
 *
 * A `Write` call can carry a whole file and the store is a file the user keeps,
 * so the excerpt is for a human skimming a row — never the payload itself.
 */
export const TOOL_DETAIL_LIMIT = 300;

/** One tool call an adapter found, before it becomes a {@link UsageEvent}. */
export interface PendingToolCall {
  /** Tool name exactly as the agent spelled it. */
  name: string;
  /**
   * The call's arguments: JSON text as the agent wrote it, or an already-parsed
   * value. Absent when the log carries none.
   */
  payload?: unknown;
  /** Set only when the log itself recorded the outcome; absent means it did not say. */
  ok?: boolean | undefined;
}

/** Cut at `limit` without leaving half of a surrogate pair behind. */
function clip(text: string, limit: number): string {
  const last = text.charCodeAt(limit - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

/**
 * The bounded excerpt of one argument payload, and its true size.
 *
 * A string payload is used as it stands — Codex writes `arguments` as JSON text
 * and DSH the same, so re-encoding it would only add quotes. Anything else is
 * serialised. A payload the log does not carry yields neither field.
 *
 * @param payload - the call's arguments, as the agent wrote them.
 * @returns the excerpt and the payload's UTF-8 byte length.
 */
function excerptOf(payload: unknown): Pick<UsageEvent, 'detail' | 'bytes'> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (text === undefined || text.length === 0) return {};
  return {
    detail: text.length <= TOOL_DETAIL_LIMIT ? text : clip(text, TOOL_DETAIL_LIMIT),
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

/**
 * Turn one request's calls into its events, in the order they ran.
 *
 * @param calls - the calls the log recorded for a request, in log order.
 * @returns the events, `ordinal` counting from 0.
 */
export function toolCallEvents(calls: readonly PendingToolCall[]): UsageEvent[] {
  return calls.map((call, ordinal) => ({
    kind: 'tool_call',
    ordinal,
    name: call.name,
    ...excerptOf(call.payload),
    ...(call.ok === undefined ? {} : { ok: call.ok }),
  }));
}

/**
 * Hang a request's events on its record.
 *
 * Nothing is written for an empty list: `events: []` would claim the log said
 * "no tool calls", when it means "nothing was extracted" — and the storage layer
 * decides whether to write a row from exactly that difference.
 *
 * @param record - the record the calls belong to.
 * @param events - events built by {@link toolCallEvents}.
 */
export function attachToolEvents(record: UsageRecord, events: readonly UsageEvent[]): void {
  if (events.length > 0) record.events = events;
}
