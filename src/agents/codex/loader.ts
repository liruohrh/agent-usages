/**
 * Codex adapter: reads the rollout logs Codex CLI writes itself.
 *
 * Layout (verified against codex-cli 0.155.1):
 *
 * ```
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl
 * ```
 *
 * Each line is `{ timestamp, ordinal, type, payload }`. Usage arrives as
 * `event_msg` / `token_count` events carrying **both** a delta and a running
 * total:
 *
 * | field | meaning |
 * | --- | --- |
 * | `info.last_token_usage` | that one API response — the only summable view |
 * | `info.total_token_usage` | whole thread, cumulative |
 *
 * Only the delta is billed. A `codex exec fork` copies no events but inherits
 * the parent's running total, so summing `total_token_usage` would charge the
 * parent's history again; with deltas the inherited part simply has no event.
 * The `token_usage_record` lines are a second rendering of the same calls, so
 * they are ignored rather than added.
 *
 * A subagent is a rollout of its own. Its `session_meta.id` is its own id while
 * `session_meta.session_id` still names the **parent** — hence identity comes
 * from `id` (or the file name), and the parent link from
 * `source.subagent.thread_spawn`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

import { repoOf } from '../../core/git.ts';
import { workspacePathsOf } from '../../core/paths.ts';
import type { ProjectRecord, SessionRecord, TokenBuckets, UsageDataset, UsageRecord } from '../../core/types.ts';
import { UserError, renderDiagnostic, type Warning } from '../../i18n/errors.ts';
import { t } from '../../i18n/index.ts';
import type { AdapterOptions, AgentAdapter } from '../contract.ts';

/** Environment variable Codex honours for its home directory. */
const ENV_HOME = 'CODEX_HOME';

/** Parse a JSON value into a record, or `undefined`. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read a non-empty string, or `undefined`. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Read a finite number, or `undefined`. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/** Read a non-negative count, defaulting to 0. */
function asCount(value: unknown): number {
  const parsed = asNumber(value);
  return parsed === undefined || parsed <= 0 ? 0 : parsed;
}

/** Read an ISO timestamp as epoch milliseconds, or `null`. */
function asInstant(value: unknown): number | null {
  const text = asString(value);
  if (text === undefined) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Token buckets from Codex's six counters.
 *
 * `input_tokens` already contains `cached_input_tokens`, and `output_tokens`
 * already contains `reasoning_output_tokens`, so both are split rather than
 * added: the buckets stay disjoint, which is what the report's arithmetic
 * (`I/T + O/T` = the request's total) depends on.
 */
function usageBuckets(usage: Record<string, unknown>): TokenBuckets {
  const input = asCount(usage['input_tokens']);
  const cached = asCount(usage['cached_input_tokens']);
  const output = asCount(usage['output_tokens']);
  const reasoning = asCount(usage['reasoning_output_tokens']);
  return {
    input: Math.max(0, input - cached),
    output: Math.max(0, output - reasoning),
    cacheRead: cached,
    cacheWrite: asCount(usage['cache_write_input_tokens']),
    reasoning,
  };
}

/** One rollout file's facts. */
interface ScannedSession {
  /** Codex's own thread id (`session_meta.id`), never `session_id`. */
  id: string;
  cwd: string | null;
  createdAt: number | null;
  records: UsageRecord[];
  parentId: string | null;
  depth: number;
  isSubagent: boolean;
  /** Title: the task a subagent was given, or nothing. */
  title: string | null;
  /** Session this one was forked from (`forked_from_id`). */
  forkedFrom: string | null;
  /** Subagent identity, straight from `thread_spawn`. */
  agentPath: string | null;
  agentNickname: string | null;
  /** Tokens the fork inherited as a running total, with no events behind them. */
  inheritedTokens: number;
}

/**
 * Parse one rollout file.
 *
 * @param path - a `rollout-*.jsonl` file.
 * @param fallbackId - id from the file name, used when the header is missing.
 * @returns what the file billed, or `undefined` when it has nothing to read.
 */
async function scanSession(path: string, fallbackId: string): Promise<ScannedSession | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  let id: string | undefined;
  let title: string | null = null;
  let forkedFrom: string | null = null;
  let forkBoundary: number | undefined;
  let agentPath: string | null = null;
  let agentNickname: string | null = null;
  let inheritedTokens = 0;
  let parentId: string | null = null;
  let depth = 0;
  let isSubagent = false;
  let cwd: string | null = null;
  let createdAt: number | null = null;
  let model = 'unknown';
  const records: UsageRecord[] = [];
  let line = 0;
  for (const raw of text.split('\n')) {
    if (raw.trim().length === 0) continue;
    line += 1;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = asRecord(JSON.parse(raw));
    } catch {
      continue;
    }
    if (entry === undefined) continue;
    const type = asString(entry['type']);
    const payload = asRecord(entry['payload']);
    if (type === 'session_meta' && payload !== undefined) {
      id ??= asString(payload['id']);
      cwd ??= asString(payload['cwd']) ?? null;
      createdAt ??= asInstant(entry['timestamp']);
      // A subagent's `session_id` names its parent; the spawn record is the link.
      const spawn = asRecord(asRecord(asRecord(payload['source'])?.['subagent'])?.['thread_spawn']);
      if (spawn !== undefined) {
        isSubagent = true;
        depth = asNumber(spawn['depth']) ?? 1;
        parentId = asString(spawn['parent_thread_id']) ?? null;
        agentPath = asString(spawn['agent_path']) ?? null;
        agentNickname = asString(spawn['agent_nickname']) ?? null;
      }
      // A fork names its source and inherits its running total without copying
      // any event; the difference is what must never be billed here.
      const forkSource = asString(payload['forked_from_id']);
      if (forkSource !== undefined) forkedFrom ??= forkSource;
      // A fork may copy the source's history up to this ordinal. Today's forks do
      // not (verified: every copied-fork's first token event sits past the
      // boundary), but skipping anything at or below it costs nothing and keeps
      // the "delta only" rule safe if that ever changes.
      forkBoundary ??= asNumber(payload['forked_from_ordinal_exclusive']);
      continue;
    }
    if (type === 'turn_context' && payload !== undefined) {
      cwd ??= asString(payload['cwd']) ?? null;
      // The model can change mid-session; the next request is billed with it.
      model = asString(payload['model']) ?? model;
      continue;
    }
    if (type === 'response_item' && payload !== undefined && title === null) {
      // A subagent's first message is the task it was spawned with:
      // "Message Type: NEW_TASK\nTask name: …\n\n<the task itself>".
      if (asString(payload['type']) === 'agent_message') {
        title = taskTitle(payload) ?? title;
      }
      continue;
    }
    if (type !== 'event_msg' || payload === undefined) continue;
    if (asString(payload['type']) !== 'token_count') continue;
    if (forkBoundary !== undefined && (asNumber(entry['ordinal']) ?? 0) <= forkBoundary) continue;
    // The delta, never the running total: a fork inherits the parent's total
    // without inheriting its events.
    const delta = asRecord(asRecord(payload['info'])?.['last_token_usage']);
    const time = asInstant(entry['timestamp']);
    if (delta === undefined || time === null) continue;
    if (records.length === 0) {
      const info = asRecord(payload['info']);
      const running = info === undefined ? undefined : asRecord(info['total_token_usage']);
      const total = asNumber(running?.['total_tokens']) ?? 0;
      inheritedTokens = Math.max(0, total - (asNumber(delta['total_tokens']) ?? 0));
    }
    createdAt ??= time;
    records.push({
      id: `${id ?? fallbackId}:tok:${String(entry['ordinal'] ?? line)}`,
      time,
      model,
      modelLabel: model,
      tokens: usageBuckets(delta),
    });
  }
  if (id === undefined && records.length === 0 && cwd === null) return undefined;
  // Without a task message, the spawn path still names the agent.
  title ??= agentPath === null ? null : (agentPath.split('/').filter((part) => part.length > 0).pop() ?? null);
  title ??= agentNickname;
  return {
    id: id ?? fallbackId,
    cwd,
    createdAt,
    title,
    records,
    parentId,
    depth,
    isSubagent,
    forkedFrom,
    agentPath,
    agentNickname,
    inheritedTokens,
  };
}

/**
 * The task text out of a subagent's opening `NEW_TASK` message.
 *
 * @param payload - the `agent_message` payload.
 * @returns the first line of the task itself, or `undefined` when this is not a
 *   task message.
 */
function taskTitle(payload: Record<string, unknown>): string | undefined {
  const content = Array.isArray(payload['content']) ? payload['content'] : [];
  const texts = content
    .map((item) => asString(asRecord(item)?.['text']) ?? '')
    .filter((text) => text.length > 0);
  const text = texts.join('\n');
  if (!text.includes('NEW_TASK')) return undefined;
  // The envelope is `Message Type: …\nTask name: …\nSender: …\nPayload:` and the
  // task itself follows the `Payload:` marker.
  const marker = text.indexOf('Payload:');
  const body = marker === -1 ? text : text.slice(marker + 'Payload:'.length);
  const line = body
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line === undefined ? undefined : line.slice(0, 80);
}

/** Every `rollout-*.jsonl` under a directory tree, sorted for stable runs. */
async function findRollouts(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) found.push(path);
    }
  };
  await walk(root);
  return found.sort();
}

/** Assemble one neutral session record. */
function buildSession(scanned: ScannedSession, named: string | null): SessionRecord {
  const records = [...scanned.records].sort((left, right) => left.time - right.time);
  const extra: Record<string, unknown> = {};
  // A fork is a continuation of its source, not a subagent it spawned: it keeps
  // `depth = 0` and only names where it came from.
  if (scanned.forkedFrom !== null) {
    extra['forkedFrom'] = scanned.forkedFrom;
    extra['inheritedTokens'] = scanned.inheritedTokens;
  }
  if (scanned.isSubagent) {
    if (scanned.agentPath !== null) extra['agentPath'] = scanned.agentPath;
    if (scanned.agentNickname !== null) extra['agentNickname'] = scanned.agentNickname;
  }
  return {
    id: scanned.id,
    agent: 'codex',
    title: named ?? scanned.title,
    cwd: scanned.cwd,
    createdAt: scanned.createdAt,
    records,
    parentId: scanned.parentId ?? scanned.forkedFrom,
    depth: scanned.depth,
    isSubagent: scanned.isSubagent,
    archived: false,
    childIds: [],
    parentKnown: false,
    ...(Object.keys(extra).length === 0 ? {} : { extra }),
  };
}

/** Earliest instant a session can be attributed to. */
function firstUsageOf(session: SessionRecord): number {
  const first = session.records[0];
  if (first !== undefined) return first.time;
  if (session.createdAt !== null) return session.createdAt;
  return Number.POSITIVE_INFINITY;
}

/** Read a Codex home into the agent-neutral dataset. */
async function load(options: AdapterOptions = {}): Promise<UsageDataset> {
  const env = options.env ?? process.env;
  const source = options.home ?? defaultSource(env) ?? '';
  const warnings: Warning[] = [];
  if (options.home !== undefined && !isAbsolute(options.home)) {
    throw new UserError('codexHomeNotAbsolute', { value: JSON.stringify(options.home) });
  }

  const [files, titles] = [await findRollouts(join(source, 'sessions')), await readThreadTitles(source)];
  const sessions: SessionRecord[] = [];
  const filesOf = new Map<string, string>();
  for (const file of files) {
    const fallbackId = basename(file).replace(/^rollout-[^-]*-/, '').replace(/\.jsonl$/, '');
    const scanned = await scanSession(file, fallbackId);
    if (scanned === undefined) {
      warnings.push(
        new UserError('codexSessionUnreadable', { path: relative(source, file).split(sep).join('/') }),
      );
      continue;
    }
    if (sessions.some((session) => session.id === scanned.id)) continue;
    const session = buildSession(scanned, titles.get(scanned.id) ?? null);
    sessions.push(session);
    filesOf.set(session.id, file);
  }
  if (sessions.length === 0) {
    throw new Error(renderDiagnostic('codexNoData', { source }));
  }
  // `/btw` runs in a thread that never gets a rollout, so its tokens are missing
  // from every session file — but the internal log records each turn's total.
  const known = new Set(sessions.map((session) => session.id));
  const side = await readSideTurnUsage(source, known);
  if (side.turns > 0) {
    warnings.push(
      new UserError('sideQuestionsCounted', {
        count: String(side.threads),
        tokens: side.tokens.toLocaleString('en-US'),
        turns: String(side.turns),
        agent: 'Codex',
      }),
    );
  } else {
    const btw = await countUnpersistedSessions(join(source, 'history.jsonl'), known);
    if (btw > 0) warnings.push(new UserError('sideQuestionsUncounted', { count: String(btw), agent: 'Codex' }));
  }

  const byId = new Map(sessions.map((session) => [session.id, session]));
  for (const session of sessions) {
    if (session.parentId === null) continue;
    const parent = byId.get(session.parentId);
    if (parent === undefined) continue;
    // A fork is a continuation of its source, not one of its children.
    if (session.isSubagent) parent.childIds.push(session.id);
    session.parentKnown = true;
  }
  for (const session of sessions) session.childIds.sort();

  // Codex has no project registry: the session's own `cwd` is the grouping key.
  const byCwd = new Map<string, SessionRecord[]>();
  for (const session of sessions) {
    const key = session.cwd ?? '';
    const bucket = byCwd.get(key);
    if (bucket === undefined) byCwd.set(key, [session]);
    else bucket.push(session);
  }
  const projects: ProjectRecord[] = [];
  for (const [path, members] of byCwd) {
    members.sort((left, right) => firstUsageOf(left) - firstUsageOf(right));
    projects.push({
      id: path.length > 0 ? `path:${path}` : 'path:<unknown>',
      name: path.length > 0 ? basename(path) : '<unknown>',
      path,
      sessions: members,
      agents: ['codex'],
      workspaces: workspacePathsOf(members, path),
    });
  }
  await Promise.all(
    projects.map(async (project) => {
      if (project.path.length === 0) return;
      const repo = await repoOf(project.path);
      if (repo !== undefined) project.repo = repo;
    }),
  );
  projects.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  return {
    agent: 'codex',
    agents: ['codex'],
    source,
    projects,
    sessions,
    stats: {
      filesRead: sessions.map((session) => filesOf.get(session.id) as string),
      sessions: sessions.length,
      records: sessions.reduce((total, session) => total + session.records.length, 0),
    },
    warnings,
  };
}

/**
 * Usage of turns whose thread never got a rollout.
 *
 * `logs_2.sqlite` logs one line per sampled turn:
 * `… post sampling token usage turn_id=… total_usage_tokens=48556 …`. Threads
 * that appear there but have no rollout are exactly the side questions
 * (`/btw`), whose spend is otherwise invisible. Only the total is available —
 * no input/cache split — so the number is reported, never priced.
 *
 * @param home - the Codex home.
 * @param known - thread ids that do have a rollout (never counted here).
 * @returns the side threads, their turns, and their total tokens.
 */
async function readSideTurnUsage(
  home: string,
  known: ReadonlySet<string>,
): Promise<{ threads: number; turns: number; tokens: number }> {
  const perThread = new Map<string, { turns: number; tokens: number }>();
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(home, 'logs_2.sqlite'), { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT thread_id, feedback_log_body FROM logs WHERE feedback_log_body LIKE '%post sampling token usage%'")
        .all() as { thread_id?: unknown; feedback_log_body?: unknown }[];
      for (const row of rows) {
        const thread = asString(row.thread_id);
        const body = asString(row.feedback_log_body);
        if (thread === undefined || body === undefined || known.has(thread)) continue;
        const tokens = Number(/total_usage_tokens=(\d+)/.exec(body)?.[1] ?? 0);
        const entry = perThread.get(thread) ?? { turns: 0, tokens: 0 };
        entry.turns += 1;
        entry.tokens += tokens;
        perThread.set(thread, entry);
      }
    } finally {
      db.close();
    }
  } catch {
    // No sqlite module, missing database, or a locked one: no side usage.
  }
  return {
    threads: perThread.size,
    turns: [...perThread.values()].reduce((total, entry) => total + entry.turns, 0),
    tokens: [...perThread.values()].reduce((total, entry) => total + entry.tokens, 0),
  };
}

/**
 * Count prompts that belong to no rollout.
 *
 * Codex runs `/btw` in a throwaway thread: the prompt reaches
 * `history.jsonl`, no `rollout-*.jsonl` is ever written, and no usage event
 * exists anywhere. A history entry whose session id has no rollout is that
 * case, and the reader deserves to know the total is incomplete.
 *
 * @param path - `history.jsonl`.
 * @param known - session ids that do have a rollout.
 * @returns how many distinct history sessions never persisted.
 */
async function countUnpersistedSessions(path: string, known: ReadonlySet<string>): Promise<number> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return 0;
  }
  const unpersisted = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = asRecord(JSON.parse(line));
      const id = asString(entry?.['session_id']);
      if (id !== undefined && !known.has(id)) unpersisted.add(id);
    } catch {
      continue;
    }
  }
  return unpersisted.size;
}

/**
 * Titles Codex keeps outside the rollout.
 *
 * `state_5.sqlite`'s `threads` table carries the user-set `name` and the
 * generated `title` (the first user message) — including for subagent threads,
 * whose task text is often the most useful label there is. Reading it is
 * optional: an older Node without `node:sqlite`, a missing file, or a locked
 * database all degrade to "no titles" rather than failing the report.
 *
 * @param home - the Codex home.
 * @returns a map from thread id to its display name.
 */
async function readThreadTitles(home: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const path = join(home, 'state_5.sqlite');
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare('SELECT id, name, title FROM threads').all() as {
        id?: unknown;
        name?: unknown;
        title?: unknown;
      }[];
      for (const row of rows) {
        const id = asString(row.id);
        const label = asString(row.name) ?? asString(row.title);
        if (id !== undefined && label !== undefined) titles.set(id, label.replace(/\s+/g, ' ').slice(0, 80));
      }
    } finally {
      db.close();
    }
  } catch {
    // No sqlite module, no database, no titles.
  }
  return titles;
}

/** Default data root: `~/.codex`. */
function defaultSource(env: NodeJS.ProcessEnv): string | null {
  const explicit = env[ENV_HOME];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return join(homedir(), '.codex');
}

export const codexAgent: AgentAdapter = {
  id: 'codex',
  label: 'Codex CLI',
  sessionNoun: t().errors.codexSessionNoun,
  envVars: [ENV_HOME],
  defaultSource,
  hasData: async (source) => (await findRollouts(join(source, 'sessions'))).length > 0,
  load,
  notes: () => t().errors.codexNotes(),
};
