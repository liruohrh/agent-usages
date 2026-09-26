#!/usr/bin/env node
/**
 * Build the dashboard, so that `npm install github:…` produces a working UI.
 *
 * Installing from a git URL is not like installing a published tarball: npm
 * clones the repository, which contains the front end's *sources* and none of its
 * build output (`web/dist` is a local artifact and is not tracked). npm runs this
 * script for git dependencies — after installing them — which is the documented
 * hook for exactly this situation.
 *
 * Two rules keep it from becoming a nuisance:
 *
 * - **Under pnpm, do nothing.** The repository is a pnpm workspace, and a
 *   developer installing it that way builds the front end with `pnpm web:build`
 *   on purpose. Reaching for `npm install` inside their workspace would mix two
 *   package managers for no reason.
 * - **Never fail the install.** The CLI is useful without the dashboard — `serve`
 *   already answers with a page that says which command builds it — so a missing
 *   toolchain, no network or a broken build prints one line and exits 0. An
 *   install that half-works beats an install that refuses.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(repo, 'web');

/** The package manager npm was invoked as (`npm/11.12.1 node/v25.9.0 …`). */
const agent = process.env['npm_config_user_agent'] ?? '';

/** Say one line on stderr, where npm shows it without pretending it failed. */
function warn(message) {
  process.stderr.write(`agent-usages: ${message}\n`);
}

if (agent.startsWith('pnpm')) {
  // The workspace dev path: `pnpm web:build` is explicit, and `pnpm install`
  // must not start a second package manager inside `web/`.
  process.exit(0);
}

if (!existsSync(join(web, 'package.json'))) {
  warn('web/ is missing from this checkout; skipping the dashboard build');
  process.exit(0);
}

/** Run one command, quietly, and report whether it worked. */
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repo,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

// The front end has its own dependencies (vite, tailwind, react, echarts). A git
// install does not fetch them, so do it here — only when the build tool is
// actually absent, and quietly: npm is already printing enough.
if (!existsSync(join(web, 'node_modules', 'vite'))) {
  process.stdout.write('agent-usages: installing the dashboard dependencies (once)\n');
  if (!run('npm', ['--prefix', web, 'install', '--no-audit', '--no-fund', '--loglevel=error'])) {
    warn('could not install the dashboard dependencies; the CLI works, `serve` needs a built front end');
    process.exit(0);
  }
}

process.stdout.write('agent-usages: building the dashboard (once per install)\n');
if (!run('npm', ['--prefix', web, 'run', 'build']) || !existsSync(join(web, 'dist', 'index.html'))) {
  warn('the dashboard did not build; the CLI works, `serve` will say how to build it');
  process.exit(0);
}
process.stdout.write('agent-usages: dashboard ready\n');
