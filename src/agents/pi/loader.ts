/**
 * pi adapter: reads pi's own session store.
 *
 * pi keeps one append-only JSONL file per session at
 * `<home>/sessions/<projectKey>/<ISO>_<uuid>.jsonl`: a header line, then one
 * event per line. Assistant events repeat the provider's `usage` block, so the
 * file is the usage source — the same idea as a DSH session log, without the
 * zstd framing: plain JSONL is read whole, which for these files is cheaper
 * than frame-walking.
 *
 * A **subagent is a session of its own**, stored inside a directory named after
 * the parent's file, one directory per spawn and per attempt:
 *
 * ```
 * <home>/sessions/<projectKey>/<ISO>_<uuid>.jsonl            ← the parent
 * <home>/sessions/<projectKey>/<ISO>_<uuid>/<child>/run-0/session.jsonl
 * ```
 *
 * The path is the only link: a child's header carries no parent id, so
 * delegation is read from where the file sits. A child's own subagents follow
 * the same rule one level down.
 *
 * Titles live in `session_info` events, which pi rewrites as a session is
 * renamed, so the last one wins — the same rule as DSH's `session/title`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import { repoOf } from '../../core/git.ts';
import type { ProjectRecord, SessionRecord, TokenBuckets, UsageDataset, UsageRecord } from '../../core/types.ts';
import { UserError, renderDiagnostic, type Warning } from '../../i18n/errors.ts';
import { t } from '../../i18n/index.ts';
import type { AdapterOptions, AgentAdapter } from '../contract.ts';

/** Environment variable pi honours for its agent directory. */
const ENV_AGENT_DIR = 'PI_CODING_AGENT_DIR';

/** Environment variable pi honours for an out-of-tree session directory. */
const ENV_SESSION_DIR = 'PI_CODING_AGENT_SESSION_DIR';

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

/** Read a non-negative count, defaulting to 0. */
function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Read an ISO timestamp as epoch milliseconds, or `null`. */
function asInstant(value: unknown): number | null {
  const text = asString(value);
  if (text === undefined) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Token buckets as pi's `usage` block reports them. */
function usageBuckets(usage: Record<string, unknown>): TokenBuckets {
  return {
    input: asCount(usage['input']),
    output: asCount(usage['output']),
    cacheRead: asCount(usage['cacheRead']),
    cacheWrite: asCount(usage['cacheWrite']),
    // pi reports reasoning inside the completion count, like DSH; it is carried
    // for transparency and never billed beside `output`.
    reasoning: asCount(usage['reasoning']),
  };
}

/** One session file, before delegation and projects are resolved. */
interface ScannedSession {
  /** Session id from the file's header. */
  id: string;
  /** Working directory from the header. */
  cwd: string | null;
  /** Creation time from the header. */
  createdAt: number | null;
  /** Last name pi gave the session, when it named it at all. */
  title: string | null;
  /** One record per billed assistant message, in file order. */
  records: UsageRecord[];
  /** Message ids behind {@link records}, in the same order. */
  messageIds: string[];
  /** Absolute path of the session this one was forked from, when it was. */
  parentSessionPath: string | null;
}

/**
 * Parse one session file.
 *
 * @param path - a parent session file or a subagent run's `session.jsonl`.
 * @returns what the file records, or `undefined` when it has no header.
 */
async function scanSession(path: string): Promise<ScannedSession | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  let id: string | undefined;
  let cwd: string | null = null;
  let createdAt: number | null = null;
  let title: string | null = null;
  let parentSessionPath: string | null = null;
  const records: UsageRecord[] = [];
  const messageIds: string[] = [];
  let line = 0;
  for (const raw of text.split('\n')) {
    if (raw.trim().length === 0) continue;
    line += 1;
    let event: Record<string, unknown> | undefined;
    try {
      event = asRecord(JSON.parse(raw));
    } catch {
      continue;
    }
    if (event === undefined) continue;
    const type = asString(event['type']);
    if (type === 'session') {
      id ??= asString(event['id']);
      cwd ??= asString(event['cwd']) ?? null;
      createdAt ??= asInstant(event['timestamp']);
      // A forked session copies its source's messages verbatim; the path is how
      // pi says where they came from.
      const origin = asString(event['parentSession']);
      if (origin !== null && origin !== undefined) {
        parentSessionPath = isAbsolute(origin) ? origin : join(dirname(path), origin);
      }
      continue;
    }
    if (type === 'session_info') {
      // pi renames a session as the work moves on; the last name is the title.
      title = asString(event['name']) ?? title;
      continue;
    }
    if (type !== 'message') continue;
    const message = asRecord(event['message']);
    const usage = message === undefined ? undefined : asRecord(message['usage']);
    const time = asInstant(event['timestamp']);
    if (message === undefined || usage === undefined || time === null) continue;
    if (asString(message['role']) !== 'assistant') continue;
    const model = asString(message['model']) ?? 'unknown';
    const provider = asString(message['provider']);
    const messageId = asString(event['id']) ?? `line${line}`;
    messageIds.push(messageId);
    records.push({
      // A message id is unique inside its file (the log is a parent chain), and
      // the session id keeps two files from ever colliding.
      id: `${id ?? 'session'}:msg:${messageId}`,
      time,
      model,
      modelLabel: provider === undefined ? model : `${provider} / ${model}`,
      tokens: usageBuckets(usage),
    });
  }
  if (id === undefined) return undefined;
  return { id, cwd, createdAt, title, records, messageIds, parentSessionPath };
}

/** Where pi keeps a session's subagent runs: the file's own name, sans suffix. */
function runRootOf(sessionFile: string): string {
  return sessionFile.endsWith('.jsonl') ? sessionFile.slice(0, -'.jsonl'.length) : sessionFile;
}

/**
 * Every subagent attempt spawned by one session.
 *
 * @param sessionFile - the parent session's file.
 * @returns each `run-<n>/session.jsonl` beneath the parent's run directory.
 */
async function childRuns(sessionFile: string): Promise<string[]> {
  const root = runRootOf(sessionFile);
  let spawns: string[];
  try {
    spawns = await readdir(root);
  } catch {
    return [];
  }
  const runs: string[] = [];
  for (const spawn of spawns) {
    const spawnDir = join(root, spawn);
    let attempts: string[];
    try {
      attempts = await readdir(spawnDir);
    } catch {
      continue;
    }
    for (const attempt of attempts) {
      if (!/^run-\d+$/.test(attempt)) continue;
      runs.push(join(spawnDir, attempt, 'session.jsonl'));
    }
  }
  return runs;
}

/** A session plus the facts the walk learned about its place in the tree. */
interface WalkedSession {
  session: ScannedSession;
  parentId: string | null;
  depth: number;
  /** A fork of another session: a continuation, not a subagent it spawned. */
  continuation: boolean;
}

/** Walk one session file and everything it spawned. */
async function walk(
  file: string,
  parentId: string | null,
  depth: number,
  found: WalkedSession[],
  warnings: Warning[],
  source: string,
): Promise<void> {
  let session = await scanSession(file);
  if (session === undefined) {
    warnings.push(
      new UserError('piSessionUnreadable', { path: relative(source, file).split(sep).join('/') }),
    );
    return;
  }
  // A fork copies the source's messages (same ids) and gives no boundary, so the
  // inherited records are exactly the ones the source already billed. Dropping
  // them keeps a fork from paying twice for the same tokens; when the source is
  // gone they are kept, because then this file is the only copy left.
  let continuation = false;
  let forkParentId: string | null = null;
  if (session.parentSessionPath !== null) {
    const origin = await scanSession(session.parentSessionPath);
    if (origin !== undefined) {
      const scanned = session;
      const inherited = new Set(origin.messageIds);
      const kept = scanned.records.filter((_, index) => !inherited.has(scanned.messageIds[index] as string));
      const keptIds = scanned.messageIds.filter((messageId) => !inherited.has(messageId));
      session = { ...scanned, records: kept, messageIds: keptIds };
      forkParentId = origin.id;
      continuation = true;
    }
  }
  found.push({ session, parentId: forkParentId ?? parentId, depth, continuation });
  for (const run of await childRuns(file)) {
    await walk(run, session.id, depth + 1, found, warnings, source);
  }
}

/** Directory entries, or an empty list when the directory cannot be read. */
async function readdirOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/** The session directory, honouring pi's own escape hatch. */
function sessionsRootOf(source: string, env: NodeJS.ProcessEnv): string {
  return env[ENV_SESSION_DIR] ?? join(source, 'sessions');
}

/** Assemble one neutral session record from a walk result. */
function buildSession(walked: WalkedSession): SessionRecord {
  const { session, parentId, depth, continuation } = walked;
  const records = [...session.records].sort((left, right) =>
    left.time === right.time ? 0 : left.time - right.time,
  );
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    createdAt: session.createdAt,
    records,
    parentId,
    depth,
    isSubagent: depth > 0 && !continuation,
    archived: false,
    childIds: [],
    parentKnown: false,
  };
}

/** Read a pi home into the agent-neutral dataset. */
async function load(options: AdapterOptions = {}): Promise<UsageDataset> {
  const env = options.env ?? process.env;
  const source = options.home ?? defaultSource(env) ?? '';
  const warnings: Warning[] = [];
  if (options.home !== undefined && !isAbsolute(options.home)) {
    throw new UserError('piHomeNotAbsolute', { value: JSON.stringify(options.home) });
  }

  const sessionsRoot = sessionsRootOf(source, env);
  const projectKeys = await readdirOrEmpty(sessionsRoot);
  const walked = new Map<string, WalkedSession[]>(); // project key → its sessions
  for (const projectKey of projectKeys) {
    const projectDir = join(sessionsRoot, projectKey);
    const entries = await readdirOrEmpty(projectDir);
    const found = walked.get(projectKey) ?? [];
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      await walk(join(projectDir, entry), null, 0, found, warnings, source);
    }
    if (found.length > 0) walked.set(projectKey, found);
  }

  if (walked.size === 0) {
    throw new Error(renderDiagnostic('piNoData', { source }));
  }

  const sessions: SessionRecord[] = [];
  const projectOfSession = new Map<string, string>();
  for (const [projectKey, found] of walked) {
    for (const entry of found) {
      const session = buildSession(entry);
      sessions.push(session);
      projectOfSession.set(session.id, projectKey);
    }
  }

  // Second pass: record each parent's children now that every session is known.
  const byId = new Map(sessions.map((session) => [session.id, session]));
  for (const session of sessions) {
    if (session.parentId === null) continue;
    const parent = byId.get(session.parentId);
    if (parent === undefined) continue;
    // Only a session the parent *spawned* is one of its children; a fork is a
    // continuation of it, and folding it in as a subagent would be wrong.
    if (session.isSubagent) parent.childIds.push(session.id);
    session.parentKnown = true;
  }
  for (const session of sessions) session.childIds.sort();

  const projects: ProjectRecord[] = [];
  for (const [projectKey, found] of walked) {
    const members = sessions.filter((session) => projectOfSession.get(session.id) === projectKey);
    members.sort((left, right) => firstUsageOf(left) - firstUsageOf(right));
    const path = found.find((entry) => entry.session.cwd !== null)?.session.cwd ?? '';
    projects.push({
      id: projectKey,
      name: path.length > 0 ? basename(path) : projectKey,
      path,
      sessions: members,
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
    agent: 'pi',
    source,
    projects,
    sessions,
    stats: {
      filesRead: [...walked.values()].flat().map((entry) => entry.session.id),
      sessions: sessions.length,
      records: sessions.reduce((total, session) => total + session.records.length, 0),
    },
    warnings,
  };
}

/** Earliest instant a session can be attributed to. */
function firstUsageOf(session: SessionRecord): number {
  const first = session.records[0];
  if (first !== undefined) return first.time;
  if (session.createdAt !== null) return session.createdAt;
  return Number.POSITIVE_INFINITY;
}

/** Default data root: pi's agent directory. */
function defaultSource(env: NodeJS.ProcessEnv): string | null {
  const explicit = env[ENV_AGENT_DIR];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return join(homedir(), '.pi', 'agent');
}

export const piAgent: AgentAdapter = {
  id: 'pi',
  label: 'pi (coding agent)',
  sessionNoun: t().errors.piSessionNoun,
  envVars: [ENV_AGENT_DIR, ENV_SESSION_DIR],
  defaultSource,
  hasData: async (source) => {
    const root = sessionsRootOf(source, process.env);
    for (const projectKey of await readdirOrEmpty(root)) {
      const entries = await readdirOrEmpty(join(root, projectKey));
      if (entries.some((entry) => entry.endsWith('.jsonl'))) return true;
    }
    return false;
  },
  load,
  notes: () => t().errors.piNotes(),
};
