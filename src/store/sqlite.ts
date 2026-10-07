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
import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { muteSqliteExperimentalWarning } from '../core/warnings.ts';

import type { DatasetStats, ProjectRecord, SessionRecord, UsageDataset, UsageEvent, UsageRecord } from '../core/types.ts';
import { warningsFromJson, warningsToJson, type WarningJson } from './dataset-json.ts';
import type { FingerprintStatus, SourceFingerprint } from './fingerprint.ts';
import { isUnderPrefix } from './prefix.ts';

/** The schema this module writes. Bump it when a migration is needed. */
export const STORE_SCHEMA_VERSION = 3;

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

/**
 * Version 3: which reader wrote each root's rows.
 *
 * Freshness was decided by one value for the whole file (`meta.tool_version`),
 * which cannot say *which* roots the new build has already re-read. A run killed
 * between opening the file and writing its first root therefore left the file
 * looking current while every row in it was the old build's work — and nothing
 * could tell. Storing the reader on the root makes the answer per root and
 * atomic with the rows it describes: a root may be reused exactly when the
 * version asking is the version that wrote it. `NULL` is "written before anyone
 * said", which is not a version we can trust.
 */
const SCHEMA_V3 = `
ALTER TABLE roots ADD COLUMN reader_version TEXT;
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
 * per step, so an old database does not take a special path: `v0 → v3` is the
 * same steps as `v0 → v1`, `v1 → v2`, `v2 → v3`.
 */
const MIGRATIONS: readonly MigrationStep[] = [
  { to: 1, sql: SCHEMA_V1 },
  { to: 2, sql: SCHEMA_V2 },
  { to: 3, sql: SCHEMA_V3 },
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

/**
 * Everything the store holds for one root, as the store itself sees it.
 *
 * For showing a user what is in their database — `store list` — and for spotting
 * the rows that need attention: a root whose `readerVersion` is not the version
 * running now was read by an older build, and if its logs are gone it cannot be
 * read again, so a field that build did not know about (tool calls) will be
 * empty there for good.
 */
export interface StoreRootDetail {
  /** Agent that read the root. */
  agent: string;
  /** Identity of the root: {@link rootIdOf} of its path. */
  rootId: string;
  /** Absolute path of the root, as it was when written. */
  root: string;
  /** When a scan last read it, in milliseconds since the Unix epoch. */
  lastSeen: number;
  /** Version of the tool that wrote these rows, or `null` for rows that predate the column. */
  readerVersion: string | null;
  /** Sessions stored for the root. */
  sessions: number;
  /** Records stored for the root. */
  records: number;
  /** Events stored for the root. */
  events: number;
}

/** What a store is and what is in it, for a reader who wants to look. */
export interface StoreStats {
  /** Where the database is, as it was asked for at open. */
  path: string;
  /** Schema version on disk (`PRAGMA user_version`). */
  schemaVersion: number;
  /** Tool version recorded in `meta`, or `null` when the file does not say. */
  toolVersion: string | null;
  /**
   * What the store occupies on disk right now, in bytes: the file and its
   * write-ahead log and shared-memory sidecars, or `0` for a store that lives in
   * memory.
   *
   * The whole footprint rather than the main file alone, because in WAL mode the
   * recent rows live in a sidecar, and a size that ignored it would report a
   * database that has just grown as unchanged.
   */
  bytes: number;
}

/**
 * One node of what the store holds, from an agent down to a session.
 *
 * For a reader deciding what to forget: `store forget` is cache eviction, so it
 * has to show what the cache is holding and where it came from. The tree is
 * `agent → root → project → cwd → session`; every level carries the totals of
 * everything below it, so a caller can render any depth without walking twice.
 *
 * `readerVersions` is the point of the view. A row written by a build that did
 * not know about tool calls still has none, and if the log it came from is gone
 * that stays true for good — so a node with more than one version (or with
 * `null` in the set, which is "written before anyone said") is telling the reader
 * that its numbers are not all from the code they are running.
 */
export interface StoreOverviewNode {
  /** Which level this node is. */
  kind: 'agent' | 'root' | 'project' | 'cwd' | 'session';
  /**
   * Identity at this level: the agent id, the root path, the project id, the
   * session's working directory, or the session id.
   *
   * Empty means "the rows did not say": a session with no `cwd`, a session no
   * project lists, a session without a title. Rendering that is the caller's
   * decision — this layer has no language.
   */
  id: string;
  /** What to show for the node: a path, a project name, a session title. */
  label: string;
  /** Sessions in this node and below. */
  sessions: number;
  /** Records in them. */
  records: number;
  /** Events in them. */
  events: number;
  /** Latest activity below this node, in milliseconds since the Unix epoch, or `null` when nothing is dated. */
  lastActivity: number | null;
  /** Tool versions that wrote rows below this node, ascending; `null` for rows written before the column existed. */
  readerVersions: (string | null)[];
  /** The next level down. */
  children: StoreOverviewNode[];
}

/**
 * Which rows {@link UsageStore.forget} targets.
 *
 * Every field given is one more condition, and they are combined as an
 * intersection: `{ agent: 'dsh', cwd: '/ws/app' }` forgets the sessions of that
 * agent that ran in that directory, not the agent's other roots and not another
 * agent's use of the same directory.
 *
 * The distinction that matters is *what* the intersection covers. Naming whole
 * roots (`root`, `rootPrefix`, `agent`, `all`) removes them entirely, which is
 * the obvious meaning. Naming part of a root (`cwd`, `project`, `session`)
 * cannot: the root's fingerprint would still claim its files are unchanged while
 * the dataset beside it is missing rows, and the next scan would serve the
 * remainder as the truth. So a partial forget also drops what the store
 * remembers about that root, and the next scan reads it again — the sections
 * are gone from the store, not from the logs.
 */
export interface ForgetSelector {
  /** Roots read by this agent. */
  agent?: string | undefined;
  /** This exact root, as stored (an absolute path). */
  root?: string | undefined;
  /** Roots at or under this path prefix, by whole path segment. */
  rootPrefix?: string | undefined;
  /** Sessions that ran in this directory or under it. */
  cwd?: string | undefined;
  /** Sessions the adapter filed under this project id. */
  project?: string | undefined;
  /** This one session id. */
  session?: string | undefined;
  /** Everything. Cannot be combined with the other fields. */
  all?: true | undefined;
}

/** One root a {@link UsageStore.forget} call touched. */
export interface ForgottenRoot {
  /** Agent that read it. */
  agent: string;
  /** Identity of the root. */
  rootId: string;
  /** Absolute path of the root. */
  root: string;
  /** Rows deleted under this root. */
  rows: number;
  /**
   * Whether the store's memory of the root was cleared as well.
   *
   * `true` means its file fingerprints and reader version are gone, so the next
   * scan of that root reads everything again instead of trusting a record of
   * files that no longer matches what is stored.
   */
  reset: boolean;
}

/** What {@link UsageStore.forget} did. */
export interface ForgetResult {
  /** Rows deleted, per table. */
  deleted: { roots: number; files: number; sessions: number; records: number; events: number };
  /** Rows deleted in total. */
  total: number;
  /** Every root the call touched, with what happened to it. */
  roots: readonly ForgottenRoot[];
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
 * carry a header that says the current version while the tables — or the columns
 * a later version added — are missing. That is damage like any other: the file is
 * moved aside and rebuilt.
 */
class MissingTablesError extends Error {
  constructor(missing: readonly string[]) {
    super(`schema says version ${STORE_SCHEMA_VERSION} but it is missing: ${missing.join(', ')}`);
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

/** Columns the current version needs on a table it already had. */
const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  roots: ['reader_version'],
};

/**
 * Check that the file really holds the schema its version claims.
 *
 * Tables and the columns later versions added: a file whose header says v3 but
 * which never got `roots.reader_version` would fail at the first read, from
 * somewhere with no way to recover, so it is caught here as damage.
 * @param db - the connection.
 */
function verifySchema(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as unknown as { name: string }[];
  const present = new Set(rows.map((row) => row.name));
  const missing: string[] = REQUIRED_TABLES.filter((name) => !present.has(name));
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!present.has(table)) continue;
    const have = new Set(
      (db.prepare(`PRAGMA table_info('${table}')`).all() as unknown as { name: string }[]).map((row) => row.name),
    );
    for (const column of columns) if (!have.has(column)) missing.push(`${table}.${column}`);
  }
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
 * Note which tool version last opened the file.
 *
 * This is a record of who looked, and every open updates it — but it is *not*
 * what decides whether anything may be reused. A build that opens a file has not
 * necessarily finished re-reading it, so freshness is answered per root, by
 * `roots.reader_version`, which only a completed `writeRoot` sets.
 * @param db - the connection.
 * @param toolVersion - the version to record.
 */
function recordToolVersion(db: DatabaseSync, toolVersion: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run('tool_version', toolVersion);
}

/**
 * The tables a root is made of, children first, and what each one's rows are
 * called in a {@link ForgetResult}.
 *
 * Deleting in this order means every row is removed by a statement that names it
 * rather than by a cascade firing: the count a caller gets back is the number of
 * rows that actually went, and no orphan can survive a connection with foreign
 * keys switched off.
 */
const ROOT_TABLES: readonly string[] = ['events', 'records', 'sessions', 'files', 'roots'];

/** Which result field each table's row count belongs in. */
const TABLE_FIELDS: Readonly<Record<string, string>> = {
  events: 'events',
  records: 'records',
  sessions: 'sessions',
  files: 'files',
  roots: 'roots',
};

/** A node with nothing in it yet. */
function emptyOverviewNode(kind: StoreOverviewNode['kind'], id: string, label: string): StoreOverviewNode {
  return { kind, id, label, sessions: 0, records: 0, events: 0, lastActivity: null, readerVersions: [], children: [] };
}

/** Add a child's totals to its parent, versions and last activity included. */
function accumulate(parent: StoreOverviewNode, child: StoreOverviewNode): void {
  parent.sessions += child.sessions;
  parent.records += child.records;
  parent.events += child.events;
  if (child.lastActivity !== null) {
    parent.lastActivity = parent.lastActivity === null ? child.lastActivity : Math.max(parent.lastActivity, child.lastActivity);
  }
  for (const version of child.readerVersions) {
    if (!parent.readerVersions.includes(version)) parent.readerVersions.push(version);
  }
  parent.readerVersions.sort(compareVersions);
}

/** `null` (written before anyone said) first, then versions as text. */
function compareVersions(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left.localeCompare(right);
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

  /**
   * The version of the tool that opened this store.
   *
   * A dataset is only as good as the reader that produced it: a build that
   * learned to extract something new — tool calls, say — cannot serve rows a
   * build that did not know about it wrote, however unchanged the source files
   * look. So the reader version is written onto each root as it is stored, and a
   * root is reusable exactly when it carries this one.
   */
  #toolVersion: string;

  /** Set when the rows live in memory rather than in the file at {@link path}. */
  #inMemory: boolean;

  private constructor(path: string, db: DatabaseSync, toolVersion: string, inMemory: boolean) {
    this.path = path;
    this.#db = db;
    this.#toolVersion = toolVersion;
    this.#inMemory = inMemory;
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
      return { store: new UsageStore(path, connect(path, toolVersion, driver), toolVersion, false), reset: null };
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
            store: new UsageStore(path, connect(path, toolVersion, driver), toolVersion, false),
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
    return new UsageStore(path, connect(':memory:', toolVersion, driver), toolVersion, true);
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
   * What the sources looked like when the root was last read *by this version*.
   *
   * This is the question "may this root's stored data be used instead of reading
   * its files again?", so it answers `undefined` — "nothing usable here" — in
   * both of the cases where reuse would be wrong: a root this store has never
   * heard of, and a root whose rows were written by a different version of the
   * tool. The caller then reads the sources and writes the root back, and the
   * data in the store catches up with what the reader can now see.
   *
   * The version is the root's own (`roots.reader_version`), so a run that was
   * killed before it re-read anything still leaves every root marked as the old
   * build's work. `readRoot` deliberately keeps answering for such a root: rows
   * that cannot be re-read (a session from a log that is gone) are still history
   * worth showing, and {@link knowsRoot} is how a caller tells that case apart
   * from a root the store has never seen.
   *
   * @param agent - the agent that read it.
   * @param rootId - identity of the root.
   * @returns one entry per stored source file, or `undefined` when this store has
   *   nothing reusable for the root. An empty array means the root is known, was
   *   read with no sources at all, and was written by this version.
   */
  fingerprintOf(agent: string, rootId: string): readonly SourceFingerprint[] | undefined {
    this.#assertOpen();
    const row = this.#get<{ root: string; reader_version: string | null }>(
      'SELECT root, reader_version FROM roots WHERE agent = ? AND root_id = ?',
      agent,
      rootId,
    );
    if (row === undefined) return undefined;
    // Written by another build (or by one that did not say): the files may be
    // untouched and the stored dataset still out of date, because what a reader
    // extracts is not in the files' fingerprints.
    if (row.reader_version !== this.#toolVersion) return undefined;
    const root = row.root;
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
   * Whether this store has ever been told about a root.
   *
   * Deliberately independent of who wrote its rows: a root this store remembers
   * but cannot reuse is still a root whose history exists here, and a session
   * kept from a log that is gone cannot be recovered from anywhere else. A caller
   * planning what to read needs that answer — "is this root mine?" — separately
   * from "may I skip reading it?", so the two questions have two answers.
   * @param agent - the agent that read it.
   * @param rootId - identity of the root.
   * @returns `true` when there are rows for the root, whatever version wrote them.
   */
  knowsRoot(agent: string, rootId: string): boolean {
    this.#assertOpen();
    return this.#get<{ one: number }>(
      'SELECT 1 AS one FROM roots WHERE agent = ? AND root_id = ?',
      agent,
      rootId,
    ) !== undefined;
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
   * Writing a root is also what makes it reusable again: from here on, this run
   * answers {@link fingerprintOf} for it, whatever version wrote it last time.
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
   * Every root the store holds rows for, with what it holds.
   *
   * The counterpart of {@link rootsOf} for a reader looking at the database
   * rather than at one agent's cache: it says who wrote each root, when it was
   * last read and how many rows are there, so `store list` can show the lot and
   * `store forget` can name what it is about to delete.
   * @returns one entry per root, by agent and then most recently seen first.
   */
  rootSummaries(): readonly StoreRootDetail[] {
    this.#assertOpen();
    const rows = this.#all<{
      agent: string;
      root_id: string;
      root: string;
      last_seen: number;
      reader_version: string | null;
      sessions: number;
      records: number;
      events: number;
    }>(
      `SELECT r.agent, r.root_id, r.root, r.last_seen, r.reader_version,
         (SELECT count(*) FROM sessions s WHERE s.agent = r.agent AND s.root_id = r.root_id) AS sessions,
         (SELECT count(*) FROM records c WHERE c.agent = r.agent AND c.root_id = r.root_id) AS records,
         (SELECT count(*) FROM events e WHERE e.agent = r.agent AND e.root_id = r.root_id) AS events
       FROM roots r
       ORDER BY r.agent ASC, r.last_seen DESC, r.root_id ASC`,
    );
    return rows.map((row) => ({
      agent: row.agent,
      rootId: row.root_id,
      root: row.root,
      lastSeen: Number(row.last_seen),
      readerVersion: row.reader_version,
      sessions: Number(row.sessions),
      records: Number(row.records),
      events: Number(row.events),
    }));
  }

  /**
   * What this store is: which file, which schema, which tool wrote it last.
   * @returns the store's own facts.
   */
  stats(): StoreStats {
    this.#assertOpen();
    const version = this.#get<{ user_version: number }>('PRAGMA user_version');
    const tool = this.#get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'tool_version');
    let bytes = 0;
    if (!this.#inMemory) {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          bytes += statSync(`${this.path}${suffix}`).size;
        } catch {
          // A sidecar that is not there contributes nothing.
        }
      }
    }
    return {
      path: this.path,
      schemaVersion: version === undefined ? 0 : Number(version.user_version),
      toolVersion: tool?.value ?? null,
      bytes,
    };
  }

  /**
   * Delete what a selector names, and clear the memory of the roots left partial.
   *
   * One transaction: either the rows are gone and the affected roots are marked
   * as needing a fresh read, or nothing happened. The counts come from the
   * statements themselves, so they say what left the database rather than what
   * the selector was meant to match.
   *
   * Forgetting is **cache eviction**, not deletion of the user's history: a log
   * that is still there and not excluded is read again on the next scan, and the
   * sections come back. Keeping data out for good is the exclusion rule's job
   * (`--store-exclude`, or `--no-store` for a whole run), which is a rule rather
   * than a cleanup.
   *
   * @param selector - what to forget; see {@link ForgetSelector}.
   * @returns the rows deleted per table and the roots affected.
   * @throws when the selector names nothing, or mixes `all` with a condition.
   */
  forget(selector: ForgetSelector): ForgetResult {
    this.#assertOpen();
    const conditions = Object.entries(selector).filter(([, value]) => value !== undefined);
    if (conditions.length === 0) {
      throw new Error('forget needs a selector: name an agent, a root, a session, or pass all');
    }
    if (selector.all === true && conditions.length > 1) {
      throw new Error('forget cannot combine all with a narrower selector');
    }
    const deleted = { roots: 0, files: 0, sessions: 0, records: 0, events: 0 };
    const affected: ForgottenRoot[] = [];
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (selector.all === true) {
        for (const table of ROOT_TABLES) {
          deleted[TABLE_FIELDS[table] as keyof typeof deleted] += this.#delete(`DELETE FROM ${table}`);
        }
        affected.push(...this.#rootRefs());
      } else if (selector.cwd !== undefined || selector.project !== undefined || selector.session !== undefined) {
        this.#forgetSessions(selector, deleted, affected);
      } else {
        this.#forgetRoots(selector, deleted, affected);
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Already unwound; the original error is the one to report.
      }
      throw error;
    }
    return {
      deleted,
      total: deleted.roots + deleted.files + deleted.sessions + deleted.records + deleted.events,
      roots: affected,
    };
  }

  /**
   * Hand the pages of a database that has been emptied back to the system.
   *
   * `VACUUM` rewrites the whole file, so it needs room for a second copy of it
   * and takes time proportional to its size — which is why it is a call of its
   * own rather than something every `forget` does. After a forget it is the step
   * that actually shrinks the file; without it the rows are gone but the space is
   * still held.
   *
   * The write-ahead log is folded back into the file afterwards: the vacuum
   * writes the new, smaller database *through* the log, and until that log is
   * checkpointed the file on disk still looks exactly as big as before.
   */
  vacuum(): void {
    this.#assertOpen();
    if (this.#inMemory) return;
    this.#db.exec('VACUUM');
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /**
   * What is in the store, as a tree of agents, roots, projects, cwds and sessions.
   *
   * Built from the rows themselves — the project skeletons in `roots`, the
   * `cwd` on each session, and per-session counts — so it describes what is
   * actually stored rather than what a scan once intended to store.
   * @returns one node per agent, each with everything below it.
   */
  storeOverview(): readonly StoreOverviewNode[] {
    this.#assertOpen();
    const roots = this.#all<{
      agent: string;
      root_id: string;
      root: string;
      reader_version: string | null;
      projects_json: string;
    }>('SELECT agent, root_id, root, reader_version, projects_json FROM roots ORDER BY agent ASC, root_id ASC');
    const sessions = this.#all<{
      agent: string;
      root_id: string;
      session_id: string;
      title: string | null;
      cwd: string | null;
      created_at: number | null;
      records: number;
      events: number;
      last_record: number | null;
    }>(
      `SELECT s.agent, s.root_id, s.session_id, s.title, s.cwd, s.created_at,
         (SELECT count(*) FROM records c WHERE c.agent = s.agent AND c.root_id = s.root_id AND c.session_id = s.session_id) AS records,
         (SELECT count(*) FROM events e WHERE e.agent = s.agent AND e.root_id = s.root_id AND e.session_id = s.session_id) AS events,
         (SELECT max(c.time) FROM records c WHERE c.agent = s.agent AND c.root_id = s.root_id AND c.session_id = s.session_id) AS last_record
       FROM sessions s
       ORDER BY s.agent ASC, s.root_id ASC, s.rowid ASC`,
    );

    const byRoot = new Map<string, typeof sessions>();
    for (const row of sessions) {
      const key = `${row.agent}\u0000${row.root_id}`;
      const list = byRoot.get(key) ?? [];
      list.push(row);
      byRoot.set(key, list);
    }

    const agents = new Map<string, StoreOverviewNode>();
    for (const root of roots) {
      const key = `${root.agent}\u0000${root.root_id}`;
      const rows = byRoot.get(key) ?? [];
      const rootNode = emptyOverviewNode('root', root.root, root.root);
      rootNode.readerVersions = root.reader_version === null ? [null] : [root.reader_version];
      const projects = new Map<string, StoreOverviewNode>();
      const filed = this.#projectIndex(root.projects_json);
      for (const row of rows) {
        const project = filed.get(row.session_id);
        const projectId = project?.id ?? '';
        let projectNode = projects.get(projectId);
        if (projectNode === undefined) {
          projectNode = emptyOverviewNode('project', projectId, project?.name ?? '');
          projects.set(projectId, projectNode);
        }
        const cwdId = row.cwd ?? '';
        let cwdNode = projectNode.children.find((node) => node.id === cwdId);
        if (cwdNode === undefined) {
          cwdNode = emptyOverviewNode('cwd', cwdId, cwdId);
          projectNode.children.push(cwdNode);
        }
        const sessionNode = emptyOverviewNode('session', row.session_id, row.title ?? '');
        const lastActivity = row.last_record === null
          ? row.created_at === null ? null : Number(row.created_at)
          : Math.max(Number(row.last_record), row.created_at === null ? Number.NEGATIVE_INFINITY : Number(row.created_at));
        sessionNode.sessions = 1;
        sessionNode.records = Number(row.records);
        sessionNode.events = Number(row.events);
        sessionNode.lastActivity = lastActivity;
        sessionNode.readerVersions = rootNode.readerVersions;
        cwdNode.children.push(sessionNode);
        accumulate(cwdNode, sessionNode);
        accumulate(projectNode, sessionNode);
        accumulate(rootNode, sessionNode);
      }
      rootNode.children = [...projects.values()];
      let agentNode = agents.get(root.agent);
      if (agentNode === undefined) {
        agentNode = emptyOverviewNode('agent', root.agent, root.agent);
        agents.set(root.agent, agentNode);
      }
      agentNode.children.push(rootNode);
      accumulate(agentNode, rootNode);
    }
    return [...agents.values()];
  }

  /**
   * Which project each session of a root is filed under.
   *
   * One parse per root, not one per session: a root can hold thousands of
   * sessions and they all share the same skeletons.
   * @param projectsJson - the root's stored project skeletons.
   * @returns session id → the project that lists it.
   */
  #projectIndex(projectsJson: string): Map<string, { id: string; name: string }> {
    const index = new Map<string, { id: string; name: string }>();
    for (const skeleton of JSON.parse(projectsJson) as ProjectSkeleton[]) {
      for (const sessionId of skeleton.sessionIds) index.set(sessionId, { id: skeleton.id, name: skeleton.name });
    }
    return index;
  }

  /** Every root, as a reference without counts. */
  #rootRefs(): ForgottenRoot[] {
    const rows = this.#all<{ agent: string; root_id: string; root: string }>(
      'SELECT agent, root_id, root FROM roots ORDER BY agent ASC, root_id ASC',
    );
    return rows.map((row) => ({ agent: row.agent, rootId: row.root_id, root: row.root, rows: 0, reset: false }));
  }

  /** The roots a selector names, ignoring any session-level conditions. */
  #selectedRoots(selector: ForgetSelector): ForgottenRoot[] {
    return this.#rootRefs()
      .filter((entry) => selector.agent === undefined || entry.agent === selector.agent)
      .filter((entry) => selector.root === undefined || entry.root === selector.root)
      .filter(
        (entry) => selector.rootPrefix === undefined || isUnderPrefix(entry.root, [selector.rootPrefix]),
      );
  }

  /**
   * Forget whole roots: every row of them goes, the root row included.
   *
   * The children are deleted before the root rather than by the cascade: the
   * counts then come from statements that name the rows, and a connection with
   * foreign keys switched off cannot leave orphans behind.
   */
  #forgetRoots(selector: ForgetSelector, deleted: ForgetResult['deleted'], affected: ForgottenRoot[]): void {
    for (const entry of this.#selectedRoots(selector)) {
      const { agent, rootId } = entry;
      const events = this.#delete('DELETE FROM events WHERE agent = ? AND root_id = ?', agent, rootId);
      const records = this.#delete('DELETE FROM records WHERE agent = ? AND root_id = ?', agent, rootId);
      const sessions = this.#delete('DELETE FROM sessions WHERE agent = ? AND root_id = ?', agent, rootId);
      const files = this.#delete('DELETE FROM files WHERE agent = ? AND root_id = ?', agent, rootId);
      const roots = this.#delete('DELETE FROM roots WHERE agent = ? AND root_id = ?', agent, rootId);
      deleted.events += events;
      deleted.records += records;
      deleted.sessions += sessions;
      deleted.files += files;
      deleted.roots += roots;
      affected.push({ ...entry, rows: events + records + sessions + files + roots, reset: false });
    }
  }

  /**
   * Forget part of a root: the named sessions go, and the rest of the root stops
   * being reusable.
   *
   * A root with rows missing is a root whose fingerprint lies — it would still
   * say "the files have not changed" while the dataset beside it is short a
   * session — so its fingerprint and reader version are dropped too, and the next
   * scan reads the whole root again. What comes back is what the logs say, which
   * is the point: the sections are forgotten, not deleted from history.
   */
  #forgetSessions(selector: ForgetSelector, deleted: ForgetResult['deleted'], affected: ForgottenRoot[]): void {
    const scope = new Map(
      this.#selectedRoots(selector).map((entry) => [`${entry.agent}\u0000${entry.rootId}`, entry]),
    );
    const rows = this.#all<{
      agent: string;
      root_id: string;
      session_id: string;
      cwd: string | null;
      projects_json: string;
    }>(
      `SELECT s.agent, s.root_id, s.session_id, s.cwd, r.projects_json
       FROM sessions s JOIN roots r ON r.agent = s.agent AND r.root_id = s.root_id
       ORDER BY s.agent ASC, s.root_id ASC, s.rowid ASC`,
    );
    // The same skeletons for every session of a root: parsed once, keyed by the
    // JSON text they came from.
    const indexes = new Map<string, Map<string, { id: string; name: string }>>();
    for (const row of rows) {
      if (!indexes.has(row.projects_json)) indexes.set(row.projects_json, this.#projectIndex(row.projects_json));
    }
    const matched = rows.filter((row) => {
      if (!scope.has(`${row.agent}\u0000${row.root_id}`)) return false;
      if (selector.session !== undefined && row.session_id !== selector.session) return false;
      if (selector.cwd !== undefined && !isUnderPrefix(row.cwd ?? '', [selector.cwd])) return false;
      if (selector.project !== undefined && indexes.get(row.projects_json)?.get(row.session_id)?.id !== selector.project) {
        return false;
      }
      return true;
    });

    // Per root, so the result can say where the rows were and which roots are now
    // going to be read again.
    const touched = new Map<string, { entry: ForgottenRoot; rows: number }>();
    for (const row of matched) {
      const key = `${row.agent}\u0000${row.root_id}`;
      const entry = scope.get(key) as ForgottenRoot;
      const tally = touched.get(key) ?? { entry, rows: 0 };
      const events = this.#delete(
        'DELETE FROM events WHERE agent = ? AND root_id = ? AND session_id = ?',
        row.agent, row.root_id, row.session_id,
      );
      const records = this.#delete(
        'DELETE FROM records WHERE agent = ? AND root_id = ? AND session_id = ?',
        row.agent, row.root_id, row.session_id,
      );
      const sessions = this.#delete(
        'DELETE FROM sessions WHERE agent = ? AND root_id = ? AND session_id = ?',
        row.agent, row.root_id, row.session_id,
      );
      deleted.events += events;
      deleted.records += records;
      deleted.sessions += sessions;
      tally.rows += events + records + sessions;
      touched.set(key, tally);
    }
    for (const { entry, rows: removed } of touched.values()) {
      const files = this.#delete('DELETE FROM files WHERE agent = ? AND root_id = ?', entry.agent, entry.rootId);
      deleted.files += files;
      this.#run('UPDATE roots SET reader_version = NULL WHERE agent = ? AND root_id = ?', entry.agent, entry.rootId);
      affected.push({ ...entry, rows: removed + files, reset: true });
    }
  }

  /**
   * Run a statement for its effect, and how many rows it changed.
   * @param sql - the statement.
   * @param params - its parameters.
   * @returns rows changed.
   */
  #delete(sql: string, ...params: (string | number | null)[]): number {
    return Number(this.#statement(sql).run(...params).changes);
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
      `INSERT INTO roots (agent, root_id, root, last_seen, agents_json, projects_json, warnings_json, stats_json, reader_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent, root_id) DO UPDATE SET
         root = excluded.root,
         last_seen = excluded.last_seen,
         agents_json = excluded.agents_json,
         projects_json = excluded.projects_json,
         warnings_json = excluded.warnings_json,
         stats_json = excluded.stats_json,
         reader_version = excluded.reader_version`,
      agent, rootId, root, now, JSON.stringify(dataset.agents), JSON.stringify(skeletons),
      JSON.stringify(warningsToJson(dataset.warnings)), JSON.stringify(dataset.stats), this.#toolVersion,
    );
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
