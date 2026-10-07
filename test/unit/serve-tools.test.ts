/**
 * The tool-call view over HTTP.
 *
 * Two things are pinned here beyond the shapes: the identity the rest of the
 * dashboard is built on — `Σ agents = totals`, for calls, records, records with
 * calls, the three outcomes and bytes — and the difference between "this data
 * recorded no tool call" and "this snapshot never carried tool calls at all".
 * The second is the failure mode a reader cannot see: both answer with an empty
 * list unless the payload says which one it is.
 *
 * A real DSH home is built on disk (a session log with two tool results, one of
 * them an error) so the aggregation under test is the adapters' own data, not a
 * hand-made report object.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dshAgent } from '../../src/agents/dsh/loader.ts';
import { collectTools, type ToolsReport } from '../../src/report/tools.ts';
import { resolveRange } from '../../src/report/timerange.ts';
import { openStore, type DashboardStore } from '../../src/serve/data.ts';
import { createApp } from '../../src/serve/server.ts';

const SESSION_ID = 'session-abcdefab-0000-4000-8000-0000000000ab';
const CWD = '/tmp/serve-tools-demo';
/** 2026-09-11 20:00 CST, the instant the usage fixtures use. */
const AT = Date.parse('2026-09-11T12:00:00Z');
const BASH_ARGS = '{"command": "ls -la"}';
const READ_ARGS = '{"file_path": "/tmp/a.ts"}';
/** A payload long enough that its excerpt is bounded while `bytes` is not. */
const LONG_ARGS = `{"command": "${'x'.repeat(2_000)}"}`;

/** The fixture's own numbers: three calls over three records, one of each verdict. */
const EXPECTED = {
  calls: 3,
  records: 3,
  recordsWithCalls: 2,
  ok: { true: 1, false: 1, unknown: 1 },
  bytes: Buffer.byteLength(BASH_ARGS, 'utf8') + Buffer.byteLength(READ_ARGS, 'utf8') + Buffer.byteLength(LONG_ARGS, 'utf8'),
};

let work: string;
let home: string;

/** One `assistant/message` event carrying the content of one step. */
function step(seq: number, content: unknown[]): string {
  return JSON.stringify({
    type: 'assistant/message',
    seq,
    time: AT + seq,
    data: {
      turn: 1,
      step: seq,
      message: { role: 'assistant', content, source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    },
  });
}

/** One `tool/result` event; `error` is how the harness records a failure. */
function result(seq: number, callId: string, error?: unknown): string {
  return JSON.stringify({
    type: 'tool/result',
    seq,
    time: AT + seq,
    data: {
      turn: 1,
      step: 10,
      message: { source: { kind: 'tool', callId }, content: [] },
      ...(error === undefined ? {} : { error }),
    },
  });
}

/** Write the DSH home the tests read. */
async function writeHome(): Promise<void> {
  const projectKey = `--${CWD.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '')}--`;
  const dir = join(home, 'sessions', projectKey, SESSION_ID);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'session.jsonl'),
    `${[
      JSON.stringify({ type: 'session', version: 0, id: SESSION_ID, createdAt: AT, cwd: CWD, delegationDepth: 0 }),
      JSON.stringify({ type: 'session/title', seq: 2, time: AT, data: { title: '工具会话' } }),
      step(10, [
        { type: 'tool-call', id: 'call_1', name: 'bash', arguments: BASH_ARGS },
        { type: 'tool-call', id: 'call_2', name: 'read', arguments: READ_ARGS },
      ]),
      result(11, 'call_1'),
      result(12, 'call_2', { name: 'FsError', code: 'FS_NOT_OBSERVED' }),
      step(20, [{ type: 'text', text: 'no tool here' }]),
      step(30, [{ type: 'tool-call', id: 'call_3', name: 'write', arguments: LONG_ARGS }]),
    ].join('\n')}\n`,
  );
}

/** A store over the fixture home, with the usage store out of the way. */
async function liveStore(): Promise<DashboardStore> {
  return openStore({
    agent: 'dsh',
    home,
    noUpdate: true,
    noStore: true,
    env: { ...process.env, DSH_HOME: home },
  });
}

/** The app on a free port, the way `startServer` binds it. */
async function serve(store: DashboardStore): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createApp(store, { quiet: true }).listen(0);
  await new Promise((done) => server.once('listening', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** GET one path as JSON. */
async function get(url: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`);
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

/** The numbers of one agent row, for comparing two aggregations field by field. */
function agentNumbers(report: ToolsReport | undefined): unknown[] {
  return (report?.agents ?? []).map((agent) => [
    agent.agent,
    agent.calls,
    agent.records,
    agent.recordsWithCalls,
    agent.ok.true,
    agent.ok.false,
    agent.ok.unknown,
    agent.bytes,
    agent.tools.map((tool) => [tool.name, tool.calls, tool.ok.true, tool.ok.false, tool.ok.unknown, tool.bytes, tool.share]),
  ]);
}

/** The four totals, summed from the rows, as the API promises them. */
function summed(report: { agents: readonly { calls: number; records: number; recordsWithCalls: number; bytes: number; ok: { true: number; false: number; unknown: number } }[] }): Record<string, number> {
  const total = { calls: 0, records: 0, recordsWithCalls: 0, bytes: 0, true: 0, false: 0, unknown: 0 };
  for (const agent of report.agents) {
    total.calls += agent.calls;
    total.records += agent.records;
    total.recordsWithCalls += agent.recordsWithCalls;
    total.bytes += agent.bytes;
    total.true += agent.ok.true;
    total.false += agent.ok.false;
    total.unknown += agent.ok.unknown;
  }
  return total;
}

/** The same totals as the payload states them. */
function stated(report: { totals: { calls: number; records: number; recordsWithCalls: number; bytes: number; ok: { true: number; false: number; unknown: number } } }): Record<string, number> {
  const { totals } = report;
  return {
    calls: totals.calls,
    records: totals.records,
    recordsWithCalls: totals.recordsWithCalls,
    bytes: totals.bytes,
    true: totals.ok.true,
    false: totals.ok.false,
    unknown: totals.ok.unknown,
  };
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'agent-usages-serve-tools-'));
  home = join(work, '.dsh');
  await writeHome();
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('tool calls on a live store', () => {
  it('hangs the aggregation on the dashboard, and writes it into a snapshot', async () => {
    const store = await liveStore();
    const tools = store.dashboard().tools;
    expect(tools?.agents.map((agent) => agent.agent)).toEqual(['dsh']);
    expect(tools?.agents[0]?.calls).toBe(EXPECTED.calls);
    expect(tools?.agents[0]?.records).toBe(EXPECTED.records);
    expect(tools?.agents[0]?.recordsWithCalls).toBe(EXPECTED.recordsWithCalls);
    expect(tools?.agents[0]?.ok).toEqual(EXPECTED.ok);
    expect(tools?.agents[0]?.bytes).toBe(EXPECTED.bytes);
    expect(tools?.agents[0]?.tools.map((tool) => tool.name)).toEqual(['bash', 'read', 'write']);
    expect(tools?.totals).toEqual({ ...EXPECTED, ok: EXPECTED.ok });

    // The snapshot is a photograph of that same aggregation: what was computed
    // for the dashboard is what the file carries, and reading it back gives the
    // very same numbers.
    const path = join(work, 'snapshot.json');
    await store.writeSnapshot(path);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { tools?: ToolsReport };
    expect(agentNumbers(parsed.tools)).toEqual(agentNumbers(tools));

    const loaded = await openStore({ snapshot: path, noStore: true });
    expect(loaded.toolsAvailable).toBe(true);
    expect(agentNumbers(loaded.dashboard().tools)).toEqual(agentNumbers(tools));
  });

  it('writes exactly what collectTools computes for the same dataset', async () => {
    const store = await liveStore();
    const dataset = await dshAgent.load({ home, env: { ...process.env, DSH_HOME: home }, enrich: true });
    const reference = collectTools(dataset, { range: resolveRange({}) });
    // Field by field, not structure against structure: the point is that the
    // server and the CLI agree on every number.
    expect(agentNumbers(store.dashboard().tools)).toEqual(agentNumbers(reference));
  });

  it('serves /api/tools with Σ agents = totals', async () => {
    const running = await serve(await liveStore());
    try {
      const answer = await get(running.url, '/api/tools');
      expect(answer.status).toBe(200);
      const body = answer.body as unknown as ToolsReport & { unavailable?: boolean };
      expect(body.unavailable).toBeUndefined();
      expect(body.agents.map((agent) => agent.agent)).toEqual(['dsh']);
      expect(summed(body)).toEqual(stated(body));
      expect(stated(body)).toMatchObject({ calls: 3, records: 3, recordsWithCalls: 2, bytes: EXPECTED.bytes });

      const health = await get(running.url, '/api/health');
      expect(health.body['toolsAvailable']).toBe(true);

      // The same block rides on the dashboard payload, for a client that has it.
      const dashboard = await get(running.url, '/api/dashboard');
      const carried = dashboard.body['tools'] as ToolsReport;
      expect(summed(carried)).toEqual(stated(carried));
    } finally {
      await running.close();
    }
  });

  it('keeps the identity when the query narrows by agent or range', async () => {
    const running = await serve(await liveStore());
    try {
      const narrowed = await get(running.url, '/api/tools?agent=dsh');
      expect((narrowed.body as unknown as ToolsReport).agents.map((agent) => agent.agent)).toEqual(['dsh']);
      expect(summed(narrowed.body as unknown as ToolsReport)).toEqual(stated(narrowed.body as unknown as ToolsReport));

      // A name no agent has is an empty answer, not the whole table.
      const nothing = await get(running.url, '/api/tools?agent=nope');
      const empty = nothing.body as unknown as ToolsReport;
      expect(empty.agents).toEqual([]);
      expect(empty.totals.calls).toBe(0);
      expect(summed(empty)).toEqual(stated(empty));

      const ranged = await get(running.url, '/api/tools?range=today');
      const window = ranged.body as unknown as ToolsReport;
      expect(summed(window)).toEqual(stated(window));

      // An unparseable range fails the same way every other route does.
      const bad = await get(running.url, '/api/tools?range=2026-01-01..2026-02-02..2026-03-03');
      expect(bad.status).toBe(400);
      expect(typeof (bad.body['error'] as { code?: unknown })?.code).toBe('string');
    } finally {
      await running.close();
    }
  });
});

describe('a snapshot without tool data', () => {
  /** The fixture snapshot with its `tools` member removed, as an older file. */
  async function oldSnapshot(): Promise<string> {
    const store = await liveStore();
    const path = join(work, 'old.json');
    const fresh = join(work, 'fresh.json');
    await store.writeSnapshot(fresh);
    const parsed = JSON.parse(await readFile(fresh, 'utf8')) as Record<string, unknown>;
    delete parsed['tools'];
    await writeFile(path, `${JSON.stringify(parsed)}\n`);
    return path;
  }

  it('answers unavailable rather than "no tool calls"', async () => {
    const store = await openStore({ snapshot: await oldSnapshot(), noStore: true });
    expect(store.toolsAvailable).toBe(false);
    expect(store.dashboard().tools).toBeUndefined();

    const running = await serve(store);
    try {
      const answer = await get(running.url, '/api/tools');
      expect(answer.status).toBe(200);
      expect(answer.body['unavailable']).toBe(true);
      expect(answer.body['agents']).toEqual([]);
      expect(answer.body['totals']).toEqual({
        calls: 0,
        records: 0,
        recordsWithCalls: 0,
        ok: { true: 0, false: 0, unknown: 0 },
        bytes: 0,
      });
      const health = await get(running.url, '/api/health');
      expect(health.body['toolsAvailable']).toBe(false);
    } finally {
      await running.close();
    }
  });

  it('tells an empty report apart from a missing one', async () => {
    // The other case: the file *does* carry tool data, and it says zero calls.
    const path = join(work, 'empty.json');
    await writeFile(
      path,
      `${JSON.stringify({
        tools: {
          agents: [
            {
              agent: 'dsh',
              calls: 0,
              records: 3,
              recordsWithCalls: 0,
              ok: { true: 0, false: 0, unknown: 0 },
              bytes: 0,
              tools: [],
              sessions: [],
            },
          ],
          totals: { calls: 0, records: 3, recordsWithCalls: 0, ok: { true: 0, false: 0, unknown: 0 }, bytes: 0 },
        },
      })}\n`,
    );
    const store = await openStore({ snapshot: path, noStore: true });
    expect(store.toolsAvailable).toBe(true);
    const running = await serve(store);
    try {
      const answer = await get(running.url, '/api/tools');
      expect(answer.status).toBe(200);
      expect(answer.body['unavailable']).toBeUndefined();
      const body = answer.body as unknown as ToolsReport;
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0]?.records).toBe(3);
      expect(body.agents[0]?.calls).toBe(0);
      expect(summed(body)).toEqual(stated(body));
    } finally {
      await running.close();
    }
  });
});

describe('narrowing a multi-agent snapshot', () => {
  /** A snapshot carrying two agents, so narrowing has something to drop. */
  async function twoAgentSnapshot(): Promise<string> {
    const path = join(work, 'two.json');
    await writeFile(
      path,
      `${JSON.stringify({
        loadedAgents: [
          { id: 'dsh', label: 'DSH', source: '/tmp/dsh' },
          { id: 'codex', label: 'Codex', source: '/tmp/codex' },
        ],
        tools: {
          agents: [
            { agent: 'dsh', calls: 5, records: 6, recordsWithCalls: 4, ok: { true: 4, false: 1, unknown: 0 }, bytes: 500, tools: [], sessions: [] },
            { agent: 'codex', calls: 2, records: 3, recordsWithCalls: 2, ok: { true: 0, false: 0, unknown: 2 }, bytes: 200, tools: [], sessions: [] },
          ],
          // Deliberately wrong totals: the reader recomputes them from the rows,
          // which is what makes the identity hold for any file.
          totals: { calls: 999, records: 999, recordsWithCalls: 999, ok: { true: 999, false: 9, unknown: 9 }, bytes: 999 },
        },
      })}\n`,
    );
    return path;
  }

  it('drops the other agents and re-totals them', async () => {
    const store = await openStore({ snapshot: await twoAgentSnapshot(), noStore: true });
    const running = await serve(store);
    try {
      const all = (await get(running.url, '/api/tools')).body as unknown as ToolsReport;
      expect(all.agents.map((agent) => agent.agent).sort()).toEqual(['codex', 'dsh']);
      expect(all.totals.calls).toBe(7);
      expect(summed(all)).toEqual(stated(all));

      const only = (await get(running.url, '/api/tools?agent=codex')).body as unknown as ToolsReport;
      expect(only.agents.map((agent) => agent.agent)).toEqual(['codex']);
      expect(only.totals.calls).toBe(2);
      expect(only.totals.bytes).toBe(200);
      expect(only.totals.ok.unknown).toBe(2);
      expect(summed(only)).toEqual(stated(only));

      // The dashboard payload is narrowed by the same rule, so a page that reads
      // it rather than the endpoint sees the same rows.
      const dashboard = (await get(running.url, '/api/dashboard?agent=codex')).body['tools'] as ToolsReport;
      expect(dashboard.agents.map((agent) => agent.agent)).toEqual(['codex']);
      expect(summed(dashboard)).toEqual(stated(dashboard));
    } finally {
      await running.close();
    }
  });
});
