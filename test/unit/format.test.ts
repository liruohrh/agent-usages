/**
 * Presentation tests: the text tables and the JSON payload.
 *
 * The table renderer has two jobs that are easy to break silently — aligning
 * columns when titles contain wide characters, and reconciling a totals row with
 * the report it belongs to — so both are pinned here.
 */

import { describe, expect, it } from 'vitest';

import { emptyBuckets } from '../../src/core/buckets.ts';
import type { CostTotals, TokenTotals } from '../../src/core/types.ts';
import { createPricingEngine } from '../../src/pricing/index.ts';
import { formatSessionList, formatUsageReport, sessionListToJson, usageToJson } from '../../src/format.ts';
import type { ProjectReport, SessionListResult, SessionReport, UsageResult } from '../../src/report.ts';
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
    subagents: {
      split: false,
      rows: 0,
      parents: 0,
      requests: 0,
      tokens: emptyBuckets(),
      cost: cost('0.0000'),
    },
    requests: 0,
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

/** Display width in terminal cells, counting wide characters as two. */
function cells(line: string): number {
  return [...line].reduce((total, character) => total + ((character.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1), 0);
}

describe('formatUsageReport', () => {
  it('renders the header naming the agent, source, and pricing provider', () => {
    const text = formatUsageReport(report({ dimension: 'project', range: { from: null, to: null, label: '本月' } }), engine, '¤', 'Stub Agent');
    expect(text).toContain('Agent 用量统计');
    expect(text).toContain('test（Stub Agent）');
    expect(text).toContain('数据目录  /tmp/test');
    expect(text).toContain('维度      按项目');
    expect(text).toContain('时间范围  本月');
    expect(text).toContain('计价来源  Stub Vendor');
  });

  it('reports input, reasoning, output, and totals as separate lines', () => {
    const tokens: TokenTotals = {
      ...emptyBuckets(),
      input: 1_000,
      cacheRead: 130_399_872,
      output: 1_000_000,
      reasoning: 250_000,
    };
    const text = formatUsageReport(report({ requests: 3, tokens }), engine, '¤');
    expect(text).toContain('输入(缓存未命中)    1,000');
    expect(text).toContain('输入(缓存命中)      130,399,872');
    // The input total adds the disjoint prompt buckets.
    expect(text).toContain('输入合计            130,400,872');
    // Reasoning and the rest of the completion are shown apart...
    expect(text).toContain('输出(思考)          250,000');
    expect(text).toContain('输出(非思考)        750,000');
    // ...and the output total is the provider's own completion count, so
    // reasoning appears in it exactly once.
    expect(text).toContain('输出合计            1,000,000');
    expect(text).toContain('Token 总计          131,400,872');
  });

  it('hides the cache-write line when the provider never writes', () => {
    const none = formatUsageReport(report({ tokens: { ...emptyBuckets(), input: 1 } }), engine, '¤');
    expect(none).not.toContain('输入(缓存写入)');
    const some = formatUsageReport(report({ tokens: { ...emptyBuckets(), input: 1, cacheWrite: 5 } }), engine, '¤');
    expect(some).toContain('输入(缓存写入)      5');
    expect(some).toContain('输入合计            6');
  });

  it('lists the components the pricing provider charged', () => {
    const text = formatUsageReport(
      report({
        requests: 1,
        cost: cost('5.0200', { cacheHitInputCost: '0.0200', cacheMissInputCost: '1.0000', outputCost: '4.0000' }),
        components: new Map([
          ['input-hit', { component: { id: 'input-hit', label: '命中', basis: 'cacheRead', rate: '0.02', per: 1_000_000 }, tokens: 1_000_000 }],
          ['input-miss', { component: { id: 'input-miss', label: '未命中', basis: 'input', rate: '1', per: 1_000_000 }, tokens: 1_000_000 }],
        ]),
      }),
      engine,
      '¤',
    );
    expect(text).toContain('费用明细:');
    expect(text).toContain('命中');
    expect(text).toContain('¤0.02');
    expect(text).toContain('费用合计');
    expect(text).toContain('¤5.02');
  });

  it('notes the conversion only when a rate is applied', () => {
    expect(formatUsageReport(report(), engine, '¤')).not.toContain('折算为');
    const converted = formatUsageReport(report({ currency: 'USD', currencyRate: 0.14, cost: cost('1.0000') }), engine, '$');
    expect(converted).toContain('折算为 USD');
  });

  it('explains a pricing fallback instead of hiding it', () => {
    const text = formatUsageReport(
      report({
        requests: 1,
        bands: [{ periodId: '2026-01-01', periodLabel: 'flat period', tier: 'off-peak', resolution: 'fallback-later', requests: 1, total: '1.0000' }],
      }),
      engine,
      '¤',
    );
    expect(text).toContain('flat period');
    expect(text).toContain('按其后第一个区间的价格计算');
  });

  it('lists projects only in the project and session dimensions', () => {
    const projects = [projectRow({ id: 'demo' })];
    expect(formatUsageReport(report({ dimension: 'all', projects }), engine, '¤')).not.toContain('按项目:');
    expect(formatUsageReport(report({ dimension: 'project', projects }), engine, '¤')).toContain('按项目:');
  });

  it('renders session rows with subagent rows marked and indented', () => {
    const sessions: SessionReport[] = [
      {
        id: 'parent',
        title: null,
        cwd: null,
        projectName: 'demo',
        projectId: 'demo',
        createdAt: null,
        firstUsage: null,
        lastUsage: null,
        isSubagent: false,
        subagentCount: 2,
        parentId: null,
        requests: 1,
        tokens: emptyBuckets(),
        cost: cost('0.0000'),
        bands: [],
        models: [],
      },
      {
        id: 'child',
        title: '子代理',
        cwd: null,
        projectName: 'demo',
        projectId: 'demo',
        createdAt: null,
        firstUsage: null,
        lastUsage: null,
        isSubagent: true,
        subagentCount: 0,
        parentId: 'parent',
        requests: 1,
        tokens: emptyBuckets(),
        cost: cost('0.0000'),
        bands: [],
        models: [],
      },
    ];
    const text = formatUsageReport(
      report({ dimension: 'session', projects: [projectRow({ id: 'demo', sessionReports: sessions })] }),
      engine,
      '¤',
    );
    expect(text).toContain('按会话（↳ 为子代理）:');
    expect(text).toContain('(无标题)');
    expect(text).toContain('↳');
  });

  it('prints warnings under a heading', () => {
    expect(formatUsageReport(report({ warnings: ['没有项目匹配 "x"'] }), engine, '¤')).toContain('没有项目匹配 "x"');
  });

  it('keeps wide characters from shearing the columns', () => {
    const text = formatUsageReport(
      report({ dimension: 'project', projects: [projectRow({ id: 'demo', name: '中文项目名称' })] }),
      engine,
      '¤',
    );
    const header = text.split('\n').find((line) => line.startsWith('项目 '));
    const data = text.split('\n').find((line) => line.includes('中文项目名称'));
    expect(header).toBeDefined();
    expect(data).toBeDefined();
    // 中文项目名称 is 6 characters but 12 cells, so compare in cells.
    expect(cells((data ?? '').slice(0, (data ?? '').indexOf('/tmp/demo')))).toBe(
      cells((header ?? '').slice(0, (header ?? '').indexOf('路径'))),
    );
  });
});

/** One session-list row, with the fields a test does not care about defaulted. */
function row(id: string, overrides: Partial<SessionListResult['projects'][number]['sessions'][number]> = {}): SessionListResult['projects'][number]['sessions'][number] {
  return {
    id,
    title: null,
    projectId: 'demo',
    projectName: 'demo',
    cwd: null,
    createdAt: null,
    firstUsage: 1,
    lastUsage: 2,
    requests: 0,
    tokens: emptyBuckets(),
    isSubagent: false,
    depth: 0,
    parentId: null,
    subagentCount: 0,
    subagentRequests: 0,
    nested: false,
    ...overrides,
  };
}

describe('table totals rows', () => {
  /** A report whose project rows carry the given costs. */
  function withProjects(entries: { id: string; cost: string; requests: number }[]): UsageResult {
    const total = entries.reduce((sum, entry) => sum + Number(entry.cost), 0).toFixed(4);
    return report({
      dimension: 'project',
      requests: entries.reduce((sum, entry) => sum + entry.requests, 0),
      cost: cost(total),
      projects: entries.map((entry) => projectRow({ id: entry.id, cost: cost(entry.cost), requests: entry.requests })),
    });
  }

  it('adds a totals row when a table has several rows', () => {
    const line = formatUsageReport(
      withProjects([{ id: 'a', cost: '1.0000', requests: 2 }, { id: 'b', cost: '2.5000', requests: 3 }]),
      engine,
      '¤',
    )
      .split('\n')
      .find((row) => row.startsWith('合计'));
    expect(line).toBeDefined();
    expect(line).toContain('¤3.50');
    expect(line).toContain('5');
  });

  it('omits the totals row when it would only repeat the single row above it', () => {
    const text = formatUsageReport(withProjects([{ id: 'only', cost: '4.0000', requests: 7 }]), engine, '¤');
    expect(text.split('\n').some((line) => line.startsWith('合计'))).toBe(false);
  });

  it('takes the totals row from the report, not from summing the rows', () => {
    // The rows deliberately do not add up to the report's own total: the totals
    // row must show the report, which is the number a reader is checking.
    const result = withProjects([{ id: 'a', cost: '1.0000', requests: 1 }, { id: 'b', cost: '1.0000', requests: 1 }]);
    result.cost = cost('99.0000');
    const line = formatUsageReport(result, engine, '¤').split('\n').find((row) => row.startsWith('合计'));
    expect(line).toContain('¤99.00');
  });

  it('keeps columns aligned through a wide totals row', () => {
    const text = formatUsageReport(
      withProjects([{ id: 'a', cost: '1.0000', requests: 1 }, { id: 'b', cost: '1234567.8900', requests: 999_999 }]),
      engine,
      '¤',
    );
    const lines = text.split('\n').filter((line) => line.startsWith('项目') || line.startsWith('合计'));
    expect(lines).toHaveLength(2);
    expect(cells(lines[1] ?? '')).toBe(cells(lines[0] ?? ''));
  });

  it('totals the session list over the rows it displays', () => {
    const list: SessionListResult = {
      agent: 'test',
      source: '/tmp/test',
      totalSessions: 3,
      warnings: [],
      projects: [
        {
          id: 'demo',
          name: 'demo',
          path: '/tmp/demo',
          sessionCount: 3,
          firstUsage: 1,
          lastUsage: 4,
          sessions: [
            row('parent', { requests: 5, tokens: { ...emptyBuckets(), cacheRead: 1_000, output: 100 }, subagentCount: 2 }),
            row('child-a', {
              requests: 3,
              tokens: { ...emptyBuckets(), cacheRead: 600, output: 60 },
              isSubagent: true,
              parentId: 'parent',
              nested: true,
            }),
            row('child-b', {
              requests: 2,
              tokens: { ...emptyBuckets(), cacheRead: 400, output: 40 },
              isSubagent: true,
              parentId: 'parent',
              nested: true,
            }),
          ],
        },
      ],
    };
    const text = formatSessionList(list);
    const line = text.split('\n').find((entry) => entry.startsWith('合计'));
    expect(line).toBeDefined();
    // 5 + 3 + 2 requests, and the input column excludes the output column.
    expect(line).toContain('10');
    expect(line).toContain('2.0K');
    expect(line).toContain('200');
  });

  it('shows no totals row when the project has a single row', () => {
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
          sessionCount: 3,
          firstUsage: 1,
          lastUsage: 2,
          sessions: [row('parent', { requests: 5, subagentCount: 2 })],
        },
      ],
    };
    expect(formatSessionList(list).split('\n').some((line) => line.startsWith('合计'))).toBe(false);
  });
});

describe('usageToJson', () => {
  it('carries agent, source, and pricing provider for provenance', () => {
    const json = usageToJson(report(), engine) as Record<string, unknown>;
    expect(json['agent']).toBe('test');
    expect(json['source']).toBe('/tmp/test');
    expect(json['pricingProvider']).toBe('stub');
  });

  it('emits the same token roll-up it prints', () => {
    const json = usageToJson(
      report({ tokens: { ...emptyBuckets(), input: 10, cacheRead: 20, output: 30, reasoning: 12 } }),
      engine,
    ) as { totals: { tokens: TokenTotals; tokenBreakdown: Record<string, number> } };
    expect(json.totals.tokens.cacheRead).toBe(20);
    expect(json.totals.tokenBreakdown).toEqual({
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

  it('emits ISO timestamps beside the epoch values', () => {
    const json = usageToJson(report({ range: { from: 1_786_896_000_000, to: null, label: 'x' } }), engine) as {
      range: Record<string, unknown>;
    };
    expect(json.range['from']).toBe(1_786_896_000_000);
    expect(json.range['fromIso']).toBe('2026-08-16T16:00:00.000Z');
    expect(json.range['toIso']).toBeNull();
  });

  it('lists each cost component with its own rate basis', () => {
    const json = usageToJson(
      report({
        cost: cost('5.0200', { cacheMissInputCost: '1.0000' }),
        components: new Map([
          [
            'input-miss',
            { component: { id: 'input-miss', label: '未命中', basis: 'inputAndCacheWrite', rate: '1', per: 1_000_000 }, tokens: 1_000_000 },
          ],
        ]),
      }),
      engine,
    ) as { costComponents: Record<string, unknown>[] };
    expect(json.costComponents[0]).toMatchObject({ id: 'input-miss', basis: 'inputAndCacheWrite', rate: '1', amount: '1.0000' });
  });

  it('omits sessionReports unless the dimension produced them', () => {
    const json = usageToJson(report({ projects: [projectRow({ id: 'demo' })] }), engine) as {
      projects: Record<string, unknown>[];
    };
    expect(json.projects[0]).not.toHaveProperty('sessionReports');
  });

  it('survives a JSON round-trip with amounts still exact', () => {
    const json = JSON.parse(JSON.stringify(usageToJson(report({ cost: cost('18.9037') }), engine))) as {
      totals: { cost: Record<string, string> };
    };
    expect(json.totals.cost['total']).toBe('18.9037');
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
