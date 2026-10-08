/**
 * An application directory for a test run, so nothing touches the real one.
 *
 * The page's language switch writes `language` into the tool's own configuration
 * file (`PUT /api/settings`) — which is the point of the switch, and exactly why
 * a test must not do it to the developer's file. This copies the caches the scan
 * needs (prices, rates, state) into a scratch application directory, writes
 * `config/config.json` with the language the test expects, and points
 * `AGENT_USAGES_HOME` at it.
 *
 * Since the layout became one application directory (`<home>/{config,cache,data}`,
 * 2026-10-08) the isolation is a single environment variable — `XDG_*` is not read
 * at all — and the scratch directory has the same shape as the real one.
 *
 * The directory is `web/.tmp/app` (gitignored) and is rebuilt on every run: a
 * stale language there would silently flip the assertions.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The application directory's name, matching `src/config/paths.ts`. */
const APP_DIR = '.liruohrh.agent-usages';

/**
 * Point this process — and the server it starts — at a scratch application directory.
 * @param repo - the repository root.
 * @param language - the language to pin, `zh` or `en`.
 * @returns the scratch directory.
 */
export function isolateConfig(repo, language) {
  const root = join(repo, 'web', '.tmp', 'app');
  rmSync(root, { recursive: true, force: true });
  const configDir = join(root, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), `${JSON.stringify({ language }, null, 2)}\n`, 'utf8');

  // The live scan needs the cached price list and rates; without them it would
  // reach for the network. Copy whatever the real directory has (a machine with
  // none still works — it falls back to the shipped tables). `AGENT_USAGES_HOME`
  // wins over the default when a developer already moved theirs.
  const real = process.env['AGENT_USAGES_HOME'] ?? join(homedir(), APP_DIR);
  const realCache = join(real, 'cache');
  if (existsSync(realCache)) {
    const scratchCache = join(root, 'cache');
    mkdirSync(scratchCache, { recursive: true });
    for (const name of readdirSync(realCache)) {
      if (name.startsWith('cache-') || name === 'state.json') {
        cpSync(join(realCache, name), join(scratchCache, name));
      }
    }
  }
  process.env['AGENT_USAGES_HOME'] = root;
  return root;
}
