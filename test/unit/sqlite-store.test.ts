/**
 * The usage store: the scan's result in SQLite.
 *
 * What matters here is not that a database works — SQLite does — but that this
 * one keeps its promises to the layers above: a dataset comes back out the way
 * it went in (extras, tiered cache writes and warnings included), one root's
 * write cannot touch another's, a file the user deleted does not take its usage
 * with it, and a file that is not a database costs a rebuild rather than an
 * error. The cases run against real files in a temporary directory, because a
 * database is a file and the interesting failures are the ones a file can have.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UserError } from '../../src/i18n/errors.ts';
import { setLanguage } from '../../src/i18n/index.ts';
import type { SessionRecord, UsageDataset } from '../../src/core/types.ts';
import {
  STORE_BACKUP_SUFFIX,
  STORE_SCHEMA_VERSION,
  UsageStore,
  type SourceFingerprint,
  type UsageStoreOpenResult,
} from '../../src/store/index.ts';
import { buckets, dataset, project, record, session } from '../support/dataset.ts';

let dir: string;
let dbPath: string;
/** Stores opened by a test, closed after it whatever it did. */
let opened: UsageStore[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-usages-sqlite-'));
  dbPath = join(dir, 'data', 'usage.db');
  opened = [];
});

afterEach(async () => {
  for (const store of opened) store.close();
  await rm(dir, { recursive: true, force: true });
});

/** Open the store and remember it for cleanup. */
async function openStore(path = dbPath, toolVersion = '1.2.3'): Promise<UsageStoreOpenResult> {
  const result = await UsageStore.open({ path, toolVersion });
  opened.push(result.store);
  return result;
}

/** An open store with nothing stored in it. */
async function emptyStore(): Promise<UsageStore> {
  return (await openStore()).store;
}

/** A fingerprint for one file of a root. */
function fingerprintFor(root: string, relPath: string, size = 10, headHash = 'abc'): SourceFingerprint {
  return { path: join(root, relPath), status: 'ok', size, mtimeMs: 1_700_000_000_000, headHash };
}

/** A dataset with everything the domain model can carry, to round-trip. */
function richDataset(root: string): UsageDataset {
  const first = session({
    id: 's-1',
    agent: 'dsh',
    title: 'a titled session',
    cwd: join(root, 'repo'),
    sourceFile: join(root, 'logs', 's-1.jsonl'),
    createdAt: 1_700_000_000_000,
    parentKnown: true,
    childIds: ['s-2'],
    extra: { nested: { list: [1, 2, 3], flag: true }, note: null },
    records: [
      record({
        id: 'r-1',
        time: 1_700_000_001_000,
        model: 'deepseek-v4',
        modelLabel: 'deepseek / v4',
        tokens: buckets({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 5 }),
        cacheWriteTtl: '1h',
        cacheWriteTiers: { '5m': 10, '1h': 30 },
        seq: 7,
        turn: 2,
        step: 3,
      }),
      record({ id: 'r-2', time: 1_700_000_002_000, tokens: buckets({ input: 1 }) }),
    ],
  });
  const second = session({
    id: 's-2',
    agent: 'dsh',
    parentId: 's-1',
    depth: 1,
    isSubagent: true,
    archived: true,
    childIds: [],
    createdAt: null,
    sourceFile: join(root, 'logs', 's-2.jsonl'),
    records: [record({ id: 'r-3', time: 1_700_000_003_000, tokens: buckets({ output: 9, cacheWrite: 1 }) })],
  });
  return dataset([project({ id: 'p-1', name: 'the project', sessions: [first, second] })], {
    agent: 'dsh',
    agents: ['dsh'],
    source: root,
    stats: { filesRead: [join(root, 'logs', 's-1.jsonl'), join(root, 'logs', 's-2.jsonl')], sessions: 2, records: 3 },
    warnings: [
      new UserError('unpricedRecords', { count: '3' }),
      new UserError('configIgnored', { path: join(root, 'config.json'), reason: 'bad json' }),
    ],
  });
}

/** Read one column of one row, straight from the file. */
function cell(path: string, sql: string, ...params: string[]): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : Object.values(row)[0];
  } finally {
    db.close();
  }
}

/** Every value of every row, straight from the file. */
function column(path: string, sql: string, ...params: string[]): unknown[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map((row) => Object.values(row)[0]);
  } finally {
    db.close();
  }
}

/** How SQLite says it would run a query: the `detail` column of the plan. */
function plan(path: string, sql: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Record<string, unknown>[])
      .map((row) => String(row['detail']))
      .join('\n');
  } finally {
    db.close();
  }
}

describe('opening', () => {
  it('creates the file, its directory, the schema and the indexes', async () => {
    const { store, reset } = await openStore();
    expect(reset).toBeNull();
    expect(store.path).toBe(dbPath);

    // The features the design rests on, read from the file itself: WAL so a
    // reader never blocks a writer, and foreign keys so a root's rows are one
    // unit.
    expect(cell(dbPath, 'PRAGMA journal_mode')).toBe('wal');
    expect(Number(cell(dbPath, 'PRAGMA foreign_keys'))).toBe(1);
    expect(Number(cell(dbPath, 'PRAGMA user_version'))).toBe(STORE_SCHEMA_VERSION);

    const tables = column(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(tables).toEqual(['files', 'meta', 'records', 'roots', 'sessions']);
    const indexes = column(dbPath, "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    expect(indexes).toEqual(['records_model', 'records_time', 'sessions_created_at', 'sessions_source_file']);

    const meta = Object.fromEntries(
      (new DatabaseSync(dbPath, { readOnly: true }).prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[])
        .map((row) => [row.key, row.value]),
    );
    expect(meta['schema_version']).toBe(String(STORE_SCHEMA_VERSION));
    expect(meta['tool_version']).toBe('1.2.3');
    expect(Number(meta['created_at'])).toBeGreaterThan(1_600_000_000_000);
  });

  it('reopens an existing file without losing or resetting anything', async () => {
    const root = join(dir, 'home');
    const first = await openStore();
    first.store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 1,
      dataset: richDataset(root),
      fingerprint: [fingerprintFor(root, 'logs/s-1.jsonl')],
    });
    const created = cell(dbPath, 'SELECT value FROM meta WHERE key = ?', 'created_at');
    first.store.close();

    const second = await openStore(dbPath, '9.9.9');
    expect(second.reset).toBeNull();
    expect(second.store.fingerprintOf('dsh', 'r-1')).toHaveLength(1);
    expect(second.store.readRoot('dsh', 'r-1')?.dataset.sessions).toHaveLength(2);
    // Only the informational tool version moved.
    expect(cell(dbPath, 'SELECT value FROM meta WHERE key = ?', 'created_at')).toBe(created);
    expect(cell(dbPath, 'SELECT value FROM meta WHERE key = ?', 'tool_version')).toBe('9.9.9');
    expect(Number(cell(dbPath, 'PRAGMA user_version'))).toBe(STORE_SCHEMA_VERSION);
  });

  it('migrates a version 0 file in place, without touching a version 2 one', async () => {
    // A file with no schema at all: the state the JSON cache era leaves behind.
    const v0Path = join(dir, 'v0.db');
    new DatabaseSync(v0Path).close();
    const migrated = await openStore(v0Path);
    expect(migrated.reset).toBeNull();
    expect(Number(cell(v0Path, 'PRAGMA user_version'))).toBe(STORE_SCHEMA_VERSION);
    expect(column(v0Path, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).toEqual([
      'files',
      'meta',
      'records',
      'roots',
      'sessions',
    ]);

    // A file from a newer build: opened, but not written to. Not even the
    // journal mode may change, because that is a write.
    const newerPath = join(dir, 'newer.db');
    const newer = new DatabaseSync(newerPath);
    newer.exec('CREATE TABLE future (a TEXT)');
    newer.exec('PRAGMA user_version = 2');
    newer.close();
    const before = await readFile(newerPath);

    const result = await openStore(newerPath);
    expect(result.reset).toEqual({
      reason: 'newer',
      path: newerPath,
      backup: null,
      detail: 'user_version 2',
    });
    // Usable, in memory: a scan still runs, it just does not persist.
    result.store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root: join(dir, 'home'),
      now: 5,
      dataset: richDataset(join(dir, 'home')),
      fingerprint: [],
    });
    expect(result.store.readRoot('dsh', 'r-1')?.dataset.sessions).toHaveLength(2);
    result.store.close();
    expect(await readFile(newerPath)).toEqual(before);
    expect(Number(cell(newerPath, 'PRAGMA user_version'))).toBe(2);
  });

  it('rebuilds a file that is not a database, keeping the damaged one', async () => {
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(dbPath, 'this is not a database, it is a text file\n');

    const { store, reset } = await openStore();
    expect(reset?.reason).toBe('corrupt');
    expect(reset?.path).toBe(dbPath);
    expect(reset?.detail).toContain('not a database');
    expect(reset?.backup).toContain(STORE_BACKUP_SUFFIX);
    expect(await readFile(reset?.backup ?? '', 'utf8')).toBe('this is not a database, it is a text file\n');

    // The rebuilt file is a real store.
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root: join(dir, 'home'),
      now: 1,
      dataset: richDataset(join(dir, 'home')),
      fingerprint: [],
    });
    expect(store.readRoot('dsh', 'r-1')?.dataset.sessions).toHaveLength(2);
    expect(Number(cell(dbPath, 'PRAGMA user_version'))).toBe(STORE_SCHEMA_VERSION);
  });

  it('rebuilds a file that claims a schema it does not have', async () => {
    // What a process killed mid-write, or a full disk, leaves behind: the
    // header says version 1, the tables are gone.
    const half = join(dir, 'half.db');
    const db = new DatabaseSync(half);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
    db.close();

    const { store, reset } = await openStore(half);
    expect(reset?.reason).toBe('corrupt');
    expect(reset?.detail).toContain('missing');
    expect(await readFile(reset?.backup ?? '', 'utf8')).toContain('SQLite format 3');
    expect(column(half, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).toEqual([
      'files',
      'meta',
      'records',
      'roots',
      'sessions',
    ]);
    expect(store.readRoot('dsh', 'r-1')).toBeUndefined();
  });

  it('falls back to memory when the path cannot be opened at all', async () => {
    // A directory where the database should be: nothing can be created, and
    // nothing must be thrown either.
    const { store, reset } = await openStore(dir);
    expect(reset?.reason).toBe('unreadable');
    expect(reset?.backup).toBeNull();
    expect(store.path).toBe(dir);
    // Usable, in memory.
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root: join(dir, 'home'),
      now: 1,
      dataset: richDataset(join(dir, 'home')),
      fingerprint: [],
    });
    expect(store.readRoot('dsh', 'r-1')?.dataset.sessions).toHaveLength(2);
    // And nothing was written into the directory it was pointed at.
    expect(await readdir(dir)).not.toContain('usage.db');
  });
});

describe('round trip', () => {
  it('gives back the dataset it was written, extra fields and all', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    const original = richDataset(root);
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 1_700_000_100_000,
      dataset: original,
      fingerprint: original.stats.filesRead.map((path) => fingerprintFor(root, path.slice(root.length + 1))),
    });

    const read = store.readRoot('dsh', 'r-1');
    expect(read?.root).toBe(root);
    expect(read?.lastSeen).toBe(1_700_000_100_000);
    expect(read?.staleSessionIds).toEqual([]);
    expect(read?.dataset).toStrictEqual(original);
    expect(read?.dataset).not.toBe(original);
  });

  it('keeps the fingerprint it was written with, in absolute paths', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    const stored = [fingerprintFor(root, 'logs/a.jsonl', 11, 'aa'), fingerprintFor(root, 'logs/b.jsonl', 22, 'bb')];
    store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 1, dataset: richDataset(root), fingerprint: stored });
    expect([...(store.fingerprintOf('dsh', 'r-1') ?? [])].sort((a, b) => a.path.localeCompare(b.path))).toEqual(
      [...stored].sort((a, b) => a.path.localeCompare(b.path)),
    );
  });

  it('stores paths inside the root as relative ones, and nothing else', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    const outside = join(dir, 'elsewhere', 'log.jsonl');
    const inside = session({
      id: 's-in',
      agent: 'dsh',
      sourceFile: join(root, 'logs', 'in.jsonl'),
      records: [],
    });
    const away = session({ id: 's-out', agent: 'dsh', sourceFile: outside, records: [] });
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 1,
      dataset: dataset([project({ id: 'p', sessions: [inside, away] })], { agent: 'dsh', agents: ['dsh'], source: root }),
      fingerprint: [fingerprintFor(root, 'logs/in.jsonl'), { path: outside, status: 'ok', size: 1, mtimeMs: 2, headHash: 'c' }],
    });

    // Relative inside the root — that is what makes the file portable — and
    // absolute for a source outside it, because no relative path would be true.
    expect(column(dbPath, 'SELECT rel_path FROM files ORDER BY rel_path')).toEqual(
      ['logs/in.jsonl', outside].sort(),
    );
    expect(column(dbPath, 'SELECT source_file FROM sessions ORDER BY session_id')).toEqual(['logs/in.jsonl', outside]);
    expect(cell(dbPath, 'SELECT root FROM roots WHERE agent = ? AND root_id = ?', 'dsh', 'r-1')).toBe(root);

    // And they come back absolute.
    const read = store.readRoot('dsh', 'r-1');
    expect(read?.dataset.sessions.find((entry) => entry.id === 's-in')?.sourceFile).toBe(join(root, 'logs', 'in.jsonl'));
    expect(read?.dataset.sessions.find((entry) => entry.id === 's-out')?.sourceFile).toBe(outside);
  });

  it('renders a stored warning in the language of the reader, not the writer', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 1, dataset: richDataset(root), fingerprint: [] });

    const stored = await readFile(dbPath);
    expect(stored.includes(Buffer.from('未计入费用'))).toBe(false);

    setLanguage('zh');
    const chinese = store.readRoot('dsh', 'r-1')?.dataset.warnings[0]?.message;
    setLanguage('en');
    const english = store.readRoot('dsh', 'r-1')?.dataset.warnings[0]?.message;
    setLanguage('zh');
    expect(chinese).toContain('未计入费用');
    expect(english).not.toBe(chinese);
    expect(store.readRoot('dsh', 'r-1')?.dataset.warnings[0]?.code).toBe('unpricedRecords');
  });

  it('round-trips a dataset with no sessions, files or warnings', async () => {
    const store = await emptyStore();
    const root = join(dir, 'empty');
    const empty = dataset([], { agent: 'dsh', agents: ['dsh'], source: root, stats: { filesRead: [], sessions: 0, records: 0 } });
    store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 42, dataset: empty, fingerprint: [] });

    const read = store.readRoot('dsh', 'r-1');
    expect(read?.dataset).toStrictEqual(empty);
    // A root that was read with no sources is known, and says so.
    expect(store.fingerprintOf('dsh', 'r-1')).toEqual([]);
    expect(store.rootsOf('dsh')).toEqual([{ rootId: 'r-1', root, lastSeen: 42 }]);
  });

  it('says nothing about a root it was never told about', async () => {
    const store = await emptyStore();
    expect(store.readRoot('dsh', 'never')).toBeUndefined();
    expect(store.fingerprintOf('dsh', 'never')).toBeUndefined();
    expect(store.rootsOf('dsh')).toEqual([]);
  });
});

describe('writing', () => {
  it('keeps every root and agent apart', async () => {
    const store = await emptyStore();
    const rootA = join(dir, 'a');
    const rootB = join(dir, 'b');
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-a',
      root: rootA,
      now: 10,
      dataset: dataset([project({ id: 'pa', sessions: [session({ id: 's-a', agent: 'dsh' })] })], {
        agent: 'dsh',
        agents: ['dsh'],
        source: rootA,
      }),
      fingerprint: [fingerprintFor(rootA, 'log.jsonl')],
    });
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-b',
      root: rootB,
      now: 20,
      dataset: dataset([project({ id: 'pb', sessions: [session({ id: 's-b', agent: 'dsh' })] })], {
        agent: 'dsh',
        agents: ['dsh'],
        source: rootB,
      }),
      fingerprint: [fingerprintFor(rootB, 'log.jsonl')],
    });
    // Same root path, a different agent: a separate scope, not an overwrite.
    store.writeRoot({
      agent: 'codex',
      rootId: 'r-a',
      root: rootA,
      now: 30,
      dataset: dataset([project({ id: 'pc', sessions: [session({ id: 's-c', agent: 'codex' })] })], {
        agent: 'codex',
        agents: ['codex'],
        source: rootA,
      }),
      fingerprint: [],
    });

    expect(store.readRoot('dsh', 'r-a')?.dataset.sessions.map((entry) => entry.id)).toEqual(['s-a']);
    expect(store.readRoot('dsh', 'r-b')?.dataset.sessions.map((entry) => entry.id)).toEqual(['s-b']);
    expect(store.readRoot('codex', 'r-a')?.dataset.sessions.map((entry) => entry.id)).toEqual(['s-c']);
    expect(store.readRoot('dsh', 'r-b')?.root).toBe(rootB);
    expect(store.rootsOf('dsh').map((entry) => entry.rootId)).toEqual(['r-b', 'r-a']);
    expect(store.rootsOf('codex').map((entry) => entry.rootId)).toEqual(['r-a']);
  });

  it('replaces a root with what the new scan read', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 1, dataset: richDataset(root), fingerprint: [] });
    const second = dataset([project({ id: 'p-2', sessions: [session({ id: 's-9', agent: 'dsh', records: [record({ id: 'r-9', time: 9 })] })] })], {
      agent: 'dsh',
      agents: ['dsh'],
      source: root,
      stats: { filesRead: [], sessions: 1, records: 1 },
    });
    store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 2, dataset: second, fingerprint: [] });

    const read = store.readRoot('dsh', 'r-1');
    expect(read?.dataset).toStrictEqual(second);
    expect(read?.lastSeen).toBe(2);
    // The old sessions and their records are gone, not orphaned.
    expect(column(dbPath, 'SELECT session_id FROM records')).toEqual(['s-9']);
  });

  it('keeps the sessions of a file that vanished, marked stale', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    const kept = session({
      id: 's-gone',
      agent: 'dsh',
      cwd: join(root, 'repo'),
      sourceFile: join(root, 'logs', 'gone.jsonl'),
      records: [record({ id: 'r-gone', time: 5 })],
    });
    const live = session({ id: 's-live', agent: 'dsh', sourceFile: join(root, 'logs', 'live.jsonl'), records: [] });
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 1,
      dataset: dataset([project({ id: 'p', sessions: [kept, live] })], { agent: 'dsh', agents: ['dsh'], source: root }),
      fingerprint: [fingerprintFor(root, 'logs/gone.jsonl'), fingerprintFor(root, 'logs/live.jsonl')],
    });

    // A new scan that only saw the live file, and the live file's session
    // rewritten with one more record.
    const updated = session({
      id: 's-live',
      agent: 'dsh',
      sourceFile: join(root, 'logs', 'live.jsonl'),
      records: [record({ id: 'r-new', time: 6 })],
    });
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 2,
      dataset: dataset([project({ id: 'p', sessions: [updated] })], { agent: 'dsh', agents: ['dsh'], source: root }),
      fingerprint: [fingerprintFor(root, 'logs/live.jsonl')],
      vanishedFiles: ['logs/gone.jsonl'],
    });

    const read = store.readRoot('dsh', 'r-1');
    // The kept session keeps the position it was written in; the ones this scan
    // read are written after it.
    expect(read?.dataset.sessions.map((entry) => entry.id)).toEqual(['s-gone', 's-live']);
    expect(read?.staleSessionIds).toEqual(['s-gone']);
    // The vanished file's usage is intact, project attribution included.
    const gone = read?.dataset.sessions[0];
    expect(gone?.records.map((entry) => entry.id)).toEqual(['r-gone']);
    // In a project, the sessions this scan read come first and the carried-over
    // ones follow: the store never silently drops a group a stale session had.
    expect(read?.dataset.projects[0]?.sessions.map((entry) => entry.id)).toEqual(['s-live', 's-gone']);
    // The live session was replaced, not appended to.
    expect(read?.dataset.sessions[1]?.records.map((entry) => entry.id)).toEqual(['r-new']);
    // And the file it came from is still on record as missing.
    expect(store.fingerprintOf('dsh', 'r-1')).toEqual([
      { path: join(root, 'logs', 'gone.jsonl'), status: 'missing', size: 10, mtimeMs: 1_700_000_000_000, headHash: 'abc' },
      fingerprintFor(root, 'logs/live.jsonl'),
    ]);

    // The file comes back: its session is live again, read from the source.
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 3,
      dataset: dataset(
        [project({ id: 'p', sessions: [updated, session({ id: 's-gone', agent: 'dsh', sourceFile: join(root, 'logs', 'gone.jsonl'), records: [record({ id: 'r-back', time: 7 })] })] })],
        { agent: 'dsh', agents: ['dsh'], source: root },
      ),
      fingerprint: [fingerprintFor(root, 'logs/live.jsonl'), fingerprintFor(root, 'logs/gone.jsonl')],
    });
    const back = store.readRoot('dsh', 'r-1');
    expect(back?.staleSessionIds).toEqual([]);
    expect(back?.dataset.sessions.find((entry) => entry.id === 's-gone')?.records.map((entry) => entry.id)).toEqual(['r-back']);
    expect(store.fingerprintOf('dsh', 'r-1')?.every((entry) => entry.status === 'ok')).toBe(true);
  });

  it('treats a source the scan no longer lists as vanished', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    const old = session({ id: 's-old', agent: 'dsh', sourceFile: join(root, 'logs', 'old.jsonl'), records: [] });
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 1,
      dataset: dataset([project({ id: 'p', sessions: [old] })], { agent: 'dsh', agents: ['dsh'], source: root }),
      fingerprint: [fingerprintFor(root, 'logs/old.jsonl')],
    });
    // The scan found nothing at all this time and the caller said nothing about
    // it: the row is still the store's only record that the file was read, so
    // the session is kept rather than dropped by a scan that cannot see it.
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 2,
      dataset: dataset([], { agent: 'dsh', agents: ['dsh'], source: root, stats: { filesRead: [], sessions: 0, records: 0 } }),
      fingerprint: [],
    });
    expect(store.readRoot('dsh', 'r-1')?.staleSessionIds).toEqual(['s-old']);
  });

  it('keeps a source that is there but unreadable, and its sessions', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    const locked = session({ id: 's-locked', agent: 'dsh', sourceFile: join(root, 'logs', 'locked.jsonl'), records: [] });
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 1,
      dataset: dataset([project({ id: 'p', sessions: [locked] })], { agent: 'dsh', agents: ['dsh'], source: root }),
      fingerprint: [fingerprintFor(root, 'logs/locked.jsonl')],
    });
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 2,
      dataset: dataset([], { agent: 'dsh', agents: ['dsh'], source: root, stats: { filesRead: [], sessions: 0, records: 0 } }),
      fingerprint: [{ path: join(root, 'logs', 'locked.jsonl'), status: 'unreadable', size: -1, mtimeMs: -1, headHash: '' }],
    });
    expect(store.fingerprintOf('dsh', 'r-1')?.[0]?.status).toBe('unreadable');
    expect(store.readRoot('dsh', 'r-1')?.staleSessionIds).toEqual(['s-locked']);
  });

  it('drops a session the adapter stopped reporting while its file is still here', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    const first = session({ id: 's-old', agent: 'dsh', sourceFile: join(root, 'logs', 'live.jsonl'), records: [] });
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 1,
      dataset: dataset([project({ id: 'p', sessions: [first] })], { agent: 'dsh', agents: ['dsh'], source: root }),
      fingerprint: [fingerprintFor(root, 'logs/live.jsonl')],
    });
    // History cleared, log rotated: the file is still read, the session is not.
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 2,
      dataset: dataset([], { agent: 'dsh', agents: ['dsh'], source: root, stats: { filesRead: [], sessions: 0, records: 0 } }),
      fingerprint: [fingerprintFor(root, 'logs/live.jsonl')],
    });
    const read = store.readRoot('dsh', 'r-1');
    expect(read?.dataset.sessions).toEqual([]);
    expect(read?.staleSessionIds).toEqual([]);
    expect(column(dbPath, 'SELECT session_id FROM sessions')).toEqual([]);
  });

  it('writes a root in one transaction, leaving nothing behind when it fails', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    const original = richDataset(root);
    store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 1, dataset: original, fingerprint: [] });

    // A dataset that cannot be stored: this is what a half-written root would
    // come from, and it must not happen.
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const broken = dataset(
      [project({ id: 'p-9', sessions: [session({ id: 's-9', agent: 'dsh', extra: circular })] })],
      { agent: 'dsh', agents: ['dsh'], source: root },
    );
    expect(() => store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 2,
      dataset: broken,
      fingerprint: [],
    })).toThrow();

    const read = store.readRoot('dsh', 'r-1');
    expect(read?.dataset).toStrictEqual(original);
    expect(read?.lastSeen).toBe(1);
    expect(column(dbPath, 'SELECT session_id FROM sessions')).toEqual(['s-1', 's-2']);
  });

  it('refuses to work once it is closed, and closing twice is fine', async () => {
    const store = await emptyStore();
    store.close();
    store.close();
    expect(() => store.rootsOf('dsh')).toThrow(/closed/);
    expect(() => store.readRoot('dsh', 'r-1')).toThrow(/closed/);
  });
});

describe('rows on disk', () => {
  it('keeps one row per record, keyed by the adapter’s own id', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    const withTiers = session({
      id: 's-1',
      agent: 'dsh',
      sourceFile: join(root, 'log.jsonl'),
      records: [
        record({ id: 'r-1', time: 100, model: 'm-a', tokens: buckets({ input: 1 }), cacheWriteTtl: '1h', cacheWriteTiers: { '1h': 5 } }),
        record({ id: 'r-2', time: 200, model: 'm-b', tokens: buckets({ output: 2 }), seq: 3, turn: 4, step: 5 }),
      ],
    });
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 1,
      dataset: dataset([project({ id: 'p', sessions: [withTiers] })], { agent: 'dsh', agents: ['dsh'], source: root }),
      fingerprint: [],
    });

    expect(column(dbPath, 'SELECT record_id FROM records ORDER BY rowid')).toEqual(['r-1', 'r-2']);
    expect(cell(dbPath, 'SELECT cache_write_tiers_json FROM records WHERE record_id = ?', 'r-1')).toBe('{"1h":5}');
    expect(cell(dbPath, 'SELECT cache_write_ttl FROM records WHERE record_id = ?', 'r-1')).toBe('1h');
    expect(cell(dbPath, 'SELECT seq FROM records WHERE record_id = ?', 'r-2')).toBe(3);
    expect(cell(dbPath, 'SELECT model FROM records WHERE record_id = ?', 'r-2')).toBe('m-b');
    // A record with no tier named stores nothing to reinterpret later.
    expect(cell(dbPath, 'SELECT cache_write_ttl FROM records WHERE record_id = ?', 'r-2')).toBeNull();
    // The index the design asks for is on the file, and a time filter uses it.
    expect(plan(dbPath, 'SELECT * FROM records WHERE time > 0')).toContain('records_time');
    expect(plan(dbPath, 'SELECT * FROM records WHERE model = ?')).toContain('records_model');
  });

  it('stores no money and no sentence', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 1, dataset: richDataset(root), fingerprint: [] });
    const dump = await readFile(dbPath);
    for (const word of ['cost', 'price', 'unpricedRecords']) {
      expect(dump.includes(Buffer.from(word))).toBe(false);
    }
    // What a session carried beyond the model travels as JSON, verbatim.
    expect(String(cell(dbPath, 'SELECT extra_json FROM sessions WHERE session_id = ?', 's-1'))).toContain('nested');
  });

  it('reads records back in the order they were written', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    const unordered: SessionRecord = session({
      id: 's-1',
      agent: 'dsh',
      records: [
        record({ id: 'r-late', time: 300 }),
        record({ id: 'r-early', time: 100 }),
      ],
    });
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 1,
      dataset: dataset([project({ id: 'p', sessions: [unordered] })], { agent: 'dsh', agents: ['dsh'], source: root }),
      fingerprint: [],
    });
    expect(store.readRoot('dsh', 'r-1')?.dataset.sessions[0]?.records.map((entry) => entry.id)).toEqual(['r-late', 'r-early']);
  });

  it('leaves no orphan rows when a session is dropped', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 1, dataset: richDataset(root), fingerprint: [] });
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 2,
      dataset: dataset([], { agent: 'dsh', agents: ['dsh'], source: root, stats: { filesRead: [], sessions: 0, records: 0 } }),
      fingerprint: [],
    });
    expect(column(dbPath, 'SELECT session_id FROM sessions')).toEqual([]);
    // Nothing points at a session that is no longer there: the cascade, not a
    // second statement somewhere, is what removed them.
    expect(column(dbPath, 'SELECT record_id FROM records')).toEqual([]);
  });
});
