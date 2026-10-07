/**
 * The install path, and the promise that it never needs a doc edit.
 *
 * Two things can rot silently here, and neither shows up in the CLI suite:
 *
 * - **A versioned URL creeping back into the docs.** The whole point of the fixed
 *   asset names (`agent-usages.tgz`, `install.sh`, …) is that
 *   `releases/latest/download/install.sh` stays correct forever, so a release never
 *   edits a document. One copy-pasted `…/releases/download/v0.0.3/…` undoes that;
 *   this checks both the docs and the release workflow that uploads the fixed names.
 * - **The wrapper and installer contracts.** `install.mjs` must keep saying what it
 *   does in `--help`, must not need a dependency before it can install one, and must
 *   fail with a non-zero status and a sentence (not a stack) when the tarball is
 *   wrong.
 *
 * Nothing here runs `npm install -g`: that needs the network and a real tarball, and
 * the `install` job in `.github/workflows/test.yml` does it for real (twice, plus
 * `--tarball` and both wrappers against a local HTTP base).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('..', import.meta.url));
const installer = join(repo, 'scripts', 'install.mjs');
const shellWrapper = join(repo, 'scripts', 'install.sh');
const powerShellWrapper = join(repo, 'scripts', 'install.ps1');
const releaseWorkflow = join(repo, '.github', 'workflows', 'release.yml');

const scratch = mkdtempSync(join(tmpdir(), 'usages-install-test-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function install(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [installer, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function shell(args: string[]) {
  return spawnSync('sh', [shellWrapper, ...args], { encoding: 'utf8' });
}

/** A ustar header is enough for the installer's reader, which is all this feeds. */
function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('000644 \0', 100, 8, 'ascii');
  header.write('000000 \0', 108, 8, 'ascii');
  header.write('000000 \0', 116, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0' + '00', 257, 8, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

/** The smallest thing `install.mjs` accepts as a package tarball. */
function packageTarball(packageJson: Record<string, string>): Buffer {
  const body = Buffer.from(JSON.stringify(packageJson), 'utf8');
  return gzipSync(
    Buffer.concat([
      tarHeader('package/package.json', body.length),
      body,
      Buffer.alloc((512 - (body.length % 512)) % 512),
      Buffer.alloc(1024), // the two zero blocks that end an archive
    ]),
  );
}

function markdownFiles(): string[] {
  const docs = readdirSync(join(repo, 'docs'), { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => join('docs', entry));
  return ['README.md', ...docs];
}

describe('install.mjs', () => {
  it('documents every option in --help', () => {
    const result = install(['--help']);
    expect(result.status).toBe(0);
    for (const option of ['--base', '--version', '--tarball', '--prefix', '--dry-run']) {
      expect(result.stdout).toContain(option);
    }
    expect(result.stdout).toContain('AGENT_USAGES_BASE_URL');
  });

  it('rejects an unknown option with a usage exit code', () => {
    const result = install(['--nope']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--nope');
  });

  it('names the file it cannot find, and fails', () => {
    const missing = join(scratch, 'missing.tgz');
    const result = install(['--tarball', missing]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(missing);
  });

  it('refuses bytes that are not a gzip, without a stack trace', () => {
    const fake = join(scratch, 'fake.tgz');
    writeFileSync(fake, 'this is not a tarball');
    const result = install(['--tarball', fake]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('不是 gzip');
    expect(result.stderr).not.toContain('    at ');
  });

  it('refuses a gzip with no package.json behind it', () => {
    const fake = join(scratch, 'empty.tgz');
    writeFileSync(fake, gzipSync(Buffer.from('not a tar archive')));
    const result = install(['--tarball', fake]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('package/package.json');
  });

  it('refuses a package that is not @agent/usages', () => {
    const fake = join(scratch, 'other.tgz');
    writeFileSync(fake, packageTarball({ name: 'left-pad', version: '1.0.0' }));
    const result = install(['--tarball', fake]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('@agent/usages');
  });

  it('refuses a version that is not the one asked for', () => {
    const fake = join(scratch, 'version.tgz');
    writeFileSync(fake, packageTarball({ name: '@agent/usages', version: '1.2.3' }));
    const result = install(['--tarball', fake, '--version', '9.9.9']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('1.2.3');
  });

  it('dry-runs a readable tarball without installing or writing anything', () => {
    const fake = join(scratch, 'dry.tgz');
    const prefix = join(scratch, 'prefix');
    writeFileSync(fake, packageTarball({ name: '@agent/usages', version: '0.0.0-test' }));
    const before = readdirSync(scratch).sort();
    const result = install(['--dry-run', '--tarball', fake, '--prefix', prefix]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0.0.0-test');
    expect(result.stdout).toContain('dry-run');
    expect(result.stdout).toContain('npm install -g');
    expect(existsSync(prefix)).toBe(false);
    expect(readdirSync(scratch).sort()).toEqual(before);
  });

  it('imports nothing outside node:', () => {
    const source = readFileSync(installer, 'utf8');
    const imports = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier?.startsWith('node:'))).toBe(true);
  });
});

describe('install.sh', () => {
  it.skipIf(process.platform === 'win32')('is valid POSIX sh syntax', () => {
    const result = spawnSync('sh', ['-n', shellWrapper], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('answers --help itself, without downloading anything', () => {
    const result = shell(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('AGENT_USAGES_NODE');
  });

  it('refuses --base without a value', () => {
    const result = shell(['--base']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--base');
  });

  it.skipIf(process.platform === 'win32')('reports a Node that is too old', () => {
    const old = join(scratch, 'old-node');
    writeFileSync(old, '#!/bin/sh\nif [ "$1" = "-p" ]; then echo 22.17.0; exit 0; fi\nexit 0\n', { mode: 0o755 });
    const result = spawnSync('sh', [shellWrapper], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_USAGES_NODE: old },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('22.18');
    expect(result.stderr).toContain('nodejs.org');
  });
});

describe('install.ps1', () => {
  it('stays ASCII, so Windows PowerShell 5.1 cannot mis-decode it', () => {
    expect(readFileSync(powerShellWrapper).every((byte) => byte < 0x80)).toBe(true);
  });

  it('mirrors the shell wrapper', () => {
    const source = readFileSync(powerShellWrapper, 'utf8');
    expect(source).toContain('AGENT_USAGES_NODE');
    expect(source).toContain('AGENT_USAGES_BASE_URL');
    expect(source).toContain('22.18');
    expect(source).toContain('install.mjs');
  });
});

describe('the install docs carry no version', () => {
  it('points at releases/latest/download instead of a versioned URL', () => {
    for (const file of markdownFiles()) {
      expect(readFileSync(join(repo, file), 'utf8'), file).not.toMatch(/releases\/download\/v/);
    }
  });

  it('shows the two one-liners', () => {
    const readme = readFileSync(join(repo, 'README.md'), 'utf8');
    expect(readme).toContain('releases/latest/download/install.sh');
    expect(readme).toContain('releases/latest/download/install.ps1');
    expect(readFileSync(join(repo, 'docs', 'web.md'), 'utf8')).toContain('releases/latest/download/install.sh');
  });

  it('uploads the fixed names the docs point at', () => {
    // 资产清单（含固定名）在上传前拼出来，最后一次性 `gh release upload`。
    const workflow = readFileSync(releaseWorkflow, 'utf8');
    for (const asset of [
      'release/agent-usages.tgz',
      'scripts/install.sh',
      'scripts/install.ps1',
      'scripts/install.mjs',
    ]) {
      expect(workflow, asset).toContain(asset);
    }
    expect(workflow).toContain('gh release upload "$TAG"');
    // 固定名那份必须是版本名那份的字节副本，不是第二次构建。
    expect(workflow).toContain('cmp ');
  });
});
