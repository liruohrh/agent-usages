/**
 * HTML report tests.
 *
 * The document is the only output that leaves the terminal, so what is pinned
 * here is what a terminal never has to worry about: it must start as a document,
 * escape everything it echoes, carry no script and no external resource, and
 * still print the same figures the text report prints.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { emptyBuckets } from '../../src/core/buckets.ts';
import type { CostTotals, TokenTotals } from '../../src/core/types.ts';
import { renderHtmlReport, type HtmlOptions } from '../../src/html.ts';
import { UserError } from '../../src/i18n/errors.ts';
import { DEFAULT_LANGUAGE, setLanguage } from '../../src/i18n/index.ts';
import type { ProjectReport, RateInfo, ScopeTotals, SessionReport, UsageResult } from '../../src/report.ts';
import type { ReportSection } from '../../src/format.ts';

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE);
});

/** Rate provenance every fixture carries, priced 1:1. */
const RATE_INFO: RateInfo = {
  base: 'CNY',
  display: 'CNY',
  rate: '1',
  mode: 'latest' as const,
  reason: 'fallback-base' as const,
  source: 'test',
  date: '2026-09-21',
};

/** A cost total with the fields a test does not set left at zero. */
function cost(total: string, overrides: Partial<CostTotals> = {}): CostTotals {
  return {
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheHitInputCost: '0.0000',
    cacheMissInputCost: total,
    outputCost: '0.0000',
    cacheWriteInputCost: '0.0000',
    reasoningCost: '0.0000',
    total,
    ...overrides,
  };
}

/** One node's totals: the shape every report node carries. */
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
    archived: false,
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

/** A project row for the report fixtures. */
function projectRow(overrides: Partial<ProjectReport> & { id: string }): ProjectReport {
  const tokens = overrides.tokens ?? emptyBuckets();
  const requests = overrides.requests ?? 0;
  const total = overrides.cost?.total ?? '0.0000';
  return {
    name: overrides.id,
    path: `/tmp/${overrides.id}`,
    sessions: 1,
    activeSessions: 1,
    subagentSessions: 0,
    requests,
    firstUsage: null,
    lastUsage: null,
    tokens,
    cost: cost(total),
    own: totals(tokens, requests, total),
    spawned: totals(emptyBuckets(), 0, '0.0000', 0),
    total: totals(tokens, requests, total),
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
    dimension: 'session',
    range: { from: null, to: null, label: '全部时间' },
    currency: 'CNY',
    currencyRate: 1,
    rateInfo: RATE_INFO,
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
    models: [],
    projects: [],
    repos: [],
    warnings: [],
    ...overrides,
  };
}

/** Wrap one result as the single window a report prints. */
function one(result: UsageResult, label = '总'): ReportSection[] {
  return [{ label, range: result.range, result }];
}

/** Render a report, defaulting to the plain tree. */
function render(result: UsageResult, options: HtmlOptions = {}): string {
  return renderHtmlReport(one(result), { symbol: '¥', ...options });
}

/** A tiny token set whose figures stay below `compact`'s rounding. */
const SMALL: TokenTotals = { input: 10, cacheRead: 20, cacheWrite: 0, output: 50, reasoning: 10 };

/** One project with one session, priced at `total`. */
function pricedProject(id: string, total: string, tokens: TokenTotals = SMALL): ProjectReport {
  return projectRow({
    id,
    name: id,
    requests: 3,
    tokens,
    cost: cost(total),
    firstUsage: Date.parse('2026-07-01T00:00:00Z'),
    lastUsage: Date.parse('2026-07-09T00:00:00Z'),
    sessionReports: [sessionRow({ id: `${id}-s`, title: `${id} session`, requests: 3, tokens, cost: cost(total) })],
  });
}

describe('renderHtmlReport', () => {
  it('starts as a document and carries its stylesheet inline', () => {
    const html = render(report());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<style>');
    expect(html).toContain('</html>');
  });

  it('names the agent, its data root, the range, and the pricing source', () => {
    const html = render(report(), { agentLabel: 'Stub Agent', pricingLabel: 'Stub Vendor' });
    expect(html).toContain('Agent 用量统计');
    expect(html).toContain('test（Stub Agent）');
    expect(html).toContain('/tmp/test');
    expect(html).toContain('全部时间');
    expect(html).toContain('Stub Vendor（CNY）');
  });

  it('prints the headline total, the project, and its sessions', () => {
    const html = render(
      report({
        requests: 3,
        tokens: SMALL,
        cost: cost('15.1668'),
        projects: [pricedProject('demo', '15.1668')],
      }),
    );
    expect(html).toContain('¥15.1668');
    expect(html).toContain('demo');
    expect(html).toContain('demo session');
    // The five billed buckets, the token total, the request count, and the money.
    for (const label of ['I/M', 'I/C', 'I/W', 'O', 'R']) expect(html).toContain(`>${label}<`);
    expect(html).toContain('>80<');
    expect(html).toContain('>3<');
  });

  it('carries no script and no external resource', () => {
    const html = render(
      report({
        requests: 3,
        tokens: SMALL,
        cost: cost('1.0000'),
        projects: [pricedProject('demo', '1.0000')],
      }),
    );
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<link\b|src=|@import|url\(|https?:\/\//);
  });

  it('escapes markup and ampersands in titles and names', () => {
    const html = render(
      report({
        requests: 1,
        tokens: SMALL,
        cost: cost('1.0000'),
        projects: [
          projectRow({
            id: 'p',
            name: 'p<1> & co',
            requests: 1,
            tokens: SMALL,
            cost: cost('1.0000'),
            sessionReports: [
              sessionRow({ id: 's', title: 'A <b> & "c" \'d\'', requests: 1, tokens: SMALL, cost: cost('1.0000') }),
            ],
          }),
        ],
      }),
    );
    expect(html).toContain('p&lt;1&gt; &amp; co');
    expect(html).toContain('A &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39;');
    expect(html).not.toContain('<b>');
    // Escaped once, not twice: a double escape would print `&amp;lt;` to a reader.
    expect(html).not.toContain('&amp;lt;');
  });

  it('draws one inline SVG bar per project, scaled to the largest total', () => {
    const html = render(
      report({
        requests: 6,
        cost: cost('3.0000'),
        projects: [
          pricedProject('big', '2.0000', { ...emptyBuckets(), input: 100 }),
          pricedProject('small', '1.0000', { ...emptyBuckets(), input: 50 }),
        ],
      }),
    );
    expect(html).toContain('<svg');
    expect(html).toContain('<rect');
    // Normalized to the largest total: the leader is a full bar, the follower half.
    expect(html).toContain('width="100"');
    expect(html).toContain('width="100.00"');
    expect(html).toContain('width="50.00"');
  });

  it('keeps a visible bar for a project that billed little', () => {
    const html = render(
      report({
        requests: 2,
        cost: cost('2.0000'),
        projects: [
          pricedProject('big', '2.0000', { ...emptyBuckets(), input: 1_000_000 }),
          pricedProject('tiny', '0.0001', { ...emptyBuckets(), input: 1 }),
        ],
      }),
    );
    expect(html).toContain('width="1.00"');
  });

  it('renders several windows in one document', () => {
    const first = report({ range: { from: null, to: null, label: '全部时间' } });
    const second = report({ range: { from: 1, to: 2, label: '今日' } });
    const html = renderHtmlReport(
      [
        { label: '总', range: first.range, result: first },
        { label: '今日', range: second.range, result: second },
      ],
      { symbol: '¥' },
    );
    expect(html).toContain('<dt>时间窗口</dt><dd>总 / 今日</dd>');
    expect(html).toContain('<h2>总</h2>');
    expect(html).toContain('<h2>今日</h2>');
  });

  it('writes the window as a span when the data has one', () => {
    // Local wall-clock instants, so the test does not depend on the machine's zone.
    const at = (hour: number): number => new Date(2026, 6, 1, hour).getTime();
    const html = render(report({ firstUsage: at(8), lastUsage: at(23) }));
    expect(html).toMatch(/<h2>总 · 2026-07-01 8h~23h<\/h2>/);
  });

  it('splits a session into 自身 / 子代理 only when asked', () => {
    const spawned: TokenTotals = { ...emptyBuckets(), input: 5, output: 10 };
    const session = sessionRow({
      id: 'parent',
      title: 'Parent',
      requests: 3,
      tokens: SMALL,
      cost: cost('2.0000'),
      subagentCount: 1,
      own: totals(SMALL, 3, '2.0000'),
      spawned: totals(spawned, 1, '1.0000', 1),
      total: totals({ ...emptyBuckets(), input: 15, output: 60 }, 4, '3.0000'),
    });
    const project = projectRow({ id: 'demo', requests: 4, sessionReports: [session] });
    const plain = render(report({ requests: 4, projects: [project] }));
    expect(plain).not.toContain('自身');
    const split = render(report({ requests: 4, projects: [project] }), { scope: true });
    expect(split).toContain('>自身</td>');
    expect(split).toContain('>子代理</td>');
    expect(split).toContain('>总</span>');
  });

  it('keeps a subagent under the session that spawned it', () => {
    // The report orders rows by recency; the `↳` marker only means something if
    // the row above it is the parent, so the renderer has to re-order them.
    const rows = [
      sessionRow({
        id: 'child',
        title: 'Child session',
        isSubagent: true,
        parentId: 'parent',
        requests: 1,
        tokens: SMALL,
        cost: cost('1.0000'),
      }),
      sessionRow({ id: 'parent', title: 'Parent session', requests: 1, tokens: SMALL, cost: cost('1.0000') }),
    ];
    const html = render(report({ requests: 2, projects: [projectRow({ id: 'demo', sessionReports: rows })] }));
    expect(html).toContain('<span class="nested">↳</span>');
    expect(html.indexOf('Parent session')).toBeLessThan(html.indexOf('Child session'));
  });

  it('lists the per-model split only when a node used more than one model', () => {
    const models = [
      { model: 'demo-model', requests: 1, tokens: SMALL, cost: cost('1.0000') },
      { model: 'other-model', requests: 2, tokens: SMALL, cost: cost('2.0000') },
    ];
    const multi = render(report({ requests: 3, models, projects: [projectRow({ id: 'demo', models })] }));
    expect(multi).toContain('各模型明细');
    expect(multi).toContain('demo-model');
    expect(multi).toContain('other-model');
    const single = render(report({ models: [models[0]!] }));
    expect(single).not.toContain('各模型明细');
  });

  it('folds the pricing bands, with each band and its rate card', () => {
    const band = {
      model: 'demo-model',
      periodId: '2026-08-16',
      periodLabel: '正式版',
      window: '2026-08-16 00:00 → 至今',
      tier: 'flat' as const,
      resolution: 'exact' as const,
      requests: 3,
      tokens: SMALL,
      cost: cost('1.0000'),
      components: [{ id: 'input-miss', label: '未命中', rate: '1', per: 1_000_000, tokens: 10, amount: '1.0000' }],
    };
    const html = render(report({ requests: 3, tokens: SMALL, cost: cost('1.0000'), bands: [band] }));
    expect(html).toContain('<details');
    expect(html).toContain('计价区间');
    expect(html).toContain('2026-08-16 统一价格 · demo-model');
    expect(html).toContain('未命中 1');
    expect(html).toContain('¥1.00');
  });

  it('shows the warnings the report collected', () => {
    const html = render(report({ warnings: [new UserError('sessionNotFound', { selector: '演示' })] }));
    expect(html).toContain('提示');
    expect(html).toContain('找不到会话 &quot;演示&quot;');
  });

  it('hides a project that billed nothing in range', () => {
    const html = render(report({ projects: [projectRow({ id: 'empty' })] }));
    expect(html).not.toContain('empty');
  });

  it('speaks the active language and declares it', () => {
    expect(render(report())).toContain('<html lang="zh">');
    setLanguage('en');
    const html = render(report());
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Agent usage');
    expect(html).toContain('Data dir');
  });
});
