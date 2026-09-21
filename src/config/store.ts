/**
 * Reading and writing the tool's own small JSON files.
 *
 * Configuration and caches are conveniences: a missing file means "use the
 * defaults", a corrupt one means "use the defaults and say so", and neither may
 * ever take the command down. Writes go through a temporary file so a cache can
 * never be left half-written by an interrupted process.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A file that could not be read as JSON. */
export interface ReadFailure {
  /** Path that failed. */
  path: string;
  /** Why it failed, for a warning line. */
  reason: string;
}

/** The result of reading a JSON file. */
export interface ReadResult<T> {
  /** Parsed value, or `undefined` when there was nothing usable. */
  value: T | undefined;
  /** Set when a file existed but could not be used. */
  failure: ReadFailure | undefined;
}

/**
 * Read a JSON file, without ever throwing.
 * @param path - file to read.
 * @returns the parsed value, or a failure describing why it is missing.
 */
export function readJson<T>(path: string): ReadResult<T> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Not existing is the normal case for a fresh install, not a failure.
    if (code === 'ENOENT') return { value: undefined, failure: undefined };
    return { value: undefined, failure: { path, reason: (error as Error).message } };
  }
  try {
    return { value: JSON.parse(text) as T, failure: undefined };
  } catch (error) {
    return { value: undefined, failure: { path, reason: `不是合法 JSON：${(error as Error).message}` } };
  }
}

/**
 * Write a JSON file, creating its directory.
 * @param path - file to write.
 * @param value - value to serialise.
 * @throws when the file cannot be written; callers treat that as non-fatal.
 */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

/**
 * Write a JSON file, ignoring any failure.
 *
 * The configuration directory can be missing, read-only, or on a filesystem the
 * process may not write; none of that is a reason for a report to fail, so a
 * cache that cannot be written is simply not written.
 * @param path - file to write.
 * @param value - value to serialise.
 * @returns whether the write succeeded.
 */
export function writeJsonQuietly(path: string, value: unknown): boolean {
  try {
    writeJson(path, value);
    return true;
  } catch {
    return false;
  }
}

/** Read a text file, treating absence as empty. */
export function readTextIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
