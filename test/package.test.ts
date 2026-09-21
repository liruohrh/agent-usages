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

/** The paths npm would put in the published tarball. */
function packedPaths(): string[] {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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

  it('ships the readme npm shows on the package page', () => {
    expect(paths).toContain('README.md');
  });

  it('leaves tests and local artifacts out', () => {
    expect(paths.some((path) => path.startsWith('test/'))).toBe(false);
    expect(paths.some((path) => path.endsWith('.log'))).toBe(false);
  });
});
