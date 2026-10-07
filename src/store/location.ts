/**
 * Where the usage store lives when nobody names a path.
 *
 * The store is the user's data — records they may keep for years, back up, or
 * read with `sqlite3` — so it belongs in the data directory, not next to derived
 * caches (`XDG_CACHE_HOME`) or settings (`XDG_CONFIG_HOME`). Losing it costs a
 * full rescan, but it is not disposable either: it is the only place the history
 * of directories that no longer exist is kept.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** The directory this tool owns inside the data root. */
export const STORE_DIR_NAME = 'agent-usages';

/** The database file inside it. */
export const STORE_FILE_NAME = 'usage.db';

/**
 * The path of the usage store.
 * @param env - environment to read `XDG_DATA_HOME` / `HOME` from.
 * @returns an absolute path, or a bare file name when no home can be found.
 */
export function defaultStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['XDG_DATA_HOME'];
  const home = (env['HOME'] ?? env['USERPROFILE'] ?? '').trim();
  const root = home.length > 0 ? home : homedir();
  if (base !== undefined && base.trim().length > 0) return join(base.trim(), STORE_DIR_NAME, STORE_FILE_NAME);
  if (root.length === 0) return STORE_FILE_NAME;
  return join(root, '.local', 'share', STORE_DIR_NAME, STORE_FILE_NAME);
}
