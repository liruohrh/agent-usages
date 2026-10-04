/**
 * Reading a data-root value out of the environment.
 *
 * An agent's data can live in more than one directory, and every one of them is
 * named the same way: a comma-separated list. The rules are deliberately boring,
 * because they apply to `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `DSH_HOME` and
 * `PI_CODING_AGENT_DIR` alike — split on commas, trim the parts, drop the empty
 * ones, keep the order, and never read the same directory twice.
 *
 * This module deliberately depends on nothing but the path helpers: every
 * adapter imports it, and an adapter must not drag the registry (and with it
 * every other adapter) in.
 */

import { normalizePath } from '../core/paths.ts';

/**
 * Split one data-root value.
 * @param value - the environment variable's value, e.g. `/a, /b`.
 * @returns the non-empty, trimmed roots, in the order written.
 */
export function splitRoots(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Deduplicate roots, comparing them the way the merge layer compares paths.
 *
 * `/a/` and `/a` are one directory, and so are a path and its symlink: two
 * spellings of one root would otherwise be read twice. The first spelling wins,
 * so a warning quotes the one the user wrote.
 *
 * @param roots - roots in priority order.
 * @returns the same list without repeats.
 */
export function uniqueRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const root of roots) {
    const trimmed = root.trim();
    if (trimmed.length === 0) continue;
    const key = normalizePath(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}
