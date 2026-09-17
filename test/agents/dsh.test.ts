/**
 * DSH adapter tests.
 *
 * These build a real DSH home on disk — ledger shards, a workspace registry, a
 * projection cache, and session logs — and assert that the adapter converts it
 * into the neutral model correctly. The two things that are easy to get wrong
 * and are therefore pinned here: shard union, and delegation, which exists
 * *only* in the session logs.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dshAgent, resolveDshHome } from '../../src/agents/dsh/loader.ts';
import { locateSessionLogs, readSessionLog } from '../../src/agents/dsh/sessionlog.ts';
import { createPricingEngine } from '../../src/pricing/index.ts';
import { deepseekPricing } from '../../src/pricing/vendors/deepseek.ts';
import { listSessions, resolveSessionSelectors, runQuery, type UsageQuery } from '../../src/report.ts';

const SID = {
  /** Shard 25. Spans the 2026-09-10 price change and both tiers. */
  spanning: 'session-aaaaaaaa-0000-4000-8000-000000000001',
  /** Shard 08. Only ever billed at the newer, cheaper rate. */
  current: 'session-bbbbbbbb-0000-4000-8000-000000000002',
  /** Shard 19. A second project. */
  otherProject: 'session-cccccccc-0000-4000-8000-000000000003',
  /** Shard 10. Known to the projection cache but absent from the ledger. */
  neverBilled: 'session-dddddddd-0000-4000-8000-000000000004',
  /** Shard 04. A subagent spawned by {@link SID.spanning}. */
  subA: 'session-ffffffff-0000-4000-8000-00000000000f',
  /** Shard 17. A subagent spawned by {@link SID.spanning}. */
  subB: 'session-99999999-0000-4000-8000-000000000009',
  /** Shard 31. A subagent of {@link SID.subA} — depth 2. */
  subDeep: 'session-77777777-0000-4000-8000-000000000007',
} as const;

const WPSEARCH = '/home/user/ws/exampleApp';
const TOOLING = '/home/user/ws/exampleLib';
const WORKSPACE_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const WORKSPACE_B = 'bbbbbbbb-2222-4222-8222-222222222222';

/** Peak instants in UTC, annotated with Beijing wall time. */
const AT = {
  /** 2026-08-20 10:00 CST (Thursday) — peak, pre-change period. */
  augustPeak: Date.parse('2026-08-20T02:00:00Z'),
  /** 2026-08-20 20:00 CST — off-peak, pre-change period. */
  augustOffPeak: Date.parse('2026-08-20T12:00:00Z'),
  /** 2026-09-11 10:00 CST (Friday) — peak, current period. */
  septemberPeak: Date.parse('2026-09-11T02:00:00Z'),
  /** 2026-09-11 20:00 CST — off-peak, current period. */
  septemberOffPeak: Date.parse('2026-09-11T12:00:00Z'),
} as const;

/** Ledger shard index, mirroring the writer's FNV-1a hash. */
function shardIndexOf(sessionId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 32;
}

/** One ledger `usage[]` row. */
function usageRow(
  sessionId: string,
  turn: number,
  step: number,
  time: number,
  values: { input: number; output: number; cacheRead: number; cacheWrite?: number; reasoning?: number },
): Record<string, unknown> {
  return {
    key: `${sessionId}:step:${turn}:${step}`,
    seq: turn * 100 + step,
    time,
    workspaceId: null,
    identity: {
      identityKey: '["deepseek-official","deepseek-v4-flash","deepseek-v4-flash",null]',
      provider: 'deepseek-official',
      requestedModel: 'deepseek-v4-flash',
      actualModel: 'deepseek-v4-flash',
      label: 'deepseek-official / deepseek-v4-flash',
      legacy: false,
    },
    modelId: 'deepseek-official / deepseek-v4-flash',
    turn,
    step,
    values: {
      input: values.input,
      output: values.output,
      cacheRead: values.cacheRead,
      cacheWrite: values.cacheWrite ?? 0,
      reasoning: values.reasoning ?? 0,
    },
    pricingAt: time,
    cost: { pricingMode: 'official-model', status: 'unpriced', total: '0' },
  };
}

/** One ledger session record. */
function sessionRecord(
  sessionId: string,
  workspaceId: string,
  sourceCwd: string,
  usage: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    version: 3,
    sessionId,
    workspaceId,
    sourceCwd,
    lastSeq: 999,
    source: 'flush',
    updatedAt: 1_789_000_000_000,
    usage,
  };
}

/** Write one shard file holding one session record. */
async function writeShard(home: string, sessionId: string, record: Record<string, unknown>): Promise<void> {
  const name = `all_usage_ledger_${String(shardIndexOf(sessionId)).padStart(2, '0')}`;
  await writeFile(
    join(home, 'storages', `${name}.json`),
    JSON.stringify({ unit: { name, version: 0 }, global: null, tables: { sessions: { [sessionId]: record } } }),
  );
}

/** One per-step usage event to embed in a fixture session log. */
interface LogUsage {
  turn: number;
  step: number;
  time: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
  reasoning?: number;
  model?: string;
  provider?: string;
}

/** Write an uncompressed session log: header frame, optional title, optional usage. */
async function writeSessionLog(
  home: string,
  sessionId: string,
  cwd: string,
  header: { parentSession?: string; delegationDepth: number; createdAt: number },
  title?: string,
  usage: readonly LogUsage[] = [],
): Promise<void> {
  const projectKey = `--${cwd.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '')}--`;
  const dir = join(home, 'sessions', projectKey, sessionId);
  await mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 0,
      id: sessionId,
      createdAt: header.createdAt,
      cwd,
      delegationDepth: header.delegationDepth,
      ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
      ...(header.delegationDepth > 0 ? { origin: 'subagent' } : {}),
    }),
  ];
  if (title !== undefined) {
    lines.push(JSON.stringify({ type: 'session/title', seq: 3, time: header.createdAt + 1000, data: { title } }));
  }
  usage.forEach((entry, index) => {
    lines.push(
      JSON.stringify({
        type: 'assistant/message',
        seq: 10 + index,
        time: entry.time,
        data: {
          turn: entry.turn,
          step: entry.step,
          message: {
            source: { provider: entry.provider ?? 'deepseek-official', model: entry.model ?? 'deepseek-v4-flash' },
          },
          usage: {
            inputTokens: entry.input,
            outputTokens: entry.output,
            cacheReadTokens: entry.cacheRead,
            cacheWriteTokens: entry.cacheWrite ?? 0,
            reasoningTokens: entry.reasoning ?? 0,
          },
        },
      }),
    );
  });
  // DSH appends one zstd frame per batch; an uncompressed log is equally valid
  // input for the reader and keeps the fixture readable.
  await writeFile(join(dir, 'session.jsonl'), `${lines.join('\n')}\n`);
}

/** Build a complete, self-consistent DSH home. */
async function buildHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'agent-usages-dsh-'));
  await mkdir(join(home, 'storages'), { recursive: true });

  // The registry deliberately lists only a subset of sessions, exactly like the
  // real one does — the adapter must not treat `sessionIds` as the roster.
  await writeFile(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [WORKSPACE_A, WORKSPACE_B], archivedSessionIds: [] },
      tables: {
        workspaces: {
          [WORKSPACE_A]: { path: WPSEARCH, title: 'example-app', sessionIds: [SID.spanning], createdAt: 'x', updatedAt: 'x' },
          [WORKSPACE_B]: { path: TOOLING, title: 'example-lib', sessionIds: [], createdAt: 'x', updatedAt: 'x' },
        },
      },
    }),
  );

  await writeFile(
    join(home, 'storages', 'session_projcache.json'),
    JSON.stringify({
      unit: { name: 'session_projcache', version: 3 },
      global: null,
      tables: {
        sessions: Object.fromEntries(
          Object.entries({
            [SID.spanning]: { cwd: WPSEARCH, title: '跨价格调整的会话', createdAt: Date.parse('2026-08-20T01:00:00Z') },
            [SID.current]: { cwd: WPSEARCH, title: '降价后的会话', createdAt: Date.parse('2026-09-11T01:00:00Z') },
            [SID.otherProject]: { cwd: TOOLING, title: '另一个项目', createdAt: Date.parse('2026-09-11T11:00:00Z') },
            [SID.neverBilled]: { cwd: TOOLING, title: '从未计费的会话', createdAt: Date.parse('2026-09-12T00:00:00Z') },
          }).map(([id, meta]) => [
            id,
            {
              identity: { createdAt: meta.createdAt, cwd: meta.cwd },
              rows: { title: { ver: 1, seq: 9, val: meta.title } },
            },
          ]),
        ),
      },
    }),
  );

  // Session 1: two requests before the price change (one peak, one off-peak) and
  // two after it, so it must be billed under two periods and both tiers.
  await writeShard(
    home,
    SID.spanning,
    sessionRecord(SID.spanning, WORKSPACE_A, WPSEARCH, [
      usageRow(SID.spanning, 1, 1, AT.augustPeak, { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, reasoning: 500_000 }),
      usageRow(SID.spanning, 1, 2, AT.augustOffPeak, { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }),
      usageRow(SID.spanning, 2, 1, AT.septemberPeak, { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }),
      usageRow(SID.spanning, 2, 2, AT.septemberOffPeak, { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }),
    ]),
  );

  await writeShard(
    home,
    SID.current,
    sessionRecord(SID.current, WORKSPACE_A, WPSEARCH, [
      usageRow(SID.current, 1, 1, AT.septemberOffPeak, { input: 500_000, output: 200_000, cacheRead: 100_000 }),
    ]),
  );

  await writeShard(
    home,
    SID.otherProject,
    sessionRecord(SID.otherProject, WORKSPACE_B, TOOLING, [
      usageRow(SID.otherProject, 1, 1, AT.septemberOffPeak, { input: 2_000_000, output: 300_000, cacheRead: 0 }),
    ]),
  );

  // Session logs carry the delegation tree. The ledger and the projection cache
  // know nothing about who spawned whom, so these files are the only source.
  await writeSessionLog(home, SID.spanning, WPSEARCH, { delegationDepth: 0, createdAt: Date.parse('2026-08-20T01:00:00Z') }, '跨价格调整的会话');
  await writeSessionLog(home, SID.current, WPSEARCH, { delegationDepth: 0, createdAt: Date.parse('2026-09-11T01:00:00Z') }, '降价后的会话');
  await writeSessionLog(home, SID.otherProject, TOOLING, { delegationDepth: 0, createdAt: Date.parse('2026-09-11T11:00:00Z') }, '另一个项目');
  await writeSessionLog(home, SID.neverBilled, TOOLING, { delegationDepth: 0, createdAt: Date.parse('2026-09-12T00:00:00Z') }, '从未计费的会话');
  await writeSessionLog(home, SID.subA, WPSEARCH, { parentSession: SID.spanning, delegationDepth: 1, createdAt: Date.parse('2026-08-20T02:00:00Z') }, '分类插件的子代理');
  await writeSessionLog(home, SID.subB, WPSEARCH, { parentSession: SID.spanning, delegationDepth: 1, createdAt: Date.parse('2026-08-20T03:00:00Z') });
  await writeSessionLog(home, SID.subDeep, WPSEARCH, { parentSession: SID.subA, delegationDepth: 2, createdAt: Date.parse('2026-08-20T04:00:00Z') });

  // One off-peak request each, so every subagent contributes exactly 5.02 CNY.
  for (const subagentId of [SID.subA, SID.subB, SID.subDeep]) {
    await writeShard(
      home,
      subagentId,
      sessionRecord(subagentId, WORKSPACE_A, WPSEARCH, [
        usageRow(subagentId, 1, 1, AT.septemberOffPeak, { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }),
      ]),
    );
  }

  return home;
}

const LOG_ONLY = {
  parent: 'session-11111111-0000-4000-8000-0000000000a1',
  child: 'session-22222222-0000-4000-8000-0000000000a2',
  idle: 'session-33333333-0000-4000-8000-0000000000a3',
} as const;
const LOGONLY_WORKSPACE = 'cccccccc-3333-4333-8333-333333333333';
const LOGONLY_PATH = '/home/user/ws/logonly';

/**
 * A stock DSH home: no `dsh-all-usage` ledger, only session logs.
 *
 * The harness itself already records each step's usage, so the adapter must
 * produce the same report as the ledger path does from these logs alone.
 */
async function buildLogOnlyHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'agent-usages-dsh-logs-'));
  await mkdir(join(home, 'storages'), { recursive: true });

  await writeFile(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [LOGONLY_WORKSPACE], archivedSessionIds: [] },
      tables: {
        workspaces: {
          [LOGONLY_WORKSPACE]: { path: LOGONLY_PATH, title: 'logonly', sessionIds: [], createdAt: 'x', updatedAt: 'x' },
        },
      },
    }),
  );

  await writeFile(
    join(home, 'storages', 'session_projcache.json'),
    JSON.stringify({
      unit: { name: 'session_projcache', version: 3 },
      global: null,
      tables: {
        sessions: {
          [LOG_ONLY.idle]: {
            identity: { createdAt: Date.parse('2026-09-12T00:00:00Z'), cwd: LOGONLY_PATH },
            rows: { title: { ver: 1, seq: 9, val: '从未计费的会话' } },
          },
        },
      },
    }),
  );

  // Two off-peak requests on a top-level session and one on its subagent; the
  // third session only exists in the projection cache.
  await writeSessionLog(
    home,
    LOG_ONLY.parent,
    LOGONLY_PATH,
    { delegationDepth: 0, createdAt: Date.parse('2026-09-11T10:00:00Z') },
    '只用日志的会话',
    [
      { turn: 1, step: 1, time: AT.septemberOffPeak, input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, reasoning: 400_000 },
      { turn: 1, step: 2, time: AT.septemberOffPeak + 1000, input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 },
    ],
  );
  await writeSessionLog(
    home,
    LOG_ONLY.child,
    LOGONLY_PATH,
    { parentSession: LOG_ONLY.parent, delegationDepth: 1, createdAt: Date.parse('2026-09-11T10:30:00Z') },
    '日志里的子代理',
    [{ turn: 1, step: 1, time: AT.septemberOffPeak + 2000, input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }],
  );
  await writeSessionLog(home, LOG_ONLY.idle, LOGONLY_PATH, {
    delegationDepth: 0,
    createdAt: Date.parse('2026-09-12T00:00:00Z'),
  });

  return home;
}

let home: string;
let logOnlyHome: string;
const engine = createPricingEngine(deepseekPricing);
const context = { engine, pricingProvider: engine.provider.id };

beforeEach(async () => {
  home = await buildHome();
  logOnlyHome = await buildLogOnlyHome();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(logOnlyHome, { recursive: true, force: true });
});

/** A query over the fixture, overridden per test. */
const query = (overrides: Partial<UsageQuery> = {}): UsageQuery => ({
  dimension: 'all',
  range: { from: null, to: null, label: '全部时间' },
  currencyRate: 1,
  currency: 'CNY',
  ...overrides,
});

describe('adapter metadata', () => {
  it('declares its id, environment variable, and default source', () => {
    expect(dshAgent.id).toBe('dsh');
    expect(dshAgent.envVars).toEqual(['DSH_HOME']);
    expect(dshAgent.defaultSource({ HOME: '/home/user' })).toBe('/home/user/.dsh');
    expect(dshAgent.defaultSource({ DSH_HOME: '/custom' })).toBe('/custom');
    expect(dshAgent.defaultSource({ DSH_HOME: '  ', HOME: '/home/user' })).toBe('/home/user/.dsh');
    expect(dshAgent.defaultSource({})).toBeNull();
  });

  it('resolves the home the way the harness does', () => {
    expect(resolveDshHome(undefined, { DSH_HOME: '/custom/dsh', HOME: '/home/user' })).toBe('/custom/dsh');
    expect(resolveDshHome(undefined, { DSH_HOME: '   ', HOME: '/home/user' })).toBe('/home/user/.dsh');
    expect(() => resolveDshHome(undefined, { DSH_HOME: 'relative', HOME: '/home/user' })).toThrow(/绝对路径/);
    expect(() => resolveDshHome(undefined, {})).toThrow(/无法确定/);
  });

  it('detects whether a root holds DSH data', async () => {
    expect(await dshAgent.hasData(home)).toBe(true);
    expect(await dshAgent.hasData(join(home, 'nope'))).toBe(false);
  });

  it('explains its data caveats', () => {
    expect(dshAgent.notes().length).toBeGreaterThan(0);
    expect(dshAgent.notes().join('\n')).toMatch(/dsh-all-usage/);
  });
});

describe('shard placement', () => {
  it('puts each fixture session in the shard the writer hash dictates', () => {
    expect(shardIndexOf(SID.spanning)).toBe(25);
    expect(shardIndexOf(SID.current)).toBe(8);
    expect(shardIndexOf(SID.otherProject)).toBe(19);
    expect(shardIndexOf(SID.neverBilled)).toBe(10);
    expect(shardIndexOf(SID.subA)).toBe(4);
    expect(shardIndexOf(SID.subB)).toBe(17);
    expect(shardIndexOf(SID.subDeep)).toBe(31);
  });
});

describe('reading a DSH home', () => {
  it('unions sessions across ledger shards', async () => {
    const data = await dshAgent.load({ home });
    expect(data.agent).toBe('dsh');
    expect(data.sessions).toHaveLength(7);
    // 4 in the spanning session, 1 in each of its 3 subagents, 1 each in the
    // other two ledger sessions.
    expect(data.stats.records).toBe(9);
    expect(data.stats.filesRead.length).toBe(6);
  });

  it('attributes sessions to projects by cwd, not by the registry roster', async () => {
    const data = await dshAgent.load({ home });
    const byName = new Map(data.projects.map((project) => [project.name, project]));
    // `example-app`'s sessionIds lists one session; the cwd index finds all five.
    expect(byName.get('example-app')?.sessions).toHaveLength(5);
    // `example-lib` declares none at all, yet both of its sessions are found.
    expect(byName.get('example-lib')?.sessions).toHaveLength(2);
    expect(data.warnings).toEqual([]);
  });

  it('reads titles and creation times from the projection cache', async () => {
    const data = await dshAgent.load({ home });
    const spanning = data.sessions.find((session) => session.id === SID.spanning);
    expect(spanning?.title).toBe('跨价格调整的会话');
    expect(spanning?.createdAt).toBe(Date.parse('2026-08-20T01:00:00Z'));
  });

  it('orders records chronologically and keys them stably', async () => {
    const data = await dshAgent.load({ home });
    const spanning = data.sessions.find((session) => session.id === SID.spanning);
    const times = spanning?.records.map((entry) => entry.time) ?? [];
    expect(times).toEqual([...times].sort((left, right) => left - right));
    expect(new Set(spanning?.records.map((entry) => entry.id)).size).toBe(4);
    // The bare routed model is what a price list keys on.
    expect(spanning?.records[0]?.model).toBe('deepseek-v4-flash');
    expect(spanning?.records[0]?.modelLabel).toBe('deepseek-official / deepseek-v4-flash');
  });

  it('carries the adapter’s own totals as extra metadata', async () => {
    const data = await dshAgent.load({ home });
    const current = data.sessions.find((session) => session.id === SID.current);
    expect(current?.extra).toBeUndefined();
    // Only sessions the projection cache knows about carry a cross-check.
    const data2 = await dshAgent.load({ home });
    expect(data2.sessions.every((session) => session.id.length > 0)).toBe(true);
  });

  it('skips session logs when enrichment is off', async () => {
    const data = await dshAgent.load({ home, enrich: false });
    expect(data.sessions).toHaveLength(7);
    expect(data.sessions.every((session) => !session.isSubagent)).toBe(true);
    expect(data.sessions.every((session) => session.parentId === null)).toBe(true);
  });

  it('fails with an actionable message when there is neither a ledger nor a log', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'agent-usages-empty-'));
    await mkdir(join(empty, 'storages'), { recursive: true });
    await expect(dshAgent.load({ home: empty })).rejects.toThrow(/没有找到 DSH 用量数据/);
    expect(await dshAgent.hasData(empty)).toBe(false);
    await rm(empty, { recursive: true, force: true });
  });

  it('rejects a relative home', async () => {
    await expect(dshAgent.load({ home: 'relative/path' })).rejects.toThrow(/绝对路径/);
  });
});

describe('session log reading', () => {
  it('reads a plain JSONL header', async () => {
    const info = await readSessionLog(join(home, 'sessions', '--home-dev-ws-example-app--', SID.subA, 'session.jsonl'));
    expect(info.sessionId).toBe(SID.subA);
    expect(info.parentSessionId).toBe(SID.spanning);
    expect(info.delegationDepth).toBe(1);
    expect(info.title).toBe('分类插件的子代理');
  });

  it('reads a multi-frame zstd log from the real layout', async () => {
    // Real DSH logs are a chain of independent zstd frames; the reader steps
    // through them because node:zlib stops at the first one.
    const dir = join(home, 'sessions', '--home-dev-ws-example-app--', SID.subB);
    await rm(join(dir, 'session.jsonl'), { force: true });
    const { zstdCompressSync } = await import('node:zlib');
    const header = JSON.stringify({ type: 'session', version: 0, id: SID.subB, createdAt: 1, cwd: WPSEARCH, delegationDepth: 1, parentSession: SID.spanning });
    const title = JSON.stringify({ type: 'session/title', seq: 2, data: { title: '压缩日志标题' } });
    await writeFile(join(dir, 'session.jsonl.zstd'), Buffer.concat([zstdCompressSync(Buffer.from(`${header}\n`)), zstdCompressSync(Buffer.from(`${title}\n`))]));
    const info = await readSessionLog(join(dir, 'session.jsonl.zstd'));
    expect(info.parentSessionId).toBe(SID.spanning);
    expect(info.title).toBe('压缩日志标题');
  });
});

describe('delegation', () => {
  it('reconstructs the tree from session logs', async () => {
    const data = await dshAgent.load({ home });
    const byId = new Map(data.sessions.map((session) => [session.id, session]));

    const parent = byId.get(SID.spanning);
    expect(parent?.isSubagent).toBe(false);
    expect(parent?.depth).toBe(0);
    expect(parent?.childIds).toEqual([SID.subA, SID.subB].sort());

    const child = byId.get(SID.subA);
    expect(child?.isSubagent).toBe(true);
    expect(child?.depth).toBe(1);
    expect(child?.parentId).toBe(SID.spanning);
    expect(child?.parentKnown).toBe(true);
    expect(child?.childIds).toEqual([SID.subDeep]);

    const grandchild = byId.get(SID.subDeep);
    expect(grandchild?.depth).toBe(2);
    expect(grandchild?.parentId).toBe(SID.subA);
  });

  it('titles a subagent from its log, which the projection cache omits', async () => {
    const data = await dshAgent.load({ home });
    expect(data.sessions.find((session) => session.id === SID.subA)?.title).toBe('分类插件的子代理');
    expect(data.sessions.find((session) => session.id === SID.subB)?.title).toBeNull();
  });
});

describe('cost from real ledger data', () => {
  it('bills each request at the rate in force at its own timestamp', async () => {
    const data = await dshAgent.load({ home });
    const result = runQuery(data, query({ sessions: [SID.spanning] }), context);

    // Seven requests: the named session's four plus one each from its three
    // subagent descendants, which session selection pulls in with it.
    // Pre-change peak    : 0.10 + 3.00 + 9.00 = 12.10
    // Pre-change off-peak: 0.05 + 1.50 + 4.50 =  6.05
    // Post-change peak   : 0.04 + 2.00 + 8.00 = 10.04
    // Post-change off-peak x4: 0.02 + 1.00 + 4.00 = 5.02 each
    expect(result.requests).toBe(7);
    expect(result.cost.total).toBe('48.2700');
    expect(result.cost.cacheHitInputCost).toBe('0.2700');
    expect(result.cost.cacheMissInputCost).toBe('10.5000');
    expect(result.cost.outputCost).toBe('37.5000');
  });

  it('splits one session across two periods and two tiers', async () => {
    const data = await dshAgent.load({ home });
    const result = runQuery(data, query({ sessions: [SID.spanning] }), context);
    // The August requests fall in the 2026-08-17 period (before the weekend
    // exemption), the September ones in the current period.
    expect(result.bands.map((band) => `${band.periodId}/${band.tier}`).sort()).toEqual([
      '2026-08-17/off-peak',
      '2026-08-17/peak',
      '2026-09-10/off-peak',
      '2026-09-10/peak',
    ]);
    expect(result.bands.every((band) => band.resolution === 'exact')).toBe(true);
  });

  it('counts reasoning inside output without billing it twice', async () => {
    const data = await dshAgent.load({ home });
    const result = runQuery(data, query({ sessions: [SID.spanning] }), context);
    expect(result.tokens.reasoning).toBe(500_000);
    expect(result.tokens.output).toBe(7_000_000);
  });

  it('charges cache writes at the cache-miss rate', async () => {
    await writeShard(
      home,
      SID.current,
      sessionRecord(SID.current, WORKSPACE_A, WPSEARCH, [
        usageRow(SID.current, 1, 1, AT.septemberOffPeak, { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }),
      ]),
    );
    const data = await dshAgent.load({ home });
    const result = runQuery(data, query({ sessions: [SID.current] }), context);
    expect(result.tokens.cacheWrite).toBe(1_000_000);
    // DeepSeek does not bill cache writes on their own line, so the write joins
    // the miss bucket: 1M at the 1 CNY/M miss rate.
    expect(result.cost.total).toBe('1.0000');
    expect(result.cost.cacheMissInputCost).toBe('1.0000');
  });

  it('keeps every aggregate reconciled', async () => {
    const data = await dshAgent.load({ home });
    const result = runQuery(data, query({ dimension: 'project' }), context);
    const sum = result.projects.reduce((total, project) => total + Number(project.cost.total), 0);
    expect(Number(result.cost.total)).toBe(Number(sum.toFixed(4)));
  });

  it('folds subagents by default and splits them on request, with equal totals', async () => {
    const data = await dshAgent.load({ home });
    const folded = runQuery(data, query({ dimension: 'session', projects: ['example-app'] }), context);
    const split = runQuery(
      data,
      query({ dimension: 'session', projects: ['example-app'], subagentMode: 'detail' }),
      context,
    );
    expect(Number(folded.cost.total)).toBe(Number(split.cost.total));
    const foldedRows = folded.projects.find((project) => project.name === 'example-app')?.sessionReports ?? [];
    const splitRows = split.projects.find((project) => project.name === 'example-app')?.sessionReports ?? [];
    expect(foldedRows.every((row) => !row.isSubagent)).toBe(true);
    expect(splitRows.filter((row) => row.isSubagent)).toHaveLength(3);
    expect(splitRows.find((row) => row.id === SID.spanning)?.cost.total).toBe('33.2100');
  });

  it('breaks the real numbers down by scope', async () => {
    const data = await dshAgent.load({ home });
    const result = runQuery(data, query({ projects: ['example-app'], subagentMode: 'subagents' }), context);
    const breakdown = result.scopeBreakdown;
    expect(breakdown).toBeDefined();
    // Two sessions a human started (`spanning` and `current`), three subagents.
    // `spanning`'s own four requests cost 33.21; `current`'s single request costs
    // 0.002 + 0.5 + 0.8 = 1.302; each subagent's off-peak request costs 5.02.
    expect(breakdown?.own.sessions).toBe(2);
    expect(breakdown?.subagents.sessions).toBe(3);
    expect(breakdown?.own.requests).toBe(5);
    expect(breakdown?.subagents.requests).toBe(3);
    expect(breakdown?.own.cost.total).toBe('34.5120');
    expect(breakdown?.subagents.cost.total).toBe('15.0600');
    expect(breakdown?.total.cost.total).toBe('49.5720');
    // The breakdown must not disagree with the project it describes.
    expect(Number(breakdown?.own.cost.total) + Number(breakdown?.subagents.cost.total)).toBeCloseTo(
      Number(breakdown?.total.cost.total),
      6,
    );
  });
});

describe('title search on real data', () => {
  it('resolves a session by the title the projection cache stored', async () => {
    const data = await dshAgent.load({ home });
    const { ids, errors } = resolveSessionSelectors(data.sessions, ['  降价后的会话  ']);
    expect(errors).toEqual([]);
    expect([...ids]).toEqual([SID.current]);
  });

  it('resolves a subagent by the title only its log carries', async () => {
    // Subagents are absent from the projection cache, so this title exists
    // nowhere but the session log.
    const data = await dshAgent.load({ home });
    const { ids, errors } = resolveSessionSelectors(data.sessions, ['分类插件的子代理']);
    expect(errors).toEqual([]);
    expect([...ids]).toEqual([SID.subA]);
  });

  it('cannot select a session that has no title', async () => {
    const data = await dshAgent.load({ home });
    expect(data.sessions.find((session) => session.id === SID.subB)?.title).toBeNull();
    expect(resolveSessionSelectors(data.sessions, [SID.subB]).errors).toEqual([]);
  });

  it('reports a title it cannot find rather than failing silently', async () => {
    const data = await dshAgent.load({ home });
    expect(resolveSessionSelectors(data.sessions, ['并不存在的标题']).errors).toEqual(['找不到会话 "并不存在的标题"']);
  });
});

describe('session inventory', () => {
  it('orders projects and sessions newest first', async () => {
    const data = await dshAgent.load({ home });
    const result = listSessions(data);
    expect(result.projects.map((project) => project.name)).toEqual(['example-lib', 'example-app']);
    expect(result.agent).toBe('dsh');
    const exampleApp = result.projects.find((project) => project.name === 'example-app');
    expect(exampleApp?.sessions.map((session) => session.id)).toEqual([SID.current, SID.spanning]);
  });

  it('lists sessions that never billed a request', async () => {
    const data = await dshAgent.load({ home });
    const result = listSessions(data);
    const exampleLib = result.projects.find((project) => project.name === 'example-lib');
    const neverBilled = exampleLib?.sessions.find((session) => session.id === SID.neverBilled);
    expect(neverBilled?.requests).toBe(0);
    expect(neverBilled?.firstUsage).toBeNull();
    expect(neverBilled?.createdAt).toBe(Date.parse('2026-09-12T00:00:00Z'));
  });

  it('nests subagents under their parent on request', async () => {
    const data = await dshAgent.load({ home });
    const split = listSessions(data, { includeSubagents: true, projects: ['example-app'] });
    const exampleApp = split.projects[0];
    expect(exampleApp?.sessions.filter((session) => session.nested)).toHaveLength(3);
    // A parent comes first and its subagents follow it directly; the parent's
    // own first request predates theirs, so it sorts last among the roots.
    const topLevel = exampleApp?.sessions.filter((session) => !session.nested) ?? [];
    expect(topLevel.map((session) => session.id)).toEqual([SID.current, SID.spanning]);
    const parentIndex = exampleApp?.sessions.findIndex((session) => session.id === SID.spanning) ?? -1;
    expect(exampleApp?.sessions.slice(parentIndex + 1).every((session) => session.nested)).toBe(true);
  });
});

describe('reading a DSH home without the usage ledger', () => {
  it('detects a home that only has session logs', async () => {
    expect(await dshAgent.hasData(logOnlyHome)).toBe(true);
  });

  it('builds records, projects, and the delegation tree from logs alone', async () => {
    const data = await dshAgent.load({ home: logOnlyHome });
    expect(data.sessions).toHaveLength(3);
    expect(data.stats.records).toBe(3);
    expect(data.stats.filesRead).toHaveLength(3);
    expect(data.projects.map((project) => project.name)).toEqual(['logonly']);
    expect(data.projects[0]?.sessions).toHaveLength(3);

    const byId = new Map(data.sessions.map((session) => [session.id, session]));
    expect(byId.get(LOG_ONLY.parent)?.isSubagent).toBe(false);
    expect(byId.get(LOG_ONLY.child)?.parentId).toBe(LOG_ONLY.parent);
    expect(byId.get(LOG_ONLY.child)?.depth).toBe(1);
    expect(byId.get(LOG_ONLY.parent)?.childIds).toEqual([LOG_ONLY.child]);
    expect(byId.get(LOG_ONLY.parent)?.title).toBe('只用日志的会话');
    // A session the logs never mention still comes from the projection cache.
    expect(byId.get(LOG_ONLY.idle)?.records).toHaveLength(0);

    const first = byId.get(LOG_ONLY.parent)?.records[0];
    expect(first?.id).toBe(`${LOG_ONLY.parent}:step:1:1`);
    expect(first?.model).toBe('deepseek-v4-flash');
    expect(first?.modelLabel).toBe('deepseek-official / deepseek-v4-flash');
    expect(first?.tokens).toEqual({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, reasoning: 400_000 });
  });

  it('prices log-derived usage exactly like the ledger would', async () => {
    const data = await dshAgent.load({ home: logOnlyHome });
    const result = runQuery(data, query(), context);
    expect(result.requests).toBe(3);
    // Three off-peak post-change requests at 5.02 CNY each.
    expect(result.cost.total).toBe('15.0600');
    expect(result.tokens.reasoning).toBe(400_000);
    expect(result.bands.every((band) => band.resolution === 'exact')).toBe(true);
  });

  it('reads a mirrored v3 stream instead of the legacy seed file', async () => {
    const dir = join(home, 'sessions', '--home-dev-ws-example-app--', SID.current);
    await rm(join(dir, 'session.jsonl'), { force: true });
    const { zstdCompressSync } = await import('node:zlib');
    const header = JSON.stringify({
      type: 'session',
      version: 0,
      id: SID.current,
      createdAt: 1,
      cwd: WPSEARCH,
      delegationDepth: 0,
    });
    // The live release keeps a header-only seed at `session.jsonl.zstd` and
    // appends the real stream to `session.v3.jsonl.zstd`; only the latter counts.
    await writeFile(join(dir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(`${header}\n`)));
    const event = JSON.stringify({
      type: 'assistant/message',
      seq: 2,
      time: AT.septemberOffPeak,
      data: {
        turn: 1,
        step: 1,
        message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: 5 },
      },
    });
    await writeFile(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(`${header}\n${event}\n`)));

    const located = await locateSessionLogs(home);
    expect(located.find((log) => log.directoryName === SID.current)?.path).toMatch(/session\.v3\.jsonl\.zstd$/);

    const scan = await readSessionLog(join(dir, 'session.v3.jsonl.zstd'), { collectUsage: true });
    expect(scan.records).toHaveLength(1);
    expect(scan.records[0]).toMatchObject({
      id: `${SID.current}:step:1:1`,
      model: 'deepseek-v4-flash',
      tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, reasoning: 5 },
    });
  });
});
