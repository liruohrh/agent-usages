import { describe, expect, it } from 'vitest';

import { formatSessionList, formatUsageReport, sessionListToJson, usageToJson } from '../src/format.ts';
import { PricingEngine } from '../src/pricing.ts';
import type { SessionListResult, UsageResult } from '../src/report.ts';
import { emptyBuckets } from '../src/loader.ts';

const engine = new PricingEngine();

/** A zero-cost report, so each test can set only what it asserts. */
function report(overrides: Partial<UsageResult> = {}): UsageResult {
  return {
    dimension: 'all',
    range: { from: null, to: null, label: '全部时间' },
    currency: 'CNY',
    currencyRate: 1,
    requests: 0,
    tokens: emptyBuckets(),
    cost: {
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheHitInputCost: '0.0000',
      cacheMissInputCost: '0.0000',
      outputCost: '0.0000',
      total: '0.0000',
    },
    bands: [],
    models: [],
    projects: [],
    warnings: [],
    subagents: {
      split: false,
      rows: 0,
      parents: 0,
      tokens: emptyBuckets(),
      cost: {
        cacheHitInputTokens: 0,
        cacheMissInputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheHitInputCost: '0.0000',
        cacheMissInputCost: '0.0000',
        outputCost: '0.0000',
        total: '0.0000',
      },
      requests: 0,
    },
    ...overrides,
  };
}

describe('formatUsageReport', () => {
  it('renders the header with dimension, range, and currency', () => {
    const text = formatUsageReport(report({ dimension: 'project', range: { from: null, to: null, label: '本月' } }), engine);
    expect(text).toContain('DSH Token 用量统计');
    expect(text).toContain('维度      按项目');
    expect(text).toContain('时间范围  本月');
    expect(text).toContain('计价货币  CNY');
  });

  it('notes the conversion when a rate is applied', () => {
    const text = formatUsageReport(report({ currency: 'USD', currencyRate: 0.14 }), engine);
    expect(text).toContain('1 CNY = 0.14 USD');
    expect(text).toContain('折算');
  });

  it('renders amounts with the currency symbol and two decimals', () => {
    const text = formatUsageReport(
      report({
        requests: 1,
        cost: {
          cacheHitInputTokens: 0,
          cacheMissInputTokens: 1_000_000,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheHitInputCost: '0.0000',
          cacheMissInputCost: '1.0000',
          outputCost: '0.0000',
          total: '1.0000',
        },
      }),
      engine,
    );
    expect(text).toContain('¥1.00');
  });

  it('groups thousands in token counts', () => {
    const tokens = { ...emptyBuckets(), cacheRead: 130_399_872 };
    const text = formatUsageReport(report({ tokens }), engine);
    expect(text).toContain('130,399,872');
  });

  it('reports reasoning tokens as contained in output, not additive', () => {
    const tokens = { ...emptyBuckets(), output: 1_000_000, reasoning: 250_000 };
    const text = formatUsageReport(report({ tokens }), engine);
    expect(text).toContain('含推理 250,000');
    // The grand total counts output once, never output + reasoning.
    expect(text).toContain('Token 总计     1,000,000');
  });

  it('describes the pricing band with the window of the period it names', () => {
    const text = formatUsageReport(
      report({
        requests: 5,
        bands: [
          {
            periodId: '2026-08-17',
            periodLabel: 'V4-Flash（正式版）峰谷定价',
            band: 'peak',
            resolution: 'exact',
            requests: 5,
          },
        ],
      }),
      engine,
    );
    expect(text).toContain('高峰时段：5 次请求');
    // The named period's own window, not some other period's.
    expect(text).toContain('2026-08-17 00:00 → 2026-08-23 00:00');
  });

  it('explains a fallback rather than hiding it', () => {
    const text = formatUsageReport(
      report({
        requests: 1,
        bands: [
          { periodId: '2026-08-17', periodLabel: 'V4-Flash（正式版）峰谷定价', band: 'off-peak', resolution: 'fallback-later', requests: 1 },
        ],
      }),
      engine,
    );
    expect(text).toContain('按其后第一个区间的价格计算');
  });

  it('lists projects only in the project and session dimensions', () => {
    const project = {
      workspaceId: 'w1',
      name: 'demo',
      path: '/home/user/demo',
      sessions: 2,
      activeSessions: 1,
      subagentSessions: 0,
      requests: 3,
      firstUsage: null,
      lastUsage: null,
      tokens: emptyBuckets(),
      cost: {
        cacheHitInputTokens: 0,
        cacheMissInputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheHitInputCost: '0.0000',
        cacheMissInputCost: '0.0000',
        outputCost: '0.0000',
        total: '0.0000',
      },
      bands: [],
      models: [],
    };
    expect(formatUsageReport(report({ dimension: 'all', projects: [project] }), engine)).not.toContain('按项目:');
    expect(formatUsageReport(report({ dimension: 'project', projects: [project] }), engine)).toContain('按项目:');
  });

  it('renders session rows inside their project in the session dimension', () => {
    const text = formatUsageReport(
      report({
        dimension: 'session',
        requests: 2,
        projects: [
          {
            workspaceId: 'w1',
            name: 'demo',
            path: '/home/user/demo',
            sessions: 1,
            activeSessions: 1,
            subagentSessions: 0,
            requests: 2,
            firstUsage: null,
            lastUsage: null,
            tokens: emptyBuckets(),
            cost: {
              cacheHitInputTokens: 0,
              cacheMissInputTokens: 0,
              outputTokens: 0,
              cacheWriteTokens: 0,
              cacheHitInputCost: '0.0000',
              cacheMissInputCost: '0.0000',
              outputCost: '0.0000',
              total: '0.0000',
            },
            bands: [],
            models: [],
            sessionReports: [
              {
                sessionId: 'session-1',
                title: null,
                cwd: '/home/user/demo',
                projectName: 'demo',
                workspaceId: 'w1',
                createdAt: null,
                firstUsage: null,
                lastUsage: null,
                isSubagent: false,
                subagentCount: 0,
                parentSessionId: null,
                requests: 2,
                tokens: emptyBuckets(),
                cost: {
                  cacheHitInputTokens: 0,
                  cacheMissInputTokens: 0,
                  outputTokens: 0,
                  cacheWriteTokens: 0,
                  cacheHitInputCost: '0.0000',
                  cacheMissInputCost: '0.0000',
                  outputCost: '0.0000',
                  total: '0.0000',
                },
                bands: [],
                models: [],
              },
            ],
          },
        ],
      }),
      engine,
    );
    expect(text).toContain('按会话（↳ 为子代理）:');
    expect(text).toContain('(无标题)');
  });

  it('prints warnings under a heading', () => {
    const text = formatUsageReport(report({ warnings: ['没有项目匹配 "x"'] }), engine);
    expect(text).toContain('提示:');
    expect(text).toContain('没有项目匹配 "x"');
  });

  it('keeps wide characters from shearing the columns', () => {
    // A Chinese title occupies two terminal cells per character; the table must
    // pad by display width, not by code-unit count.
    const text = formatUsageReport(
      report({
        dimension: 'project',
        projects: [
          {
            workspaceId: 'w1',
            name: '中文项目名称',
            path: '/home/user/demo',
            sessions: 1,
            activeSessions: 1,
            subagentSessions: 0,
            requests: 1,
            firstUsage: null,
            lastUsage: null,
            tokens: emptyBuckets(),
            cost: {
              cacheHitInputTokens: 0,
              cacheMissInputTokens: 0,
              outputTokens: 0,
              cacheWriteTokens: 0,
              cacheHitInputCost: '0.0000',
              cacheMissInputCost: '0.0000',
              outputCost: '0.0000',
              total: '0.0000',
            },
            bands: [],
            models: [],
          },
        ],
      }),
      engine,
    );
    const header = text.split('\n').find((line) => line.startsWith('项目 '));
    const data = text.split('\n').find((line) => line.includes('中文项目名称'));
    expect(header).toBeDefined();
    expect(data).toBeDefined();
    // Compare in terminal cells: 中文项目名称 is 6 characters but 12 cells wide.
    const cells = (line: string): number =>
      [...line].reduce((total, character) => total + ((character.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1), 0);
    const headerOffset = cells((header ?? '').slice(0, (header ?? '').indexOf('路径')));
    const dataOffset = cells((data ?? '').slice(0, (data ?? '').indexOf('/home/user/demo')));
    expect(headerOffset).toBe(dataOffset);
  });
});

describe('usageToJson', () => {
  it('emits ISO timestamps beside the epoch values', () => {
    const json = usageToJson(report({ range: { from: 1_786_896_000_000, to: null, label: 'x' } })) as {
      range: Record<string, unknown>;
    };
    expect(json.range['from']).toBe(1_786_896_000_000);
    // 1786896000000 ms is Beijing 2026-08-17 00:00, which is 16:00Z the day before.
    expect(json.range['fromIso']).toBe('2026-08-16T16:00:00.000Z');
    expect(json.range['toIso']).toBeNull();
  });

  it('omits sessionReports unless the dimension produced them', () => {
    const withoutSessions = usageToJson(
      report({
        projects: [
          {
            workspaceId: 'w1',
            name: 'demo',
            path: '/d',
            sessions: 0,
            activeSessions: 0,
            subagentSessions: 0,
            requests: 0,
            firstUsage: null,
            lastUsage: null,
            tokens: emptyBuckets(),
            cost: {
              cacheHitInputTokens: 0,
              cacheMissInputTokens: 0,
              outputTokens: 0,
              cacheWriteTokens: 0,
              cacheHitInputCost: '0.0000',
              cacheMissInputCost: '0.0000',
              outputCost: '0.0000',
              total: '0.0000',
            },
            bands: [],
            models: [],
          },
        ],
      }),
    ) as { projects: Record<string, unknown>[] };
    expect(withoutSessions.projects[0]).not.toHaveProperty('sessionReports');
  });

  it('survives a JSON round-trip with costs still exact', () => {
    const json = JSON.parse(JSON.stringify(usageToJson(report({ requests: 7 })))) as {
      totals: { cost: Record<string, string> };
      totals2?: unknown;
    };
    expect(json.totals.cost['total']).toBe('0.0000');
    expect(typeof json.totals.cost['total']).toBe('string');
  });
});

describe('sessionListToJson', () => {
  const list: SessionListResult = {
    totalSessions: 1,
    warnings: [],
    projects: [
      {
        workspaceId: 'w1',
        name: 'demo',
        path: '/home/user/demo',
        firstUsage: 1_786_896_000_000,
        lastUsage: null,
        sessions: [
          {
            sessionId: 'session-1',
            title: '演示',
            workspaceId: 'w1',
            projectName: 'demo',
            cwd: '/home/user/demo',
            createdAt: 1_786_896_000_000,
            firstUsage: null,
            lastUsage: null,
            requests: 0,
            tokens: emptyBuckets(),
            isSubagent: false,
            delegationDepth: 0,
            parentSessionId: null,
            subagentCount: 0,
            subagentRequests: 0,
            nested: false,
          },
        ],
      },
    ],
  };

  it('counts both projects and sessions', () => {
    const json = sessionListToJson(list) as { totalProjects: number; totalSessions: number };
    expect(json.totalProjects).toBe(1);
    expect(json.totalSessions).toBe(1);
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
    expect(text).toContain('DSH 会话列表');
    expect(text).toContain('项目数 1');
    expect(text).toContain('demo');
    expect(text).toContain('演示');
  });
});
