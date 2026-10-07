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
import type { SessionRecord, UsageDataset, UsageRecord } from '../../src/core/types.ts';
import {
  STORE_BACKUP_SUFFIX,
  STORE_MIGRATION_BACKUP_SUFFIX,
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
        // Every shape an event can take: a trimmed payload with its true size, a
        // failure, an empty argument payload, and one the log said nothing else
        // about.
        events: [
          { kind: 'tool_call', ordinal: 0, name: 'Read', detail: 'src/store/sqlite.ts', bytes: 4096, ok: true },
          { kind: 'tool_call', ordinal: 1, name: 'Bash', bytes: 0, ok: false },
          { kind: 'tool_call', ordinal: 2, name: 'Grep' },
        ],
      }),
      record({
        id: 'r-2',
        time: 1_700_000_002_000,
        tokens: buckets({ input: 1 }),
        events: [{ kind: 'tool_call', ordinal: 0, name: 'Edit', detail: '' }],
      }),
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

/**
 * Write a schema version 1 database by hand, as the previous release left it.
 *
 * The DDL is copied from the shipped version 1 rather than imported, because the
 * point of the test is that a file on a user's disk — written by code that is no
 * longer here — opens and upgrades. Rows go in for this release's reader to find
 * afterwards.
 */
function seedVersion1(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE roots (
  agent TEXT NOT NULL, root_id TEXT NOT NULL, root TEXT NOT NULL, last_seen INTEGER NOT NULL,
  agents_json TEXT NOT NULL, projects_json TEXT NOT NULL, warnings_json TEXT NOT NULL, stats_json TEXT NOT NULL,
  PRIMARY KEY (agent, root_id)
);
CREATE TABLE files (
  agent TEXT NOT NULL, root_id TEXT NOT NULL, rel_path TEXT NOT NULL, size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL, head_hash TEXT NOT NULL, status TEXT NOT NULL,
  PRIMARY KEY (agent, root_id, rel_path),
  FOREIGN KEY (agent, root_id) REFERENCES roots(agent, root_id) ON DELETE CASCADE
);
CREATE TABLE sessions (
  agent TEXT NOT NULL, root_id TEXT NOT NULL, session_id TEXT NOT NULL, title TEXT, cwd TEXT,
  created_at INTEGER, parent_id TEXT, depth INTEGER NOT NULL, is_subagent INTEGER NOT NULL,
  archived INTEGER NOT NULL, parent_known INTEGER NOT NULL, child_ids_json TEXT NOT NULL,
  source_file TEXT, extra_json TEXT, state TEXT NOT NULL,
  PRIMARY KEY (agent, root_id, session_id),
  FOREIGN KEY (agent, root_id) REFERENCES roots(agent, root_id) ON DELETE CASCADE
);
CREATE TABLE records (
  agent TEXT NOT NULL, root_id TEXT NOT NULL, session_id TEXT NOT NULL, record_id TEXT NOT NULL,
  time INTEGER NOT NULL, model TEXT NOT NULL, model_label TEXT NOT NULL, input INTEGER NOT NULL,
  output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, reasoning INTEGER NOT NULL,
  cache_write_ttl TEXT, cache_write_tiers_json TEXT, seq INTEGER, turn INTEGER, step INTEGER,
  PRIMARY KEY (agent, root_id, session_id, record_id),
  FOREIGN KEY (agent, root_id, session_id) REFERENCES sessions(agent, root_id, session_id) ON DELETE CASCADE
);
CREATE INDEX records_time ON records(time);
CREATE INDEX records_model ON records(model);
CREATE INDEX sessions_created_at ON sessions(created_at);
CREATE INDEX sessions_source_file ON sessions(source_file);
PRAGMA user_version = 1;
`);
  const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  meta.run('schema_version', '1');
  meta.run('tool_version', '1.0.0');
  meta.run('created_at', '1600000000000');
  db.prepare(
    'INSERT INTO roots (agent, root_id, root, last_seen, agents_json, projects_json, warnings_json, stats_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'dsh', 'r-v1', '/home/old', 1_600_000_000_000, '["dsh"]',
    '[{"id":"p-v1","name":"old project","path":"/home/old/p","agents":["dsh"],"workspaces":["/home/old/p"],"sessionIds":["s-v1"]}]',
    '[]', '{"filesRead":["/home/old/logs/a.jsonl"],"sessions":1,"records":1}',
  );
  db.prepare('INSERT INTO files (agent, root_id, rel_path, size, mtime_ms, head_hash, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('dsh', 'r-v1', 'logs/a.jsonl', 10, 1.5, 'abc', 'ok');
  db.prepare(
    'INSERT INTO sessions (agent, root_id, session_id, title, cwd, created_at, parent_id, depth, is_subagent, archived, parent_known, child_ids_json, source_file, extra_json, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('dsh', 'r-v1', 's-v1', 'a session from before', '/home/old/p', 1_600_000_000_000, null, 0, 0, 0, 1, '[]', 'logs/a.jsonl', null, 'live');
  db.prepare(
    'INSERT INTO records (agent, root_id, session_id, record_id, time, model, model_label, input, output, cache_read, cache_write, reasoning, cache_write_ttl, cache_write_tiers_json, seq, turn, step) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('dsh', 'r-v1', 's-v1', 'rec-v1', 1_600_000_000_001, 'old-model', 'old model', 42, 1, 2, 3, 4, null, null, null, null, null);
  db.close();
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
    expect(tables).toEqual(['events', 'files', 'meta', 'records', 'roots', 'sessions']);
    const indexes = column(dbPath, "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    expect(indexes).toEqual([
      'events_name',
      'events_session_id',
      'records_model',
      'records_time',
      'sessions_created_at',
      'sessions_source_file',
    ]);

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

  it('migrates a version 0 file in place, without touching a newer one', async () => {
    // A file with no schema at all: the state the JSON cache era leaves behind.
    const v0Path = join(dir, 'v0.db');
    new DatabaseSync(v0Path).close();
    const migrated = await openStore(v0Path);
    expect(migrated.reset).toBeNull();
    expect(Number(cell(v0Path, 'PRAGMA user_version'))).toBe(STORE_SCHEMA_VERSION);
    expect(column(v0Path, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).toEqual([
      'events',
      'files',
      'meta',
      'records',
      'roots',
      'sessions',
    ]);

    // A file from a newer build: opened, but not written to. Not even the
    // journal mode may change, because that is a write.
    const newerPath = join(dir, 'newer.db');
    const future = STORE_SCHEMA_VERSION + 1;
    const newer = new DatabaseSync(newerPath);
    newer.exec('CREATE TABLE future (a TEXT)');
    newer.exec(`PRAGMA user_version = ${future}`);
    newer.close();
    const before = await readFile(newerPath);

    const result = await openStore(newerPath);
    expect(result.reset).toEqual({
      reason: 'newer',
      path: newerPath,
      backup: null,
      detail: `user_version ${future}`,
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
    expect(Number(cell(newerPath, 'PRAGMA user_version'))).toBe(future);
  });

  it('upgrades a version 1 database in place, keeping every row and a copy of it', async () => {
    const v1Path = join(dir, 'v1.db');
    seedVersion1(v1Path);

    const { store, reset } = await openStore(v1Path, '2.0.0');
    expect(reset).toBeNull();
    expect(Number(cell(v1Path, 'PRAGMA user_version'))).toBe(STORE_SCHEMA_VERSION);
    expect(cell(v1Path, 'SELECT value FROM meta WHERE key = ?', 'schema_version')).toBe(String(STORE_SCHEMA_VERSION));
    expect(cell(v1Path, 'SELECT value FROM meta WHERE key = ?', 'tool_version')).toBe('2.0.0');
    expect(column(v1Path, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).toEqual([
      'events',
      'files',
      'meta',
      'records',
      'roots',
      'sessions',
    ]);

    // The rows that were there before are still there, and readable: a migration
    // that loses a year of usage is worse than no store at all.
    const read = store.readRoot('dsh', 'r-v1');
    expect(read?.root).toBe('/home/old');
    expect(read?.lastSeen).toBe(1_600_000_000_000);
    expect(read?.dataset.sessions.map((entry) => entry.id)).toEqual(['s-v1']);
    expect(read?.dataset.sessions[0]?.records.map((entry) => entry.id)).toEqual(['rec-v1']);
    expect(read?.dataset.sessions[0]?.records[0]?.tokens.input).toBe(42);
    // A v1 record has no events, and the upgrade must not invent any.
    expect(read?.dataset.sessions[0]?.records[0]?.events).toBeUndefined();
    expect(column(v1Path, 'SELECT ordinal FROM events')).toEqual([]);

    // The copy the migration promised: the file as it was, version 1, rows included.
    const backup = `${v1Path}${STORE_MIGRATION_BACKUP_SUFFIX}1`;
    expect(Number(cell(backup, 'PRAGMA user_version'))).toBe(1);
    expect(column(backup, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).toEqual([
      'files',
      'meta',
      'records',
      'roots',
      'sessions',
    ]);
    expect(cell(backup, 'SELECT record_id FROM records')).toBe('rec-v1');
    const copy = await readFile(backup);

    // Opening again is a no-op: no reset, no second copy, nothing moved.
    const again = await openStore(v1Path, '2.0.1');
    expect(again.reset).toBeNull();
    expect(Number(cell(v1Path, 'PRAGMA user_version'))).toBe(STORE_SCHEMA_VERSION);
    expect(await readFile(backup)).toEqual(copy);
    expect(again.store.readRoot('dsh', 'r-v1')?.dataset.sessions[0]?.records[0]?.tokens.input).toBe(42);
  });

  it('refuses to migrate at all when the copy before it cannot be written', async () => {
    const v1Path = join(dir, 'v1.db');
    seedVersion1(v1Path);
    // The name the copy would take, occupied by a directory: writing the copy
    // fails, and the migration must not run without one.
    await mkdir(`${v1Path}${STORE_MIGRATION_BACKUP_SUFFIX}1`);
    const before = await readFile(v1Path);

    const { store, reset } = await openStore(v1Path);
    expect(reset?.reason).toBe('migration');
    expect(reset?.backup).toBeNull();
    expect(reset?.detail).toContain('refusing to migrate');

    // The database was not touched: same bytes, still version 1, rows intact.
    expect(await readFile(v1Path)).toEqual(before);
    expect(Number(cell(v1Path, 'PRAGMA user_version'))).toBe(1);
    expect(cell(v1Path, 'SELECT record_id FROM records')).toBe('rec-v1');
    // This run works in memory, so the scan it belongs to still reports numbers.
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root: join(dir, 'home'),
      now: 1,
      dataset: richDataset(join(dir, 'home')),
      fingerprint: [],
    });
    expect(store.readRoot('dsh', 'r-1')?.dataset.sessions).toHaveLength(2);
  });

  it('copies rows that are still in the write-ahead log into the migration backup', async () => {
    const v1Path = join(dir, 'v1.db');
    seedVersion1(v1Path);
    // A writer that has committed a record and not closed: its rows are in
    // `usage.db-wal`, not in the database file yet. A copy of the file alone
    // would back up a database missing exactly the most recent usage.
    const writer = new DatabaseSync(v1Path);
    writer.exec('PRAGMA journal_mode = WAL');
    writer.prepare(
      'INSERT INTO records (agent, root_id, session_id, record_id, time, model, model_label, input, output, cache_read, cache_write, reasoning, cache_write_ttl, cache_write_tiers_json, seq, turn, step) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('dsh', 'r-v1', 's-v1', 'rec-wal', 1_600_000_000_002, 'old-model', 'old model', 7, 0, 0, 0, 0, null, null, null, null, null);
    expect(column(v1Path, 'SELECT record_id FROM records ORDER BY record_id')).toEqual(['rec-v1', 'rec-wal']);

    const { store, reset } = await openStore(v1Path);
    expect(reset).toBeNull();
    writer.close();

    expect(Number(cell(v1Path, 'PRAGMA user_version'))).toBe(STORE_SCHEMA_VERSION);
    const backup = `${v1Path}${STORE_MIGRATION_BACKUP_SUFFIX}1`;
    // The copy holds both records — the one in the file and the one the writer
    // had left in the log.
    expect(column(backup, 'SELECT record_id FROM records ORDER BY record_id')).toEqual(['rec-v1', 'rec-wal']);
    expect(Number(cell(backup, 'PRAGMA user_version'))).toBe(1);
    // And the migrated database has them too.
    const read = store.readRoot('dsh', 'r-v1');
    expect(read?.dataset.sessions[0]?.records.map((entry) => entry.id)).toEqual(['rec-v1', 'rec-wal']);
  });

  it('rolls a failed migration back, leaving the version 1 file as it was', async () => {
    const v1Path = join(dir, 'v1.db');
    seedVersion1(v1Path);
    // Something in the v1 file that the upgrade's `CREATE TABLE events` will run
    // into: a table by that name, from a run that got no further than this.
    const conflict = new DatabaseSync(v1Path);
    conflict.exec('CREATE TABLE events (placeholder TEXT)');
    conflict.close();

    const { store, reset } = await openStore(v1Path);
    expect(reset?.reason).toBe('migration');
    expect(reset?.detail).toContain('migrating from schema version 1 failed');
    // The copy *was* written before the attempt, so it is named even though the
    // file itself was left alone.
    expect(reset?.backup).toBe(`${v1Path}${STORE_MIGRATION_BACKUP_SUFFIX}1`);

    // Nothing of the upgrade survived: same version, the placeholder table still
    // the only `events`, no indexes from v2, and the rows still readable.
    expect(Number(cell(v1Path, 'PRAGMA user_version'))).toBe(1);
    expect(column(v1Path, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).toEqual([
      'events',
      'files',
      'meta',
      'records',
      'roots',
      'sessions',
    ]);
    expect(cell(v1Path, "SELECT name FROM pragma_table_info('events')")).toBe('placeholder');
    expect(column(v1Path, "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'events%'")).toEqual([]);
    expect(cell(v1Path, 'SELECT record_id FROM records')).toBe('rec-v1');
    expect(store.readRoot('dsh', 'r-1')).toBeUndefined();
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
      'events',
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
    expect(column(dbPath, 'SELECT ordinal FROM events')).toEqual([]);
  });
});

describe('events', () => {
  /** One session whose single record did the given things. */
  function toolsRoot(root: string, events: UsageRecord['events']): UsageDataset {
    const worker = session({
      id: 's-tools',
      agent: 'dsh',
      sourceFile: join(root, 'logs', 'tools.jsonl'),
      records: [record({ id: 'r-tools', time: 1_700_000_000_000, events })],
    });
    return dataset([project({ id: 'p-tools', sessions: [worker] })], {
      agent: 'dsh',
      agents: ['dsh'],
      source: root,
      stats: { filesRead: [join(root, 'logs', 'tools.jsonl')], sessions: 1, records: 1 },
    });
  }

  it('stores a row per call and gives the calls back in order', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 1, dataset: richDataset(root), fingerprint: [] });

    const read = store.readRoot('dsh', 'r-1');
    const first = read?.dataset.sessions[0]?.records[0];
    expect(first?.events).toEqual([
      { kind: 'tool_call', ordinal: 0, name: 'Read', detail: 'src/store/sqlite.ts', bytes: 4096, ok: true },
      { kind: 'tool_call', ordinal: 1, name: 'Bash', bytes: 0, ok: false },
      { kind: 'tool_call', ordinal: 2, name: 'Grep' },
    ]);
    // A detail the log recorded as empty is a detail, not silence.
    expect(read?.dataset.sessions[0]?.records[1]?.events).toEqual([
      { kind: 'tool_call', ordinal: 0, name: 'Edit', detail: '' },
    ]);

    // The rows say the same, with absence as NULL rather than as a default. The
    // order that matters is per record: `ordinal` is a position inside a request.
    expect(column(dbPath, 'SELECT name FROM events ORDER BY record_id, ordinal')).toEqual([
      'Read',
      'Bash',
      'Grep',
      'Edit',
    ]);
    expect(cell(dbPath, 'SELECT bytes FROM events WHERE name = ?', 'Bash')).toBe(0);
    expect(cell(dbPath, 'SELECT ok FROM events WHERE name = ?', 'Bash')).toBe(0);
    expect(cell(dbPath, 'SELECT ok FROM events WHERE name = ?', 'Grep')).toBeNull();
    expect(cell(dbPath, 'SELECT detail FROM events WHERE name = ?', 'Edit')).toBe('');
    expect(cell(dbPath, 'SELECT ordinal FROM events WHERE name = ?', 'Read')).toBe(0);
    expect(cell(dbPath, 'SELECT record_id FROM events WHERE name = ?', 'Grep')).toBe('r-1');
    // Counting tool calls is the query this table exists for, and it uses the index.
    expect(plan(dbPath, 'SELECT count(*) FROM events WHERE name = ?')).toContain('events_name');
  });

  it('writes no rows for a record whose log said nothing about tool calls', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    const quiet = session({ id: 's-quiet', agent: 'dsh', records: [record({ id: 'r-quiet', time: 1 })] });
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 1,
      dataset: dataset([project({ id: 'p', sessions: [quiet] })], { agent: 'dsh', agents: ['dsh'], source: root }),
      fingerprint: [],
    });
    expect(column(dbPath, 'SELECT ordinal FROM events')).toEqual([]);
    const back = store.readRoot('dsh', 'r-1')?.dataset.sessions[0]?.records[0];
    // Absent, not empty: an empty list would claim the request called no tools.
    expect(back?.events).toBeUndefined();
    expect(back).not.toHaveProperty('events');
  });

  it('brings calls back in ordinal order, whatever order they arrived in', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 1,
      dataset: toolsRoot(root, [
        { kind: 'tool_call', ordinal: 2, name: 'third' },
        { kind: 'tool_call', ordinal: 0, name: 'first' },
        { kind: 'tool_call', ordinal: 1, name: 'second' },
      ]),
      fingerprint: [],
    });
    expect(store.readRoot('dsh', 'r-1')?.dataset.sessions[0]?.records[0]?.events?.map((event) => event.name)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('refuses a record with two events in the same position', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 1, dataset: richDataset(root), fingerprint: [] });

    const broken = toolsRoot(root, [
      { kind: 'tool_call', ordinal: 0, name: 'Read' },
      { kind: 'tool_call', ordinal: 0, name: 'Write' },
    ]);
    expect(() => store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 2, dataset: broken, fingerprint: [] }))
      .toThrow(/two events with ordinal 0/);

    // And the root is left exactly as it was, not half replaced.
    expect(column(dbPath, 'SELECT count(*) FROM events')).toEqual([4]);
    expect(store.readRoot('dsh', 'r-1')?.dataset.sessions.map((entry) => entry.id)).toEqual(['s-1', 's-2']);
  });

  it('replaces one root’s events without touching another root’s', async () => {
    const store = await emptyStore();
    const rootA = join(dir, 'a');
    const rootB = join(dir, 'b');
    store.writeRoot({ agent: 'dsh', rootId: 'r-a', root: rootA, now: 1, dataset: toolsRoot(rootA, [
      { kind: 'tool_call', ordinal: 0, name: 'Read' },
      { kind: 'tool_call', ordinal: 1, name: 'Bash' },
    ]), fingerprint: [] });
    store.writeRoot({ agent: 'dsh', rootId: 'r-b', root: rootB, now: 2, dataset: toolsRoot(rootB, [
      { kind: 'tool_call', ordinal: 0, name: 'Grep' },
    ]), fingerprint: [] });

    // The same scan read again, having seen one more call.
    store.writeRoot({ agent: 'dsh', rootId: 'r-a', root: rootA, now: 3, dataset: toolsRoot(rootA, [
      { kind: 'tool_call', ordinal: 0, name: 'Read' },
      { kind: 'tool_call', ordinal: 1, name: 'Bash' },
      { kind: 'tool_call', ordinal: 2, name: 'Edit' },
    ]), fingerprint: [] });

    expect(column(dbPath, 'SELECT name FROM events WHERE root_id = ? ORDER BY ordinal', 'r-a')).toEqual([
      'Read',
      'Bash',
      'Edit',
    ]);
    expect(column(dbPath, 'SELECT name FROM events WHERE root_id = ? ORDER BY ordinal', 'r-b')).toEqual(['Grep']);
    expect(store.readRoot('dsh', 'r-b')?.dataset.sessions[0]?.records[0]?.events).toEqual([
      { kind: 'tool_call', ordinal: 0, name: 'Grep' },
    ]);

    // A later scan that saw fewer calls loses the calls that are gone with them.
    store.writeRoot({ agent: 'dsh', rootId: 'r-a', root: rootA, now: 4, dataset: toolsRoot(rootA, [
      { kind: 'tool_call', ordinal: 0, name: 'Read' },
    ]), fingerprint: [] });
    expect(column(dbPath, 'SELECT name FROM events WHERE root_id = ?', 'r-a')).toEqual(['Read']);
  });

  it('keeps the events of a session whose file is gone', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    const vanished = session({
      id: 's-gone',
      agent: 'dsh',
      sourceFile: join(root, 'logs', 'gone.jsonl'),
      records: [record({ id: 'r-gone', time: 5, events: [
        { kind: 'tool_call', ordinal: 0, name: 'Bash', detail: 'npm test', ok: false },
      ] })],
    });
    const live = session({
      id: 's-live',
      agent: 'dsh',
      sourceFile: join(root, 'logs', 'live.jsonl'),
      records: [record({ id: 'r-live', time: 6, events: [{ kind: 'tool_call', ordinal: 0, name: 'Read' }] })],
    });
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 1,
      dataset: dataset([project({ id: 'p', sessions: [vanished, live] })], { agent: 'dsh', agents: ['dsh'], source: root }),
      fingerprint: [fingerprintFor(root, 'logs/gone.jsonl'), fingerprintFor(root, 'logs/live.jsonl')],
    });

    // The file is gone; the session it fed is kept, and so is what it did.
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 2,
      dataset: dataset([project({ id: 'p', sessions: [live] })], { agent: 'dsh', agents: ['dsh'], source: root }),
      fingerprint: [fingerprintFor(root, 'logs/live.jsonl')],
      vanishedFiles: ['logs/gone.jsonl'],
    });

    const read = store.readRoot('dsh', 'r-1');
    expect(read?.staleSessionIds).toEqual(['s-gone']);
    expect(read?.dataset.sessions[0]?.records[0]?.events).toEqual([
      { kind: 'tool_call', ordinal: 0, name: 'Bash', detail: 'npm test', ok: false },
    ]);
    // The live session's calls were replaced with what this scan read, and the
    // tombstone's rows are still there rather than orphaned.
    expect(read?.dataset.sessions[1]?.records[0]?.events).toEqual([{ kind: 'tool_call', ordinal: 0, name: 'Read' }]);
    expect(column(dbPath, 'SELECT name FROM events ORDER BY name')).toEqual(['Bash', 'Read']);
  });
});
