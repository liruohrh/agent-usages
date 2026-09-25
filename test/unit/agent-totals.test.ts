/**
 * Multi-agent report tests.
 *
 * The merge layer groups sessions; this layer *splits* them again, by the agent
 * that produced them. What has to hold is the arithmetic: every node's per-agent
 * rows are a partition of its sessions, so `Σ agentTotals` is the node's own
 * number — sessions, requests, tokens and money — with no rounding step in
 * between.
 */

import { describe, expect, it } from 'vitest';

import { mergeDatasets } from '../../src/core/merge.ts';
import { createPricingEngine } from '../../src/pricing/index.ts';
import { runQuery, type UsageQuery, type UsageResult } from '../../src/report.ts';
import { buckets, dataset, project, record, session } from '../support/dataset.ts';
import { STUB_AT, stubProvider } from '../support/stub-pricing.ts';

const engine = createPricingEngine(stubProvider());
const context = { engine, pricingProvider: engine.provider.id };

/** One million of every bucket: a full request on the stub's flat model. */
const FULL = buckets({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 });
const SMALL = buckets({ input: 100_000, output: 50_000 });

function query(overrides: Partial<UsageQuery> = {}): UsageQuery {
  return {
    dimension: 'session',
    range: { from: null, to: null, label: '全部时间' },
    rate: {
      base: 'XTS',
      display: 'XTS',
      rate: '1',
      mode: 'latest',
      reason: 'fallback-base',
      source: 'test',
      date: '2026-09-21',
    },
    currency: 'XTS',
    ...overrides,
  };
}

/** Two agents in one directory: DSH with a subagent, Claude with a flat session. */
function multiAgent() {
  const dsh = dataset(
    [
      project({
        id: 'demo',
        name: 'demo',
        path: '/tmp/demo',
        sessions: [
          session({
            id: 'dsh-parent',
            agent: 'dsh',
            cwd: '/tmp/demo',
            records: [record({ id: 'p1', time: STUB_AT.early, model: 'flat-model', tokens: FULL })],
          }),
          session({
            id: 'dsh-child',
            agent: 'dsh',
            cwd: '/tmp/demo',
            parentId: 'dsh-parent',
            depth: 1,
            isSubagent: true,
            parentKnown: true,
            records: [record({ id: 'c1', time: STUB_AT.early, model: 'flat-model', tokens: SMALL })],
          }),
        ],
      }),
    ],
    { agent: 'dsh', agents: ['dsh'], source: '/data/dsh' },
  );
  const claude = dataset(
    [
      project({
        id: '-tmp-demo',
        name: '-tmp-demo',
        path: '/tmp/demo',
        sessions: [
          session({
            id: 'claude-flat',
            agent: 'claude',
            cwd: '/tmp/demo',
            records: [record({ id: 'f1', time: STUB_AT.late, model: 'tiered-model', tokens: FULL })],
          }),
        ],
      }),
    ],
    { agent: 'claude', agents: ['claude'], source: '/data/claude' },
  );
  return mergeDatasets([dsh, claude]);
}

/** Every quantity that must survive the per-agent split. */
function quantities(result: UsageResult): { key: string; value: number }[] {
  return [
    { key: 'requests', value: result.requests },
    { key: 'tokens.input', value: result.tokens.input },
    { key: 'tokens.output', value: result.tokens.output },
    { key: 'tokens.cacheRead', value: result.tokens.cacheRead },
    { key: 'tokens.cacheWrite', value: result.tokens.cacheWrite },
    { key: 'tokens.reasoning', value: result.tokens.reasoning },
    { key: 'cost.total', value: Number(result.cost.total) },
  ];
}

describe('per-agent totals', () => {
  it('names every agent, sorted, with its own row', async () => {
    const result = runQuery(await multiAgent(), query(), context);
    expect(result.agents.map((row) => row.agent)).toEqual(['claude', 'dsh']);
    const dsh = result.agents.find((row) => row.agent === 'dsh');
    expect(dsh?.sessions).toBe(2);
    expect(dsh?.subagentSessions).toBe(1);
    expect(dsh?.requests).toBe(2);
    expect(result.projects[0]?.agents).toEqual(['claude', 'dsh']);
    expect(result.projects[0]?.workspaces).toEqual(['/tmp/demo']);
  });

  it('sums the rows to the grand total, quantity by quantity', async () => {
    const result = runQuery(await multiAgent(), query(), context);
    const rows = result.agents;
    const sum = (pick: (row: (typeof rows)[number]) => number): number =>
      rows.reduce((total, row) => total + pick(row), 0);
    expect({
      requests: sum((row) => row.requests),
      input: sum((row) => row.tokens.input),
      output: sum((row) => row.tokens.output),
      cacheRead: sum((row) => row.tokens.cacheRead),
      cacheWrite: sum((row) => row.tokens.cacheWrite),
      reasoning: sum((row) => row.tokens.reasoning),
      cost: sum((row) => Number(row.cost.total)).toFixed(4),
    }).toEqual({
      requests: result.requests,
      input: result.tokens.input,
      output: result.tokens.output,
      cacheRead: result.tokens.cacheRead,
      cacheWrite: result.tokens.cacheWrite,
      reasoning: result.tokens.reasoning,
      cost: result.cost.total,
    });
    // Sessions too: every session in scope belongs to exactly one agent row.
    expect(sum((row) => row.sessions)).toBe(3);
    expect(sum((row) => row.subagentSessions)).toBe(1);
  });

  it('sums each project’s rows to that project’s own line', async () => {
    const result = runQuery(await multiAgent(), query(), context);
    for (const projectRow of result.projects) {
      const totals = projectRow.agentTotals.reduce(
        (sum, row) => ({
          requests: sum.requests + row.requests,
          input: sum.input + row.tokens.input,
          cost: sum.cost + Number(row.cost.total),
        }),
        { requests: 0, input: 0, cost: 0 },
      );
      expect({
        requests: totals.requests,
        input: totals.input,
        cost: totals.cost.toFixed(4),
      }).toEqual({ requests: projectRow.requests, input: projectRow.tokens.input, cost: projectRow.cost.total });
    }
  });

  it('marks every session row with its agent, subagents included', async () => {
    const result = runQuery(await multiAgent(), query({ subagentMode: 'detail' }), context);
    const rows = result.projects.flatMap((entry) => entry.sessionReports ?? []);
    expect(rows.map((row) => `${row.agent}:${row.id}`).sort()).toEqual([
      'claude:claude-flat',
      'dsh:dsh-child',
      'dsh:dsh-parent',
    ]);
  });

  it('keeps the identity in the folded mode too', async () => {
    const merged = await multiAgent();
    const folded = runQuery(merged, query(), context);
    const detailed = runQuery(merged, query({ subagentMode: 'detail' }), context);
    expect(quantities(detailed)).toEqual(quantities(folded));
    expect(folded.agents).toEqual(detailed.agents);
  });

  it('does not fold a fork into the session it came from', async () => {
    // A continuation names a parent but is a session of its own: folding it in
    // would report its tokens twice — once on its own row, once in the parent's.
    const data = dataset([
      project({
        id: 'p',
        name: 'p',
        path: '/tmp/p',
        sessions: [
          session({
            id: 'source',
            agent: 'claude',
            cwd: '/tmp/p',
            records: [record({ id: 's1', time: STUB_AT.early, model: 'flat-model', tokens: FULL })],
          }),
          session({
            id: 'fork',
            agent: 'claude',
            cwd: '/tmp/p',
            parentId: 'source',
            depth: 0,
            isSubagent: false,
            parentKnown: true,
            records: [record({ id: 'f1', time: STUB_AT.early, model: 'flat-model', tokens: FULL })],
          }),
        ],
      }),
    ]);
    const result = runQuery(data, query(), context);
    // Two full requests, counted twice and only twice.
    expect(result.tokens.input).toBe(2_000_000);
    expect(result.agents[0]?.tokens.input).toBe(2_000_000);
    expect(result.projects[0]?.tokens.input).toBe(2_000_000);
    const rows = result.projects[0]?.sessionReports ?? [];
    expect(rows).toHaveLength(2);
    const parent = rows.find((row) => row.id === 'source');
    expect(parent?.subagentCount).toBe(0);
    expect(parent?.spawned.requests).toBe(0);
  });
});
