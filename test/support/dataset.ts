/**
 * Builders for synthetic datasets.
 *
 * Tests that care about *aggregation* should not have to construct an agent's
 * on-disk format, so these helpers build the neutral model directly. Adapter
 * tests build real files instead and assert on the same shapes.
 */

import { emptyBuckets } from '../../src/core/buckets.ts';
import type { ProjectRecord, SessionRecord, TokenBuckets, UsageDataset, UsageRecord } from '../../src/core/types.ts';

/** A record with every field filled in, overridable per test. */
export function record(overrides: Partial<UsageRecord> & { time: number }): UsageRecord {
  return {
    id: overrides.id ?? `r-${overrides.time}`,
    model: overrides.model ?? 'test-model',
    modelLabel: overrides.modelLabel ?? overrides.model ?? 'test-model',
    tokens: overrides.tokens ?? { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    ...overrides,
  } as UsageRecord;
}

/** Buckets with only the fields a test cares about set. */
export function buckets(overrides: Partial<TokenBuckets> = {}): TokenBuckets {
  return { ...emptyBuckets(), ...overrides };
}

/** A session with the given records. */
export function session(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    agent: 'test',
    title: null,
    cwd: null,
    createdAt: null,
    records: [],
    parentId: null,
    depth: 0,
    isSubagent: false,
    archived: false,
    childIds: [],
    parentKnown: false,
    ...overrides,
  };
}

/** A project with the given sessions. */
export function project(overrides: Partial<ProjectRecord> & { id: string }): ProjectRecord {
  const sessions = overrides.sessions ?? [];
  return {
    name: overrides.id,
    path: `/tmp/${overrides.id}`,
    sessions,
    // The same rule the adapters follow: a project names the agents and
    // workspaces its sessions came from.
    agents: [...new Set(sessions.map((entry) => entry.agent))].sort(),
    workspaces: [
      ...new Set(sessions.map((entry) => entry.cwd).filter((cwd): cwd is string => cwd !== null && cwd.length > 0)),
    ].sort(),
    ...overrides,
  };
}

/** A dataset with the given projects, deriving the flat session list from them. */
export function dataset(projects: ProjectRecord[], overrides: Partial<UsageDataset> = {}): UsageDataset {
  const sessions = projects.flatMap((entry) => entry.sessions);
  return {
    agent: 'test',
    agents: ['test'],
    source: '/tmp/test',
    projects,
    sessions,
    stats: {
      filesRead: [],
      sessions: sessions.length,
      records: sessions.reduce((total, entry) => total + entry.records.length, 0),
    },
    warnings: [],
    ...overrides,
  };
}
