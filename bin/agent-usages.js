#!/usr/bin/env node
/**
 * Executable entry point.
 *
 * Node 22.6+ strips TypeScript types natively, so the CLI source is executed
 * directly — there is no build step and therefore no build output that can fall
 * out of sync with `src/`. `--no-warnings` suppresses the single
 * `ExperimentalWarning: Type Stripping` notice that older Node releases print.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const result = spawnSync(
  process.execPath,
  ['--no-warnings', '--enable-source-maps', entry, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

if (result.error !== undefined) {
  process.stderr.write(`agent-usages: 无法启动 ${process.execPath}: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
