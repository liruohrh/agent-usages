/**
 * Reader for DSH session logs.
 *
 * A session's identity lives in the first line of
 * `<home>/sessions/<projectKey>/<sessionId>/session.jsonl.zstd`, which is the
 * only on-disk place that records **delegation**: whether a session is a
 * subagent, and which session spawned it.
 *
 * The same stream also carries the harness' own per-request accounting: every
 * `assistant/message` event repeats the `usage` block the provider returned for
 * that step. That makes the log the sole usage source, and the numbers are the
 * same ones the harness folds into `session_projcache.json`.
 *
 * The log is an append-only stream of **independent zstd frames** — one frame
 * carries the header, later frames carry events. `node:zlib`'s
 * `zstdDecompressSync` stops at the end of the first frame and a streaming
 * decoder aborts with `ZSTD_error_prefix_unknown` at the second, so frames are
 * located by scanning for the zstd magic number and decoded one at a time.
 * Reading therefore stops as soon as the fields of interest have been found, or
 * continues to the end of the file when per-request usage is wanted.
 */

import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import type { TokenBuckets, UsageRecord } from '../../core/types.ts';

/** The zstd frame magic number. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Bytes read up-front; a header plus an early title always fit comfortably. */
const HEAD_BYTES = 256 * 1024;

/** Hard cap on bytes read per log before giving up on optional fields. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Log file names in preference order.
 *
 * DSH currently writes the live stream to `session.v3.jsonl.zstd` and leaves a
 * small seed file at `session.jsonl.zstd`; older releases wrote the whole stream
 * to `session.jsonl.zstd`. Only one file per session directory is read, so a
 * seed file is never mistaken for the stream.
 */
const LOG_FILE_PREFERENCE: readonly string[] = [
  'session.v3.jsonl.zstd',
  'session.v3.jsonl',
  'session.jsonl.zstd',
  'session.jsonl',
];

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

/** A session log's header facts plus the billed requests it records. */
export interface SessionLogScan extends SessionLogInfo {
  /**
   * One record per `assistant/message` usage block, in file order.
   *
   * Empty unless the read was asked to collect usage: header-only reads stop at
   * the leading frames.
   */
  records: UsageRecord[];
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

/** Read a finite number, or `undefined`. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Read a non-negative count, defaulting to 0. */
function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
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

/** Token buckets as a `usage` block reports them. */
function usageBuckets(usage: Record<string, unknown>): TokenBuckets {
  return {
    input: asCount(usage['inputTokens']),
    output: asCount(usage['outputTokens']),
    cacheRead: asCount(usage['cacheReadTokens']),
    cacheWrite: asCount(usage['cacheWriteTokens']),
    // DeepSeek reports reasoning inside the completion count; it is carried for
    // transparency and never billed beside `output`.
    reasoning: asCount(usage['reasoningTokens']),
  };
}

/** One usage record before its session id is known. */
interface PendingUsage {
  /** Request key inside the session, `turn:step`. */
  key: string;
  record: Omit<UsageRecord, 'id'>;
}

/**
 * Turn one `assistant/message` event into a usage record.
 *
 * The record is keyed by turn and step, so a request means the same thing no
 * matter how often the log is re-read: re-reading cannot double-bill a step.
 *
 * @param event - the parsed log event.
 * @returns the pending record, or `undefined` when the event carries no usable usage.
 */
function parseUsageEvent(event: Record<string, unknown>): PendingUsage | undefined {
  if (asString(event['type']) !== 'assistant/message') return undefined;
  const data = asRecord(event['data']);
  const usage = data === undefined ? undefined : asRecord(data['usage']);
  const time = asNumber(event['time']);
  if (usage === undefined || time === undefined) return undefined;
  const turn = asInteger(data?.['turn']) ?? 0;
  const step = asInteger(data?.['step']) ?? 0;
  const source = asRecord(asRecord(data?.['message'])?.['source']);
  const model = asString(source?.['model']) ?? 'unknown';
  const provider = asString(source?.['provider']);
  return {
    key: `${turn}:${step}`,
    record: {
      seq: asInteger(event['seq']) ?? 0,
      time,
      turn,
      step,
      model,
      modelLabel: provider === undefined ? model : `${provider} / ${model}`,
      tokens: usageBuckets(usage),
    },
  };
}

/** Accumulator shared by the file-format readers. */
interface ScanState {
  header: Record<string, unknown> | undefined;
  title: string | undefined;
  /** Usage records by request key; a later append supersedes an earlier one. */
  records: Map<string, PendingUsage>;
}

/** Absorb one decoded chunk of newline-delimited JSON events. */
function absorbChunk(text: string, state: ScanState, collectUsage: boolean): void {
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
    if (type === 'session' && state.header === undefined) state.header = event;
    else if (type === 'session/title' && state.title === undefined) {
      state.title = asString(asRecord(event['data'])?.['title']);
    }
    if (!collectUsage) continue;
    const usage = parseUsageEvent(event);
    if (usage !== undefined) state.records.set(usage.key, usage);
  }
}

/** Where a log's facts are complete enough to stop scanning. */
function isComplete(state: ScanState, collectUsage: boolean, lastFrame: boolean): boolean {
  if (collectUsage) return lastFrame;
  return state.header !== undefined && (state.title !== undefined || lastFrame);
}

/** Decode every frame in `data`, absorbing events into `state`. */
function absorbFrames(data: Buffer, state: ScanState, collectUsage: boolean): void {
  const offsets = frameOffsets(data);
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index] as number;
    const end = index + 1 < offsets.length ? (offsets[index + 1] as number) : data.length;
    const text = decodeFrame(data.subarray(start, end));
    if (text !== undefined) absorbChunk(text, state, collectUsage);
    if (isComplete(state, collectUsage, index === offsets.length - 1)) return;
  }
}

/**
 * Read a session log.
 *
 * @param path - absolute path to `session.jsonl.zstd` (or `.jsonl`).
 * @param options - `collectUsage: true` scans the whole file and fills
 *   {@link SessionLogScan.records}; the default stops once the header (and, if
 *   it is near the front, the title) has been seen.
 * @returns what was recovered.
 * @throws when the header frame cannot be found or parsed, which means the file is not a DSH session log.
 */
export async function readSessionLog(
  path: string,
  options: { collectUsage?: boolean } = {},
): Promise<SessionLogScan> {
  const collectUsage = options.collectUsage === true;
  const state: ScanState = { header: undefined, title: undefined, records: new Map() };
  const compressed = path.endsWith('.zstd');

  if (!compressed) {
    const data = collectUsage ? await readFile(path) : await readHead(path, HEAD_BYTES);
    absorbChunk(data.toString('utf8'), state, collectUsage);
  } else {
    const handle = await open(path, 'r');
    try {
      const size = Number((await handle.stat()).size);
      let length = collectUsage ? size : Math.min(HEAD_BYTES, size);
      let data = Buffer.alloc(length);
      await handle.read(data, 0, length, 0);
      absorbFrames(data, state, collectUsage);
      if (!collectUsage && state.header === undefined && size > data.length) {
        // The leading frames did not contain the header; widen the window once.
        length = Math.min(MAX_BYTES, size);
        data = Buffer.alloc(length);
        await handle.read(data, 0, length, 0);
        absorbFrames(data, state, collectUsage);
      }
    } finally {
      await handle.close();
    }
  }

  if (state.header === undefined) {
    throw new Error(`无法在 ${path} 中找到会话头（session 事件）`);
  }
  const sessionId = asString(state.header['id']);
  if (sessionId === undefined) {
    throw new Error(`${path} 的会话头缺少 id 字段`);
  }
  const parentRaw = asString(state.header['parentSession']);
  const depth = asInteger(state.header['delegationDepth']) ?? (parentRaw === undefined ? 0 : 1);
  return {
    sessionId,
    parentSessionId: parentRaw ?? null,
    delegationDepth: depth,
    createdAt: asInteger(state.header['createdAt']) ?? null,
    cwd: asString(state.header['cwd']) ?? null,
    title: state.title ?? null,
    // The header carries the id, so every record can now be keyed
    // `<sessionId>:step:<turn>:<step>`.
    records: [...state.records.values()].map((pending) => ({
      id: `${sessionId}:step:${pending.key}`,
      ...pending.record,
    })),
  };
}

/** Read at most `limit` bytes from the start of a file. */
async function readHead(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const size = Number((await handle.stat()).size);
    const buffer = Buffer.alloc(Math.min(limit, size));
    await handle.read(buffer, 0, buffer.length, 0);
    return buffer;
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
 * One log per session directory is returned: when both the `session.v3` stream
 * and the legacy `session.jsonl` seed exist, the former wins, so the seed can
 * never masquerade as an empty session.
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
      const best = LOG_FILE_PREFERENCE.find((name) => entries.includes(name));
      if (best !== undefined) found.push({ directoryName: sessionDir, path: join(dir, best) });
    }
  }
  return found;
}

/**
 * Read delegation facts — and optionally usage — for every session log under a DSH home.
 *
 * Failures are collected rather than thrown: a single unreadable log must not
 * make the whole report unavailable.
 *
 * @param home - DSH home directory.
 * @param options - `collectUsage` also fills `records`, one entry per session,
 *   which requires reading every log to its end.
 * @returns a map from session id (and its `session-` spellings) to facts, a map
 *   from canonical session id to its records, the files read, and one warning per
 *   unreadable log.
 */
export async function readSessionLogIndex(
  home: string,
  options: { collectUsage?: boolean } = {},
): Promise<{
  byId: Map<string, SessionLogInfo>;
  records: Map<string, UsageRecord[]>;
  files: string[];
  warnings: string[];
}> {
  const collectUsage = options.collectUsage === true;
  const logs = await locateSessionLogs(home);
  const byId = new Map<string, SessionLogInfo>();
  const records = new Map<string, UsageRecord[]>();
  const files: string[] = [];
  const warnings: string[] = [];
  type Result = { log: LocatedSessionLog; scan: SessionLogScan } | { log: LocatedSessionLog; error: Error };
  const results = await Promise.all(
    logs.map(async (log): Promise<Result> => {
      try {
        return { log, scan: await readSessionLog(log.path, { collectUsage }) };
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
    const { scan } = result;
    files.push(result.log.path);
    byId.set(scan.sessionId, scan);
    if (collectUsage) records.set(scan.sessionId, scan.records);
    // A session may be referenced by its bare UUID in one place and by its
    // `session-` prefixed id in another; index both spellings.
    const bare = scan.sessionId.replace(/^session-/, '');
    if (bare !== scan.sessionId) byId.set(bare, scan);
    const prefixed = `session-${bare}`;
    if (!byId.has(prefixed)) byId.set(prefixed, scan);
  }
  return { byId, records, files, warnings };
}
