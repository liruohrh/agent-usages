/**
 * Where this tool keeps everything it owns: one application directory.
 *
 * Deliberately *not* the XDG layout. `$XDG_CONFIG_HOME/agent-usages` for
 * settings and caches, `$XDG_DATA_HOME/agent-usages` for the scan database,
 * splits one application's files across directories chosen by a convention the
 * user cannot see — and the file that actually matters (years of history, the
 * only copy of it for directories that no longer exist) ends up somewhere nobody
 * would think to look when backing up. One directory with three sub-directories
 * is what a phone app does, and what "copy this folder to another machine" needs:
 *
 * ```text
 * ~/.liruohrh.agent-usages/
 * ├── config/config.json
 * ├── cache/cache-pricing.json, cache-rates.json, cache-holidays.json, state.json
 * └── data/usage.db (+ -wal, -shm, backups)
 * ```
 *
 * `AGENT_USAGES_HOME` moves the whole thing; `XDG_CONFIG_HOME`,
 * `XDG_CACHE_HOME` and `XDG_DATA_HOME` are never consulted here. The one place
 * that still looks at them is `legacy.ts`, which moves an installation an older
 * version left there into this directory once — reading a layout in order to
 * leave it is not the same as following it.
 */

import { join } from 'node:path';
import { UserError } from '../i18n/errors.ts';

/** The application directory inside the user's home. */
export const APP_DIR_NAME = '.liruohrh.agent-usages';

/** The sub-directory holding the user's configuration. */
export const CONFIG_DIR_NAME = 'config';

/** The sub-directory holding fetched configuration and rate caches. */
export const CACHE_DIR_NAME = 'cache';

/** The sub-directory holding the scan database. */
export const DATA_DIR_NAME = 'data';

/** The user's override file, inside the config directory. */
export const USER_CONFIG_FILE_NAME = 'config.json';

/**
 * The application directory: everything this tool writes lives under it.
 *
 * `AGENT_USAGES_HOME` when it is set (that is also how tests keep their work out
 * of a real home), `$HOME/.liruohrh.agent-usages` otherwise. `USERPROFILE` is
 * read after `HOME` because a Windows shell often leaves `HOME` unset.
 *
 * @param env - environment to read the override and the home directory from.
 * @returns an absolute path.
 * @throws {UserError} when neither the override nor a home directory is available:
 *   there is nowhere to write, and guessing would put a database where the user
 *   never named.
 */
export function agentUsagesHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['AGENT_USAGES_HOME'];
  if (explicit !== undefined && explicit.trim().length > 0) return join(explicit.trim());
  const home = (env['HOME'] ?? env['USERPROFILE'] ?? '').trim();
  if (home.length === 0) throw new UserError('appHomeUnset', {});
  return join(home, APP_DIR_NAME);
}

/** The directory holding the user's configuration. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentUsagesHome(env), CONFIG_DIR_NAME);
}

/** The directory holding caches: fetched lists and the update bookkeeping. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentUsagesHome(env), CACHE_DIR_NAME);
}

/** The user's override file. */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), USER_CONFIG_FILE_NAME);
}

/** A cached copy of one fetched configuration file. */
export function cachePath(kind: 'pricing' | 'rates' | 'holidays', env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheDir(env), `cache-${kind}.json`);
}

/** A cached daily rate series for one currency pair. */
export function seriesPath(base: string, target: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheDir(env), `cache-series-${base}-${target}.json`);
}

/** When the tool last looked for updates: a note to itself, not a setting. */
export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheDir(env), 'state.json');
}
