/**
 * The DSH agent adapter.
 *
 * Reads DeepSeek Harness' on-disk usage stores and converts them into the
 * agent-neutral {@link UsageDataset}. Three file families under the DSH home
 * directory matter:
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
 * Nothing here writes to the DSH home; the adapter is strictly read-only.
 */

import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { emptyBuckets } from '../../core/buckets.ts';
import type {
  DatasetStats,
  ProjectRecord,
  SessionRecord,
  TokenBuckets,
  UsageDataset,
  UsageRecord,
} from '../../core/types.ts';
import type { AdapterOptions, AgentAdapter } from '../contract.ts';
import { readSessionLogIndex, type SessionLogInfo } from './sessionlog.ts';

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

/**
 * Parse one ledger `usage[]` element, or `undefined` when it is unusable.
 *
 * The ledger names the model twice — a provider-qualified label and the bare
 * routed model — and the bare one is what a price list keys on.
 */
function parseRecord(raw: unknown): UsageRecord | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const id = asString(record['key']);
  const time = asNumber(record['time']);
  if (id === undefined || time === undefined) return undefined;
  const identity = asRecord(record['identity']);
  const modelLabel =
    asString(record['modelId']) ??
    asString(identity?.['label']) ??
    asString(identity?.['actualModel']) ??
    asString(identity?.['requestedModel']) ??
    'unknown';
  const model = asString(identity?.['actualModel']) ?? asString(identity?.['requestedModel']) ?? modelLabel;
  return {
    id,
    seq: asCount(record['seq']),
    time,
    modelLabel,
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
  records: Map<string, UsageRecord[]>;
  workspaceIds: Map<string, string>;
  sourceCwds: Map<string, string>;
  shards: string[];
}> {
  const records = new Map<string, UsageRecord[]>();
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
      const parsedRecords: UsageRecord[] = [];
      const seenKeys = new Set<string>();
      for (const rawEntry of usage) {
        const entry = parseRecord(rawEntry);
        if (entry === undefined) continue;
        if (seenKeys.has(entry.id)) {
          warnings.push(`会话 ${sessionId} 的账本分片 ${name} 出现重复记录 ${entry.id}，已忽略后一条`);
          continue;
        }
        seenKeys.add(entry.id);
        parsedRecords.push(entry);
      }
      const existing = records.get(sessionId);
      if (existing === undefined) {
        records.set(sessionId, parsedRecords);
      } else {
        // Distinct shards own distinct sessions. A collision means the shard
        // layout changed, so records are de-duplicated by key rather than
        // summed outright — double-billing the user would be worse than a
        // missing record, and the warning tells them to check.
        const known = new Set(existing.map((entry) => entry.id));
        let added = 0;
        for (const entry of parsedRecords) {
          if (known.has(entry.id)) continue;
          known.add(entry.id);
          existing.push(entry);
          added += 1;
        }
        warnings.push(
          `会话 ${sessionId} 同时出现在多个账本分片（${name}），已按记录键去重合并（新增 ${added} 条）`,
        );
      }
    }
  }
  return { records, workspaceIds, sourceCwds, shards };
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
function syntheticProjectKey(cwd: string | undefined): string {
  return `path:${cwd ?? '<unknown>'}`;
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
function resolveProjectKey(
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
 * Read a DSH home directory into the agent-neutral dataset.
 *
 * @param options - resolved adapter options; `enrich: false` skips the per-session
 *   logs, which is faster but loses titles for subagents and every delegation link.
 * @returns the dataset, with each project's sessions ordered by first usage ascending.
 * @throws when the data root is absent or carries no usage ledger.
 */
async function load(options: AdapterOptions = {}): Promise<UsageDataset> {
  const source = resolve(options.home ?? defaultSource(options.env ?? process.env) ?? '');
  const warnings: string[] = [];
  if (options.home !== undefined && !isAbsolute(options.home)) {
    throw new Error(`数据目录必须是绝对路径，收到 ${JSON.stringify(options.home)}`);
  }
  const [ledger, workspaces, meta, logIndex] = await Promise.all([
    readLedger(source, warnings),
    readWorkspaces(source, warnings),
    readSessionMeta(source, warnings),
    // A session log answers the delegation question that neither the ledger nor
    // the projection cache records. An unreadable log degrades attribution to
    // "top-level session" rather than failing the whole report.
    options.enrich === false ? Promise.resolve({ byId: new Map<string, SessionLogInfo>(), warnings: [] }) : readSessionLogIndex(source),
  ]);
  warnings.push(...logIndex.warnings);

  const workspaceOf = new Map<string, WorkspaceMeta>();
  for (const workspace of workspaces) workspaceOf.set(workspace.workspaceId, workspace);

  // `workspace.json`'s per-workspace `sessionIds` list is NOT an authoritative
  // roster: it is populated by a one-time bootstrap plus later explicit
  // attachments, and on a real home it names a fraction of the ledger's
  // sessions. The registry's *paths* are reliable, and the session's own cwd is
  // the real authority for ownership, so attribution goes through a path index —
  // exactly how the ledger writer itself attributes sessions.
  const workspaceByPath = new Map<string, WorkspaceMeta>();
  for (const workspace of workspaces) {
    if (workspace.path !== undefined && workspace.path.length > 0) {
      workspaceByPath.set(pathKey(workspace.path), workspace);
    }
  }

  const sessions: SessionRecord[] = [];
  const projectOfSession = new Map<string, string>();
  for (const [sessionId, records] of ledger.records) {
    records.sort((left, right) => (left.time === right.time ? (left.seq ?? 0) - (right.seq ?? 0) : left.time - right.time));
    const sessionMeta = meta.get(sessionId);
    const log = logIndex.byId.get(sessionId);
    const cwd = sessionMeta?.cwd ?? log?.cwd ?? ledger.sourceCwds.get(sessionId) ?? null;
    const projectKey =
      resolveProjectKey(ledger.workspaceIds.get(sessionId), cwd, workspaceOf, workspaceByPath, warnings) ??
      syntheticProjectKey(cwd ?? undefined);
    const session = buildSession(sessionId, records, {
      // Subagents are absent from the projection cache, so their log title is
      // the only human-readable label available.
      title: sessionMeta?.title ?? log?.title ?? null,
      cwd,
      createdAt: sessionMeta?.createdAt ?? log?.createdAt ?? null,
      log,
      byId: logIndex.byId,
    });
    if (sessionMeta?.projectedTotals !== undefined && sessionMeta.projectedTotals !== null) {
      session.extra = { projectedTotals: sessionMeta.projectedTotals };
    }
    sessions.push(session);
    projectOfSession.set(sessionId, projectKey);
  }

  // Sessions the projection cache knows about but the ledger does not carry made
  // no billed requests; they are still listed so the inventory matches what DSH
  // itself shows.
  for (const [sessionId, sessionMeta] of meta) {
    if (ledger.records.has(sessionId)) continue;
    const log = logIndex.byId.get(sessionId);
    const cwd = sessionMeta.cwd ?? log?.cwd ?? null;
    const projectKey = resolveProjectKey(undefined, cwd, workspaceOf, workspaceByPath, warnings) ?? syntheticProjectKey(cwd ?? undefined);
    const session = buildSession(sessionId, [], {
      title: sessionMeta.title ?? log?.title ?? null,
      cwd,
      createdAt: sessionMeta.createdAt ?? log?.createdAt ?? null,
      log,
      byId: logIndex.byId,
    });
    if (sessionMeta.projectedTotals !== undefined && sessionMeta.projectedTotals !== null) {
      session.extra = { projectedTotals: sessionMeta.projectedTotals };
    }
    sessions.push(session);
    projectOfSession.set(sessionId, projectKey);
  }

  // Second pass: record each parent's children now that every session is known.
  const byId = new Map(sessions.map((session) => [session.id, session]));
  for (const session of sessions) {
    if (session.parentId === null) continue;
    const parent = byId.get(session.parentId);
    if (parent === undefined) continue;
    parent.childIds.push(session.id);
  }
  for (const session of sessions) session.childIds.sort();

  const byProject = new Map<string, SessionRecord[]>();
  for (const session of sessions) {
    const key = projectOfSession.get(session.id) ?? syntheticProjectKey(session.cwd ?? undefined);
    const bucket = byProject.get(key);
    if (bucket === undefined) byProject.set(key, [session]);
    else bucket.push(session);
  }

  const projects: ProjectRecord[] = [];
  for (const [projectKey, members] of byProject) {
    const declared = workspaceOf.get(projectKey);
    const firstCwd = members.find((session) => session.cwd !== null)?.cwd ?? undefined;
    const path = declared?.path ?? firstCwd ?? '';
    members.sort((left, right) => firstUsageOf(left) - firstUsageOf(right));
    projects.push({
      id: projectKey,
      name: declared?.title ?? (path.length > 0 ? basenameOf(path) : projectKey),
      path,
      sessions: members,
    });
  }
  projects.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  const stats: DatasetStats = {
    filesRead: ledger.shards,
    sessions: sessions.length,
    records: sessions.reduce((total, session) => total + session.records.length, 0),
  };
  return { agent: 'dsh', source, projects, sessions, stats, warnings };
}

/** Assemble one session record from its parts. */
function buildSession(
  id: string,
  records: UsageRecord[],
  meta: {
    title: string | null;
    cwd: string | null;
    createdAt: number | null;
    log: SessionLogInfo | undefined;
    byId: ReadonlyMap<string, SessionLogInfo>;
  },
): SessionRecord {
  const parentId = resolveParentId(meta.log, meta.byId);
  const depth = meta.log?.delegationDepth ?? (parentId === null ? 0 : 1);
  const isSubagent = parentId !== null || depth > 0;
  return {
    id,
    title: meta.title,
    cwd: meta.cwd,
    createdAt: meta.createdAt,
    records,
    parentId: isSubagent ? parentId : null,
    depth,
    isSubagent,
    childIds: [],
    parentKnown: parentId !== null && meta.byId.has(parentId),
  };
}

/**
 * Resolve a session's parent id through the log index.
 *
 * The ledger keys a session by the bare UUID while the log header (and the
 * directories on disk) carry the `session-` prefix, so a parent id is run back
 * through the index — which holds both spellings — to land on the spelling the
 * ledger used.
 */
function resolveParentId(
  log: SessionLogInfo | undefined,
  byId: ReadonlyMap<string, SessionLogInfo>,
): string | null {
  const raw = log?.parentSessionId ?? null;
  if (raw === null) return null;
  return byId.get(raw)?.sessionId ?? raw;
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
  const first = session.records[0];
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
  const last = session.records[session.records.length - 1];
  if (last !== undefined) return last.time;
  if (session.createdAt !== null) return session.createdAt;
  return Number.NEGATIVE_INFINITY;
}

/** Default DSH home, honouring the same environment the harness does. */
function defaultSource(env: NodeJS.ProcessEnv): string | null {
  const configured = env['DSH_HOME']?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  const home = env['HOME'] ?? env['USERPROFILE'] ?? '';
  if (home.length === 0) return null;
  return join(home, '.dsh');
}

/**
 * Resolve the DSH home the way the harness does.
 * @param configured - an explicit path, which wins.
 * @param env - environment to read.
 * @returns the absolute DSH home path.
 * @throws when `DSH_HOME` is set but not absolute, or no home can be determined.
 */
export function resolveDshHome(configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  const candidate = configured ?? defaultSource(env);
  if (candidate === null || candidate === undefined || candidate.trim().length === 0) {
    throw new Error('无法确定 DSH 主目录：请设置 DSH_HOME 或用 --home 指定');
  }
  if (!isAbsolute(candidate)) {
    throw new Error(`DSH 主目录必须是绝对路径，收到 ${JSON.stringify(candidate)}`);
  }
  return resolve(candidate);
}

/** The DSH agent adapter. */
export const dshAgent: AgentAdapter = {
  id: 'dsh',
  label: 'DeepSeek Harness (DSH)',
  sessionNoun: '会话',
  envVars: ['DSH_HOME'],
  defaultSource,
  hasData: async (source) => {
    try {
      const names = await readdir(join(source, 'storages'));
      return names.some((name) => /^all_usage_ledger_\d+\.json$/.test(name));
    } catch {
      return false;
    }
  },
  load,
  notes: () => [
    '用量账本由 DSH 插件 dsh-all-usage 写入；若从未安装该插件，则没有可统计的逐请求用量。',
    '账本中的 cost 字段不可用（其价格目录从未成功拉取，恒为 0），本工具只取其 token 数与时间戳并自行计价。',
    '子代理关系只存在于会话日志首帧，需要在 sessions/ 下额外读取每个会话的日志。',
  ],
};
