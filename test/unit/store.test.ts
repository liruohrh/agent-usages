/**
 * The scan cache's data layer.
 *
 * Everything here is about *trust*: a cached dataset may be reused only when the
 * files it came from are provably the same, a cached warning must speak the
 * language of whoever reads it now, and a cache file that is old, broken or
 * unreadable must cost a rescan and nothing more. The cases are written as real
 * files in a temporary directory, because that is what the code reads.
 */

import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UserError } from '../../src/i18n/errors.ts';
import { setLanguage } from '../../src/i18n/index.ts';
import { fingerprintOf, fingerprintsEqual, fromJson, rootIdOf, toJson } from '../../src/store/index.ts';
import { buckets, dataset, project, record, session } from '../support/dataset.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-usages-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a file of `size` bytes whose content starts with `head`. */
async function write(path: string, head: string, size = head.length): Promise<void> {
  await writeFile(path, head.padEnd(size, '.'), 'utf8');
}

/** One fingerprint of one file, for the assertions that need a single entry. */
async function printOne(path: string) {
  const [entry] = await fingerprintOf([path]);
  if (entry === undefined) throw new Error('no fingerprint');
  return entry;
}

describe('source fingerprints', () => {
  it('fingerprints a file by size, mtime and the hash of its head', async () => {
    const file = join(dir, 'log.jsonl');
    await write(file, 'first line\n');
    const before = await printOne(file);
    const stats = await stat(file);
    expect(before.status).toBe('ok');
    expect(before.size).toBe(stats.size);
    expect(before.mtimeMs).toBe(stats.mtimeMs);
    expect(before.headHash).toMatch(/^[0-9a-f]{64}$/);
    // The same file twice is the same fingerprint: that is the cache hit.
    expect(fingerprintsEqual([before], await fingerprintOf([file]))).toBe(true);
  });

  it('changes when a file grows', async () => {
    const file = join(dir, 'log.jsonl');
    await write(file, 'first line\n');
    const before = await printOne(file);
    await appendFile(file, 'second line\n');
    const after = await printOne(file);
    expect(after.size).toBeGreaterThan(before.size);
    expect(fingerprintsEqual([before], [after])).toBe(false);
  });

  it('changes when the same number of bytes is rewritten', async () => {
    const file = join(dir, 'log.jsonl');
    await write(file, 'a'.repeat(64));
    const before = await printOne(file);
    // Same length, different head: only the hash can see this, which is why the
    // fingerprint is not just `{ size, mtimeMs }`.
    await write(file, 'b'.repeat(64));
    const after = await printOne(file);
    expect(after.size).toBe(before.size);
    expect(after.headHash).not.toBe(before.headHash);
    expect(fingerprintsEqual([before], [after])).toBe(false);
  });

  it('changes when only the mtime is touched, and says which fact moved', async () => {
    const file = join(dir, 'log.jsonl');
    await write(file, 'unchanged\n');
    const before = await printOne(file);
    const later = new Date(Date.now() + 60_000);
    await utimes(file, later, later);
    const after = await printOne(file);
    // Content identical, so the scan may rescan — but the fingerprint differs,
    // which is the conservative answer: a re-copied file is parsed again.
    expect(after.size).toBe(before.size);
    expect(after.headHash).toBe(before.headHash);
    expect(after.mtimeMs).not.toBe(before.mtimeMs);
    expect(fingerprintsEqual([before], [after])).toBe(false);
  });

  it('hashes only the head, so a big file stays cheap', async () => {
    const file = join(dir, 'big.jsonl');
    const head = 'head\n'.padEnd(4096, '.');
    await writeFile(file, `${head}tail-a`, 'utf8');
    const entry = await printOne(file);
    expect(entry.status).toBe('ok');
    expect(entry.size).toBe(head.length + 'tail-a'.length);
    // Rewriting past the first 4 KiB is invisible to the head hash — the size
    // and the parse are what catch that, and the cache stores both.
    await writeFile(file, `${head}tail-b`, 'utf8');
    const after = await printOne(file);
    expect(after.size).toBe(entry.size);
    expect(after.headHash).toBe(entry.headHash);
  });

  it('marks a missing file instead of throwing, and never calls it unchanged', async () => {
    const entry = await printOne(join(dir, 'never-existed.jsonl'));
    expect(entry).toMatchObject({ status: 'missing', size: -1, mtimeMs: -1, headHash: '' });
    // Two missing entries are not "the same files": nothing may be reused.
    expect(fingerprintsEqual([entry], [entry])).toBe(false);
  });

  it('marks a directory as unreadable instead of throwing', async () => {
    const entry = await printOne(dir);
    expect(entry.status).toBe('unreadable');
  });

  it('compares by path, not by order', async () => {
    const one = join(dir, 'a.jsonl');
    const two = join(dir, 'b.jsonl');
    await write(one, 'a\n');
    await write(two, 'b\n');
    const forwards = await fingerprintOf([one, two]);
    expect(fingerprintsEqual(forwards, await fingerprintOf([two, one]))).toBe(true);
    // A source that disappeared makes the sets differ, not merely shorter.
    await rm(two);
    expect(fingerprintsEqual(forwards, await fingerprintOf([one]))).toBe(false);
  });
});

describe('root ids', () => {
  it('is the same id for the same directory spelled differently', () => {
    const id = rootIdOf('/data/agent');
    expect(rootIdOf('/data/agent/')).toBe(id);
    expect(rootIdOf('/data/agent/../agent')).toBe(id);
    expect(rootIdOf('/data/./agent')).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('follows a symlink to the directory it points at', async () => {
    const real = join(dir, 'real');
    const link = join(dir, 'link');
    await mkdir(real, { recursive: true });
    await symlink(real, link, 'dir');
    expect(rootIdOf(link)).toBe(rootIdOf(real));
    // A different directory is a different root.
    const other = join(dir, 'other');
    await mkdir(other, { recursive: true });
    expect(rootIdOf(other)).not.toBe(rootIdOf(real));
  });
});

/** A dataset with everything the cache has to carry: extras, tokens, a warning. */
function sampleDataset() {
  const first = session({
    id: 's-1',
    agent: 'dsh',
    title: 'a session',
    cwd: '/ws/app',
    sourceFile: '/data/agent/sessions/s-1/log.jsonl',
    createdAt: 1_700_000_000_000,
    records: [record({ id: 'r-1', time: 1_700_000_000_000, tokens: buckets({ input: 10, cacheRead: 20 }) })],
    extra: { nested: { list: [1, 2, 3], flag: true }, note: null },
  });
  const second = session({ id: 's-2', agent: 'dsh', parentId: 's-1', depth: 1, isSubagent: true, childIds: [] });
  return dataset([project({ id: 'p-1', sessions: [first, second] })], {
    agent: 'dsh',
    agents: ['dsh'],
    source: '/data/agent',
    stats: { filesRead: ['/data/agent/sessions/s-1/log.jsonl'], sessions: 2, records: 1 },
    warnings: [
      new UserError('unpricedRecords', { count: '3' }),
      new UserError('configIgnored', { path: '/home/me/.config/agent-usages/config.json', reason: 'bad json' }),
    ],
  });
}

describe('dataset JSON', () => {
  it('round-trips the whole dataset, extras and all', () => {
    const original = sampleDataset();
    expect(fromJson(toJson(original))).toEqual(original);
  });

  it('stores warnings as codes and parameters, never as sentences', () => {
    const stored = toJson(sampleDataset());
    expect(stored.warnings).toEqual([
      { code: 'unpricedRecords', params: { count: '3' } },
      { code: 'configIgnored', params: { path: '/home/me/.config/agent-usages/config.json', reason: 'bad json' } },
    ]);
    // No sentence anywhere in the JSON: the language is decided when it is read.
    // (`unpricedRecords` is the *code*, so only the prose is checked for.)
    expect(JSON.stringify(stored)).not.toContain('未计入费用');
    expect(JSON.stringify(stored)).not.toContain('no usable price');
    for (const warning of stored.warnings) expect(warning).not.toHaveProperty('message');
  });

  it('renders a cached warning in the language of the reader, not the writer', () => {
    // The stored form is written once; the sentence is rendered at each read, in
    // whatever language the process is speaking *then* — a getter, so it has to
    // be read (not held) after the switch.
    const stored = JSON.parse(JSON.stringify(toJson(sampleDataset()))) as ReturnType<typeof toJson>;
    setLanguage('zh');
    const chineseWarning = fromJson(stored).warnings[0];
    const chinese = chineseWarning?.message;
    setLanguage('en');
    const english = fromJson(stored).warnings[0]?.message;
    setLanguage('zh');
    expect(chineseWarning?.code).toBe('unpricedRecords');
    expect(chineseWarning?.params).toEqual({ count: '3' });
    expect(chinese).toContain('3');
    expect(english).toContain('3');
    // Same code and parameters, two renderings: the cached file holds neither.
    expect(english).not.toBe(chinese);
    expect(chinese).toContain('未计入费用');
  });

  it('survives a real JSON.stringify trip without losing anything it carries', () => {
    const original = sampleDataset();
    const stored = JSON.parse(JSON.stringify(toJson(original))) as ReturnType<typeof toJson>;
    const back = fromJson(stored);
    expect(back.agent).toBe(original.agent);
    expect(back.projects[0]?.sessions[0]?.extra).toEqual(original.projects[0]?.sessions[0]?.extra);
    expect(back.projects[0]?.sessions[0]?.records[0]?.tokens).toEqual(original.projects[0]?.sessions[0]?.records[0]?.tokens);
    expect(back.stats).toEqual(original.stats);
  });

  it('does not let the cache alias the dataset it was handed', () => {
    const original = sampleDataset();
    const stored = toJson(original);
    // Mutating the dataset afterwards must not reach into the stored form: a
    // cache that shares structure would change while it is being written.
    (original.projects[0]?.sessions[0] as { title: string | null }).title = 'changed later';
    expect(stored.projects[0]?.sessions[0]?.title).toBe('a session');
  });
});

/** One cache entry for a synthetic root, as the caller would build it. */
function entryOf(root: string, datasetJson = toJson(sampleDataset())) {
  return {
    root,
    fingerprint: [{ path: join(root, 'log.jsonl'), status: 'ok' as const, size: 10, mtimeMs: 1, headHash: 'ab' }],
    dataset: datasetJson,
    lastSeen: 1_700_000_000_000,
  };
}
