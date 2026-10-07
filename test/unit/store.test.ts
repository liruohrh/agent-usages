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
import {
  SCAN_CACHE_FORMAT,
  ScanCache,
  fingerprintOf,
  fingerprintsEqual,
  fromJson,
  rootIdOf,
  toJson,
} from '../../src/store/index.ts';
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

describe('ScanCache', () => {
  it('starts empty when there is no file, and does not call that a reset', async () => {
    const { cache, reset } = await ScanCache.open({ dir, toolVersion: '1.0.0' });
    expect(reset).toBeNull();
    expect(cache.path).toBe(join(dir, 'scan-cache.json'));
    expect(cache.agentsPresent()).toEqual([]);
    expect(cache.get('dsh', 'root')).toBeUndefined();
  });

  it('stores, reads back and forgets entries per agent and root', async () => {
    const { cache } = await ScanCache.open({ dir, toolVersion: '1.0.0' });
    const rootId = rootIdOf('/data/agent');
    cache.set('dsh', rootId, entryOf('/data/agent'));
    cache.set('claude', rootIdOf('/data/claude'), entryOf('/data/claude'));
    expect(cache.get('dsh', rootId)?.root).toBe('/data/agent');
    expect(cache.rootsOf('dsh')).toEqual([rootId]);
    expect(cache.entriesOf('claude')).toHaveLength(1);
    expect([...cache.agentsPresent()].sort()).toEqual(['claude', 'dsh']);
    expect(cache.delete('dsh', rootId)).toBe(true);
    expect(cache.delete('dsh', rootId)).toBe(false);
    expect(cache.agentsPresent()).toEqual(['claude']);
  });

  it('writes the file, creates the directory, and reads the same entries back', async () => {
    const nested = join(dir, 'deep', 'cache');
    const { cache } = await ScanCache.open({ dir: nested, toolVersion: '1.0.0' });
    const rootId = rootIdOf('/data/agent');
    cache.set('dsh', rootId, entryOf('/data/agent'));
    await cache.save();
    const written = JSON.parse(await readFile(join(nested, 'scan-cache.json'), 'utf8')) as { format: number };
    expect(written.format).toBe(SCAN_CACHE_FORMAT);
    const reopened = await ScanCache.open({ dir: nested, toolVersion: '1.0.0' });
    expect(reopened.reset).toBeNull();
    expect(reopened.cache.get('dsh', rootId)).toEqual(entryOf('/data/agent'));
  });

  it('leaves no temporary file behind, and replaces the old one whole', async () => {
    const { cache } = await ScanCache.open({ dir, toolVersion: '1.0.0' });
    cache.set('dsh', rootIdOf('/data/agent'), entryOf('/data/agent'));
    await cache.save();
    cache.set('dsh', rootIdOf('/data/second'), entryOf('/data/second'));
    await cache.save();
    // Only the cache file: the write goes through a temp name and a rename, so
    // a reader never sees a half-written document and no scratch file survives.
    expect((await readdir(dir)).sort()).toEqual(['scan-cache.json']);
    const reopened = await ScanCache.open({ dir, toolVersion: '1.0.0' });
    expect(reopened.cache.rootsOf('dsh')).toHaveLength(2);
  });

  it('rebuilds when the format is not this one', async () => {
    const path = join(dir, 'scan-cache.json');
    await writeFile(path, JSON.stringify({ format: 2, tool: '1.0.0', agents: { dsh: { r: entryOf('/old') } } }), 'utf8');
    const { cache, reset } = await ScanCache.open({ dir, toolVersion: '1.0.0' });
    expect(reset).toEqual({ reason: 'format', path, detail: 'format 2' });
    expect(cache.agentsPresent()).toEqual([]);
    // The old file is left alone until the caller saves: a run that decides not
    // to cache must not destroy what a working version wrote.
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ format: 2 });
  });

  it('rebuilds when another tool version wrote the file', async () => {
    const path = join(dir, 'scan-cache.json');
    await writeFile(path, JSON.stringify({ format: SCAN_CACHE_FORMAT, tool: '0.9.0', agents: {} }), 'utf8');
    const { reset } = await ScanCache.open({ dir, toolVersion: '1.0.0' });
    expect(reset).toEqual({ reason: 'tool', path, detail: 'tool 0.9.0' });
  });

  it('rebuilds a file that is not parseable JSON, and says so', async () => {
    const path = join(dir, 'scan-cache.json');
    await writeFile(path, '{"format": 1, "tool": ', 'utf8');
    const { cache, reset } = await ScanCache.open({ dir, toolVersion: '1.0.0' });
    expect(reset?.reason).toBe('corrupt');
    expect(reset?.path).toBe(path);
    expect(reset?.detail).toContain('JSON');
    expect(cache.agentsPresent()).toEqual([]);
  });

  it('rebuilds a file that parses but is not a cache', async () => {
    const path = join(dir, 'scan-cache.json');
    for (const wrong of ['[]', '"text"', '{"tool":"1.0.0"}', '{"format":1,"tool":"1.0.0","agents":[]}']) {
      await writeFile(path, wrong, 'utf8');
      const { reset } = await ScanCache.open({ dir, toolVersion: '1.0.0' });
      expect(reset?.reason, wrong).toBe('corrupt');
    }
  });

  it('rebuilds when the path exists but cannot be read as a file', async () => {
    const path = join(dir, 'scan-cache.json');
    await mkdir(path, { recursive: true });
    const { reset } = await ScanCache.open({ dir, toolVersion: '1.0.0' });
    expect(reset?.reason).toBe('unreadable');
    expect(reset?.detail).toBe('EISDIR');
  });

  it('carries a real dataset through a save and a cold open', async () => {
    const original = sampleDataset();
    const { cache } = await ScanCache.open({ dir, toolVersion: '1.0.0' });
    cache.set('dsh', rootIdOf('/data/agent'), entryOf('/data/agent', toJson(original)));
    await cache.save();
    const { cache: reopened } = await ScanCache.open({ dir, toolVersion: '1.0.0' });
    const entry = reopened.get('dsh', rootIdOf('/data/agent'));
    expect(entry).toBeDefined();
    expect(fromJson((entry as { dataset: ReturnType<typeof toJson> }).dataset)).toEqual(original);
  });

  it('takes a custom file name, so a caller can keep several caches apart', async () => {
    const { cache } = await ScanCache.open({ dir, toolVersion: '1.0.0', file: 'other.json' });
    cache.set('dsh', rootIdOf('/data/agent'), entryOf('/data/agent'));
    await cache.save();
    expect(await readdir(dir)).toEqual(['other.json']);
    expect(cache.path).toBe(join(dir, 'other.json'));
  });
});

describe('cache and fingerprints together', () => {
  it('reuses a dataset when the files are unchanged, and rescans when they are not', async () => {
    // The decision C will make: fingerprint the sources, compare with the cache.
    const root = join(dir, 'agent-home');
    await mkdir(root, { recursive: true });
    const log = join(root, 'log.jsonl');
    await write(log, 'request one\n');

    const first = await fingerprintOf([log]);
    const { cache } = await ScanCache.open({ dir: join(dir, 'cache'), toolVersion: '1.0.0' });
    cache.set('dsh', rootIdOf(root), {
      root,
      fingerprint: first,
      dataset: toJson(sampleDataset()),
      lastSeen: 1,
    });

    const unchanged = await fingerprintOf([log]);
    const hit = cache.get('dsh', rootIdOf(root));
    expect(hit).toBeDefined();
    expect(fingerprintsEqual((hit as { fingerprint: typeof first }).fingerprint, unchanged)).toBe(true);

    await appendFile(log, 'request two\n');
    const changed = await fingerprintOf([log]);
    expect(fingerprintsEqual(first, changed)).toBe(false);
  });
});
