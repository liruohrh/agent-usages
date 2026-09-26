#!/usr/bin/env node
/**
 * Executable entry point.
 *
 * Two ways to run the same program, because TypeScript is only executable from a
 * checkout:
 *
 * - **Installed** (npm, `npx github:…`, a git dependency) the files live under
 *   `node_modules`, and Node refuses to strip types there — so the package ships
 *   the compiled `dist/` and we run that. It is plain JavaScript, so it also runs
 *   on the oldest Node this package supports.
 * - **A clone** has no build output at all: `src/` is the program, and Node
 *   22.6+ strips the types as it loads. `--experimental-strip-types` is what
 *   makes that work on 22.6–22.17 (from 23.6 on it is on by default and the flag
 *   is a no-op), and `--no-warnings` suppresses the notice those releases print.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const compiled = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const source = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const entry = existsSync(compiled) ? compiled : source;

const flags =
  entry === source
    ? ['--experimental-strip-types', '--no-warnings', '--enable-source-maps']
    : ['--enable-source-maps'];
const result = spawnSync(process.execPath, [...flags, entry, ...process.argv.slice(2)], { stdio: 'inherit' });

if (result.error !== undefined) {
  process.stderr.write(`agent-usages: 无法启动 ${process.execPath}: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
