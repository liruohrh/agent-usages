/**
 * Path prefixes: which directories a rule covers.
 *
 * Two features ask the same question — "is this directory inside that one?" —
 * and must answer it identically, or a root would be excluded from one and
 * deleted by the other:
 *
 * - the roots a run is told never to write to the database (the command line's
 *   `--store-exclude`, for data that is not the user's own);
 * - `store forget --root-prefix`, where a prefix is how a person names several
 *   roots at once (`~/Downloads/agentdatas` covering everything under it).
 *
 * The comparison is by whole path segment. A string prefix would be the easy
 * bug: `/a/b` would match `/a/bc`, and a rule the user wrote to protect one
 * directory would silently take another one with it.
 *
 * It lives here, below both callers, because `agents` may import `store` and
 * `store` may not import `agents`; the alternative is two implementations of a
 * rule that has to mean one thing.
 */

/** A path without its trailing separators, keeping a filesystem root intact. */
export function stripTrailingSeparators(path: string): string {
  let end = path.length;
  while (end > 1 && (path[end - 1] === '/' || path[end - 1] === '\\')) end -= 1;
  return path.slice(0, end);
}

/**
 * Whether a path is one of the given prefixes, or lies inside one of them.
 *
 * A trailing separator on either side is noise: `/a/b/` and `/a/b` are the same
 * directory, and the prefix itself counts as covered by itself. Case is folded
 * only where the platform does (two directories differing in case are two
 * directories on Linux and one on Windows).
 *
 * @param path - the directory to test, absolute.
 * @param prefixes - the prefixes to test against, absolute.
 * @returns `true` when the path is covered.
 */
export function isUnderPrefix(path: string, prefixes: readonly string[] | undefined): boolean {
  if (prefixes === undefined || prefixes.length === 0) return false;
  const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);
  const candidate = fold(stripTrailingSeparators(path));
  return prefixes.some((prefix) => {
    const trimmed = fold(stripTrailingSeparators(prefix));
    if (trimmed.length === 0) return false;
    return candidate === trimmed || candidate.startsWith(trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
  });
}
