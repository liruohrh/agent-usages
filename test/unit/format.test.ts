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
    subagentMode: 'total',
    subagents: { sessions: 0, parents: 0 },
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


/**
 * Display width in terminal cells.
 *
 * Deliberately the renderer's own measurement: a test that measures with a
 * different rule could pass while the terminal still renders ragged columns.
 */
function cells(line: string): number {
  return stringWidth(line);
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
    expect(text).toContain('费用明细');
    expect(text).toContain('命中');
    expect(text).toContain('¤0.02');
    expect(text).toContain('合计');
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
        bands: [
          {
            periodId: '2026-01-01',
            periodLabel: 'flat period',
            tier: 'off-peak',
            resolution: 'fallback-later',
            requests: 1,
            total: '1.0000',
            amounts: { 'output': '1.0000' },
            rates: { output: '20' },
            inputTokens: 0,
          },
        ],
      }),
      engine,
      '¤',
    );
    expect(text).toContain('flat period');
    expect(text).toContain('按其后第一个区间的价格计算');
  });

  it('left-aligns a pricing-band footnote instead of drifting it right', () => {
    const text = formatUsageReport(
      report({
        requests: 1,
        bands: [
          {
            periodId: '2026-01-01',
            periodLabel: 'flat period',
            tier: 'off-peak',
            resolution: 'fallback-later',
            requests: 1,
            total: '1.0000',
            amounts: { output: '1.0000' },
            rates: { output: '20' },
            inputTokens: 0,
          },
        ],
      }),
      engine,
      '¤',
    );
    // Header, separator, band row, and the period footnote: every line of the
    // block starts in column 0. The footnote used to be indented two cells, so
    // its period id read as a table row that had drifted right.
    const lines = text
      .slice(text.indexOf('计价区间:'))
      .split('\n')
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(line).toBe(line.trimStart());
    expect(lines[4]).toMatch(/^2026-01-01（.+）：flat period/);
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
    expect(text).toContain('按会话（↳ 为子代理');
    expect(text).toContain('(无标题)');
    expect(text).toContain('↳');
  });

  it('prints warnings under a heading', () => {
    expect(formatUsageReport(report({ warnings: ['没有项目匹配 "x"'] }), engine, '¤')).toContain('没有项目匹配 "x"');
  });

  it('pads a wide-character cell by cells, not by characters', () => {
    const text = formatUsageReport(
      report({ dimension: 'project', projects: [projectRow({ id: 'demo', name: '中文项目名称' })] }),
      engine,
      '¤',
    );
    const header = text.split('\n').find((line) => line.startsWith('项目') && line.includes('会话'));
    const data = text.split('\n').find((line) => line.includes('中文项目名称'));
    expect(header, 'header').toBeDefined();
    expect(data, 'data row').toBeDefined();
    // The name is 6 characters but 12 cells wide, so a character-counting pad
    // would leave every following column one cell short per wide character.
    const nameWidth = cells('中文项目名称');
    expect(nameWidth).toBe(12);
    expect(cells(data ?? '')).toBeGreaterThanOrEqual(nameWidth + 2);
    // The header pads its own label out to the same column, so the two rows
    // agree on where the next column starts.
    const gap = /^项目(\s+)/.exec(header ?? '')?.[1] ?? '';
    expect(cells(`项目${gap}`)).toBe(nameWidth + 2);
  });
});

/** One session-list row, with the fields a test does not care about defaulted. */
function row(
  id: string,
  overrides: Partial<SessionListResult['projects'][number]['sessions'][number]> = {},
): SessionListResult['projects'][number]['sessions'][number] {
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

describe('terminal width, beyond CJK', () => {
  it('fits every row into the same number of cells, whatever the script', () => {
    // Each name stresses a different width rule. A `codePoint > 0x2e80` test gets
    // a ZWJ family (one grapheme, two cells), a flag (two regional indicators),
    // a combining mark (zero extra cells) and half-width katakana (one cell each)
    // wrong, so the rows would end at different cells.
    const names = ['👨‍👩‍👧 family', '🇨🇳 flag', 'e\u0301 combining', 'ｱｲｳｴｵ katakana', '中文项目名称', 'plain'];
    const table = projectTable(names).slice(projectTable(names).indexOf('按项目:'));
    const rows = table
      .split('\n')
      .filter((line) => line.trim().length > 0 && !line.includes('─') && !line.startsWith('按项目:'));
    // Header, six projects and the totals row: every one ends at the same cell.
    // A wrong width rule leaves each script a different number of cells short,
    // and a trailing trim leaves a right-aligned last column ragged.
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((line) => cells(line))).size).toBe(1);
  });

  it('measures half-width katakana as one cell', () => {
    // ｱ is a single-cell character whose code point is above 0x2e80, so the
    // naive rule counted it as two and every following column drifted.
    expect(cells('ｱｲｳｴｵ')).toBe(5);
    const text = projectTable(['ｱｲｳｴｵ', '中文项目名称']);
    const table = text.slice(text.indexOf('按项目:'));
    const rows = table.split('\n').filter((line) => /^(ｱｲｳｴｵ|中文项目名称)/.test(line));
    expect(rows).toHaveLength(2);
    expect(cells(rows[0] ?? '')).toBe(cells(rows[1] ?? ''));
  });

  it('clips a long session title on a grapheme boundary', () => {
    // The session table clips titles to a fixed width, so this is where clipping
    // is observable. It must not split a ZWJ sequence or leave a bare joiner.
    const long = '👨‍👩‍👧'.repeat(6) + ' analysis of a very long session title';
    const sessions: SessionReport[] = [
      {
        id: 'parent',
        title: long,
        cwd: null,
        projectName: 'demo',
        projectId: 'demo',
        createdAt: null,
        firstUsage: null,
        lastUsage: null,
        isSubagent: false,
        subagentCount: 0,
        parentId: null,
        requests: 1,
        tokens: emptyBuckets(),
        cost: cost('0.0000'),
        bands: [],
        models: [],
      },
    ];
    const text = formatUsageReport(
      report({
        dimension: 'session',
        requests: 1,
        projects: [projectRow({ id: 'demo', sessionReports: sessions })],
      }),
      engine,
      '¤',
    );
    const row = text.split('\n').find((line) => line.includes('…'));
    expect(row).toBeDefined();
    // No dangling zero-width joiner before the ellipsis, and no half a cluster.
    expect(row).not.toContain('\u200d…');
    // The clipped title fits the reserved column, ellipsis included.
    const title = /^\S+\s{2}(.*?)…/.exec(row ?? '')?.[1] ?? '';
    expect(cells(`${title}…`)).toBeLessThanOrEqual(32);
    // Six family emoji are 12 cells of the 32, so the rest is text.
    expect(cells('👨‍👩‍👧'.repeat(6))).toBe(12);
  });
});

/** A project table with one row per name, for width tests. */
function projectTable(names: readonly string[]): string {
  return formatUsageReport(
    report({ dimension: 'project', projects: names.map((name) => projectRow({ id: name, name })) }),
    engine,
    '¤',
  );
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
    // The cost table always totals its components; only the project table should
    // drop the row, because there it would merely echo the one project above it.
    const projectTable = text.slice(text.indexOf('按项目:'));
    expect(projectTable.split('\n').some((line) => line.startsWith('合计'))).toBe(false);
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
    const projectTable = text.slice(text.indexOf('按项目:'));
    const lines = projectTable.split('\n').filter((line) => line.startsWith('项目') || line.startsWith('合计'));
    expect(lines).toHaveLength(2);
    // Header and totals row must agree on where each column starts: compare the
    // offset of the money column, which both rows have.
    const offsetOf = (line: string, needle: string): number => {
      const index = line.indexOf(needle);
      return index === -1 ? -1 : [...line.slice(0, index)].reduce((n, c) => n + ((c.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1), 0);
    };
    expect(offsetOf(lines[1] ?? '', '¤')).toBe(offsetOf(lines[0] ?? '', '费用'));
  });

  it('totals the request column of the session list', () => {
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
    // 5 + 3 + 2 requests. Token figures belong to `usage`, not to this listing.
    expect(line?.trimEnd().endsWith('10')).toBe(true);
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

describe('label alignment', () => {
  /** The value column of every `label  value` line, in terminal cells. */
  function valueColumns(text: string): Map<string, number> {
    const found = new Map<string, number>();
    for (const line of text.split('\n')) {
      const match = /^(\s*)(\S.*?)(\s{2,})(\S.*)$/.exec(line);
      if (match === null) continue;
      const [, indent = '', name = '', gap = '', value = ''] = match;
      found.set(value, cells(`${indent}${name}${gap}`));
      void value;
    }
    return found;
  }

  it('lines the header values up in one column', () => {
    const text = formatUsageReport(report({ dimension: 'project' }), engine, '¤', 'An Agent');
    const columns = new Set<string>();
    for (const key of ['Agent', '数据目录', '维度', '时间范围', '计价来源']) {
      // Skip the report title, which happens to begin with `Agent` too.
      const line = text.split('\n').find((row) => new RegExp(`^${key}\\s{2,}\\S`).test(row));
      expect(line, key).toBeDefined();
      const match = /^(\S.*?)(\s{2,})(\S.*)$/.exec(line ?? '');
      expect(match, key).not.toBeNull();
      columns.add(String(cells(`${match?.[1] ?? ''}${match?.[2] ?? ''}`)));
    }
    expect(columns.size).toBe(1);
  });

  it('lines the token block values up despite mixed-width parentheses', () => {
    // `输入(缓存未命中)` mixes an ASCII paren with a full-width one in the
    // sibling label `输入（…）`-style rows; padding by character count would
    // leave those rows short by one cell each.
    const tokens: TokenTotals = { ...emptyBuckets(), input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 1 };
    const text = formatUsageReport(report({ requests: 1, tokens }), engine, '¤');
    const block = text.split('\n').filter((line) => /^(请求数|输入|输出|Token 总计)/.test(line));
    expect(block).toHaveLength(9);
    const columns = new Set(
      block.map((line) => {
        const match = /^(\S.*?)(\s{2,})(\S.*)$/.exec(line);
        return String(cells(`${match?.[1] ?? ''}${match?.[2] ?? ''}`));
      }),
    );
    expect(columns.size).toBe(1);
  });

  it('reports the input-miss row as the cache-miss counter plus cache writes', () => {
    // The miss component charges `input + cacheWrite`, so the tokens printed
    // beside its amount must include the writes — otherwise the line would not
    // explain the money next to it.
    const text = formatUsageReport(
      report({
        tokens: { ...emptyBuckets(), input: 1_000, cacheWrite: 500 },
        cost: cost('1.5000', { cacheMissInputCost: '1.5000' }),
        components: new Map([
          ['input-miss', { component: { id: 'input-miss', label: '未命中', basis: 'inputAndCacheWrite', rate: '1', per: 1_000 }, tokens: 1_500 }],
        ]),
      }),
      engine,
      '¤',
    );
    expect(text).toContain('1,500');
  });
});

describe('the by-scope table', () => {
  /** A result carrying a scope breakdown. */
  function scoped(own: [string, number], subagents: [string, number]): UsageResult {
    const total = (Number(own[0]) + Number(subagents[0])).toFixed(4);
    return report({
      subagentMode: 'subagents',
      subagents: { sessions: subagents[1], parents: 1 },
      cost: cost(total),
      scopeBreakdown: {
        own: { sessions: 1, requests: own[1], tokens: { ...emptyBuckets(), input: 1_000, output: 100 }, cost: cost(own[0]) },
        subagents: {
          sessions: subagents[1],
          requests: subagents[1],
          tokens: { ...emptyBuckets(), input: 2_000, output: 200 },
          cost: cost(subagents[0]),
        },
        total: {
          sessions: 1 + subagents[1],
          requests: own[1] + subagents[1],
          tokens: { ...emptyBuckets(), input: 3_000, output: 300 },
          cost: cost(total),
        },
      },
    });
  }

  it('shows the three scopes with their share of the total', () => {
    const text = formatUsageReport(scoped(['75.0000', 3], ['25.0000', 2]), engine, '¤');
    expect(text).toContain('按范围:');
    expect(text).toContain('主会话自身');
    expect(text).toContain('全部子代理');
    expect(text).toContain('总计');
    expect(text).toContain('¤75.00');
    expect(text).toContain('¤25.00');
    expect(text).toContain('¤100.00');
    // Shares are computed from the exact amounts, not from the rounded cells.
    expect(text).toContain('75.0%');
    expect(text).toContain('25.0%');
    expect(text).toContain('100%');
  });

  it('is absent unless the query asked for it', () => {
    expect(formatUsageReport(report(), engine, '¤')).not.toContain('按范围:');
  });

  it('renders a dash instead of a share when the total is zero', () => {
    const text = formatUsageReport(scoped(['0.0000', 0], ['0.0000', 0]), engine, '¤');
    expect(text).toContain('按范围:');
    // A 0/0 share must not print NaN.
    expect(text).not.toContain('NaN');
    expect(text).toContain('—');
  });

  it('describes the mode in the scope line', () => {
    expect(formatUsageReport(report({ subagentMode: 'detail', subagents: { sessions: 2, parents: 1 } }), engine, '¤')).toContain(
      '每个子代理单独一行',
    );
    expect(formatUsageReport(report({ subagents: { sessions: 2, parents: 1 } }), engine, '¤')).toContain(
      '2 个子代理会话已并入其父会话',
    );
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
    const json = usageToJson(result, engine) as {
      subagentMode: string;
      subagents: { sessions: number; parents: number };
      scopeBreakdown: Record<string, { requests: number; tokenBreakdown: Record<string, number> }>;
    };
    expect(json.subagentMode).toBe('detail');
    expect(json.subagents.sessions).toBe(3);
    expect(json.scopeBreakdown['own']?.requests).toBe(2);
    expect(json.scopeBreakdown['subagents']?.tokenBreakdown['inputTotal']).toBe(20);
    expect(json.scopeBreakdown['total']?.tokenBreakdown['outputTotal']).toBe(12);
  });

  it('omits the scope breakdown unless it was computed', () => {
    const json = usageToJson(report(), engine) as Record<string, unknown>;
    expect(json).not.toHaveProperty('scopeBreakdown');
    expect(json['subagentMode']).toBe('total');
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
