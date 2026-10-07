/**
 * The scan cache: what a scan read last time, and whether it still counts.
 *
 * One file holds one entry per (agent, root). An entry is a root path, the
 * fingerprints of the files the adapter read, and the dataset they produced.
 * The next scan fingerprints the same files and reuses the dataset when every
 * fact matches — which is what makes a second run cheap without changing a
 * single number.
 *
 * The cache is a *cache*: everything it cannot trust is discarded rather than
 * raised. A file written by another version of the tool, a half-written file, a
 * file a human edited — each is reported as a structured reason and then
 * ignored, so a broken cache costs a rescan and never a failed command. The
 * reasons are data, not sentences: the caller decides whether a user is told
 * and in what language.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { SourceFingerprint } from './fingerprint.ts';
import { fromJson, toJson, type DatasetJson } from './dataset-json.ts';

/** The cache format this build writes; a different number is a rebuild. */
export const SCAN_CACHE_FORMAT = 1;

/** The file the cache lives in, inside the directory the caller names. */
export const SCAN_CACHE_FILE = 'scan-cache.json';

/** What one scan of one (agent, root) left behind. */
export interface ScanCacheEntry {
  /** Absolute path of the data root, as the adapter was given it. */
  root: string;
  /** The files the scan read, fingerprinted. */
  fingerprint: readonly SourceFingerprint[];
  /** The dataset they produced. */
  dataset: DatasetJson;
  /** When this root was last seen by a scan, milliseconds since the epoch. */
  lastSeen: number;
}

/** Every root of one agent, keyed by {@link rootIdOf}. */
export type ScanCacheRoots = Record<string, ScanCacheEntry>;

/** The whole file. */
export interface ScanCacheDocument {
  /** Format version; see {@link SCAN_CACHE_FORMAT}. */
  format: number;
  /** Tool version that wrote it. */
  tool: string;
  /** Entries, per agent id and root id. */
  agents: Record<string, ScanCacheRoots>;
}

/**
 * Why a cache file was not used.
 *
 * `format` and `tool` are version drift (not an error); `corrupt` is a file that
 * could not be parsed or did not have the shape; `unreadable` is a file that
 * exists but could not be read at all.
 */
export type ScanCacheResetReason = 'corrupt' | 'format' | 'tool' | 'unreadable';

/** The structured reason a cache was rebuilt, for the caller to report. */
export interface ScanCacheReset {
  /** Which kind of problem was found. */
  reason: ScanCacheResetReason;
  /** Absolute path of the file that was not trusted. */
  path: string;
  /**
   * The offending value or an OS/JSON error, for a log line.
   *
   * Deliberately a raw detail — `format 2`, `ENOENT`, `Unexpected token }` — and
   * not a sentence the user reads.
   */
  detail: string;
}

/** Options for {@link ScanCache.open}. */
export interface ScanCacheOpenOptions {
  /** Directory holding the cache file; created on `save`. */
  dir: string;
  /** Version of the tool writing it; a different one starts over. */
  toolVersion: string;
  /** File name inside `dir`; defaults to {@link SCAN_CACHE_FILE}. */
  file?: string | undefined;
}

/** What {@link ScanCache.open} answers. */
export interface ScanCacheOpenResult {
  /** The cache, empty when the old file was not trusted. */
  cache: ScanCache;
  /** Why the old file was discarded, or `null` when there was nothing to discard. */
  reset: ScanCacheReset | null;
}

/** A cache file that could not be parsed, with the detail worth logging. */
class CacheCorrupt extends Error {
  /** What was wrong, for the reset report. */
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.detail = detail;
  }
}

/**
 * Read and check a parsed cache document.
 *
 * Only the outer shape is checked: a file that is not even this shape is not a
 * cache, while a well-formed entry whose dataset is odd is the adapter's
 * business. Version drift is separated from corruption so the caller can tell
 * "you upgraded" from "this file is broken".
 * @param value - the parsed JSON.
 * @param toolVersion - the version expected.
 * @throws {CacheCorrupt} when the document is not a cache of this shape.
 */
function checkDocument(value: unknown, toolVersion: string): ScanCacheDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CacheCorrupt(`not an object: ${JSON.stringify(value)?.slice(0, 40) ?? 'undefined'}`);
  }
  const document = value as Partial<ScanCacheDocument>;
  if (typeof document.format !== 'number') throw new CacheCorrupt(`format ${JSON.stringify(document.format)}`);
  if (document.format !== SCAN_CACHE_FORMAT) {
    throw new CacheReset('format', `format ${document.format}`);
  }
  if (typeof document.tool !== 'string') throw new CacheCorrupt(`tool ${JSON.stringify(document.tool)}`);
  if (document.tool !== toolVersion) throw new CacheReset('tool', `tool ${document.tool}`);
  if (typeof document.agents !== 'object' || document.agents === null || Array.isArray(document.agents)) {
    throw new CacheCorrupt(`agents ${JSON.stringify(document.agents)}`);
  }
  return { format: document.format, tool: document.tool, agents: document.agents };
}

/** Version drift: a valid cache of another version, not a broken file. */
class CacheReset extends Error {
  /** Which version disagreed. */
  readonly reason: 'format' | 'tool';
  /** The version that was found. */
  readonly detail: string;

  constructor(reason: 'format' | 'tool', detail: string) {
    super(detail);
    this.reason = reason;
    this.detail = detail;
  }
}

/** One scan cache, held in memory and written whole. */
export class ScanCache {
  /** Absolute path of the file this cache reads and writes. */
  readonly path: string;
  /** Tool version stamped into the file. */
  private readonly toolVersion: string;
  /** The entries, by agent and root id. */
  private readonly agents: Record<string, ScanCacheRoots>;
  /** Whether anything changed since the file was read. */
  private modified = false;

  private constructor(path: string, toolVersion: string, agents: Record<string, ScanCacheRoots>) {
    this.path = path;
    this.toolVersion = toolVersion;
    this.agents = agents;
  }

  /**
   * Whether {@link ScanCache.save} has anything to write.
   *
   * A run in which every root came back unchanged has nothing to say: rewriting
   * a multi-megabyte file on every invocation would cost more than the cache
   * saves. Callers only save when this is `true`.
   */
  get dirty(): boolean {
    return this.modified;
  }

  /**
   * Open the cache in a directory, rebuilding it when it cannot be trusted.
   *
   * A missing file is a cold start (`reset: null`). Anything else that stands in
   * the way of using the file — a different format or tool version, unparsable
   * JSON, an unreadable path — is reported as a {@link ScanCacheReset} and the
   * cache comes back empty. Nothing is written until {@link ScanCache.save}, so
   * a caller that decides not to cache leaves the old file alone.
   *
   * @param options - the directory, the tool version, and an optional file name.
   * @returns the cache and, when one was discarded, why.
   */
  static async open(options: ScanCacheOpenOptions): Promise<ScanCacheOpenResult> {
    const path = join(options.dir, options.file ?? SCAN_CACHE_FILE);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      // No file at all is the first run, not a problem to report.
      return {
        cache: new ScanCache(path, options.toolVersion, {}),
        reset: code === 'ENOENT' ? null : { reason: 'unreadable', path, detail: code },
      };
    }
    try {
      const document = checkDocument(JSON.parse(text), options.toolVersion);
      return { cache: new ScanCache(path, options.toolVersion, document.agents), reset: null };
    } catch (error) {
      if (error instanceof CacheReset) return { cache: new ScanCache(path, options.toolVersion, {}), reset: { reason: error.reason, path, detail: error.detail } };
      const detail = error instanceof CacheCorrupt ? error.detail : `JSON ${(error as Error).message}`;
      return { cache: new ScanCache(path, options.toolVersion, {}), reset: { reason: 'corrupt', path, detail } };
    }
  }

  /** One root's entry, or `undefined` when it was never scanned. */
  get(agent: string, rootId: string): ScanCacheEntry | undefined {
    return this.agents[agent]?.[rootId];
  }

  /** Store one root's entry, replacing any previous one. */
  set(agent: string, rootId: string, entry: ScanCacheEntry): void {
    (this.agents[agent] ??= {})[rootId] = entry;
    this.modified = true;
  }

  /** Drop one root's entry; `true` when there was one. */
  delete(agent: string, rootId: string): boolean {
    const roots = this.agents[agent];
    if (roots === undefined || roots[rootId] === undefined) return false;
    delete roots[rootId];
    if (Object.keys(roots).length === 0) delete this.agents[agent];
    this.modified = true;
    return true;
  }

  /** Every root id stored for one agent. */
  rootsOf(agent: string): readonly string[] {
    return Object.keys(this.agents[agent] ?? {});
  }

  /** Every stored entry of one agent, in file order. */
  entriesOf(agent: string): readonly ScanCacheEntry[] {
    return Object.values(this.agents[agent] ?? {});
  }

  /** Every agent with at least one entry. */
  agentsPresent(): readonly string[] {
    return Object.keys(this.agents);
  }

  /** The document as it would be written, for inspection and tests. */
  document(): ScanCacheDocument {
    return { format: SCAN_CACHE_FORMAT, tool: this.toolVersion, agents: this.agents };
  }

  /**
   * Write the cache, atomically.
   *
   * The file is built beside its destination and renamed over it: a reader (a
   * second command, a crashed run's leftovers) sees either the previous file or
   * the whole new one, never a half-written JSON document. The directory is
   * created when missing, so a first run needs no setup.
   */
  async save(): Promise<void> {
    const target = this.path;
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 8)}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(this.document(), null, 2)}\n`, 'utf8');
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }
}
