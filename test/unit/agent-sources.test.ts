/**
 * Planning what to read, with a store that remembers more than it can reuse.
 *
 * Two questions that used to share one answer: does the store know a root (a
 * root whose history is here, even if the log behind it is gone), and may that
 * root's rows be reused (only when this version of the tool wrote them). Mixing
 * them up costs exact history: on the first run after an upgrade every root is
 * "not reusable", and a plan that treats that as "not known" drops the agents
 * whose directories are gone — the very run where a tombstone is the only place
 * their usage exists.
 *
 * The agents are the real adapters; only the environment and the store are
 * synthetic, so nothing on this machine is read.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { planAgentSources } from '../../src/agents/sources.ts';
import { rootIdOf, UsageStore } from '../../src/store/index.ts';

let home: string;
let configDir: string;
let stores: UsageStore[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-usages-plan-'));
  configDir = join(home, 'claude');
  stores = [];
});

afterEach(async () => {
  for (const store of stores) store.close();
  await rm(home, { recursive: true, force: true });
});

/**
 * An environment in which only one agent's directory exists.
 *
 * Every path an adapter could look at comes from `home` — including the ones an
 * adapter would otherwise derive from the real user's home directory, which is
 * why each agent's own variable is named here. "Detected" then means exactly
 * what this test put on disk.
 * @returns the environment to plan with.
 */
function environment(): NodeJS.ProcessEnv {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    CLAUDE_CONFIG_DIR: configDir,
    CODEX_HOME: join(home, '.codex'),
    DSH_HOME: join(home, '.dsh'),
    PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'),
    PI_CODING_AGENT_SESSION_DIR: join(home, '.pi', 'agent', 'sessions'),
  };
}

/** A Claude Code session log, enough for the adapter to call the root read. */
async function populate(): Promise<void> {
  const project = join(configDir, 'projects', '-tmp-demo');
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, 'aaa.jsonl'),
    `${JSON.stringify({
      type: 'user',
      uuid: 'u1',
      sessionId: '11111111-1111-4111-8111-111111111111',
      timestamp: '2026-09-23T00:00:00.000Z',
      cwd: '/tmp/demo',
    })}\n`,
  );
}

/** Open a store and remember it for cleanup. */
async function openStore(path: string, toolVersion: string): Promise<UsageStore> {
  const { store } = await UsageStore.open({ path, toolVersion });
  stores.push(store);
  return store;
}

describe('planning with the usage store', () => {
  it('plans an agent whose directory is gone while another version wrote its root', async () => {
    await populate();
    const path = join(home, 'usage.db');
    const env = environment();
    const rootId = rootIdOf(configDir);

    // The old build read the directory and stored its (empty) result.
    const older = await openStore(path, '0.1.0');
    older.writeRoot({
      agent: 'claudecode',
      rootId,
      root: configDir,
      now: 1,
      dataset: { agent: 'claudecode', agents: ['claudecode'], source: configDir, projects: [], sessions: [], stats: { filesRead: [], sessions: 0, records: 0 }, warnings: [] },
      fingerprint: [],
    });
    older.close();

    // The directory is gone, so nothing detects the agent any more.
    await rm(configDir, { recursive: true, force: true });

    // A run of the same build as the rows: the root is remembered and reusable,
    // so the agent is planned and its history will be reported as vanished.
    const same = await openStore(path, '0.1.0');
    const warmed = await planAgentSources({ env, store: same });
    expect(warmed.planned.map((entry) => entry.adapter.id)).toContain('claudecode');
    expect(warmed.planned.find((entry) => entry.adapter.id === 'claudecode')?.roots).toEqual([configDir]);
    same.close();

    // A run of a newer build: this root cannot be reused, and *still* has to be
    // planned, or the one run that sees the upgrade would lose the history.
    const upgraded = await openStore(path, '0.2.0');
    expect(upgraded.fingerprintOf('claudecode', rootId)).toBeUndefined();
    expect(upgraded.knowsRoot('claudecode', rootId)).toBe(true);
    const planned = await planAgentSources({ env, store: upgraded });
    expect(planned.planned.map((entry) => entry.adapter.id)).toContain('claudecode');

    // Without a store there is nothing to remember: the agent is not planned,
    // which is what makes the assertion above about the store and not about the
    // adapter's own defaults.
    const forgotten = await planAgentSources({ env });
    expect(forgotten.planned.map((entry) => entry.adapter.id)).not.toContain('claudecode');
  });

  it('does not plan an agent it never had a root for', async () => {
    const env = environment();
    const store = await openStore(join(home, 'usage.db'), '0.2.0');
    const planned = await planAgentSources({ env, store });
    expect(planned.planned).toEqual([]);
  });

  it('plans a detected agent whatever the store says about it', async () => {
    await populate();
    const env = environment();
    const store = await openStore(join(home, 'usage.db'), '0.2.0');
    const planned = await planAgentSources({ env, store });
    expect(planned.planned.map((entry) => entry.adapter.id)).toEqual(['claudecode']);
    expect(planned.planned[0]?.roots).toEqual([configDir]);
  });
});
