/**
 * Reader for the DSH on-disk usage stores.
 *
 * Three files under the DSH home directory matter:
 *
 * - `storages/all_usage_ledger_*.json` — the durable per-request usage ledger.
 *   Each shard is an independent key/value unit and a session lives in exactly
 *   one shard, so sessions are unioned across shards; within a shard a session
 *   appears once.
 * - `storages/workspace.json` — the workspace ("project") registry: title,
 *   path, and member session ids.
 * - `storages/session_projcache.json` — projection cache: session title, cwd,
 *   creation time, and the harness' own token totals, which are used only to
 *   cross-check the ledger.
 *
 * Nothing here writes to the DSH home; the loader is strictly read-only.
 */

import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  ProjectRecord,
  SessionRecord,
  TokenBuckets,
  UsageDataset,
  UsageEntry,
} from './types.ts';
import { readSessionLogIndex, type SessionLogInfo } from './sessionlog.ts';

/** Buckets with every counter at zero. */
export function emptyBuckets(): TokenBuckets {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

/** Options accepted by {@link loadDataset}. */
export interface LoadOptions {
  /** Explicit DSH home; defaults to {@link resolveDshHome}. */
  home?: string;
}

/**
 * Resolve the DSH home directory the same way the harness does.
 * @param env - environment to read; defaults to `process.env`.
 * @param platform - platform name, used only for the Windows default; defaults to `process.platform`.
 * @returns the absolute DSH home path.
 * @throws when `DSH_HOME` is set but not absolute.
 */
export function resolveDshHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env['DSH_HOME']?.trim();
  if (configured !== undefined && configured.length > 0) {
    if (!isAbsolute(configured)) {
      throw new Error(`DSH_HOME must be an absolute path, got ${JSON.stringify(configured)}`);
    }
    return configured;
  }
  const home = env['HOME'] ?? env['USERPROFILE'] ?? '';
  if (home.length === 0) {
    throw new Error('cannot determine the home directory: neither HOME nor USERPROFILE is set');
  }
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    return appData !== undefined && appData.length > 0 ? join(appData, 'dsh') : join(home, '.dsh');
  }
  return join(home, '.dsh');
}

/** Narrow an unknown JSON value to a record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read a non-negative integer, defaulting to 0 for missing or malformed input. */
function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Read a finite number, or `undefined`. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Read a non-empty string, or `undefined`. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Parse the token buckets the harness recorded for one request. */
function parseBuckets(raw: unknown): TokenBuckets {
  const values = asRecord(raw);
  if (values === undefined) return emptyBuckets();
  return {
    input: asCount(values['input']),
    output: asCount(values['output']),
    cacheRead: asCount(values['cacheRead']),
    cacheWrite: asCount(values['cacheWrite']),
    reasoning: asCount(values['reasoning']),
  };
}

/** Parse one ledger `usage[]` element, or `undefined` when it is unusable. */
function parseEntry(raw: unknown): UsageEntry | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const key = asString(record['key']);
  const time = asNumber(record['time']);
  if (key === undefined || time === undefined) return undefined;
  const identity = asRecord(record['identity']);
  const modelId =
    asString(record['modelId']) ??
    asString(identity?.['label']) ??
    asString(identity?.['actualModel']) ??
    asString(identity?.['requestedModel']) ??
    'unknown';
  const model =
    asString(identity?.['actualModel']) ??
    asString(identity?.['requestedModel']) ??
    modelId;
  return {
    key,
    seq: asCount(record['seq']),
    time,
    modelId,
    model,
    turn: asCount(record['turn']),
    step: asCount(record['step']),
    tokens: parseBuckets(record['values']),
  };
}

/** Session facts recovered from `session_projcache.json`. */
interface SessionMeta {
  title: string | undefined;
  cwd: string | undefined;
  createdAt: number | undefined;
  projectedTotals: TokenBuckets | undefined;
}

/** Read the projection cache into a flat session-id → metadata map. */
async function readSessionMeta(home: string, warnings: string[]): Promise<Map<string, SessionMeta>> {
  const result = new Map<string, SessionMeta>();
  const path = join(home, 'storages', 'session_projcache.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`无法读取 ${path}: ${(error as Error).message}`);
    }
    return result;
  }
  const sessions = asRecord(asRecord(asRecord(parsed)?.['tables'])?.['sessions']);
  if (sessions === undefined) return result;
  for (const [sessionId, rawSession] of Object.entries(sessions)) {
    const record = asRecord(rawSession);
    if (record === undefined) continue;
    const identity = asRecord(record['identity']);
    const rows = asRecord(record['rows']);
    const titleRow = asRecord(rows?.['title']);
    const usageRow = asRecord(rows?.['tokenUsage']);
    const totals = asRecord(asRecord(usageRow?.['val'])?.['totals']);
    result.set(sessionId, {
      title: asString(titleRow?.['val']),
      cwd: asString(identity?.['cwd']),
      createdAt: asNumber(identity?.['createdAt']),
      projectedTotals:
        totals === undefined
          ? undefined
          : {
              input: asCount(totals['uncachedInputTokens']),
              output: asCount(totals['outputTokens']),
              cacheRead: asCount(totals['cacheReadTokens']),
              cacheWrite: asCount(totals['cacheWriteTokens']),
              reasoning: 0,
            },
    });
  }
  return result;
}

/** One workspace as declared by `workspace.json`. */
interface WorkspaceMeta {
  workspaceId: string;
  title: string | undefined;
  path: string | undefined;
  sessionIds: string[];
}

/** Read the workspace registry. */
async function readWorkspaces(home: string, warnings: string[]): Promise<WorkspaceMeta[]> {
  const path = join(home, 'storages', 'workspace.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`无法读取 ${path}: ${(error as Error).message}`);
    }
    return [];
  }
  const workspaces = asRecord(asRecord(asRecord(parsed)?.['tables'])?.['workspaces']);
  if (workspaces === undefined) return [];
  const result: WorkspaceMeta[] = [];
  for (const [workspaceId, rawWorkspace] of Object.entries(workspaces)) {
    const record = asRecord(rawWorkspace);
    if (record === undefined) continue;
    const ids = Array.isArray(record['sessionIds']) ? record['sessionIds'] : [];
    result.push({
      workspaceId,
      title: asString(record['title']),
      path: asString(record['path']),
      sessionIds: ids.filter((id): id is string => typeof id === 'string'),
    });
  }
  return result;
}

/** Read every ledger shard, merging sessions and reporting duplicate keys. */
async function readLedger(
  home: string,
  warnings: string[],
): Promise<{
  entries: Map<string, UsageEntry[]>;
  workspaceIds: Map<string, string>;
  sourceCwds: Map<string, string>;
  shards: string[];
}> {
  const entries = new Map<string, UsageEntry[]>();
  const workspaceIds = new Map<string, string>();
  const sourceCwds = new Map<string, string>();
  const shards: string[] = [];
  const storageDir = join(home, 'storages');
  let names: string[];
  try {
    names = await readdir(storageDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`DSH 数据目录不存在: ${storageDir}（可用 --home 指定，或设置 DSH_HOME）`);
    }
    throw error;
  }
  const ledgerFiles = names.filter((name) => /^all_usage_ledger_\d+\.json$/.test(name)).sort();
  if (ledgerFiles.length === 0) {
    throw new Error(`在 ${storageDir} 下没有找到 all_usage_ledger_*.json，无法统计用量`);
  }

  for (const name of ledgerFiles) {
    const path = join(storageDir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      warnings.push(`跳过无法解析的账本分片 ${name}: ${(error as Error).message}`);
      continue;
    }
    shards.push(path);
    const sessions = asRecord(asRecord(asRecord(parsed)?.['tables'])?.['sessions']);
    if (sessions === undefined) continue;
    for (const [sessionId, rawSession] of Object.entries(sessions)) {
      if (sessionId.startsWith('__')) continue; // ledger bookkeeping row
      const record = asRecord(rawSession);
      if (record === undefined) continue;
      const workspaceId = asString(record['workspaceId']);
      if (workspaceId !== undefined) workspaceIds.set(sessionId, workspaceId);
      const sourceCwd = asString(record['sourceCwd']);
      if (sourceCwd !== undefined) sourceCwds.set(sessionId, sourceCwd);
      const usage = Array.isArray(record['usage']) ? record['usage'] : [];
      const parsedEntries: UsageEntry[] = [];
      const seenKeys = new Set<string>();
      for (const rawEntry of usage) {
        const entry = parseEntry(rawEntry);
        if (entry === undefined) continue;
        if (seenKeys.has(entry.key)) {
          warnings.push(`会话 ${sessionId} 的账本分片 ${name} 出现重复记录 ${entry.key}，已忽略后一条`);
          continue;
        }
        seenKeys.add(entry.key);
        parsedEntries.push(entry);
      }
      const existing = entries.get(sessionId);
      if (existing === undefined) {
        entries.set(sessionId, parsedEntries);
      } else {
        // Distinct shards own distinct sessions. A collision means the shard
        // layout changed, so records are de-duplicated by key rather than
        // summed outright — double-billing the user would be worse than a
        // missing record, and the warning tells them to check.
        const known = new Set(existing.map((entry) => entry.key));
        let added = 0;
        for (const entry of parsedEntries) {
          if (known.has(entry.key)) continue;
          known.add(entry.key);
          existing.push(entry);
          added += 1;
        }
        warnings.push(
          `会话 ${sessionId} 同时出现在多个账本分片（${name}），已按记录键去重合并（新增 ${added} 条）`,
        );
      }
    }
  }
  return { entries, workspaceIds, sourceCwds, shards };
}

/**
 * Compare working directories the way the ledger writer does: separators
 * unified, case folded, trailing separators dropped.
 * @param path - a filesystem path.
 * @returns a stable comparison key.
 */
export function pathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Whether a workspace id is a placeholder the ledger uses for gone projects. */
function isPlaceholderWorkspaceId(workspaceId: string): boolean {
  return workspaceId === 'retired:deleted' || workspaceId.startsWith('unregistered:');
}

/** Derive a project key for sessions the workspace registry does not list. */
function syntheticWorkspaceId(cwd: string | undefined): string {
  return `path:${cwd ?? '<unknown>'}`;
}

/**
 * Delegation facts for one session, resolved through the log index.
 *
 * The ledger keys a session by the bare UUID while the log header (and the
 * directories on disk) carry the `session-` prefix, so a parent id is run back
 * through the index — which holds both spellings — to land on the same spelling
 * the ledger used.
 */
function delegationOf(
  sessionId: string,
  log: SessionLogInfo | undefined,
  byId: ReadonlyMap<string, SessionLogInfo>,
): Pick<SessionRecord, 'parentSessionId' | 'delegationDepth' | 'isSubagent' | 'subagentIds' | 'parentKnown'> {
  const rawParent = log?.parentSessionId ?? null;
  const resolvedParent = rawParent === null ? null : (byId.get(rawParent)?.sessionId ?? rawParent);
  // `delegationDepth` is the harness' own statement of nesting; a session with a
  // parent is a subagent even if the depth field is missing or zero.
  const isSubagent = resolvedParent !== null || (log !== undefined && log.delegationDepth > 0);
  return {
    parentSessionId: isSubagent ? resolvedParent : null,
    delegationDepth: log?.delegationDepth ?? (isSubagent ? 1 : 0),
    isSubagent,
    subagentIds: [],
    parentKnown: resolvedParent !== null && byId.has(resolvedParent),
  };
}

/** Basename of a path, tolerating Windows separators. */
function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

/**
 * Attribute a session to a workspace.
 *
 * Preference order: a workspace id the registry still knows, then the cwd path
 * index, then the session's own cwd as a synthetic project. A ledger id that
 * the registry no longer lists (a deleted project) is not silently dropped —
 * the path index gets a chance first, and the id is kept only as a last resort.
 */
function resolveWorkspaceId(
  ledgerWorkspaceId: string | undefined,
  cwd: string | null,
  workspaceOf: ReadonlyMap<string, WorkspaceMeta>,
  workspaceByPath: ReadonlyMap<string, WorkspaceMeta>,
  warnings: string[],
): string | null {
  if (ledgerWorkspaceId !== undefined && workspaceOf.has(ledgerWorkspaceId)) {
    return ledgerWorkspaceId;
  }
  if (cwd !== null) {
    const byPath = workspaceByPath.get(pathKey(cwd));
    if (byPath !== undefined) {
      if (ledgerWorkspaceId !== undefined && !isPlaceholderWorkspaceId(ledgerWorkspaceId)) {
        warnings.push(
          `会话归属不一致：账本记为项目 ${ledgerWorkspaceId}，工作目录 ${cwd} 属于项目 ${byPath.workspaceId}；已按工作目录归组`,
        );
      }
      return byPath.workspaceId;
    }
  }
  if (ledgerWorkspaceId === undefined || isPlaceholderWorkspaceId(ledgerWorkspaceId)) {
    // Left as `null`: the session becomes its own project keyed by cwd.
    return null;
  }
  warnings.push(`会话引用的项目 ${ledgerWorkspaceId} 已不在 workspace.json 中，且无法由工作目录还原`);
  return null;
}

/**
 * Load every project, session, and usage record from a DSH home directory.
 * @param options - loader options.
 * @returns the dataset, with sessions ordered by first usage ascending.
 * @throws when the storages directory or the usage ledger is missing.
 */
export async function loadDataset(options: LoadOptions = {}): Promise<UsageDataset> {
  const home = resolve(options.home ?? resolveDshHome());
  const warnings: string[] = [];
  const [ledger, workspaces, meta, logIndex] = await Promise.all([
    readLedger(home, warnings),
    readWorkspaces(home, warnings),
    readSessionMeta(home, warnings),
    readSessionLogIndex(home),
  ]);
  // A session log answers the delegation question that neither the ledger nor
  // the projection cache records. An unreadable log degrades attribution to
  // "top-level session" rather than failing the whole report.
  warnings.push(...logIndex.warnings);

  const workspaceOf = new Map<string, WorkspaceMeta>();
  for (const workspace of workspaces) {
    workspaceOf.set(workspace.workspaceId, workspace);
  }

  // `workspace.json`'s per-workspace `sessionIds` list is NOT an authoritative
  // roster: it is populated by a one-time bootstrap plus later explicit
  // attachments, and on this machine it names 7 sessions while the ledger holds
  // 51. The registry's *paths* are reliable, and the session's own cwd is the
  // real authority for ownership, so attribution goes through a path index —
  // the same way the ledger writer itself attributes sessions.
  const workspaceByPath = new Map<string, WorkspaceMeta>();
  for (const workspace of workspaces) {
    if (workspace.path !== undefined && workspace.path.length > 0) {
      workspaceByPath.set(pathKey(workspace.path), workspace);
    }
  }

  const sessions: SessionRecord[] = [];
  for (const [sessionId, entries] of ledger.entries) {
    entries.sort((left, right) => (left.time === right.time ? left.seq - right.seq : left.time - right.time));
    const sessionMeta = meta.get(sessionId);
    const log = logIndex.byId.get(sessionId);
    const cwd = sessionMeta?.cwd ?? log?.cwd ?? ledger.sourceCwds.get(sessionId) ?? null;
    sessions.push({
      sessionId,
      workspaceId: resolveWorkspaceId(ledger.workspaceIds.get(sessionId), cwd, workspaceOf, workspaceByPath, warnings),
      // Subagents are absent from the projection cache, so their log title is
      // the only human-readable label available.
      title: sessionMeta?.title ?? log?.title ?? null,
      cwd,
      createdAt: sessionMeta?.createdAt ?? log?.createdAt ?? null,
      entries,
      projectedTotals: sessionMeta?.projectedTotals ?? null,
      ...delegationOf(sessionId, log, logIndex.byId),
    });
  }

  // Sessions the projection cache knows about but the ledger does not carry no
  // billed requests; they are still listed by `session list` so the inventory
  // matches what DSH shows.
  for (const [sessionId, sessionMeta] of meta) {
    if (ledger.entries.has(sessionId)) continue;
    const log = logIndex.byId.get(sessionId);
    const cwd = sessionMeta.cwd ?? log?.cwd ?? null;
    sessions.push({
      sessionId,
      workspaceId: resolveWorkspaceId(undefined, cwd, workspaceOf, workspaceByPath, warnings),
      title: sessionMeta.title ?? log?.title ?? null,
      cwd,
      createdAt: sessionMeta.createdAt ?? log?.createdAt ?? null,
      entries: [],
      projectedTotals: sessionMeta.projectedTotals ?? null,
      ...delegationOf(sessionId, log, logIndex.byId),
    });
  }

  // Second pass: record each parent's children now that every session is known.
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  for (const session of sessions) {
    if (session.parentSessionId === null) continue;
    const parent = byId.get(session.parentSessionId);
    if (parent === undefined) continue;
    parent.subagentIds.push(session.sessionId);
  }
  for (const session of sessions) session.subagentIds.sort();

  const byWorkspace = new Map<string, SessionRecord[]>();
  for (const session of sessions) {
    const key = session.workspaceId ?? syntheticWorkspaceId(session.cwd ?? undefined);
    const bucket = byWorkspace.get(key);
    if (bucket === undefined) byWorkspace.set(key, [session]);
    else bucket.push(session);
  }

  const projects: ProjectRecord[] = [];
  for (const [workspaceId, members] of byWorkspace) {
    const declared = workspaceOf.get(workspaceId);
    const firstCwd = members.find((session) => session.cwd !== null)?.cwd ?? undefined;
    const path = declared?.path ?? firstCwd ?? '';
    members.sort((left, right) => firstUsageOf(left) - firstUsageOf(right));
    projects.push({
      workspaceId,
      name: declared?.title ?? (path.length > 0 ? basenameOf(path) : workspaceId),
      path,
      sessions: members,
    });
  }
  projects.sort((left, right) => left.name.localeCompare(right.name) || left.workspaceId.localeCompare(right.workspaceId));

  return { home, shardFiles: ledger.shards, projects, sessions, warnings };
}

/**
 * Earliest instant a session can be attributed to.
 *
 * The first billed request is the most reliable signal; session creation time
 * covers sessions that never billed a request.
 * @param session - the session to date.
 * @returns milliseconds since the Unix epoch, or `Number.POSITIVE_INFINITY` when the session has no time at all.
 */
export function firstUsageOf(session: SessionRecord): number {
  const first = session.entries[0];
  if (first !== undefined) return first.time;
  if (session.createdAt !== null) return session.createdAt;
  return Number.POSITIVE_INFINITY;
}

/**
 * Latest instant a session can be attributed to.
 * @param session - the session to date.
 * @returns milliseconds since the Unix epoch, or `Number.NEGATIVE_INFINITY` when the session has no time at all.
 */
export function lastUsageOf(session: SessionRecord): number {
  const last = session.entries[session.entries.length - 1];
  if (last !== undefined) return last.time;
  if (session.createdAt !== null) return session.createdAt;
  return Number.NEGATIVE_INFINITY;
}
