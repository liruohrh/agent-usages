/**
 * Reader for DSH session logs.
 *
 * A session's identity lives in the first line of
 * `<home>/sessions/<projectKey>/<sessionId>/session.jsonl.zstd`, which is the
 * only on-disk place that records **delegation**: whether a session is a
 * subagent, and which session spawned it. Neither the usage ledger nor the
 * projection cache carries that link, so the log is the sole authority.
 *
 * The log is an append-only stream of **independent zstd frames** — one frame
 * carries the header, later frames carry events. `node:zlib`'s
 * `zstdDecompressSync` stops at the end of the first frame and a streaming
 * decoder aborts with `ZSTD_error_prefix_unknown` at the second, so frames are
 * located by scanning for the zstd magic number and decoded one at a time.
 * Reading stops as soon as the fields of interest have been found, which keeps
 * a multi-megabyte log cheap to inspect.
 */

import { open, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** The zstd frame magic number. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Bytes read up-front; a header plus an early title always fit comfortably. */
const HEAD_BYTES = 256 * 1024;

/** Hard cap on bytes read per log before giving up on optional fields. */
const MAX_BYTES = 4 * 1024 * 1024;

/** What a session log's header (and early events) reveal about delegation. */
export interface SessionLogInfo {
  /** Canonical session id as written in the header. */
  sessionId: string;
  /** Parent session id when this session is a subagent; `null` for top-level sessions. */
  parentSessionId: string | null;
  /** Delegation depth: 0 for a top-level session, ≥1 for a subagent. */
  delegationDepth: number;
  /** Session creation time from the header. */
  createdAt: number | null;
  /** Working directory from the header. */
  cwd: string | null;
  /** Projected title from the log, used for subagents the projection cache omits. */
  title: string | null;
}

/** Parse a JSON value into a record, or `undefined`. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read a non-negative integer, or `undefined`. */
function asInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Read a non-empty string, or `undefined`. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Offsets of every zstd frame in a buffer, in ascending order. */
function frameOffsets(data: Buffer): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (;;) {
    const found = data.indexOf(ZSTD_MAGIC, cursor);
    if (found === -1) return offsets;
    offsets.push(found);
    cursor = found + ZSTD_MAGIC.length;
  }
}

/** Decode one frame, or `undefined` when the slice is not a whole frame. */
function decodeFrame(slice: Buffer): string | undefined {
  try {
    return zstdDecompressSync(slice).toString('utf8');
  } catch {
    // A slice that runs past its frame, or a false-positive magic, simply
    // yields nothing; the caller moves on to the next candidate boundary.
    return undefined;
  }
}

/**
 * Read the delegation facts, and if possible the title, from a session log.
 *
 * @param path - absolute path to `session.jsonl.zstd` (or `.jsonl`).
 * @returns what was recovered.
 * @throws when the header frame cannot be found or parsed, which means the file is not a DSH session log.
 */
export async function readSessionLog(path: string): Promise<SessionLogInfo> {
  const handle = await open(path, 'r');
  try {
    const stats = await handle.stat();
    const size = Number(stats.size);
    let chunk = Buffer.alloc(Math.min(HEAD_BYTES, size));
    await handle.read(chunk, 0, chunk.length, 0);
    let data = chunk;

    let header: Record<string, unknown> | undefined;
    let title: string | undefined;

    // An uncompressed log (`session.jsonl`, the `compression: none` layout) is
    // plain newline-delimited JSON with no frames at all.
    if (!path.endsWith('.zstd')) {
      for (const line of data.toString('utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let event: Record<string, unknown> | undefined;
        try {
          event = asRecord(JSON.parse(trimmed));
        } catch {
          continue;
        }
        if (event === undefined) continue;
        const type = asString(event['type']);
        if (type === 'session' && header === undefined) header = event;
        else if (type === 'session/title' && title === undefined) title = asString(asRecord(event['data'])?.['title']);
      }
    }

    for (let attempt = 0; attempt < 2 && header === undefined && path.endsWith('.zstd'); attempt += 1) {
      const offsets = frameOffsets(data);
      for (let index = 0; index < offsets.length; index += 1) {
        const start = offsets[index] as number;
        const end = index + 1 < offsets.length ? (offsets[index + 1] as number) : data.length;
        const text = decodeFrame(data.subarray(start, end));
        if (text === undefined) continue;
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          let event: Record<string, unknown> | undefined;
          try {
            event = asRecord(JSON.parse(trimmed));
          } catch {
            continue;
          }
          if (event === undefined) continue;
          const type = asString(event['type']);
          if (type === 'session' && header === undefined) header = event;
          else if (type === 'session/title' && title === undefined) {
            title = asString(asRecord(event['data'])?.['title']);
          }
        }
        // The header is in the leading frames; once it is known, only the title
        // can still be worth reading, and only while it is missing.
        if (header !== undefined && (title !== undefined || index >= offsets.length - 1)) break;
      }
      if (header === undefined && size > data.length) {
        // The leading frames did not contain the header; widen the window once.
        const want = Math.min(MAX_BYTES, size);
        chunk = Buffer.alloc(want);
        await handle.read(chunk, 0, want, 0);
        data = chunk;
        continue;
      }
      break;
    }

    if (header === undefined) {
      throw new Error(`无法在 ${path} 的前 ${data.length} 字节中找到会话头（session 事件）`);
    }
    const sessionId = asString(header['id']);
    if (sessionId === undefined) {
      throw new Error(`${path} 的会话头缺少 id 字段`);
    }
    const parentRaw = asString(header['parentSession']);
    const depth = asInteger(header['delegationDepth']) ?? (parentRaw === undefined ? 0 : 1);
    return {
      sessionId,
      parentSessionId: parentRaw ?? null,
      delegationDepth: depth,
      createdAt: asInteger(header['createdAt']) ?? null,
      cwd: asString(header['cwd']) ?? null,
      title: title ?? null,
    };
  } finally {
    await handle.close();
  }
}

/** A session log located on disk. */
export interface LocatedSessionLog {
  /** Parsed session id from the directory or file name. */
  directoryName: string;
  /** Absolute path to the log file. */
  path: string;
}

/**
 * Locate every session log under a DSH home's `sessions` directory.
 *
 * The directory layout is `<home>/sessions/<projectKey>/<encodedId>/session.jsonl[.zstd]`,
 * where `projectKey` is a lossy encoding of the working directory and has no
 * decoder — which is why the header's own `cwd` is used for attribution rather
 * than the directory name.
 *
 * @param home - DSH home directory.
 * @returns every log found, or an empty list when the directory is absent.
 */
export async function locateSessionLogs(home: string): Promise<LocatedSessionLog[]> {
  const root = join(home, 'sessions');
  let projectKeys: string[];
  try {
    projectKeys = await readdir(root);
  } catch {
    return [];
  }
  const found: LocatedSessionLog[] = [];
  for (const projectKey of projectKeys) {
    const projectDir = join(root, projectKey);
    let sessionDirs: string[];
    try {
      if (!(await stat(projectDir)).isDirectory()) continue;
      sessionDirs = await readdir(projectDir);
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      const dir = join(projectDir, sessionDir);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.startsWith('session.jsonl')) continue;
        found.push({ directoryName: sessionDir, path: join(dir, entry) });
      }
    }
  }
  return found;
}

/**
 * Read delegation facts for every session log under a DSH home.
 *
 * Failures are collected rather than thrown: a single unreadable log must not
 * make the whole usage report unavailable, because the ledger still answers the
 * token question without it.
 *
 * @param home - DSH home directory.
 * @returns a map from session id to facts, plus one warning per unreadable log.
 */
export async function readSessionLogIndex(
  home: string,
): Promise<{ byId: Map<string, SessionLogInfo>; warnings: string[] }> {
  const logs = await locateSessionLogs(home);
  const byId = new Map<string, SessionLogInfo>();
  const warnings: string[] = [];
  type Result = { log: LocatedSessionLog; info: SessionLogInfo } | { log: LocatedSessionLog; error: Error };
  const results = await Promise.all(
    logs.map(async (log): Promise<Result> => {
      try {
        return { log, info: await readSessionLog(log.path) };
      } catch (error) {
        return { log, error: error instanceof Error ? error : new Error(String(error)) };
      }
    }),
  );
  for (const result of results) {
    if ('error' in result) {
      warnings.push(`无法读取会话日志 ${relative(home, result.log.path).split(sep).join('/')}: ${result.error.message}`);
      continue;
    }
    byId.set(result.info.sessionId, result.info);
    // The ledger occasionally keys a session by the bare UUID while the log's
    // directory (and header) carry the `session-` prefix; index both spellings.
    const bare = result.info.sessionId.replace(/^session-/, '');
    if (bare !== result.info.sessionId) byId.set(bare, result.info);
    const prefixed = `session-${bare}`;
    if (!byId.has(prefixed)) byId.set(prefixed, result.info);
  }
  return { byId, warnings };
}
