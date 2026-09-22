/**
 * Repository detection.
 *
 * The fixtures are real directories: the detector's whole job is to read what
 * git wrote on disk (`.git` as a directory, a `gitdir:` pointer, a `HEAD`), so a
 * fake filesystem would test nothing but the mock.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { repoOf } from '../../src/core/git.ts';

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

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-usages-git-'));

  // A repository, a worktree of it, and a package opened on its own.
  await makeRepo(join(root, 'main'), 'master');
  await makeWorktree(join(root, 'main'), 'lynx-rewrite', 'ref: refs/heads/lynx-rewrite\n');
  await makeLinked(join(root, 'lynx-rewrite'), join(root, 'main', '.git', 'worktrees', 'lynx-rewrite'));
  await mkdir(join(root, 'main', 'packages', 'app'), { recursive: true });

  // A worktree with a detached HEAD: there is no branch to show.
  await makeWorktree(join(root, 'main'), 'detached', '5be326a000000000000000000000000000000000ff\n');
  await makeLinked(join(root, 'detached'), join(root, 'main', '.git', 'worktrees', 'detached'));

  // A worktree nested *inside* the repository, as Orca lays them out.
  await makeWorktree(join(root, 'main'), 'userws', 'ref: refs/heads/userws\n');
  await makeLinked(
    join(root, 'main', '.agents', 'worktrees', 'userws'),
    join(root, 'main', '.git', 'worktrees', 'userws'),
  );

  // A worktree whose pointer is relative, as git writes for submodules.
  await makeLinked(join(root, 'relative'), '../main/.git/worktrees/lynx-rewrite');

  // A submodule: a repository of its own, registered inside its parent.
  await makeRepo(join(root, 'super'), 'master');
  await mkdir(join(root, 'super', '.git', 'modules', 'inner'), { recursive: true });
  await writeFile(join(root, 'super', '.git', 'modules', 'inner', 'HEAD'), 'ref: refs/heads/inner\n');
  await makeLinked(join(root, 'super', 'inner'), join(root, 'super', '.git', 'modules', 'inner'));

  // A directory that is not in any repository at all.
  await mkdir(join(root, 'plain'), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('git repository detection', () => {
  it('names the repository a main working tree belongs to', async () => {
    expect(await repoOf(join(root, 'main'))).toEqual({
      name: 'main',
      root: join(root, 'main'),
      kind: 'main',
      branch: 'master',
    });
  });

  it('reads a worktree out of its gitdir pointer', async () => {
    expect(await repoOf(join(root, 'lynx-rewrite'))).toEqual({
      name: 'main',
      root: join(root, 'main'),
      kind: 'worktree',
      branch: 'lynx-rewrite',
    });
  });

  it('maps a directory inside a repository to that repository', async () => {
    expect(await repoOf(join(root, 'main', 'packages', 'app'))).toEqual({
      name: 'main',
      root: join(root, 'main'),
      kind: 'subdir',
      branch: 'master',
    });
  });

  it('gives a worktree inside the repository its own badge', async () => {
    // The nearest `.git` wins, so the nested worktree is not mistaken for the
    // repository it lives in.
    expect(await repoOf(join(root, 'main', '.agents', 'worktrees', 'userws'))).toEqual({
      name: 'main',
      root: join(root, 'main'),
      kind: 'worktree',
      branch: 'userws',
    });
  });

  it('resolves a relative gitdir against the directory holding it', async () => {
    expect(await repoOf(join(root, 'relative'))).toMatchObject({ kind: 'worktree', branch: 'lynx-rewrite' });
  });

  it('leaves the branch out of a detached HEAD', async () => {
    expect(await repoOf(join(root, 'detached'))).toEqual({
      name: 'main',
      root: join(root, 'main'),
      kind: 'worktree',
    });
  });

  it('treats a submodule as a repository of its own', async () => {
    expect(await repoOf(join(root, 'super', 'inner'))).toEqual({
      name: 'inner',
      root: join(root, 'super', 'inner'),
      kind: 'submodule',
      branch: 'inner',
    });
  });

  it('says nothing about a directory that is not in a repository', async () => {
    expect(await repoOf(join(root, 'plain'))).toBeUndefined();
    expect(await repoOf(join(root, 'plain', 'deeper', 'still'))).toBeUndefined();
    expect(await repoOf(join(root, 'never-existed'))).toBeUndefined();
  });
});
