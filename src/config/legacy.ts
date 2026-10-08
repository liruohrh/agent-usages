/**
 * Moving an installation left by an older version into the application directory.
 *
 * Before this release the tool followed XDG: the user's configuration and the
 * fetched caches under `$XDG_CONFIG_HOME/agent-usages`, the scan database under
 * `$XDG_DATA_HOME/agent-usages`. Now there is one directory
 * (`src/config/paths.ts`), and a user who upgrades should not have to find their
 * own history and move it by hand.
 *
 * The rules are deliberately dull, because this runs against the user's files:
 *
 * - **Move, never copy-and-delete**: `rename`, with a copy fallback only for a
 *   cross-device move. The old location is left with the directories in place and
 *   the moved files gone.
 * - **Never overwrite**: a file that already exists in the new location wins, and
 *   the old one is left where it is. A half-migrated machine stays usable, and
 *   nothing a newer version wrote can be replaced by an older copy.
 * - **Never fail a run**: a file that cannot be moved is reported and skipped.
 * - **Only when something moved** does the caller say anything: a warning on a
 *   fresh install would be noise about a layout the user never had.
 * - **Not everything old is ours to touch**: `~/.cache/agent-usages/scan-cache.json`
 *   (the JSON scan cache retired in 0.1.0) is ignored rather than moved or
 *   deleted — it is the user's file, and the documentation says it can go.
 *
 * It is a pure function of the environment and the paths, called explicitly by
 * the entry points (`src/cli/index.ts`, `src/serve/main.ts`); a library user that
 * never calls it simply has no legacy location, which is the truth for a fresh
 * install.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { UserError, type Warning } from '../i18n/errors.ts';
import { agentUsagesHome, cacheDir, configDir, USER_CONFIG_FILE_NAME } from './paths.ts';

/** One file that was moved, for the warning and for tests. */
export interface MovedFile {
  /** Where it was. */
  from: string;
  /** Where it is now. */
  to: string;
}

/** What one migration pass did. */
export interface LegacyMigration {
  /** Files that were moved, in the order they were handled. */
  moved: MovedFile[];
  /** Files that could not be moved, with the reason, and which stayed put. */
  failed: { path: string; reason: string }[];
}

/**
 * The old XDG locations of this application's files, as an older version left them.
 *
 * Reading XDG here is the point: this function exists to *find* the old layout
 * and leave it behind. The new layout (`paths.ts`) never consults these
 * variables.
 * @param env - environment to read `XDG_*` / platform defaults from.
 * @returns the directories an older version wrote to.
 */
function legacyDirs(env: NodeJS.ProcessEnv): { config: string; data: string } {
  const config = env['XDG_CONFIG_HOME']?.trim();
  const data = env['XDG_DATA_HOME']?.trim();
  const home = (env['HOME'] ?? env['USERPROFILE'] ?? '').trim();
  const appData = process.platform === 'win32' ? env['APPDATA']?.trim() : undefined;
  const configBase = config !== undefined && config.length > 0
    ? config
    : appData !== undefined && appData.length > 0
      ? appData
      : join(home, '.config');
  return {
    config: join(configBase, 'agent-usages'),
    data: data !== undefined && data.length > 0 ? join(data, 'agent-usages') : join(home, '.local', 'share', 'agent-usages'),
  };
}

/**
 * Move one file, creating the destination directory, without overwriting anything.
 *
 * Nothing to move is not a failure: on a fresh installation none of the old paths
 * exist, and a migration that reported each of them as a problem would greet every
 * new user with warnings about a layout they never had.
 */
function moveFile(from: string, to: string, result: LegacyMigration): void {
  if (!existsSync(from) || existsSync(to)) return;
  try {
    mkdirSync(dirname(to), { recursive: true });
    try {
      renameSync(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      // Another filesystem: there is no atomic move between devices, so copy and
      // only then remove the original.
      copyFileSync(from, to);
      rmSync(from, { force: true });
    }
    result.moved.push({ from, to });
  } catch (error) {
    result.failed.push({ path: from, reason: (error as Error).message });
  }
}

/** Every file directly inside a directory, or none when it is not there. */
function filesIn(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Move anything an older version left in the XDG locations into the application
 * directory.
 *
 * Idempotent by construction: every move skips a destination that already
 * exists, so running it twice does nothing the second time; and nothing outside
 * the files named below is looked at, moved or removed.
 *
 * @param env - environment to read the paths from.
 * @param storePath - where the database lives now (`defaultStorePath(env)`), which
 *   also names the files it was called in the old location. Passed in because the
 *   store's layout belongs to the `store` layer, which this one may not import.
 * @returns what moved and what could not.
 */
export function migrateLegacyLayout(env: NodeJS.ProcessEnv, storePath: string): LegacyMigration {
  const result: LegacyMigration = { moved: [], failed: [] };
  const legacy = legacyDirs(env);

  // The configuration file, then the caches beside it, then the bookkeeping file
  // an older version kept with them.
  moveFile(join(legacy.config, USER_CONFIG_FILE_NAME), join(configDir(env), USER_CONFIG_FILE_NAME), result);
  for (const name of filesIn(legacy.config)) {
    if (name.startsWith('cache-') && name.endsWith('.json')) {
      moveFile(join(legacy.config, name), join(cacheDir(env), name), result);
    }
  }
  moveFile(join(legacy.config, 'state.json'), join(cacheDir(env), 'state.json'), result);

  // The database and everything that belongs to it: the write-ahead log, the
  // shared-memory file, and the copies a migration or a rebuild left behind. They
  // are named after the database, so the caller's own path says which files they
  // are.
  const database = basename(storePath);
  for (const name of filesIn(legacy.data)) {
    if (name === database || name.startsWith(`${database}-`) || name.startsWith(`${database}.`)) {
      moveFile(join(legacy.data, name), join(dirname(storePath), name), result);
    }
  }
  return result;
}

/**
 * The warning a migration earns, if it did anything.
 *
 * One line saying where the files came from and where they are now — not one per
 * file, which would be a wall of paths nobody reads — plus one line per file that
 * could not be moved, because a file left behind in a directory the user thinks
 * is abandoned is worth knowing about.
 *
 * @param result - what {@link migrateLegacyLayout} did.
 * @param env - environment the migration ran with, so the warning names the same
 *   application directory it moved things into.
 * @returns the warnings to show, in order; empty when nothing happened.
 */
export function legacyMigrationWarnings(result: LegacyMigration, env: NodeJS.ProcessEnv = process.env): Warning[] {
  const warnings: Warning[] = [];
  if (result.moved.length > 0) {
    const from = [...new Set(result.moved.map((entry) => dirname(entry.from)))].join(', ');
    const to = agentUsagesHome(env);
    warnings.push(new UserError('appHomeMigrated', { count: String(result.moved.length), from, to }));
  }
  for (const failure of result.failed) {
    warnings.push(new UserError('appHomeMigrateFailed', { path: failure.path, reason: failure.reason }));
  }
  return warnings;
}
