/**
 * Start the platform for the end-to-end tests.
 *
 * The offline snapshot is preferred: the front end's job is to show what the API
 * says, and a fixture makes the numbers in the assertions stable. `pnpm
 * web:snapshot` writes one; without it the tests run against a live scan, which
 * works but measures the machine as it grows.
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isolateConfig } from './tmp-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const snapshot = join(repo, 'web', 'mock', 'dashboard.snapshot.json');
const port = process.env.E2E_PORT ?? '4317';

// Pin the language: the page's switch writes the configuration file, and the
// assertions are written in Chinese. A copy in a scratch directory keeps both the
// test deterministic and the developer's own file untouched.
isolateConfig(repo, 'zh');

const args = ['serve', '--port', port, '--no-update'];
if (existsSync(snapshot)) args.push('--snapshot', snapshot);
else process.stdout.write(`e2e: no snapshot at ${snapshot}, scanning live data\n`);

const child = spawn(process.execPath, [join(repo, 'src', 'cli.ts'), ...args], { stdio: 'inherit' });
const stop = () => {
  child.kill('SIGINT');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
