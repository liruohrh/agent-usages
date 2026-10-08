/**
 * Where the usage store lives when nobody names a path.
 *
 * Inside the application directory, under `data/`: the store is the user's data
 * — records they may keep for years, back up, or read with `sqlite3` — so it does
 * not share a directory with fetched price lists and update bookkeeping, and it
 * is never located by a convention the user has to know. `AGENT_USAGES_HOME`
 * moves the whole application directory; `XDG_DATA_HOME` is not consulted (see
 * `src/config/paths.ts` for why, and `src/config/legacy.ts` for the one-time move
 * out of the old location).
 *
 * Losing the database costs a full rescan, but it is not disposable either: it is
 * the only place the history of directories that no longer exist is kept.
 */

import { join } from 'node:path';
import { UserError } from '../i18n/errors.ts';

/**
 * The application directory inside the user's home.
 *
 * Repeated from `src/config/paths.ts` because the layers point one way: `config`
 * may import `store`, not the other way round. A test asserts the two agree, so
 * they cannot drift into naming different directories.
 */
const APP_DIR_NAME = '.liruohrh.agent-usages';

/** The sub-directory the database lives in, inside the application directory. */
export const STORE_DIR_NAME = 'data';

/** The database file inside it. */
export const STORE_FILE_NAME = 'usage.db';

/**
 * The path of the usage store.
 * @param env - environment to read `AGENT_USAGES_HOME` / `HOME` from.
 * @returns an absolute path.
 * @throws {UserError} when neither the override nor a home directory is available.
 */
export function defaultStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['AGENT_USAGES_HOME'];
  if (explicit !== undefined && explicit.trim().length > 0) {
    return join(explicit.trim(), STORE_DIR_NAME, STORE_FILE_NAME);
  }
  const home = (env['HOME'] ?? env['USERPROFILE'] ?? '').trim();
  if (home.length === 0) throw new UserError('appHomeUnset', {});
  return join(home, APP_DIR_NAME, STORE_DIR_NAME, STORE_FILE_NAME);
}
