/**
 * Aggregation tests.
 *
 * These drive the report layer with a synthetic dataset and the stub price list,
 * so they test *grouping* — dimensions, filters, subagent folding, and the
 * reconciliation between totals and rows — without depending on any agent's file
 * format or any vendor's rates.
 */

import { describe, expect, it } from 'vitest';

import { emptyBuckets } from '../../src/core/buckets.ts';
import { createPricingEngine } from '../../src/pricing/index.ts';
import type { RateInfo } from '../../src/report.ts';
import {
  expandWithDescendants,
  listSessions,
  resolveProjectSelectors,
  resolveSessionSelectors,
  runQuery,
  type UsageQuery,
} from '../../src/report.ts';
import { buckets, dataset, project, record, session } from '../support/dataset.ts';
import { STUB_AT, stubProvider } from '../support/stub-pricing.ts';

const engine = createPricingEngine(stubProvider());
const context = { engine, pricingProvider: engine.provider.id };

/** The rate information every query carries, priced 1:1 in the stub's currency. */
const RATE_INFO: RateInfo = {
  base: 'XTS',
  display: 'XTS',
  rate: '1',
  mode: 'latest' as const,
  reason: 'fallback-base' as const,
  source: 'test',
  date: '2026-09-21',
};

/** One million of each bucket, so 1M of every component applies. */
const FULL = buckets({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 });

const SID = { parent: 's-parent', childA: 's-child-a', childB: 's-child-b', grandchild: 's-grandchild' } as const;

/**
 * Two projects. The first has a parent session with two subagents, one of which
 * has its own child; the second has a single flat session.
 *
 * With the stub's prices: a full request on `flat-model` costs
 * 1 + 10 + 20 + 5 = 36 units, and one on `tiered-model` in its late period costs
 * 3 + 6 = 9 units. So the fixture totals 4 x 36 + 9 = 153.
 */
function fixture() {
  return dataset([
    project({
      id: 'alpha',
      name: 'alpha',
      path: '/tmp/alpha',
      sessions: [
        session({
          id: SID.parent,
          title: '父会话',
          createdAt: STUB_AT.early - 1000,
          records: [record({ id: 'p1', time: STUB_AT.early, model: 'flat-model', tokens: FULL })],
          childIds: [SID.childA, SID.childB],
        }),
        session({
          id: SID.childA,
          title: '子代理 A',
          parentId: SID.parent,
          depth: 1,
          isSubagent: true,
          parentKnown: true,
          childIds: [SID.grandchild],
          records: [record({ id: 'a1', time: STUB_AT.early, model: 'flat-model', tokens: FULL })],
        }),
        session({
          id: SID.childB,
          parentId: SID.parent,
          depth: 1,
          isSubagent: true,
          parentKnown: true,
          records: [record({ id: 'b1', time: STUB_AT.early, model: 'flat-model', tokens: FULL })],
        }),
        session({
          id: SID.grandchild,
          parentId: SID.childA,
          depth: 2,
          isSubagent: true,
          parentKnown: true,
          records: [record({ id: 'g1', time: STUB_AT.early, model: 'flat-model', tokens: FULL })],
        }),
      ],
    }),
    project({
      id: 'beta',
      name: 'beta',
      path: '/tmp/beta',
      sessions: [
        session({
          id: 's-beta',
          title: '另一个项目的标题',
          createdAt: STUB_AT.late,
          records: [record({ id: 'beta1', time: STUB_AT.late, model: 'tiered-model', tokens: FULL })],
        }),
      ],
    }),
  ]);
}

/** A query with everything unset, overridden per test. */
function query(overrides: Partial<UsageQuery> = {}): UsageQuery {
  return {
    dimension: 'all',
    range: { from: null, to: null, label: '全部时间' },
    rate: { ...RATE_INFO, base: 'XTS', display: 'XTS' },
    currency: 'XTS',
    ...overrides,
  };
}

describe('selector resolution', () => {
  it('matches projects by id, name, path, and basename', () => {
    const { projects } = fixture();
    for (const selector of ['alpha', '/tmp/alpha', 'alpha']) {
      expect([...resolveProjectSelectors(projects, [selector]).keys]).toEqual(['alpha']);
    }
    expect(resolveProjectSelectors(projects, ['nope']).errors.map((warning) => warning.message)).toEqual([
      '没有项目匹配 "nope"',
    ]);
  });

  it('glob-matches project selectors', () => {
    const { projects } = fixture();
    expect([...resolveProjectSelectors(projects, ['al*']).keys]).toEqual(['alpha']);
  });

  it('matches sessions by id and by either prefix spelling', () => {
    const { sessions } = fixture();
    const bare = session({ id: 'abc-123' });
    const collection = [bare];
    for (const selector of ['abc-123', 'session-abc-123', 'abc']) {
      const { ids, errors } = resolveSessionSelectors(collection, [selector]);
      expect(errors).toEqual([]);
      expect([...ids]).toEqual(['abc-123']);
    }
    expect(sessions.length).toBeGreaterThan(0);
  });

  it('matches a session by its exact title', () => {
    const data = fixture();
    const { ids, errors } = resolveSessionSelectors(data.sessions, ['另一个项目的标题']);
    expect(errors).toEqual([]);
    expect([...ids]).toEqual(['s-beta']);
    // The parent's title resolves to the parent; its subagents follow through
    // subtree expansion, not through the selector.
    expect([...resolveSessionSelectors(data.sessions, ['父会话']).ids]).toEqual([SID.parent]);
  });

  it('trims surrounding whitespace on both the selector and the title', () => {
    const data = fixture();
    for (const selector of ['  父会话  ', '\t父会话\n', '父会话   ']) {
      const { ids, errors } = resolveSessionSelectors(data.sessions, [selector]);
      expect(errors).toEqual([]);
      expect([...ids]).toEqual([SID.parent]);
    }
  });

  it('matches case-insensitively', () => {
    const data = dataset([project({ id: 'p', sessions: [session({ id: 's', title: 'Mixed Case Title' })] })]);
    for (const selector of ['mixed case title', 'MIXED CASE TITLE', '  Mixed Case Title  ']) {
      expect([...resolveSessionSelectors(data.sessions, [selector]).ids]).toEqual(['s']);
    }
  });

  it('does not match a mere title prefix', () => {
    // A partial id is accepted, but a partial title is not: titles are matched
    // exactly so a short selector cannot silently sweep up several sessions.
    const data = fixture();
    const { ids, errors } = resolveSessionSelectors(data.sessions, ['父会']);
    expect([...ids]).toEqual([]);
    expect(errors.map((warning) => warning.message)).toEqual(['找不到会话 "父会"']);
  });

  it('does not match a missing or blank title', () => {
    const data = dataset([
      project({ id: 'p', sessions: [session({ id: 's-none' }), session({ id: 's-space', title: '   ' })] }),
    ]);
    // A blank selector is ignored outright.
    expect([...resolveSessionSelectors(data.sessions, ['   ']).ids]).toEqual([]);
    // A whitespace-only title is treated as absent, so it cannot be selected.
    expect(resolveSessionSelectors(data.sessions, ['']).errors).toEqual([]);
    expect([...resolveSessionSelectors(data.sessions, ['s-none']).ids]).toEqual(['s-none']);
  });

  it('selects every session sharing a title', () => {
    const data = dataset([
      project({
        id: 'p',
        sessions: [session({ id: 's1', title: '同名会话' }), session({ id: 's2', title: '同名会话' }), session({ id: 's3' })],
      }),
    ]);
    expect([...resolveSessionSelectors(data.sessions, ['同名会话']).ids].sort()).toEqual(['s1', 's2']);
  });

  it('selects both an id match and a title match in one pass', () => {
    // A selector equal to one session's id and another's title must select both.
    const data = dataset([
      project({ id: 'p', sessions: [session({ id: 'shared' }), session({ id: 'other', title: 'shared' })] }),
    ]);
    expect([...resolveSessionSelectors(data.sessions, ['shared']).ids].sort()).toEqual(['other', 'shared']);
  });

  it('matches titles with a glob', () => {
    const data = dataset([
      project({ id: 'p', sessions: [session({ id: 's1', title: 'enrich chunk 1' }), session({ id: 's2', title: 'enrich chunk 2' }), session({ id: 's3', title: 'other' })] }),
    ]);
    expect([...resolveSessionSelectors(data.sessions, ['enrich*']).ids].sort()).toEqual(['s1', 's2']);
    expect([...resolveSessionSelectors(data.sessions, ['*chunk 2']).ids]).toEqual(['s2']);
  });

  it('rejects an ambiguous id prefix and names the candidates', () => {
    const collection = [session({ id: 'same-1' }), session({ id: 'same-2' })];
    const { ids, errors } = resolveSessionSelectors(collection, ['same']);
    expect([...ids]).toEqual([]);
    expect(errors[0]?.message).toMatch(/有 2 个候选/);
    // A glob is a deliberate multi-match, so it selects both without complaint.
    const glob = resolveSessionSelectors(collection, ['same-*']);
    expect(glob.errors).toEqual([]);
    expect([...glob.ids].sort()).toEqual(['same-1', 'same-2']);
  });

  it('expands a selection with every descendant', () => {
    const data = fixture();
    expect([...expandWithDescendants(data, new Set([SID.parent]))].sort()).toEqual(
      [SID.parent, SID.childA, SID.childB, SID.grandchild].sort(),
    );
    expect([...expandWithDescendants(data, new Set([SID.childA]))].sort()).toEqual([SID.childA, SID.grandchild].sort());
  });
});

describe('dimensions', () => {
  it('reports the whole dataset in the all dimension', () => {
    const result = runQuery(fixture(), query(), context);
    expect(result.requests).toBe(5);
    expect(result.cost.total).toBe('153.0000');
    expect(result.agent).toBe('test');
    expect(result.pricingProvider).toBe('stub');
  });

  it('reports every project in the project dimension', () => {
    const result = runQuery(fixture(), query({ dimension: 'project' }), context);
    expect(result.projects.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
    expect(result.projects.every((entry) => entry.sessionReports === undefined)).toBe(true);
  });

  it('nests session rows inside projects in the session dimension', () => {
    const result = runQuery(fixture(), query({ dimension: 'session' }), context);
    const alpha = result.projects.find((entry) => entry.name === 'alpha');
    expect(alpha?.sessionReports).toHaveLength(1);
    expect(alpha?.sessionReports?.[0]?.subagentCount).toBe(3);
  });
});

describe('subagent presentation modes', () => {
  it('folds descendants into the session that spawned them by default', () => {
    const result = runQuery(fixture(), query({ dimension: 'session' }), context);
    const parent = result.projects[0]?.sessionReports?.[0];
    expect(parent?.id).toBe(SID.parent);
    expect(parent?.isSubagent).toBe(false);
    expect(parent?.requests).toBe(4);
    expect(parent?.cost.total).toBe('144.0000');
    expect(result.subagentMode).toBe('total');
    expect(result.subagents.sessions).toBe(3);
    // 4 x 36 for alpha's tree, 9 for beta.
    expect(result.projects.find((entry) => entry.name === 'beta')?.cost.total).toBe('9.0000');
  });

  it('adds the by-scope breakdown without changing any row', () => {
    const plain = runQuery(fixture(), query({ dimension: 'session' }), context);
    const scoped = runQuery(fixture(), query({ dimension: 'session', subagentMode: 'subagents' }), context);
    expect(plain.scopeBreakdown).toBeUndefined();
    const breakdown = scoped.scopeBreakdown;
    expect(breakdown).toBeDefined();
    // alpha's own session (36), beta's (9), and the three subagents (36 each).
    expect(breakdown?.own.cost.total).toBe('45.0000');
    expect(breakdown?.subagents.cost.total).toBe('108.0000');
    expect(breakdown?.total.cost.total).toBe('153.0000');
    expect(breakdown?.own.sessions).toBe(2);
    expect(breakdown?.subagents.sessions).toBe(3);
    expect(breakdown?.total.sessions).toBe(5);
    // The rows themselves are untouched.
    expect(scoped.projects[0]?.sessionReports).toHaveLength(1);
  });

  it('makes own plus subagents equal the total, in every figure', () => {
    const result = runQuery(fixture(), query({ subagentMode: 'detail' }), context);
    const { own, subagents, total } = result.scopeBreakdown ?? { own: undefined, subagents: undefined, total: undefined };
    expect(own).toBeDefined();
    expect(subagents).toBeDefined();
    expect(total).toBeDefined();
    expect(own!.sessions + subagents!.sessions).toBe(total!.sessions);
    expect(own!.requests + subagents!.requests).toBe(total!.requests);
    expect(Number(own!.cost.total) + Number(subagents!.cost.total)).toBeCloseTo(Number(total!.cost.total), 6);
    for (const counter of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) {
      expect(own!.tokens[counter] + subagents!.tokens[counter]).toBe(total!.tokens[counter]);
    }
  });

  it('lists every subagent on its own row in detail mode', () => {
    const result = runQuery(fixture(), query({ dimension: 'session', subagentMode: 'detail' }), context);
    const alpha = result.projects.find((entry) => entry.name === 'alpha');
    const rows = alpha?.sessionReports ?? [];
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.isSubagent)).toHaveLength(3);
    // A row's cost describes what its line shows — the whole subtree — while
    // `own` is the session's own four requests.
    expect(rows.find((row) => row.id === SID.parent)?.cost.total).toBe('144.0000');
    expect(rows.find((row) => row.id === SID.parent)?.own.cost.total).toBe('36.0000');
    expect(rows.find((row) => row.id === SID.childA)?.cost.total).toBe('72.0000');
    expect(rows.find((row) => row.id === SID.childA)?.own.cost.total).toBe('36.0000');
    expect(alpha?.subagentSessions).toBe(3);
    expect(alpha?.sessions).toBe(4);
  });

  it('keeps the grand total identical across all three modes', () => {
    // Only the presentation changes; the same usage is being reported.
    const totals = (['total', 'subagents', 'detail'] as const).map(
      (subagentMode) => runQuery(fixture(), query({ dimension: 'session', subagentMode }), context),
    );
    for (const result of totals) {
      expect(result.cost.total).toBe('153.0000');
      expect(result.requests).toBe(5);
      expect(result.tokens.output).toBe(5_000_000);
    }
  });

  it('keeps a named session subtree in scope in every mode', () => {
    for (const subagentMode of ['total', 'subagents', 'detail'] as const) {
      const result = runQuery(fixture(), query({ sessions: [SID.parent], subagentMode }), context);
      expect(result.requests).toBe(4);
      expect(result.subagents.sessions).toBe(3);
      if (subagentMode === 'total') {
        // Ask for the breakdown and you get it; ask for nothing and it is absent.
        expect(result.scopeBreakdown).toBeUndefined();
      } else {
        expect(result.scopeBreakdown?.subagents.requests).toBe(3);
        expect(result.scopeBreakdown?.own.sessions).toBe(1);
      }
    }
    const child = runQuery(fixture(), query({ sessions: [SID.childA], subagentMode: 'subagents' }), context);
    expect(child.requests).toBe(2);
    expect(child.subagents.sessions).toBe(2);
    expect(child.scopeBreakdown?.subagents.sessions).toBe(2);
  });
});

describe('reconciliation', () => {
  it('makes the grand total equal the sum of the project rows', () => {
    const result = runQuery(fixture(), query({ dimension: 'project' }), context);
    const sum = result.projects.reduce((total, entry) => total + Number(entry.cost.total), 0);
    expect(Number(result.cost.total)).toBe(Number(sum.toFixed(4)));
  });

  it('makes each project equal the sum of its sessions', () => {
    const result = runQuery(fixture(), query({ dimension: 'session' }), context);
    for (const entry of result.projects) {
      const sum = (entry.sessionReports ?? []).reduce((total, row) => total + Number(row.cost.total), 0);
      expect(Number(entry.cost.total)).toBe(Number(sum.toFixed(4)));
    }
  });

  it('makes the component amounts sum to the total', () => {
    const result = runQuery(fixture(), query(), context);
    const { cost } = result;
    const sum =
      Number(cost.cacheHitInputCost) + Number(cost.cacheMissInputCost) + Number(cost.outputCost) + Number(cost.cacheWriteInputCost);
    expect(sum).toBeCloseTo(Number(cost.total), 10);
  });

  it('makes the grand total the sum of the rows, rounding included', () => {
    // Three rows whose exact shares each round up. The total is the sum of what
    // is printed, so a reader adding the rows always lands on it — even though
    // the exact sum of the three is a ten-thousandth lower.
    const awkward = dataset([
      project({
        id: 'p',
        sessions: [1, 2, 3].map((index) =>
          session({
            id: `s${index}`,
            records: [record({ id: `r${index}`, time: STUB_AT.early, model: 'tiered-model', tokens: buckets({ input: 333_333 }) })],
          }),
        ),
      }),
    ]);
    const result = runQuery(awkward, query({ dimension: 'session' }), context);
    const sum = (result.projects[0]?.sessionReports ?? []).reduce((total, row) => total + Number(row.cost.total), 0);
    // 333,333 tokens at 1 unit per million is 0.333333 per row, shown as 0.3333,
    // so the three rows add up to 0.9999 and the total says 0.9999 too.
    expect(result.cost.total).toBe('0.9999');
    expect(Number(result.cost.total)).toBeCloseTo(sum, 4);
  });
});

describe('additivity', () => {
  /** Money as a number, so two rows can be added in a test. */
  const amount = (total: string): number => Number(total);

  it('makes the grand total the sum of the projects', () => {
    const result = runQuery(fixture(), query({ dimension: 'session' }), context);
    const sum = result.projects.reduce((total, entry) => total + amount(entry.cost.total), 0);
    expect(amount(result.cost.total)).toBeCloseTo(sum, 4);
    expect(Number(sum.toFixed(4))).toBe(amount(result.cost.total));
  });

  it('makes each project the sum of its sessions', () => {
    const result = runQuery(fixture(), query({ dimension: 'session' }), context);
    for (const entry of result.projects) {
      const sum = (entry.sessionReports ?? []).reduce((total, row) => total + amount(row.cost.total), 0);
      expect(Number(sum.toFixed(4))).toBe(amount(entry.cost.total));
    }
  });

  it('makes each session row its own records plus everything it spawned', () => {
    for (const mode of ['subagents', 'detail'] as const) {
      const result = runQuery(fixture(), query({ dimension: 'session', subagentMode: mode }), context);
      for (const project of result.projects) {
        for (const row of project.sessionReports ?? []) {
          expect(amount(row.own.cost.total) + amount(row.spawned.cost.total)).toBeCloseTo(amount(row.total.cost.total), 4);
          expect(Number((amount(row.own.cost.total) + amount(row.spawned.cost.total)).toFixed(4))).toBe(
            amount(row.total.cost.total),
          );
        }
      }
    }
  });

  it('makes each project its own sessions plus every subagent', () => {
    const result = runQuery(fixture(), query({ dimension: 'session', subagentMode: 'subagents' }), context);
    for (const project of result.projects) {
      expect(amount(project.own.cost.total) + amount(project.spawned.cost.total)).toBeCloseTo(amount(project.total.cost.total), 4);
    }
    const breakdown = result.scopeBreakdown;
    expect(breakdown).toBeDefined();
    expect(amount(breakdown!.own.cost.total) + amount(breakdown!.subagents.cost.total)).toBeCloseTo(
      amount(breakdown!.total.cost.total),
      4,
    );
    expect(amount(breakdown!.total.cost.total)).toBe(amount(result.cost.total));
  });

  it('makes the model rows add up to the node above them', () => {
    // Two models in one session, so the node's line really is a split.
    const mixed = dataset([
      project({
        id: 'p',
        sessions: [
          session({
            id: 's',
            records: [
              record({ id: 'r1', time: STUB_AT.early, model: 'flat-model', tokens: buckets({ input: 333_333 }) }),
              record({ id: 'r2', time: STUB_AT.early, model: 'tiered-model', tokens: buckets({ input: 333_333 }) }),
            ],
          }),
        ],
      }),
    ]);
    const result = runQuery(mixed, query({ dimension: 'session' }), context);
    expect(result.models).toHaveLength(2);
    const sum = result.models.reduce((total, model) => total + amount(model.cost.total), 0);
    expect(Number(sum.toFixed(4))).toBe(amount(result.cost.total));
  });

  it('makes tokens and requests add up the same way money does', () => {
    const tokenCount = (tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }): number =>
      tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    for (const subagentMode of ['total', 'subagents', 'detail'] as const) {
      const result = runQuery(fixture(), query({ dimension: 'session', subagentMode }), context);
      const perProjectTokens = result.projects.reduce((total, entry) => total + tokenCount(entry.tokens), 0);
      const perProjectRequests = result.projects.reduce((total, entry) => total + entry.requests, 0);
      expect(perProjectTokens).toBe(tokenCount(result.tokens));
      expect(perProjectRequests).toBe(result.requests);
      for (const entry of result.projects) {
        const rows = entry.sessionReports ?? [];
        const known = new Set(rows.map((row) => row.id));
        // Rows are nested: only the roots stand for the whole project.
        const roots = rows.filter((row) => row.parentId === null || !known.has(row.parentId));
        expect(roots.reduce((total, row) => total + tokenCount(row.tokens), 0)).toBe(tokenCount(entry.tokens));
      }
    }
  });

  it('makes every row its own bands and its own model rows', () => {
    for (const subagentMode of ['total', 'subagents', 'detail'] as const) {
      const result = runQuery(fixture(), query({ dimension: 'session', subagentMode }), context);
      for (const project of result.projects) {
        for (const row of project.sessionReports ?? []) {
          const bands = row.bands.reduce((total, band) => total + amount(band.cost.total), 0);
          expect(Number(bands.toFixed(4))).toBe(amount(row.cost.total));
          const models = row.models.reduce((total, model) => total + amount(model.cost.total), 0);
          expect(Number(models.toFixed(4))).toBe(amount(row.cost.total));
          const components = row.bands.flatMap((band) => band.components);
          for (const band of row.bands) {
            const own = band.components.reduce((total, component) => total + amount(component.amount), 0);
            expect(Number(own.toFixed(4))).toBe(amount(band.cost.total));
          }
          expect(components.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('makes the bands add up to the node they price', () => {
    const result = runQuery(fixture(), query({ dimension: 'session' }), context);
    const sum = result.bands.reduce((total, band) => total + amount(band.cost.total), 0);
    expect(Number(sum.toFixed(4))).toBe(amount(result.cost.total));
    for (const band of result.bands) {
      const components = band.components.reduce((total, component) => total + amount(component.amount), 0);
      expect(Number(components.toFixed(4))).toBe(amount(band.cost.total));
    }
  });
});

describe('time ranges', () => {
  it('filters each record by its own timestamp, not by session', () => {
    const data = dataset([
      project({
        id: 'p',
        sessions: [
          session({
            id: 's',
            records: [
              record({ id: 'old', time: Date.parse('2026-01-05T00:00:00Z'), model: 'tiered-model' }),
              record({ id: 'new', time: Date.parse('2026-07-05T00:00:00Z'), model: 'tiered-model' }),
            ],
          }),
        ],
      }),
    ]);
    const result = runQuery(
      data,
      query({ range: { from: Date.parse('2026-06-01T00:00:00Z'), to: null, label: 'june onwards' } }),
      context,
    );
    expect(result.requests).toBe(1);
    expect(result.bands.map((band) => band.periodId)).toEqual(['2026-06-01']);
  });

  it('flags an empty result', () => {
    const result = runQuery(fixture(), query({ range: { from: Date.parse('2030-01-01T00:00:00Z'), to: null, label: 'future' } }), context);
    expect(result.requests).toBe(0);
    expect(result.warnings.map((warning) => warning.message).join('\n')).toMatch(/没有任何用量记录/);
  });
});

describe('currency', () => {
  it('reports the rate it was priced at, without converting again', () => {
    // Conversion happens once, on the provider's rates; the report only carries
    // the provenance so the renderer can explain itself.
    const result = runQuery(
      fixture(),
      query({ currency: 'USD', rate: { ...RATE_INFO, display: 'USD', rate: '0.5', reason: 'flag' } }),
      context,
    );
    expect(result.currency).toBe('USD');
    expect(result.currencyRate).toBe(0.5);
    expect(result.rateInfo.rate).toBe('0.5');
    expect(result.rateInfo.base).toBe('XTS');
  });
});

describe('unpriced records', () => {
  it('counts them instead of treating them as free', () => {
    const strict = createPricingEngine({ ...stubProvider(), defaultModel: null });
    const data = dataset([
      project({
        id: 'p',
        sessions: [session({ id: 's', records: [record({ id: 'r', time: STUB_AT.early, model: 'unknown' })] })],
      }),
    ]);
    const result = runQuery(data, query(), { engine: strict, pricingProvider: 'stub' });
    expect(result.unpriced).toBe(1);
    expect(result.requests).toBe(1);
    expect(result.cost.total).toBe('0.0000');
    expect(result.warnings.map((warning) => warning.message).join('\n')).toMatch(/没有可用价格/);
  });
});

describe('session list', () => {
  it('orders projects and sessions newest first', () => {
    const result = listSessions(fixture());
    expect(result.projects.map((entry) => entry.name)).toEqual(['beta', 'alpha']);
    // `totalSessions` counts sessions in scope; folded rows hide their subagents
    // from the table without hiding them from the count.
    expect(result.totalSessions).toBe(5);
    const alpha = result.projects.find((entry) => entry.name === 'alpha');
    expect(alpha?.sessions).toHaveLength(1);
    expect(alpha?.sessionCount).toBe(4);
  });

  it('folds subagents by default and nests them on request', () => {
    const data = fixture();
    const folded = listSessions(data);
    const alpha = folded.projects.find((entry) => entry.name === 'alpha');
    expect(alpha?.sessions).toHaveLength(1);
    // Folded: two direct subagents plus one grandchild.
    expect(alpha?.sessions[0]?.subagentCount).toBe(3);
    // Folded: the row stands for the parent and its three descendants.
    expect(alpha?.sessions[0]?.requests).toBe(4);
    expect(alpha?.sessions[0]?.id).toBe(SID.parent);

    const split = listSessions(data, { includeSubagents: true });
    const alphaSplit = split.projects.find((entry) => entry.name === 'alpha');
    expect(alphaSplit?.sessions).toHaveLength(4);
    expect(alphaSplit?.sessions.filter((entry) => entry.nested)).toHaveLength(3);
    // The parent still sits first.
    expect(alphaSplit?.sessions[0]?.id).toBe(SID.parent);
  });

  it('lists sessions that never billed anything', () => {
    const data = dataset([project({ id: 'p', sessions: [session({ id: 'empty', createdAt: 1 })] })]);
    const result = listSessions(data);
    expect(result.projects[0]?.sessions[0]?.requests).toBe(0);
    expect(result.projects[0]?.sessions[0]?.tokens).toEqual(emptyBuckets());
  });

  it('honours project and session filters', () => {
    const data = fixture();
    expect(listSessions(data, { projects: ['beta'] }).projects.map((entry) => entry.name)).toEqual(['beta']);
    // Naming a subagent selects it and its own descendants, nothing else.
    const subtree = listSessions(data, { sessions: [SID.childA] });
    expect(subtree.totalSessions).toBe(2);
    expect(subtree.projects[0]?.sessionCount).toBe(2);
    // Folded by default: the named subagent stands alone because its parent is
    // out of scope, and its own child is folded into it.
    expect(subtree.projects[0]?.sessions.map((entry) => entry.id)).toEqual([SID.childA]);
    expect(subtree.projects[0]?.sessions[0]?.nested).toBe(false);
    expect(subtree.projects[0]?.sessions[0]?.subagentCount).toBe(1);
    // Split: both keep a row.
    const split = listSessions(data, { sessions: [SID.childA], includeSubagents: true });
    expect(split.projects[0]?.sessions.map((entry) => entry.id).sort()).toEqual([SID.childA, SID.grandchild].sort());
  });
});
