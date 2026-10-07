/**
 * Adapter source lists: the files a scan reads, for a cache to fingerprint.
 *
 * `listSources(root)` exists so a scan can be skipped when nothing it reads has
 * changed, and its contract has one hard edge: **the set must cover every file
 * `load` reads** — the logs *and* the auxiliary files (a title beside a session,
 * a subagent's metadata, a prompt history, a cache that adds sessions). A file
 * left out is a file whose change never invalidates a cached scan, so each group
 * below checks the invariant against a synthetic home, names the auxiliary files
 * explicitly, and proves the list comes from disk rather than from a constant.
 *
 * The fixtures are the smallest homes each adapter accepts; they are built here
 * rather than reused from the adapter suites so a change to one suite cannot
 * quietly weaken this invariant.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentAdapter } from '../../src/agents/contract.ts';
import { claudecodeAgent } from '../../src/agents/claudecode/loader.ts';
import { codexAgent } from '../../src/agents/codex/loader.ts';
import { dshAgent } from '../../src/agents/dsh/loader.ts';
import { piAgent } from '../../src/agents/pi/loader.ts';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-usages-sources-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/**
 * The list, checked for the two properties every caller relies on: absolute
 * paths, and the same answer when asked twice.
 */
async function sourcesOf(adapter: AgentAdapter, root: string): Promise<Set<string>> {
  const files = await adapter.listSources(root);
  for (const file of files) expect(isAbsolute(file), `${file} is absolute`).toBe(true);
  expect(new Set(await adapter.listSources(root))).toEqual(new Set(files));
  return new Set(files);
}

/**
 * The invariant: everything the scan reports having read is a listed source.
 *
 * @param adapter - the adapter under test.
 * @param root - its data root.
 * @param suffixes - what a log file of this agent ends with (a DSH log may be
 *   zstd-compressed); every `filesRead` entry must be an absolute path ending in
 *   one of them — the field is a file list, not a session-id list.
 * @returns the sources, so a test can look for its auxiliary files in them.
 */
async function sourcesCoveringScan(
  adapter: AgentAdapter,
  root: string,
  suffixes: readonly string[] = ['.jsonl'],
): Promise<Set<string>> {
  const sources = await sourcesOf(adapter, root);
  const { stats } = await adapter.load({ home: root });
  expect(stats.filesRead.length).toBeGreaterThan(0);
  for (const file of stats.filesRead) {
    expect(sources.has(file), `${adapter.id} lists ${file}`).toBe(true);
    expect(isAbsolute(file), `${adapter.id}: ${file} is absolute`).toBe(true);
    expect(suffixes.some((suffix) => file.endsWith(suffix)), `${adapter.id}: ${file} is a log`).toBe(true);
  }
  return sources;
}

/** One `token_count` event, as Codex writes it. */
function codexCounters(count: number): Record<string, number> {
  return {
    input_tokens: count,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: count,
    reasoning_output_tokens: 0,
    total_tokens: count * 2,
  };
}

describe('claudecode source list', () => {
  const SESSION = '11111111-1111-4111-8111-111111111111';
  const AGENT = 'aabbccdd112233445';

  /** The home a Claude Code scan reads: a log, a name, a subagent, a history. */
  async function fixture(): Promise<void> {
    const project = join(home, 'projects', '-tmp-demo');
    const subagents = join(project, SESSION, 'subagents');
    await mkdir(subagents, { recursive: true });
    await writeFile(
      join(project, `${SESSION}.jsonl`),
      `${[
        JSON.stringify({ type: 'user', uuid: 'u1', sessionId: SESSION, timestamp: '2026-09-23T00:00:00.000Z', cwd: '/tmp/demo' }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId: SESSION,
          timestamp: '2026-09-23T00:00:01.000Z',
          cwd: '/tmp/demo',
          message: { id: 'msg-a1', model: 'deepseek-flash', usage: { input_tokens: 1_000, output_tokens: 100 } },
        }),
      ].join('\n')}\n`,
    );
    await writeFile(join(project, SESSION, 'custom-title.json'), JSON.stringify({ customTitle: '我的会话' }));
    await writeFile(
      join(subagents, `agent-${AGENT}.jsonl`),
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'b1',
        parentUuid: null,
        sessionId: SESSION,
        timestamp: '2026-09-23T00:00:02.000Z',
        cwd: '/tmp/demo',
        message: { id: 'msg-b1', model: 'deepseek-flash', usage: { input_tokens: 500, output_tokens: 50 } },
      })}\n`,
    );
    await writeFile(join(subagents, `agent-${AGENT}.meta.json`), JSON.stringify({ description: 'Say hello', spawnDepth: 1 }));
    await writeFile(
      join(home, 'history.jsonl'),
      `${JSON.stringify({ display: '/btw a side question', timestamp: 1, sessionId: SESSION })}\n`,
    );
  }

  it('covers the scan and names the title, the subagent metadata and the history', async () => {
    await fixture();
    const sources = await sourcesCoveringScan(claudecodeAgent, home);
    expect(sources.has(join(home, 'projects', '-tmp-demo', `${SESSION}.jsonl`))).toBe(true);
    expect(sources.has(join(home, 'projects', '-tmp-demo', SESSION, 'custom-title.json'))).toBe(true);
    expect(sources.has(join(home, 'projects', '-tmp-demo', SESSION, 'subagents', `agent-${AGENT}.jsonl`))).toBe(true);
    expect(sources.has(join(home, 'projects', '-tmp-demo', SESSION, 'subagents', `agent-${AGENT}.meta.json`))).toBe(true);
    expect(sources.has(join(home, 'history.jsonl'))).toBe(true);
  });

  it('drops a removed auxiliary file from the list', async () => {
    await fixture();
    const before = await sourcesOf(claudecodeAgent, home);
    const title = join(home, 'projects', '-tmp-demo', SESSION, 'custom-title.json');
    expect(before.has(title)).toBe(true);
    await rm(title);
    expect(await sourcesOf(claudecodeAgent, home)).not.toContain(title);
  });
});

describe('codex source list', () => {
  const ID = '019f0000-0000-7000-8000-000000000000';

  /** A rollout, the two databases of titles/side turns, and the history file. */
  async function fixture(): Promise<void> {
    const day = join(home, 'sessions', '2026', '09', '23');
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, `rollout-2026-09-23T00-00-00-${ID}.jsonl`),
      `${[
        JSON.stringify({
          timestamp: '2026-09-23T00:00:00.000Z',
          ordinal: 0,
          type: 'session_meta',
          payload: { id: ID, session_id: ID, cwd: '/tmp/demo' },
        }),
        JSON.stringify({
          timestamp: '2026-09-23T00:00:01.000Z',
          ordinal: 1,
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: codexCounters(100), last_token_usage: codexCounters(100) } },
        }),
      ].join('\n')}\n`,
    );
    // Not real databases: the readers degrade to "no titles", which is exactly
    // what a scan does on a machine where Codex left none behind.
    await writeFile(join(home, 'state_5.sqlite'), '');
    await writeFile(join(home, 'logs_2.sqlite'), '');
    await writeFile(join(home, 'history.jsonl'), `${JSON.stringify({ session_id: 'never-persisted', ts: 1 })}\n`);
  }

  it('covers the scan and names the title database, the side-turn log and the history', async () => {
    await fixture();
    const sources = await sourcesCoveringScan(codexAgent, home);
    expect(sources.has(join(home, 'state_5.sqlite'))).toBe(true);
    expect(sources.has(join(home, 'logs_2.sqlite'))).toBe(true);
    expect(sources.has(join(home, 'history.jsonl'))).toBe(true);
  });

  it('drops a removed auxiliary file from the list', async () => {
    await fixture();
    const titles = join(home, 'state_5.sqlite');
    expect(await sourcesOf(codexAgent, home)).toContain(titles);
    await rm(titles);
    expect(await sourcesOf(codexAgent, home)).not.toContain(titles);
  });
});

describe('dsh source list', () => {
  const SESSION = 'session-aaaaaaaa-0000-4000-8000-000000000001';

  /** A session log plus the projection cache and workspace registry beside it. */
  async function fixture(): Promise<void> {
    const dir = join(home, 'sessions', '--tmp-demo--', SESSION);
    await mkdir(join(home, 'storages'), { recursive: true });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'session.jsonl'),
      `${[
        JSON.stringify({ type: 'session', version: 0, id: SESSION, createdAt: 1_000, cwd: '/tmp/demo', delegationDepth: 0 }),
        JSON.stringify({
          type: 'assistant/message',
          seq: 10,
          time: 2_000,
          data: {
            turn: 1,
            step: 1,
            message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
            usage: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          },
        }),
      ].join('\n')}\n`,
    );
    await writeFile(
      join(home, 'storages', 'session_projcache.json'),
      JSON.stringify({ tables: { sessions: { [SESSION]: { rows: { title: { val: '缓存的标题' } } } } } }),
    );
    await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({ global: { archivedSessionIds: [] }, tables: {} }));
  }

  it('covers the scan and names the projection cache and the workspace registry', async () => {
    await fixture();
    const sources = await sourcesCoveringScan(dshAgent, home, ['.jsonl', '.jsonl.zstd']);
    expect(sources.has(join(home, 'sessions', '--tmp-demo--', SESSION, 'session.jsonl'))).toBe(true);
    expect(sources.has(join(home, 'storages', 'session_projcache.json'))).toBe(true);
    expect(sources.has(join(home, 'storages', 'workspace.json'))).toBe(true);
  });

  it('drops a removed auxiliary file from the list', async () => {
    await fixture();
    const cache = join(home, 'storages', 'session_projcache.json');
    expect(await sourcesOf(dshAgent, home)).toContain(cache);
    await rm(cache);
    expect(await sourcesOf(dshAgent, home)).not.toContain(cache);
  });
});

describe('pi source list', () => {
  const PARENT = '2026-08-02T10-35-20-835Z_019fc20a-e183-76cd-af73-8a96cf233658';
  const FORK = '2026-08-02T11-00-00-000Z_019fc20b-1111-4111-8111-111111111111';

  /** A session, a subagent run under it, and a fork whose origin is outside. */
  async function fixture(): Promise<{ origin: string; run: string }> {
    const project = join(home, 'sessions', '--demo--');
    const run = join(project, PARENT, 'd3131b6a', 'run-0', 'session.jsonl');
    await mkdir(join(project, PARENT, 'd3131b6a', 'run-0'), { recursive: true });
    const session = (id: string, extra: Record<string, unknown> = {}): string =>
      JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-08-02T10:35:20.835Z', cwd: '/ws/demo', ...extra });
    const message = (id: string, time: number): string =>
      JSON.stringify({
        type: 'message',
        id,
        parentId: null,
        timestamp: new Date(time).toISOString(),
        message: {
          role: 'assistant',
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          usage: { input: 1_000, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        },
      });
    await writeFile(join(project, `${PARENT}.jsonl`), `${[session('p1'), message('m1', 1_000)].join('\n')}\n`);
    await writeFile(run, `${[session('c1'), message('m2', 2_000)].join('\n')}\n`);

    // A fork's origin lives outside the sessions root: still a file its scan reads.
    const origin = join(home, 'elsewhere', 'origin.jsonl');
    await mkdir(join(home, 'elsewhere'), { recursive: true });
    await writeFile(origin, `${[session('o1'), message('m3', 3_000)].join('\n')}\n`);
    await writeFile(
      join(project, `${FORK}.jsonl`),
      `${[session('f1', { parentSession: origin }), message('m4', 4_000)].join('\n')}\n`,
    );
    return { origin, run };
  }

  it('covers the scan and names the subagent run and a fork’s out-of-root origin', async () => {
    const { origin, run } = await fixture();
    const sources = await sourcesCoveringScan(piAgent, home);
    expect(sources.has(join(home, 'sessions', '--demo--', `${PARENT}.jsonl`))).toBe(true);
    expect(sources.has(join(home, 'sessions', '--demo--', `${FORK}.jsonl`))).toBe(true);
    expect(sources.has(run)).toBe(true);
    // Only reading the fork's header finds this one: it is outside the root.
    expect(sources.has(origin)).toBe(true);
  });

  it('drops a removed subagent run from the list', async () => {
    const { run } = await fixture();
    expect(await sourcesOf(piAgent, home)).toContain(run);
    await rm(join(run, '..', '..', '..', '..'), { recursive: true, force: true });
    expect(await sourcesOf(piAgent, home)).not.toContain(run);
  });
});
