/**
 * A configuration directory for a test run, so nothing touches the real one.
 *
 * The page's language switch writes `language` into the tool's own configuration
 * file (`PUT /api/settings`) — which is the point of the switch, and exactly why
 * a test must not do it to the developer's file. This copies the caches the scan
 * needs (prices, rates, state) into a scratch directory, writes a `config.json`
 * with the language the test expects, and points `XDG_CONFIG_HOME` at it.
 *
 * The directory is `web/.tmp/config` (gitignored) and is rebuilt on every run:
 * a stale language there would silently flip the assertions.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Point this process — and the server it starts — at a scratch configuration.
 * @param repo - the repository root.
 * @param language - the language to pin, `zh` or `en`.
 * @returns the scratch directory.
 */
export function isolateConfig(repo, language) {
  const root = join(repo, 'web', '.tmp', 'config');
  rmSync(root, { recursive: true, force: true });
  const dir = join(root, 'agent-usages');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ language }, null, 2)}\n`, 'utf8');

  // The live scan needs the cached price list and rates; without them it would
  // reach for the network. Copy whatever the real directory has (a machine with
  // none still works — it falls back to the shipped tables).
  const real = join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'agent-usages');
  if (existsSync(real)) {
    for (const name of readdirSync(real)) {
      if (name.startsWith('cache-') || name === 'state.json') {
        cpSync(join(real, name), join(dir, name));
      }
    }
  }
  process.env['XDG_CONFIG_HOME'] = root;
  return root;
}
