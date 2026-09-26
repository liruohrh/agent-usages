/**
 * Where this tool keeps the user's own configuration and its caches.
 *
 * One directory, resolved the way the platform expects: `XDG_CONFIG_HOME` when
 * set, `%APPDATA%` on Windows, `~/.config` otherwise. Everything the tool writes
 * lives there, so "delete the folder" is always a complete reset.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** The directory holding this tool's configuration and cache. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg.trim().length > 0) return join(xdg.trim(), 'agent-usages');
  if (process.platform === 'win32') {
    const appData = env['APPDATA'];
    if (appData !== undefined && appData.trim().length > 0) return join(appData.trim(), 'agent-usages');
  }
  return join(env['HOME'] ?? homedir(), '.config', 'agent-usages');
}

/** The user's override file. */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'config.json');
}

/** A cached copy of one fetched configuration file. */
export function cachePath(kind: 'pricing' | 'rates' | 'holidays', env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), `cache-${kind}.json`);
}

/** A cached daily rate series for one currency pair. */
export function seriesPath(base: string, target: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), `cache-series-${base}-${target}.json`);
}

/** When the tool last looked for updates. */
export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'state.json');
}
