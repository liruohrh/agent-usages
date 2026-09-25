/**
 * Path identity for workspaces.
 *
 * Two agents record the same directory in their own spelling: one writes the
 * path the user typed, another the symlink target, a third keeps a trailing
 * separator or a Windows backslash. Merging their datasets into one project
 * means deciding when two spellings name the same directory, so that decision
 * lives here — one function, used by the adapters *and* by the merge layer, so
 * a key computed on one side always matches the key computed on the other.
 *
 * Nothing here throws: a path that no longer exists (a session whose directory
 * was deleted) is normal input, and falls back to the resolved string.
 */

import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';

/**
 * Answers are stable for a run, and a report asks about the same paths twice.
 *
 * `realpathSync` hits the filesystem, so the cache matters: a merged report over
 * thousands of sessions would otherwise stat the same few directories once per
 * session.
 */
const canonicalCache = new Map<string, string>();

/**
 * A path in its canonical absolute form.
 *
 * The symlink target is used when the filesystem can name one, because two
 * agents pointed at the same checkout through different links really did use one
 * directory; the resolved string is the fallback for a path that is gone.
 * @param path - a filesystem path, absolute or relative.
 * @returns the absolute path, symlinks resolved when possible.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const cached = canonicalCache.get(absolute);
  if (cached !== undefined) return cached;
  let canonical = absolute;
  try {
    canonical = realpathSync(absolute);
  } catch {
    // Gone, unreadable, or not a directory that exists yet: the resolved string
    // is still a stable identity for this run.
  }
  canonicalCache.set(absolute, canonical);
  return canonical;
}

/**
 * Comparison key for a workspace path.
 *
 * Canonical form, forward slashes, no trailing separator, case folded — the
 * same rule the DSH adapter has always used to match a session's `cwd` against
 * its workspace registry, now shared so every agent and the merge layer agree.
 * @param path - a filesystem path.
 * @returns a stable comparison key.
 */
export function normalizePath(path: string): string {
  return canonicalPath(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * The workspace paths a project's sessions ran in.
 *
 * Deduplicated by {@link normalizePath} and sorted by that key, so the list is
 * stable across runs. The project's own `path` is used only when no session
 * recorded a working directory.
 * @param sessions - the project's sessions.
 * @param fallback - the project's declared path, when it has one.
 * @returns the display paths, deduplicated and sorted.
 */
export function workspacePathsOf(sessions: readonly { cwd: string | null }[], fallback = ''): string[] {
  const paths = new Map<string, string>();
  for (const session of sessions) {
    if (session.cwd === null || session.cwd.length === 0) continue;
    const key = normalizePath(session.cwd);
    if (!paths.has(key)) paths.set(key, canonicalPath(session.cwd));
  }
  if (paths.size === 0 && fallback.length > 0) paths.set(normalizePath(fallback), canonicalPath(fallback));
  return [...paths.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, path]) => path);
}

/**
 * The last segment of a path, tolerating Windows separators and trailing ones.
 * @param path - a filesystem path.
 * @returns the final segment, or the path itself when it has none.
 */
export function basenameOf(path: string): string {
  return basename(path.replace(/[\\/]+$/, '')) || path;
}
