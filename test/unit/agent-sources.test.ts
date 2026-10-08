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

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudecodeAgent } from '../../src/agents/claudecode/loader.ts';
import { loadPlannedAgents, planAgentSources } from '../../src/agents/sources.ts';
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
    // The application directory keeps the store and the configuration out of a
    // real home; nothing here reads `XDG_*` any more.
    AGENT_USAGES_HOME: join(home, 'app'),
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

describe('roots that never enter the store', () => {
  /** A store in the temporary home, and the cleanup it needs. */
  async function storeInHome(): Promise<UsageStore> {
    return openStore(join(home, 'usage.db'), '0.2.0');
  }

  it('reads an excluded root and writes nothing about it', async () => {
    await populate();
    const env = environment();
    const store = await storeInHome();
    const planned = [{ adapter: claudecodeAgent, roots: [configDir] }];

    const excluded = await loadPlannedAgents(planned, { env, store, excludedRoots: [configDir] });
    // Read as usual: the numbers are the same as they would be without a store.
    expect(excluded.datasets).toHaveLength(1);
    expect(excluded.datasets[0]?.sessions).toHaveLength(1);
    expect(store.rootSummaries()).toEqual([]);
    expect(store.knowsRoot('claudecode', rootIdOf(configDir))).toBe(false);

    // And it is not remembered either: a second run writes nothing again, where a
    // stored root would have been remembered and named in a warning by now.
    const again = await loadPlannedAgents(planned, { env, store, excludedRoots: [configDir] });
    expect(again.datasets).toHaveLength(1);
    expect(store.rootSummaries()).toEqual([]);
  });

  it('writes a root that is not excluded in the same run', async () => {
    await populate();
    const other = join(home, 'claude-other');
    await mkdir(join(other, 'projects', '-tmp-demo'), { recursive: true });
    await writeFile(
      join(other, 'projects', '-tmp-demo', 'bbb.jsonl'),
      await readFile(join(configDir, 'projects', '-tmp-demo', 'aaa.jsonl'), 'utf8'),
    );
    const env = environment();
    const store = await storeInHome();
    const planned = [{ adapter: claudecodeAgent, roots: [configDir, other] }];

    const result = await loadPlannedAgents(planned, { env, store, excludedRoots: [configDir] });
    expect(result.datasets).toHaveLength(2);
    expect(store.rootSummaries().map((entry) => entry.root)).toEqual([other]);
  });

  it('does not remember an excluded root even when rows for it exist', async () => {
    await populate();
    const env = environment();
    const store = await storeInHome();
    const rootId = rootIdOf(configDir);
    // Rows from before the directory was excluded — exactly what must not
    // resurrect a root that is not supposed to be kept.
    store.writeRoot({
      agent: 'claudecode',
      rootId,
      root: configDir,
      now: 1,
      dataset: { agent: 'claudecode', agents: ['claudecode'], source: configDir, projects: [], sessions: [], stats: { filesRead: [], sessions: 0, records: 0 }, warnings: [] },
      fingerprint: [],
    });
    await rm(configDir, { recursive: true, force: true });

    const included = await planAgentSources({ env, store });
    expect(included.planned.map((entry) => entry.adapter.id)).toContain('claudecode');

    const excluded = await planAgentSources({ env, store, excludedRoots: [configDir] });
    expect(excluded.planned.map((entry) => entry.adapter.id)).not.toContain('claudecode');
  });
});
