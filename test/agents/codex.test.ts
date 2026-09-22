/**
 * Codex adapter tests.
 *
 * Rollouts are built the way Codex writes them: `session_meta`, a
 * `turn_context`, and `token_count` events that carry a delta *and* a running
 * total — including the fork case, whose inherited total has no event behind it.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { codexAgent } from '../../src/agents/codex/loader.ts';

const PARENT = '01a0ca09-f65d-72c1-baf0-567e3e04ec8d';
const CHILD = '01a0ca0b-4181-7433-884b-58ccbd8701e9';

let home: string;

/** Codex's six counters, as a `token_count` event reports them. */
function counters(input: number, cached: number, output: number, reasoning: number): Record<string, number> {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

/** One `token_count` event carrying both the delta and the running total. */
function tokenCount(ordinal: number, delta: Record<string, number>, total: Record<string, number>): string {
  return JSON.stringify({
    timestamp: `2026-09-23T00:0${ordinal}:00.000Z`,
    ordinal,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: delta } },
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-usages-codex-'));
  const day = join(home, 'sessions', '2026', '09', '23');
  await mkdir(day, { recursive: true });

  const parent = [
    JSON.stringify({
      timestamp: '2026-09-23T00:00:00.000Z',
      ordinal: 0,
      type: 'session_meta',
      payload: { id: PARENT, session_id: PARENT, cwd: '/tmp/demo' },
    }),
    JSON.stringify({ timestamp: '2026-09-23T00:00:00.500Z', ordinal: 0, type: 'turn_context', payload: { model: 'deepseek-flash', cwd: '/tmp/demo' } }),
    tokenCount(1, counters(1000, 800, 100, 20), counters(1000, 800, 100, 20)),
    // The same call again in its other rendering: it must not be billed twice.
    JSON.stringify({
      timestamp: '2026-09-23T00:01:00.000Z',
      ordinal: 1,
      type: 'token_usage_record',
      payload: { usage: counters(1000, 800, 100, 20) },
    }),
    tokenCount(2, counters(2000, 1500, 200, 50), counters(3000, 2300, 300, 70)),
  ].join('\n');
  await writeFile(join(day, `rollout-2026-09-23T00-00-00-${PARENT}.jsonl`), `${parent}\n`);

  const child = [
    JSON.stringify({
      timestamp: '2026-09-23T00:02:00.000Z',
      ordinal: 0,
      type: 'session_meta',
      payload: {
        id: CHILD,
        // A subagent's session_id names its parent, not itself.
        session_id: PARENT,
        cwd: '/tmp/demo',
        thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_path: '/root/math' } } },
      },
    }),
    tokenCount(1, counters(500, 400, 60, 10), counters(500, 400, 60, 10)),
  ].join('\n');
  await writeFile(join(day, `rollout-2026-09-23T00-02-00-${CHILD}.jsonl`), `${child}\n`);

  // A fork: it inherits the parent's running total but copies no events, so its
  // only token_count carries a total with no delta behind it.
  const fork = [
    JSON.stringify({
      timestamp: '2026-09-23T00:03:00.000Z',
      ordinal: 0,
      type: 'session_meta',
      payload: { id: 'fork-1', session_id: 'fork-1', cwd: '/tmp/demo', forked_from_id: PARENT },
    }),
    JSON.stringify({
      timestamp: '2026-09-23T00:03:01.000Z',
      ordinal: 30,
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: counters(4000, 2300, 300, 70) } },
    }),
  ].join('\n');
  await writeFile(join(day, 'rollout-2026-09-23T00-03-00-fork-1.jsonl'), `${fork}\n`);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('reading a Codex home', () => {
  it('sums the delta and splits the counters into disjoint buckets', async () => {
    const data = await codexAgent.load({ home });
    const session = data.sessions.find((candidate) => candidate.id === PARENT);
    expect(session?.records.map((record) => record.id)).toEqual([`${PARENT}:tok:1`, `${PARENT}:tok:2`]);
    // input 1000 − cached 800, output 100 − reasoning 20.
    expect(session?.records[0]?.tokens).toEqual({ input: 200, output: 80, cacheRead: 800, cacheWrite: 0, reasoning: 20 });
    expect(session?.records[1]?.tokens).toEqual({ input: 500, output: 150, cacheRead: 1500, cacheWrite: 0, reasoning: 50 });
    expect(session?.records[0]?.model).toBe('deepseek-flash');
  });

  it('bills nothing for a fork that only inherited a running total', async () => {
    const data = await codexAgent.load({ home });
    const fork = data.sessions.find((candidate) => candidate.id === 'fork-1');
    const parent = data.sessions.find((candidate) => candidate.id === PARENT);
    expect(fork?.records).toEqual([]);
    // It is identified as a continuation of its source, not as a child.
    expect(fork?.parentId).toBe(PARENT);
    expect(fork?.isSubagent).toBe(false);
    expect(fork?.extra?.['forkedFrom']).toBe(PARENT);
    expect(parent?.childIds).toEqual([CHILD]);
  });

  it('attaches a subagent through thread_spawn, not through session_id', async () => {
    const data = await codexAgent.load({ home });
    const child = data.sessions.find((candidate) => candidate.id === CHILD);
    const parent = data.sessions.find((candidate) => candidate.id === PARENT);
    expect(child?.isSubagent).toBe(true);
    expect(child?.depth).toBe(1);
    expect(child?.parentId).toBe(PARENT);
    expect(child?.parentKnown).toBe(true);
    expect(child?.records).toHaveLength(1);
    expect(parent?.childIds).toEqual([CHILD]);
  });

  it('groups sessions by their cwd and recognises the home', async () => {
    const data = await codexAgent.load({ home });
    expect(data.agent).toBe('codex');
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0]?.path).toBe('/tmp/demo');
    expect(data.projects[0]?.name).toBe('demo');
    expect(data.projects[0]?.sessions).toHaveLength(3);
    expect(await codexAgent.hasData(home)).toBe(true);
    expect(await codexAgent.hasData(join(home, 'nope'))).toBe(false);
  });
});
