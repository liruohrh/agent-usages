/**
 * Merge-layer tests.
 *
 * The merge decides when two rows are the *same* project, so the fixtures are
 * real directories wherever repository detection is involved: `repoOf` reads
 * what git wrote on disk, and a fake filesystem would test nothing but the mock.
 * The rest is built through the neutral dataset helpers, because what is under
 * test here is grouping — not any adapter's file format.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mergeDatasets } from '../../src/core/merge.ts';
import { resolveProjectSelectors } from '../../src/report/index.ts';
import { dataset, project, record, session } from '../support/dataset.ts';

let root: string;

/** A repository whose `.git` is a directory, with `HEAD` on `branch`. */
async function makeRepo(dir: string, branch: string): Promise<void> {
  await mkdir(join(dir, '.git'), { recursive: true });
  await writeFile(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
}

/** A linked checkout: `.git` is a file holding a `gitdir:` pointer. */
async function makeLinked(dir: string, gitdir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.git'), `gitdir: ${gitdir}\n`);
}

/** Register a worktree inside a repository's `.git`, with the given `HEAD`. */
async function makeWorktree(mainDir: string, name: string, head: string): Promise<void> {
  const dir = join(mainDir, '.git', 'worktrees', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'HEAD'), head);
}

/** One dataset for one agent: a single project holding a single session. */
function agentDataset(id: string, options: { cwd?: string | null; projectId?: string; projectName?: string } = {}) {
  const projectId = options.projectId ?? 'p1';
  const cwd = options.cwd === undefined ? '/tmp/shared' : options.cwd;
  return dataset(
    [
      project({
        id: projectId,
        name: options.projectName ?? projectId,
        path: cwd ?? '',
        sessions: [session({ id: `${id}-session`, agent: id, cwd, records: [record({ time: 1_000 })] })],
      }),
    ],
    { agent: id, agents: [id], source: `/data/${id}` },
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-usages-merge-'));
  await makeRepo(join(root, 'main'), 'master');
  await makeWorktree(join(root, 'main'), 'feature', 'ref: refs/heads/feature\n');
  await makeLinked(join(root, 'feature'), join(root, 'main', '.git', 'worktrees', 'feature'));
  await mkdir(join(root, 'plain'), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('mergeDatasets', () => {
  it('returns a lone dataset untouched when there is nothing to merge', async () => {
    const only = agentDataset('dsh');
    const merged = await mergeDatasets([only]);
    expect(merged).toBe(only);
    expect(merged.agents).toEqual(['dsh']);
  });

  it('merges one directory read by two agents into one project', async () => {
    const merged = await mergeDatasets([agentDataset('dsh'), agentDataset('claude')]);

    expect(merged.projects).toHaveLength(1);
    const [project0] = merged.projects;
    expect(project0?.agents).toEqual(['claude', 'dsh']);
    expect(project0?.workspaces).toEqual(['/tmp/shared']);
    expect(project0?.sessions).toHaveLength(2);
    expect(merged.agents).toEqual(['dsh', 'claude']);
    expect(merged.agent).toBe('dsh+claude');
    expect(merged.source).toBe('/data/dsh, /data/claude');
    expect(merged.stats.sessions).toBe(2);
  });

  it('keeps each session id as the agent wrote it, with the agent beside it', async () => {
    // Both agents use the same id; only the pair is unique, so the bare id must
    // survive unchanged — a user pastes ids from the agent's own UI.
    const merged = await mergeDatasets([agentDataset('dsh'), agentDataset('claude')]);
    const ids = merged.sessions.map((entry) => `${entry.agent}:${entry.id}`).sort();
    expect(ids).toEqual(['claude:claude-session', 'dsh:dsh-session']);
    expect(merged.sessions.every((entry) => entry.id.endsWith('-session'))).toBe(true);
  });

  it('folds a worktree and its main tree into one repository project', async () => {
    const main = agentDataset('dsh', { cwd: join(root, 'main'), projectId: 'main' });
    const worktree = agentDataset('pi', { cwd: join(root, 'feature'), projectId: 'feature' });

    const merged = await mergeDatasets([main, worktree]);
    expect(merged.projects).toHaveLength(1);
    const [project0] = merged.projects;
    expect(project0?.agents).toEqual(['dsh', 'pi']);
    expect(project0?.workspaces).toEqual([join(root, 'feature'), join(root, 'main')].sort());
    expect(project0?.path).toBe(join(root, 'main'));
    expect(project0?.repo?.kind).toBe('main');
    expect(project0?.repo?.name).toBe('main');
    expect(project0?.id).toBe(`repo:${join(root, 'main')}`.toLowerCase());
  });

  it('keeps directories that share no repository apart', async () => {
    const first = agentDataset('dsh', { cwd: join(root, 'plain'), projectId: 'a' });
    const second = agentDataset('claude', { cwd: join(root, 'main'), projectId: 'b' });
    const merged = await mergeDatasets([first, second]);
    expect(merged.projects.map((entry) => entry.name).sort()).toEqual(['main', 'plain']);
  });

  it('files a session with no working directory under its own project', async () => {
    const homeless = agentDataset('codex', { cwd: null, projectName: 'unknown-place' });
    const located = agentDataset('dsh', { cwd: join(root, 'plain'), projectId: 'plain' });
    const merged = await mergeDatasets([homeless, located]);

    const unknown = merged.projects.find((entry) => entry.name === 'unknown-place');
    expect(unknown?.workspaces).toEqual([]);
    expect(unknown?.agents).toEqual(['codex']);
    expect(unknown?.sessions.map((entry) => entry.id)).toEqual(['codex-session']);
    // The directory-less bucket is a project of its own, not a merge of every
    // session that happened to record no cwd elsewhere.
    expect(merged.projects).toHaveLength(2);
  });

  it('sums the adapter counters and keeps every warning', async () => {
    const first = agentDataset('dsh');
    const second = agentDataset('claude');
    first.stats.filesRead = ['a.jsonl'];
    second.stats.filesRead = ['b.jsonl', 'a.jsonl'];
    const merged = await mergeDatasets([first, second]);
    expect(merged.stats.filesRead).toEqual(['a.jsonl', 'b.jsonl']);
    expect(merged.stats.records).toBe(2);
  });
});

describe('configured projects', () => {
  it('gathers the declared paths under the configured name', async () => {
    const one = agentDataset('dsh', { cwd: join(root, 'main'), projectId: 'main' });
    const two = agentDataset('claude', { cwd: join(root, 'plain'), projectId: 'plain' });
    const merged = await mergeDatasets([one, two], {
      projects: [{ name: 'Memolink', paths: [join(root, 'main'), join(root, 'plain')] }],
    });

    expect(merged.projects).toHaveLength(1);
    const [project0] = merged.projects;
    expect(project0?.name).toBe('Memolink');
    expect(project0?.id).toBe('project:Memolink');
    expect(project0?.agents).toEqual(['claude', 'dsh']);
    expect(project0?.workspaces).toEqual([join(root, 'main'), join(root, 'plain')].sort());
    // The configured project spans two repositories, so it claims neither.
    expect(project0?.repo).toBeUndefined();
  });

  it('takes in a subdirectory of a declared path', async () => {
    await mkdir(join(root, 'main', 'packages', 'app'), { recursive: true });
    const inner = agentDataset('dsh', { cwd: join(root, 'main', 'packages', 'app'), projectId: 'app' });
    const merged = await mergeDatasets([inner], {
      projects: [{ name: 'Memolink', paths: [join(root, 'main')] }],
    });
    expect(merged.projects.map((entry) => entry.name)).toEqual(['Memolink']);
  });

  it('auto-merges a worktree that shares a declared path’s repository', async () => {
    // The worktree's own path is nowhere in the configuration: it joins because
    // it is a worktree *of* the repository the configured path belongs to.
    const worktree = agentDataset('pi', { cwd: join(root, 'feature'), projectId: 'feature' });
    const merged = await mergeDatasets([worktree], {
      projects: [{ name: 'Memolink', paths: [join(root, 'main')] }],
    });
    expect(merged.projects).toHaveLength(1);
    const [project0] = merged.projects;
    expect(project0?.name).toBe('Memolink');
    expect(project0?.workspaces).toEqual([join(root, 'feature')]);
    // The declared main tree is not among the workspaces, so the project does
    // not contain the repository's own working tree and keeps the worktree kind.
    expect(project0?.repo?.kind).toBe('worktree');
  });

  it('keeps an explicitly declared path with its own project', async () => {
    // The worktree is declared by a *different* project, so rule 1 must win over
    // the repository rule that would otherwise pull it into Memolink.
    const main = agentDataset('dsh', { cwd: join(root, 'main'), projectId: 'main' });
    const worktree = agentDataset('pi', { cwd: join(root, 'feature'), projectId: 'feature' });
    const merged = await mergeDatasets([main, worktree], {
      projects: [
        { name: 'Memolink', paths: [join(root, 'main')] },
        { name: 'Feature', paths: [join(root, 'feature')] },
      ],
    });
    expect(merged.projects.map((entry) => entry.name).sort()).toEqual(['Feature', 'Memolink']);
  });

  it('is addressable by the configured name', async () => {
    const merged = await mergeDatasets([agentDataset('dsh', { cwd: join(root, 'main') })], {
      projects: [{ name: 'Memolink', paths: [join(root, 'main')] }],
    });
    expect([...resolveProjectSelectors(merged.projects, ['Memolink']).keys]).toEqual(['project:Memolink']);
    expect([...resolveProjectSelectors(merged.projects, ['project:Memolink']).keys]).toEqual(['project:Memolink']);
  });
});
