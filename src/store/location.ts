/**
 * Where the scan cache lives when nobody names a directory.
 *
 * The cache is derived data — losing it costs a rescan and nothing else — so it
 * belongs in the cache directory, not in `~/.config` next to the settings a user
 * would miss. `XDG_CACHE_HOME` is honoured because that is what the variable is
 * for; a machine without a home directory gets a relative directory, which the
 * failure path of `save()` reports like any other unwritable path.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** The directory name this tool owns inside the cache root. */
export const SCAN_CACHE_DIR_NAME = 'agent-usages';

/**
 * The directory holding the scan cache.
 * @param env - environment to read `XDG_CACHE_HOME` / `HOME` from.
 * @returns an absolute directory, or a bare name when no home can be found.
 */
export function defaultScanCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['XDG_CACHE_HOME'];
  if (base !== undefined && base.trim().length > 0) return join(base.trim(), SCAN_CACHE_DIR_NAME);
  const home = (env['HOME'] ?? env['USERPROFILE'] ?? '').trim();
  if (home.length > 0) return join(home, '.cache', SCAN_CACHE_DIR_NAME);
  const fallback = homedir();
  return fallback.length > 0 ? join(fallback, '.cache', SCAN_CACHE_DIR_NAME) : SCAN_CACHE_DIR_NAME;
}
