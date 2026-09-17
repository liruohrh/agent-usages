/**
 * The DSH agent adapter.
 *
 * Reads DeepSeek Harness' own on-disk state and converts it into the
 * agent-neutral {@link UsageDataset}. Three file families under the DSH home
 * directory matter, all written by the harness itself:
 *
 * - `sessions/<projectKey>/<id>/session.jsonl[.zstd]` — the session logs and the
 *   only per-request usage source. Every `assistant/message` event repeats the
 *   `usage` block the provider returned for that step, so the log alone answers
 *   the token question; its leading frame also carries the delegation tree.
 * - `storages/workspace.json` — the workspace ("project") registry: title and
 *   path.
 * - `storages/session_projcache.json` — projection cache: session title, cwd,
 *   creation time, and the harness' own token totals, which are used only to
 *   cross-check the per-request records.
 *
 * No third-party plugin is needed, and none is read.
 *
 * Nothing here writes to the DSH home; the adapter is strictly read-only.
 */

import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  DatasetStats,
  ProjectRecord,
  SessionRecord,
  TokenBuckets,
  UsageDataset,
  UsageRecord,
} from '../../core/types.ts';
import type { AdapterOptions, AgentAdapter } from '../contract.ts';
import { readSessionLogIndex, locateSessionLogs, type SessionLogInfo } from './sessionlog.ts';

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

/**
 * Normalise a filesystem path for comparison: separators unified, case folded,
 * trailing separators dropped.
 * @param path - a filesystem path.
 * @returns a stable comparison key.
 */
export function pathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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
 * Attribute a session to a workspace by its working directory.
 *
 * `workspace.json`'s per-workspace `sessionIds` list is NOT an authoritative
 * roster: it is populated by a one-time bootstrap plus later explicit
 * attachments, so on a real home it names a fraction of the sessions. A
 * workspace's *path* is reliable, and the session header's own cwd is the real
 * authority for ownership, so attribution goes through a path index.
 *
 * @param cwd - the session's working directory, when known.
 * @param workspaceByPath - workspace path index.
 * @returns the matching workspace id, or `null` for a session that belongs to a
 *   project the registry does not know (the caller then synthesises one).
 */
function resolveProjectKey(
  cwd: string | null,
  workspaceByPath: ReadonlyMap<string, WorkspaceMeta>,
): string | null {
  if (cwd === null) return null;
  return workspaceByPath.get(pathKey(cwd))?.workspaceId ?? null;
}

/**
 * Read a DSH home directory into the agent-neutral dataset.
 *
 * Usage comes from the harness' own session logs, which record each step's
 * `usage` block. The projection cache and workspace registry only add titles,
 * ownership, and a cross-check; no third-party plugin is involved.
 *
 * @param options - resolved adapter options; `enrich: false` keeps the per-request
 *   usage but drops the log-derived titles and delegation links.
 * @returns the dataset, with each project's sessions ordered by first usage ascending.
 * @throws when the data root carries neither a session log nor a projection cache.
 */
async function load(options: AdapterOptions = {}): Promise<UsageDataset> {
  const source = resolve(options.home ?? defaultSource(options.env ?? process.env) ?? '');
  const warnings: string[] = [];
  if (options.home !== undefined && !isAbsolute(options.home)) {
    throw new Error(`数据目录必须是绝对路径，收到 ${JSON.stringify(options.home)}`);
  }

  const enrich = options.enrich !== false;
  const [workspaces, meta, logIndex] = await Promise.all([
    readWorkspaces(source, warnings),
    readSessionMeta(source, warnings),
    // The log answers two questions at once: per-request usage (every step), and
    // delegation (the leading frame), which neither of the two caches records.
    // An unreadable log degrades to a warning rather than failing the report.
    readSessionLogIndex(source, { collectUsage: true }),
  ]);
  warnings.push(...logIndex.warnings);

  if (logIndex.files.length === 0 && meta.size === 0) {
    throw new Error(
      `在 ${source} 下没有找到 DSH 用量数据：sessions/ 下没有会话日志，也没有 storages/session_projcache.json（可用 --home 指定，或设置 DSH_HOME）`,
    );
  }

  const workspaceOf = new Map<string, WorkspaceMeta>();
  for (const workspace of workspaces) workspaceOf.set(workspace.workspaceId, workspace);
  const workspaceByPath = new Map<string, WorkspaceMeta>();
  for (const workspace of workspaces) {
    if (workspace.path !== undefined && workspace.path.length > 0) {
      workspaceByPath.set(pathKey(workspace.path), workspace);
    }
  }

  // The same session can be spelled with or without the `session-` prefix in
  // different stores, and the log index knows both spellings; resolving every
  // projection-cache key to the log's canonical id keeps one session one row.
  const metaByCanonical = new Map<string, SessionMeta>();
  for (const [id, sessionMeta] of meta) {
    const canonical = logIndex.byId.get(id)?.sessionId ?? id;
    if (!metaByCanonical.has(canonical)) metaByCanonical.set(canonical, sessionMeta);
  }

  // Every session any source knows about: the logs carry billed sessions, the
  // projection cache the ones that never billed a request.
  const sessionIds = new Set<string>();
  for (const info of logIndex.byId.values()) sessionIds.add(info.sessionId);
  for (const sessionId of metaByCanonical.keys()) sessionIds.add(sessionId);

  const sessions: SessionRecord[] = [];
  const projectOfSession = new Map<string, string>();
  for (const sessionId of sessionIds) {
    const sessionMeta = metaByCanonical.get(sessionId);
    const log = enrich ? logIndex.byId.get(sessionId) : undefined;
    // A resumed/forked session's log opens with a copy of its parent's events.
    // DSH records how long that seeded prefix is, and the parent already owns
    // those requests, so the inherited part is dropped rather than billed twice.
    const seedLength = log?.seedLength ?? null;
    const records = (logIndex.records.get(sessionId) ?? []).filter(
      (record) => seedLength === null || (record.seq ?? 0) > seedLength,
    );
    records.sort((left, right) => (left.time === right.time ? (left.seq ?? 0) - (right.seq ?? 0) : left.time - right.time));
    const cwd = sessionMeta?.cwd ?? log?.cwd ?? null;
    const projectKey = resolveProjectKey(cwd, workspaceByPath) ?? syntheticProjectKey(cwd ?? undefined);
    const session = buildSession(sessionId, records, {
      // Subagents are absent from the projection cache, so their log title is
      // the only human-readable label available.
      title: sessionMeta?.title ?? log?.title ?? null,
      cwd,
      createdAt: sessionMeta?.createdAt ?? log?.createdAt ?? null,
      log,
      byId: logIndex.byId,
    });
    if (sessionMeta?.projectedTotals !== undefined) {
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
    filesRead: logIndex.files,
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
  // Delegation depth is the authority, not the mere presence of a parent: DSH
  // records a resumed/forked session's `parentSession` with depth 0, and such a
  // session is a continuation of its source, not a subagent it spawned.
  const depth = meta.log?.delegationDepth ?? 0;
  const isSubagent = depth > 0;
  const parentId = isSubagent ? resolveParentId(meta.log, meta.byId) : null;
  return {
    id,
    title: meta.title,
    cwd: meta.cwd,
    createdAt: meta.createdAt,
    records,
    parentId,
    depth,
    isSubagent,
    childIds: [],
    parentKnown: parentId !== null && meta.byId.has(parentId),
  };
}

/**
 * Resolve a session's parent id through the log index.
 *
 * A parent id may be written with the `session-` prefix while the child's
 * directory (or another log) spells it bare, so it is run back through the
 * index — which holds both spellings — to land on the canonical id.
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
      if ((await locateSessionLogs(source)).length > 0) return true;
    } catch {
      // Fall through: the projection cache can still describe sessions.
    }
    try {
      const names = await readdir(join(source, 'storages'));
      return names.includes('session_projcache.json');
    } catch {
      return false;
    }
  },
  load,
  notes: () => [
    '逐请求用量来自 harness 自己写的会话日志：每个 assistant/message 事件都带该步的 usage，因此不需要安装任何插件。',
    'reasoningTokens 是可选字段：新版 DSH 默认的 messages 协议不带它，此时思考 token 计 0，工具不会估算。',
    '会话日志是追加写的多帧 zstd；正在写入的会话最后几帧可能读不全，重跑即可补齐。',
    '会话标题与创建时间优先取 storages/session_projcache.json，子代理关系只在会话日志首帧。',
    '本工具不读取任何第三方插件的落盘数据。',
  ],
};
