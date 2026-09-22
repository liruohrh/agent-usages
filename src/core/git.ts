/**
 * Git repository detection for project directories.
 *
 * Agents key projects by *directory*, but a repository is not a directory: one
 * repository shows up as the main working tree, plus one project per
 * `git worktree` checked out elsewhere (Orca-style tools put them under
 * `~/orca/workspaces/<repo>/<name>`), plus any subdirectory someone opened on
 * its own. The report can only add those up if it knows which directories share
 * a repository, so this module answers exactly that.
 *
 * Nothing here shells out to `git`: the answer is in two files.
 *
 * | on disk | meaning |
 * | --- | --- |
 * | `<path>/.git` is a directory | this path is the repository's main working tree |
 * | `<path>/.git` is a file | `<path>` is a linked checkout; the file holds `gitdir: <dir>` |
 * | `gitdir` under `.git/worktrees/<name>` | a `git worktree`; the repository is the part before `.git` |
 * | `gitdir` under `.git/modules/<name>` | a submodule, which is a repository of its own |
 *
 * A path inside a repository but not at its root (a monorepo package opened
 * directly) resolves to the repository too, and is marked `subdir`.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { RepoInfo } from './types.ts';

/** How far up the tree to look before giving up. */
const MAX_DEPTH = 64;

/** Answers are stable for a run, and a report asks about the same paths twice. */
const cache = new Map<string, Promise<RepoInfo | undefined>>();

/**
 * The git repository a directory belongs to.
 *
 * @param path - a project directory; absolute, but relative paths are resolved.
 * @returns the repository, or `undefined` when the path is not inside one (or no
 *   longer exists) — the report then treats the project as standing alone.
 */
export function repoOf(path: string): Promise<RepoInfo | undefined> {
  const key = resolve(path);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const pending = detect(key);
  cache.set(key, pending);
  return pending;
}

/** Walk up from `start` to the nearest `.git` marker and read what it says. */
async function detect(start: string): Promise<RepoInfo | undefined> {
  let current = start;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const marker = join(current, '.git');
    const kind = await markerType(marker);
    if (kind === 'dir') {
      const branch = await readBranch(join(marker, 'HEAD'));
      return {
        name: basename(current),
        root: current,
        kind: current === start ? 'main' : 'subdir',
        ...(branch === undefined ? {} : { branch }),
      };
    }
    if (kind === 'file') return readLinked(current, marker);
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** Whether `.git` is a directory, a file, or absent. */
async function markerType(marker: string): Promise<'dir' | 'file' | undefined> {
  try {
    const info = await stat(marker);
    return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a linked checkout's `.git` file: a `gitdir:` pointer, an optional
 * `commondir:` line, and nothing else.
 *
 * @param current - the directory holding the `.git` file.
 * @param marker - the `.git` file's path.
 * @returns the repository this checkout belongs to, or `undefined` when the
 *   pointer is missing or names a layout this module does not recognise.
 */
async function readLinked(current: string, marker: string): Promise<RepoInfo | undefined> {
  let text: string;
  try {
    text = await readFile(marker, 'utf8');
  } catch {
    return undefined;
  }
  const raw = /^\s*gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
  if (raw === undefined) return undefined;
  const gitdir = isAbsolute(raw) ? resolve(raw) : resolve(current, raw);
  const branch = await readBranch(join(gitdir, 'HEAD'));

  // A worktree's gitdir is `<common>/worktrees/<name>`; `<common>` is the main
  // repository's `.git` directory, so its parent is the main working tree.
  const worktree = splitAtSegment(gitdir, 'worktrees');
  if (worktree !== undefined) {
    const common = worktree;
    const root = basename(common) === '.git' ? dirname(common) : common;
    return {
      name: basename(root),
      root,
      kind: 'worktree',
      ...(branch === undefined ? {} : { branch }),
    };
  }

  // A submodule's gitdir lives inside its parent's `.git/modules/<name>`. The
  // submodule is a repository in its own right, so it is named after itself.
  if (splitAtSegment(gitdir, 'modules') !== undefined) {
    return {
      name: basename(current),
      root: current,
      kind: 'submodule',
      ...(branch === undefined ? {} : { branch }),
    };
  }

  // Unrecognised pointer (a hand-written file, a layout this module does not
  // know): better to say nothing than to guess a repository.
  return undefined;
}

/**
 * The path before the last `<segment>/<name>` pair, or `undefined`.
 *
 * @param path - a path to inspect.
 * @param segment - the directory name to split on, e.g. `worktrees`.
 * @returns the part before `<segment>/<name>`, or `undefined` when absent.
 */
function splitAtSegment(path: string, segment: string): string | undefined {
  const parts = path.split(/[\\/]/);
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    if (parts[index] === segment) return parts.slice(0, index).join('/');
  }
  return undefined;
}

/**
 * The checked-out branch named by a `HEAD` file.
 *
 * @param head - path to `HEAD`.
 * @returns the branch name, or `undefined` for a detached `HEAD` (a raw commit
 *   id) or an unreadable file.
 */
async function readBranch(head: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(head, 'utf8');
  } catch {
    return undefined;
  }
  const ref = /^\s*ref:\s*(\S+)\s*$/.exec(text)?.[1];
  if (ref === undefined) return undefined;
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}
