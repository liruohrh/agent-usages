/**
 * Packaging tests.
 *
 * The tool reads its default price list and rate table from `config/` next to
 * `src/`, so a tarball without them installs a CLI that cannot price anything —
 * a failure that only shows up for a user, never in development. These assert on
 * the real `npm pack` listing instead of on the `files` field, so the check holds
 * however the field is later edited.
 */

import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

/**
 * The paths npm would put in the published tarball.
 *
 * `--ignore-scripts` skips the `prepack` web build: this checks *what* the
 * tarball contains, not that it is fresh (publishing runs the build, and a
 * `vite build` printing to stdout would also corrupt the JSON read below).
 */
function packedPaths(): string[] {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const [packed] = JSON.parse(output) as { files: { path: string }[] }[];
  return (packed?.files ?? []).map((file) => file.path);
}

describe('npm pack', () => {
  const paths = packedPaths();

  it('ships the configuration the runtime reads', () => {
    expect(paths).toContain('config/pricing.json');
    expect(paths).toContain('config/rates.json');
  });

  it('ships the entry points and the sources they import', () => {
    expect(paths).toContain('bin/agent-usages.js');
    expect(paths).toContain('src/cli.ts');
    expect(paths).toContain('src/config/pricing.ts');
  });

  it('ships the built front end, so `serve` needs no build on the user’s machine', () => {
    expect(paths).toContain('web/dist/index.html');
    expect(paths.some((path) => path.startsWith('web/dist/assets/') && path.endsWith('.js'))).toBe(true);
    expect(paths.some((path) => path.startsWith('web/dist/assets/') && path.endsWith('.css'))).toBe(true);
  });

  it('ships the holiday calendar next to the price list', () => {
    expect(paths).toContain('config/holidays.json');
  });

  it('ships the readme npm shows on the package page', () => {
    expect(paths).toContain('README.md');
  });

  it('leaves tests and local artifacts out', () => {
    expect(paths.some((path) => path.startsWith('test/'))).toBe(false);
    expect(paths.some((path) => path.endsWith('.log'))).toBe(false);
  });
});
