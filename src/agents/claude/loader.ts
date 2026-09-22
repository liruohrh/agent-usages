/**
 * Claude Code adapter: reads the session logs Claude Code writes itself.
 *
 * Layout (verified against Claude Code 2.1.278):
 *
 * ```
 * ~/.claude/projects/<escaped-cwd>/<session-uuid>.jsonl                      ← the session
 * ~/.claude/projects/<escaped-cwd>/<session-uuid>/subagents/agent-<id>.jsonl ← a subagent
 * ~/.claude/projects/<escaped-cwd>/<session-uuid>/subagents/agent-<id>.meta.json
 * ```
 *
 * Every line is one entry; assistant entries carry the provider's `usage`
 * (`input_tokens` / `output_tokens` / `cache_read_input_tokens` /
 * `cache_creation_input_tokens`, with thinking tokens under
 * `output_tokens_details`). The parent file does **not** repeat a subagent's
 * requests — the subagent has its own file — so both are read and neither is
 * billed twice.
 *
 * The project directory name escapes the working directory lossily (`/` and `-`
 * both become `-`), so the `cwd` inside the entries is what the adapter trusts.
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

import { repoOf } from '../../core/git.ts';
import type { ProjectRecord, SessionRecord, TokenBuckets, UsageDataset, UsageRecord } from '../../core/types.ts';
import { UserError, renderDiagnostic, type Warning } from '../../i18n/errors.ts';
import { t } from '../../i18n/index.ts';
import type { AdapterOptions, AgentAdapter } from '../contract.ts';

/** Environment variable Claude Code honours for its config directory. */
const ENV_CONFIG_DIR = 'CLAUDE_CONFIG_DIR';

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

/**
 * A model id as a pricing table can match it.
 *
 * Claude Code passes context-window suffixes through verbatim
 * (`deepseek-flash[1m]`), which is the same model as `deepseek-flash`.
 */
function priceableModel(model: string): string {
  const bracket = model.indexOf('[');
  return bracket === -1 ? model : model.slice(0, bracket);
}

/** Token buckets as Claude Code's `usage` block reports them. */
function usageBuckets(usage: Record<string, unknown>): TokenBuckets {
  const details = asRecord(usage['output_tokens_details']);
  return {
    input: asCount(usage['input_tokens']),
    output: asCount(usage['output_tokens']),
    cacheRead: asCount(usage['cache_read_input_tokens']),
    cacheWrite: asCount(usage['cache_creation_input_tokens']),
    // Thinking tokens are reported inside the completion count; carried for
    // transparency, never billed beside `output`.
    reasoning: asCount(details?.['thinking_tokens']),
  };
}

/** One session file's facts. */
interface ScannedSession {
  /** Session id: the parent's file uuid, or the subagent's `sessionId`. */
  id: string;
  /** Working directory recorded in the entries. */
  cwd: string | null;
  /** First timestamp seen. */
  createdAt: number | null;
  /** Last `summary` entry, or the user-set title, or the opening prompt. */
  title: string | null;
  /** One record per billed assistant entry, in file order. */
  records: UsageRecord[];
  /** `message.id` behind each record, in the same order. */
  messageIds: string[];
  /** Message-tree branch points: uuids with more than one child. */
  branchPoints: number;
}

/**
 * Parse one session file.
 *
 * @param path - a session file or a subagent file.
 * @param fallbackId - id to use when no entry carries one (the file name works).
 * @returns what the file records.
 */
async function scanSession(path: string, fallbackId: string): Promise<ScannedSession | undefined> {
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
  const records: UsageRecord[] = [];
  const messageIds: string[] = [];
  const children = new Map<string, number>();
  // One API response is written as one entry per content block, and every one of
  // them repeats the same `usage` — counting entries would bill each request two
  // or three times. `message.id` identifies the call, so it is the key; when two
  // entries disagree, the one that actually finished (a `stop_reason`) and
  // reported more output is the better record (cc-usage's rule).
  const billed = new Map<string, { index: number; score: number }>();
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
    // A branch (`--resume-session-at`) leaves the log append-only and shows up
    // as one message in the tree with two children.
    const treeParent = asString(entry['parentUuid']);
    if (treeParent !== undefined) children.set(treeParent, (children.get(treeParent) ?? 0) + 1);
    id ??= asString(entry['sessionId']);
    cwd ??= asString(entry['cwd']) ?? null;
    if (asString(entry['type']) === 'user' && title === null) {
      // Sessions without a custom title still open with something worth showing.
      const message = asRecord(entry['message']);
      const content = message?.['content'];
      const text = typeof content === 'string'
        ? content
        : (Array.isArray(content) ? asString(asRecord(content[0])?.['text']) : undefined);
      if (text !== undefined) {
        const line = text.split('\n').map((part) => part.trim()).find((part) => part.length > 0);
        if (line !== undefined) title = line.slice(0, 80);
      }
    }
    if (asString(entry['type']) === 'summary') {
      // Compaction summaries are the closest thing to a title that the log has.
      title = asString(entry['summary']) ?? title;
      continue;
    }
    const message = asRecord(entry['message']);
    const usage = message === undefined ? undefined : asRecord(message['usage']);
    if (usage === undefined || message === undefined) continue;
    if (asString(entry['type']) !== 'assistant') continue;
    const model = asString(message['model']);
    // Claude Code writes `<synthetic>` entries for requests it never sent (a
    // rejected model, a login problem); they must not become billed requests.
    if (model === undefined || model === '<synthetic>') continue;
    const time = asInstant(entry['timestamp']);
    if (time === null) continue;
    const messageId = asString(message['id']) ?? asString(entry['uuid']) ?? `line${line}`;
    const buckets = usageBuckets(usage);
    const score = (asString(message['stop_reason']) === undefined ? 0 : 1_000_000_000) + buckets.output;
    const seen = billed.get(messageId);
    if (seen !== undefined) {
      if (score > seen.score) {
        records[seen.index] = { ...(records[seen.index] as UsageRecord), tokens: buckets, time };
        billed.set(messageId, { index: seen.index, score });
      }
      continue;
    }
    billed.set(messageId, { index: records.length, score });
    messageIds.push(messageId);
    createdAt ??= time;
    records.push({
      id: `${id ?? fallbackId}:${messageId}`,
      time,
      model: priceableModel(model),
      modelLabel: model,
      tokens: buckets,
    });
  }
  if (id === undefined && cwd === null && records.length === 0) return undefined;
  // `--resume-session-at` branches in place: the log stays append-only and the
  // branch shows up as a message with two children.
  const branchPoints = [...children.values()].filter((count) => count > 1).length;
  return { id: id ?? fallbackId, cwd, createdAt, title, records, messageIds, branchPoints };
}

/** Directory entries, or an empty list when the directory cannot be read. */
async function readdirOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/** One session and everything it spawned. */
interface WalkedSession {
  session: ScannedSession;
  file: string;
  parentId: string | null;
  depth: number;
  isSubagent: boolean;
  /** `agent-<id>.meta.json` of a subagent run, when there is one. */
  meta: Record<string, unknown> | undefined;
}

/** Read a session file and the subagent files filed under it. */
async function walk(
  file: string,
  id: string,
  found: WalkedSession[],
  warnings: Warning[],
  source: string,
): Promise<void> {
  let session = await scanSession(file, id);
  if (session === undefined || session.records.length === 0) {
    // A session that never billed a request (an aborted run) is still a session,
    // but only if it has anything at all to say.
    if (session === undefined) {
      warnings.push(new UserError('claudeSessionUnreadable', { path: relative(source, file).split(sep).join('/') }));
      return;
    }
  }
  // Claude Code keeps a user-set session name next to the log.
  const custom = await readFile(join(file.replace(/\.jsonl$/, ''), 'custom-title.json'), 'utf8').catch(() => undefined);
  if (custom !== undefined && session.title === null) {
    try {
      const parsed = asRecord(JSON.parse(custom));
      const customTitle = asString(parsed?.['customTitle']);
      // A user-set name outranks the opening prompt.
      if (customTitle !== undefined) session = { ...session, title: customTitle };
    } catch {
      // An unreadable title is not worth failing a report over.
    }
  }
  found.push({ session, file, parentId: null, depth: 0, isSubagent: false, meta: undefined });
  // Subagents live one level down, in a directory named after the session file.
  const subagents = join(file.replace(/\.jsonl$/, ''), 'subagents');
  for (const entry of await readdirOrEmpty(subagents)) {
    if (!entry.startsWith('agent-') || !entry.endsWith('.jsonl')) continue;
    const metaText = await readFile(join(subagents, entry.replace(/\.jsonl$/, '.meta.json')), 'utf8').catch(() => undefined);
    const meta = metaText === undefined ? undefined : asRecord(JSON.parse(metaText));
    // A subagent's entries keep the *parent's* `sessionId`, so its identity has
    // to come from the file: `agent-<agentId>.jsonl`.
    const agentId = entry.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const child = await scanSession(join(subagents, entry), agentId);
    if (child === undefined) continue;
    const depth = typeof meta?.['spawnDepth'] === 'number' ? Number(meta['spawnDepth']) : 1;
    // A subagent's own log has no title; the meta file's description is what
    // the parent asked it to do, which is exactly what a title should say.
    const described = asString(meta?.['description']);
    // The description the parent gave it beats its own opening prompt.
    const title = described ?? child.title;
    found.push({
      session: { ...child, id: agentId, title },
      file: join(subagents, entry),
      parentId: session.id,
      depth,
      isSubagent: true,
      meta,
    });
  }
}

/** Assemble one neutral session record. */
function buildSession(walked: WalkedSession): SessionRecord {
  const { session, parentId, depth, isSubagent } = walked;
  const records = [...session.records].sort((left, right) => left.time - right.time);
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    createdAt: session.createdAt,
    records,
    parentId,
    depth,
    isSubagent,
    archived: false,
    childIds: [],
    parentKnown: false,
  };
}

/** Earliest instant a session can be attributed to. */
function firstUsageOf(session: SessionRecord): number {
  const first = session.records[0];
  if (first !== undefined) return first.time;
  if (session.createdAt !== null) return session.createdAt;
  return Number.POSITIVE_INFINITY;
}

/** The `projects` directory under a Claude Code config directory. */
function projectsRootOf(source: string, env: NodeJS.ProcessEnv): string {
  return join(env[ENV_CONFIG_DIR] ?? source, 'projects');
}

/** Read a Claude Code home into the agent-neutral dataset. */
async function load(options: AdapterOptions = {}): Promise<UsageDataset> {
  const env = options.env ?? process.env;
  const source = options.home ?? defaultSource(env) ?? '';
  const warnings: Warning[] = [];
  if (options.home !== undefined && !isAbsolute(options.home)) {
    throw new UserError('claudeHomeNotAbsolute', { value: JSON.stringify(options.home) });
  }

  const projectsRoot = projectsRootOf(source, env);
  const walked = new Map<string, WalkedSession[]>();
  for (const projectKey of await readdirOrEmpty(projectsRoot)) {
    const projectDir = join(projectsRoot, projectKey);
    const found: WalkedSession[] = [];
    for (const entry of await readdirOrEmpty(projectDir)) {
      if (!entry.endsWith('.jsonl')) continue;
      await walk(join(projectDir, entry), entry.replace(/\.jsonl$/, ''), found, warnings, source);
    }
    if (found.length > 0) walked.set(projectKey, found);
  }
  if (walked.size === 0) {
    throw new Error(renderDiagnostic('claudeNoData', { source }));
  }
  const btw = await countSideQuestions(join(env[ENV_CONFIG_DIR] ?? source, 'history.jsonl'));
  if (btw > 0) warnings.push(new UserError('sideQuestionsUncounted', { count: String(btw), agent: 'Claude Code' }));

  const sessions: SessionRecord[] = [];
  const projectOfSession = new Map<string, string>();
  // `--fork-session` copies the source's entries verbatim — same `message.id`,
  // no back-pointer — so the copy is recognised by the calls it repeats. One
  // message id is one API call, so an id billed by an earlier file is inherited
  // history, not a new request. The fork keeps its own title, cwd and records,
  // and is reported as a continuation of the session it came from.
  const billedBy = new Map<string, string>();
  for (const [projectKey, found] of walked) {
    const ordered = [...found].sort(
      (left, right) =>
        (left.session.records[0]?.time ?? left.session.createdAt ?? 0) -
        (right.session.records[0]?.time ?? right.session.createdAt ?? 0),
    );
    for (const entry of ordered) {
      if (sessions.some((session) => session.id === entry.session.id)) continue;
      const records: UsageRecord[] = [];
      const messageIds: string[] = [];
      let inheritedFrom: string | null = null;
      entry.session.records.forEach((record, index) => {
        const messageId = entry.session.messageIds[index] as string;
        const previous = billedBy.get(messageId);
        if (previous !== undefined && previous !== entry.session.id) {
          inheritedFrom ??= previous;
          return;
        }
        if (previous === undefined) billedBy.set(messageId, entry.session.id);
        records.push(record);
        messageIds.push(messageId);
      });
      const extra: Record<string, unknown> = {};
      if (inheritedFrom !== null) {
        extra['forkedFrom'] = inheritedFrom;
        extra['inheritedRequests'] = entry.session.records.length - records.length;
      }
      if (entry.session.branchPoints > 0) extra['branchPoints'] = entry.session.branchPoints;
      if (entry.isSubagent && entry.meta !== undefined) {
        // Claude Code records what the subagent was asked to do next to its log.
        const agentType = asString(entry.meta['agentType']);
        const description = asString(entry.meta['description']);
        const toolUseId = asString(entry.meta['toolUseId']);
        if (agentType !== undefined) extra['agentType'] = agentType;
        if (description !== undefined) extra['description'] = description;
        if (toolUseId !== undefined) extra['toolUseId'] = toolUseId;
      }
      const session = buildSession({
        ...entry,
        session: { ...entry.session, records, messageIds },
        parentId: inheritedFrom ?? entry.parentId,
      });
      if (Object.keys(extra).length > 0) session.extra = extra;
      sessions.push(session);
      projectOfSession.set(session.id, projectKey);
    }
  }

  const byId = new Map(sessions.map((session) => [session.id, session]));
  for (const session of sessions) {
    if (session.parentId === null) continue;
    const parent = byId.get(session.parentId);
    if (parent === undefined) continue;
    if (session.isSubagent) parent.childIds.push(session.id);
    session.parentKnown = true;
  }
  for (const session of sessions) session.childIds.sort();

  const projects: ProjectRecord[] = [];
  for (const [projectKey, found] of walked) {
    const members = sessions.filter((session) => projectOfSession.get(session.id) === projectKey);
    if (members.length === 0) continue;
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
    agent: 'claude',
    source,
    projects,
    sessions,
    stats: {
      filesRead: [...walked.values()].flat().map((entry) => entry.file),
      sessions: sessions.length,
      records: sessions.reduce((total, session) => total + session.records.length, 0),
    },
    warnings,
  };
}

/**
 * Count `/btw` side questions in an agent's prompt history.
 *
 * `/btw` runs in a throwaway session that never reaches a session log, so its
 * tokens cannot be counted; the prompt history is the only place it shows up
 * (Claude Code keeps the `/btw` prefix there, which makes the count exact).
 *
 * @param path - the agent's `history.jsonl`.
 * @returns how many prompts are `/btw` invocations.
 */
async function countSideQuestions(path: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = asRecord(JSON.parse(line));
      if ((asString(entry?.['display']) ?? '').startsWith('/btw')) count += 1;
    } catch {
      continue;
    }
  }
  return count;
}

/** Default data root: the Claude Code config directory. */
function defaultSource(env: NodeJS.ProcessEnv): string | null {
  const explicit = env[ENV_CONFIG_DIR];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return join(homedir(), '.claude');
}

export const claudeAgent: AgentAdapter = {
  id: 'claude',
  label: 'Claude Code',
  sessionNoun: t().errors.claudeSessionNoun,
  envVars: [ENV_CONFIG_DIR],
  defaultSource,
  hasData: async (source) => {
    const root = projectsRootOf(source, process.env);
    for (const projectKey of await readdirOrEmpty(root)) {
      const entries = await readdirOrEmpty(join(root, projectKey));
      if (entries.some((entry) => entry.endsWith('.jsonl'))) return true;
    }
    return false;
  },
  load,
  notes: () => t().errors.claudeNotes(),
};
