/**
 * Tool-call aggregation tests.
 *
 * The shapes here are built directly in the neutral model (see
 * `test/support/dataset.ts`), because what is under test is the arithmetic: which
 * records count towards coverage, how the three outcomes stay apart, how a share
 * is rounded, and what a range filter does to all of it.
 *
 * The fixtures are deliberately tiny and the assertions are on counts and named
 * fields — never on a whole structure — so a failure says which figure is wrong.
 */

import { describe, expect, it } from 'vitest';

import type { UsageEvent, UsageRecord } from '../../src/core/types.ts';
import { collectTools, sharePercent } from '../../src/report/tools.ts';
import { resolveRange } from '../../src/report/timerange.ts';
import { dataset, project, record, session } from '../support/dataset.ts';

/** An instant in September 2026, at 10:00 UTC. */
function at(day: number): number {
  return Date.parse(`2026-09-${String(day).padStart(2, '0')}T10:00:00Z`);
}

/** One tool call, with everything a test does not set left out. */
function call(name: string, overrides: Partial<UsageEvent> = {}): UsageEvent {
  return { kind: 'tool_call', ordinal: 0, name, ...overrides };
}

/** One request carrying the given calls (an empty list means "no calls"). */
function request(time: number, calls: readonly UsageEvent[], overrides: Partial<UsageRecord> = {}): UsageRecord {
  return record({ time, ...(calls.length === 0 ? {} : { events: calls }), ...overrides });
}

/** A one-project dataset whose sessions are `agent → its records`. */
function homeOf(agents: Record<string, readonly UsageRecord[]>, title: string | null = 'demo'): ReturnType<typeof dataset> {
  return dataset([
    project({
      id: 'p1',
      sessions: Object.entries(agents).map(([agent, records]) =>
        session({ id: `${agent}-s1`, agent, title, records: [...records] }),
      ),
    }),
  ]);
}

describe('sharePercent', () => {
  it('rounds to one decimal, and answers 0 rather than NaN for an empty whole', () => {
    expect(sharePercent(1, 3)).toBe(33.3);
    expect(sharePercent(8444, 9463)).toBe(89.2);
    expect(sharePercent(0, 0)).toBe(0);
  });
});

describe('collectTools', () => {
  it('counts calls, coverage and bytes, and keeps a call-less record in the denominator', () => {
    const data = homeOf({
      dsh: [
        request(at(1), [call('bash', { bytes: 100 }), call('read', { bytes: 50, ok: true })]),
        request(at(2), []),
        request(at(3), [call('write', { bytes: 25, ok: false })]),
      ],
    });
    const report = collectTools(data);
    const [agent] = report.agents;
    expect(report.agents).toHaveLength(1);
    expect(agent?.agent).toBe('dsh');
    expect(agent?.calls).toBe(3);
    expect(agent?.records).toBe(3);
    expect(agent?.recordsWithCalls).toBe(2);
    expect(agent?.bytes).toBe(175);
    expect(report.totals.calls).toBe(3);
    expect(report.totals.records).toBe(3);
    expect(report.totals.bytes).toBe(175);
  });

  it('keeps the three outcomes apart, with an absent verdict as unknown', () => {
    const data = homeOf({
      dsh: [
        request(at(1), [
          call('bash', { ok: true }),
          call('bash', { ok: false }),
          call('bash', { ok: true }),
          // No verdict recorded: it must not be folded into either side.
          call('bash'),
        ]),
      ],
    });
    const [agent] = collectTools(data).agents;
    expect(agent?.ok).toEqual({ true: 2, false: 1, unknown: 1 });
    expect(agent?.tools[0]?.ok).toEqual({ true: 2, false: 1, unknown: 1 });
  });

  it('sorts tools by calls, breaks ties by name, and rounds the share', () => {
    const data = homeOf({
      dsh: [
        request(at(1), [call('write'), call('edit'), call('bash'), call('bash'), call('bash'), call('read')]),
      ],
    });
    const [agent] = collectTools(data).agents;
    expect(agent?.tools.map((tool) => tool.name)).toEqual(['bash', 'edit', 'read', 'write']);
    expect(agent?.tools.map((tool) => tool.calls)).toEqual([3, 1, 1, 1]);
    // 3/6, then three ties at 1/6 — one rounding, the same one the JSON prints.
    expect(agent?.tools.map((tool) => tool.share)).toEqual([50, 16.7, 16.7, 16.7]);
  });

  it('cuts the tool list at --top, where 0 keeps every tool', () => {
    const data = homeOf({
      dsh: [request(at(1), [call('a'), call('b'), call('c')])],
    });
    expect(collectTools(data, { top: 2 }).agents[0]?.tools.map((tool) => tool.name)).toEqual(['a', 'b']);
    expect(collectTools(data, { top: 0 }).agents[0]?.tools).toHaveLength(3);
  });

  it('collects sessions only when asked, only those with calls, largest first', () => {
    const data = dataset([
      project({
        id: 'p1',
        sessions: [
          session({ id: 's-small', agent: 'dsh', title: '小', records: [request(at(1), [call('bash')])] }),
          session({ id: 's-big', agent: 'dsh', title: '大', records: [request(at(2), [call('bash', { ok: true }), call('read', { ok: false })])] }),
          session({ id: 's-none', agent: 'dsh', title: '无', records: [request(at(3), [])] }),
        ],
      }),
    ]);
    expect(collectTools(data).agents[0]?.sessions).toEqual([]);
    const sessions = collectTools(data, { sessions: true }).agents[0]?.sessions ?? [];
    expect(sessions.map((entry) => [entry.id, entry.calls])).toEqual([
      ['s-big', 2],
      ['s-small', 1],
    ]);
    expect(sessions[0]?.ok).toEqual({ true: 1, false: 1, unknown: 0 });
    expect(sessions[1]?.title).toBe('小');
    expect(collectTools(data, { sessions: true, limit: 1 }).agents[0]?.sessions.map((entry) => entry.id)).toEqual(['s-big']);
  });

  it('filters records by range without dropping the whole request count', () => {
    const data = homeOf({
      dsh: [request(at(1), [call('old')]), request(at(20), [call('new')])],
    });
    const range = resolveRange({ spec: '2026-09-15..2026-09-30' });
    const [agent] = collectTools(data, { range }).agents;
    expect(agent?.records).toBe(1);
    expect(agent?.calls).toBe(1);
    expect(agent?.tools.map((tool) => tool.name)).toEqual(['new']);
  });

  it('groups by agent, largest first, and falls back to the dataset id', () => {
    const data = homeOf({
      dsh: [request(at(1), [call('bash')])],
      claudecode: [request(at(2), [call('Bash'), call('Read'), call('Edit')])],
      '': [request(at(3), [call('pi_tool')])],
    });
    const report = collectTools(data);
    expect(report.agents.map((agent) => agent.agent)).toEqual(['claudecode', 'dsh', 'test']);
    expect(report.totals.calls).toBe(5);
    expect(report.totals.records).toBe(3);
  });

  it('treats an empty events list as no calls rather than as a request with calls', () => {
    const data = homeOf({ dsh: [record({ time: at(1), events: [] })] });
    const [agent] = collectTools(data).agents;
    expect(agent?.records).toBe(1);
    expect(agent?.recordsWithCalls).toBe(0);
    expect(agent?.calls).toBe(0);
    expect(agent?.tools).toEqual([]);
  });

  it('answers an empty dataset with zeroed totals and no agents', () => {
    const report = collectTools(dataset([]));
    expect(report.agents).toEqual([]);
    expect(report.totals.calls).toBe(0);
    expect(report.totals.records).toBe(0);
    expect(report.totals.ok).toEqual({ true: 0, false: 0, unknown: 0 });
  });
});
