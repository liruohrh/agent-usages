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
    currencyRate: 1,
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
    expect(resolveProjectSelectors(projects, ['nope']).errors).toEqual(['没有项目匹配 "nope"']);
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
    expect(errors).toEqual(['找不到会话 "父会"']);
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
    expect(errors[0]).toMatch(/有 2 个候选/);
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

describe('subagent folding', () => {
  it('folds descendants into the session that spawned them by default', () => {
    const result = runQuery(fixture(), query({ dimension: 'session' }), context);
    const parent = result.projects[0]?.sessionReports?.[0];
    expect(parent?.id).toBe(SID.parent);
    expect(parent?.isSubagent).toBe(false);
    expect(parent?.requests).toBe(4);
    expect(parent?.cost.total).toBe('144.0000');
    expect(result.subagents.split).toBe(false);
    expect(result.subagents.rows).toBe(3);
    expect(result.subagents.cost.total).toBe('108.0000');
    // 4 x 36 for alpha's tree, 9 for beta.
    expect(result.projects.find((entry) => entry.name === 'beta')?.cost.total).toBe('9.0000');
  });

  it('splits subagents into their own rows on request', () => {
    const result = runQuery(fixture(), query({ dimension: 'session', includeSubagents: false }), context);
    const alpha = result.projects.find((entry) => entry.name === 'alpha');
    const rows = alpha?.sessionReports ?? [];
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.isSubagent)).toHaveLength(3);
    expect(rows.find((row) => row.id === SID.parent)?.cost.total).toBe('36.0000');
    expect(rows.find((row) => row.id === SID.childA)?.cost.total).toBe('36.0000');
    expect(alpha?.subagentSessions).toBe(3);
    expect(alpha?.sessions).toBe(4);
  });

  it('covers exactly the same usage in both modes', () => {
    const folded = runQuery(fixture(), query({ dimension: 'session' }), context);
    const split = runQuery(fixture(), query({ dimension: 'session', includeSubagents: false }), context);
    expect(split.cost.total).toBe(folded.cost.total);
    expect(split.requests).toBe(folded.requests);
    expect(split.subagents.cost.total).toBe(folded.subagents.cost.total);
  });

  it('keeps a named session subtree in scope in either mode', () => {
    for (const includeSubagents of [true, false]) {
      const result = runQuery(fixture(), query({ sessions: [SID.parent], includeSubagents }), context);
      expect(result.requests).toBe(4);
      expect(result.subagents.rows).toBe(3);
    }
    const child = runQuery(fixture(), query({ sessions: [SID.childA] }), context);
    expect(child.requests).toBe(2);
    expect(child.subagents.rows).toBe(2);
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

  it('does not let per-row rounding reach the grand total', () => {
    // Three rows whose exact shares each round up; a total built by adding the
    // rounded rows would be larger than the exact total.
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
    // 999,999 tokens at 1 unit per million is 0.999999; each row rounds up to
    // 0.3333, so adding the rows would give 0.9999 while the true total is 1.0000.
    expect(result.cost.total).toBe('1.0000');
    expect(sum).toBeCloseTo(0.9999, 4);
    expect(Number(result.cost.total)).toBeGreaterThan(sum);
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
    expect(result.warnings.join('\n')).toMatch(/没有任何用量记录/);
  });
});

describe('currency', () => {
  it('converts by the requested rate', () => {
    const data = fixture();
    const one = runQuery(data, query(), context);
    const half = runQuery(data, query({ currencyRate: 0.5, currency: 'USD' }), context);
    expect(Number(half.cost.total)).toBeCloseTo(Number(one.cost.total) / 2, 4);
  });

  it('rejects a negative rate', () => {
    expect(() => runQuery(fixture(), query({ currencyRate: -1 }), context)).toThrow(/汇率必须是非负有限数字/);
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
    expect(result.warnings.join('\n')).toMatch(/没有可用价格/);
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
