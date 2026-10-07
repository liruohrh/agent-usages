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

import { mergeDatasets, unionSessionRecords } from '../../src/core/merge.ts';
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
    const merged = await mergeDatasets([agentDataset('dsh'), agentDataset('claudecode')]);

    expect(merged.projects).toHaveLength(1);
    const [project0] = merged.projects;
    expect(project0?.agents).toEqual(['claudecode', 'dsh']);
    expect(project0?.workspaces).toEqual(['/tmp/shared']);
    expect(project0?.sessions).toHaveLength(2);
    expect(merged.agents).toEqual(['dsh', 'claudecode']);
    expect(merged.agent).toBe('dsh+claudecode');
    expect(merged.source).toBe('/data/dsh, /data/claudecode');
    expect(merged.stats.sessions).toBe(2);
  });

  it('keeps each session id as the agent wrote it, with the agent beside it', async () => {
    // Both agents use the same id; only the pair is unique, so the bare id must
    // survive unchanged — a user pastes ids from the agent's own UI.
    const merged = await mergeDatasets([agentDataset('dsh'), agentDataset('claudecode')]);
    const ids = merged.sessions.map((entry) => `${entry.agent}:${entry.id}`).sort();
    expect(ids).toEqual(['claudecode:claudecode-session', 'dsh:dsh-session']);
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
    const second = agentDataset('claudecode', { cwd: join(root, 'main'), projectId: 'b' });
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
    const second = agentDataset('claudecode');
    first.stats.filesRead = ['a.jsonl'];
    second.stats.filesRead = ['b.jsonl', 'a.jsonl'];
    const merged = await mergeDatasets([first, second]);
    expect(merged.stats.filesRead).toEqual(['a.jsonl', 'b.jsonl']);
    expect(merged.stats.records).toBe(2);
  });
});

describe('a session read twice', () => {
  it('unions the records by id, keeps the first reading, and takes the earlier facts', () => {
    const into = session({
      id: 's1',
      agent: 'claudecode',
      cwd: '/first',
      createdAt: 300,
      sourceFile: '/first/s1.jsonl',
      records: [record({ id: 's1:m2', time: 200 }), record({ id: 's1:m1', time: 100 })],
    });
    const other = session({
      id: 's1',
      agent: 'claudecode',
      cwd: '/second',
      createdAt: 50,
      title: 'named by the second log',
      sourceFile: '/second/s1.jsonl',
      records: [record({ id: 's1:m1', time: 100 }), record({ id: 's1:m3', time: 300 })],
    });

    unionSessionRecords(into, other);

    // `s1:m1` is one API call although both logs carry it; `s1:m3` only the
    // second one does, and losing it is what a "second file wins" rule costs.
    expect(into.records.map((entry) => entry.id)).toEqual(['s1:m1', 's1:m2', 's1:m3']);
    // The reading that placed the session stays the base for its project facts.
    expect(into.cwd).toBe('/first');
    expect(into.createdAt).toBe(50);
    expect(into.title).toBe('named by the second log');
    expect(into.extra?.['sourceFiles']).toEqual(['/first/s1.jsonl', '/second/s1.jsonl']);
    expect(other.records).toHaveLength(2);
  });

  it('counts a session once when two datasets hold it', async () => {
    const id = 'shared-session';
    const reading = (name: string, ids: readonly string[]) =>
      dataset(
        [
          project({
            id: name,
            name,
            path: '/tmp/shared',
            sessions: [session({ id, agent: 'claudecode', cwd: '/tmp/shared', records: ids.map((recordId, index) => record({ id: recordId, time: 100 * (index + 1) })) })],
          }),
        ],
        { agent: 'claudecode', agents: ['claudecode'], source: `/data/${name}` },
      );

    const merged = await mergeDatasets([reading('first', [`${id}:m1`]), reading('second', [`${id}:m1`, `${id}:m2`])]);

    expect(merged.sessions).toHaveLength(1);
    expect(merged.sessions[0]?.records.map((entry) => entry.id)).toEqual([`${id}:m1`, `${id}:m2`]);
    expect(merged.stats.records).toBe(2);
    expect(merged.projects).toHaveLength(1);
    expect(merged.projects[0]?.sessions).toHaveLength(1);
  });

  it('says so, once, when two datasets carried the same session', async () => {
    const id = 'shared-session';
    const reading = (name: string, ids: readonly string[]) =>
      dataset(
        [
          project({
            id: name,
            name,
            path: '/tmp/shared',
            sessions: [
              session({
                id,
                agent: 'claudecode',
                cwd: '/tmp/shared',
                sourceFile: `/data/${name}/${id}.jsonl`,
                records: ids.map((recordId, index) => record({ id: recordId, time: 100 * (index + 1) })),
              }),
            ],
          }),
        ],
        { agent: 'claudecode', agents: ['claudecode'], source: `/data/${name}` },
      );

    const merged = await mergeDatasets([
      reading('first', [`${id}:m1`]),
      reading('second', [`${id}:m1`, `${id}:m2`]),
      reading('third', [`${id}:m1`]),
    ]);

    // Three readings, one session — and one warning, not two.
    const merged3 = merged.warnings.filter((warning) => warning.code === 'sessionMergedAcrossSources');
    expect(merged3).toHaveLength(1);
    expect(merged3[0]?.message).toContain(id);
    expect(merged3[0]?.message).toContain('claudecode');
    expect(merged3[0]?.message).toContain('/data/first/');
    expect(merged3[0]?.message).toContain('/data/third/');
  });

  it('names five sessions and sums up the rest when a whole root was read twice', async () => {
    // A duplicated root folds every session it holds: naming all of them is not
    // information, so five are named and the count carries the rest.
    const ids = ['s1', 's2', 's3', 's4', 's5', 's6'];
    const reading = (name: string) =>
      dataset(
        [
          project({
            id: name,
            name,
            path: '/tmp/shared',
            sessions: ids.map((id, index) =>
              session({
                id,
                agent: 'claudecode',
                cwd: '/tmp/shared',
                sourceFile: `/data/${name}/${id}.jsonl`,
                records: [record({ id: `${id}:m${index}`, time: 100 * (index + 1) })],
              }),
            ),
          }),
        ],
        { agent: 'claudecode', agents: ['claudecode'], source: `/data/${name}` },
      );

    const merged = await mergeDatasets([reading('first'), reading('second')]);

    // The union itself is untouched: one session per id, each with its request.
    expect(merged.sessions.map((entry) => entry.id).sort()).toEqual(ids);
    expect(merged.sessions.every((entry) => entry.records.length === 1)).toBe(true);

    const detail = merged.warnings.filter((warning) => warning.code === 'sessionMergedAcrossSources');
    const summary = merged.warnings.filter((warning) => warning.code === 'sessionMergedAcrossSourcesSummary');
    expect(detail).toHaveLength(5);
    expect(summary).toHaveLength(1);
    expect(summary[0]?.message).toContain('6');
    expect(summary[0]?.message).toContain('/data/first');
    // The five named ones are the first five identities, in a stable order.
    expect(detail.map((warning) => warning.message.match(/claudecode:(\S+?)\s/)?.[1])).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('stays quiet when no session was read twice', async () => {
    const id = 'only-once';
    const one = dataset(
      [
        project({
          id: 'p1',
          name: 'p1',
          path: '/tmp/shared',
          sessions: [session({ id, agent: 'claudecode', cwd: '/tmp/shared', records: [record({ id: `${id}:m1`, time: 100 })] })],
        }),
      ],
      { agent: 'claudecode', agents: ['claudecode'], source: '/data/one' },
    );
    const two = dataset(
      [
        project({
          id: 'p2',
          name: 'p2',
          path: '/tmp/other',
          sessions: [session({ id: 'another', agent: 'claudecode', cwd: '/tmp/other', records: [record({ id: 'another:m1', time: 100 })] })],
        }),
      ],
      { agent: 'claudecode', agents: ['claudecode'], source: '/data/two' },
    );

    const merged = await mergeDatasets([one, two]);
    expect(merged.sessions).toHaveLength(2);
    expect(merged.warnings.filter((warning) => warning.code === 'sessionMergedAcrossSources')).toHaveLength(0);
  });
});

describe('configured projects', () => {
  it('gathers the declared paths under the configured name', async () => {
    const one = agentDataset('dsh', { cwd: join(root, 'main'), projectId: 'main' });
    const two = agentDataset('claudecode', { cwd: join(root, 'plain'), projectId: 'plain' });
    const merged = await mergeDatasets([one, two], {
      projects: [{ name: 'Memolink', paths: [join(root, 'main'), join(root, 'plain')] }],
    });

    expect(merged.projects).toHaveLength(1);
    const [project0] = merged.projects;
    expect(project0?.name).toBe('Memolink');
    expect(project0?.id).toBe('project:Memolink');
    expect(project0?.agents).toEqual(['claudecode', 'dsh']);
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

describe('sessions that look copied', () => {
  /** One dataset holding one session, whose single request is named by `recordId`. */
  const one = (id: string, recordId: string, time = 1_000) =>
    dataset(
      [
        project({
          id: `p-${id}`,
          name: id,
          path: '/tmp/shared',
          sessions: [
            session({ id, agent: 'claudecode', cwd: '/tmp/shared', records: [record({ id: recordId, time })] }),
          ],
        }),
      ],
      { agent: 'claudecode', agents: ['claudecode'], source: `/data/${id}` },
    );

  it('says so when two different sessions hold identical records', async () => {
    // Two ids are two conversations, so the tool cannot fold them; it can only
    // tell the reader that the same work appears twice.
    const merged = await mergeDatasets([one('a', 'a:m1'), one('b', 'b:m1')]);
    const copied = merged.warnings.filter((entry) => entry.code === 'sessionsLookCopied');
    expect(copied).toHaveLength(1);
    expect(copied[0]?.params).toMatchObject({
      first: 'claudecode:a',
      second: 'claudecode:b',
      requests: '1',
    });
    expect(merged.sessions).toHaveLength(2);
  });

  it('stays quiet when the records differ or a session billed nothing', async () => {
    const different = await mergeDatasets([one('a', 'a:m1'), one('b', 'b:m1', 2_000)]);
    expect(different.warnings.map((entry) => entry.code)).not.toContain('sessionsLookCopied');

    const empty = dataset(
      [
        project({
          id: 'p-empty',
          name: 'empty',
          path: '/tmp/shared',
          sessions: [session({ id: 'z', agent: 'claudecode', cwd: '/tmp/shared', records: [] })],
        }),
      ],
      { agent: 'claudecode', agents: ['claudecode'], source: '/data/empty' },
    );
    const quiet = await mergeDatasets([empty, one('a', 'a:m1')]);
    expect(quiet.warnings.map((entry) => entry.code)).not.toContain('sessionsLookCopied');
  });

  it('names five groups and sums the rest', async () => {
    const datasets = [];
    for (let index = 0; index < 6; index += 1) {
      datasets.push(one(`x${index}`, `x${index}:m1`, 1_000 + index), one(`y${index}`, `y${index}:m1`, 1_000 + index));
    }
    const merged = await mergeDatasets(datasets);
    const codes = merged.warnings.map((entry) => entry.code);
    expect(codes.filter((code) => code === 'sessionsLookCopied')).toHaveLength(5);
    const summary = merged.warnings.find((entry) => entry.code === 'sessionsLookCopiedSummary');
    expect(summary?.params).toMatchObject({ count: '6', limit: '5' });
  });
});
