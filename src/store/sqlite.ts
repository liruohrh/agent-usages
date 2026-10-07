/**
 * The usage store: what a scan read, kept in SQLite instead of a JSON blob.
 *
 * The JSON cache it replaces existed to make the second run cheap. This exists
 * to make the data the *user's*: one file in the data directory that can be
 * backed up, opened with any SQLite tool, and queried years later for questions
 * this tool had not asked yet — which tools an agent called, which projects a
 * model was used in, how a number changed. Cheap second runs come along for
 * free, because a root that was already read is rebuilt from a few `SELECT`s
 * rather than by parsing logs again.
 *
 * That goal decides the shape of everything here:
 *
 * - **Rows, not a blob.** Sessions, records and events are tables, and an event
 *   hangs off the request that caused it; a schema version says when the layout
 *   moved, and a version bump copies the database before it changes it.
 * - **A row knows where it came from.** Every row is keyed `(agent, root_id, …)`:
 *   storing a root only touches that root, and "who said this?" is always
 *   answerable. The union across roots is still the merge layer's job.
 * - **Paths inside a root are relative.** `files.rel_path` and
 *   `sessions.source_file` are stored relative to the root, so the data survives
 *   the directory being moved or restored elsewhere. The absolute path lives in
 *   `roots.root` alone.
 * - **Nothing that can be recomputed is stored.** No money: a price list has its
 *   own version and the cost of a record has to be recomputed with the rates of
 *   the moment, not frozen into a file.
 * - **A file that cannot be read is not a failure.** A broken database is moved
 *   aside and rebuilt, never deleted, and {@link UsageStore.open} says what
 *   happened instead of throwing.
 */

import { mkdir, rename } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { muteSqliteExperimentalWarning } from '../core/warnings.ts';

import type { DatasetStats, ProjectRecord, SessionRecord, UsageDataset, UsageEvent, UsageRecord } from '../core/types.ts';
import { warningsFromJson, warningsToJson, type WarningJson } from './dataset-json.ts';
import type { FingerprintStatus, SourceFingerprint } from './fingerprint.ts';

/** The schema this module writes. Bump it when a migration is needed. */
export const STORE_SCHEMA_VERSION = 2;

/** Suffix of the file a broken database is moved aside to. */
export const STORE_BACKUP_SUFFIX = '.corrupt-';

/**
 * Suffix of the copy a migration leaves behind, then the version it came from:
 * `usage.db.bak-v1`.
 *
 * A migration is the one operation that rewrites a database the user may have
 * been keeping for years, so it does not happen without a copy of what was there
 * before it. The copy is made with SQLite's own `VACUUM INTO`, which reads the
 * logical database — a plain file copy would miss whatever is still in the
 * write-ahead log.
 */
export const STORE_MIGRATION_BACKUP_SUFFIX = '.bak-v';

/**
 * How long a writer waits for the lock before giving up, in milliseconds.
 *
 * Two scans can overlap — an editor's command palette and a shell, a server and
 * a CLI — and SQLite's default answer to a busy database is to fail at once. A
 * short wait turns that into a slower answer instead of an error.
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Version 1: roots, their source files, and what was read from them.
 *
 * `PRAGMA user_version` carries the version, and each constant below is one step
 * of the chain (see {@link MIGRATIONS}). The foreign keys are what make a root's
 * rows one unit: deleting a root takes its files, sessions and records with it.
 */
const SCHEMA_V1 = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE roots (
  agent         TEXT NOT NULL,
  root_id       TEXT NOT NULL,
  root          TEXT NOT NULL,
  last_seen     INTEGER NOT NULL,
  agents_json   TEXT NOT NULL,
  projects_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  stats_json    TEXT NOT NULL,
  PRIMARY KEY (agent, root_id)
);

CREATE TABLE files (
  agent     TEXT NOT NULL,
  root_id   TEXT NOT NULL,
  rel_path  TEXT NOT NULL,
  size      INTEGER NOT NULL,
  mtime_ms  REAL NOT NULL,
  head_hash TEXT NOT NULL,
  status    TEXT NOT NULL,
  PRIMARY KEY (agent, root_id, rel_path),
  FOREIGN KEY (agent, root_id) REFERENCES roots(agent, root_id) ON DELETE CASCADE
);

CREATE TABLE sessions (
  agent       TEXT NOT NULL,
  root_id     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  title       TEXT,
  cwd         TEXT,
  created_at  INTEGER,
  parent_id   TEXT,
  depth       INTEGER NOT NULL,
  is_subagent INTEGER NOT NULL,
  archived    INTEGER NOT NULL,
  parent_known INTEGER NOT NULL,
  child_ids_json TEXT NOT NULL,
  source_file TEXT,
  extra_json  TEXT,
  state       TEXT NOT NULL,
  PRIMARY KEY (agent, root_id, session_id),
  FOREIGN KEY (agent, root_id) REFERENCES roots(agent, root_id) ON DELETE CASCADE
);

CREATE TABLE records (
  agent        TEXT NOT NULL,
  root_id      TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  record_id    TEXT NOT NULL,
  time         INTEGER NOT NULL,
  model        TEXT NOT NULL,
  model_label  TEXT NOT NULL,
  input        INTEGER NOT NULL,
  output       INTEGER NOT NULL,
  cache_read   INTEGER NOT NULL,
  cache_write  INTEGER NOT NULL,
  reasoning    INTEGER NOT NULL,
  cache_write_ttl TEXT,
  cache_write_tiers_json TEXT,
  seq          INTEGER,
  turn         INTEGER,
  step         INTEGER,
  PRIMARY KEY (agent, root_id, session_id, record_id),
  FOREIGN KEY (agent, root_id, session_id) REFERENCES sessions(agent, root_id, session_id) ON DELETE CASCADE
);

CREATE INDEX records_time ON records(time);
CREATE INDEX records_model ON records(model);
CREATE INDEX sessions_created_at ON sessions(created_at);
CREATE INDEX sessions_source_file ON sessions(source_file);
`;

/**
 * Version 2: what each request *did*, not just what it cost.
 *
 * Token counts answer "how much"; a tool call answers "what was the agent
 * actually doing" — which tool, on what, and whether it failed. The rows hang
 * off `records` (one event is one thing a request did), so a query can join them
 * to the model, the project and the day of the request that caused them, and a
 * later `kind` (thinking, file edits, compaction) fits without a second table.
 *
 * `ordinal` is part of the primary key because one request can call the same
 * tool twice, and a call that happened twice is not one call.
 */
const SCHEMA_V2 = `
CREATE TABLE events (
  agent      TEXT NOT NULL,
  root_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  record_id  TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  detail     TEXT,
  bytes      INTEGER,
  ok         INTEGER,
  PRIMARY KEY (agent, root_id, session_id, record_id, ordinal),
  FOREIGN KEY (agent, root_id, session_id, record_id)
    REFERENCES records(agent, root_id, session_id, record_id) ON DELETE CASCADE
);

CREATE INDEX events_name ON events(name);
CREATE INDEX events_session_id ON events(session_id);
`;

/** One step of the schema chain: the DDL that reaches `to` from `to - 1`. */
interface MigrationStep {
  /** `user_version` this step produces. */
  readonly to: number;
  /** The DDL to run, for a database that is one version behind. */
  readonly sql: string;
}

/**
 * Every version, in order.
 *
 * A file is brought up by running each step it has not had yet, one transaction
 * per step, so an old database does not take a special path: `v0 → v2` is the
 * same two steps as `v0 → v1` then `v1 → v2`.
 */
const MIGRATIONS: readonly MigrationStep[] = [
  { to: 1, sql: SCHEMA_V1 },
  { to: 2, sql: SCHEMA_V2 },
];

/** A project as stored: everything but its sessions, plus the ids that order them. */
type ProjectSkeleton = Omit<ProjectRecord, 'sessions'> & { sessionIds: string[] };

/** A raw row, as `node:sqlite` hands it over. */
interface RootRow {
  root: string;
  last_seen: number;
  agents_json: string;
  projects_json: string;
  warnings_json: string;
  stats_json: string;
}

interface FileRow {
  rel_path: string;
  size: number;
  mtime_ms: number;
  head_hash: string;
  status: string;
}

interface SessionRow {
  session_id: string;
  title: string | null;
  cwd: string | null;
  created_at: number | null;
  parent_id: string | null;
  depth: number;
  is_subagent: number;
  archived: number;
  parent_known: number;
  child_ids_json: string;
  source_file: string | null;
  extra_json: string | null;
  state: string;
}

interface RecordRow {
  session_id: string;
  record_id: string;
  time: number;
  model: string;
  model_label: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  cache_write_ttl: string | null;
  cache_write_tiers_json: string | null;
  seq: number | null;
  turn: number | null;
  step: number | null;
}

interface EventRow {
  session_id: string;
  record_id: string;
  ordinal: number;
  kind: string;
  name: string;
  detail: string | null;
  bytes: number | null;
  ok: number | null;
}

/** What {@link UsageStore.open} needs to know. */
export interface UsageStoreOpenOptions {
  /** Where the database lives. Parent directories are created. */
  path: string;
  /** Version of the tool opening it, recorded in `meta`. */
  toolVersion: string;
}

/** Why a store was started empty instead of from what was on disk. */
export interface UsageStoreReset {
  /**
   * `corrupt`: not a database, moved aside. `newer`: another version wrote it.
   * `migration`: it could not be safely brought up to this version — the
   * pre-migration backup or the migration itself failed — so it was left as it
   * was. `unreadable`: could not be opened at all.
   */
  reason: 'corrupt' | 'newer' | 'migration' | 'unreadable';
  /** The path that was asked for. */
  path: string;
  /**
   * Where the file that was replaced (or copied before a migration) went, or
   * `null` when nothing was written anywhere.
   */
  backup: string | null;
  /** What was wrong, for a log line or a warning. */
  detail: string;
}

/** The store, and what had to be done to get it. */
export interface UsageStoreOpenResult {
  /** Use this. It is always usable, even when `reset` is set. */
  store: UsageStore;
  /** `null` when the file on disk was used as it was. */
  reset: UsageStoreReset | null;
}

/** One root an agent has data from. */
export interface StoreRootSummary {
  /** Identity of the root: {@link rootIdOf} of its path. */
  rootId: string;
  /** Absolute path of the root, as it was when written. */
  root: string;
  /** When a scan last read it, in milliseconds since the Unix epoch. */
  lastSeen: number;
}

/** What {@link UsageStore.writeRoot} stores. */
export interface WriteRootInput {
  /** Agent that read the root. */
  agent: string;
  /** Identity of the root. */
  rootId: string;
  /** Absolute path of the root. */
  root: string;
  /** When this read happened, in milliseconds since the Unix epoch. */
  now: number;
  /**
   * What the adapter read.
   *
   * Every record's `events` go with it: one row per event, keyed by the record
   * and the event's ordinal. A record with no `events` writes no rows, and comes
   * back with no `events` field — the absence means the log did not say, which
   * an empty array would turn into "nothing happened".
   */
  dataset: UsageDataset;
  /** What the sources looked like, as {@link fingerprintOf} recorded them. */
  fingerprint: readonly SourceFingerprint[];
  /**
   * Sources that are gone, so their sessions are kept and marked instead of
   * being replaced by a scan that no longer sees them.
   *
   * Paths may be absolute or relative to `root`. A path the previous fingerprint
   * named and this one does not is treated as vanished whether or not it is
   * listed here — a file that stopped being a source is exactly what this is for,
   * and silently dropping its sessions would delete usage the user still has.
   */
  vanishedFiles?: readonly string[];
}

/** What {@link UsageStore.readRoot} gives back. */
export interface ReadRootResult {
  /** The dataset as it was written, warnings rendered in the active language. */
  dataset: UsageDataset;
  /** Absolute path of the root when it was written. */
  root: string;
  /** When a scan last read it, in milliseconds since the Unix epoch. */
  lastSeen: number;
  /**
   * Sessions kept from sources that are no longer there.
   *
   * They are in `dataset` like any other session — dropping them would lose
   * usage the user still has — and this is how a reader tells which ones came
   * from a file it can no longer see, so it can mark them instead of counting
   * them as live. `SessionRecord` has no field for it: the state belongs to the
   * store, not to the domain model.
   */
  staleSessionIds: readonly string[];
}

/**
 * A root's path as stored: relative when it is inside the root, absolute when it
 * is not (an adapter may read a file elsewhere, and pretending otherwise would
 * invent a path that does not exist).
 * @param root - absolute path of the root.
 * @param path - absolute path of the file.
 * @returns the path to store.
 */
function relPathOf(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return path;
  return sep === '/' ? rel : rel.split(sep).join('/');
}

/**
 * The absolute path of a stored one.
 * @param root - absolute path of the root.
 * @param rel - the stored path.
 * @returns the absolute path.
 */
function absPathOf(root: string, rel: string): string {
  return isAbsolute(rel) ? rel : join(root, rel);
}

/** `PRAGMA user_version`, as a number. */
function schemaVersionOf(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row === undefined ? 0 : Number(row.user_version);
}

/**
 * Read the schema version of an existing file without writing a byte to it.
 *
 * Read-only on purpose: opening a newer file's database read-write would set
 * `journal_mode` and bump the change counter, which is exactly the "destroyed
 * by an older build" outcome {@link UsageStore.open} promises to avoid. A file
 * that is not a database fails here, which is where the damage is detected.
 * @param path - the database path.
 * @returns the version the file declares.
 */
function readOnlyVersion(path: string, driver: SqliteModule): number {
  const db = new driver.DatabaseSync(path, { readOnly: true });
  try {
    return schemaVersionOf(db);
  } finally {
    db.close();
  }
}

/** Raised internally when the file was written by a newer schema. */
class NewerSchemaError extends Error {
  /** The version that was found. */
  readonly version: number;

  constructor(version: number) {
    super(`store schema version ${version} is newer than ${STORE_SCHEMA_VERSION}`);
    this.name = 'NewerSchemaError';
    this.version = version;
  }
}

/**
 * Raised internally when the file claims a schema it does not have.
 *
 * A database half-written by a killed process, or truncated by a full disk, can
 * carry a header that says version 1 while the tables it promises are missing.
 * That is damage like any other: the file is moved aside and rebuilt.
 */
class MissingTablesError extends Error {
  constructor(missing: readonly string[]) {
    super(`schema says version ${STORE_SCHEMA_VERSION} but tables are missing: ${missing.join(', ')}`);
    this.name = 'MissingTablesError';
  }
}

/**
 * Raised internally when a database could not be brought up to this version.
 *
 * Either the pre-migration backup could not be written — in which case nothing
 * was attempted, because a migration that has no way back is not worth running —
 * or the migration itself failed and was rolled back. The file is left as it
 * was, and the caller gets a warning instead of a store.
 */
class MigrationError extends Error {
  /** The copy taken before the attempt, when one was made. */
  readonly backup: string | null;

  constructor(detail: string, backup: string | null) {
    super(detail);
    this.name = 'MigrationError';
    this.backup = backup;
  }
}

/** The tables the current schema promises. */
const REQUIRED_TABLES: readonly string[] = ['events', 'files', 'meta', 'records', 'roots', 'sessions'];

/**
 * Check that the file really holds the schema its version claims.
 * @param db - the connection.
 */
function verifySchema(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as unknown as { name: string }[];
  const present = new Set(rows.map((row) => row.name));
  const missing = REQUIRED_TABLES.filter((name) => !present.has(name));
  if (missing.length > 0) throw new MissingTablesError(missing);
}

/** Whether the error means "this file is not a database we can use". */
function isCorrupt(error: unknown): boolean {
  const code = (error as { errcode?: unknown }).errcode;
  // 11 SQLITE_CORRUPT, 26 SQLITE_NOTADB, and their extended codes.
  if (typeof code === 'number' && (code % 256 === 11 || code % 256 === 26)) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /not a database|malformed|corrupt/i.test(message);
}

/** Whether the error means "the file could not be opened at all". */
function isUnopenable(error: unknown): boolean {
  const code = (error as { errcode?: unknown }).errcode;
  // 3 SQLITE_PERM, 8 SQLITE_READONLY, 14 SQLITE_CANTOPEN, and their extended codes.
  if (typeof code === 'number' && [3, 8, 14].includes(code % 256)) return true;
  const osCode = (error as { code?: unknown }).code;
  return typeof osCode === 'string' && /^(EACCES|EPERM|EROFS|ENOSPC|EISDIR|ENOTDIR|EMFILE|ENFILE|ENOENT)$/.test(osCode);
}

/** A one-line description of a failure, for `reset.detail`. */
function detailOf(error: unknown): string {
  const errstr = (error as { errstr?: unknown }).errstr;
  if (typeof errstr === 'string' && errstr.length > 0) return errstr;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : String(error);
}

/** `2026-10-07T12-30-00-000Z` — sortable, and safe in a file name. */
function stampOf(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Move a broken database (and its WAL sidecars) out of the way.
 * @param path - the database path.
 * @returns where it went, or `null` when there was nothing to move.
 */
async function backupAside(path: string, now: Date): Promise<string | null> {
  const target = `${path}${STORE_BACKUP_SUFFIX}${stampOf(now)}`;
  try {
    await rename(path, target);
  } catch {
    // Nothing there: a path that could not even be created has no file to keep.
    return null;
  }
  for (const sidecar of ['-wal', '-shm']) {
    // Best effort: a sidecar is meaningless without its database, and a scan
    // that cannot move one still has a working store.
    try {
      await rename(`${path}${sidecar}`, `${target}${sidecar}`);
    } catch {
      // Ignored on purpose.
    }
  }
  return target;
}

/**
 * Copy a database before it is migrated, and say where the copy is.
 *
 * `VACUUM INTO` rather than `copyFile`: a database in WAL mode may hold committed
 * rows in its `-wal` sidecar, and a file copy of the main file alone would back
 * up a database missing exactly the recent data a user would miss. `VACUUM INTO`
 * reads through a connection, so what lands in the copy is the logical database,
 * complete, in one file that can be opened anywhere.
 *
 * Synchronous, like the migration it guards: the copy has to be finished and
 * verified before the first write, and it happens between two synchronous steps.
 *
 * @param path - the database to copy.
 * @param from - the version the copy holds, for the name.
 * @returns the path of the copy.
 * @throws when the copy cannot be written; the caller must not migrate then.
 */
function backupBeforeMigration(path: string, from: number, driver: SqliteModule): string {
  const backup = `${path}${STORE_MIGRATION_BACKUP_SUFFIX}${from}`;
  // `VACUUM INTO` refuses to overwrite: a half-written copy from a previous
  // attempt must not be mistaken for a good one, and the state just before *this*
  // migration is the useful thing to keep.
  rmSync(backup, { force: true });
  const db = new driver.DatabaseSync(path, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  return backup;
}

/** The driver, loaded on first use so the warning filter can go in first. */
type SqliteModule = typeof import('node:sqlite');

/** The loaded driver, once {@link loadSqlite} has run. */
let sqliteDriver: SqliteModule | undefined;

/**
 * Load `node:sqlite`, keeping its `ExperimentalWarning` out of the tool's output.
 *
 * Loaded on first use rather than imported: the warning is printed when the
 * module is first imported, so the filter has to be in place before that — see
 * `muteSqliteExperimentalWarning`.
 *
 * @returns the driver.
 */
async function loadSqlite(): Promise<SqliteModule> {
  if (sqliteDriver !== undefined) return sqliteDriver;
  muteSqliteExperimentalWarning();
  sqliteDriver = await import('node:sqlite');
  return sqliteDriver;
}

/**
 * Open a file as a store, migrating a lower schema version and refusing a
 * higher one.
 *
 * A migration never runs without a copy of what was there before it: the copy is
 * taken first, and a copy that cannot be written stops the whole attempt (the
 * caller turns that into "this run works in memory"), because a schema change
 * with no way back is the one thing this file must not do to a user's data.
 *
 * @param path - the database path, or `:memory:`.
 * @param toolVersion - version of the tool, recorded in `meta`.
 * @param driver - the loaded `node:sqlite` module.
 * @returns the open connection.
 * @throws NewerSchemaError, MigrationError, MissingTablesError, or a SQLite error
 *   for a path that cannot be opened; {@link UsageStore.open} turns each into a
 *   structured answer.
 */
function connect(path: string, toolVersion: string, driver: SqliteModule): DatabaseSync {
  let version = 0;
  if (path !== ':memory:' && existsSync(path)) {
    try {
      version = readOnlyVersion(path, driver);
    } catch (error) {
      // Damage is decided here; anything else is decided by the read-write open
      // below, which is the operation the caller actually asked for.
      if (isCorrupt(error)) throw error;
    }
  }
  if (version > STORE_SCHEMA_VERSION) throw new NewerSchemaError(version);

  // Before the read-write open, so the copy is of the file as the user left it —
  // opening it, even just to set `journal_mode`, already writes to the header.
  let backup: string | null = null;
  if (version > 0 && version < STORE_SCHEMA_VERSION) backup = takeBackup(path, version, driver);

  const db = new driver.DatabaseSync(path);
  try {
    // The key between a root and its rows is composite, so the pragma is what
    // makes a root's data one unit rather than three unrelated tables.
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // WAL: a reader never blocks a writer, which is what lets a long scan be
    // read by the server while it is still running.
    db.exec('PRAGMA journal_mode = WAL');
    const onDisk = schemaVersionOf(db);
    if (onDisk > STORE_SCHEMA_VERSION) throw new NewerSchemaError(onDisk);
    if (onDisk < STORE_SCHEMA_VERSION) {
      // A version the read-only probe could not report (a WAL that needs
      // recovery, say) still gets its copy here — later, but before any change
      // to the rows.
      if (backup === null && onDisk > 0) backup = takeBackup(path, onDisk, driver);
      try {
        migrate(db, onDisk, toolVersion);
      } catch (error) {
        throw new MigrationError(
          `migrating from schema version ${onDisk} failed: ${detailOf(error)}`,
          backup,
        );
      }
    } else {
      // A version that is current but whose tables are not is a damaged file
      // that would otherwise be reported as a confusing "no such table" much
      // later, from a read that has no way to recover.
      verifySchema(db);
      recordToolVersion(db, toolVersion);
    }
  } catch (error) {
    try {
      db.close();
    } catch {
      // Already closed or never usable; the error below is the one that matters.
    }
    throw error;
  }
  return db;
}

/**
 * Take the pre-migration copy, or refuse to migrate.
 * @param path - the database to copy.
 * @param from - the version it holds.
 * @param driver - the loaded `node:sqlite` module.
 * @returns the path of the copy.
 * @throws MigrationError when the copy cannot be written.
 */
function takeBackup(path: string, from: number, driver: SqliteModule): string {
  try {
    return backupBeforeMigration(path, from, driver);
  } catch (error) {
    throw new MigrationError(
      `refusing to migrate: the copy taken before it could not be written (${detailOf(error)})`,
      null,
    );
  }
}

/**
 * Bring a database up to {@link STORE_SCHEMA_VERSION}.
 *
 * One step per version, each in its own transaction: a migration that dies is
 * rolled back whole, so the file is left at the version it was, never halfway.
 * A file created by this call runs both steps, so there is exactly one definition
 * of what the schema is.
 * @param db - the connection.
 * @param from - the version found on disk.
 * @param toolVersion - version of the tool, for a freshly created file.
 */
function migrate(db: DatabaseSync, from: number, toolVersion: string): void {
  for (const step of MIGRATIONS) {
    if (step.to <= from) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(step.sql);
      if (step.to === 1) {
        // Created once, when the file starts being ours.
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING')
          .run('created_at', String(Date.now()));
      }
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
        .run('schema_version', String(step.to));
      db.exec(`PRAGMA user_version = ${step.to}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  recordToolVersion(db, toolVersion);
}

/**
 * Note which tool version last touched the file.
 *
 * Informational: it says whether a bug was seen by the build it was reported
 * against, and it is the one meta row that changes on every open.
 * @param db - the connection.
 * @param toolVersion - the version to record.
 */
function recordToolVersion(db: DatabaseSync, toolVersion: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run('tool_version', toolVersion);
}

/**
 * A root's usage, in a database the user owns.
 *
 * Instances come from {@link UsageStore.open}; the constructor is private
 * because opening is the part with decisions in it (which file, which version,
 * what to do when it is broken).
 *
 * Reads and writes are synchronous — SQLite is — and every write is one
 * transaction, so a scan that is interrupted leaves the roots it already
 * finished, not a half-written one.
 */
export class UsageStore {
  /** Where the database lives, as asked for at open. */
  readonly path: string;

  /** The connection, or the in-memory stand-in when the file was unusable. */
  #db: DatabaseSync;

  /** Statements, by SQL: preparing once per statement keeps a big write cheap. */
  #statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  /** Set by {@link close}; every other method refuses to run after it. */
  #closed = false;

  private constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.#db = db;
  }

  /**
   * Open the store at `options.path`, creating it when it is not there.
   *
   * Never throws for the file's own sake:
   *
   * - a file that is not a database (or is corrupt) is moved aside as
   *   `usage.db.corrupt-<time>` and a fresh one is created — the damaged file is
   *   kept because a user who is told "rebuilt" may still want to look at it;
   * - a file written by a newer schema is left exactly as it is and the store
   *   works in memory instead, so an older build cannot destroy a newer one's
   *   data by opening it;
   * - a file this version must migrate is copied to `usage.db.bak-v<from>` first,
   *   and if that copy cannot be written the file is left alone and the run
   *   continues in memory: a schema change is never the first thing to touch a
   *   database that has no copy of itself;
   * - a path that cannot be opened at all (a directory, no permission, a
   *   read-only disk) also falls back to memory, and the scan still runs.
   *
   * In those cases the store is usable — its data just does not outlive the
   * process, and `reset.backup` names the copy or the moved-aside file when one
   * was written. The caller turns `reset` into a warning; that is a decision
   * about language and presentation, which does not belong here.
   *
   * @param options - where the database is, and which tool is opening it.
   * @returns the store, and what had to be done to get it.
   */
  static async open(options: UsageStoreOpenOptions): Promise<UsageStoreOpenResult> {
    const { path, toolVersion } = options;
    const driver = await loadSqlite();
    await mkdir(dirname(path), { recursive: true }).catch(() => {
      // A directory that cannot be created will make `connect` fail below, which
      // produces the `unreadable` answer with a better description than this.
    });

    try {
      return { store: new UsageStore(path, connect(path, toolVersion, driver)), reset: null };
    } catch (error) {
      if (error instanceof NewerSchemaError) {
        return {
          store: UsageStore.#ephemeral(path, toolVersion, driver),
          reset: {
            reason: 'newer',
            path,
            backup: null,
            detail: `user_version ${error.version}`,
          },
        };
      }
      if (error instanceof MigrationError) {
        return UsageStore.#fallback(path, toolVersion, driver, error.message, error.backup, 'migration');
      }
      if (error instanceof MissingTablesError || isCorrupt(error)) {
        const backup = await backupAside(path, new Date());
        try {
          return {
            store: new UsageStore(path, connect(path, toolVersion, driver)),
            reset: { reason: 'corrupt', path, backup, detail: detailOf(error) },
          };
        } catch (later) {
          return UsageStore.#fallback(path, toolVersion, driver, detailOf(later), backup, 'unreadable');
        }
      }
      if (isUnopenable(error)) {
        return UsageStore.#fallback(path, toolVersion, driver, detailOf(error), null, 'unreadable');
      }
      // Not a statement about the file: a bug here would be swallowed by a
      // silent fallback, so it is thrown instead.
      throw error;
    }
  }

  /**
   * A store that keeps its rows in memory: usable, and gone with the process.
   * @param path - the path that was asked for, reported as the store's path.
   * @param toolVersion - version of the tool.
   * @returns the store.
   */
  static #ephemeral(path: string, toolVersion: string, driver: SqliteModule): UsageStore {
    return new UsageStore(path, connect(':memory:', toolVersion, driver));
  }

  /**
   * The store an older build gets to keep working: memory, so nothing is written
   * where the file it could not use is.
   * @param path - the path that was asked for.
   * @param toolVersion - version of the tool.
   * @param driver - the loaded `node:sqlite` module.
   * @param detail - what was wrong.
   * @param backup - where a copy or a moved-aside file went, when one was written.
   * @param reason - why the file could not be used as it was.
   * @returns the store and its reset reason.
   */
  static async #fallback(
    path: string,
    toolVersion: string,
    driver: SqliteModule,
    detail: string,
    backup: string | null,
    reason: UsageStoreReset['reason'],
  ): Promise<UsageStoreOpenResult> {
    try {
      return {
        store: UsageStore.#ephemeral(path, toolVersion, driver),
        reset: { reason, path, backup, detail },
      };
    } catch (error) {
      // An in-memory database needs no filesystem at all, so this is not about
      // the path: something is wrong with the process, and hiding that would be
      // worse than reporting it.
      throw new Error(`usage store ${path} is unusable: ${detail}`, { cause: error });
    }
  }

  /**
   * What the sources looked like when the root was last read.
   * @param agent - the agent that read it.
   * @param rootId - identity of the root.
   * @returns one entry per stored source file, or `undefined` when this store
   *   has never been told about the root. An empty array means the root is
   *   known and was read with no sources at all.
   */
  fingerprintOf(agent: string, rootId: string): readonly SourceFingerprint[] | undefined {
    this.#assertOpen();
    const root = this.#rootPath(agent, rootId);
    if (root === undefined) return undefined;
    const rows = this.#all<FileRow>(
      'SELECT rel_path, size, mtime_ms, head_hash, status FROM files WHERE agent = ? AND root_id = ? ORDER BY rel_path',
      agent,
      rootId,
    );
    return rows.map((row) => ({
      path: absPathOf(root, row.rel_path),
      status: row.status as FingerprintStatus,
      size: Number(row.size),
      mtimeMs: Number(row.mtime_ms),
      headHash: row.head_hash,
    }));
  }

  /**
   * Rebuild the dataset a root was written with.
   *
   * The result is what was stored, not a rescan: warnings are rendered in the
   * language active now, sessions kept from sources that are gone are still
   * here, and `staleSessionIds` says which ones those are.
   *
   * Order is the order things were written in. A dataset written and read back
   * without a source vanishing comes out exactly as a deep-equal copy; after a
   * source vanished the kept sessions hold the rows they already had, so they
   * come before the ones this scan read, and a project lists what the scan read
   * first and the sessions it inherited after that. Nothing above relies on it —
   * the merge layer re-sorts sessions by first usage — but it is stable, which
   * is what makes it usable.
   * @param agent - the agent that read it.
   * @param rootId - identity of the root.
   * @returns the dataset and where it came from, or `undefined` when this store
   *   has never been told about the root.
   */
  readRoot(agent: string, rootId: string): ReadRootResult | undefined {
    this.#assertOpen();
    const rootRow = this.#get<RootRow>(
      'SELECT root, last_seen, agents_json, projects_json, warnings_json, stats_json FROM roots WHERE agent = ? AND root_id = ?',
      agent,
      rootId,
    );
    if (rootRow === undefined) return undefined;

    // Insertion order, not time: a dataset that came out of an adapter in a
    // particular order has to come back out in it, and `time` is only reliable
    // for records a provider actually timestamped in order.
    const sessionRows = this.#all<SessionRow>(
      'SELECT session_id, title, cwd, created_at, parent_id, depth, is_subagent, archived, parent_known, child_ids_json, source_file, extra_json, state FROM sessions WHERE agent = ? AND root_id = ? ORDER BY rowid',
      agent,
      rootId,
    );
    const recordRows = this.#all<RecordRow>(
      'SELECT session_id, record_id, time, model, model_label, input, output, cache_read, cache_write, reasoning, cache_write_ttl, cache_write_tiers_json, seq, turn, step FROM records WHERE agent = ? AND root_id = ? ORDER BY rowid',
      agent,
      rootId,
    );
    // Ordered by `ordinal`, which is what the model means by the order of a
    // record's events: two calls to the same tool in one request keep the order
    // they happened in, not the order their rows were written.
    const eventRows = this.#all<EventRow>(
      'SELECT session_id, record_id, ordinal, kind, name, detail, bytes, ok FROM events WHERE agent = ? AND root_id = ? ORDER BY ordinal',
      agent,
      rootId,
    );

    const eventsByRecord = new Map<string, Map<string, UsageEvent[]>>();
    for (const row of eventRows) {
      const byRecord = eventsByRecord.get(row.session_id) ?? new Map<string, UsageEvent[]>();
      const list = byRecord.get(row.record_id) ?? [];
      list.push(eventOf(row));
      byRecord.set(row.record_id, list);
      eventsByRecord.set(row.session_id, byRecord);
    }

    const recordsBySession = new Map<string, UsageRecord[]>();
    for (const row of recordRows) {
      const list = recordsBySession.get(row.session_id) ?? [];
      // A record with no events gets no `events` field at all: absent means "the
      // log did not say", which an empty array would turn into "nothing happened".
      list.push(recordOf(row, eventsByRecord.get(row.session_id)?.get(row.record_id)));
      recordsBySession.set(row.session_id, list);
    }

    const sessions: SessionRecord[] = [];
    const staleSessionIds: string[] = [];
    const byId = new Map<string, SessionRecord>();
    for (const row of sessionRows) {
      const sessionRecord = sessionOf(agent, rootRow.root, row, recordsBySession.get(row.session_id) ?? []);
      sessions.push(sessionRecord);
      byId.set(sessionRecord.id, sessionRecord);
      if (row.state !== 'live') staleSessionIds.push(sessionRecord.id);
    }

    const skeletons = JSON.parse(rootRow.projects_json) as ProjectSkeleton[];
    const projects: ProjectRecord[] = [];
    for (const skeleton of skeletons) {
      const { sessionIds, ...rest } = skeleton;
      const members = sessionIds.map((id) => byId.get(id)).filter((entry): entry is SessionRecord => entry !== undefined);
      // A project whose sessions are all gone would be a heading with nothing
      // under it; the sessions that remain are what a reader groups.
      if (members.length === 0) continue;
      projects.push({ ...rest, sessions: members });
    }

    return {
      dataset: {
        agent,
        agents: JSON.parse(rootRow.agents_json) as string[],
        source: rootRow.root,
        projects,
        sessions,
        stats: JSON.parse(rootRow.stats_json) as DatasetStats,
        warnings: warningsFromJson(JSON.parse(rootRow.warnings_json) as WarningJson[]),
      },
      root: rootRow.root,
      lastSeen: Number(rootRow.last_seen),
      staleSessionIds,
    };
  }

  /**
   * Store what a scan of one root read, replacing what was there for it.
   *
   * One transaction: either the whole root is updated or none of it is. Sessions
   * whose source file is gone are the exception to "replace" — they are kept,
   * marked `stale`, with their records, because a log the user deleted is not a
   * reason for the usage it held to disappear from a total. Everything else in
   * this `(agent, root_id)` is dropped and rewritten from `input.dataset`, other
   * roots and other agents untouched.
   *
   * A session's `agent` is this store call's `agent`, not the one the session
   * carries: rows are keyed by the root an agent read, so a merged dataset —
   * one dataset holding several agents' sessions — belongs in the store only
   * after it has been split back into the root each agent read.
   *
   * @param input - the agent, the root, what was read and what it looked like.
   */
  writeRoot(input: WriteRootInput): void {
    this.#assertOpen();
    const { agent, rootId, root, now, dataset, fingerprint } = input;
    const vanishedFiles = input.vanishedFiles ?? [];
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#writeRootRows({ agent, rootId, root, now, dataset, fingerprint, vanishedFiles });
      this.#db.exec('COMMIT');
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // The transaction was already unwound; the original error is the one to
        // report.
      }
      throw error;
    }
  }

  /**
   * Every root this agent has data from.
   * @param agent - the agent.
   * @returns one entry per root, most recently seen first.
   */
  rootsOf(agent: string): readonly StoreRootSummary[] {
    this.#assertOpen();
    const rows = this.#all<{ root_id: string; root: string; last_seen: number }>(
      'SELECT root_id, root, last_seen FROM roots WHERE agent = ? ORDER BY last_seen DESC, root_id ASC',
      agent,
    );
    return rows.map((row) => ({ rootId: row.root_id, root: row.root, lastSeen: Number(row.last_seen) }));
  }

  /**
   * Close the database. Safe to call more than once.
   *
   * Nothing is flushed here: every write was its own transaction, so closing is
   * only about letting go of the file.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    try {
      this.#db.close();
    } catch {
      // A connection that is already gone is closed, which is what was asked.
    }
  }

  /** The rows of one write; runs inside the caller's transaction. */
  #writeRootRows(input: WriteRootInput & { vanishedFiles: readonly string[] }): void {
    const { agent, rootId, root, now, dataset, fingerprint, vanishedFiles } = input;
    const previousFiles = this.#all<FileRow>(
      'SELECT rel_path, size, mtime_ms, head_hash, status FROM files WHERE agent = ? AND root_id = ?',
      agent,
      rootId,
    );
    const previous = new Map(previousFiles.map((row) => [row.rel_path, row]));

    // The scan's view of the sources, keyed as stored.
    const current = new Map<string, SourceFingerprint>();
    for (const entry of fingerprint) current.set(relPathOf(root, entry.path), entry);

    // Sources that are gone: the caller's list, whatever the scan found
    // unreadable, and anything the previous scan knew that this one does not.
    // All three mean the same thing to a session: the file it came from is no
    // longer being read, so its usage is kept rather than replaced.
    const vanished = new Set<string>(vanishedFiles.map((path) => relPathOf(root, path)));
    for (const [rel, entry] of current) if (entry.status !== 'ok') vanished.add(rel);
    for (const rel of previous.keys()) if (!current.has(rel)) vanished.add(rel);

    // The sessions already stored for this root, before anything is touched:
    // which ones survive, and which project skeletons have to be carried over
    // with them, both depend on what was here.
    const oldSessions = this.#all<{ session_id: string; source_file: string | null }>(
      'SELECT session_id, source_file FROM sessions WHERE agent = ? AND root_id = ?',
      agent,
      rootId,
    );
    const kept = new Set<string>();
    for (const row of oldSessions) {
      if (row.source_file !== null && vanished.has(row.source_file)) kept.add(row.session_id);
    }

    this.#upsertRoot({ agent, rootId, root, now, dataset, kept });

    this.#run('DELETE FROM files WHERE agent = ? AND root_id = ?', agent, rootId);
    for (const [rel, entry] of current) {
      this.#run(
        'INSERT INTO files (agent, root_id, rel_path, size, mtime_ms, head_hash, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        agent, rootId, rel, entry.size, entry.mtimeMs, entry.headHash, entry.status,
      );
    }
    for (const rel of vanished) {
      if (current.has(rel)) continue;
      const old = previous.get(rel);
      // The row is kept with its old facts, marked missing: what was read from
      // it is still in `sessions`, and this is the record that it was there.
      if (old === undefined) continue;
      this.#run(
        'INSERT INTO files (agent, root_id, rel_path, size, mtime_ms, head_hash, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        agent, rootId, rel, old.size, old.mtime_ms, old.head_hash, 'missing',
      );
    }

    for (const row of oldSessions) {
      if (kept.has(row.session_id)) continue;
      // Deleting the session takes its records with it (ON DELETE CASCADE).
      this.#run('DELETE FROM sessions WHERE agent = ? AND root_id = ? AND session_id = ?', agent, rootId, row.session_id);
    }
    for (const id of kept) {
      this.#run("UPDATE sessions SET state = 'stale' WHERE agent = ? AND root_id = ? AND session_id = ?", agent, rootId, id);
    }

    for (const sessionRecord of dataset.sessions) {
      const sourceFile = sessionRecord.sourceFile === undefined ? null : relPathOf(root, sessionRecord.sourceFile);
      // A session the store already had as stale can come back live: the file it
      // is read from was found again. Its old records are replaced with the ones
      // the scan just produced, exactly as for a new session.
      this.#run('DELETE FROM records WHERE agent = ? AND root_id = ? AND session_id = ?', agent, rootId, sessionRecord.id);
      this.#run('DELETE FROM sessions WHERE agent = ? AND root_id = ? AND session_id = ?', agent, rootId, sessionRecord.id);
      this.#run(
        `INSERT INTO sessions (agent, root_id, session_id, title, cwd, created_at, parent_id, depth, is_subagent, archived, parent_known, child_ids_json, source_file, extra_json, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`,
        agent, rootId, sessionRecord.id, sessionRecord.title, sessionRecord.cwd, sessionRecord.createdAt,
        sessionRecord.parentId, sessionRecord.depth, sessionRecord.isSubagent ? 1 : 0, sessionRecord.archived ? 1 : 0,
        sessionRecord.parentKnown ? 1 : 0, JSON.stringify(sessionRecord.childIds), sourceFile,
        sessionRecord.extra === undefined ? null : JSON.stringify(sessionRecord.extra),
      );
      for (const usageRecord of sessionRecord.records) {
        const events = usageRecord.events;
        // Only rows for events that exist: "no events" is the usual case today,
        // and it must not cost a row, nor read back as "an empty list of things
        // the agent did".
        if (events !== undefined) assertOrdinals(sessionRecord.id, usageRecord.id, events);
        this.#run(
          `INSERT INTO records (agent, root_id, session_id, record_id, time, model, model_label, input, output, cache_read, cache_write, reasoning, cache_write_ttl, cache_write_tiers_json, seq, turn, step)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          agent, rootId, sessionRecord.id, usageRecord.id, usageRecord.time, usageRecord.model, usageRecord.modelLabel,
          usageRecord.tokens.input, usageRecord.tokens.output, usageRecord.tokens.cacheRead, usageRecord.tokens.cacheWrite,
          usageRecord.tokens.reasoning, usageRecord.cacheWriteTtl ?? null,
          usageRecord.cacheWriteTiers === undefined ? null : JSON.stringify(usageRecord.cacheWriteTiers),
          usageRecord.seq ?? null, usageRecord.turn ?? null, usageRecord.step ?? null,
        );
        // After the record row: the foreign key is what makes an event belong to
        // its request, and what removes the events when the request goes.
        for (const event of events ?? []) {
          this.#run(
            `INSERT INTO events (agent, root_id, session_id, record_id, ordinal, kind, name, detail, bytes, ok)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            agent, rootId, sessionRecord.id, usageRecord.id, event.ordinal, event.kind, event.name,
            event.detail ?? null, event.bytes ?? null, event.ok === undefined ? null : event.ok ? 1 : 0,
          );
        }
      }
    }
  }

  /** The `roots` row of one write, projects unioned with what survives. */
  #upsertRoot(input: {
    agent: string;
    rootId: string;
    root: string;
    now: number;
    dataset: UsageDataset;
    kept: ReadonlySet<string>;
  }): void {
    const { agent, rootId, root, now, dataset, kept } = input;
    const previousRow = this.#get<{ projects_json: string }>(
      'SELECT projects_json FROM roots WHERE agent = ? AND root_id = ?',
      agent,
      rootId,
    );
    const previousProjects = previousRow === undefined
      ? []
      : (JSON.parse(previousRow.projects_json) as ProjectSkeleton[]);

    const written = new Set(dataset.sessions.map((entry) => entry.id));
    const skeletons: ProjectSkeleton[] = dataset.projects.map((projectRecord) => {
      const { sessions, ...rest } = projectRecord;
      return { ...rest, sessionIds: sessions.map((entry) => entry.id) };
    });
    const claimed = new Set(skeletons.flatMap((skeleton) => skeleton.sessionIds));

    // A session this scan still read (or kept because its file is gone) stays in
    // the project it was read under. A session the scan no longer lists while
    // its file is still here was dropped by the adapter (history cleared, log
    // rotated) and goes — carried-over membership must not resurrect it.
    const carried = new Map<string, string[]>();
    for (const skeleton of previousProjects) {
      for (const id of skeleton.sessionIds) {
        if (claimed.has(id) || (!kept.has(id) && !written.has(id))) continue;
        const ids = carried.get(skeleton.id) ?? [];
        ids.push(id);
        carried.set(skeleton.id, ids);
      }
    }
    for (const skeleton of skeletons) {
      const extra = carried.get(skeleton.id);
      if (extra === undefined) continue;
      skeleton.sessionIds.push(...extra.filter((id) => !skeleton.sessionIds.includes(id)));
      carried.delete(skeleton.id);
    }
    for (const skeleton of previousProjects) {
      const extra = carried.get(skeleton.id);
      if (extra === undefined || extra.length === 0) continue;
      skeletons.push({ ...skeleton, sessionIds: extra });
    }

    this.#run(
      `INSERT INTO roots (agent, root_id, root, last_seen, agents_json, projects_json, warnings_json, stats_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent, root_id) DO UPDATE SET
         root = excluded.root,
         last_seen = excluded.last_seen,
         agents_json = excluded.agents_json,
         projects_json = excluded.projects_json,
         warnings_json = excluded.warnings_json,
         stats_json = excluded.stats_json`,
      agent, rootId, root, now, JSON.stringify(dataset.agents), JSON.stringify(skeletons),
      JSON.stringify(warningsToJson(dataset.warnings)), JSON.stringify(dataset.stats),
    );
  }

  /** The stored path of a root, or `undefined` when it is unknown. */
  #rootPath(agent: string, rootId: string): string | undefined {
    const row = this.#get<{ root: string }>('SELECT root FROM roots WHERE agent = ? AND root_id = ?', agent, rootId);
    return row === undefined ? undefined : row.root;
  }

  /** One prepared statement, reused. */
  #statement(sql: string): ReturnType<DatabaseSync['prepare']> {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /** Run a statement for its effect. */
  #run(sql: string, ...params: (string | number | null)[]): void {
    this.#statement(sql).run(...params);
  }

  /** One row, or `undefined`. */
  #get<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.#statement(sql).get(...params) as T | undefined;
  }

  /** Every row of a query. */
  #all<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.#statement(sql).all(...params) as unknown as T[];
  }

  /** Refuse to work on a closed store rather than on a closed connection. */
  #assertOpen(): void {
    if (this.#closed) throw new Error(`usage store ${this.path} is closed`);
  }
}

/**
 * Refuse a record whose events claim the same position twice.
 *
 * The store keys an event by its ordinal, because "the second `Bash` call in this
 * request" is the identity the model gives it. Two events sharing one ordinal
 * would either overwrite each other or be rejected by SQLite at the bottom of a
 * transaction, and both read as a lost tool call — the one thing this table
 * exists to make impossible to lose silently. So the answer is a named error
 * before anything is written, which the caller can report as a broken adapter.
 *
 * @param sessionId - session the record belongs to, for the message.
 * @param recordId - record the events claim to be from.
 * @param events - the events to check.
 * @throws when two of them share an ordinal.
 */
function assertOrdinals(sessionId: string, recordId: string, events: readonly UsageEvent[]): void {
  if (events.length < 2) return;
  const seen = new Set<number>();
  for (const event of events) {
    if (seen.has(event.ordinal)) {
      throw new Error(
        `session ${sessionId} record ${recordId} has two events with ordinal ${event.ordinal}`,
      );
    }
    seen.add(event.ordinal);
  }
}

/**
 * One stored session row, as the domain model. */
function sessionOf(agent: string, root: string, row: SessionRow, records: UsageRecord[]): SessionRecord {
  return {
    id: row.session_id,
    agent,
    title: row.title,
    cwd: row.cwd,
    ...(row.source_file === null ? {} : { sourceFile: absPathOf(root, row.source_file) }),
    createdAt: row.created_at === null ? null : Number(row.created_at),
    records,
    parentId: row.parent_id,
    depth: Number(row.depth),
    isSubagent: row.is_subagent !== 0,
    archived: row.archived !== 0,
    childIds: JSON.parse(row.child_ids_json) as string[],
    parentKnown: row.parent_known !== 0,
    ...(row.extra_json === null ? {} : { extra: JSON.parse(row.extra_json) as Record<string, unknown> }),
  };
}

/** One stored record row, as the domain model. */
function recordOf(row: RecordRow, events: readonly UsageEvent[] | undefined): UsageRecord {
  return {
    id: row.record_id,
    time: Number(row.time),
    model: row.model,
    modelLabel: row.model_label,
    tokens: {
      input: Number(row.input),
      output: Number(row.output),
      cacheRead: Number(row.cache_read),
      cacheWrite: Number(row.cache_write),
      reasoning: Number(row.reasoning),
    },
    ...(row.cache_write_ttl === null ? {} : { cacheWriteTtl: row.cache_write_ttl as UsageRecord['cacheWriteTtl'] }),
    ...(row.cache_write_tiers_json === null
      ? {}
      : { cacheWriteTiers: JSON.parse(row.cache_write_tiers_json) as UsageRecord['cacheWriteTiers'] }),
    ...(row.seq === null ? {} : { seq: Number(row.seq) }),
    ...(row.turn === null ? {} : { turn: Number(row.turn) }),
    ...(row.step === null ? {} : { step: Number(row.step) }),
    ...(events === undefined ? {} : { events }),
  };
}

/** One stored event row, as the domain model. */
function eventOf(row: EventRow): UsageEvent {
  return {
    kind: row.kind as UsageEvent['kind'],
    ordinal: Number(row.ordinal),
    name: row.name,
    // `null` is "the log did not say"; an empty detail or a size of zero is
    // something the log did say, and the two must not read alike.
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(row.bytes === null ? {} : { bytes: Number(row.bytes) }),
    ...(row.ok === null ? {} : { ok: row.ok !== 0 }),
  };
}
