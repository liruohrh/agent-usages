/**
 * Source fingerprints: what makes a cached scan trustworthy.
 *
 * A scan may be reused only when the files it read are *the same files*: the
 * cheap facts about them are recorded here, and the next scan compares. The
 * facts have to catch the cases real agents produce — a log grows (size), a log
 * is rewritten in place with the same length (`headHash` over the first
 * kilobytes), a file is replaced by an older copy (mtime alone would miss it,
 * which is why it is only ever one of three).
 *
 * Nothing here throws for a file that cannot be read: a missing log is an
 * ordinary state of the world, and the caller has to decide what it means (a
 * source that went away, a tombstone, a warning). The fingerprint says so
 * instead of failing the scan.
 */

import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

import { normalizePath } from '../core/paths.ts';

/** How many leading bytes are hashed, enough to catch a rewrite of a header. */
export const HEAD_HASH_BYTES = 4096;

/** Whether a source could be read at all. */
export type FingerprintStatus =
  /** Read: the other fields describe it. */
  | 'ok'
  /** The path does not exist (or is not reachable). */
  | 'missing'
  /** It exists but could not be read — a directory, a permission problem. */
  | 'unreadable';

/** What one source file looked like when a scan read it. */
export interface SourceFingerprint {
  /** Absolute path of the file. */
  path: string;
  /** Whether it could be read. */
  status: FingerprintStatus;
  /** Size in bytes, or `-1` when it could not be read. */
  size: number;
  /** Modification time in milliseconds, or `-1` when it could not be read. */
  mtimeMs: number;
  /** sha256 of the first {@link HEAD_HASH_BYTES} bytes, hex, or `''`. */
  headHash: string;
}

/** A fingerprint that carries no facts: the file could not be read. */
function unreadable(path: string, status: FingerprintStatus): SourceFingerprint {
  return { path, status, size: -1, mtimeMs: -1, headHash: '' };
}

/**
 * Fingerprint a set of files.
 *
 * Each file is opened and only its first {@link HEAD_HASH_BYTES} are read — a
 * multi-hundred-megabyte log costs one page, not a copy. A file that cannot be
 * read comes back marked rather than thrown: the caller needs to know *which*
 * source is unavailable, and one unreadable file must not fail a whole scan.
 *
 * @param files - absolute paths to fingerprint, in the caller's order.
 * @returns one fingerprint per path, in the same order.
 */
export async function fingerprintOf(files: readonly string[]): Promise<readonly SourceFingerprint[]> {
  return Promise.all(files.map(async (path) => fingerprintOne(path)));
}

/** Fingerprint one file, turning every failure into a status. */
async function fingerprintOne(path: string): Promise<SourceFingerprint> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    return unreadable(path, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable');
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return unreadable(path, 'unreadable');
    const buffer = Buffer.alloc(HEAD_HASH_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_HASH_BYTES, 0);
    return {
      path,
      status: 'ok',
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      headHash: createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex'),
    };
  } catch {
    return unreadable(path, 'unreadable');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Whether two fingerprint sets describe the same sources.
 *
 * Compared by path, not by position: an adapter is free to list the same files
 * in another order, and that is not a change. Any entry that could not be read
 * makes the sets differ — a cache is reused only when every source is known to
 * be unchanged, and "we could not look" is not "unchanged".
 *
 * @param left - one set, e.g. from the cache.
 * @param right - the other, e.g. just taken.
 * @returns `true` when both name the same paths with the same facts.
 */
export function fingerprintsEqual(
  left: readonly SourceFingerprint[],
  right: readonly SourceFingerprint[],
): boolean {
  if (left.length !== right.length) return false;
  const byPath = new Map(right.map((entry) => [entry.path, entry]));
  for (const entry of left) {
    const other = byPath.get(entry.path);
    if (other === undefined) return false;
    if (entry.status !== 'ok' || other.status !== 'ok') return false;
    if (entry.size !== other.size || entry.mtimeMs !== other.mtimeMs || entry.headHash !== other.headHash) return false;
  }
  return true;
}

/**
 * A short, stable id for a data root.
 *
 * The path is canonicalized first (`normalizePath` resolves `..`, trailing
 * separators, case and symlinks), so the same directory spelled two ways is one
 * root — otherwise re-pointing an agent's home at the same place through a link
 * would look like a new source and rescan everything. 16 hex digits of sha256
 * are plenty to keep roots apart inside one machine's cache and short enough to
 * read in a file.
 *
 * @param root - a directory path, in any spelling.
 * @returns 16 lowercase hex characters.
 */
export function rootIdOf(root: string): string {
  return createHash('sha256').update(normalizePath(root)).digest('hex').slice(0, 16);
}
