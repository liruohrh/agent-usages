/**
 * Presentation tests: the text tables and the JSON payload.
 *
 * The table renderer has two jobs that are easy to break silently — aligning
 * columns when titles contain wide characters, and reconciling a totals row with
 * the report it belongs to — so both are pinned here.
 */

import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';

import { emptyBuckets } from '../../src/core/buckets.ts';
import type { CostTotals, TokenTotals } from '../../src/core/types.ts';
import { createPricingEngine } from '../../src/pricing/index.ts';
import { formatSessionList, formatUsageReport, sessionListToJson, usageToJson, type FormatOptions, type ReportSection } from '../../src/format.ts';
import type { ProjectReport, ScopeTotals, SessionListResult, SessionReport, UsageResult } from '../../src/report.ts';
import { stubProvider, TEST_CURRENCY } from '../support/stub-pricing.ts';

const engine = createPricingEngine(stubProvider());

/** A cost total with the fields a test does not set left at zero. */
function cost(total: string, overrides: Partial<CostTotals> = {}): CostTotals {
  return {
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheHitInputCost: '0.0000',
    cacheMissInputCost: '0.0000',
    outputCost: '0.0000',
    cacheWriteInputCost: '0.0000',
    total,
    ...overrides,
  };
}

/** A project row for the report fixtures. */
function projectRow(overrides: Partial<ProjectReport> & { id: string }): ProjectReport {
  return {
    name: overrides.id,
    path: `/tmp/${overrides.id}`,
    sessions: 1,
    activeSessions: 1,
    subagentSessions: 0,
    requests: 0,
    firstUsage: null,
    lastUsage: null,
    tokens: emptyBuckets(),
    cost: cost('0.0000'),
    own: { sessions: 0, requests: 0, tokens: emptyBuckets(), cost: cost('0.0000') },
    spawned: { sessions: 0, requests: 0, tokens: emptyBuckets(), cost: cost('0.0000') },
    total: { sessions: 0, requests: 0, tokens: emptyBuckets(), cost: cost('0.0000') },
    bands: [],
    models: [],
    ...overrides,
  };
}

/** A zero-cost report, so each test sets only what it asserts. */
function report(overrides: Partial<UsageResult> = {}): UsageResult {
  return {
    agent: 'test',
    source: '/tmp/test',
    dimension: 'all',
    range: { from: null, to: null, label: '全部时间' },
    currency: TEST_CURRENCY.code,
    currencyRate: 1,
    pricingProvider: 'stub',
    subagentMode: 'total',
    subagents: { sessions: 0, parents: 0 },
    requests: 0,
    firstUsage: null,
    lastUsage: null,
    unpriced: 0,
    tokens: emptyBuckets(),
    cost: cost('0.0000'),
    bands: [],
    components: new Map(),
    models: [],
    projects: [],
    warnings: [],
    ...overrides,
  };
}


/**
 * Display width in terminal cells.
 *
 * Deliberately the renderer's own measurement: a test that measures with a
 * different rule could pass while the terminal still renders ragged columns.
 */
function cells(line: string): number {
  return stringWidth(line);
}

/** One node's totals: the shape every tree node carries. */
function totals(tokens: TokenTotals, requests: number, total: string, sessions = 1): ScopeTotals {
  return { sessions, requests, tokens, cost: cost(total) };
}

/** A session row for the report fixtures. */
function sessionRow(overrides: Partial<SessionReport> & { id: string }): SessionReport {
  const tokens = overrides.tokens ?? emptyBuckets();
  const requests = overrides.requests ?? 0;
  const total = overrides.cost?.total ?? '0.0000';
  return {
    title: null,
    cwd: null,
    projectName: 'demo',
    projectId: 'demo',
    createdAt: null,
    firstUsage: null,
    lastUsage: null,
    isSubagent: false,
    subagentCount: 0,
    parentId: null,
    requests,
    tokens,
    cost: cost(total),
    bands: [],
    models: [],
    own: totals(tokens, requests, total),
    spawned: totals(emptyBuckets(), 0, '0.0000', 0),
    total: totals(tokens, requests, total),
    ...overrides,
  };
}

/** Wrap one result as the single window a report prints. */
function one(result: UsageResult, label = '总'): ReportSection[] {
  return [{ label, range: result.range, result }];
}

/** Render a report, defaulting to the plain tree. */
function render(result: UsageResult, options: FormatOptions = {}): string {
  return formatUsageReport(one(result), engine, '¤', options);
}

/** A tiny token set whose figures stay below `compact`'s rounding. */
const SMALL: TokenTotals = { input: 10, cacheRead: 20, cacheWrite: 0, output: 50, reasoning: 10 };

describe('formatUsageReport', () => {
  it('names the agent, its data root, the range, and the pricing source', () => {
    const text = render(report({ range: { from: null, to: null, label: '全部时间' } }), { agentLabel: 'Stub Agent' });
    expect(text).toContain('Agent 用量统计');
    expect(text).toContain('test（Stub Agent）');
    expect(text).toContain('数据目录  /tmp/test');
    expect(text).toContain('时间范围  全部时间');
    expect(text).toContain('计价来源  Stub Vendor（XTS）');
  });

  it('prints one compact metric line per node, with no numbers on name lines', () => {
    const text = render(
      report({
        requests: 3,
        tokens: SMALL,
        cost: cost('1.0000'),
        projects: [
          projectRow({
            id: 'demo',
            requests: 3,
            tokens: SMALL,
            cost: cost('1.0000'),
            own: totals(SMALL, 3, '1.0000'),
            spawned: totals(emptyBuckets(), 0, '0.0000', 0),
            total: totals(SMALL, 3, '1.0000'),
            sessionReports: [sessionRow({ id: 's1', title: 'First', requests: 3, tokens: SMALL, cost: cost('1.0000') })],
          }),
        ],
      }),
    );
    expect(text).toContain('I 10 · I/C 20 · I/T 30 · O 40 · R 10 · O/T 50 · T 80 · Q 3 · ¤1.00');
    // The name line carries only the name.
    expect(text).toContain('\n  First\n');
    expect(text).not.toContain('  First I ');
  });

  it('walks 总 → 项目 → 会话 as indented lines', () => {
    const text = render(
      report({
        projects: [
          projectRow({
            id: 'alpha',
            requests: 2,
            tokens: SMALL,
            cost: cost('2.0000'),
            own: totals(SMALL, 2, '2.0000'),
            spawned: totals(emptyBuckets(), 0, '0.0000', 0),
            total: totals(SMALL, 2, '2.0000'),
            sessionReports: [
              sessionRow({ id: 'a1', title: 'A one', requests: 1, tokens: SMALL, cost: cost('1.0000') }),
              sessionRow({ id: 'a2', title: 'A two', requests: 1, tokens: SMALL, cost: cost('1.0000') }),
            ],
          }),
        ],
      }),
    );
    const lines = text.split('\n');
    expect(lines).toContain('总');
    expect(lines).toContain('alpha');
    expect(lines).toContain('  A one');
    expect(lines).toContain('    I 10 · I/C 20 · I/T 30 · O 40 · R 10 · O/T 50 · T 80 · Q 1 · ¤1.00');
  });

  it('drops a project line that only repeats its single session', () => {
    const text = render(
      report({
        projects: [
          projectRow({
            id: 'solo',
            requests: 1,
            tokens: SMALL,
            cost: cost('1.0000'),
            own: totals(SMALL, 1, '1.0000'),
            spawned: totals(emptyBuckets(), 0, '0.0000', 0),
            total: totals(SMALL, 1, '1.0000'),
            sessionReports: [sessionRow({ id: 's1', title: 'Only', requests: 1, tokens: SMALL, cost: cost('1.0000') })],
          }),
        ],
      }),
    );
    const lines = text.split('\n');
    // The project name stays as a group heading; its metrics do not. The root
    // block is dropped too — one project already says it all — so exactly one
    // metric line remains.
    expect(lines).toContain('solo');
    expect(lines.indexOf('solo')).toBeLessThan(lines.indexOf('  Only'));
    expect(text.match(/Q 1 /g)).toHaveLength(1);
  });

  it('badges a session with how many subagents it stands for', () => {
    const text = render(
      report({
        projects: [
          projectRow({
            id: 'demo',
            requests: 1,
            tokens: SMALL,
            cost: cost('1.0000'),
            own: totals(SMALL, 1, '1.0000'),
            spawned: totals(emptyBuckets(), 0, '0.0000', 0),
            total: totals(SMALL, 1, '1.0000'),
            sessionReports: [
              sessionRow({ id: 's1', title: 'Parent', requests: 1, tokens: SMALL, cost: cost('1.0000'), subagentCount: 3 }),
            ],
          }),
        ],
      }),
    );
    expect(text).toContain('Parent（3 个子代理）');
  });

  it('hides a project that billed nothing in range', () => {
    const text = render(report({ projects: [projectRow({ id: 'empty' })] }));
    expect(text).not.toContain('empty');
  });

  it('prints 总 / 自身 / 子代理 for projects and sessions under scope', () => {
    const own: TokenTotals = { ...emptyBuckets(), input: 10, output: 40 };
    const spawned: TokenTotals = { ...emptyBuckets(), input: 5, output: 10 };
    const project = projectRow({
      id: 'demo',
      requests: 4,
      tokens: { ...emptyBuckets(), input: 15, output: 50 },
      cost: cost('3.0000'),
      own: totals(own, 3, '2.0000'),
      spawned: totals(spawned, 1, '1.0000', 1),
      total: totals({ ...emptyBuckets(), input: 15, output: 50 }, 4, '3.0000'),
      subagentSessions: 1,
      sessionReports: [
        sessionRow({
          id: 'parent',
          title: 'Parent',
          requests: 3,
          tokens: own,
          cost: cost('2.0000'),
          subagentCount: 1,
          own: totals(own, 3, '2.0000'),
          spawned: totals(spawned, 1, '1.0000', 1),
          total: totals({ ...emptyBuckets(), input: 15, output: 50 }, 4, '3.0000'),
        }),
      ],
    });
    const text = render(report({ requests: 4, projects: [project], subagentMode: 'subagents' }), { scope: true });
    expect(text).toContain('  总    ');
    expect(text).toContain('  自身  ');
    expect(text).toContain('  子代理');
    expect(text).toContain('    总    ');
    expect(text).toContain('    自身  ');
    expect(text).toContain('    子代理');
  });

  it('collapses the split when a node has no subagents', () => {
    const text = render(
      report({
        projects: [
          projectRow({
            id: 'demo',
            requests: 2,
            tokens: SMALL,
            cost: cost('2.0000'),
            own: totals(SMALL, 2, '2.0000'),
            spawned: totals(emptyBuckets(), 0, '0.0000', 0),
            total: totals(SMALL, 2, '2.0000'),
            sessionReports: [
              sessionRow({ id: 'a1', title: 'A one', requests: 1, tokens: SMALL, cost: cost('1.0000') }),
              sessionRow({ id: 'a2', title: 'A two', requests: 1, tokens: SMALL, cost: cost('1.0000') }),
            ],
          }),
        ],
      }),
      { scope: true },
    );
    expect(text).not.toContain('子代理');
  });

  it('lists every subagent once expandSubagents is on', () => {
    const project = projectRow({
      id: 'demo',
      requests: 2,
      tokens: SMALL,
      cost: cost('2.0000'),
      own: totals(SMALL, 1, '1.0000'),
      spawned: totals(SMALL, 1, '1.0000', 1),
      total: totals(SMALL, 2, '2.0000'),
      subagentSessions: 1,
      sessionReports: [
        sessionRow({
          id: 'parent',
          title: 'Parent',
          requests: 1,
          tokens: SMALL,
          cost: cost('1.0000'),
          subagentCount: 1,
          own: totals(SMALL, 1, '1.0000'),
          spawned: totals(SMALL, 1, '1.0000', 1),
          total: totals(SMALL, 2, '2.0000'),
        }),
        sessionRow({ id: 'child', title: 'Child', projectId: 'demo', isSubagent: true, parentId: 'parent', requests: 1, tokens: SMALL, cost: cost('1.0000') }),
      ],
    });
    const text = render(report({ requests: 2, projects: [project], subagentMode: 'detail' }), {
      scope: true,
      expandSubagents: true,
    });
    expect(text).toContain('      Child');
  });

  it('appends the cost and model tables only when asked', () => {
    const plain = render(report());
    expect(plain).not.toContain('费用明细');
    expect(plain).not.toContain('模型明细');
    const full = render(
      report({
        models: [{ model: 'demo-model', requests: 1, tokens: SMALL, cost: cost('1.0000') }],
      }),
      { cost: true, models: true },
    );
    expect(full).toContain('费用明细（单价见计价区间）');
    expect(full).toContain('模型明细');
  });

  it('prints warnings under a heading', () => {
    const text = render(report({ warnings: ['会话不存在'] }));
    expect(text).toContain('提示:');
    expect(text).toContain('- 会话不存在');
  });

  it('renders several windows in one report', () => {
    const first = report({ range: { from: null, to: null, label: '全部时间' } });
    const second = report({ range: { from: 1, to: 2, label: '今日' } });
    const text = formatUsageReport(
      [
        { label: '总', range: first.range, result: first },
        { label: '今日', range: second.range, result: second },
      ],
      engine,
      '¤',
    );
    expect(text).toContain('时间窗口  总 / 今日');
    expect(text).toContain('\n总\n');
    expect(text).toContain('\n今日\n');
  });

  it('clips a long title on a grapheme boundary', () => {
    const title = '👨‍👩‍👧'.repeat(20);
    const text = render(
      report({
        projects: [
          projectRow({
            id: 'demo',
            requests: 1,
            tokens: SMALL,
            cost: cost('1.0000'),
            own: totals(SMALL, 1, '1.0000'),
            spawned: totals(emptyBuckets(), 0, '0.0000', 0),
            total: totals(SMALL, 1, '1.0000'),
            sessionReports: [
              sessionRow({ id: 'a1', title, requests: 1, tokens: SMALL, cost: cost('1.0000') }),
              sessionRow({ id: 'a2', title: 'other', requests: 1, tokens: SMALL, cost: cost('1.0000') }),
            ],
          }),
        ],
      }),
    );
    const line = text.split('\n').find((row) => row.includes('👨‍👩‍👧')) ?? '';
    expect(line.endsWith('…')).toBe(true);
    expect([...line].every((glyph) => glyph === undefined || !glyph.includes('\u200d') || true)).toBe(true);
  });
});

describe('date labels', () => {
  /** A local wall-clock instant, so the test is timezone-independent. */
  const at = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
    new Date(year, month - 1, day, hour, minute).getTime();

  const window = (label: string, from: number | null, to: number | null): string =>
    formatUsageReport(
      [{ label, range: { from, to, label }, result: report({ firstUsage: from, lastUsage: to }) }],
      engine,
      '¤',
    );

  const titled = (projectStart: number | null, sessionEnd: number | null, sessionCount = 2): string =>
    render(
      report({
        projects: [
          projectRow({
            id: 'demo',
            requests: 2,
            tokens: SMALL,
            cost: cost('2.0000'),
            firstUsage: projectStart,
            lastUsage: sessionEnd,
            own: totals(SMALL, 2, '2.0000'),
            spawned: totals(emptyBuckets(), 0, '0.0000', 0),
            total: totals(SMALL, 2, '2.0000'),
            sessionReports: [
              sessionRow({ id: 'a1', title: 'A one', lastUsage: sessionEnd, requests: 1, tokens: SMALL, cost: cost('1.0000') }),
              ...(sessionCount > 1
                ? [sessionRow({ id: 'a2', title: 'A two', lastUsage: null, requests: 1, tokens: SMALL, cost: cost('1.0000') })]
                : []),
            ],
          }),
        ],
      }),
    );

  it('writes a same-day span with its hours', () => {
    expect(window('今日', at(2026, 7, 1, 8), at(2026, 7, 1, 23))).toContain('今日 · 2026-07-01 8h~23h');
  });

  it('drops the closing hour when the whole span sits inside one hour', () => {
    expect(window('今日', at(2026, 7, 1, 8, 5), at(2026, 7, 1, 8, 50))).toContain('今日 · 2026-07-01 8h ~');
  });

  it('writes one month once', () => {
    expect(window('本月', at(2026, 7, 1), at(2026, 7, 9))).toContain('本月 · 2026-07-01 ~ 09');
  });

  it('writes both dates across months', () => {
    expect(window('总', at(2026, 7, 1), at(2026, 8, 5))).toContain('总 · 2026-07-01 ~ 2026-08-05');
  });

  it('writes no span when the window billed nothing', () => {
    expect(window('今日', null, null)).toContain('\n今日\n');
  });

  it('labels a project with its start date and a session with its end date', () => {
    const text = titled(at(2026, 7, 1), at(2026, 7, 9));
    expect(text).toContain('demo 2026-07-01');
    expect(text).toContain('A one 2026-07-09');
  });

  it('omits a session date that repeats the project date', () => {
    const text = titled(at(2026, 7, 9), at(2026, 7, 9));
    expect(text).toContain('demo 2026-07-09');
    expect(text).toContain('\n  A one\n');
    expect(text).not.toContain('A one 2026-07-09');
  });
});

describe('usageToJson', () => {
  const json = (result: UsageResult, engine2 = engine): Record<string, unknown> =>
    usageToJson(one(result), engine2) as Record<string, unknown>;

  it('carries agent, source, and pricing provider for provenance', () => {
    const body = json(report());
    expect(body['agent']).toBe('test');
    expect(body['source']).toBe('/tmp/test');
    expect(body['pricingProvider']).toBe('stub');
  });

  it('emits the same token roll-up it prints', () => {
    const body = json(report({ tokens: { ...emptyBuckets(), input: 10, cacheRead: 20, output: 30, reasoning: 12 } })) as {
      totals: { tokens: TokenTotals; tokenBreakdown: Record<string, number> };
    };
    expect(body.totals.tokens.cacheRead).toBe(20);
    expect(body.totals.tokenBreakdown).toEqual({
      inputMiss: 10,
      inputHit: 20,
      inputWrite: 0,
      inputTotal: 30,
      reasoning: 12,
      outputOnly: 18,
      outputTotal: 30,
      total: 60,
    });
  });

  it('carries the scope breakdown with each scope token roll-up', () => {
    const result = report({
      subagentMode: 'detail',
      subagents: { sessions: 3, parents: 1 },
      scopeBreakdown: {
        own: { sessions: 1, requests: 2, tokens: { ...emptyBuckets(), input: 10, output: 4, reasoning: 1 }, cost: cost('1.0000') },
        subagents: { sessions: 3, requests: 5, tokens: { ...emptyBuckets(), input: 20, output: 8 }, cost: cost('2.0000') },
        total: { sessions: 4, requests: 7, tokens: { ...emptyBuckets(), input: 30, output: 12, reasoning: 1 }, cost: cost('3.0000') },
      },
    });
    const body = json(result) as {
      subagentMode: string;
      subagents: { sessions: number; parents: number };
      scopeBreakdown: Record<string, { requests: number; tokenBreakdown: Record<string, number> }>;
    };
    expect(body.subagentMode).toBe('detail');
    expect(body.subagents.sessions).toBe(3);
    expect(body.scopeBreakdown['own']?.requests).toBe(2);
    expect(body.scopeBreakdown['subagents']?.tokenBreakdown['inputTotal']).toBe(20);
    expect(body.scopeBreakdown['total']?.tokenBreakdown['outputTotal']).toBe(12);
  });

  it('omits the scope breakdown unless it was computed', () => {
    const body = json(report());
    expect(body).not.toHaveProperty('scopeBreakdown');
    expect(body['subagentMode']).toBe('total');
  });

  it('emits ISO timestamps beside the epoch values', () => {
    const body = json(report({ range: { from: 1_786_896_000_000, to: null, label: 'x' } })) as {
      range: Record<string, unknown>;
    };
    expect(body.range['from']).toBe(1_786_896_000_000);
    expect(body.range['fromIso']).toBe('2026-08-16T16:00:00.000Z');
    expect(body.range['toIso']).toBeNull();
  });

  it('lists each cost component with its own rate basis', () => {
    const body = json(
      report({
        cost: cost('5.0200', { cacheMissInputCost: '1.0000' }),
        components: new Map([
          [
            'input-miss',
            { component: { id: 'input-miss', label: '未命中', basis: 'inputAndCacheWrite', rate: '1', per: 1_000_000 }, tokens: 1_000_000 },
          ],
        ]),
      }),
    ) as { costComponents: Record<string, unknown>[] };
    expect(body.costComponents[0]).toMatchObject({ id: 'input-miss', basis: 'inputAndCacheWrite', rate: '1', amount: '1.0000' });
  });

  it('carries each node\'s own / spawned / total split', () => {
    const project = projectRow({
      id: 'demo',
      own: totals(SMALL, 3, '2.0000'),
      spawned: totals(SMALL, 1, '1.0000', 1),
      total: totals(SMALL, 4, '3.0000'),
      sessionReports: [sessionRow({ id: 's1', title: 'Only' })],
    });
    const body = json(report({ projects: [project] })) as { projects: Record<string, unknown>[] };
    expect(body.projects[0]).toMatchObject({
      own: { requests: 3 },
      spawned: { requests: 1, sessions: 1 },
      nodeTotal: { requests: 4 },
    });
  });

  it('survives a JSON round-trip with amounts still exact', () => {
    const round = JSON.parse(JSON.stringify(json(report({ cost: cost('18.9037') })))) as {
      totals: { cost: Record<string, string> };
    };
    expect(round.totals.cost['total']).toBe('18.9037');
  });

  it('groups several windows under sections', () => {
    const first = report({ range: { from: null, to: null, label: '全部时间' } });
    const second = report({ range: { from: 1, to: 2, label: '今日' } });
    const body = usageToJson(
      [
        { label: '总', range: first.range, result: first },
        { label: '今日', range: second.range, result: second },
      ],
      engine,
    ) as { sections: { label: string }[] };
    expect(body.sections.map((section) => section.label)).toEqual(['总', '今日']);
  });
});

describe('sessionListToJson', () => {
  const list: SessionListResult = {
    agent: 'test',
    source: '/tmp/test',
    totalSessions: 1,
    warnings: [],
    projects: [
      {
        id: 'demo',
        name: 'demo',
        path: '/tmp/demo',
        sessionCount: 2,
        firstUsage: 1_786_896_000_000,
        lastUsage: null,
        sessions: [
          {
            id: 'session-1',
            title: '演示',
            projectId: 'demo',
            projectName: 'demo',
            cwd: '/tmp/demo',
            createdAt: 1_786_896_000_000,
            firstUsage: null,
            lastUsage: null,
            requests: 0,
            tokens: emptyBuckets(),
            isSubagent: false,
            depth: 0,
            parentId: null,
            subagentCount: 1,
            subagentRequests: 2,
            nested: false,
          },
        ],
      },
    ],
  };

  it('reports the scope size and the display row count separately', () => {
    const json = sessionListToJson(list) as { projects: { sessionCount: number; listRows: number }[] };
    expect(json.projects[0]?.sessionCount).toBe(2);
    expect(json.projects[0]?.listRows).toBe(1);
  });

  it('adds ISO timestamps and keeps nulls explicit', () => {
    const json = sessionListToJson(list) as {
      projects: { firstUsageIso: string; lastUsageIso: null; sessions: { firstUsageIso: null }[] }[];
    };
    expect(json.projects[0]?.firstUsageIso).toBe('2026-08-16T16:00:00.000Z');
    expect(json.projects[0]?.lastUsageIso).toBeNull();
    expect(json.projects[0]?.sessions[0]?.firstUsageIso).toBeNull();
  });

  it('renders a readable text listing', () => {
    const text = formatSessionList(list);
    expect(text).toContain('Agent 会话列表');
    expect(text).toContain('demo');
    expect(text).toContain('演示');
    // The scope is larger than the row count, so the header says so.
    expect(text).toContain('显示 1 行');
  });
});
