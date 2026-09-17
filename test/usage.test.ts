import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadDataset, pathKey, resolveDshHome } from '../src/loader.ts';
import { PricingEngine } from '../src/pricing.ts';
import { expandWithDescendants, listSessions, resolveSessionSelectors, runQuery, type UsageQuery } from '../src/report.ts';
import { readSessionLog } from '../src/sessionlog.ts';

/**
 * The ledger shards usage by `FNV-1a-32(sessionId) % 32`, so each fixture
 * session is written into the shard the real plugin would have chosen. These
 * indices are asserted below, so a wrong fixture fails loudly instead of
 * quietly passing because the loader reads every file anyway.
 */
const SID = {
  /** Shard 25. Spans the 2026-09-10 price change and both bands. */
  spanning: 'session-aaaaaaaa-0000-4000-8000-000000000001',
  /** Shard 08. Only ever billed at the newer, cheaper rate. */
  current: 'session-bbbbbbbb-0000-4000-8000-000000000002',
  /** Shard 19. A second project, off-peak only. */
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

/** Ledger shard index for a session id, mirroring the plugin's hash. */
function shardIndexOf(sessionId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 32;
}

const WPSEARCH = '/home/user/ws/exampleApp';
const TOOLING = '/home/user/ws/exampleLib';

const WORKSPACE_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const WORKSPACE_B = 'bbbbbbbb-2222-4222-8222-222222222222';

/** Peak instants, expressed in UTC and annotated with Beijing wall time. */
const AT = {
  /** 2026-08-20 10:00 CST (Thursday) — peak, pre-change period. */
  augustPeak: Date.parse('2026-08-20T02:00:00Z'),
  /** 2026-08-20 20:00 CST (Thursday) — off-peak, pre-change period. */
  augustOffPeak: Date.parse('2026-08-20T12:00:00Z'),
  /** 2026-09-11 10:00 CST (Friday) — peak, current period. */
  septemberPeak: Date.parse('2026-09-11T02:00:00Z'),
  /** 2026-09-11 20:00 CST (Friday) — off-peak, current period. */
  septemberOffPeak: Date.parse('2026-09-11T12:00:00Z'),
} as const;

/** One ledger usage row, in the shape the plugin writes. */
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
    pricingTimeSource: 'request-context',
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

/** Write a shard file containing exactly one session record. */
async function writeShard(home: string, sessionId: string, record: Record<string, unknown>): Promise<void> {
  const name = `all_usage_ledger_${String(shardIndexOf(sessionId)).padStart(2, '0')}.json`;
  await writeFile(
    join(home, 'storages', name),
    JSON.stringify({
      unit: { name: name.replace(/\.json$/, ''), version: 0 },
      global: null,
      tables: { sessions: { __all_usage_ledger_meta__: { version: 1 }, [sessionId]: record } },
    }),
  );
}

/** Build a complete, self-consistent DSH home in a temporary directory. */
async function buildHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-usage-test-'));
  await mkdir(join(home, 'storages'), { recursive: true });

  // The registry deliberately lists only a subset of sessions, exactly like the
  // real one does — the loader must not treat `sessionIds` as the roster.
  await writeFile(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [WORKSPACE_A, WORKSPACE_B], archivedSessionIds: [] },
      tables: {
        workspaces: {
          [WORKSPACE_A]: {
            path: WPSEARCH,
            title: 'example-app',
            sessionIds: [SID.spanning],
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-09-11T00:00:00.000Z',
          },
          [WORKSPACE_B]: {
            path: TOOLING,
            title: 'example-lib',
            sessionIds: [],
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
          },
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
          [SID.spanning]: {
            identity: { createdAt: Date.parse('2026-08-20T01:00:00Z'), cwd: WPSEARCH },
            rows: { title: { ver: 1, seq: 9, val: '跨价格调整的会话' } },
          },
          [SID.current]: {
            identity: { createdAt: Date.parse('2026-09-11T01:00:00Z'), cwd: WPSEARCH },
            rows: { title: { ver: 1, seq: 9, val: '降价后的会话' } },
          },
          [SID.otherProject]: {
            identity: { createdAt: Date.parse('2026-09-11T11:00:00Z'), cwd: TOOLING },
            rows: { title: { ver: 1, seq: 9, val: '另一个项目' } },
          },
          [SID.neverBilled]: {
            identity: { createdAt: Date.parse('2026-09-12T00:00:00Z'), cwd: TOOLING },
            rows: { title: { ver: 1, seq: 9, val: '从未计费的会话' } },
          },
        },
      },
    }),
  );

  // Session 1: two requests before the price change (one peak, one off-peak)
  // and two after it, so it must be billed under two periods and both bands.
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

  // Session 2: one request at the newer rate only.
  await writeShard(
    home,
    SID.current,
    sessionRecord(SID.current, WORKSPACE_A, WPSEARCH, [
      usageRow(SID.current, 1, 1, AT.septemberOffPeak, { input: 500_000, output: 200_000, cacheRead: 100_000 }),
    ]),
  );

  // Session 3: another project entirely.
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
  await writeSessionLog(
    home,
    SID.subA,
    WPSEARCH,
    { parentSession: SID.spanning, delegationDepth: 1, createdAt: Date.parse('2026-08-20T02:00:00Z') },
    '分类插件的子代理',
  );
  await writeSessionLog(
    home,
    SID.subB,
    WPSEARCH,
    { parentSession: SID.spanning, delegationDepth: 1, createdAt: Date.parse('2026-08-20T03:00:00Z') },
  );
  await writeSessionLog(
    home,
    SID.subDeep,
    WPSEARCH,
    { parentSession: SID.subA, delegationDepth: 2, createdAt: Date.parse('2026-08-20T04:00:00Z') },
  );

  // One off-peak request each, so every subagent contributes exactly 5.02 CNY
  // and the arithmetic is checkable by hand.
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


/** Build an uncompressed session log: a header frame, then a title frame. */
async function writeSessionLog(
  home: string,
  sessionId: string,
  cwd: string,
  header: { parentSession?: string; delegationDepth: number; createdAt: number },
  title?: string,
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
  // DSH appends one zstd frame per batch; an uncompressed log is equally valid
  // input for the reader and keeps the fixture readable.
  await writeFile(join(dir, 'session.jsonl'), `${lines.join('\n')}\n`);
}

let home: string;
let engine: PricingEngine;

beforeEach(async () => {
  home = await buildHome();
  engine = new PricingEngine();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const query = (overrides: Partial<UsageQuery> = {}): UsageQuery => ({
  dimension: 'all',
  range: { from: null, to: null, label: '全部时间' },
  currencyRate: 1,
  currency: 'CNY',
  ...overrides,
});

describe('shard placement', () => {
  it('puts the fixture sessions in the shards the plugin hash dictates', () => {
    // Guards the fixture itself: if these ever move, the test is no longer
    // exercising cross-shard union.
    expect(shardIndexOf(SID.spanning)).toBe(25);
    expect(shardIndexOf(SID.current)).toBe(8);
    expect(shardIndexOf(SID.otherProject)).toBe(19);
    expect(shardIndexOf(SID.neverBilled)).toBe(10);
    expect(shardIndexOf(SID.subA)).toBe(4);
    expect(shardIndexOf(SID.subB)).toBe(17);
    expect(shardIndexOf(SID.subDeep)).toBe(31);
  });
});

describe('resolveDshHome', () => {
  it('prefers DSH_HOME', () => {
    expect(resolveDshHome({ DSH_HOME: '/custom/dsh', HOME: '/home/user' }, 'linux')).toBe('/custom/dsh');
  });

  it('ignores a blank DSH_HOME', () => {
    expect(resolveDshHome({ DSH_HOME: '   ', HOME: '/home/user' }, 'linux')).toBe('/home/user/.dsh');
  });

  it('falls back to ~/.dsh', () => {
    expect(resolveDshHome({ HOME: '/home/user' }, 'linux')).toBe('/home/user/.dsh');
  });

  it('rejects a relative DSH_HOME', () => {
    expect(() => resolveDshHome({ DSH_HOME: 'relative/path', HOME: '/home/user' }, 'linux')).toThrow(/absolute path/);
  });
});

describe('loading a DSH home', () => {
  it('unions sessions across ledger shards', async () => {
    const dataset = await loadDataset({ home });
    expect(dataset.sessions).toHaveLength(7);
    expect(dataset.shardFiles).toHaveLength(6);
    expect(dataset.sessions.map((session) => session.sessionId).sort()).toEqual(
      [SID.spanning, SID.current, SID.otherProject, SID.neverBilled, SID.subA, SID.subB, SID.subDeep].sort(),
    );
  });

  it('attributes sessions to projects by cwd, not by the registry roster', async () => {
    const dataset = await loadDataset({ home });
    const byName = new Map(dataset.projects.map((project) => [project.name, project]));
    // `example-app`'s `sessionIds` lists one session, but the cwd index puts both
    // of its sessions there.
    expect(byName.get('example-app')?.sessions.map((session) => session.sessionId).sort()).toEqual(
      [SID.spanning, SID.current, SID.subA, SID.subB, SID.subDeep].sort(),
    );
    // `example-lib` declares no sessions at all, yet both of its sessions are found.
    expect(byName.get('example-lib')?.sessions.map((session) => session.sessionId).sort()).toEqual(
      [SID.otherProject, SID.neverBilled].sort(),
    );
    expect(dataset.warnings).toEqual([]);
  });

  it('reads titles and creation times from the projection cache', async () => {
    const dataset = await loadDataset({ home });
    const spanning = dataset.sessions.find((session) => session.sessionId === SID.spanning);
    expect(spanning?.title).toBe('跨价格调整的会话');
    expect(spanning?.createdAt).toBe(Date.parse('2026-08-20T01:00:00Z'));
  });

  it('sorts usage entries chronologically', async () => {
    const dataset = await loadDataset({ home });
    const spanning = dataset.sessions.find((session) => session.sessionId === SID.spanning);
    const times = spanning?.entries.map((entry) => entry.time) ?? [];
    expect(times).toEqual([...times].sort((left, right) => left - right));
  });

  it('fails with an actionable message when the ledger is missing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dsh-usage-empty-'));
    await mkdir(join(empty, 'storages'), { recursive: true });
    await expect(loadDataset({ home: empty })).rejects.toThrow(/没有找到 all_usage_ledger_\*.json/);
    await rm(empty, { recursive: true, force: true });
  });

  it('reports a missing storages directory', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dsh-usage-nodir-'));
    await expect(loadDataset({ home: empty })).rejects.toThrow(/DSH 数据目录不存在/);
    await rm(empty, { recursive: true, force: true });
  });
});

describe('pathKey', () => {
  it('normalises separators, case, and trailing slashes', () => {
    expect(pathKey('/home/user/ws/')).toBe('/home/user/ws');
    expect(pathKey('C:\\Users\\Dev\\ws\\')).toBe('c:/users/dev/ws');
    expect(pathKey('/Home/User/WS')).toBe('/home/user/ws');
  });
});

describe('cost calculation over real ledger data', () => {
  it('bills each request at the rate in force at its own timestamp', async () => {
    const dataset = await loadDataset({ home });
    const result = runQuery(dataset, query({ sessions: [SID.spanning] }), engine);

    // Seven requests: the four of the named session plus one each from its three
    // subagent descendants, which session selection pulls in with it.
    // Pre-change peak   : hit 0.10 + miss 3.00 + out 9.00 = 12.10
    // Pre-change off-peak: hit 0.05 + miss 1.50 + out 4.50 =  6.05
    // Post-change peak  : hit 0.04 + miss 2.00 + out 8.00 = 10.04
    // Post-change off-peak: hit 0.02 + miss 1.00 + out 4.00 =  5.02
    expect(result.requests).toBe(7);
    expect(result.cost.total).toBe('48.2700');
    expect(result.cost.cacheHitInputCost).toBe('0.2700');
    expect(result.cost.cacheMissInputCost).toBe('10.5000');
    expect(result.cost.outputCost).toBe('37.5000');
  });

  it('splits one session across two periods AND two bands', async () => {
    const dataset = await loadDataset({ home });
    const result = runQuery(dataset, query({ sessions: [SID.spanning] }), engine);
    const bands = result.bands.map((band) => `${band.periodId}/${band.band}`).sort();
    expect(bands).toEqual([
      '2026-08-17/off-peak',
      '2026-08-17/peak',
      '2026-09-10/off-peak',
      '2026-09-10/peak',
    ]);
    expect(result.bands.every((band) => band.resolution === 'exact')).toBe(true);
  });

  it('counts reasoning tokens inside output without billing them twice', async () => {
    const dataset = await loadDataset({ home });
    // The session plus its three subagents, one of which did the thinking.
    const result = runQuery(dataset, query({ sessions: [SID.spanning] }), engine);
    expect(result.tokens.reasoning).toBe(500_000);
    expect(result.tokens.output).toBe(7_000_000);
    // Output tokens are counted once: reasoning is inside output, not beside it.
    expect(result.cost.outputTokens).toBe(7_000_000);
  });

  it('charges cache writes at the cache-miss rate', async () => {
    // DeepSeek never emits cache-write tokens, but a future adapter might; the
    // CLI must not silently drop them.
    await writeShard(
      home,
      SID.current,
      sessionRecord(SID.current, WORKSPACE_A, WPSEARCH, [
        usageRow(SID.current, 1, 1, AT.septemberOffPeak, {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 1_000_000,
        }),
      ]),
    );
    const dataset = await loadDataset({ home });
    const result = runQuery(dataset, query({ sessions: [SID.current] }), engine);
    expect(result.tokens.cacheWrite).toBe(1_000_000);
    expect(result.cost.cacheWriteTokens).toBe(1_000_000);
    expect(result.cost.cacheMissInputCost).toBe('1.0000');
  });

  it('sums to the total it displays', async () => {
    const dataset = await loadDataset({ home });
    const result = runQuery(dataset, query(), engine);
    const parts =
      Number(result.cost.cacheHitInputCost) + Number(result.cost.cacheMissInputCost) + Number(result.cost.outputCost);
    expect(parts).toBeCloseTo(Number(result.cost.total), 10);
    // Components are rendered as exact decimals with a fixed precision.
    expect(result.cost.total).toMatch(/^\d+\.\d{4}$/);
  });

  it('converts currency by the requested rate', async () => {
    const dataset = await loadDataset({ home });
    const cny = runQuery(dataset, query(), engine);
    const usd = runQuery(dataset, query({ currencyRate: 0.14, currency: 'USD' }), engine);
    expect(Number(usd.cost.total)).toBeCloseTo(Number(cny.cost.total) * 0.14, 3);
  });

  it('rejects a negative currency rate', async () => {
    const dataset = await loadDataset({ home });
    expect(() => runQuery(dataset, query({ currencyRate: -1 }), engine)).toThrow(/汇率必须是非负有限数字/);
  });
});

describe('dimensions and filters', () => {
  it('reports all projects in the project dimension, even empty ones', async () => {
    const dataset = await loadDataset({ home });
    const result = runQuery(dataset, query({ dimension: 'project' }), engine);
    expect(result.projects).toHaveLength(2);
    const exampleApp = result.projects.find((project) => project.name === 'example-app');
    // Folded by default: the two sessions a human started stand for all five.
    expect(exampleApp?.sessions).toBe(2);
    expect(exampleApp?.activeSessions).toBe(2);
    expect(exampleApp?.subagentSessions).toBe(3);
    expect(result.projects.every((project) => project.sessionReports === undefined)).toBe(true);
  });

  it('nests session reports inside projects in the session dimension', async () => {
    const dataset = await loadDataset({ home });
    const result = runQuery(dataset, query({ dimension: 'session' }), engine);
    const exampleApp = result.projects.find((project) => project.name === 'example-app');
    // Folded: one row per session a human started, carrying its whole subtree.
    expect(exampleApp?.sessionReports).toHaveLength(2);
    // A session that never billed is not reported as a zero row.
    const exampleLib = result.projects.find((project) => project.name === 'example-lib');
    expect(exampleLib?.sessions).toBe(2);
    expect(exampleLib?.sessionReports).toHaveLength(1);
    expect(exampleLib?.sessionReports?.[0]?.sessionId).toBe(SID.otherProject);
  });

  it('keeps the project total equal to the sum of its sessions', async () => {
    const dataset = await loadDataset({ home });
    const result = runQuery(dataset, query({ dimension: 'session' }), engine);
    const exampleApp = result.projects.find((project) => project.name === 'example-app');
    const sum = (exampleApp?.sessionReports ?? []).reduce((total, session) => total + Number(session.cost.total), 0);
    expect(sum).toBeCloseTo(Number(exampleApp?.cost.total), 10);
  });

  it('filters by project name, path, and workspace id', async () => {
    const dataset = await loadDataset({ home });
    for (const selector of ['example-lib', TOOLING, WORKSPACE_B]) {
      const result = runQuery(dataset, query({ projects: [selector] }), engine);
      expect(result.projects.map((project) => project.name)).toEqual(['example-lib']);
    }
  });

  it('glob-matches project selectors', async () => {
    const dataset = await loadDataset({ home });
    const result = runQuery(dataset, query({ projects: ['wp*'] }), engine);
    expect(result.projects.map((project) => project.name)).toEqual(['example-app']);
  });

  it('filters by several sessions at once', async () => {
    const dataset = await loadDataset({ home });
    const result = runQuery(dataset, query({ sessions: [SID.spanning, SID.otherProject] }), engine);
    // The named session's subtree — the session plus its three descendants —
    // plus the other project's single request.
    expect(result.requests).toBe(8);
    // Three descendants of the named session; the other project has none.
    expect(result.subagents.rows).toBe(3);
    expect(result.projects.map((project) => project.name).sort()).toEqual(['example-lib', 'example-app']);
  });

  it('warns instead of failing when a selector matches nothing', async () => {
    const dataset = await loadDataset({ home });
    const result = runQuery(dataset, query({ projects: ['does-not-exist'] }), engine);
    expect(result.requests).toBe(0);
    expect(result.warnings.join('\n')).toMatch(/没有项目匹配 "does-not-exist"/);
  });

  it('applies a time range to each request, not to the session', async () => {
    const dataset = await loadDataset({ home });
    // Only the two September requests are inside this window; the August ones
    // must not leak in just because the session also has newer requests.
    const result = runQuery(
      dataset,
      query({ range: { from: Date.parse('2026-09-01T00:00:00Z'), to: null, label: 'sept' }, sessions: [SID.spanning] }),
      engine,
    );
    // The session's two September requests, plus its three subagents', which
    // also fall inside the window.
    expect(result.requests).toBe(5);
    expect(result.bands.every((band) => band.periodId === '2026-09-10')).toBe(true);
  });

  it('flags an empty result', async () => {
    const dataset = await loadDataset({ home });
    const result = runQuery(
      dataset,
      query({ range: { from: Date.parse('2027-01-01T00:00:00Z'), to: null, label: 'future' } }),
      engine,
    );
    expect(result.requests).toBe(0);
    expect(result.warnings.join('\n')).toMatch(/没有任何用量记录/);
  });
});

describe('session selection', () => {
  it('accepts a full id and the session- prefixed form', async () => {
    const dataset = await loadDataset({ home });
    const bare = SID.spanning.replace(/^session-/, '');
    for (const selector of [SID.spanning, bare, `session-${bare}`]) {
      const { ids, errors } = resolveSessionSelectors(dataset.sessions, [selector]);
      expect(errors).toEqual([]);
      expect([...ids]).toEqual([SID.spanning]);
    }
  });

  it('accepts an unambiguous prefix', async () => {
    const dataset = await loadDataset({ home });
    const { ids, errors } = resolveSessionSelectors(dataset.sessions, ['session-aaaa']);
    expect(errors).toEqual([]);
    expect([...ids]).toEqual([SID.spanning]);
  });

  it('rejects an ambiguous prefix and names the candidates', async () => {
    const dataset = await loadDataset({ home });
    const { errors } = resolveSessionSelectors(dataset.sessions, ['session-']);
    expect(errors.join('\n')).toMatch(/有 7 个候选/);
  });

  it('reports an unknown session', async () => {
    const dataset = await loadDataset({ home });
    expect(resolveSessionSelectors(dataset.sessions, ['nope']).errors).toEqual(['找不到会话 "nope"']);
  });
});

describe('subagent detection', () => {
  it('reconstructs the delegation tree from session logs', async () => {
    const dataset = await loadDataset({ home });
    const byId = new Map(dataset.sessions.map((session) => [session.sessionId, session]));

    const parent = byId.get(SID.spanning);
    expect(parent?.isSubagent).toBe(false);
    expect(parent?.delegationDepth).toBe(0);
    expect(parent?.subagentIds).toEqual([SID.subA, SID.subB].sort());

    const child = byId.get(SID.subA);
    expect(child?.isSubagent).toBe(true);
    expect(child?.delegationDepth).toBe(1);
    expect(child?.parentSessionId).toBe(SID.spanning);
    expect(child?.parentKnown).toBe(true);
    // A grandchild is depth 2 and has its own subagent list.
    const grandchild = byId.get(SID.subDeep);
    expect(grandchild?.delegationDepth).toBe(2);
    expect(grandchild?.parentSessionId).toBe(SID.subA);
    expect(byId.get(SID.subA)?.subagentIds).toEqual([SID.subDeep]);
  });

  it('reads the title from the log for subagents the projection cache omits', async () => {
    const dataset = await loadDataset({ home });
    const child = dataset.sessions.find((session) => session.sessionId === SID.subA);
    // The projection cache has no entry for SID.subA, so only the log can title it.
    expect(child?.title).toBe('分类插件的子代理');
    const untitled = dataset.sessions.find((session) => session.sessionId === SID.subB);
    expect(untitled?.title).toBeNull();
  });

  it('expands a selection with every descendant', async () => {
    const dataset = await loadDataset({ home });
    const expanded = expandWithDescendants(dataset, new Set([SID.spanning]));
    expect([...expanded].sort()).toEqual([SID.spanning, SID.subA, SID.subB, SID.subDeep].sort());
    // Selecting a subagent takes its own subtree, not its siblings or parent.
    expect([...expandWithDescendants(dataset, new Set([SID.subA]))].sort()).toEqual([SID.subA, SID.subDeep].sort());
  });
});

describe('subagent accounting', () => {
  it('folds subagents into the session that spawned them by default', async () => {
    const dataset = await loadDataset({ home });
    const folded = runQuery(dataset, query({ dimension: 'session', projects: ['example-app'] }), engine);
    const parent = folded.projects[0]?.sessionReports?.find((row) => row.sessionId === SID.spanning);
    // Two subagents plus a grandchild, all inside the parent's number.
    // Two direct subagents plus a grandchild, all inside the parent's number.
    expect(parent?.subagentCount).toBe(3);
    expect(parent?.isSubagent).toBe(false);
    expect(folded.subagents.split).toBe(false);
    expect(folded.subagents.rows).toBe(3);
    // The parent's own 33.21 plus three subagent requests at 5.02 each.
    expect(parent?.cost.total).toBe('48.2700');
    expect(folded.subagents.cost.total).toBe('15.0600');
    // A folded report lists only the sessions a human started.
    expect(folded.projects[0]?.sessionReports?.every((row) => !row.isSubagent)).toBe(true);
    expect(folded.projects[0]?.sessions).toBe(2);
    expect(folded.projects[0]?.subagentSessions).toBe(3);
    // The row the user reads equals the total they are shown.
    const rowSum = (folded.projects[0]?.sessionReports ?? []).reduce(
      (total, row) => total + Number(row.cost.total),
      0,
    );
    expect(rowSum).toBeCloseTo(Number(folded.projects[0]?.cost.total ?? 0), 4);
  });

  it('splits subagents into their own rows on request', async () => {
    const dataset = await loadDataset({ home });
    const split = runQuery(
      dataset,
      query({ dimension: 'session', projects: ['example-app'], includeSubagents: false }),
      engine,
    );
    const exampleApp = split.projects.find((project) => project.name === 'example-app');
    const rows = exampleApp?.sessionReports ?? [];
    const parent = rows.find((row) => row.sessionId === SID.spanning);
    const child = rows.find((row) => row.sessionId === SID.subA);
    // The parent now reports only its own requests.
    expect(parent?.cost.total).toBe('33.2100');
    expect(parent?.isSubagent).toBe(false);
    expect(child?.isSubagent).toBe(true);
    expect(child?.parentSessionId).toBe(SID.spanning);
    expect(child?.cost.total).toBe('5.0200');
    // Every session is counted, subagents included.
    expect(exampleApp?.sessions).toBe(5);
    expect(exampleApp?.subagentSessions).toBe(3);
    expect(rows).toHaveLength(5);
    expect(split.subagents.split).toBe(true);
    // Same grand total in both modes: only the presentation differs.
    const folded = runQuery(dataset, query({ dimension: 'session', projects: ['example-app'] }), engine);
    expect(split.cost.total).toBeCloseTo(Number(folded.cost.total), 6);
  });

  it('keeps parent plus subagents equal to the folded parent', async () => {
    const dataset = await loadDataset({ home });
    const split = runQuery(
      dataset,
      query({ dimension: 'session', projects: ['example-app'], includeSubagents: false }),
      engine,
    );
    const exampleApp = split.projects.find((project) => project.name === 'example-app');
    const rows = exampleApp?.sessionReports ?? [];
    const family = rows.filter(
      (row) =>
        row.sessionId === SID.spanning ||
        row.parentSessionId === SID.spanning ||
        row.parentSessionId === SID.subA,
    );
    expect(family).toHaveLength(4);
    const sum = family.reduce((total, row) => total + Number(row.cost.total), 0);
    expect(sum).toBeCloseTo(48.27, 4);
  });

  it('reconciles the grand total, project totals, and session rows exactly', async () => {
    const dataset = await loadDataset({ home });
    const result = runQuery(dataset, query({ dimension: 'session' }), engine);
    const projectSum = result.projects.reduce((total, project) => total + Number(project.cost.total), 0);
    // Exact equality, not approximate: the grand total is computed in one pass
    // over the in-scope records, so no per-row rounding remainder can reach it.
    expect(Number(result.cost.total)).toBe(Number(projectSum.toFixed(4)));
    for (const project of result.projects) {
      const rowSum = (project.sessionReports ?? []).reduce((total, row) => total + Number(row.cost.total), 0);
      expect(Number(project.cost.total)).toBe(Number(rowSum.toFixed(4)));
    }
  });

  it('never double counts: both modes cover exactly the same usage', async () => {
    const dataset = await loadDataset({ home });
    const folded = runQuery(dataset, query({ dimension: 'session' }), engine);
    const split = runQuery(dataset, query({ dimension: 'session', includeSubagents: false }), engine);

    // Folding and splitting are presentation choices, so the totals must agree
    // to the last digit and both must equal the sum of their own rows.
    expect(Number(folded.cost.total)).toBeCloseTo(Number(split.cost.total), 6);
    expect(folded.requests).toBe(split.requests);
    for (const result of [folded, split]) {
      const projectSum = result.projects.reduce((total, project) => total + Number(project.cost.total), 0);
      expect(projectSum).toBeCloseTo(Number(result.cost.total), 4);
    }

    // The subagent slice is reported identically in both modes and is part of
    // the whole, never additional to it.
    expect(folded.subagents.cost.total).toBe(split.subagents.cost.total);
    expect(Number(folded.subagents.cost.total)).toBeGreaterThan(0);
    expect(Number(folded.subagents.cost.total)).toBeLessThan(Number(folded.cost.total));

    // Splitting only changes the number of rows.
    const foldedRows = folded.projects.flatMap((project) => project.sessionReports ?? []);
    const splitRows = split.projects.flatMap((project) => project.sessionReports ?? []);
    expect(foldedRows.every((row) => !row.isSubagent)).toBe(true);
    expect(splitRows.filter((row) => row.isSubagent)).toHaveLength(3);
  });

  it('includes a parent session subagents in the project count when folded', async () => {
    const dataset = await loadDataset({ home });
    const folded = runQuery(dataset, query({ dimension: 'project', projects: ['example-app'] }), engine);
    expect(folded.projects[0]?.sessions).toBe(2);
    expect(folded.projects[0]?.subagentSessions).toBe(3);
    const split = runQuery(dataset, query({ dimension: 'project', projects: ['example-app'], includeSubagents: false }), engine);
    expect(split.projects[0]?.sessions).toBe(5);
    expect(split.projects[0]?.subagentSessions).toBe(3);
  });

  it('keeps a named session subtree in scope when filtering', async () => {
    const dataset = await loadDataset({ home });
    // Naming the parent brings its subagents along in either mode.
    // Naming a session a human started pulls in everything it spawned, so the
    // totals are identical whether or not subagents are folded.
    for (const includeSubagents of [true, false]) {
      const result = runQuery(dataset, query({ sessions: [SID.spanning], includeSubagents }), engine);
      expect(result.requests).toBe(7);
      expect(result.subagents.rows).toBe(3);
      expect(result.subagents.cost.total).toBe('15.0600');
    }
    // Naming a subagent stays inside that subtree: the subagent and its own
    // child, never its siblings or its parent.
    for (const includeSubagents of [true, false]) {
      const child = runQuery(dataset, query({ sessions: [SID.subA], includeSubagents }), engine);
      expect(child.requests).toBe(2);
      expect(child.subagents.rows).toBe(2);
      // The named subagent is reported as a top-level row, so only its own child
      // is counted as a subagent *under* it.
      const exampleApp = child.projects.find((project) => project.name === 'example-app');
      expect(exampleApp?.subagentSessions).toBe(2);
    }
  });
});

describe('session list', () => {
  it('orders projects and sessions by time, descending', async () => {
    const dataset = await loadDataset({ home });
    const result = listSessions(dataset);
    // `example-lib` starts later than `example-app`, so it comes first.
    expect(result.projects.map((project) => project.name)).toEqual(['example-lib', 'example-app']);
    // Folded by default: the three subagents ride with their parent.
    expect(result.totalSessions).toBe(4);
    const exampleApp = result.projects.find((project) => project.name === 'example-app');
    expect(exampleApp?.sessions.map((session) => session.sessionId)).toEqual([SID.current, SID.spanning]);
    // The later-started session sorts first.
    expect((exampleApp?.sessions[0]?.firstUsage ?? 0) > (exampleApp?.sessions[1]?.firstUsage ?? 0)).toBe(true);
  });

  it('lists sessions that never billed a request', async () => {
    const dataset = await loadDataset({ home });
    const result = listSessions(dataset);
    const exampleLib = result.projects.find((project) => project.name === 'example-lib');
    const neverBilled = exampleLib?.sessions.find((session) => session.sessionId === SID.neverBilled);
    expect(neverBilled).toBeDefined();
    expect(neverBilled?.requests).toBe(0);
    expect(neverBilled?.firstUsage).toBeNull();
    expect(neverBilled?.createdAt).toBe(Date.parse('2026-09-12T00:00:00Z'));
  });

  it('honours project and session filters', async () => {
    const dataset = await loadDataset({ home });
    expect(listSessions(dataset, { projects: ['example-app'] }).projects.map((project) => project.name)).toEqual(['example-app']);
    const filtered = listSessions(dataset, { sessions: [SID.otherProject] });
    expect(filtered.totalSessions).toBe(1);
    expect(filtered.projects.map((project) => project.name)).toEqual(['example-lib']);
  });
});
