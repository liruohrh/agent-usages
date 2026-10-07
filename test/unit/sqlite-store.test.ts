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

/**
 * A dataset as a build that knew nothing about tool calls wrote it.
 *
 * The shape of every database on disk before the extraction existed, and of the
 * ones a released build left behind: real sessions and records, no events.
 */
function eventlessDataset(root: string, sessionId: string): UsageDataset {
  const worker = session({
    id: sessionId,
    agent: 'dsh',
    sourceFile: join(root, 'logs', `${sessionId}.jsonl`),
    records: [record({ id: `r-${sessionId}`, time: 1_700_000_000_000 })],
  });
  return dataset([project({ id: 'p', sessions: [worker] })], {
    agent: 'dsh',
    agents: ['dsh'],
    source: root,
    stats: { filesRead: [join(root, 'logs', `${sessionId}.jsonl`)], sessions: 1, records: 1 },
  });
}

/** The same root, read by a build that extracts the tool call it made. */
function toolsDataset(root: string, sessionId: string): UsageDataset {
  const worker = session({
    id: sessionId,
    agent: 'dsh',
    sourceFile: join(root, 'logs', `${sessionId}.jsonl`),
    records: [
      record({
        id: `r-${sessionId}`,
        time: 1_700_000_000_000,
        events: [{ kind: 'tool_call', ordinal: 0, name: 'Read' }],
      }),
    ],
  });
  return dataset([project({ id: 'p', sessions: [worker] })], {
    agent: 'dsh',
    agents: ['dsh'],
    source: root,
    stats: { filesRead: [join(root, 'logs', `${sessionId}.jsonl`)], sessions: 1, records: 1 },
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
    const first = await openStore(dbPath, '1.2.3');
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

    // The same version again: the cache is used, nothing is rebuilt, and the
    // file's own bookkeeping rows stay put.
    const second = await openStore(dbPath, '1.2.3');
    expect(second.reset).toBeNull();
    expect(second.store.fingerprintOf('dsh', 'r-1')).toHaveLength(1);
    expect(second.store.readRoot('dsh', 'r-1')?.dataset.sessions).toHaveLength(2);
    expect(second.store.readRoot('dsh', 'r-1')?.lastSeen).toBe(1);
    expect(cell(dbPath, 'SELECT value FROM meta WHERE key = ?', 'created_at')).toBe(created);
    expect(cell(dbPath, 'SELECT value FROM meta WHERE key = ?', 'tool_version')).toBe('1.2.3');
    expect(Number(cell(dbPath, 'PRAGMA user_version'))).toBe(STORE_SCHEMA_VERSION);
  });

  it('treats every root as a cache miss when another version wrote the database', async () => {
    const root = join(dir, 'home');
    const quiet = eventlessDataset(root, 's-old');

    // A database as the released build left it: version 0.0.3, a real dataset,
    // and no events — that build could not extract them.
    const old = await openStore(dbPath, '0.0.3');
    old.store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 1, dataset: quiet, fingerprint: [fingerprintFor(root, 'logs/s-old.jsonl')] });
    expect(old.store.fingerprintOf('dsh', 'r-1')).toHaveLength(1);
    expect(column(dbPath, 'SELECT ordinal FROM events')).toEqual([]);
    old.store.close();

    // The new build opens it: the files have not changed, but what a reader
    // extracts from them has, so nothing here may be served as a hit.
    const upgraded = await openStore(dbPath, '0.1.0');
    expect(upgraded.reset).toBeNull();
    expect(upgraded.store.fingerprintOf('dsh', 'r-1')).toBeUndefined();
    expect(upgraded.store.fingerprintOf('dsh', 'never')).toBeUndefined();
    // Not a reset: the rows are still there to be read, and nothing was cleared.
    expect(upgraded.store.readRoot('dsh', 'r-1')?.dataset.sessions).toHaveLength(1);
    expect(upgraded.store.rootsOf('dsh')).toHaveLength(1);
    // The version is recorded as the one looking at the file now.
    expect(cell(dbPath, 'SELECT value FROM meta WHERE key = ?', 'tool_version')).toBe('0.1.0');

    // The scan that follows re-reads the root and writes it back: the new field
    // is there, and the root is a cache entry again.
    upgraded.store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 2,
      dataset: toolsDataset(root, 's-old'),
      fingerprint: [fingerprintFor(root, 'logs/s-old.jsonl')],
    });
    expect(upgraded.store.fingerprintOf('dsh', 'r-1')).toHaveLength(1);
    expect(upgraded.store.readRoot('dsh', 'r-1')?.dataset.sessions[0]?.records[0]?.events).toEqual([
      { kind: 'tool_call', ordinal: 0, name: 'Read' },
    ]);
    expect(column(dbPath, 'SELECT name FROM events')).toEqual(['Read']);
    upgraded.store.close();

    // And the next run of the same version hits the cache — an upgrade costs one
    // re-read, not a re-read every time.
    const settled = await openStore(dbPath, '0.1.0');
    expect(settled.store.fingerprintOf('dsh', 'r-1')).toHaveLength(1);
    expect(settled.store.readRoot('dsh', 'r-1')?.lastSeen).toBe(2);
  });

  it('keeps reading a stale entry for a root this run has not re-read', async () => {
    // A server rescans on a timer: the first pass after an upgrade re-reads every
    // root, and later passes must not re-read them again just because the file
    // still says an older version wrote them.
    const root = join(dir, 'home');
    const other = join(dir, 'other');
    const old = await openStore(dbPath, '0.0.3');
    old.store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 1, dataset: eventlessDataset(root, 's-1'), fingerprint: [] });
    old.store.writeRoot({ agent: 'dsh', rootId: 'r-2', root: other, now: 1, dataset: eventlessDataset(other, 's-2'), fingerprint: [] });
    old.store.close();

    const store = (await openStore(dbPath, '0.1.0')).store;
    expect(store.fingerprintOf('dsh', 'r-1')).toBeUndefined();
    expect(store.fingerprintOf('dsh', 'r-2')).toBeUndefined();
    store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 2, dataset: toolsDataset(root, 's-1'), fingerprint: [] });
    // The one it rewrote is current; the one it has not touched is still a miss.
    expect(store.fingerprintOf('dsh', 'r-1')).toHaveLength(0);
    expect(store.fingerprintOf('dsh', 'r-2')).toBeUndefined();
  });

  it('still re-reads a root after a run that recorded its version but wrote nothing', async () => {
    const root = join(dir, 'home');
    const old = await openStore(dbPath, '0.0.3');
    old.store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 1, dataset: eventlessDataset(root, 's-1'), fingerprint: [] });
    old.store.close();

    // A run of the newer version that was killed between opening the file and
    // writing its first root. All that is left of it is the version it recorded
    // on open — the rows are still the old build's work.
    const killed = await openStore(dbPath, '0.1.0');
    expect(killed.store.fingerprintOf('dsh', 'r-1')).toBeUndefined();
    killed.store.close();
    expect(cell(dbPath, 'SELECT value FROM meta WHERE key = ?', 'tool_version')).toBe('0.1.0');

    // So the next run must not take that version for an answer: the root's own
    // record of who wrote it is what decides, and it still says 0.0.3. (This is
    // the file as it is on disk after such a run: version row updated, rows not.)
    expect(cell(dbPath, 'SELECT reader_version FROM roots WHERE root_id = ?', 'r-1')).toBe('0.0.3');
    const next = await openStore(dbPath, '0.1.0');
    expect(next.store.fingerprintOf('dsh', 'r-1')).toBeUndefined();
    // Remembered all the same: it is this root's history, not its freshness.
    expect(next.store.knowsRoot('dsh', 'r-1')).toBe(true);
    expect(next.store.readRoot('dsh', 'r-1')?.dataset.sessions).toHaveLength(1);

    // Once the re-read happens, the root carries the version that did it, and the
    // run after that is a hit again — one upgrade, one re-read.
    next.store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 2, dataset: toolsDataset(root, 's-1'), fingerprint: [] });
    next.store.close();
    expect(cell(dbPath, 'SELECT reader_version FROM roots WHERE root_id = ?', 'r-1')).toBe('0.1.0');
    const after = await openStore(dbPath, '0.1.0');
    expect(after.store.fingerprintOf('dsh', 'r-1')).toHaveLength(0);
  });

  it('answers "do you know this root?" independently of who wrote it', async () => {
    const store = await emptyStore();
    expect(store.knowsRoot('dsh', 'r-1')).toBe(false);
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root: join(dir, 'home'),
      now: 1,
      dataset: eventlessDataset(join(dir, 'home'), 's-1'),
      fingerprint: [],
    });
    expect(store.knowsRoot('dsh', 'r-1')).toBe(true);
    // A different agent, or a different root: not known.
    expect(store.knowsRoot('codex', 'r-1')).toBe(false);
    expect(store.knowsRoot('dsh', 'r-2')).toBe(false);
  });

  it('keeps a tombstone session and its events across a version change', async () => {
    const root = join(dir, 'home');
    const gone = session({
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
    const both = dataset([project({ id: 'p', sessions: [gone, live] })], { agent: 'dsh', agents: ['dsh'], source: root });
    const files = [fingerprintFor(root, 'logs/gone.jsonl'), fingerprintFor(root, 'logs/live.jsonl')];

    // The old build reads the root, then sees one of its two files disappear: the
    // session it fed becomes a tombstone, and nothing can read it back from a log.
    const old = await openStore(dbPath, '0.1.0');
    old.store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 1, dataset: both, fingerprint: files });
    old.store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 2,
      dataset: dataset([project({ id: 'p', sessions: [live] })], { agent: 'dsh', agents: ['dsh'], source: root }),
      fingerprint: [fingerprintFor(root, 'logs/live.jsonl')],
      vanishedFiles: ['logs/gone.jsonl'],
    });
    expect(old.store.readRoot('dsh', 'r-1')?.staleSessionIds).toEqual(['s-gone']);
    old.store.close();

    // A version that never saw that log opens the file: the tombstone and what it
    // did are still readable, and re-reading the root does not lose them.
    const newer = (await openStore(dbPath, '0.2.0')).store;
    const before = newer.readRoot('dsh', 'r-1');
    expect(before?.staleSessionIds).toEqual(['s-gone']);
    expect(before?.dataset.sessions[0]?.records[0]?.events).toEqual([
      { kind: 'tool_call', ordinal: 0, name: 'Bash', detail: 'npm test', ok: false },
    ]);
    newer.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 3,
      dataset: toolsDataset(root, 's-live'),
      fingerprint: [fingerprintFor(root, 'logs/live.jsonl')],
      vanishedFiles: ['logs/gone.jsonl'],
    });
    const after = newer.readRoot('dsh', 'r-1');
    expect(after?.staleSessionIds).toEqual(['s-gone']);
    expect(after?.dataset.sessions[0]?.records[0]?.events).toEqual([
      { kind: 'tool_call', ordinal: 0, name: 'Bash', detail: 'npm test', ok: false },
    ]);
    expect(column(dbPath, 'SELECT name FROM events ORDER BY name')).toEqual(['Bash', 'Read']);
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

  it('upgrades a version 2 database, trusting none of the roots it finds', async () => {
    // What every database written by the released versions looks like: the v1
    // schema plus the events table, and no record of which reader wrote a root.
    const v2Path = join(dir, 'v2.db');
    seedVersion1(v2Path);
    const older = new DatabaseSync(v2Path);
    older.exec(`
CREATE TABLE events (
  agent TEXT NOT NULL, root_id TEXT NOT NULL, session_id TEXT NOT NULL, record_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  detail TEXT, bytes INTEGER, ok INTEGER,
  PRIMARY KEY (agent, root_id, session_id, record_id, ordinal),
  FOREIGN KEY (agent, root_id, session_id, record_id)
    REFERENCES records(agent, root_id, session_id, record_id) ON DELETE CASCADE
);
CREATE INDEX events_name ON events(name);
CREATE INDEX events_session_id ON events(session_id);
PRAGMA user_version = 2;
`);
    older.close();

    const { store, reset } = await openStore(v2Path, '0.2.0');
    expect(reset).toBeNull();
    expect(Number(cell(v2Path, 'PRAGMA user_version'))).toBe(STORE_SCHEMA_VERSION);
    expect(column(v2Path, "SELECT name FROM pragma_table_info('roots')")).toContain('reader_version');
    // Nothing is lost: same rows, still readable, and a session's events are
    // simply absent because that file never had any.
    expect(store.readRoot('dsh', 'r-v1')?.dataset.sessions[0]?.records[0]?.tokens.input).toBe(42);
    expect(store.readRoot('dsh', 'r-v1')?.dataset.sessions[0]?.records[0]?.events).toBeUndefined();
    // Remembered, but written before anyone said who wrote it: re-read once.
    expect(store.knowsRoot('dsh', 'r-v1')).toBe(true);
    expect(store.fingerprintOf('dsh', 'r-v1')).toBeUndefined();
    // The copy taken before the migration is the v2 file, column and all.
    const backup = `${v2Path}${STORE_MIGRATION_BACKUP_SUFFIX}2`;
    expect(Number(cell(backup, 'PRAGMA user_version'))).toBe(2);
    expect(column(backup, "SELECT name FROM pragma_table_info('roots')")).not.toContain('reader_version');
    expect(cell(backup, 'SELECT record_id FROM records')).toBe('rec-v1');

    // Reading the root again stamps it, and the run after that is a hit.
    const only = fingerprintFor('/home/old', 'logs/a.jsonl');
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-v1',
      root: '/home/old',
      now: 1_600_000_100_000,
      dataset: richDataset('/home/old'),
      fingerprint: [only],
    });
    expect(cell(v2Path, 'SELECT reader_version FROM roots WHERE root_id = ?', 'r-v1')).toBe('0.2.0');
    expect(store.fingerprintOf('dsh', 'r-v1')).toEqual([only]);
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

describe('what the store holds', () => {
  /** A root with two projects, two working directories, and a session in none of them. */
  function layeredRoot(root: string): UsageDataset {
    const inApp = session({
      id: 's-app',
      agent: 'dsh',
      title: 'app work',
      cwd: join(root, 'app'),
      createdAt: 1_700_000_000_000,
      sourceFile: join(root, 'logs', 'a.jsonl'),
      records: [record({ id: 'r-app', time: 1_700_000_100_000, events: [{ kind: 'tool_call', ordinal: 0, name: 'Read' }] })],
    });
    const inAppToo = session({
      id: 's-app-2',
      agent: 'dsh',
      title: 'more app work',
      cwd: join(root, 'app'),
      createdAt: 1_700_000_200_000,
      records: [record({ id: 'r-app-2', time: 1_700_000_300_000 })],
    });
    const inDocs = session({
      id: 's-docs',
      agent: 'dsh',
      title: 'docs',
      cwd: join(root, 'docs'),
      createdAt: 1_700_000_400_000,
      records: [record({ id: 'r-docs', time: 1_700_000_500_000, events: [
        { kind: 'tool_call', ordinal: 0, name: 'Bash' },
        { kind: 'tool_call', ordinal: 1, name: 'Bash' },
      ] })],
    });
    const homeless = session({ id: 's-none', agent: 'dsh', title: 'no cwd', cwd: null, records: [record({ id: 'r-none', time: 1_700_000_600_000 })] });
    return dataset(
      [
        project({ id: 'p-app', name: 'The App', sessions: [inApp, inAppToo] }),
        project({ id: 'p-docs', name: 'The Docs', sessions: [inDocs] }),
      ],
      {
        agent: 'dsh',
        agents: ['dsh'],
        source: root,
        // `s-none` is in the flat list and in no project: the overview still has to
        // account for its rows.
        sessions: [inApp, inAppToo, inDocs, homeless],
        stats: { filesRead: [], sessions: 4, records: 4 },
      },
    );
  }

  it('describes agents, roots, projects, cwds and sessions with their totals', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    store.writeRoot({ agent: 'dsh', rootId: 'r-1', root, now: 1, dataset: layeredRoot(root), fingerprint: [] });
    store.writeRoot({
      agent: 'codex',
      rootId: 'r-2',
      root: join(dir, 'codex'),
      now: 2,
      dataset: eventlessDataset(join(dir, 'codex'), 's-codex'),
      fingerprint: [],
    });

    const [codex, dsh] = store.storeOverview();
    expect(codex?.kind).toBe('agent');
    expect(codex?.id).toBe('codex');
    expect(codex?.sessions).toBe(1);
    expect(dsh?.id).toBe('dsh');
    expect(dsh?.sessions).toBe(4);
    expect(dsh?.records).toBe(4);
    expect(dsh?.events).toBe(3);
    expect(dsh?.lastActivity).toBe(1_700_000_600_000);

    const [rootNode] = dsh?.children ?? [];
    expect(rootNode?.kind).toBe('root');
    expect(rootNode?.id).toBe(root);
    expect(rootNode?.label).toBe(root);
    const byProject = new Map((rootNode?.children ?? []).map((node) => [node.id, node]));
    expect([...byProject.keys()].sort()).toEqual(['', 'p-app', 'p-docs']);
    expect(byProject.get('p-app')?.label).toBe('The App');
    expect(byProject.get('p-app')?.sessions).toBe(2);
    expect(byProject.get('p-app')?.events).toBe(1);
    // The session no project lists is still accounted for, under the empty id.
    expect(byProject.get('')?.sessions).toBe(1);

    const app = byProject.get('p-app');
    const byCwd = new Map((app?.children ?? []).map((node) => [node.id, node]));
    expect([...byCwd.keys()]).toEqual([join(root, 'app')]);
    const [appSession] = (byCwd.get(join(root, 'app'))?.children ?? []).sort((left, right) => left.id.localeCompare(right.id));
    expect(appSession?.kind).toBe('session');
    expect(appSession?.id).toBe('s-app');
    expect(appSession?.label).toBe('app work');
    expect(appSession?.sessions).toBe(1);
    expect(appSession?.records).toBe(1);
    expect(appSession?.events).toBe(1);
    expect(appSession?.lastActivity).toBe(1_700_000_100_000);
    expect(appSession?.children).toEqual([]);

    const docs = byProject.get('p-docs');
    expect(docs?.children[0]?.id).toBe(join(root, 'docs'));
    expect(docs?.children[0]?.children[0]?.events).toBe(2);
    // A session without a working directory is grouped under the empty id too.
    expect(byProject.get('')?.children[0]?.id).toBe('');
  });

  it('shows every reader version a node holds, including "nobody said"', async () => {
    const root = join(dir, 'home');
    const old = await openStore(dbPath, '0.1.0');
    old.store.writeRoot({ agent: 'dsh', rootId: 'r-old', root, now: 1, dataset: eventlessDataset(root, 's-old'), fingerprint: [] });
    old.store.close();

    const store = (await openStore(dbPath, '0.2.0')).store;
    store.writeRoot({ agent: 'dsh', rootId: 'r-new', root: join(dir, 'new'), now: 2, dataset: eventlessDataset(join(dir, 'new'), 's-new'), fingerprint: [] });
    store.writeRoot({ agent: 'dsh', rootId: 'r-silent', root: join(dir, 'silent'), now: 3, dataset: eventlessDataset(join(dir, 'silent'), 's-silent'), fingerprint: [] });
    store.close();
    // A root from before the column existed: nothing says who wrote it.
    const raw = new DatabaseSync(dbPath);
    raw.prepare('UPDATE roots SET reader_version = NULL WHERE root_id = ?').run('r-silent');
    raw.close();

    const reading = (await openStore(dbPath, '0.2.0')).store;
    const [agent] = reading.storeOverview();
    // One node, three answers: rows written by another build, by this one, and by
    // a build that never said.
    expect(agent?.readerVersions).toEqual([null, '0.1.0', '0.2.0']);
    const roots = new Map((agent?.children ?? []).map((node) => [node.id, node]));
    expect(roots.get(root)?.readerVersions).toEqual(['0.1.0']);
    expect(roots.get(join(dir, 'new'))?.readerVersions).toEqual(['0.2.0']);
    expect(roots.get(join(dir, 'silent'))?.readerVersions).toEqual([null]);
    // And it is visible at every level below, because that is where a reader looks.
    expect(roots.get(join(dir, 'new'))?.children[0]?.readerVersions).toEqual(['0.2.0']);
  });

  it('reports the file, the schema and the tool that wrote it', async () => {
    const store = (await openStore(dbPath, '1.2.3')).store;
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root: join(dir, 'home'),
      now: 1,
      dataset: eventlessDataset(join(dir, 'home'), 's-1'),
      fingerprint: [],
    });
    const stats = store.stats();
    expect(stats.path).toBe(dbPath);
    expect(stats.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(stats.toolVersion).toBe('1.2.3');
    expect(stats.bytes).toBeGreaterThan(0);
  });

  it('says a store that lives in memory has no bytes on disk', async () => {
    const { store } = await openStore(dir);
    expect(store.stats().bytes).toBe(0);
    expect(store.stats().path).toBe(dir);
  });
});

describe('forgetting', () => {
  /** Three roots: two for one agent, one for another, each with sessions and events. */
  async function stocked(): Promise<UsageStore> {
    const store = await emptyStore();
    const parent = join(dir, 'datas');
    for (const [agent, rootId, name, cwd] of [
      ['dsh', 'r-a1', 'mine', join(parent, 'mine')],
      ['dsh', 'r-a2', 'borrowed', join(parent, 'borrowed')],
      ['codex', 'r-b1', 'theirs', join(parent, 'theirs')],
    ] as const) {
      const root = join(parent, name);
      const worker = session({
        id: `s-${name}`,
        agent,
        cwd,
        sourceFile: join(root, 'log.jsonl'),
        records: [record({ id: `r-${name}`, time: 10, events: [{ kind: 'tool_call', ordinal: 0, name: 'Read' }] })],
      });
      store.writeRoot({
        agent,
        rootId,
        root,
        now: 1,
        dataset: dataset([project({ id: `p-${name}`, name, sessions: [worker] })], { agent, agents: [agent], source: root }),
        fingerprint: [fingerprintFor(root, 'log.jsonl')],
      });
    }
    return store;
  }

  it('forgets one root by exact path, leaving its neighbours alone', async () => {
    const store = await stocked();
    const parent = join(dir, 'datas');
    const result = store.forget({ root: join(parent, 'borrowed') });
    expect(result.deleted).toEqual({ roots: 1, files: 1, sessions: 1, records: 1, events: 1 });
    expect(result.total).toBe(5);
    expect(result.roots).toEqual([
      { agent: 'dsh', rootId: 'r-a2', root: join(parent, 'borrowed'), rows: 5, reset: false },
    ]);
    expect(store.rootSummaries().map((entry) => entry.rootId).sort()).toEqual(['r-a1', 'r-b1']);
    // The other agent's root with the same kind of name is untouched.
    expect(store.readRoot('codex', 'r-b1')?.dataset.sessions).toHaveLength(1);
  });

  it('counts a dry run exactly like the real one, and rolls it back', async () => {
    const store = await stocked();
    const before = store.stats().bytes;
    const walked = store.forget({ rootPrefix: join(dir, 'datas') }, { dryRun: true });
    // The figures `--yes` would print are the deletion's own, not an estimate.
    expect(walked.total).toBe(15);
    expect(walked.roots).toHaveLength(3);
    // Rolled back: every root is still there, with its fingerprint and reader version.
    expect(store.rootSummaries()).toHaveLength(3);
    expect(store.fingerprintOf('dsh', 'r-a1')).toHaveLength(1);
    expect(store.stats().bytes).toBe(before);

    // And the real call on the same selector does exactly what the dry run said.
    const real = store.forget({ rootPrefix: join(dir, 'datas') });
    expect(real.total).toBe(walked.total);
    expect(store.rootSummaries()).toEqual([]);
  });

  it('says which build wrote a root, and tells an unknown root apart from an old one', async () => {
    const store = await stocked();
    expect(store.readerVersionOf('dsh', 'r-a1')).toBe('1.2.3');
    // Never heard of it: not the same answer as "written before the column existed".
    expect(store.readerVersionOf('dsh', 'r-nope')).toBeUndefined();

    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec("UPDATE roots SET reader_version = NULL WHERE root_id = 'r-a1'");
    } finally {
      raw.close();
    }
    expect(store.readerVersionOf('dsh', 'r-a1')).toBeNull();
  });

  it('forgets every root under a path prefix, by whole path segment', async () => {
    const store = await stocked();
    const parent = join(dir, 'datas');
    // Nothing matches: `datas-other` is not inside `datas`.
    expect(store.forget({ rootPrefix: `${parent}-other` }).total).toBe(0);
    const result = store.forget({ rootPrefix: parent });
    expect(result.deleted.roots).toBe(3);
    // By agent, then by root: the order the store lists roots in.
    expect(result.roots.map((entry) => entry.rootId)).toEqual(['r-b1', 'r-a1', 'r-a2']);
    expect(store.rootSummaries()).toEqual([]);
    expect(store.knowsRoot('dsh', 'r-a1')).toBe(false);
  });

  it('forgets one agent, leaving the other agent and its roots', async () => {
    const store = await stocked();
    const result = store.forget({ agent: 'dsh' });
    expect(result.deleted.roots).toBe(2);
    expect(result.roots.map((entry) => entry.agent)).toEqual(['dsh', 'dsh']);
    expect(store.rootSummaries().map((entry) => entry.rootId)).toEqual(['r-b1']);
  });

  it('forgets everything, and gives the space back when asked', async () => {
    const store = await stocked();
    const before = store.stats().bytes;
    expect(store.forget({ all: true }).total).toBe(15);
    expect(store.rootSummaries()).toEqual([]);
    expect(column(dbPath, 'SELECT count(*) AS n FROM events')).toEqual([0]);
    store.vacuum();
    // The rows are gone either way; the vacuum is what returns the pages.
    expect(store.stats().bytes).toBeLessThanOrEqual(before);
    expect(store.stats().schemaVersion).toBe(STORE_SCHEMA_VERSION);
  });

  it('forgets one session and clears what the store remembered about its root', async () => {
    const store = await stocked();
    const parent = join(dir, 'datas');
    // The root is reusable before the partial forget...
    expect(store.fingerprintOf('dsh', 'r-a1')).toHaveLength(1);

    const result = store.forget({ session: 's-mine' });
    expect(result.deleted).toEqual({ roots: 0, files: 1, sessions: 1, records: 1, events: 1 });
    expect(result.roots).toEqual([
      { agent: 'dsh', rootId: 'r-a1', root: join(parent, 'mine'), rows: 4, reset: true },
    ]);
    // ...and not after it: the fingerprint said the files had not changed while
    // the dataset beside it was missing a session, so both were dropped. The next
    // scan reads the whole root again.
    expect(store.fingerprintOf('dsh', 'r-a1')).toBeUndefined();
    expect(column(dbPath, 'SELECT count(*) AS n FROM files WHERE root_id = ?', 'r-a1')).toEqual([0]);
    expect(column(dbPath, 'SELECT reader_version FROM roots WHERE root_id = ?', 'r-a1')).toEqual([null]);
    expect(store.knowsRoot('dsh', 'r-a1')).toBe(true);
    // The root is still there — a partial forget is not a deletion of the root —
    // and so are its other sessions.
    expect(store.readRoot('dsh', 'r-a1')?.dataset.sessions).toEqual([]);
    expect(store.readRoot('dsh', 'r-a2')?.dataset.sessions).toHaveLength(1);

    // And re-reading it is what puts it back together.
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-a1',
      root: join(parent, 'mine'),
      now: 9,
      dataset: eventlessDataset(join(parent, 'mine'), 's-mine'),
      fingerprint: [fingerprintFor(join(parent, 'mine'), 'log.jsonl')],
    });
    expect(store.fingerprintOf('dsh', 'r-a1')).toHaveLength(1);
  });

  it('forgets a project and a working directory, as intersections', async () => {
    const store = await emptyStore();
    const root = join(dir, 'home');
    const app = session({ id: 's-app', agent: 'dsh', cwd: join(root, 'app'), records: [record({ id: 'r-1', time: 1 })] });
    const docs = session({ id: 's-docs', agent: 'dsh', cwd: join(root, 'docs'), records: [record({ id: 'r-2', time: 2 })] });
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 1,
      dataset: dataset([project({ id: 'p-app', sessions: [app] }), project({ id: 'p-docs', sessions: [docs] })], {
        agent: 'dsh',
        agents: ['dsh'],
        source: root,
      }),
      fingerprint: [fingerprintFor(root, 'log.jsonl')],
    });

    const byProject = store.forget({ project: 'p-app' });
    expect(byProject.deleted.sessions).toBe(1);
    expect(byProject.roots[0]?.reset).toBe(true);
    expect(store.readRoot('dsh', 'r-1')?.dataset.sessions.map((entry) => entry.id)).toEqual(['s-docs']);

    // A directory and everything under it: the cwd of a session in a subdirectory.
    store.writeRoot({
      agent: 'dsh',
      rootId: 'r-1',
      root,
      now: 2,
      dataset: dataset([
        project({ id: 'p-app', sessions: [session({ id: 's-deep', agent: 'dsh', cwd: join(root, 'app', 'inner'), records: [record({ id: 'r-3', time: 3 })] })] }),
        project({ id: 'p-docs', sessions: [docs] }),
      ], { agent: 'dsh', agents: ['dsh'], source: root }),
      fingerprint: [fingerprintFor(root, 'log.jsonl')],
    });
    const byCwd = store.forget({ cwd: join(root, 'app') });
    expect(byCwd.deleted.sessions).toBe(1);
    expect(store.readRoot('dsh', 'r-1')?.dataset.sessions.map((entry) => entry.id)).toEqual(['s-docs']);

    // A selector that matches nothing changes nothing — not even a root's memory,
    // which the deletions above had already dropped.
    const memory = store.fingerprintOf('dsh', 'r-1');
    expect(memory).toBeUndefined();
    const nothing = store.forget({ cwd: join(root, 'nowhere') });
    expect(nothing.total).toBe(0);
    expect(nothing.roots).toEqual([]);
    expect(store.fingerprintOf('dsh', 'r-1')).toBe(memory);
  });

  it('refuses a selector that names nothing, or one that contradicts itself', async () => {
    const store = await stocked();
    expect(() => store.forget({})).toThrow(/needs a selector/);
    expect(() => store.forget({ all: true, agent: 'dsh' })).toThrow(/cannot combine/);
    // Neither attempt deleted anything.
    expect(store.rootSummaries()).toHaveLength(3);
  });
});
