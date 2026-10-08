/**
 * The application directory, and the one-time move out of the XDG layout.
 *
 * Two things are pinned here. First, where every file goes: one directory in the
 * user's home with `config/`, `cache/` and `data/` under it, moved by
 * `AGENT_USAGES_HOME`, and *never* by `XDG_*` — a test that set `XDG_CONFIG_HOME`
 * and expected a different answer would be the bug this layout exists to remove.
 * Second, that the move from the old layout is dull: idempotent, never
 * overwriting, never failing a run, and silent when there was nothing to move.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { legacyMigrationWarnings, migrateLegacyLayout } from '../../src/config/legacy.ts';
import {
  APP_DIR_NAME,
  agentUsagesHome,
  cacheDir,
  cachePath,
  configDir,
  seriesPath,
  statePath,
  userConfigPath,
} from '../../src/config/paths.ts';
import { readUserConfig } from '../../src/config/user.ts';
import { defaultStorePath, STORE_DIR_NAME, STORE_FILE_NAME } from '../../src/store/location.ts';

/**
 * A home directory of its own, plus the application directory under it.
 *
 * The XDG variables are removed rather than inherited: the migration reads them
 * to find an old installation, and a test that passed the developer's own
 * environment through would go looking in their real config directory.
 */
function scratchHome(): { home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), 'agent-usages-layout-'));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'AGENT_USAGES_HOME']) delete env[name];
  return { home, env };
}

/** The code of the error a function threw, or a sentence saying it did not. */
function caught(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).name;
  }
  return 'no error';
}

/** Write a file, creating its directory. */
function put(path: string, contents: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

describe('the application directory', () => {
  it('sits in the home directory, with one sub-directory per kind of data', () => {
    const { home, env } = scratchHome();
    const root = join(home, APP_DIR_NAME);
    expect(agentUsagesHome(env)).toBe(root);
    expect(configDir(env)).toBe(join(root, 'config'));
    expect(cacheDir(env)).toBe(join(root, 'cache'));
    expect(userConfigPath(env)).toBe(join(root, 'config', 'config.json'));
    expect(cachePath('pricing', env)).toBe(join(root, 'cache', 'cache-pricing.json'));
    expect(seriesPath('CNY', 'EUR', env)).toBe(join(root, 'cache', 'cache-series-CNY-EUR.json'));
    expect(statePath(env)).toBe(join(root, 'cache', 'state.json'));
    // The store is the `data/` side of the same directory, named by the store's
    // own layer — the two must not drift into different homes.
    expect(defaultStorePath(env)).toBe(join(root, STORE_DIR_NAME, STORE_FILE_NAME));
  });

  it('is moved by AGENT_USAGES_HOME, and falls back to HOME or USERPROFILE', () => {
    const override = join(tmpdir(), 'agent-usages-elsewhere');
    expect(agentUsagesHome({ AGENT_USAGES_HOME: override, HOME: '/ignored' })).toBe(override);
    expect(defaultStorePath({ AGENT_USAGES_HOME: override, HOME: '/ignored' })).toBe(join(override, 'data', 'usage.db'));
    expect(agentUsagesHome({ HOME: '/home/someone' })).toBe(join('/home/someone', APP_DIR_NAME));
    expect(agentUsagesHome({ USERPROFILE: 'C:\\Users\\someone' })).toContain(APP_DIR_NAME);
    // An empty override is not an override.
    expect(agentUsagesHome({ AGENT_USAGES_HOME: '  ', HOME: '/home/someone' })).toBe(join('/home/someone', APP_DIR_NAME));
  });

  it('says so when there is no home to put it in', () => {
    const nothing = { PATH: '/usr/bin' } as NodeJS.ProcessEnv;
    // The code, not the sentence: the catalogue decides the wording, this decides
    // that the failure is the one a caller can act on.
    expect(caught(() => agentUsagesHome(nothing))).toBe('appHomeUnset');
    expect(caught(() => defaultStorePath(nothing))).toBe('appHomeUnset');
  });

  it('never reads XDG_CONFIG_HOME, XDG_DATA_HOME or XDG_CACHE_HOME', () => {
    const { home, env } = scratchHome();
    const xdg = join(home, 'xdg');
    put(join(xdg, 'agent-usages', 'config.json'), JSON.stringify({ language: 'en' }));
    put(join(xdg, 'agent-usages', 'cache-pricing.json'), '{}');
    const withXdg: NodeJS.ProcessEnv = {
      ...env,
      XDG_CONFIG_HOME: xdg,
      XDG_DATA_HOME: join(xdg, 'data'),
      XDG_CACHE_HOME: join(xdg, 'cache'),
    };
    expect(agentUsagesHome(withXdg)).toBe(join(home, APP_DIR_NAME));
    expect(userConfigPath(withXdg)).toBe(join(home, APP_DIR_NAME, 'config', 'config.json'));
    expect(cachePath('pricing', withXdg)).toBe(join(home, APP_DIR_NAME, 'cache', 'cache-pricing.json'));
    expect(defaultStorePath(withXdg)).toBe(join(home, APP_DIR_NAME, 'data', 'usage.db'));

    // And a configuration file sitting under XDG is not quietly adopted.
    const loaded = readUserConfig(withXdg);
    expect(loaded.config.language).toBeUndefined();
    expect(existsSync(join(xdg, 'agent-usages', 'config.json'))).toBe(true);
  });
});

describe('moving an old installation', () => {
  /** A home with the old XDG layout populated: config, caches, database, and the retired scan cache. */
  function legacyHome(): { home: string; env: NodeJS.ProcessEnv; storePath: string; legacy: Record<string, string> } {
    const { home, env } = scratchHome();
    const legacyConfig = join(home, '.config', 'agent-usages');
    const legacyData = join(home, '.local', 'share', 'agent-usages');
    const legacyCache = join(home, '.cache', 'agent-usages');
    const files = {
      config: join(legacyConfig, 'config.json'),
      pricing: join(legacyConfig, 'cache-pricing.json'),
      rates: join(legacyConfig, 'cache-rates.json'),
      state: join(legacyConfig, 'state.json'),
      database: join(legacyData, 'usage.db'),
      wal: join(legacyData, 'usage.db-wal'),
      backup: join(legacyData, 'usage.db.bak-v2'),
      unrelated: join(legacyData, 'README'),
      scanCache: join(legacyCache, 'scan-cache.json'),
    };
    for (const [name, path] of Object.entries(files)) {
      // Real JSON for the configuration, so the test can show it is the file the
      // tool reads after the move; anything else just needs to be recognisable.
      put(path, name === 'config' ? '{"version":1,"language":"en"}' : `contents of ${name}`);
    }
    return { home, env, storePath: defaultStorePath(env), legacy: files };
  }

  it('moves configuration, caches and the database into the application directory', () => {
    const { home, env, storePath, legacy } = legacyHome();
    const result = migrateLegacyLayout(env, storePath);
    const root = join(home, APP_DIR_NAME);

    expect(result.failed).toEqual([]);
    expect(result.moved.map((entry) => entry.to).sort()).toEqual([
      join(root, 'cache', 'cache-pricing.json'),
      join(root, 'cache', 'cache-rates.json'),
      join(root, 'cache', 'state.json'),
      join(root, 'config', 'config.json'),
      join(root, 'data', 'usage.db'),
      join(root, 'data', 'usage.db-wal'),
      join(root, 'data', 'usage.db.bak-v2'),
    ].sort());
    // The files are where they belong now, contents intact...
    expect(readFileSync(join(root, 'config', 'config.json'), 'utf8')).toBe('{"version":1,"language":"en"}');
    expect(readFileSync(storePath, 'utf8')).toBe('contents of database');
    expect(readFileSync(join(root, 'data', 'usage.db.bak-v2'), 'utf8')).toBe('contents of backup');
    // ...and no longer in the old places.
    for (const [name, path] of Object.entries(legacy)) {
      if (name === 'scanCache' || name === 'unrelated') continue;
      expect(existsSync(path), `${name} should have moved`).toBe(false);
    }

    // The retired JSON scan cache is not ours to move or delete, and a file we
    // never wrote is left alone.
    expect(existsSync(legacy['scanCache'] as string)).toBe(true);
    expect(existsSync(legacy['unrelated'] as string)).toBe(true);

    // The configuration that moved is the one the tool now reads.
    expect(readUserConfig(env).config.language).toBe('en');
  });

  it('does nothing the second time, and nothing when there is no old installation', () => {
    const { env, storePath } = legacyHome();
    expect(migrateLegacyLayout(env, storePath).moved).toHaveLength(7);
    const again = migrateLegacyLayout(env, storePath);
    expect(again.moved).toEqual([]);
    expect(again.failed).toEqual([]);
    expect(legacyMigrationWarnings(again, env)).toEqual([]);

    const fresh = scratchHome();
    const untouched = migrateLegacyLayout(fresh.env, defaultStorePath(fresh.env));
    expect(untouched).toEqual({ moved: [], failed: [] });
    expect(legacyMigrationWarnings(untouched, fresh.env)).toEqual([]);
  });

  it('keeps what the new location already holds', () => {
    const { home, env, storePath, legacy } = legacyHome();
    const root = join(home, APP_DIR_NAME);
    put(join(root, 'config', 'config.json'), 'the new file');
    put(join(root, 'data', 'usage.db'), 'the new database');

    const result = migrateLegacyLayout(env, storePath);
    // Nothing overwritten: the new files win, the old ones stay where they are.
    expect(readFileSync(join(root, 'config', 'config.json'), 'utf8')).toBe('the new file');
    expect(readFileSync(storePath, 'utf8')).toBe('the new database');
    expect(existsSync(legacy['config'] as string)).toBe(true);
    expect(existsSync(legacy['database'] as string)).toBe(true);
    // Everything else still moved.
    expect(result.moved.map((entry) => entry.to)).not.toContain(join(root, 'config', 'config.json'));
    expect(result.moved.map((entry) => entry.to)).toContain(join(root, 'cache', 'state.json'));
    expect(result.failed).toEqual([]);
  });

  it('reports a file it could not move and keeps going', () => {
    const { home, env, storePath, legacy } = legacyHome();
    // A regular file where the config directory should be: the move cannot create
    // its destination, and that must not stop the rest or fail the run.
    writeFileSync(join(home, APP_DIR_NAME), 'not a directory', 'utf8');
    const result = migrateLegacyLayout(env, storePath);

    // Every move failed for the same reason — there is nowhere to put them — and
    // each one is named rather than swallowed.
    expect(result.failed).toHaveLength(7);
    expect(result.failed.map((entry) => entry.path)).toContain(legacy['config']);
    expect(result.failed[0]?.reason.length).toBeGreaterThan(0);
    expect(result.moved).toEqual([]);
    // Nothing half-moved: every old file is still where it was.
    for (const path of Object.values(legacy)) {
      expect(existsSync(path), `${path} should still be there`).toBe(true);
    }
    const warnings = legacyMigrationWarnings(result, env);
    expect(warnings.map((warning) => warning.code)).toContain('appHomeMigrateFailed');
    expect(warnings.every((warning) => warning.message.length > 0)).toBe(true);
    rmSync(join(home, APP_DIR_NAME), { force: true });
  });

  it('warns once, naming both ends, when it actually moved something', () => {
    const { home, env, storePath } = legacyHome();
    const result = migrateLegacyLayout(env, storePath);
    const warnings = legacyMigrationWarnings(result, env);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('appHomeMigrated');
    const message = warnings[0]?.message ?? '';
    // One line, not one per file: where it came from and where it is now.
    expect(message).toContain(join(home, '.config', 'agent-usages'));
    expect(message).toContain(join(home, '.local', 'share', 'agent-usages'));
    expect(message).toContain(join(home, APP_DIR_NAME));
    expect(message).toContain('7');
  });
});
